package edit

import (
	"strings"
	"testing"

	"github.com/hashicorp/hcl/v2"
	"github.com/hashicorp/hcl/v2/hclwrite"

	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/hclops"
	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/manifests"
	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/request"
)

// ensureattr_test.go — 0019 D-1 "ensure-map/list-on-edit" (Target.EnsureAttr).
// The capability: append_foreach_entry / set_attribute(mergeMap) / append_list_entry
// CREATE the missing map/list attribute (`tags = { k = v }` / `aliases = [v]`) when
// the flag is set, instead of the pre-0019 exit-1 "attribute not found". Default OFF
// preserves that exit-1 exactly. Removes on an absent map/list are an unconditional
// NOOP (nothing to remove), not gated by the flag.

// attrText returns the literal token text of block's attribute (or "" if absent).
func attrText(t *testing.T, out []byte, resType, name, attr string) (string, bool) {
	t.Helper()
	f, diags := hclwrite.ParseConfig(out, "out.tf", hcl.Pos{Line: 1, Column: 1})
	if diags.HasErrors() {
		t.Fatalf("output is not valid HCL: %v\n%s", diags, out)
	}
	blk := f.Body().FirstMatchingBlock("resource", []string{resType, name})
	if blk == nil {
		t.Fatalf("resource %s.%s missing after edit:\n%s", resType, name, out)
	}
	a := blk.Body().GetAttribute(attr)
	if a == nil {
		return "", false
	}
	return tokensString(a.Expr().BuildTokens(nil)), true
}

func addTagOp(ensure bool) manifests.Op {
	op := manifests.Op{
		ID:        "dynamodb-add-tag",
		CodemodOp: "append_foreach_entry",
		Params: []manifests.Param{
			{Name: "table", Source: "inventory"},
			{Name: "tag_key", Source: "user_input"},
			{Name: "tag_value", Source: "user_input"},
		},
	}
	op.Target.ResourceType = "aws_dynamodb_table"
	op.Target.Block = "tags"
	op.Target.EnsureAttr = ensure
	return op
}

// DRIVING: append_foreach_entry with ensureAttr on a resource that has NO tags map
// creates `tags = { key = value }` and exits 0 (was exit-1 "map attribute not found").
func TestAppendForeachEntryEnsureCreatesAbsentMap(t *testing.T) {
	src := []byte("resource \"aws_dynamodb_table\" \"x\" {\n  name = \"t\"\n}\n")
	loc := &hclops.Located{File: "x.tf", Bytes: src, Start: 0, End: len(src)}
	op := addTagOp(true)
	req := &request.Request{Params: map[string]any{"table": "aws_dynamodb_table.x", "tag_key": "Team", "tag_value": "erp"}}

	out, code, reason, err := appendForeachEntry(op, req, loc)
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if code != "" {
		t.Fatalf("code = %q reason = %q, want no refusal (ensureAttr creates the map)", code, reason)
	}
	if out == nil {
		t.Fatalf("expected a write, got nil")
	}
	got, ok := attrText(t, out, "aws_dynamodb_table", "x", "tags")
	if !ok {
		t.Fatalf("tags attribute was not created:\n%s", out)
	}
	if !strings.Contains(got, "Team") || !strings.Contains(got, "erp") {
		t.Fatalf("created tags = %q, want it to contain Team = erp:\n%s", got, out)
	}
}

// REGRESSION GUARD: WITHOUT the flag, an absent tags map is still the exit-1 error —
// no silent behavior change.
func TestAppendForeachEntryWithoutEnsureStillErrorsOnAbsentMap(t *testing.T) {
	src := []byte("resource \"aws_dynamodb_table\" \"x\" {\n  name = \"t\"\n}\n")
	loc := &hclops.Located{File: "x.tf", Bytes: src, Start: 0, End: len(src)}
	op := addTagOp(false)
	req := &request.Request{Params: map[string]any{"table": "aws_dynamodb_table.x", "tag_key": "Team", "tag_value": "erp"}}

	out, _, _, err := appendForeachEntry(op, req, loc)
	if err == nil {
		t.Fatalf("expected the pre-0019 exit-1 error on an absent map without ensureAttr, got out=%d bytes", len(out))
	}
	if out != nil {
		t.Fatalf("expected no write on the error, got %d bytes", len(out))
	}
}

// IDEMPOTENCE: with ensureAttr set but the key already present at the same value, a
// re-run is a byte-identical no-op (returns the original block).
func TestAppendForeachEntryEnsureIdempotentOnceKeyExists(t *testing.T) {
	src := []byte("resource \"aws_dynamodb_table\" \"x\" {\n  tags = {\n    Team = \"erp\"\n  }\n}\n")
	loc := &hclops.Located{File: "x.tf", Bytes: src, Start: 0, End: len(src)}
	op := addTagOp(true)
	req := &request.Request{Params: map[string]any{"table": "aws_dynamodb_table.x", "tag_key": "Team", "tag_value": "erp"}}

	out, code, _, err := appendForeachEntry(op, req, loc)
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if code != "" {
		t.Fatalf("code = %q, want no refusal", code)
	}
	if string(out) != string(loc.Bytes[loc.Start:loc.End]) {
		t.Fatalf("expected an idempotent no-op (original bytes), got:\n%s", out)
	}
}

// DRIVING: remove_foreach_entry on an absent map is a NOOP (nothing to remove), not
// an exit-1 error — executor robustness, NOT gated by ensureAttr (0031 §3).
func TestRemoveForeachEntryAbsentMapNoops(t *testing.T) {
	src := []byte("resource \"aws_dynamodb_table\" \"x\" {\n  name = \"t\"\n}\n")
	loc := &hclops.Located{File: "x.tf", Bytes: src, Start: 0, End: len(src)}
	op := manifests.Op{
		ID:        "dynamodb-remove-tag",
		CodemodOp: "remove_foreach_entry",
		Params: []manifests.Param{
			{Name: "table", Source: "inventory"},
			{Name: "key", Source: "user_input"},
		},
	}
	op.Target.ResourceType = "aws_dynamodb_table"
	op.Target.Block = "tags"
	// EnsureAttr deliberately NOT set: the remove-NOOP is unconditional.
	req := &request.Request{Params: map[string]any{"table": "aws_dynamodb_table.x", "key": "Team"}}

	out, code, _, err := removeForeachEntry(op, req, loc)
	if err != nil {
		t.Fatalf("err = %v, want a clean NOOP on an absent map", err)
	}
	if code != "" {
		t.Fatalf("code = %q, want no refusal (remove-of-absent is a NOOP)", code)
	}
	if string(out) != string(loc.Bytes[loc.Start:loc.End]) {
		t.Fatalf("expected the original bytes (no-op), got:\n%s", out)
	}
}

// DRIVING: mergeMap with ensure creates the absent object and merges every key.
func TestMergeMapEnsureCreatesAbsentMap(t *testing.T) {
	block := parentBlock(t, "resource \"aws_sns_topic\" \"x\" {\n  name = \"alerts\"\n}\n")
	code, reason, err := mergeMap(block, "tags", map[string]any{"CostCentre": "erp-basis"}, true, "aws_sns_topic")
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if code != "" {
		t.Fatalf("code = %q reason = %q, want no refusal (ensure creates the map)", code, reason)
	}
	a := block.Body().GetAttribute("tags")
	if a == nil {
		t.Fatalf("tags attribute was not created")
	}
	if got := tokensString(a.Expr().BuildTokens(nil)); !strings.Contains(got, "CostCentre") || !strings.Contains(got, "erp-basis") {
		t.Fatalf("created tags = %q, want CostCentre = erp-basis", got)
	}
}

// REGRESSION GUARD: mergeMap WITHOUT ensure still errors on an absent object.
func TestMergeMapWithoutEnsureErrorsOnAbsentMap(t *testing.T) {
	block := parentBlock(t, "resource \"aws_sns_topic\" \"x\" {\n  name = \"alerts\"\n}\n")
	_, _, err := mergeMap(block, "tags", map[string]any{"CostCentre": "erp-basis"}, false, "aws_sns_topic")
	if err == nil {
		t.Fatalf("expected the pre-0019 exit-1 error on an absent map without ensure")
	}
}

// REGRESSION GUARD: on a resource that already HAS a literal tags map, ensure=true
// leaves the merge as a union — existing keys are preserved, requested keys added.
func TestMergeMapEnsureUnionPreservesExisting(t *testing.T) {
	block := parentBlock(t, "resource \"aws_sns_topic\" \"x\" {\n  tags = {\n    Owner = \"basis\"\n  }\n}\n")
	code, _, err := mergeMap(block, "tags", map[string]any{"CostCentre": "erp"}, true, "aws_sns_topic")
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if code != "" {
		t.Fatalf("code = %q, want no refusal", code)
	}
	got := tokensString(block.Body().GetAttribute("tags").Expr().BuildTokens(nil))
	if !strings.Contains(got, "Owner") || !strings.Contains(got, "basis") {
		t.Fatalf("union merge dropped the existing key: %q", got)
	}
	if !strings.Contains(got, "CostCentre") {
		t.Fatalf("union merge did not add the requested key: %q", got)
	}
}

func addAliasOp(ensure bool, codemod string) manifests.Op {
	op := manifests.Op{
		ID:        "cloudfront-add-alternate-domain",
		CodemodOp: codemod,
		Params: []manifests.Param{
			{Name: "distribution", Source: "inventory"},
			{Name: "new_alias", Source: "user_input"},
		},
	}
	op.Target.ResourceType = "aws_cloudfront_distribution"
	op.Target.Block = "aliases"
	op.Target.EnsureAttr = ensure
	return op
}

// DRIVING (D-2 list flavor): append_list_entry with ensureAttr on a resource with NO
// aliases list creates `aliases = ["d1.example.com"]` and exits 0.
func TestAppendListEntryEnsureCreatesAbsentList(t *testing.T) {
	src := []byte("resource \"aws_cloudfront_distribution\" \"x\" {\n  enabled = true\n}\n")
	loc := &hclops.Located{File: "x.tf", Bytes: src, Start: 0, End: len(src)}
	op := addAliasOp(true, "append_list_entry")
	req := &request.Request{Params: map[string]any{"distribution": "aws_cloudfront_distribution.x", "new_alias": "d1.example.com"}}

	out, code, reason, err := appendListEntry(op, req, loc)
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if code != "" {
		t.Fatalf("code = %q reason = %q, want no refusal (ensureAttr creates the list)", code, reason)
	}
	got, ok := attrText(t, out, "aws_cloudfront_distribution", "x", "aliases")
	if !ok {
		t.Fatalf("aliases attribute was not created:\n%s", out)
	}
	if !strings.Contains(got, "d1.example.com") || !strings.Contains(got, "[") {
		t.Fatalf("created aliases = %q, want a list literal containing d1.example.com:\n%s", got, out)
	}
}

// REGRESSION GUARD: append_list_entry WITHOUT ensure still errors on an absent list.
func TestAppendListEntryWithoutEnsureErrorsOnAbsentList(t *testing.T) {
	src := []byte("resource \"aws_cloudfront_distribution\" \"x\" {\n  enabled = true\n}\n")
	loc := &hclops.Located{File: "x.tf", Bytes: src, Start: 0, End: len(src)}
	op := addAliasOp(false, "append_list_entry")
	req := &request.Request{Params: map[string]any{"distribution": "aws_cloudfront_distribution.x", "new_alias": "d1.example.com"}}

	out, _, _, err := appendListEntry(op, req, loc)
	if err == nil {
		t.Fatalf("expected the pre-0019 exit-1 error on an absent list without ensureAttr, got out=%d bytes", len(out))
	}
	if out != nil {
		t.Fatalf("expected no write on the error, got %d bytes", len(out))
	}
}

// DRIVING: remove_list_entry on an absent list is a NOOP, not an error.
func TestRemoveListEntryAbsentListNoops(t *testing.T) {
	src := []byte("resource \"aws_cloudfront_distribution\" \"x\" {\n  enabled = true\n}\n")
	loc := &hclops.Located{File: "x.tf", Bytes: src, Start: 0, End: len(src)}
	op := addAliasOp(false, "remove_list_entry")
	req := &request.Request{Params: map[string]any{"distribution": "aws_cloudfront_distribution.x", "new_alias": "d1.example.com"}}

	out, code, _, err := removeListEntry(op, req, loc)
	if err != nil {
		t.Fatalf("err = %v, want a clean NOOP on an absent list", err)
	}
	if code != "" {
		t.Fatalf("code = %q, want no refusal (remove-of-absent is a NOOP)", code)
	}
	if string(out) != string(loc.Bytes[loc.Start:loc.End]) {
		t.Fatalf("expected the original bytes (no-op), got:\n%s", out)
	}
}
