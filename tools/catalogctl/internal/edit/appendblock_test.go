package edit

import (
	"strings"
	"testing"

	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/hclops"
	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/manifests"
	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/request"
)

// locFor wraps whole-file bytes as a single located top-level block.
func locFor(src string) *hclops.Located {
	b := []byte(src)
	return &hclops.Located{File: "x.tf", Bytes: b, Start: 0, End: len(b)}
}

// deepEqualBlock: equal only when type, attrs (order-insensitive), and sub-blocks
// (positional) all match; a differing attr value or an extra sub-block breaks it.
func TestDeepEqualBlock(t *testing.T) {
	base := parentBlock(t, "resource \"x\" \"y\" {\n  rule {\n    a = 1\n    b = \"z\"\n\n    sub {\n      c = true\n    }\n  }\n}\n").Body().FirstMatchingBlock("rule", nil)
	// same content, attrs written in a different order → still equal.
	same := parentBlock(t, "resource \"x\" \"y\" {\n  rule {\n    b = \"z\"\n    a = 1\n\n    sub {\n      c = true\n    }\n  }\n}\n").Body().FirstMatchingBlock("rule", nil)
	if !deepEqualBlock(base, same) {
		t.Fatalf("blocks with identical content (reordered attrs) should be deep-equal")
	}
	diffVal := parentBlock(t, "resource \"x\" \"y\" {\n  rule {\n    a = 2\n    b = \"z\"\n\n    sub {\n      c = true\n    }\n  }\n}\n").Body().FirstMatchingBlock("rule", nil)
	if deepEqualBlock(base, diffVal) {
		t.Fatalf("a differing attribute value must break deep-equal")
	}
	extraSub := parentBlock(t, "resource \"x\" \"y\" {\n  rule {\n    a = 1\n    b = \"z\"\n\n    sub {\n      c = true\n    }\n\n    sub {\n      c = false\n    }\n  }\n}\n").Body().FirstMatchingBlock("rule", nil)
	if deepEqualBlock(base, extraSub) {
		t.Fatalf("an extra sub-block must break deep-equal")
	}
}

// ensureChildChain creates each missing segment and reuses a shared prefix so two
// Param.Paths under the same parent block get ONE intermediate.
func TestEnsureChildChain(t *testing.T) {
	nb := parentBlock(t, "resource \"x\" \"y\" {\n  rule {\n  }\n}\n").Body().FirstMatchingBlock("rule", nil)
	a := ensureChildChain(nb, []string{"statement", "managed_rule_group_statement"})
	if a.Type() != "managed_rule_group_statement" {
		t.Fatalf("deepest = %q, want managed_rule_group_statement", a.Type())
	}
	// A second path sharing the "statement" prefix must reuse it, not duplicate.
	b := ensureChildChain(nb, []string{"statement", "other"})
	if b.Type() != "other" {
		t.Fatalf("deepest = %q, want other", b.Type())
	}
	if got := len(childrenOfType(nb, "statement")); got != 1 {
		t.Fatalf("statement prefix duplicated: got %d, want 1", got)
	}
}

// dlmAddScheduleOp mirrors the golden manifest so unit tests can exercise §4.4.
func dlmAddScheduleOp() manifests.Op {
	op := manifests.Op{ID: "dlm-add-schedule", CodemodOp: "append_block", Params: []manifests.Param{
		{Name: "policy", Source: "inventory"},
		{Name: "schedule_name", Source: "user_input", Attr: "name", Role: "key"},
		{Name: "copy_tags", Source: "user_input"},
	}}
	op.Target.ResourceType = "aws_dlm_lifecycle_policy"
	op.Target.Path = []string{"policy_details"}
	op.Target.Block = "schedule"
	return op
}

const dlmOneSchedule = `resource "aws_dlm_lifecycle_policy" "x" {
  policy_details {
    schedule {
      name      = "daily"
      copy_tags = true
    }
  }
}
`

// §4.4 tier 2: a role:"key" sibling with the same key but different content refuses
// BLOCK_EXISTS (an add never silently overwrites), tree untouched.
func TestAppendBlockKeyConflictRefuses(t *testing.T) {
	op := dlmAddScheduleOp()
	req := &request.Request{Params: map[string]any{"policy": "aws_dlm_lifecycle_policy.x", "schedule_name": "daily", "copy_tags": false}}
	out, code, _, err := appendBlock(op, req, locFor(dlmOneSchedule))
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if code != "BLOCK_EXISTS" {
		t.Fatalf("code = %q, want BLOCK_EXISTS", code)
	}
	if out != nil {
		t.Fatalf("expected no write on refusal, got %d bytes", len(out))
	}
}

// §4.4 tier 1: a deep-equal sibling → idempotent no-op (origBlock bytes, exit 0).
func TestAppendBlockDeepEqualNoop(t *testing.T) {
	op := dlmAddScheduleOp()
	req := &request.Request{Params: map[string]any{"policy": "aws_dlm_lifecycle_policy.x", "schedule_name": "daily", "copy_tags": true}}
	loc := locFor(dlmOneSchedule)
	out, code, _, err := appendBlock(op, req, loc)
	if err != nil || code != "" {
		t.Fatalf("err=%v code=%q, want a no-op", err, code)
	}
	if string(out) != string(origBlock(loc)) {
		t.Fatalf("deep-equal sibling should return the original block unchanged")
	}
}

// §4.4 tier 3: a singleton target with an existing (different) instance refuses.
func TestAppendBlockSingletonRefuses(t *testing.T) {
	op := manifests.Op{ID: "asg-refresh", CodemodOp: "append_block", Params: []manifests.Param{
		{Name: "asg", Source: "inventory"},
		{Name: "min_healthy_percentage", Source: "user_input", Path: []string{"preferences"}},
	}}
	op.Target.ResourceType = "aws_autoscaling_group"
	op.Target.Block = "instance_refresh"
	op.Target.Singleton = true
	src := "resource \"aws_autoscaling_group\" \"x\" {\n  instance_refresh {\n    preferences {\n      min_healthy_percentage = 90\n    }\n  }\n}\n"
	req := &request.Request{Params: map[string]any{"asg": "aws_autoscaling_group.x", "min_healthy_percentage": 50}}
	out, code, _, err := appendBlock(op, req, locFor(src))
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if code != "BLOCK_EXISTS" {
		t.Fatalf("code = %q, want BLOCK_EXISTS", code)
	}
	if out != nil {
		t.Fatalf("expected no write on refusal, got %d bytes", len(out))
	}
}

// Omit-if-absent (§4.2): an OPTIONAL param the request omits does not materialize —
// its sub-block is absent, and a required sub-block still lands.
func TestAppendBlockOmitIfAbsent(t *testing.T) {
	op := manifests.Op{ID: "s3-add-rule", CodemodOp: "append_block", Params: []manifests.Param{
		{Name: "bucket", Source: "inventory"},
		{Name: "rule_id", Source: "user_input", Attr: "id", Role: "key"},
		{Name: "prefix", Source: "user_input", Path: []string{"filter"}},
		{Name: "expiration_days", Source: "user_input", Required: false, Attr: "days", Path: []string{"expiration"}},
	}}
	op.Target.ResourceType = "aws_s3_bucket_lifecycle_configuration"
	op.Target.Block = "rule"
	src := "resource \"aws_s3_bucket_lifecycle_configuration\" \"x\" {\n  bucket = \"b\"\n}\n"
	req := &request.Request{Params: map[string]any{"bucket": "aws_s3_bucket_lifecycle_configuration.x", "rule_id": "r1", "prefix": "logs/"}}
	out, code, reason, err := appendBlock(op, req, locFor(src))
	if err != nil || code != "" {
		t.Fatalf("err=%v code=%q reason=%q, want success", err, code, reason)
	}
	rule := parentBlock(t, string(out)).Body().FirstMatchingBlock("rule", nil)
	if rule.Body().FirstMatchingBlock("filter", nil) == nil {
		t.Fatalf("required filter{} sub-block missing:\n%s", out)
	}
	if rule.Body().FirstMatchingBlock("expiration", nil) != nil {
		t.Fatalf("optional expiration{} must be omitted when its param is absent:\n%s", out)
	}
}

// guardAppendTarget refuses a malformed identifier anywhere it will write or walk:
// target.path, a Param.Path, or an EmptyBlocks chain.
func TestGuardAppendTargetSegments(t *testing.T) {
	mk := func(mut func(*manifests.Op)) manifests.Op {
		op := manifests.Op{CodemodOp: "append_block"}
		op.Target.Block = "schedule"
		mut(&op)
		return op
	}
	cases := map[string]manifests.Op{
		"bad target path":  mk(func(o *manifests.Op) { o.Target.Path = []string{"a/b"} }),
		"bad param path":   mk(func(o *manifests.Op) { o.Params = []manifests.Param{{Name: "p", Path: []string{"x.y"}}} }),
		"bad empty blocks": mk(func(o *manifests.Op) { o.Target.EmptyBlocks = [][]string{{"ok", "1bad"}} }),
	}
	for name, op := range cases {
		t.Run(name, func(t *testing.T) {
			code, reason := guardAppendTarget(op)
			if code != "MALFORMED_BLOCK_TARGET" {
				t.Fatalf("code = %q, want MALFORMED_BLOCK_TARGET", code)
			}
			if !strings.Contains(reason, "identifier") {
				t.Fatalf("reason = %q, want it to explain the invalid identifier", reason)
			}
		})
	}
	// A fully well-formed shape passes.
	good := mk(func(o *manifests.Op) {
		o.Target.Path = []string{"policy_details"}
		o.Params = []manifests.Param{{Name: "p", Path: []string{"create_rule"}}}
		o.Target.EmptyBlocks = [][]string{{"override_action", "count"}}
	})
	if code, _ := guardAppendTarget(good); code != "" {
		t.Fatalf("well-formed append target refused %q", code)
	}
}
