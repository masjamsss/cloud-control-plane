package hclobj

import (
	"strings"
	"testing"

	"github.com/hashicorp/hcl/v2"
	"github.com/hashicorp/hcl/v2/hclwrite"
)

// hclobj_test.go pins this package's own contract directly, independent of
// either caller it was extracted from (internal/edit and internal/driftpropose
// both exercise it thoroughly, transitively, through their own suites — CTL-10's
// extraction left exactly one assertion needing an update across both, meaning
// coverage already carried over almost unchanged). What's tested here
// specifically is the RECONCILIATION itself: the one behavior CTL-10 found the
// two pre-extraction copies actually disagreeing on, now a single documented
// fact about this package rather than an implicit property of whichever copy a
// reader happens to be looking at.

func parseBlockAttr(t *testing.T, src, attr string) hclwrite.Tokens {
	t.Helper()
	f, diags := hclwrite.ParseConfig([]byte(src), "x.tf", hcl.Pos{Line: 1, Column: 1})
	if diags.HasErrors() {
		t.Fatal(diags.Error())
	}
	blocks := f.Body().Blocks()
	if len(blocks) != 1 {
		t.Fatalf("expected exactly one block, got %d", len(blocks))
	}
	a := blocks[0].Body().GetAttribute(attr)
	if a == nil {
		t.Fatalf("attribute %q not found", attr)
	}
	return a.Expr().BuildTokens(nil)
}

func toksString(toks hclwrite.Tokens) string {
	var sb strings.Builder
	for _, t := range toks {
		sb.Write(t.Bytes)
	}
	return sb.String()
}

// TestParseObjectRoundTrip proves parse→build reproduces the exact input bytes
// for a plain, comment-free literal — the baseline every other case in this file
// is a deliberate variation on.
func TestParseObjectRoundTrip(t *testing.T) {
	const body = "{\n  Env = \"prod\"\n  Owner = \"platform\"\n}"
	toks := parseBlockAttr(t, "resource \"x\" \"y\" {\n  tags = "+body+"\n}\n", "tags")
	entries, ok := ParseObject(toks)
	if !ok {
		t.Fatal("ParseObject not ok")
	}
	if len(entries) != 2 || entries[0].Key != "Env" || entries[1].Key != "Owner" {
		t.Fatalf("entries = %+v", entries)
	}
	got := toksString(BuildObject(entries))
	want := toksString(toks)
	if got != want {
		t.Fatalf("round trip changed bytes:\ngot:  %q\nwant: %q", got, want)
	}
}

// TestParseObjectLeadingCommentStaysWithItsEntry pins CTL-1 (already fixed in
// both pre-extraction copies, now one fact about this package): a full-line
// comment above an entry must not be absorbed into the key, and must be dropped
// along with its entry on removal — never left dangling, never attached to the
// wrong key.
func TestParseObjectLeadingCommentStaysWithItsEntry(t *testing.T) {
	const src = "resource \"x\" \"y\" {\n  tags = {\n    # owner of record\n    PIC = \"a\"\n    CostCenter = \"b\"\n  }\n}\n"
	entries, ok := ParseObject(parseBlockAttr(t, src, "tags"))
	if !ok {
		t.Fatal("ParseObject not ok")
	}
	if len(entries) != 2 || entries[0].Key != "PIC" || entries[1].Key != "CostCenter" {
		t.Fatalf("entries = %+v — a leading comment must not leak into the key", entries)
	}
	if !strings.Contains(toksString(entries[0].Lead), "owner of record") {
		t.Fatalf("leading comment lost: %+v", entries[0])
	}
	// Drop the commented entry — its Lead must go with it, not linger.
	kept := []Entry{entries[1]}
	got := toksString(BuildObject(kept))
	if strings.Contains(got, "owner of record") {
		t.Fatalf("dropped entry's leading comment survived the rebuild:\n%s", got)
	}
	if !strings.Contains(got, "CostCenter") {
		t.Fatalf("surviving entry lost:\n%s", got)
	}
}

// TestParseObjectCommentPlacement pins the CTL-10 reconciliation directly: a
// TRAILING line comment (ends its own line) is collected into Entry.Comment and
// re-emitted after the value; any OTHER comment token (a block comment, or a
// line comment that for whatever reason isn't the last thing on its line) stays
// exactly where it was found, inside ValToks — never hoisted, so a rebuild can
// never reposition a comment on an entry nothing actually changed.
func TestParseObjectCommentPlacement(t *testing.T) {
	t.Run("trailing comment collected separately and re-emitted after the value", func(t *testing.T) {
		const src = "resource \"x\" \"y\" {\n  tags = {\n    Env = \"prod\" # do not touch\n  }\n}\n"
		entries, ok := ParseObject(parseBlockAttr(t, src, "tags"))
		if !ok {
			t.Fatal("ParseObject not ok")
		}
		if len(entries) != 1 {
			t.Fatalf("entries = %+v", entries)
		}
		if got := toksString(entries[0].ValToks); strings.Contains(got, "do not touch") {
			t.Fatalf("trailing comment leaked into ValToks: %q", got)
		}
		if !strings.Contains(toksString(entries[0].Comment), "do not touch") {
			t.Fatalf("trailing comment not collected: %+v", entries[0])
		}
		// toksString concatenates raw token bytes with no inserted spacing
		// (hclwrite carries that out of band), so the value and comment are
		// checked as adjacent bytes in order, not as a spaced phrase.
		got := toksString(BuildObject(entries))
		if !strings.Contains(got, "\"prod\"# do not touch") {
			t.Fatalf("rebuild did not place the trailing comment right after the value:\n%s", got)
		}
	})

	t.Run("mid-value block comment stays in place, not hoisted", func(t *testing.T) {
		const src = "resource \"x\" \"y\" {\n  tags = {\n    Env = /* why */ \"prod\"\n    Owner = \"platform\"\n  }\n}\n"
		entries, ok := ParseObject(parseBlockAttr(t, src, "tags"))
		if !ok {
			t.Fatal("ParseObject not ok")
		}
		if len(entries) != 2 {
			t.Fatalf("entries = %+v", entries)
		}
		if len(entries[0].Comment) != 0 {
			t.Fatalf("mid-value comment was hoisted into Entry.Comment: %+v", entries[0])
		}
		if got := toksString(entries[0].ValToks); !strings.Contains(got, "why") {
			t.Fatalf("mid-value comment dropped from ValToks: %q", got)
		}
		// Rebuild must not add a SECOND changed line for an entry nothing here
		// touched (the exact defect the pre-extraction edit/setattr.go copy had:
		// hoisting moved the comment after the value, rewriting Env's line even
		// though only Owner's is meant to differ from source).
		got := toksString(BuildObject(entries))
		if !strings.Contains(got, "/* why */\"prod\"") {
			t.Fatalf("mid-value comment moved on rebuild:\n%s", got)
		}
	})
}

// TestParseObjectDanglingCommentRefuses pins the fail-closed shape: a comment
// after the last entry, with nothing to attach to, refuses rather than silently
// dropping or misplacing it.
func TestParseObjectDanglingCommentRefuses(t *testing.T) {
	const src = "resource \"x\" \"y\" {\n  tags = {\n    Env = \"prod\"\n    # orphaned\n  }\n}\n"
	_, ok := ParseObject(parseBlockAttr(t, src, "tags"))
	if ok {
		t.Fatal("want ok=false for a dangling trailing comment")
	}
}

// TestKeyTokens pins the SECURITY-critical branch: a non-identifier key must
// render as an escaped string literal, never raw bytes that could break out of
// the map (CTL-10's shared home for what both pre-extraction copies called
// keyTokens/keyTokensFor).
func TestKeyTokens(t *testing.T) {
	if got := toksString(KeyTokens("Owner")); got != "Owner" {
		t.Fatalf("bare identifier key = %q, want unquoted Owner", got)
	}
	got := toksString(KeyTokens(`bad" key`))
	if !strings.HasPrefix(got, `"`) || !strings.Contains(got, `\"`) {
		t.Fatalf("non-identifier key not escaped as a string literal: %q", got)
	}
}

// TestValueToCtyOptions pins ValueOptions as the call-site policy CTL-10's
// recommendation asks for: AllowInt and AllowNull each gate their shape at
// EVERY recursion depth, not just the top level, and a disallowed shape reports
// ErrUnsupportedType naming the exact offending value.
func TestValueToCtyOptions(t *testing.T) {
	t.Run("AllowInt false refuses a top-level int", func(t *testing.T) {
		_, err := ValueToCty(42, ValueOptions{})
		var ut ErrUnsupportedType
		if err == nil || !AsErrUnsupportedType(err, &ut) || ut.Value != 42 {
			t.Fatalf("err = %v, want ErrUnsupportedType{Value: 42}", err)
		}
	})
	t.Run("AllowInt true accepts a top-level int", func(t *testing.T) {
		v, err := ValueToCty(42, ValueOptions{AllowInt: true})
		if err != nil || v.AsBigFloat().String() != "42" {
			t.Fatalf("v=%v err=%v, want 42", v, err)
		}
	})
	t.Run("AllowInt gates a NESTED int too, not just the top level", func(t *testing.T) {
		_, err := ValueToCty(map[string]any{"k": []any{int8(1)}}, ValueOptions{})
		var ut ErrUnsupportedType
		if err == nil || !AsErrUnsupportedType(err, &ut) {
			t.Fatalf("err = %v, want ErrUnsupportedType for the nested int8", err)
		}
		if _, ok := ut.Value.(int8); !ok {
			t.Fatalf("ErrUnsupportedType.Value = %#v, want the nested int8 itself", ut.Value)
		}
	})
	t.Run("AllowNull false refuses nil", func(t *testing.T) {
		_, err := ValueToCty(nil, ValueOptions{})
		if err == nil {
			t.Fatal("want an error for nil with AllowNull false")
		}
	})
	t.Run("AllowNull true accepts nil as a real null, at any depth", func(t *testing.T) {
		v, err := ValueToCty(map[string]any{"k": nil}, ValueOptions{AllowNull: true})
		if err != nil {
			t.Fatalf("err = %v", err)
		}
		if !v.GetAttr("k").IsNull() {
			t.Fatalf("v[\"k\"] = %v, want null", v.GetAttr("k"))
		}
	})
	t.Run("a whole-numbered float renders as an int, never the surprising .0", func(t *testing.T) {
		v, err := ValueToCty(float64(80), ValueOptions{})
		if err != nil || v.AsBigFloat().String() != "80" {
			t.Fatalf("v=%v err=%v, want 80", v, err)
		}
	})
}

// AsErrUnsupportedType is errors.As, inlined so this test file needs no extra
// import — ErrUnsupportedType is a value type (not wrapped), so a plain type
// assertion is equivalent here.
func AsErrUnsupportedType(err error, target *ErrUnsupportedType) bool {
	ut, ok := err.(ErrUnsupportedType)
	if ok {
		*target = ut
	}
	return ok
}
