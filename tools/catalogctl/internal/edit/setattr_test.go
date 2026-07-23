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

func TestAttrNameResolution(t *testing.T) {
	ops, err := manifests.LoadDir("../../testdata/manifests")
	if err != nil {
		t.Fatal(err)
	}
	if got := attrName(ops["ec2-resize"]); got != "instance_type" {
		t.Fatalf("ec2-resize attrName = %q, want instance_type", got)
	}
	if got := attrName(ops["ebs-grow"]); got != "size" {
		t.Fatalf("ebs-grow attrName = %q, want size (reverse rename size_gib->size)", got)
	}
}

// TestTargetAttrAuthoritative proves op.Target.Attr supersedes the prose paren token
// in edit.attrName (0028 backlog #1, retires D1): when set it is returned verbatim and
// the terraformCapability prose is NEVER consulted.
func TestTargetAttrAuthoritative(t *testing.T) {
	mk := func(tc, targetAttr string, params ...manifests.Param) manifests.Op {
		op := manifests.Op{ID: "op", CodemodOp: "set_attribute", TerraformCapability: tc, Params: params}
		op.Target.ResourceType = "aws_x"
		op.Target.Attr = targetAttr
		return op
	}
	value := manifests.Param{Name: "new_status", Source: "user_input"}

	// D1 repro shape: prose says (acl) but the explicit target.attr says status — the
	// explicit field wins, so the WRONG-attribute write the prose would cause is gone.
	if got := attrName(mk("~ update (acl)", "status", value)); got != "status" {
		t.Fatalf("target.attr must override prose: got %q, want status", got)
	}
	// Absent target.attr → unchanged fallback (prose token wins over the param name).
	if got := attrName(mk("~ update (acl)", "", value)); got != "acl" {
		t.Fatalf("no target.attr → prose fallback: got %q, want acl", got)
	}
	// Absent target.attr and no bare prose token → AttrFor(value param).
	if got := attrName(mk("~ update (grow-only)", "", value)); got != "status" {
		t.Fatalf("no target.attr, prose not a token → AttrFor: got %q, want status", got)
	}
}

// TestTargetAttrOutputParity proves the end-to-end HCL output is byte-identical whether
// the write target is resolved from prose (un-migrated) or from an explicit target.attr
// (migrated). This is the golden-parity guarantee the migration relies on.
func TestTargetAttrOutputParity(t *testing.T) {
	src := []byte("resource \"aws_instance\" \"x\" {\n  instance_type = \"t3.small\"\n}\n")
	loc := &hclops.Located{File: "x.tf", Bytes: src, Start: 0, End: len(src)}
	req := &request.Request{Params: map[string]any{"target": "aws_instance.x", "new_instance_type": "t3.large"}}
	value := manifests.Param{Name: "new_instance_type", Source: "user_input"}
	locatorP := manifests.Param{Name: "target", Source: "inventory"}

	prose := manifests.Op{ID: "prose", CodemodOp: "set_attribute",
		TerraformCapability: "~ update (instance_type)", Params: []manifests.Param{locatorP, value}}
	prose.Target.ResourceType = "aws_instance"

	migrated := prose                                    // copy
	migrated.TerraformCapability = "~ update (in place)" // prose no longer names the attr
	migrated.Target.Attr = "instance_type"               // explicit, authoritative

	outProse, code1, _, err1 := setAttribute(prose, req, loc)
	outMig, code2, _, err2 := setAttribute(migrated, req, loc)
	if err1 != nil || err2 != nil || code1 != "" || code2 != "" {
		t.Fatalf("unexpected refuse/err: prose(%q,%v) migrated(%q,%v)", code1, err1, code2, err2)
	}
	if string(outProse) != string(outMig) {
		t.Fatalf("output differs between prose and target.attr:\n--- prose ---\n%s\n--- migrated ---\n%s", outProse, outMig)
	}
	if !strings.Contains(string(outMig), "instance_type = \"t3.large\"") {
		t.Fatalf("expected instance_type updated to t3.large, got:\n%s", outMig)
	}
}

// TestMergeMapNotLiteral: a reference/function-valued map attribute refuses
// NOT_LITERAL rather than silently rewriting (spec §3.1).
func TestMergeMapNotLiteral(t *testing.T) {
	src := []byte("resource \"aws_s3_bucket\" \"x\" {\n  tags = local.common_tags\n}\n")
	f, diags := hclwrite.ParseConfig(src, "x.tf", hcl.Pos{Line: 1, Column: 1})
	if diags.HasErrors() {
		t.Fatal(diags.Error())
	}
	block := f.Body().Blocks()[0]
	code, _, err := mergeMap(block, "tags", map[string]any{"PIC": "y"}, false, "aws_s3_bucket")
	if err != nil {
		t.Fatalf("mergeMap err = %v", err)
	}
	if code != "NOT_LITERAL" {
		t.Fatalf("code = %q, want NOT_LITERAL", code)
	}
}

// ── Lane K: azurerm tag-key case-collision guard (0039 §4.2) ────────────────
// Azure tag names are case-insensitive, so "Owner" and "owner" name the same
// tag — a map merge that would silently create a second, shadow key must
// refuse instead of writing HCL that diverges from what Azure will actually
// store. The guard is scoped to azurerm_* targets ONLY (SchemaDumpPrefix);
// aws_* targets — where tag keys genuinely ARE case-sensitive — keep today's
// behavior byte-for-byte.

// TestMergeMapAzureTagCaseCollisionRefuses: an incoming key that case-folds
// to an EXISTING key under a different byte spelling refuses
// TAG_KEY_CASE_COLLISION, naming both spellings, and leaves the block
// untouched (spec A2 — a refusal is never a partial write).
func TestMergeMapAzureTagCaseCollisionRefuses(t *testing.T) {
	src := []byte("resource \"azurerm_storage_account\" \"x\" {\n  tags = {\n    Owner = \"basis\"\n  }\n}\n")
	f, diags := hclwrite.ParseConfig(src, "x.tf", hcl.Pos{Line: 1, Column: 1})
	if diags.HasErrors() {
		t.Fatal(diags.Error())
	}
	block := f.Body().Blocks()[0]
	code, reason, err := mergeMap(block, "tags", map[string]any{"owner": "y"}, false, "azurerm_storage_account")
	if err != nil {
		t.Fatalf("mergeMap err = %v", err)
	}
	if code != "TAG_KEY_CASE_COLLISION" {
		t.Fatalf("code = %q, want TAG_KEY_CASE_COLLISION", code)
	}
	if !strings.Contains(reason, "Owner") || !strings.Contains(reason, "owner") {
		t.Fatalf("reason = %q, want it to name both spellings (Owner and owner)", reason)
	}
	got := tokensString(block.Body().GetAttribute("tags").Expr().BuildTokens(nil))
	if !strings.Contains(got, "\"basis\"") || strings.Contains(got, "\"y\"") {
		t.Fatalf("block was mutated on refusal, want untouched: %q", got)
	}
}

// TestMergeMapAzureReqMapInternalCaseCollisionRefuses: two keys in the SAME request
// that case-fold together ("Owner" and "owner") refuse even when NEITHER is already
// present in the block — otherwise both would append as case-distinct HCL keys and
// diverge from the single tag Azure actually stores.
func TestMergeMapAzureReqMapInternalCaseCollisionRefuses(t *testing.T) {
	src := []byte("resource \"azurerm_storage_account\" \"x\" {\n  tags = {\n    Team = \"platform\"\n  }\n}\n")
	f, diags := hclwrite.ParseConfig(src, "x.tf", hcl.Pos{Line: 1, Column: 1})
	if diags.HasErrors() {
		t.Fatal(diags.Error())
	}
	block := f.Body().Blocks()[0]
	// Neither Owner nor owner is already in the block — the collision is purely
	// between the two incoming keys.
	code, reason, err := mergeMap(block, "tags", map[string]any{"Owner": "a", "owner": "b"}, false, "azurerm_storage_account")
	if err != nil {
		t.Fatalf("mergeMap err = %v", err)
	}
	if code != "TAG_KEY_CASE_COLLISION" {
		t.Fatalf("code = %q, want TAG_KEY_CASE_COLLISION for a reqMap-internal case collision", code)
	}
	if !strings.Contains(reason, "Owner") || !strings.Contains(reason, "owner") {
		t.Fatalf("reason = %q, want it to name both spellings", reason)
	}
	got := tokensString(block.Body().GetAttribute("tags").Expr().BuildTokens(nil))
	if strings.Contains(got, "Owner") || strings.Contains(got, "owner") {
		t.Fatalf("block was mutated on refusal, want untouched: %q", got)
	}
}

// TestMergeMapAzureByteEqualKeyStillOverwrites: a byte-EQUAL key is an
// ordinary overwrite, not a collision — only a DIFFERENT spelling under the
// same case-fold refuses.
func TestMergeMapAzureByteEqualKeyStillOverwrites(t *testing.T) {
	src := []byte("resource \"azurerm_storage_account\" \"x\" {\n  tags = {\n    Owner = \"basis\"\n  }\n}\n")
	f, diags := hclwrite.ParseConfig(src, "x.tf", hcl.Pos{Line: 1, Column: 1})
	if diags.HasErrors() {
		t.Fatal(diags.Error())
	}
	block := f.Body().Blocks()[0]
	code, reason, err := mergeMap(block, "tags", map[string]any{"Owner": "erp"}, false, "azurerm_storage_account")
	if err != nil || code != "" {
		t.Fatalf("code=%q reason=%q err=%v, want a clean overwrite (byte-equal key)", code, reason, err)
	}
	got := tokensString(block.Body().GetAttribute("tags").Expr().BuildTokens(nil))
	if !strings.Contains(got, "\"erp\"") {
		t.Fatalf("Owner was not overwritten: %q", got)
	}
}

// TestMergeMapAzureNewKeyNoCollisionSucceeds: a genuinely new key (no
// case-fold collision with any existing key) merges normally — the positive
// direction of the guard.
func TestMergeMapAzureNewKeyNoCollisionSucceeds(t *testing.T) {
	src := []byte("resource \"azurerm_storage_account\" \"x\" {\n  tags = {\n    Owner = \"basis\"\n  }\n}\n")
	f, diags := hclwrite.ParseConfig(src, "x.tf", hcl.Pos{Line: 1, Column: 1})
	if diags.HasErrors() {
		t.Fatal(diags.Error())
	}
	block := f.Body().Blocks()[0]
	code, reason, err := mergeMap(block, "tags", map[string]any{"team": "z"}, false, "azurerm_storage_account")
	if err != nil || code != "" {
		t.Fatalf("code=%q reason=%q err=%v, want a clean merge", code, reason, err)
	}
	got := tokensString(block.Body().GetAttribute("tags").Expr().BuildTokens(nil))
	if !strings.Contains(got, "team") || !strings.Contains(got, "\"z\"") {
		t.Fatalf("team was not merged: %q", got)
	}
}

// TestMergeMapAwsTagCaseCollisionUnaffected: the identical case-collision
// shape on an aws_* target is byte-for-byte unaffected — AWS tag keys ARE
// case-sensitive, so "Owner" and "owner" are two distinct, coexisting tags,
// exactly as mergeMap always allowed. Proves the guard is gated on
// SchemaDumpPrefix and does not leak onto aws_* targets.
func TestMergeMapAwsTagCaseCollisionUnaffected(t *testing.T) {
	src := []byte("resource \"aws_s3_bucket\" \"x\" {\n  tags = {\n    Owner = \"basis\"\n  }\n}\n")
	f, diags := hclwrite.ParseConfig(src, "x.tf", hcl.Pos{Line: 1, Column: 1})
	if diags.HasErrors() {
		t.Fatal(diags.Error())
	}
	block := f.Body().Blocks()[0]
	code, reason, err := mergeMap(block, "tags", map[string]any{"owner": "y"}, false, "aws_s3_bucket")
	if err != nil || code != "" {
		t.Fatalf("code=%q reason=%q err=%v, want aws to allow both spellings (unaffected)", code, reason, err)
	}
	got := tokensString(block.Body().GetAttribute("tags").Expr().BuildTokens(nil))
	if !strings.Contains(got, "Owner") || !strings.Contains(got, "owner") {
		t.Fatalf("expected BOTH Owner and owner present (aws stays case-sensitive): %q", got)
	}
}

func TestCurrentNumberReadsFileValue(t *testing.T) {
	block := []byte("resource \"aws_ebs_volume\" \"v\" {\n  size = 2700\n}\n")
	got, ok := currentNumber(block, "size")
	if !ok || got != 2700 {
		t.Fatalf("currentNumber = %v ok=%v, want 2700", got, ok)
	}
}

// TestParseObjectTrailingCommentEndsEntry: a single-line comment token carries
// its own terminating newline, so a mid-map `k = v # note` line must end that
// ENTRY — not swallow the next line's key/value into valToks. Regression for
// the exit-0 corruption measured on ec2-add-instance-tag against a tags map
// with a mid-map trailing comment (two entries glued onto one line, and the
// foreach KEY_CONFLICT guard blinded for the swallowed key).
func TestParseObjectTrailingCommentEndsEntry(t *testing.T) {
	src := []byte("resource \"aws_instance\" \"x\" {\n" +
		"  tags = {\n" +
		"    \"App\" = \"member \" # trailing space is live\n" +
		"    \"Arc\" = \"Linux\"\n" +
		"  }\n" +
		"}\n")
	f, diags := hclwrite.ParseConfig(src, "x.tf", hcl.Pos{Line: 1, Column: 1})
	if diags.HasErrors() {
		t.Fatal(diags.Error())
	}
	block := f.Body().Blocks()[0]
	entries, ok := parseObject(block.Body().GetAttribute("tags").Expr().BuildTokens(nil))
	if !ok {
		t.Fatal("parseObject not ok on a literal map")
	}
	if len(entries) != 2 {
		t.Fatalf("parsed %d entries, want 2 (comment must terminate the App entry)", len(entries))
	}
	if entries[0].key != "App" || entries[1].key != "Arc" {
		t.Fatalf("keys = %q,%q, want App,Arc", entries[0].key, entries[1].key)
	}
	if got := tokensString(entries[0].valToks); got != "\"member \"" {
		t.Fatalf("App valToks = %q — must not swallow the Arc line", got)
	}
	if len(entries[0].comment) == 0 {
		t.Fatal("App entry lost its trailing comment")
	}
}

// TestMergeMapKeepsCommentBearingSiblings: merging one new key into a map with
// a mid-map trailing comment keeps every sibling on its own line, keeps the
// comment attached, and leaves no blank line (the comment token already carries
// the newline — buildObject must not add a second one).
func TestMergeMapKeepsCommentBearingSiblings(t *testing.T) {
	src := []byte("resource \"aws_instance\" \"x\" {\n" +
		"  tags = {\n" +
		"    \"App\" = \"member \" # trailing space is live\n" +
		"    \"Arc\" = \"Linux\"\n" +
		"  }\n" +
		"}\n")
	f, diags := hclwrite.ParseConfig(src, "x.tf", hcl.Pos{Line: 1, Column: 1})
	if diags.HasErrors() {
		t.Fatal(diags.Error())
	}
	block := f.Body().Blocks()[0]
	code, reason, err := mergeMap(block, "tags", map[string]any{"CostCentre": "ERP-BASIS"}, false, "aws_instance")
	if err != nil || code != "" {
		t.Fatalf("mergeMap code=%q reason=%q err=%v", code, reason, err)
	}
	got := string(hclwrite.Format(f.Bytes()))
	want := "resource \"aws_instance\" \"x\" {\n" +
		"  tags = {\n" +
		"    \"App\"      = \"member \" # trailing space is live\n" +
		"    \"Arc\"      = \"Linux\"\n" +
		"    CostCentre = \"ERP-BASIS\"\n" +
		"  }\n" +
		"}\n"
	if got != want {
		t.Fatalf("merged map mangled:\n--- got ---\n%s\n--- want ---\n%s", got, want)
	}
}
