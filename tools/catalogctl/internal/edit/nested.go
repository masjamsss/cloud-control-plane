package edit

import (
	"fmt"
	"strconv"
	"strings"

	"github.com/hashicorp/hcl/v2/hclsyntax"
	"github.com/hashicorp/hcl/v2/hclwrite"

	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/manifests"
	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/request"
)

// nested.go implements path+selector addressing: walk target.path from
// the located top-level block into a nested block, optionally disambiguating one
// repeated sibling via a role:"selector" param that matches a key attribute. All
// edits still rewrite only the top-level block's bytes (the changed-set
// invariant is preserved by the caller's splice), and output stays fmt-canonical.
//
// Refusals (fail-closed, never a fuzzy match):
//   - PATH_NOT_FOUND    — a path segment's block type is entirely absent.
//   - SELECTOR_AMBIGUOUS — a selector matched 0 or >1 siblings, or a segment is
//     repeated (>1) with no selector to choose one.

// selector picks ONE sibling repeated block: the one whose matchAttr literal
// equals value. Nil when the op declares no role:"selector" param.
type selector struct {
	matchAttr string
	value     string
}

// selectorFor extracts the op's selector param (role:"selector") and binds its
// requested value. Returns nil when the op has none.
func selectorFor(op manifests.Op, req *request.Request) *selector {
	for _, p := range op.Params {
		if p.Role == "selector" {
			return &selector{matchAttr: p.MatchAttr, value: fmt.Sprint(req.Params[p.Name])}
		}
	}
	return nil
}

// descendPath walks path from top, returning the nested block at its end. The
// selector is consumed at most once, at the first segment whose siblings carry
// the matchAttr (so it disambiguates the keyed level and never mis-fires on a
// single intermediate block deeper in the path). With ensure set (
// Target.EnsurePath), a missing NON-REPEATED level is created on demand rather
// than refused (see selectChild). matchPresence (Target.MatchPresence)
// is keyed by path segment: a segment present in the map is disambiguated by
// WHICH attribute its siblings carry instead of the value-selector (see
// selectByPresence); a nil map or a segment absent from it is unaffected.
func descendPath(top *hclwrite.Block, path []string, sel *selector, ensure bool, matchPresence map[string]string) (*hclwrite.Block, string, string) {
	cur := top
	selUsed := false
	for _, seg := range path {
		child, code, reason := selectChild(cur, seg, sel, &selUsed, ensure, matchPresence[seg])
		if code != "" {
			return nil, code, reason
		}
		cur = child
	}
	return cur, "", ""
}

// selectChild resolves exactly one child block of blockType under parent.
// presenceAttr non-empty takes over disambiguation at this level
// entirely — see selectByPresence — since it is a manifest constant, not request
// data, and the spec defines no combination with a value-selector at the SAME
// level (a selector still pending for a LATER segment is unaffected). Otherwise:
// a selector applicable at this level filters by key (0 or >1 → SELECTOR_AMBIGUOUS,
// marking the selector consumed); a single child descends; a repeated one without
// an applicable selector is SELECTOR_AMBIGUOUS. Zero children is PATH_NOT_FOUND —
// unless ensure is set AND no selector is pending, in which case the missing
// singleton block is created and descended into.
func selectChild(parent *hclwrite.Block, blockType string, sel *selector, selUsed *bool, ensure bool, presenceAttr string) (*hclwrite.Block, string, string) {
	children := childrenOfType(parent, blockType)

	if presenceAttr != "" {
		if sel != nil && !*selUsed && anyHasAttr(children, sel.matchAttr) {
			// Unspecified ("though no current op needs both") — refuse
			// rather than silently pick one mechanism over the other.
			return nil, "SELECTOR_PRESENCE_CONFLICT", fmt.Sprintf("%q has both a pending value-selector (%s) and matchPresence (%s) applicable at the same level — this combination is unsupported; routed to an engineer", blockType, sel.matchAttr, presenceAttr)
		}
		return selectByPresence(parent, blockType, children, presenceAttr, ensure)
	}

	if len(children) == 0 {
		// ensurePath: create-on-missing, but ONLY when no selector is
		// pending for this level. A pending selector means the absent level is
		// keyed/repeated — which sibling to create is ambiguous — so we fail closed
		// (PATH_NOT_FOUND) instead of guessing. The created block's type is a
		// manifest-constant (resolved) ident, so the changed set stays inside the
		// located resource and the name is name-safe by construction.
		if ensure && (sel == nil || *selUsed) {
			return parent.Body().AppendNewBlock(blockType, nil), "", ""
		}
		return nil, "PATH_NOT_FOUND", fmt.Sprintf("no %q block found to address", blockType)
	}
	if sel != nil && !*selUsed && anyHasAttr(children, sel.matchAttr) {
		var matched []*hclwrite.Block
		for _, c := range children {
			if v, ok := attrLiteral(c, sel.matchAttr); ok && v == sel.value {
				matched = append(matched, c)
			}
		}
		if len(matched) != 1 {
			return nil, "SELECTOR_AMBIGUOUS", fmt.Sprintf("selector %s=%q matched %d of %d %q blocks (need exactly 1)", sel.matchAttr, sel.value, len(matched), len(children), blockType)
		}
		*selUsed = true
		return matched[0], "", ""
	}
	if len(children) == 1 {
		return children[0], "", ""
	}
	return nil, "SELECTOR_AMBIGUOUS", fmt.Sprintf("%d %q blocks present but no selector to choose one", len(children), blockType)
}

// selectByPresence (target.matchPresence) implements shape C: among
// blockType siblings, select the ONE carrying attribute presenceAttr
// (Body().GetAttribute(presenceAttr) != nil) — distinguishing siblings by WHICH
// attribute each carries rather than any attribute's VALUE (efs lifecycle_policy:
// one block holds transition_to_ia, another transition_to_archive; there is no
// request input to key a value-selector on at all). Exactly one carrier descends;
// zero refuses PATH_NOT_FOUND unless ensure is set, in which case a NEW empty
// sibling of blockType is appended and descended into — the one place ensure
// creates a sibling AMONG REPEATED blocks rather than filling a missing singleton
// (the EFS lifecycle model: up to 3 sibling blocks, one transition attr each).
// More than one carrier is malformed config (two siblings carrying the same
// transition attr) → SELECTOR_AMBIGUOUS, the same code value-selector uses
// for "can't pick one sibling" — one refusal token for every disambiguation
// failure a caller/golden needs to grep for.
func selectByPresence(parent *hclwrite.Block, blockType string, children []*hclwrite.Block, presenceAttr string, ensure bool) (*hclwrite.Block, string, string) {
	var carriers []*hclwrite.Block
	for _, c := range children {
		if c.Body().GetAttribute(presenceAttr) != nil {
			carriers = append(carriers, c)
		}
	}
	switch len(carriers) {
	case 1:
		return carriers[0], "", ""
	case 0:
		if ensure {
			return parent.Body().AppendNewBlock(blockType, nil), "", ""
		}
		return nil, "PATH_NOT_FOUND", fmt.Sprintf("no %q block carrying %q found to address", blockType, presenceAttr)
	default:
		return nil, "SELECTOR_AMBIGUOUS", fmt.Sprintf("%d %q blocks carry %q (need exactly 1)", len(carriers), blockType, presenceAttr)
	}
}

// childrenOfType returns the direct child blocks of b whose type is t, in order.
func childrenOfType(b *hclwrite.Block, t string) []*hclwrite.Block {
	var out []*hclwrite.Block
	for _, nb := range b.Body().Blocks() {
		if nb.Type() == t {
			out = append(out, nb)
		}
	}
	return out
}

// anyHasAttr reports whether any of blocks declares attribute attr.
func anyHasAttr(blocks []*hclwrite.Block, attr string) bool {
	for _, b := range blocks {
		if b.Body().GetAttribute(attr) != nil {
			return true
		}
	}
	return false
}

// attrLiteral returns the literal string form of a simple attribute value
// (quotes stripped for strings; the raw token for idents/numbers/bools). Used
// only for selector key comparison, so non-literal expressions simply won't match.
func attrLiteral(b *hclwrite.Block, name string) (string, bool) {
	a := b.Body().GetAttribute(name)
	if a == nil {
		return "", false
	}
	var sb strings.Builder
	for _, t := range a.Expr().BuildTokens(nil) {
		switch t.Type {
		case hclsyntax.TokenOQuote, hclsyntax.TokenCQuote, hclsyntax.TokenComment, hclsyntax.TokenNewline:
			continue
		}
		sb.Write(t.Bytes)
	}
	return sb.String(), true
}

// nestedAttrName resolves the scalar attribute for a path-addressed set. An explicit
// op.Target.Attr is authoritative — the same single source of truth
// attrName honors, so target.attr means "the scalar leaf this op writes" identically
// whether the op is flat or path-addressed. A nested op never used the prose paren
// path (there was no hazard here), so absent target.attr the behavior is the frozen
// manifests.AttrFor on the value param (new_ prefix stripped, rename table applied),
// byte-for-byte unchanged.
func nestedAttrName(op manifests.Op) string {
	if op.Target.Attr != "" {
		return op.Target.Attr
	}
	vp := valueParam(op)
	if vp == nil {
		return ""
	}
	return manifests.AttrFor(op, *vp)
}

// currentNumberHW reads a literal numeric attribute from a live hclwrite block
// (the nested analog of currentNumber; grow-only reads the file, not inventory).
func currentNumberHW(b *hclwrite.Block, name string) (float64, bool) {
	s, ok := attrLiteral(b, name)
	if !ok {
		return 0, false
	}
	f, err := strconv.ParseFloat(s, 64)
	return f, err == nil
}

// ensureChildChain walks/creates a chain of sub-blocks under parent,
// returning the deepest one. Each missing segment is AppendNewBlock'd; an existing
// child of that type is reused (so two Param.Paths sharing a prefix — e.g.
// ["statement","a"] and ["statement","b"] — get ONE statement block). It is called
// ONLY on a freshly synthesized append_block, so "reuse the first child of type"
// can never touch pre-existing file content. It adds no inter-segment blank lines:
// each intermediate holds exactly one child (waf's statement{managed_rule_group_statement{}}
// is a lone nested block, no stray blank), and hclwrite.Format fixes indentation.
func ensureChildChain(parent *hclwrite.Block, path []string) *hclwrite.Block {
	cur := parent
	for _, seg := range path {
		if existing := cur.Body().FirstMatchingBlock(seg, nil); existing != nil {
			cur = existing
			continue
		}
		cur = cur.Body().AppendNewBlock(seg, nil)
	}
	return cur
}

// deepEqualBlock reports structural equality of two blocks:
// same type + labels, the same set of attributes each with byte-equal value tokens
// (order-insensitive, since HCL attribute order is not significant), and the same
// sub-blocks compared positionally (order-sensitive for repeated same-type blocks).
// Attribute values are compared as expression tokens, which hclwrite.Format leaves
// untouched, so a freshly synthesized candidate deep-equals its own written-then-
// reparsed form — that is what keeps a second run an idempotent no-op.
func deepEqualBlock(a, b *hclwrite.Block) bool {
	if a.Type() != b.Type() {
		return false
	}
	al, bl := a.Labels(), b.Labels()
	if len(al) != len(bl) {
		return false
	}
	for i := range al {
		if al[i] != bl[i] {
			return false
		}
	}
	aa, ba := a.Body().Attributes(), b.Body().Attributes()
	if len(aa) != len(ba) {
		return false
	}
	for name, av := range aa {
		bv, ok := ba[name]
		if !ok {
			return false
		}
		if tokensString(av.Expr().BuildTokens(nil)) != tokensString(bv.Expr().BuildTokens(nil)) {
			return false
		}
	}
	ab, bb := a.Body().Blocks(), b.Body().Blocks()
	if len(ab) != len(bb) {
		return false
	}
	for i := range ab {
		if !deepEqualBlock(ab[i], bb[i]) {
			return false
		}
	}
	return true
}
