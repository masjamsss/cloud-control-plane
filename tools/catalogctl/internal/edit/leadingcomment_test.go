package edit

import (
	"strings"
	"testing"

	"github.com/hashicorp/hcl/v2"
	"github.com/hashicorp/hcl/v2/hclwrite"

	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/hclobj"
	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/hclops"
	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/manifests"
	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/request"
)

// leadingcomment_test.go — CTL-1 (audit 07-catalogctl.md).
//
// A single-line comment token CARRIES its own terminating newline ("# note\n" is
// ONE token), so a full-line comment sitting on its own line ABOVE a map entry is
// not a TokenNewline. The VALUE loop learned that (the trailing-comment fix); the
// KEY loop did not, so the comment was appended into keyToks and keyString
// yielded a key like "# owner of record\nPIC" instead of "PIC". Every consumer
// then mis-identified the entry, at exit 0:
//
//	mergeMap             → requested key never matches → duplicate key appended
//	appendForeachEntry   → KEY_CONFLICT guard blinded  → duplicate key appended
//	removeForeachEntry   → key never found             → empty diff, nothing removed
//
// HCL evaluates duplicate object keys last-one-wins, so terraform plan and
// plan-check R1/R6 both pass on the corrupted file. Comments inside tags maps are
// completely ordinary Terraform, and tag-map ops are the largest op family in the
// shipped catalog. The parse/build walker itself (once setattr.go's own
// unexported parseObject/buildObject) now lives in internal/hclobj (CTL-10) —
// this file exercises it through mergeMap/appendForeachEntry/removeForeachEntry,
// the same way it always did.
//
// Every test below FAILS against the unfixed key loop.

// commentedTagsBlock is the natural fixture: a full-line comment on its own line
// directly above the entry each test targets.
const commentedTagsBlock = "resource \"aws_instance\" \"x\" {\n" +
	"  tags = {\n" +
	"    # owner of record\n" +
	"    PIC        = \"user05@example.com\"\n" +
	"    CostCenter = \"ERP-BASIS\"\n" +
	"  }\n" +
	"}\n"

func parseBlock(t *testing.T, src string) *hclwrite.Block {
	t.Helper()
	f, diags := hclwrite.ParseConfig([]byte(src), "x.tf", hcl.Pos{Line: 1, Column: 1})
	if diags.HasErrors() {
		t.Fatal(diags.Error())
	}
	return f.Body().Blocks()[0]
}

// TestParseObjectLeadingFullLineCommentKeepsKeyClean is the root-cause pin: the
// parsed keys must be the real keys, and the comment must survive as leading
// trivia so a rebuild is byte-preserving.
func TestParseObjectLeadingFullLineCommentKeepsKeyClean(t *testing.T) {
	block := parseBlock(t, commentedTagsBlock)
	entries, ok := hclobj.ParseObject(block.Body().GetAttribute("tags").Expr().BuildTokens(nil))
	if !ok {
		t.Fatal("parseObject not ok on a literal map with a full-line comment")
	}
	if len(entries) != 2 {
		t.Fatalf("parsed %d entries, want 2", len(entries))
	}
	if entries[0].Key != "PIC" || entries[1].Key != "CostCenter" {
		t.Fatalf("keys = %q,%q — want PIC,CostCenter (a full-line comment must not be absorbed into the key)",
			entries[0].Key, entries[1].Key)
	}
	if !strings.Contains(tokensString(entries[0].Lead), "owner of record") {
		t.Fatalf("the full-line comment was dropped instead of kept as leading trivia: %q",
			tokensString(entries[0].Lead))
	}
}

// TestMergeMapLeadingCommentUpdatesInPlace: the set_attribute map-merge lane
// (every *-update-tags op). Unfixed, this writes a SECOND `PIC = …` line at exit 0
// and leaves the stale one behind.
func TestMergeMapLeadingCommentUpdatesInPlace(t *testing.T) {
	block := parseBlock(t, commentedTagsBlock)
	code, reason, err := mergeMap(block, "tags", map[string]any{"PIC": "user09@example.com"}, false, "aws_instance")
	if err != nil || code != "" {
		t.Fatalf("code=%q reason=%q err=%v, want a clean merge", code, reason, err)
	}
	got := tokensString(block.Body().GetAttribute("tags").Expr().BuildTokens(nil))
	if n := strings.Count(got, "PIC"); n != 1 {
		t.Fatalf("PIC appears %d times — duplicate map key written at exit 0:\n%s", n, got)
	}
	if strings.Contains(got, "user05@example.com") {
		t.Fatalf("stale value survived alongside the new one:\n%s", got)
	}
	if !strings.Contains(got, "user09@example.com") {
		t.Fatalf("requested value not written:\n%s", got)
	}
	if !strings.Contains(got, "owner of record") {
		t.Fatalf("the sibling comment was dropped:\n%s", got)
	}
}

func tagForeachOp(codemod string) manifests.Op {
	op := manifests.Op{
		ID:        "ec2-tag-op",
		CodemodOp: codemod,
		Params: []manifests.Param{
			{Name: "instance", Source: "inventory"},
			{Name: "tag_key", Source: "user_input"},
			{Name: "tag_value", Source: "user_input"},
		},
	}
	op.Target.ResourceType = "aws_instance"
	op.Target.Block = "tags"
	return op
}

// TestAppendForeachEntryLeadingCommentKeyConflictFires: the KEY_CONFLICT guard
// ("an add never silently overwrites") must still see the commented entry.
// Unfixed, this appends a duplicate key at exit 0 and last-one-wins silently
// CHANGES the protected value — the exact outcome the guard exists to prevent.
func TestAppendForeachEntryLeadingCommentKeyConflictFires(t *testing.T) {
	src := []byte(commentedTagsBlock)
	loc := &hclops.Located{File: "x.tf", Bytes: src, Start: 0, End: len(src)}
	req := &request.Request{Params: map[string]any{
		"instance": "aws_instance.x", "tag_key": "PIC", "tag_value": "user09@example.com",
	}}

	out, code, _, err := appendForeachEntry(tagForeachOp("append_foreach_entry"), req, loc)
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if code != "KEY_CONFLICT" {
		t.Fatalf("code = %q, want KEY_CONFLICT (the commented PIC entry already holds a different value)\n%s", code, out)
	}
	if out != nil {
		t.Fatalf("a refusal must not write:\n%s", out)
	}
}

// TestRemoveForeachEntryLeadingCommentActuallyRemoves: unfixed, the key is never
// found, so this is exit 0 with an empty diff — the pipeline believes a removal
// happened and the for_each-backed resource silently survives.
func TestRemoveForeachEntryLeadingCommentActuallyRemoves(t *testing.T) {
	src := []byte(commentedTagsBlock)
	loc := &hclops.Located{File: "x.tf", Bytes: src, Start: 0, End: len(src)}
	req := &request.Request{Params: map[string]any{"instance": "aws_instance.x", "tag_key": "PIC"}}

	out, code, reason, err := removeForeachEntry(tagForeachOp("remove_foreach_entry"), req, loc)
	if err != nil || code != "" {
		t.Fatalf("code=%q reason=%q err=%v, want a clean remove", code, reason, err)
	}
	if strings.Contains(string(out), "PIC") {
		t.Fatalf("PIC was not removed — exit 0 with nothing done:\n%s", out)
	}
	if !strings.Contains(string(out), "CostCenter") {
		t.Fatalf("the sibling entry was lost:\n%s", out)
	}
}

// TestParseObjectLeadingCommentRoundTripsBytes: parse → build must not lose or
// reorder the trivia, so an unrelated edit keeps comment-bearing siblings intact.
func TestParseObjectLeadingCommentRoundTripsBytes(t *testing.T) {
	block := parseBlock(t, commentedTagsBlock)
	entries, ok := hclobj.ParseObject(block.Body().GetAttribute("tags").Expr().BuildTokens(nil))
	if !ok {
		t.Fatal("parseObject not ok")
	}
	got := tokensString(hclobj.BuildObject(entries))
	for _, want := range []string{"# owner of record", "PIC", "user05@example.com", "CostCenter"} {
		if !strings.Contains(got, want) {
			t.Fatalf("rebuilt map lost %q:\n%s", want, got)
		}
	}
	// The comment must precede the entry it annotates, not trail it.
	if strings.Index(got, "# owner of record") > strings.Index(got, "PIC") {
		t.Fatalf("leading comment moved below its entry:\n%s", got)
	}
}
