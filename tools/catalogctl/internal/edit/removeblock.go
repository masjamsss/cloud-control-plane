package edit

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"

	"github.com/hashicorp/hcl/v2"
	"github.com/hashicorp/hcl/v2/hclsyntax"
	"github.com/hashicorp/hcl/v2/hclwrite"
	"github.com/zclconf/go-cty/cty"

	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/hclops"
	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/manifests"
	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/request"
)

// removeBlock deletes one labelled block and its single preceding blank line
// (spec). It refuses PREVENT_DESTROY when the block carries
// lifecycle{prevent_destroy=true}, and DANGLING_REF when the address is still
// referenced elsewhere in --env. Never lifts or edits a prevent_destroy guard.
func removeBlock(op manifests.Op, req *request.Request, loc *hclops.Located) ([]byte, string, string, error) {
	orig := loc.Bytes
	address, err := targetAddress(op, req.Params)
	if err != nil {
		return nil, "", "", err
	}

	// a target.path removes ONE keyed nested block (e.g. waf-delete-rule),
	// leaving the parent resource and sibling blocks intact.
	if len(op.Target.Path) > 0 {
		return removeNestedBlock(op, req, loc, address)
	}

	// SAFETY hotfix: the nested encoding (target.block, no path) cannot carry
	// a selector, so it stays refused — deleting the whole enclosing resource in its
	// place would be data loss. Re-author such ops with target.path to enable them.
	if op.Target.Block != "" {
		return nil, "UNSUPPORTED_NESTED_REMOVE", fmt.Sprintf("removing a nested %q block is not yet supported — routed to an engineer (would otherwise delete the whole %s)", op.Target.Block, address), nil
	}

	if hasPreventDestroy(orig[loc.Start:loc.End]) {
		return nil, "PREVENT_DESTROY", fmt.Sprintf("%s is protected by lifecycle.prevent_destroy — routed to an engineer", address), nil
	}
	if danglingRef(filepath.Dir(loc.File), address, loc) {
		return nil, "DANGLING_REF", fmt.Sprintf("%s is still referenced elsewhere in the environment", address), nil
	}

	// Remove the exactly-one preceding blank line so no double-blank survives.
	removeStart := loc.Start
	if loc.Start >= 2 && orig[loc.Start-1] == '\n' && orig[loc.Start-2] == '\n' {
		removeStart = loc.Start - 1
	}
	newFile := make([]byte, 0, len(orig)-(loc.End-removeStart))
	newFile = append(newFile, orig[:removeStart]...)
	newFile = append(newFile, orig[loc.End:]...)
	return newFile, "", "", nil
}

// removeNestedBlock deletes exactly one nested block reached by
// target.path — the last segment's block, chosen among siblings by the selector.
// Only bytes inside the top-level block change (Splice re-proves the invariant);
// the parent resource and every sibling block survive. prevent_destroy on the
// enclosing resource still refuses (spec, fail-closed).
func removeNestedBlock(op manifests.Op, req *request.Request, loc *hclops.Located, address string) ([]byte, string, string, error) {
	orig := loc.Bytes
	if hasPreventDestroy(orig[loc.Start:loc.End]) {
		return nil, "PREVENT_DESTROY", fmt.Sprintf("%s is protected by lifecycle.prevent_destroy — routed to an engineer", address), nil
	}
	f, top, err := parseSingleBlock(loc)
	if err != nil {
		return nil, "", "", err
	}

	sel := selectorFor(op, req)
	path := op.Target.Path
	selUsed := false
	matchPresence := op.Target.MatchPresence

	// Navigate to the parent that holds the block to remove. ensure=false throughout:
	// a removal never creates the block it is about to delete — a missing level is
	// PATH_NOT_FOUND, unchanged (nor does it invent a
	// presence-matched sibling — the same ensure=false applies to matchPresence).
	parent := top
	for _, seg := range path[:len(path)-1] {
		child, code, reason := selectChild(parent, seg, sel, &selUsed, false, matchPresence[seg])
		if code != "" {
			return nil, code, reason, nil
		}
		parent = child
	}
	// Select the exact sibling to delete.
	lastSeg := path[len(path)-1]
	victim, code, reason := selectChild(parent, lastSeg, sel, &selUsed, false, matchPresence[lastSeg])
	if code != "" {
		return nil, code, reason, nil
	}
	if !parent.Body().RemoveBlock(victim) {
		return nil, "", "", fmt.Errorf("internal: failed to remove selected %q block", path[len(path)-1])
	}

	// hclwrite's RemoveBlock leaves the blank lines that flanked the removed block,
	// and hclwrite.Format does not collapse them (canonical HCL has at most one
	// consecutive blank). Collapse so no double-blank survives — the nested analog
	// of the top-level removal's preceding-blank cleanup.
	newBlock := collapseBlankLines(hclwrite.Format(f.Bytes()))
	newFile, err := hclops.Splice(orig, loc.Start, loc.End, newBlock)
	if err != nil {
		return nil, "", "", err
	}
	return newFile, "", "", nil
}

// collapseBlankLines caps consecutive newlines at two (one blank line), matching
// terraform fmt's whitespace rule that hclwrite.Format alone does not enforce.
func collapseBlankLines(b []byte) []byte {
	out := make([]byte, 0, len(b))
	nl := 0
	for _, c := range b {
		if c == '\n' {
			if nl < 2 {
				out = append(out, c)
			}
			nl++
			continue
		}
		nl = 0
		out = append(out, c)
	}
	return out
}

// hasPreventDestroy reports whether the block is protected by
// lifecycle{prevent_destroy}. It is the veto behind the forces-replace
// PREVENT_DESTROY refusal (edit.go), so it FAILS CLOSED: a prevent_destroy
// attribute protects the block unless we can STATICALLY PROVE it false. A
// literal `true`, the string "true", or any expression we cannot evaluate with
// a nil context (e.g. `var.protect`, a function call) all count as protected —
// the destroy guardrail must never fail open just because the guard was written
// in an unexpected form. Only a provable literal/string false — or no
// prevent_destroy attribute at all — leaves the block unprotected.
func hasPreventDestroy(blockBytes []byte) bool {
	f, diags := hclsyntax.ParseConfig(blockBytes, "block.tf", hcl.Pos{Line: 1, Column: 1})
	if diags.HasErrors() {
		return false
	}
	body, ok := f.Body.(*hclsyntax.Body)
	if !ok || len(body.Blocks) == 0 {
		return false
	}
	for _, nb := range body.Blocks[0].Body.Blocks {
		if nb.Type != "lifecycle" {
			continue
		}
		a, ok := nb.Body.Attributes["prevent_destroy"]
		if !ok {
			continue
		}
		if preventDestroyProvablyFalse(a) {
			continue // explicitly disabled on this lifecycle block
		}
		return true // present and not provably false → protected (fail closed)
	}
	return false
}

// preventDestroyProvablyFalse reports whether a prevent_destroy attribute can be
// STATICALLY shown to be false: a literal `false`, or the string "false". A true
// value, any other string, a null, or an expression that needs a real eval
// context (`var.x`, a function call — Value(nil) errors) is NOT provably false,
// so hasPreventDestroy treats the block as protected.
func preventDestroyProvablyFalse(a *hclsyntax.Attribute) bool {
	v, d := a.Expr.Value(nil)
	if d.HasErrors() || v.IsNull() || !v.IsKnown() {
		return false
	}
	switch v.Type() {
	case cty.Bool:
		return v.False()
	case cty.String:
		return v.AsString() == "false"
	default:
		return false
	}
}

// danglingRef does the spec's naive substring scan for the address across all
// *.tf in envDir, excluding the block being removed.
func danglingRef(envDir, address string, loc *hclops.Located) bool {
	needle := []byte(address)
	files, err := filepath.Glob(filepath.Join(envDir, "*.tf"))
	if err != nil {
		return false
	}
	for _, fp := range files {
		b, err := os.ReadFile(fp)
		if err != nil {
			continue
		}
		if fp == loc.File {
			outside := append(append([]byte{}, b[:loc.Start]...), b[loc.End:]...)
			if bytes.Contains(outside, needle) {
				return true
			}
			continue
		}
		if bytes.Contains(b, needle) {
			return true
		}
	}
	return false
}
