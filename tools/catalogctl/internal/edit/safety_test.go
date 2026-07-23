package edit

import (
	"testing"

	"github.com/hashicorp/hcl/v2"
	"github.com/hashicorp/hcl/v2/hclwrite"

	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/hclops"
	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/manifests"
	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/request"
)

// These lock the 0010-hotfix safety guards: shapes the executor cannot yet
// address (nested paths, keyed nested-block removal) MUST refuse (route to an
// engineer), never silently write invalid HCL or delete the wrong block.

// A dotted scalar attribute (e.g. metadata_options.http_tokens) must refuse
// UNSUPPORTED_PATH rather than write a dotted LHS = invalid HCL.
func TestSetAttributeRefusesDottedPath(t *testing.T) {
	src := []byte("resource \"aws_instance\" \"x\" {\n  ami = \"ami-1\"\n}\n")
	loc := &hclops.Located{File: "x.tf", Bytes: src, Start: 0, End: len(src)}
	op := manifests.Op{
		ID:        "ec2-set-imds-http-tokens",
		CodemodOp: "set_attribute",
		Params: []manifests.Param{
			{Name: "instance", Source: "inventory"},
			{Name: "http_tokens", Source: "user_input"},
		},
		TerraformCapability: "~ update (metadata_options.http_tokens)",
	}
	op.Target.ResourceType = "aws_instance"
	req := &request.Request{Params: map[string]any{"instance": "aws_instance.x", "http_tokens": "required"}}

	out, code, _, err := setAttribute(op, req, loc)
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if code != "UNSUPPORTED_PATH" {
		t.Fatalf("code = %q, want UNSUPPORTED_PATH", code)
	}
	if out != nil {
		t.Fatalf("expected no write on refusal, got %d bytes", len(out))
	}
}

// A remove_block op that names a nested block must refuse
// UNSUPPORTED_NESTED_REMOVE rather than delete the whole enclosing resource.
func TestRemoveBlockRefusesNestedTarget(t *testing.T) {
	src := []byte("resource \"aws_wafv2_web_acl\" \"x\" {\n  name = \"acl\"\n  rule {\n    name = \"r1\"\n  }\n}\n")
	loc := &hclops.Located{File: "x.tf", Bytes: src, Start: 0, End: len(src)}
	op := manifests.Op{
		ID:        "waf-delete-rule",
		CodemodOp: "remove_block",
		Params:    []manifests.Param{{Name: "web_acl", Source: "inventory"}},
	}
	op.Target.ResourceType = "aws_wafv2_web_acl"
	op.Target.Block = "rule"
	req := &request.Request{Params: map[string]any{"web_acl": "aws_wafv2_web_acl.x"}}

	out, code, _, err := removeBlock(op, req, loc)
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if code != "UNSUPPORTED_NESTED_REMOVE" {
		t.Fatalf("code = %q, want UNSUPPORTED_NESTED_REMOVE", code)
	}
	if out != nil {
		t.Fatalf("expected no write on refusal, got %d bytes", len(out))
	}
}

// isValidBlockIdent must accept real block/attr names and reject path-like,
// dotted, alternation, and leading-digit/-hyphen values — the shapes that make a
// verb emit invalid or wrong-located HCL when they reach target.block.
func TestIsValidBlockIdent(t *testing.T) {
	good := []string{"tags", "ingress", "egress", "health_check", "root_block_device", "metric_query", "_x", "a-b"}
	bad := []string{"", "ingress/egress", "environments/prod/autoscaling.tf", "a.b", "a b", "1x", "-x"}
	for _, s := range good {
		if !isValidBlockIdent(s) {
			t.Errorf("isValidBlockIdent(%q) = false, want true", s)
		}
	}
	for _, s := range bad {
		if isValidBlockIdent(s) {
			t.Errorf("isValidBlockIdent(%q) = true, want false", s)
		}
	}
}

// append_block with a path-like target.block (a real catalog data error:
// autoscaling-start-instance-refresh had block="environments/prod/autoscaling.tf")
// must refuse MALFORMED_BLOCK_TARGET, not emit a block literally named after a
// file path (invalid HCL at exit 0).
func TestAppendBlockRefusesPathLikeBlockTarget(t *testing.T) {
	src := []byte("resource \"aws_autoscaling_group\" \"x\" {\n  name = \"asg\"\n}\n")
	loc := &hclops.Located{File: "x.tf", Bytes: src, Start: 0, End: len(src)}
	op := manifests.Op{
		ID:        "autoscaling-start-instance-refresh",
		CodemodOp: "append_block",
		Params:    []manifests.Param{{Name: "asg", Source: "inventory"}},
	}
	op.Target.ResourceType = "aws_autoscaling_group"
	op.Target.Block = "environments/prod/autoscaling.tf"
	req := &request.Request{Params: map[string]any{"asg": "aws_autoscaling_group.x"}}

	out, code, _, err := appendBlock(op, req, loc)
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if code != "MALFORMED_BLOCK_TARGET" {
		t.Fatalf("code = %q, want MALFORMED_BLOCK_TARGET", code)
	}
	if out != nil {
		t.Fatalf("expected no write on refusal, got %d bytes", len(out))
	}
}

// remove_foreach_entry with an alternation target.block (vpc-remove-nacl-rule had
// block="ingress/egress", which can't disambiguate direction) must refuse
// MALFORMED_BLOCK_TARGET rather than touch the wrong structure.
func TestRemoveForeachEntryRefusesAmbiguousBlockTarget(t *testing.T) {
	src := []byte("resource \"aws_network_acl\" \"x\" {\n  tags = { Name = \"acl\" }\n}\n")
	loc := &hclops.Located{File: "x.tf", Bytes: src, Start: 0, End: len(src)}
	op := manifests.Op{
		ID:        "vpc-remove-nacl-rule",
		CodemodOp: "remove_foreach_entry",
		Params:    []manifests.Param{{Name: "nacl", Source: "inventory"}, {Name: "rule_number", Source: "user_input"}},
	}
	op.Target.ResourceType = "aws_network_acl"
	op.Target.Block = "ingress/egress"
	req := &request.Request{Params: map[string]any{"nacl": "aws_network_acl.x", "rule_number": "100"}}

	out, code, _, err := removeForeachEntry(op, req, loc)
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if code != "MALFORMED_BLOCK_TARGET" {
		t.Fatalf("code = %q, want MALFORMED_BLOCK_TARGET", code)
	}
	if out != nil {
		t.Fatalf("expected no write on refusal, got %d bytes", len(out))
	}
}

// append_block with a target.block naming a RESOURCE TYPE (the live
// sns-add-subscription shape: block="aws_sns_topic_subscription", 0013c
// Appendix A) must refuse RESOURCE_TYPE_AS_BLOCK — it otherwise emits a
// schema-invalid nested resource at exit 0. A new resource is a top-level
// block, never a nested one.
func TestAppendBlockRefusesResourceTypeAsBlock(t *testing.T) {
	src := []byte("resource \"aws_sns_topic\" \"x\" {\n  name = \"alerts\"\n}\n")
	loc := &hclops.Located{File: "x.tf", Bytes: src, Start: 0, End: len(src)}
	op := manifests.Op{
		ID:        "sns-add-subscription",
		CodemodOp: "append_block",
		Params: []manifests.Param{
			{Name: "topic", Source: "inventory"},
			{Name: "protocol", Source: "user_input"},
			{Name: "endpoint", Source: "user_input"},
		},
	}
	op.Target.ResourceType = "aws_sns_topic_subscription"
	op.Target.Block = "aws_sns_topic_subscription"
	req := &request.Request{Params: map[string]any{"topic": "aws_sns_topic.x", "protocol": "email", "endpoint": "a@example.com"}}

	out, code, _, err := appendBlock(op, req, loc)
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if code != "RESOURCE_TYPE_AS_BLOCK" {
		t.Fatalf("code = %q, want RESOURCE_TYPE_AS_BLOCK", code)
	}
	if out != nil {
		t.Fatalf("expected no write on refusal, got %d bytes", len(out))
	}
}

// append_block with an EMPTY target.block would AppendNewBlock("") — invalid
// HCL at exit 0 (0013a found 10 live ops in this shape). Must refuse
// MISSING_BLOCK_TARGET.
func TestAppendBlockRefusesEmptyBlockTarget(t *testing.T) {
	src := []byte("resource \"aws_backup_plan\" \"x\" {\n  name = \"plan\"\n}\n")
	loc := &hclops.Located{File: "x.tf", Bytes: src, Start: 0, End: len(src)}
	op := manifests.Op{
		ID:        "backup-add-plan-rule",
		CodemodOp: "append_block",
		Params: []manifests.Param{
			{Name: "plan", Source: "inventory"},
			{Name: "rule_name", Source: "user_input"},
		},
	}
	op.Target.ResourceType = "aws_backup_plan"
	req := &request.Request{Params: map[string]any{"plan": "aws_backup_plan.x", "rule_name": "daily"}}

	out, code, _, err := appendBlock(op, req, loc)
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if code != "MISSING_BLOCK_TARGET" {
		t.Fatalf("code = %q, want MISSING_BLOCK_TARGET", code)
	}
	if out != nil {
		t.Fatalf("expected no write on refusal, got %d bytes", len(out))
	}
}

// append_block now DESCENDS target.path (0013a): the new block lands inside the
// addressed parent, not at the resource top level. The synthesized schedule must
// appear nested in policy_details, and description + the parent must be intact.
func TestAppendBlockDescendsIntoPath(t *testing.T) {
	src := []byte("resource \"aws_dlm_lifecycle_policy\" \"x\" {\n  description = \"d\"\n\n  policy_details {\n    schedule {\n      name = \"weekly\"\n    }\n  }\n}\n")
	loc := &hclops.Located{File: "x.tf", Bytes: src, Start: 0, End: len(src)}
	op := manifests.Op{
		ID:        "dlm-add-schedule",
		CodemodOp: "append_block",
		Params: []manifests.Param{
			{Name: "policy", Source: "inventory"},
			{Name: "schedule_name", Source: "user_input", Attr: "name", Role: "key"},
		},
	}
	op.Target.ResourceType = "aws_dlm_lifecycle_policy"
	op.Target.Block = "schedule"
	op.Target.Path = []string{"policy_details"}
	req := &request.Request{Params: map[string]any{"policy": "aws_dlm_lifecycle_policy.x", "schedule_name": "daily"}}

	out, code, reason, err := appendBlock(op, req, loc)
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if code != "" {
		t.Fatalf("code = %q reason = %q, want no refusal (descent should append)", code, reason)
	}
	if out == nil {
		t.Fatalf("expected a write, got nil")
	}
	top := parentBlock(t, string(out))
	pd := top.Body().FirstMatchingBlock("policy_details", nil)
	if pd == nil {
		t.Fatalf("policy_details missing from output:\n%s", out)
	}
	if len(childrenOfType(pd, "schedule")) != 2 {
		t.Fatalf("want 2 schedule blocks inside policy_details, got %d:\n%s", len(childrenOfType(pd, "schedule")), out)
	}
	// The new schedule must NOT have leaked to the resource top level.
	if len(childrenOfType(top, "schedule")) != 0 {
		t.Fatalf("a schedule leaked to the resource top level:\n%s", out)
	}
}

// A crafted map KEY must never break out of the map to inject real structure.
// 0014 §4 (CONFIRMED on s3-update-tags, LOW/l1_self_service): pre-fix, keyTokens
// emitted a non-identifier key as RAW bytes, so a key carrying `"`/newline/`{`
// escaped the tags map and hclwrite.Format re-lexed the debris into a real
// top-level `force_destroy = true` at exit 0. The key is now emitted as one
// escaped string literal; the injected attribute must NOT parse as real.
func TestAppendForeachEntryEscapesKeyInjection(t *testing.T) {
	src := []byte("resource \"aws_instance\" \"x\" {\n  ami = \"ami-1\"\n  tags = {\n    Env = \"dev\"\n  }\n}\n")
	loc := &hclops.Located{File: "x.tf", Bytes: src, Start: 0, End: len(src)}
	op := manifests.Op{
		ID:        "ec2-add-tag",
		CodemodOp: "append_foreach_entry",
		Params: []manifests.Param{
			{Name: "instance", Source: "inventory"},
			{Name: "key", Source: "user_input"},
			{Name: "value", Source: "user_input"},
		},
	}
	op.Target.ResourceType = "aws_instance"
	op.Target.Block = "tags"
	// The break-out payload the auditor confirmed: close the value+map, drop to
	// resource indent, inject an attribute, reopen a map so the tail stays valid.
	payload := "a\" = \"b\"\n  }\n  force_destroy = true\n  injected = {\n    \"c"
	req := &request.Request{Params: map[string]any{"instance": "aws_instance.x", "key": payload, "value": "v"}}

	out, code, _, err := appendForeachEntry(op, req, loc)
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if code != "" {
		t.Fatalf("unexpected refusal %q (fix escapes; write expected)", code)
	}
	// Parse the emitted block; the injected force_destroy must NOT be a real
	// attribute on the resource (it may only survive as escaped text in the key).
	f, diags := hclwrite.ParseConfig(out, "out.tf", hcl.Pos{Line: 1, Column: 1})
	if diags.HasErrors() {
		t.Fatalf("output is not valid HCL: %v\n%s", diags, out)
	}
	blk := f.Body().FirstMatchingBlock("resource", []string{"aws_instance", "x"})
	if blk == nil {
		t.Fatalf("resource block missing after edit:\n%s", out)
	}
	if blk.Body().GetAttribute("force_destroy") != nil {
		t.Fatalf("INJECTION: force_destroy became a real top-level attribute:\n%s", out)
	}
	if blk.Body().FirstMatchingBlock("injected", nil) != nil || blk.Body().GetAttribute("injected") != nil {
		t.Fatalf("INJECTION: injected structure escaped the map:\n%s", out)
	}
}

// A legitimate simple block name must still pass the guard (regression guard so
// the MALFORMED check never rejects real ops). append_foreach_entry onto a real
// "tags" map succeeds and writes.
func TestForeachGuardAllowsWellShapedBlock(t *testing.T) {
	src := []byte("resource \"aws_instance\" \"x\" {\n  tags = {\n    Env = \"dev\"\n  }\n}\n")
	loc := &hclops.Located{File: "x.tf", Bytes: src, Start: 0, End: len(src)}
	op := manifests.Op{
		ID:        "ec2-add-tag",
		CodemodOp: "append_foreach_entry",
		Params: []manifests.Param{
			{Name: "instance", Source: "inventory"},
			{Name: "key", Source: "user_input"},
			{Name: "value", Source: "user_input"},
		},
	}
	op.Target.ResourceType = "aws_instance"
	op.Target.Block = "tags"
	req := &request.Request{Params: map[string]any{"instance": "aws_instance.x", "key": "Team", "value": "erp"}}

	out, code, _, err := appendForeachEntry(op, req, loc)
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if code != "" {
		t.Fatalf("code = %q, want no refusal for well-shaped block", code)
	}
	if out == nil {
		t.Fatalf("expected a write for a valid tags append, got nil")
	}
}

// ec2-add-root-volume-tag shape: append_foreach_entry, target aws_instance, no
// target.block (the tag belongs in nested root_block_device.tags, which this verb
// cannot reach). It must FAIL (error, no output) — never silently write to the
// resource's TOP-LEVEL tags. This locks the "fails safe" behavior; genuinely
// supporting it needs append_foreach_entry + target.path (a future capability).
func TestAppendForeachEntryEmptyBlockOnResourceFailsSafe(t *testing.T) {
	src := []byte("resource \"aws_instance\" \"x\" {\n  ami = \"ami-1\"\n  tags = {\n    Env = \"dev\"\n  }\n}\n")
	loc := &hclops.Located{File: "x.tf", Bytes: src, Start: 0, End: len(src)}
	op := manifests.Op{
		ID:        "ec2-add-root-volume-tag",
		CodemodOp: "append_foreach_entry",
		Params: []manifests.Param{
			{Name: "instance", Source: "inventory"},
			{Name: "key", Source: "user_input"},
			{Name: "value", Source: "user_input"},
		},
	}
	op.Target.ResourceType = "aws_instance"
	req := &request.Request{Params: map[string]any{"instance": "aws_instance.x", "key": "Backup", "value": "true"}}

	out, _, _, err := appendForeachEntry(op, req, loc)
	if err == nil {
		t.Fatalf("expected an error (fail-safe) for empty-block foreach on a resource, got out=%d bytes", len(out))
	}
	if out != nil {
		t.Fatalf("expected no write, got %d bytes", len(out))
	}
}
