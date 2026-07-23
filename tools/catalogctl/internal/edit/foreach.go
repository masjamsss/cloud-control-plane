package edit

import (
	"fmt"
	"strings"

	"github.com/hashicorp/hcl/v2/hclwrite"

	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/hclops"
	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/manifests"
	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/request"
)

// appendForeachEntry adds one key to a literal map (spec). Key present with a
// byte-identical value → no-op (idempotence). Key present with a different value →
// REFUSE KEY_CONFLICT (an "add" never silently overwrites).
func appendForeachEntry(op manifests.Op, req *request.Request, loc *hclops.Located) ([]byte, string, string, error) {
	if code, reason := guardBlockTarget(op.Target.Block); code != "" {
		return nil, code, reason, nil
	}
	f, block, err := parseSingleBlock(loc)
	if err != nil {
		return nil, "", "", err
	}
	// a target.path descends into a nested block (optionally selecting one
	// keyed sibling) before the map add below; an empty path is the top-level block.
	target, code, reason := foreachBlock(op, req, block)
	if code != "" {
		return nil, code, reason, nil
	}
	attrName, err := foreachMapAttr(op, req)
	if err != nil {
		return nil, "", "", err
	}
	nonInv := nonInvParams(op)
	if len(nonInv) < 2 {
		return nil, "", "", fmt.Errorf("append_foreach_entry needs key and value params")
	}
	key, ok := req.Params[nonInv[0].Name].(string)
	if !ok {
		return nil, "", "", fmt.Errorf("foreach key %q is not a string", nonInv[0].Name)
	}
	valCty, err := anyToCty(req.Params[nonInv[1].Name])
	if err != nil {
		return nil, "", "", err
	}
	newVal := hclwrite.TokensForValue(valCty)

	a := target.Body().GetAttribute(attrName)
	var entries []objEntry
	if a == nil {
		// ensureAttr: create-on-absent — start from an empty literal map and
		// add the key below (the attribute-level analog of ensurePath's block
		// create-on-missing). Without the opt-in, an absent map attribute stays the
		// exit-1 error, so a manifest that has not adopted the flag is
		// byte-for-byte unchanged.
		if !op.Target.EnsureAttr {
			return nil, "", "", fmt.Errorf("map attribute %q not found", attrName)
		}
	} else {
		var ok bool
		entries, ok = parseObject(a.Expr().BuildTokens(nil))
		if !ok {
			return nil, "NOT_LITERAL", fmt.Sprintf("%s is not a literal map", attrName), nil
		}
	}
	for _, e := range entries {
		if e.key == key {
			if tokensString(e.valToks) == tokensString(newVal) {
				return origBlock(loc), "", "", nil // idempotent add → no-op
			}
			return nil, "KEY_CONFLICT", fmt.Sprintf("key %q already set to a different value", key), nil
		}
	}
	entries = append(entries, objEntry{key: key, keyToks: keyTokens(key), valToks: newVal})
	target.Body().SetAttributeRaw(attrName, buildObject(entries))
	return hclwrite.Format(f.Bytes()), "", "", nil
}

// removeForeachEntry drops one key from a literal map. Missing key →
// no-op exit 0. Sibling keys keep their bytes (the expected/ tree proves it).
func removeForeachEntry(op manifests.Op, req *request.Request, loc *hclops.Located) ([]byte, string, string, error) {
	if code, reason := guardBlockTarget(op.Target.Block); code != "" {
		return nil, code, reason, nil
	}
	f, block, err := parseSingleBlock(loc)
	if err != nil {
		return nil, "", "", err
	}
	// a target.path descends into a nested block (optionally selecting one
	// keyed sibling) before the map remove below; an empty path is the top-level block.
	target, code, reason := foreachBlock(op, req, block)
	if code != "" {
		return nil, code, reason, nil
	}
	attrName, err := foreachMapAttr(op, req)
	if err != nil {
		return nil, "", "", err
	}
	nonInv := nonInvParams(op)
	if len(nonInv) < 1 {
		return nil, "", "", fmt.Errorf("remove_foreach_entry needs a key param")
	}
	key, ok := req.Params[nonInv[0].Name].(string)
	if !ok {
		return nil, "", "", fmt.Errorf("foreach key %q is not a string", nonInv[0].Name)
	}

	a := target.Body().GetAttribute(attrName)
	if a == nil {
		// Remove-of-absent is a vacuous NOOP: no map ⇒ the key is already gone.
		// Unconditional (NOT gated by EnsureAttr — a remove never creates); executor
		// robustness mirroring the missing-key no-op below.
		return origBlock(loc), "", "", nil
	}
	entries, ok := parseObject(a.Expr().BuildTokens(nil))
	if !ok {
		return nil, "NOT_LITERAL", fmt.Sprintf("%s is not a literal map", attrName), nil
	}
	kept := make([]objEntry, 0, len(entries))
	found := false
	for _, e := range entries {
		if e.key == key {
			found = true
			continue
		}
		kept = append(kept, e)
	}
	if !found {
		return origBlock(loc), "", "", nil // missing key → no-op
	}
	target.Body().SetAttributeRaw(attrName, buildObject(kept))
	return hclwrite.Format(f.Bytes()), "", "", nil
}

// foreachBlock resolves the block whose map attribute the foreach verb edits.
// With a non-empty target.path it descends into the nested block (optionally
// selecting one keyed sibling via a role:"selector"+matchAttr param), reusing the
// same descendPath/selectorFor helpers set_attribute uses — so the map add/remove
// then runs inside that nested block. With an empty path it is the located
// top-level block (behavior, no regression). Refuses PATH_NOT_FOUND /
// SELECTOR_AMBIGUOUS (fail-closed, never a fuzzy match) on an unresolvable address.
func foreachBlock(op manifests.Op, req *request.Request, top *hclwrite.Block) (*hclwrite.Block, string, string) {
	if len(op.Target.Path) == 0 {
		return top, "", ""
	}
	// ensure=false: a foreach edits an existing map attribute; auto-creating the
	// containing block is not a shape any foreach op needs, so absent → PATH_NOT_FOUND.
	// op.Target.MatchPresence threads through for uniformity; no
	// catalogued foreach op sets it, so this is a nil map for every real request.
	return descendPath(top, op.Target.Path, selectorFor(op, req), false, op.Target.MatchPresence)
}

// foreachMapAttr resolves the target map attribute: target.block for a resource,
// else the <name> of a local.<name> address.
func foreachMapAttr(op manifests.Op, req *request.Request) (string, error) {
	if op.Target.Block != "" {
		return op.Target.Block, nil
	}
	addr, err := targetAddress(op, req.Params)
	if err != nil {
		return "", err
	}
	if strings.HasPrefix(addr, "local.") {
		return strings.TrimPrefix(addr, "local."), nil
	}
	return "", fmt.Errorf("cannot resolve foreach map attribute for %q", addr)
}

func tokensString(toks hclwrite.Tokens) string {
	var sb strings.Builder
	for _, t := range toks {
		sb.Write(t.Bytes)
	}
	return sb.String()
}
