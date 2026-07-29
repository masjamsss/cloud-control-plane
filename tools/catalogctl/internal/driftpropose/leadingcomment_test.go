package driftpropose

import (
	"strings"
	"testing"

	"github.com/hashicorp/hcl/v2"
	"github.com/hashicorp/hcl/v2/hclwrite"
	"github.com/zclconf/go-cty/cty"
)

// leadingcomment_test.go — CTL-1, second copy (audit 07-catalogctl.md; CTL-10
// explains why there IS a second copy).
//
// parseObjectLiteral is a hand-ported sibling of internal/edit's parseObject and
// carries the identical key-loop defect: a full-line comment above a map entry is
// a TokenComment carrying its own newline, so it is appended into keyToks and the
// entry's key becomes "# owner of record\nOwner". mergeSingleKey then appends a
// DUPLICATE key and removeSingleKey removes nothing — and unlike the edit lane,
// drift-adopt writes straight into the bundle checkout.
//
// Both tests FAIL against the unfixed key loop.

const commentedDriftBlock = "resource \"aws_instance\" \"sample01\" {\n" +
	"  tags = {\n" +
	"    # owner of record\n" +
	"    Owner = \"basis\"\n" +
	"    Env   = \"prod\"\n" +
	"  }\n" +
	"}\n"

func driftBlock(t *testing.T) *hclwrite.Block {
	t.Helper()
	f, diags := hclwrite.ParseConfig([]byte(commentedDriftBlock), "x.tf", hcl.Pos{Line: 1, Column: 1})
	if diags.HasErrors() {
		t.Fatal(diags.Error())
	}
	return f.Body().Blocks()[0]
}

func tagsText(t *testing.T, block *hclwrite.Block) string {
	t.Helper()
	a := block.Body().GetAttribute("tags")
	if a == nil {
		t.Fatal("tags attribute vanished")
	}
	var sb strings.Builder
	for _, tok := range a.Expr().BuildTokens(nil) {
		sb.Write(tok.Bytes)
	}
	return sb.String()
}

// TestMergeSingleKeyLeadingCommentUpdatesInPlace: adopting a drifted value for a
// commented key must REPLACE it, not append a second `Owner = …` line into the
// operator's checkout.
func TestMergeSingleKeyLeadingCommentUpdatesInPlace(t *testing.T) {
	block := driftBlock(t)
	code, reason := mergeSingleKey(block, "tags", "Owner", cty.StringVal("erp"))
	if code != "" {
		t.Fatalf("code=%q reason=%q, want a clean merge", code, reason)
	}
	got := tagsText(t, block)
	if n := strings.Count(got, "Owner"); n != 1 {
		t.Fatalf("Owner appears %d times — duplicate map key written into the checkout:\n%s", n, got)
	}
	if strings.Contains(got, "basis") {
		t.Fatalf("stale value survived alongside the adopted one:\n%s", got)
	}
	if !strings.Contains(got, "owner of record") {
		t.Fatalf("the operator's comment was dropped:\n%s", got)
	}
	if !strings.Contains(got, "Env") {
		t.Fatalf("unrelated sibling key was lost:\n%s", got)
	}
}

// TestRemoveSingleKeyLeadingCommentActuallyRemoves: spec F3 — a live-null map
// segment REMOVES the key from code. Unfixed, the key is never matched, the
// rebuild is a no-op, and the caller reports "verified no-op" for a change that
// never happened.
func TestRemoveSingleKeyLeadingCommentActuallyRemoves(t *testing.T) {
	block := driftBlock(t)
	code, reason := removeSingleKey(block, "tags", "Owner")
	if code != "" {
		t.Fatalf("code=%q reason=%q, want a clean remove", code, reason)
	}
	got := tagsText(t, block)
	if strings.Contains(got, "Owner") {
		t.Fatalf("Owner was not removed — silent no-op:\n%s", got)
	}
	if !strings.Contains(got, "Env") {
		t.Fatalf("the sibling entry was lost:\n%s", got)
	}
}

// TestParseObjectLiteralLeadingCommentKeepsKeyClean pins the root cause directly.
func TestParseObjectLiteralLeadingCommentKeepsKeyClean(t *testing.T) {
	block := driftBlock(t)
	entries, ok := parseObjectLiteral(block.Body().GetAttribute("tags").Expr().BuildTokens(nil))
	if !ok {
		t.Fatal("parseObjectLiteral not ok on a literal map with a full-line comment")
	}
	if len(entries) != 2 {
		t.Fatalf("parsed %d entries, want 2", len(entries))
	}
	if entries[0].key != "Owner" || entries[1].key != "Env" {
		t.Fatalf("keys = %q,%q — want Owner,Env", entries[0].key, entries[1].key)
	}
}
