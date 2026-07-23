package edit

import (
	"fmt"
	"path/filepath"
	"strings"

	"github.com/hashicorp/hcl/v2/hclwrite"

	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/hclops"
	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/manifests"
	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/request"
)

// setAttributes writes several attributes of one resource block in a
// single all-or-nothing edit. Every value-provider param (const / reference /
// scalar / list) is resolved to an (attr, tokens) pair with its per-param guards
// run FIRST — dotted-path (UNSUPPORTED_PATH) and grow-only (SHRINK). Only when
// every param passes are the attributes written and the block spliced once by the
// caller; any refusal returns before the block is mutated, so the tree is
// untouched (nil bytes). Required-param presence is enforced upstream by
// manifests.Validate (OUT_OF_BOUNDS) before this transformer runs.
func setAttributes(op manifests.Op, req *request.Request, loc *hclops.Located) ([]byte, string, string, error) {
	f, block, err := parseSingleBlock(loc)
	if err != nil {
		return nil, "", "", err
	}
	blockBytes := loc.Bytes[loc.Start:loc.End]
	envDir := filepath.Dir(loc.File)

	// a target.path navigates into a nested block (optionally
	// selecting one keyed sibling) so the multi-attribute writes below land inside
	// it — e.g. a health_check { interval, timeout, healthy_threshold } block. The
	// descent reuses the shared helpers (descendPath/selectChild), so path and
	// selector semantics and their refusal codes (PATH_NOT_FOUND / SELECTOR_AMBIGUOUS)
	// match set_attribute exactly. An unresolvable address refuses with nil bytes
	// BEFORE any mutation, so the tree is left untouched. When Path is empty the
	// target stays the top-level block and the flat behavior is unchanged.
	target := block
	nested := len(op.Target.Path) > 0
	if nested {
		t, code, reason := descendPath(block, op.Target.Path, selectorFor(op, req), op.Target.EnsurePath, op.Target.MatchPresence)
		if code != "" {
			return nil, code, reason, nil
		}
		target = t
	}

	var writes []attrKV
	for _, p := range valueProviders(op) {
		raw, present := req.Params[p.Name]
		// A const value comes from the manifest, not the request, so it is always
		// written. An optional value-provider that was not supplied is left as-is.
		if p.Role != "const" && !present {
			continue
		}

		name := manifests.AttrFor(op, p)
		if name == "" {
			return nil, "", "", fmt.Errorf("cannot resolve attribute name for param %q", p.Name)
		}
		// SAFETY: a dotted attribute is a nested path a bare LHS cannot address —
		// SetAttributeRaw would write a dotted LHS = invalid HCL. Nested blocks are
		// addressed by target.path above, so a dotted attr name is still refused
		// (route to an engineer) rather than corrupt the file.
		if strings.Contains(name, ".") {
			return nil, "UNSUPPORTED_PATH", fmt.Sprintf("nested attribute path %q is not yet supported — routed to an engineer", name), nil
		}

		// Grow-only direction guard (spec): reads the CURRENT value — from the
		// descended nested block when target.path navigated there, else the top-level
		// block bytes — and a strict shrink refuses. Runs before any mutation so the
		// edit stays all-or-nothing.
		if p.Bounds != nil && p.Bounds.GrowOnly {
			newNum, ok := toFloat(raw)
			if !ok {
				return nil, "", "", fmt.Errorf("grow-only param %q is not numeric", p.Name)
			}
			cur, ok := currentAttrNumber(nested, target, blockBytes, name)
			if !ok {
				return nil, "", "", fmt.Errorf("cannot read current %q value", name)
			}
			if newNum < cur {
				return nil, "SHRINK", fmt.Sprintf("%s %s is below current %s (grow-only)", p.Name, num(newNum), num(cur)), nil
			}
		}

		toks, code, reason, err := valueTokens(envDir, p, raw)
		if err != nil || code != "" {
			return nil, code, reason, err
		}
		writes = append(writes, attrKV{name, toks})
	}

	// Every param resolved and guarded → apply into the (top-level or descended)
	// target block, then a single splice by the caller.
	for _, w := range writes {
		setScalar(target, w.name, w.toks)
	}
	return hclwrite.Format(f.Bytes()), "", "", nil
}

// currentAttrNumber reads attr's current numeric value for the grow-only guard:
// from the descended nested hclwrite block (currentNumberHW) when target.path
// navigated there, else from the top-level block's raw bytes (currentNumber) —
// keeping the flat read path byte-identical to the pre-nested behavior.
func currentAttrNumber(nested bool, target *hclwrite.Block, blockBytes []byte, attr string) (float64, bool) {
	if nested {
		return currentNumberHW(target, attr)
	}
	return currentNumber(blockBytes, attr)
}
