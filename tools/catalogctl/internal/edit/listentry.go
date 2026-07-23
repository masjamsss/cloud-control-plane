package edit

import (
	"fmt"
	"path/filepath"
	"strings"

	"github.com/hashicorp/hcl/v2/hclsyntax"
	"github.com/hashicorp/hcl/v2/hclwrite"

	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/hclops"
	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/manifests"
	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/request"
)

// listentry.go implements append_list_entry / remove_list_entry: set-add
// and set-remove one element of a literal list attribute (target.block, else the
// value param's attribute). The entry value flows through the value layer, so an
// element can be a scalar, or a cross-resource reference (e.g. a subnet id).
//
// Semantics (idempotent by construction):
//   - append: element already present  → no-op (exit 0, empty diff).
//   - remove: element absent           → no-op.
//   - the attribute is not a `[ … ]` literal → NOT_LITERAL refusal (untouched tree).

func appendListEntry(op manifests.Op, req *request.Request, loc *hclops.Located) ([]byte, string, string, error) {
	return listEntry(op, req, loc, true)
}

func removeListEntry(op manifests.Op, req *request.Request, loc *hclops.Located) ([]byte, string, string, error) {
	return listEntry(op, req, loc, false)
}

func listEntry(op manifests.Op, req *request.Request, loc *hclops.Located, add bool) ([]byte, string, string, error) {
	f, block, err := parseSingleBlock(loc)
	if err != nil {
		return nil, "", "", err
	}

	// The list attribute: target.block names it; else fall back to the value param's
	// attribute (attrName). A dotted name is a nested path this verb cannot address.
	attr := op.Target.Block
	if attr == "" {
		attr = attrName(op)
	}
	if attr == "" {
		return nil, "", "", fmt.Errorf("op %q: cannot resolve list attribute name", op.ID)
	}
	if strings.Contains(attr, ".") {
		return nil, "UNSUPPORTED_PATH", fmt.Sprintf("nested attribute path %q is not yet supported — routed to an engineer", attr), nil
	}

	a := block.Body().GetAttribute(attr)
	var entries []tupleEntry
	if a == nil {
		// Remove-of-absent is a vacuous NOOP (nothing to remove) — unconditional,
		// mirroring remove_foreach_entry and the remove-missing-element no-op below.
		if !add {
			return origBlock(loc), "", "", nil
		}
		// ensureAttr (list flavor): create-on-absent for the add — start
		// from an empty literal list and append the element below. Without the opt-in an
		// absent list attribute stays the exit-1 error (behavior preserved).
		if !op.Target.EnsureAttr {
			return nil, "", "", fmt.Errorf("attribute %q not found for list edit", attr)
		}
	} else {
		var ok bool
		entries, ok = parseTuple(a.Expr().BuildTokens(nil))
		if !ok {
			return nil, "NOT_LITERAL", fmt.Sprintf("%s is not a literal list", attr), nil
		}
	}

	vp := valueParam(op)
	if vp == nil {
		return nil, "", "", fmt.Errorf("op %q has no value param", op.ID)
	}
	entryToks, code, reason, err := valueTokens(filepath.Dir(loc.File), *vp, req.Params[vp.Name])
	if err != nil || code != "" {
		return nil, code, reason, err
	}
	want := tokensString(entryToks)

	idx := -1
	for i := range entries {
		if tokensString(entries[i].toks) == want {
			idx = i
			break
		}
	}

	if add {
		if idx >= 0 {
			return origBlock(loc), "", "", nil // set-add: already present → no-op
		}
		entries = append(entries, tupleEntry{toks: entryToks})
	} else {
		if idx < 0 {
			return origBlock(loc), "", "", nil // remove-missing → no-op
		}
		entries = append(entries[:idx], entries[idx+1:]...)
	}

	block.Body().SetAttributeRaw(attr, buildTuple(entries))
	return hclwrite.Format(f.Bytes()), "", "", nil
}

// tupleEntry is one element of a literal list (its value tokens). It mirrors
// objEntry in setattr.go.
type tupleEntry struct {
	toks hclwrite.Tokens
}

// parseTuple splits a literal tuple token stream into ordered element entries.
// Returns ok=false when the expression is not a `[ … ]` literal, or when it holds
// a comment (a commented list is not a clean literal — a single-line rebuild would
// swallow the rest of the line, so it is refused rather than corrupted).
func parseTuple(toks hclwrite.Tokens) ([]tupleEntry, bool) {
	i := 0
	for i < len(toks) && (toks[i].Type == hclsyntax.TokenComment || toks[i].Type == hclsyntax.TokenNewline) {
		i++
	}
	if i >= len(toks) || toks[i].Type != hclsyntax.TokenOBrack {
		return nil, false
	}
	i++
	var entries []tupleEntry
	for i < len(toks) {
		switch toks[i].Type {
		case hclsyntax.TokenNewline, hclsyntax.TokenComma:
			i++
			continue
		case hclsyntax.TokenComment:
			return nil, false
		case hclsyntax.TokenCBrack:
			return entries, true
		}
		var valToks hclwrite.Tokens
		depth := 0
		for i < len(toks) {
			t := toks[i]
			if depth == 0 && (t.Type == hclsyntax.TokenNewline || t.Type == hclsyntax.TokenComma || t.Type == hclsyntax.TokenCBrack) {
				break
			}
			if t.Type == hclsyntax.TokenComment {
				return nil, false
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
		entries = append(entries, tupleEntry{toks: valToks})
	}
	return nil, false
}

// buildTuple renders entries as `[e0,e1,…]`; hclwrite.Format on the enclosing block
// re-spaces it to the canonical `[e0, e1, …]` (empty → `[]`).
func buildTuple(entries []tupleEntry) hclwrite.Tokens {
	toks := hclwrite.Tokens{{Type: hclsyntax.TokenOBrack, Bytes: []byte("[")}}
	for idx, e := range entries {
		if idx > 0 {
			toks = append(toks, &hclwrite.Token{Type: hclsyntax.TokenComma, Bytes: []byte(",")})
		}
		toks = append(toks, e.toks...)
	}
	return append(toks, &hclwrite.Token{Type: hclsyntax.TokenCBrack, Bytes: []byte("]")})
}
