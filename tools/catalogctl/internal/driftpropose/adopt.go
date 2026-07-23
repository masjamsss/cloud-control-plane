package driftpropose

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/hashicorp/hcl/v2"
	"github.com/hashicorp/hcl/v2/hclsyntax"
	"github.com/hashicorp/hcl/v2/hclwrite"
	"github.com/zclconf/go-cty/cty"

	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/hclops"
)

// adoptEdit is the pure, in-memory locate/edit/splice core shared by
// GenerateAdopt (produces a diff for review) and ApplyAdopt (spec addendum A3's
// drift-edit write-capable replay) — ONE implementation, so replaying an edit at
// apply time is PROVABLY the identical mechanical edit that produced the
// original proposal, not merely "the same algorithm re-typed" (spec §7: "the
// identical-edit proof is the shared GenerateAdopt mechanics"). v MUST already
// be ADOPT-eligible per ClassifyByFields; the security/unknown-class/shape
// screens all run there, BEFORE this is ever reached (§8 enforcement point 1).
// This only adds the catalogctl-exclusive, checkout-DEPENDENT refinement
// ClassifyByFields cannot make on its own: does the address actually resolve to
// a block, and can the edit actually be spliced in. A non-empty ungenerable
// reason (with everything else zero) is that refinement firing; a non-nil error
// is an unexpected internal failure. newFile equals loc.Bytes byte-for-byte when
// every changed value already matches the checkout (the "verified no-op" case)
// — callers decide what that means for their own purpose (GenerateAdopt treats
// it as nothing-to-propose; ApplyAdopt treats it as nothing-to-write, success).
func adoptEdit(v Verdict, envDir string) (newFile []byte, loc *hclops.Located, attrs []Attr, ungenReason string, err error) {
	loc, err, code := hclops.Locate(envDir, v.Address)
	if err != nil {
		if code == 3 {
			return nil, nil, nil, fmt.Sprintf("address %q not found in checkout: %v", v.Address, err), nil
		}
		return nil, nil, nil, "", err // I/O or parse error on the checkout itself — not a per-verdict refusal
	}

	f, diags := hclwrite.ParseConfig(loc.Bytes[loc.Start:loc.End], loc.File, hcl.Pos{Line: 1, Column: 1})
	if diags.HasErrors() {
		return nil, nil, nil, "", fmt.Errorf("adopt %s: parse block: %s", v.Address, diags.Error())
	}
	blocks := f.Body().Blocks()
	if len(blocks) != 1 {
		return nil, nil, nil, "", fmt.Errorf("adopt %s: expected exactly one block in the located range, got %d", v.Address, len(blocks))
	}
	block := blocks[0]

	attrs = make([]Attr, 0, len(v.ChangedAttrs))
	for _, ca := range v.ChangedAttrs {
		live, ok := ca.liveValue()
		if !ok {
			// ClassifyByFields already requires sensitive:false && liveJson present
			// for every row of an ADOPT-bucket verdict; reaching here means a caller
			// bypassed that gate — a programming error, not a data-driven refusal.
			return nil, nil, nil, "", fmt.Errorf("adopt %s: attribute %q carries no liveJson value (caller bypassed ClassifyByFields)", v.Address, ca.Path)
		}
		segs, ok := ExpressibleSegments(ca)
		if !ok {
			return nil, nil, nil, "", fmt.Errorf("adopt %s: attribute %q has a value shape not expressible by the edit engine (caller bypassed ClassifyByFields)", v.Address, ca.Path)
		}
		refuseCode, reason := setAtSegments(block, segs, live)
		if refuseCode != "" {
			return nil, nil, nil, fmt.Sprintf("attribute %q: %s", ca.Path, reason), nil
		}
		codeVal, _ := ca.codeValue() // display/evidence only; absent is fine (still nil -> JSON null)
		attrs = append(attrs, Attr{Address: v.Address, Path: ca.Path, PathSegments: segs, LiveJSON: live, CodeJSON: codeVal})
	}

	newBlock := hclwrite.Format(f.Bytes())
	newFile, err = hclops.Splice(loc.Bytes, loc.Start, loc.End, newBlock)
	if err != nil {
		return nil, nil, nil, "", fmt.Errorf("adopt %s: %w", v.Address, err)
	}
	return newFile, loc, attrs, "", nil
}

// GenerateAdopt performs the runbook D1 mechanical procedure (spec §6.4) for one
// ADOPT-bucket verdict: locate the resource block in the checkout, set every changed
// attribute at its path to liveJson (the classifier's direction convention: in a
// drift plan `before` = refreshed live reality), and pin the resulting unified diff
// — approvers review the exact bytes that will land. See adoptEdit for the
// eligibility precondition and the checkout-dependent refinements this adds.
func GenerateAdopt(v Verdict, envDir, diffPrefix string) (*Proposal, string, error) {
	newFile, loc, attrs, ungenReason, err := adoptEdit(v, envDir)
	if err != nil || ungenReason != "" {
		return nil, ungenReason, err
	}

	label := filepath.ToSlash(filepath.Join(diffPrefix, filepath.Base(loc.File)))
	diffBytes := hclops.UnifiedDiff(label, label, loc.Bytes, newFile)
	if len(diffBytes) == 0 {
		// Verified no-op: the checkout already matches every liveJson value (a
		// re-generation of drift already adopted since the envelope was captured).
		// Not an error — there is simply nothing left to propose.
		return nil, "checkout already matches every changed value (verified no-op)", nil
	}
	diffStr := string(diffBytes)

	addrs := []string{v.Address}
	digest := ProposalDigest("adopt", addrs, attrs)

	return &Proposal{
		Digest:    digest,
		Flavor:    "adopt",
		Addresses: addrs,
		Attrs:     attrs,
		Diff:      &diffStr,
		RequestSkeleton: RequestSkeleton{Items: []RequestItem{{
			OperationID:   opAdopt,
			TargetAddress: v.Address,
			Params:        RequestParams{Attrs: attrs, ProposalDigest: digest},
		}}},
	}, "", nil
}

// ApplyAdopt is GenerateAdopt's write-capable twin (spec addendum A3, the
// `drift-edit` entrypoint's per-verdict edit step, §2-F1c): the SAME
// locate/edit/splice core (adoptEdit) — proven identical by construction, not
// merely "the same algorithm re-typed" — but WRITES the resulting bytes to disk
// instead of producing a diff for review. v MUST already be ADOPT-eligible per
// ClassifyByFields, exactly like GenerateAdopt's own precondition; the caller
// (drift-edit) is also responsible for the fourth screen (F4) and the digest
// cross-check — this function has no watchlist or digest opinion, mirroring how
// GenerateAdopt has none either. A verified no-op (the checkout already matches
// every changed value — legitimate when an unrelated change converged it
// between generation and replay) is SUCCESS, not a refusal: nothing needs
// writing, and the subsequent plan-check R7 will trivially confirm zero delta.
// wrote reports whether any byte actually changed on disk (informational only).
// hclops.Locate always re-reads its *.tf files from disk, so calling this once
// per verdict in a loop — never batching multiple verdicts' edits into one
// in-memory pass — lets multiple edits to the SAME file compose correctly: the
// second call sees the first call's write.
func ApplyAdopt(v Verdict, envDir string) (wrote bool, ungenReason string, err error) {
	newFile, loc, _, ungenReason, err := adoptEdit(v, envDir)
	if err != nil || ungenReason != "" {
		return false, ungenReason, err
	}
	if bytes.Equal(loc.Bytes, newFile) {
		return false, "", nil // verified no-op — success, nothing to write
	}
	if err := os.WriteFile(loc.File, newFile, 0o644); err != nil {
		return false, "", fmt.Errorf("adopt %s: write %s: %w", v.Address, loc.File, err)
	}
	return true, "", nil
}

// setAtSegments writes val at the structured path segs inside block.
// ExpressibleSegments has already refused every shape but the three below
// before this is reached (spec addendum A4):
//
//   - [s]     — a top-level scalar attribute; hclwrite's own SetAttributeValue
//     semantics apply (replaces an existing attribute's value tokens in place,
//     appends at the canonical position if absent). val == nil writes the
//     correct "unset" spelling `attr = null` (spec addendum A5) — unchanged by F3.
//   - [s, s]  — segs[0] names a top-level map attribute, segs[1] is the map key
//     (verbatim — any key bytes, dots/slashes/spaces included, since a
//     structured segment is never re-split) to upsert or, when val == nil
//     (spec F3/addendum A5: live null on a map path means the key is gone
//     live), remove. drift-propose v1 only edits an EXISTING literal-object
//     attribute (the runbook's PR-#18 tags pattern); it never fabricates a map
//     from nothing, and it never touches a non-literal (referenced/computed) map.
//   - [s, 0, s] — segs[0] names a single-instance nested block, segs[2] the leaf
//     attribute inside it (W1; see setNestedSingleBlock — segs[1] is always the
//     literal int 0 by the time ExpressibleSegments has gated the caller).
func setAtSegments(block *hclwrite.Block, segs []any, val any) (refuseCode, reason string) {
	switch len(segs) {
	case 1:
		ctyVal, err := jsonToCty(val)
		if err != nil {
			return "VALUE_SHAPE", err.Error()
		}
		block.Body().SetAttributeValue(segs[0].(string), ctyVal)
		return "", ""
	case 2:
		attrName, key := segs[0].(string), segs[1].(string)
		if val == nil {
			return removeSingleKey(block, attrName, key)
		}
		ctyVal, err := jsonToCty(val)
		if err != nil {
			return "VALUE_SHAPE", err.Error()
		}
		return mergeSingleKey(block, attrName, key, ctyVal)
	case 3:
		blockType, idx, leaf := segs[0].(string), segs[1].(int), segs[2].(string)
		if idx != 0 {
			// Unreachable when ExpressibleSegments (shapeOf) gated the caller —
			// kept as a fail-closed belt-and-braces refusal, never a silent guess.
			return "UNSUPPORTED_PATH", fmt.Sprintf("nested-block index %d is not 0 — not expressible by the edit engine", idx)
		}
		return setNestedSingleBlock(block, blockType, leaf, val)
	default:
		// Unreachable when ExpressibleSegments gated the caller; kept as a
		// fail-closed belt-and-braces refusal rather than a silent wrong write.
		return "UNSUPPORTED_PATH", fmt.Sprintf("path segments %v are not expressible by the edit engine", segs)
	}
}

// setNestedSingleBlock resolves segs[0] (blockType) among block's own direct
// nested blocks — W1's checkout-DEPENDENT half of the [s, 0, s] shape (the
// partition/shapeOf half already proved the SEGMENT SHAPE is expressible;
// this proves the ACTUAL checkout is unambiguous). Exactly one instance is
// required:
//
//   - zero instances, and blockType also names an attribute on block — the row
//     addresses an attribute, not a nested block: ungenerable, never silently
//     treated as a zero-instance block.
//   - zero instances, no such attribute either — the block is simply not
//     present: ungenerable, never fabricated (mirrors mergeSingleKey's own
//     "never fabricates a map from nothing" doctrine).
//   - two or more instances — plan-index↔config-block mapping is unsafe under
//     set/list reordering (a repeated block, register 0009 L28): ungenerable,
//     never guessed.
//
// Leaf is then set via SetAttributeValue on the nested block's own body; live
// null REMOVES the attribute (RemoveAttribute) rather than writing a literal
// `= null` — the clean "unset" spelling for a nested-block attribute (spec
// addendum A5), since a nested block has no map-key upsert/removal to speak of.
func setNestedSingleBlock(block *hclwrite.Block, blockType, leaf string, val any) (refuseCode, reason string) {
	var nested []*hclwrite.Block
	for _, nb := range block.Body().Blocks() {
		if nb.Type() == blockType {
			nested = append(nested, nb)
		}
	}
	switch {
	case len(nested) == 0:
		if block.Body().GetAttribute(blockType) != nil {
			return "NOT_A_BLOCK", fmt.Sprintf("%q is an attribute, not a nested block", blockType)
		}
		return "BLOCK_MISSING", fmt.Sprintf("nested block %q is not present — never fabricated", blockType)
	case len(nested) > 1:
		return "BLOCK_AMBIGUOUS", fmt.Sprintf(
			"%d %q blocks present — plan index cannot be safely mapped (set ordering); see register 0009 L28", len(nested), blockType)
	}
	body := nested[0].Body()
	if val == nil {
		body.RemoveAttribute(leaf)
		return "", ""
	}
	ctyVal, err := jsonToCty(val)
	if err != nil {
		return "VALUE_SHAPE", err.Error()
	}
	body.SetAttributeValue(leaf, ctyVal)
	return "", ""
}

// jsonToCty converts a decoded JSON value (string/float64/bool/nil/[]any/
// map[string]any — encoding/json's own decode shapes) into the cty.Value
// hclwrite.TokensForValue renders. Mirrors internal/edit/setattr.go's anyToCty
// (unexported there, so re-implemented rather than imported) including its
// int-vs-float distinction: a whole-numbered JSON float renders as "80", never the
// surprising "80.0".
func jsonToCty(v any) (cty.Value, error) {
	switch n := v.(type) {
	case nil:
		return cty.NullVal(cty.DynamicPseudoType), nil
	case string:
		return cty.StringVal(n), nil
	case bool:
		return cty.BoolVal(n), nil
	case float64:
		if n == float64(int64(n)) {
			return cty.NumberIntVal(int64(n)), nil
		}
		return cty.NumberFloatVal(n), nil
	case []any:
		if len(n) == 0 {
			return cty.EmptyTupleVal, nil
		}
		vals := make([]cty.Value, len(n))
		for i, e := range n {
			ev, err := jsonToCty(e)
			if err != nil {
				return cty.NilVal, err
			}
			vals[i] = ev
		}
		return cty.TupleVal(vals), nil
	case map[string]any:
		if len(n) == 0 {
			return cty.EmptyObjectVal, nil
		}
		m := make(map[string]cty.Value, len(n))
		for k, e := range n {
			ev, err := jsonToCty(e)
			if err != nil {
				return cty.NilVal, err
			}
			m[k] = ev
		}
		return cty.ObjectVal(m), nil
	default:
		return cty.NilVal, fmt.Errorf("unsupported liveJson value type %T", v)
	}
}

// --- literal-object token surgery -----------------------------------------------
//
// A scoped sibling of internal/edit/setattr.go's parseObject/buildObject/mergeMap:
// that function is unexported and shaped around a manifests.Op (azure tag
// case-collision, ensure-create, resourceType) — none of which apply to a raw
// {address, path, liveJson} triple from a drift verdict on this AWS-only estate
// (docs/runbooks/drift-detection.md's scope is environments/prod only). The
// token-walking algorithm itself — preserve every byte except the one changed
// entry's value, including a key's trailing line comment — is reused faithfully
// because it is what keeps an adopt diff to the single line the runbook's PR-#18
// pattern promises; re-rendering the whole map through cty would reformat and
// silently drop comments on every UNRELATED key.

// objEntry is one parsed `key = value # comment` row of a literal object.
type objEntry struct {
	key     string
	keyToks hclwrite.Tokens
	valToks hclwrite.Tokens
	comment hclwrite.Tokens
}

// mergeSingleKey upserts exactly one key into the EXISTING literal-object attribute
// named attrName on block. MAP_ATTR_MISSING/NOT_LITERAL are per-verdict refusals
// (routed to ungenerable by the caller), never a silent wrong write.
func mergeSingleKey(block *hclwrite.Block, attrName, key string, val cty.Value) (string, string) {
	a := block.Body().GetAttribute(attrName)
	if a == nil {
		return "MAP_ATTR_MISSING", fmt.Sprintf("attribute %q is not present — drift-propose v1 only merges into an existing map, it never fabricates one", attrName)
	}
	entries, ok := parseObjectLiteral(a.Expr().BuildTokens(nil))
	if !ok {
		return "NOT_LITERAL", fmt.Sprintf("attribute %q is not a literal object", attrName)
	}
	newToks := hclwrite.TokensForValue(val)
	found := false
	for i := range entries {
		if entries[i].key == key {
			entries[i].valToks = newToks
			found = true
			break
		}
	}
	if !found {
		entries = append(entries, objEntry{key: key, keyToks: keyTokensFor(key), valToks: newToks})
	}
	block.Body().SetAttributeRaw(attrName, buildObjectLiteral(entries))
	return "", ""
}

// removeSingleKey removes exactly one key from the EXISTING literal-object
// attribute named attrName on block — spec F3 / addendum A5: on a 2-segment map
// path, live null means "the key is gone live," and adoption REMOVES it from
// code. It never writes `key = null` — terraform-proven non-equivalent (a null
// map element is not an absent key, so the old upsert-null behavior could never
// plan 0/0/0 and permanently wedged R7). Removing an already-absent key is a
// benign no-op: the caller (GenerateAdopt) sees an empty diff and reports
// "verified no-op" — not this function's problem. Same MAP_ATTR_MISSING/
// NOT_LITERAL refusals as mergeSingleKey: a missing or non-literal map is never
// guessed at.
func removeSingleKey(block *hclwrite.Block, attrName, key string) (string, string) {
	a := block.Body().GetAttribute(attrName)
	if a == nil {
		return "MAP_ATTR_MISSING", fmt.Sprintf("attribute %q is not present — drift-propose v1 only merges into an existing map, it never fabricates one", attrName)
	}
	entries, ok := parseObjectLiteral(a.Expr().BuildTokens(nil))
	if !ok {
		return "NOT_LITERAL", fmt.Sprintf("attribute %q is not a literal object", attrName)
	}
	out := make([]objEntry, 0, len(entries))
	for _, e := range entries {
		if e.key != key {
			out = append(out, e)
		}
	}
	block.Body().SetAttributeRaw(attrName, buildObjectLiteral(out))
	return "", ""
}

// parseObjectLiteral splits a `{ … }` literal object's token stream into ordered
// entries. ok=false when the expression is not a literal object (a reference,
// function call, or anything else this engine must never blindly overwrite).
func parseObjectLiteral(toks hclwrite.Tokens) ([]objEntry, bool) {
	i := 0
	for i < len(toks) && (toks[i].Type == hclsyntax.TokenComment || toks[i].Type == hclsyntax.TokenNewline) {
		i++
	}
	if i >= len(toks) || toks[i].Type != hclsyntax.TokenOBrace {
		return nil, false
	}
	i++
	var entries []objEntry
	for i < len(toks) {
		switch toks[i].Type {
		case hclsyntax.TokenNewline, hclsyntax.TokenComma:
			i++
			continue
		case hclsyntax.TokenCBrace:
			return entries, true
		}
		var keyToks hclwrite.Tokens
		for i < len(toks) && toks[i].Type != hclsyntax.TokenEqual {
			if toks[i].Type == hclsyntax.TokenNewline || toks[i].Type == hclsyntax.TokenCBrace {
				return nil, false
			}
			keyToks = append(keyToks, toks[i])
			i++
		}
		if i >= len(toks) || toks[i].Type != hclsyntax.TokenEqual {
			return nil, false
		}
		i++ // skip '='
		var valToks, comment hclwrite.Tokens
		depth := 0
		for i < len(toks) {
			t := toks[i]
			if depth == 0 && (t.Type == hclsyntax.TokenNewline || t.Type == hclsyntax.TokenComma || t.Type == hclsyntax.TokenCBrace) {
				break
			}
			if t.Type == hclsyntax.TokenComment {
				comment = append(comment, t)
				i++
				// A single-line comment token carries its terminating newline
				// ("# note\n" is one token), so at depth 0 it also ends the entry —
				// otherwise the next entry's tokens get swallowed into this one.
				if depth == 0 && strings.HasSuffix(string(t.Bytes), "\n") {
					break
				}
				continue
			}
			switch t.Type {
			case hclsyntax.TokenOBrace, hclsyntax.TokenOBrack, hclsyntax.TokenOParen:
				depth++
			case hclsyntax.TokenCBrace, hclsyntax.TokenCBrack, hclsyntax.TokenCParen:
				depth--
			}
			valToks = append(valToks, t)
			i++
		}
		entries = append(entries, objEntry{key: keyLiteral(keyToks), keyToks: keyToks, valToks: valToks, comment: comment})
	}
	return nil, false
}

// keyLiteral strips surrounding quotes (if any) from a parsed key's token bytes,
// yielding the bare key string ("Owner", not `"Owner"`).
func keyLiteral(toks hclwrite.Tokens) string {
	var sb strings.Builder
	for _, t := range toks {
		switch t.Type {
		case hclsyntax.TokenOQuote, hclsyntax.TokenCQuote:
			// drop the quotes; keep the literal
		default:
			sb.Write(t.Bytes)
		}
	}
	return sb.String()
}

var hclIdentRe = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_-]*$`)

// keyTokensFor renders a NEW key: a bare identifier when it looks like one,
// otherwise a fully-escaped string literal via the same safe seam values use
// (TokensForValue) — never raw bytes, which would let a crafted key break out of
// the map at format time.
func keyTokensFor(k string) hclwrite.Tokens {
	if hclIdentRe.MatchString(k) {
		return hclwrite.Tokens{{Type: hclsyntax.TokenIdent, Bytes: []byte(k)}}
	}
	return hclwrite.TokensForValue(cty.StringVal(k))
}

// buildObjectLiteral re-emits entries as a multi-line `{ k = v\n … }` object;
// hclwrite.Format (called on the whole block afterward) re-aligns it to canonical form.
func buildObjectLiteral(entries []objEntry) hclwrite.Tokens {
	toks := hclwrite.Tokens{
		{Type: hclsyntax.TokenOBrace, Bytes: []byte("{")},
		{Type: hclsyntax.TokenNewline, Bytes: []byte("\n")},
	}
	for _, e := range entries {
		toks = append(toks, e.keyToks...)
		toks = append(toks, &hclwrite.Token{Type: hclsyntax.TokenEqual, Bytes: []byte("=")})
		toks = append(toks, e.valToks...)
		toks = append(toks, e.comment...)
		// A trailing line comment already carries the entry's newline (see
		// parseObjectLiteral) — appending another would leave a blank line mid-map.
		if n := len(e.comment); n > 0 && strings.HasSuffix(string(e.comment[n-1].Bytes), "\n") {
			continue
		}
		toks = append(toks, &hclwrite.Token{Type: hclsyntax.TokenNewline, Bytes: []byte("\n")})
	}
	return append(toks, &hclwrite.Token{Type: hclsyntax.TokenCBrace, Bytes: []byte("}")})
}
