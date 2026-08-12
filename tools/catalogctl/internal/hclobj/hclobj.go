// Package hclobj is the shared literal-object token-walking core CTL-10 found
// duplicated between internal/edit/setattr.go (parseObject/buildObject/keyString/
// keyTokens/anyToCty) and internal/driftpropose/adopt.go (parseObjectLiteral/
// buildObjectLiteral/keyLiteral/keyTokensFor/jsonToCty) — two independently
// re-implemented copies of "the same" byte-preserving parse/rebuild algorithm
// ("unexported there, so re-implemented rather than imported", adopt.go's own
// prior comment) that had ALREADY diverged by the time this audit found them:
// a mid-value (non-trailing) comment token survived a rebuild unmoved in the
// driftpropose copy, but was unconditionally hoisted out to trail the whole
// value in the edit copy — repositioning a comment on an entry the edit never
// touched. See ParseObject's doc comment for which behavior this package
// standardizes on, and why. CTL-1 (a full-line leading comment corrupting the
// parsed key) had already been hand-synced into both copies at once (bd7275b)
// specifically BECAUSE leaving one fixed and one not would have left the unfixed
// half looking maintained while it silently wasn't (L-8) — the right fix is this
// package, so that stops being something a future patch has to remember to do
// twice.
//
// Callers keep everything op-specific here: azure tag-case-folding, ensure-create,
// drift's MAP_ATTR_MISSING/NOT_LITERAL refusal wording, and whether a native Go
// int or a nil value is an accepted input shape (edit's request params: yes to
// int, no to nil — a nil param is always a caller bug; driftpropose's decoded
// liveJson: no to int — encoding/json never produces one, so seeing one means a
// caller routed the wrong kind of value in — yes to nil, a live attribute
// genuinely went to null). This package owns only the mechanical token walk both
// sides need to agree on.
package hclobj

import (
	"fmt"
	"regexp"
	"strings"

	"github.com/hashicorp/hcl/v2/hclsyntax"
	"github.com/hashicorp/hcl/v2/hclwrite"
	"github.com/zclconf/go-cty/cty"
)

// Entry is one parsed `key = value # comment` row of a literal object.
type Entry struct {
	Key string
	// Lead is trivia that sat on its own line(s) ABOVE this entry — full-line
	// comments. Carried separately so it can never leak into KeyToks (CTL-1) and
	// is re-emitted before the key so the bytes round-trip.
	Lead    hclwrite.Tokens
	KeyToks hclwrite.Tokens
	ValToks hclwrite.Tokens
	// Comment is a TRAILING line comment on the entry's own line (it carries its
	// own terminating newline). A comment that sits INSIDE the value instead
	// (`x = /* mid */ "v"`, or any non-trailing comment token) is NOT collected
	// here — ParseObject leaves it in ValToks, in place, so a rebuild never
	// repositions a comment on an entry the caller never touched. See
	// ParseObject's doc comment.
	Comment hclwrite.Tokens
}

// ParseObject splits a literal object token stream into ordered entries.
// Returns ok=false when the expression is not a `{ … }` literal — including a
// dangling comment after the last entry (nothing to attach it to; re-emitting it
// would move or drop it) and a comment token found where a key is expected (a
// key with a mid-key newline or comment is refused, never guessed at).
//
// Comment placement, reconciled from the two pre-extraction copies (CTL-10):
// a TRAILING single-line comment — one whose token bytes end in "\n", meaning it
// sits at the end of the entry's own line — is collected into Entry.Comment and
// re-emitted right after the value by BuildObject. Any OTHER comment token
// encountered while scanning a value (a block comment `/* … */`, or a line
// comment that for some reason does not end the token stream — HCL's lexer
// never actually emits the latter, but nothing here assumes it can't) is left
// IN PLACE inside ValToks instead of being hoisted into Comment. The
// pre-extraction edit/setattr.go copy hoisted every comment unconditionally;
// the driftpropose/adopt.go copy kept a non-trailing one in place specifically
// because hoisting it "moved it after the value on re-emit, rewriting an entry
// the merge never touched and adding a second added/removed line pair to what
// must be a one-line diff" (adopt.go's own prior reasoning) — a real, if rare,
// wrong-diff defect for edit's callers too (any set_attribute/append_foreach_entry
// touching a DIFFERENT key in the same map as an entry carrying a mid-value
// block comment would have repositioned it). This package keeps the more
// careful behavior for both callers.
func ParseObject(toks hclwrite.Tokens) ([]Entry, bool) {
	i := 0
	for i < len(toks) && (toks[i].Type == hclsyntax.TokenComment || toks[i].Type == hclsyntax.TokenNewline) {
		i++
	}
	if i >= len(toks) || toks[i].Type != hclsyntax.TokenOBrace {
		return nil, false
	}
	i++
	var entries []Entry
	for i < len(toks) {
		// Leading trivia. A single-line comment token CARRIES its terminating
		// newline ("# note\n" is ONE token), so a full-line comment above an entry
		// is not a TokenNewline and a naive key loop would append it to KeyToks —
		// yielding a key like "# owner of record\nPIC" that matches nothing
		// (CTL-1). The trivia is kept on the entry so BuildObject round-trips the
		// bytes rather than dropping a comment the operator wrote.
		var lead hclwrite.Tokens
		for i < len(toks) {
			switch toks[i].Type {
			case hclsyntax.TokenNewline, hclsyntax.TokenComma:
				i++
				continue
			case hclsyntax.TokenComment:
				lead = append(lead, toks[i])
				i++
				continue
			}
			break
		}
		if i >= len(toks) {
			return nil, false
		}
		if toks[i].Type == hclsyntax.TokenCBrace {
			if len(lead) > 0 {
				// A dangling comment after the last entry has no entry to attach
				// to; re-emitting it would move or drop it. Refuse rather than
				// guess — NOT_LITERAL is loud and leaves the tree untouched.
				return nil, false
			}
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
				if depth == 0 && strings.HasSuffix(string(t.Bytes), "\n") {
					// A single-line comment token carries its terminating
					// newline, so at depth 0 it also ENDS the entry — without
					// this, the next entry's tokens are swallowed into this
					// one's ValToks and a rebuild glues two entries onto one
					// line at exit 0 (measured: corrupted a tags map with a
					// mid-map trailing comment, and defeated the foreach
					// KEY_CONFLICT guard for the swallowed key).
					comment = append(comment, t)
					i++
					break
				}
				// Any other comment sits INSIDE the value. Keep it there — see
				// this function's doc comment.
				valToks = append(valToks, t)
				i++
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
		entries = append(entries, Entry{Key: KeyString(keyToks), Lead: lead, KeyToks: keyToks, ValToks: valToks, Comment: comment})
	}
	return nil, false
}

// BuildObject re-emits entries as a multi-line `{ k = v\n … }` object;
// hclwrite.Format (called on the whole block afterward) re-aligns it to
// canonical form.
func BuildObject(entries []Entry) hclwrite.Tokens {
	toks := hclwrite.Tokens{
		{Type: hclsyntax.TokenOBrace, Bytes: []byte("{")},
		{Type: hclsyntax.TokenNewline, Bytes: []byte("\n")},
	}
	for _, e := range entries {
		// Leading full-line comments come back out above their entry; each
		// already carries its own newline (see ParseObject), so no separator is
		// added.
		toks = append(toks, e.Lead...)
		toks = append(toks, e.KeyToks...)
		toks = append(toks, &hclwrite.Token{Type: hclsyntax.TokenEqual, Bytes: []byte("=")})
		toks = append(toks, e.ValToks...)
		toks = append(toks, e.Comment...)
		// A trailing line comment already carries the entry's newline (see
		// ParseObject) — appending another would leave a blank line mid-map.
		if n := len(e.Comment); n > 0 && strings.HasSuffix(string(e.Comment[n-1].Bytes), "\n") {
			continue
		}
		toks = append(toks, &hclwrite.Token{Type: hclsyntax.TokenNewline, Bytes: []byte("\n")})
	}
	return append(toks, &hclwrite.Token{Type: hclsyntax.TokenCBrace, Bytes: []byte("}")})
}

// KeyString strips surrounding quotes (if any) from a parsed key's token bytes,
// yielding the bare key string ("Owner", not `"Owner"`).
func KeyString(toks hclwrite.Tokens) string {
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

// KeyTokens renders a NEW key: a bare identifier when it looks like one,
// otherwise a fully-escaped string literal via the same safe seam values use
// (TokensForValue) — never raw bytes.
//
// SECURITY: a non-identifier map key must be emitted as a fully-escaped string
// literal, NOT its raw bytes. Raw bytes let a crafted key containing
// `"`/newline/`{`/`}` break out of the map — hclwrite.Format then re-lexes the
// debris into REAL top-level structure at exit 0 (confirmed pre-extraction:
// s3-update-tags injecting `force_destroy = true`). TokensForValue is the same
// seam values already use safely; it escapes `"` → \", newline → \n, etc., so
// the produced tokens can never desync from the surrounding `{ … }`.
func KeyTokens(k string) hclwrite.Tokens {
	if hclIdentRe.MatchString(k) {
		return hclwrite.Tokens{{Type: hclsyntax.TokenIdent, Bytes: []byte(k)}}
	}
	return hclwrite.TokensForValue(cty.StringVal(k))
}

// ErrUnsupportedType is returned by ValueToCty for a value shape (at any
// recursion depth) that opts did not allow. Value is the offending value
// itself, so each caller can render its own existing wording — edit's
// "unsupported value type %T" and driftpropose's "unsupported liveJson value
// type %T" both predate this package and stay byte-identical after it.
type ErrUnsupportedType struct{ Value any }

func (e ErrUnsupportedType) Error() string {
	return fmt.Sprintf("unsupported value type %T", e.Value)
}

// ValueOptions is the op-specific policy CTL-10's recommendation asks to keep at
// the call sites: which native shapes ValueToCty accepts, for a domain where
// admitting one is a real behavior change, not a formatting nicety.
type ValueOptions struct {
	// AllowInt admits a native Go int/int64 (edit's request params, which can
	// arrive via YAML decoding a whole number as an int — never true for
	// driftpropose's liveJson, which is always encoding/json output and so
	// never produces one; seeing one there means a caller routed the wrong
	// kind of value in).
	AllowInt bool
	// AllowNull admits v == nil (at any recursion depth) as a real HCL
	// `null`, not an error. driftpropose's liveJson uses it to mean "this
	// attribute genuinely went to null"; edit's request params never
	// legitimately carry a nil value, so a nil there stays a caller bug.
	AllowNull bool
}

// ValueToCty converts a decoded value — the shapes hclwrite.TokensForValue can
// render: string/bool/float64/[]any/map[string]any, plus int/int64 when
// opts.AllowInt and nil when opts.AllowNull — into the equivalent cty.Value.
// The int-vs-float distinction on a float64 renders a whole-numbered value as
// "80", never the surprising "80.0". opts applies at EVERY recursion depth, not
// just the top level, so a disallowed shape nested inside an allowed list/map
// is still refused (ErrUnsupportedType, wrapping the exact offending value).
func ValueToCty(v any, opts ValueOptions) (cty.Value, error) {
	if v == nil {
		if opts.AllowNull {
			return cty.NullVal(cty.DynamicPseudoType), nil
		}
		return cty.NilVal, ErrUnsupportedType{Value: v}
	}
	switch n := v.(type) {
	case string:
		return cty.StringVal(n), nil
	case bool:
		return cty.BoolVal(n), nil
	case int:
		if !opts.AllowInt {
			return cty.NilVal, ErrUnsupportedType{Value: v}
		}
		return cty.NumberIntVal(int64(n)), nil
	case int64:
		if !opts.AllowInt {
			return cty.NilVal, ErrUnsupportedType{Value: v}
		}
		return cty.NumberIntVal(n), nil
	case float64:
		if n == float64(int64(n)) {
			return cty.NumberIntVal(int64(n)), nil
		}
		return cty.NumberFloatVal(n), nil
	case []any:
		// a YAML sequence / JSON array → a tuple literal (heterogeneous
		// element types are allowed; TokensForValue renders `[a, b, …]`).
		if len(n) == 0 {
			return cty.EmptyTupleVal, nil
		}
		vals := make([]cty.Value, len(n))
		for i, e := range n {
			ev, err := ValueToCty(e, opts)
			if err != nil {
				return cty.NilVal, err
			}
			vals[i] = ev
		}
		return cty.TupleVal(vals), nil
	case map[string]any:
		// a YAML/JSON object → an object literal (`{ k = v, … }`).
		if len(n) == 0 {
			return cty.EmptyObjectVal, nil
		}
		m := make(map[string]cty.Value, len(n))
		for k, e := range n {
			ev, err := ValueToCty(e, opts)
			if err != nil {
				return cty.NilVal, err
			}
			m[k] = ev
		}
		return cty.ObjectVal(m), nil
	}
	return cty.NilVal, ErrUnsupportedType{Value: v}
}
