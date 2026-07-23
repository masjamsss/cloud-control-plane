package edit

import (
	"fmt"

	"github.com/hashicorp/hcl/v2/hclwrite"

	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/hclops"
	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/manifests"
	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/request"
)

// swapblock.go implements swap_child_block, the verb for shape B
// (block-type choice swap) — a parent block that holds exactly one child from a
// CLOSED CHOICE SET of empty block types (WAF's `action` ∈ allow/block/captcha/
// challenge/count; `override_action` ∈ count/none; `default_action` ∈ allow/block).
//
// The manifest addresses the PARENT via target.path (selector-aware — the same
// descendPath/selectorFor machinery every other nested verb uses, and may itself
// contain a {param:...} token resolved for free by the pre-dispatch ResolveTarget
// seam in edit.go); the desired choice comes from the op's single
// role:"discriminator" param, whose Segments map's CO-DOMAIN *is* the closed
// choice set. There is no {param:x} token to substitute for the choice itself —
// it isn't a path or attr segment, it's which SIBLING BLOCK is present — so this
// verb resolves that param directly via manifests.ResolveDiscriminator, the same
// segments-map lookup ResolveTarget uses for path/attr tokens.
//
// Semantics (all fail-closed — nil bytes, tree untouched):
//  1. Descend target.path (PATH_NOT_FOUND / SELECTOR_AMBIGUOUS unchanged).
//  2. Resolve the desired child type → want. INVALID_CHOICE is a verb-level
//     defense-in-depth re-check (spec): unreachable through the map lookup
//     itself (want is drawn from the same co-domain), kept as an independent gate.
//  3. Partition the parent's children into `choice` (type ∈ co-domain) and `other`
//     (anything else) — a non-empty `other` means the manifest target is
//     mis-addressed (the schema allows only choice children here) → CHOICE_AMBIGUOUS.
//  4. Exactly one choice child, already `want`, and empty → no-op (idempotence).
//  5. Zero or more than one choice child → CHOICE_AMBIGUOUS (malformed config;
//     never guess which one to touch or invent one from nothing).
//  6. The one choice child is non-empty (carries attrs/blocks, e.g.
//     count{custom_request_handling{...}}) → CHOICE_NOT_EMPTY: swapping would
//     silently discard config, so this routes to an engineer instead.
//  7. Otherwise: remove the existing choice child, append the desired empty one.
func swapChildBlock(op manifests.Op, req *request.Request, loc *hclops.Located) ([]byte, string, string, error) {
	dp := discriminatorParam(op)
	if dp == nil {
		return nil, "", "", fmt.Errorf("op %q (swap_child_block) has no role:\"discriminator\" param", op.ID)
	}
	choices := map[string]bool{}
	for _, v := range dp.Segments {
		choices[v] = true
	}
	if len(choices) == 0 {
		return nil, "", "", fmt.Errorf("op %q discriminator %q has an empty segments map", op.ID, dp.Name)
	}

	want, code, reason := manifests.ResolveDiscriminator(*dp, req.Params)
	if code != "" {
		return nil, code, reason, nil
	}
	if !choices[want] {
		// Defense in depth (spec): cannot happen through the map lookup
		// above (want came FROM dp.Segments, the same map choices was built from) —
		// kept as an independent runtime gate rather than trusted-by-construction.
		return nil, "INVALID_CHOICE", fmt.Sprintf("resolved choice %q for discriminator %q is not in its own declared choice set", want, dp.Name), nil
	}

	f, block, err := parseSingleBlock(loc)
	if err != nil {
		return nil, "", "", err
	}
	parent := block
	if len(op.Target.Path) > 0 {
		p, code, reason := descendPath(block, op.Target.Path, selectorFor(op, req), op.Target.EnsurePath, op.Target.MatchPresence)
		if code != "" {
			return nil, code, reason, nil
		}
		parent = p
	}

	var choice, other []*hclwrite.Block
	for _, c := range parent.Body().Blocks() {
		if choices[c.Type()] {
			choice = append(choice, c)
		} else {
			other = append(other, c)
		}
	}
	if len(other) > 0 {
		return nil, "CHOICE_AMBIGUOUS", fmt.Sprintf("the addressed block holds %d block(s) outside the declared choice set for %q — the manifest target is mis-addressed", len(other), dp.Name), nil
	}
	if len(choice) != 1 {
		return nil, "CHOICE_AMBIGUOUS", fmt.Sprintf("the addressed block holds %d choice-set block(s) for %q, need exactly 1 to swap (0 or >1 is malformed config — never guessed)", len(choice), dp.Name), nil
	}

	existing := choice[0]
	if existing.Type() == want && !bodyNonEmpty(existing.Body()) {
		return origBlock(loc), "", "", nil // idempotence: desired choice already present and empty.
	}
	if bodyNonEmpty(existing.Body()) {
		return nil, "CHOICE_NOT_EMPTY", fmt.Sprintf("the existing %q block carries attributes or sub-blocks — swapping would silently discard them; routed to an engineer", existing.Type()), nil
	}

	if !parent.Body().RemoveBlock(existing) {
		return nil, "", "", fmt.Errorf("internal: failed to remove existing %q block", existing.Type())
	}
	parent.Body().AppendNewBlock(want, nil)

	return collapseBlankLines(hclwrite.Format(f.Bytes())), "", "", nil
}

// discriminatorParam returns the op's single role:"discriminator" param, or nil.
// swap_child_block manifests carry exactly one (spec: "no value params").
func discriminatorParam(op manifests.Op) *manifests.Param {
	for i := range op.Params {
		if op.Params[i].Role == "discriminator" {
			return &op.Params[i]
		}
	}
	return nil
}
