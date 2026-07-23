package edit

import (
	"path/filepath"
	"testing"

	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/manifests"
)

// loadRealSchema loads the committed schemadump the way the CLI auto-discovers it, so
// these tests exercise the SAME data the production guard consults. Skips (not fails)
// if the dump cannot be found, so the package still builds in a checkout without it.
func loadRealSchema(t *testing.T) *nestedBlockIndex {
	t.Helper()
	p := discoverSchemaPath("aws_instance", ".")
	if p == "" {
		t.Skip("schemadump not discoverable from the edit package dir")
	}
	idx, err := loadNestedBlockIndex(p)
	if err != nil {
		t.Fatalf("loadNestedBlockIndex(%s): %v", p, err)
	}
	return idx
}

func appendOp(rt, block string, path ...string) manifests.Op {
	var op manifests.Op
	op.CodemodOp = "append_block"
	op.Target.ResourceType = rt
	op.Target.Block = block
	op.Target.Path = path
	return op
}

// TestGuardKnownBlockAgainstRealSchema is the S2 proof: an append_block naming a nested
// block the resource type does NOT declare refuses UNKNOWN_BLOCK_TYPE (the live
// iam-attach-managed-policy case — policy_attachment on aws_iam_role), while every
// legitimate append — including one legal only at a nested path — still passes.
func TestGuardKnownBlockAgainstRealSchema(t *testing.T) {
	idx := loadRealSchema(t)
	cases := []struct {
		name     string
		op       manifests.Op
		wantCode string
	}{
		// S2: the exact finding — aws_iam_role has only `inline_policy`; a managed-policy
		// attachment is the separate aws_iam_role_policy_attachment RESOURCE.
		{"iam-attach policy_attachment (S2)", appendOp("aws_iam_role", "policy_attachment"), RefuseUnknownBlockType},
		// Legit top-level nested blocks — must pass.
		{"sg ingress", appendOp("aws_security_group", "ingress"), ""},
		{"sg egress", appendOp("aws_security_group", "egress"), ""},
		{"route_table route", appendOp("aws_route_table", "route"), ""},
		{"cloudtrail insight_selector", appendOp("aws_cloudtrail", "insight_selector"), ""},
		{"wafv2 web_acl rule", appendOp("aws_wafv2_web_acl", "rule"), ""},
		// Legal only at a nested path — descend target.path, then check.
		{"dlm schedule under policy_details", appendOp("aws_dlm_lifecycle_policy", "schedule", "policy_details"), ""},
		{"dlm cross_region_copy_rule under policy_details/schedule",
			appendOp("aws_dlm_lifecycle_policy", "cross_region_copy_rule", "policy_details", "schedule"), ""},
		// `inline_policy` IS a real block of aws_iam_role — proves the guard is
		// membership-precise, not a blanket iam refusal.
		{"iam inline_policy (real block)", appendOp("aws_iam_role", "inline_policy"), ""},
		// A real block placed at the WRONG depth is caught: `schedule` is nested under
		// policy_details, so at the resource top level it is unknown.
		{"dlm schedule at top level (wrong depth)", appendOp("aws_dlm_lifecycle_policy", "schedule"), RefuseUnknownBlockType},
		// Shapes owned by the pre-existing structural guards — the schema guard DEFERS
		// (returns "") so their more specific codes still win downstream.
		{"empty block defers", appendOp("aws_iam_role", ""), ""},
		{"alternation ident defers", appendOp("aws_network_acl", "ingress/egress"), ""},
		{"aws_-prefixed block defers", appendOp("aws_s3_bucket", "aws_s3_bucket_replication_configuration"), ""},
		// Fail-open where the schema cannot answer.
		{"resource type absent from dump defers", appendOp("aws_totally_made_up", "widget"), ""},
		{"framework-unreflected type defers", appendOp("aws_s3_bucket_lifecycle_configuration", "rule"), ""},
		{"unresolved path defers", appendOp("aws_security_group", "ingress", "no_such_parent"), ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			code, reason := guardKnownBlock(c.op, idx)
			if code != c.wantCode {
				t.Fatalf("code = %q (reason %q), want %q", code, reason, c.wantCode)
			}
			if c.wantCode != "" && reason == "" {
				t.Fatalf("a refusal must carry a reason")
			}
		})
	}
}

// TestSchemaGzFallback pins the gunzip path. The large AWS dump is committed ONLY as
// .gz (the raw json is gitignored to fit git), so the guard MUST inflate it — in CI and
// any fresh clone that is the only schema present. Locally the raw json is usually there
// and discoverSchemaPath prefers it, so this test loads the committed .gz EXPLICITLY to
// exercise the gunzip branch locally too; without it a broken fallback would only ever
// surface as a red CI run (a security guard silently failing open, as it once did).
func TestSchemaGzFallback(t *testing.T) {
	var gz string
	dir, _ := filepath.Abs(".")
	for {
		if cand, _ := filepath.Glob(filepath.Join(dir, "tools", "schemadump", "aws-*-schema.json.gz")); len(cand) > 0 {
			gz = cand[0]
			break
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	if gz == "" {
		t.Skip("no committed aws schema .gz found")
	}
	idx, err := loadNestedBlockIndex(gz)
	if err != nil {
		t.Fatalf("loadNestedBlockIndex(%s): %v", gz, err)
	}
	// The inflated .gz must parse into a real, queryable index: aws_iam_role declares
	// inline_policy but NOT policy_attachment (the same invariant the raw-schema tests
	// assert), proving the gunzip produced the identical schema.
	names, ok := idx.nestedBlocksAt("aws_iam_role", nil)
	if !ok || !names["inline_policy"] || names["policy_attachment"] {
		t.Fatalf("gz-loaded index wrong: ok=%v names=%v", ok, keys(names))
	}
	// And the guard actively refuses the S2 case through the gz-loaded index — the exact
	// behavior that fails open when the schema cannot load.
	if code, _ := guardKnownBlock(appendOp("aws_iam_role", "policy_attachment"), idx); code != RefuseUnknownBlockType {
		t.Fatalf("gz-loaded guard must refuse policy_attachment, got %q", code)
	}
}

// TestGuardKnownBlockNilIndex proves a nil index (schema not found / not configured)
// fails OPEN — no refusal — so a missing dump degrades the executor to its pre-S2
// structural guards rather than refusing every append_block.
func TestGuardKnownBlockNilIndex(t *testing.T) {
	if code, _ := guardKnownBlock(appendOp("aws_iam_role", "policy_attachment"), nil); code != "" {
		t.Fatalf("nil index must fail open, got %q", code)
	}
}

// TestNestedBlocksAt pins the schema-descent primitive: top-level membership, a
// two-level descent, and the three ok=false cases (absent type, framework type,
// unresolved path).
func TestNestedBlocksAt(t *testing.T) {
	idx := loadRealSchema(t)

	names, ok := idx.nestedBlocksAt("aws_iam_role", nil)
	if !ok {
		t.Fatal("aws_iam_role should resolve")
	}
	if !names["inline_policy"] || names["policy_attachment"] {
		t.Fatalf("aws_iam_role top-level blocks = %v; want inline_policy present, policy_attachment absent", keys(names))
	}

	names, ok = idx.nestedBlocksAt("aws_dlm_lifecycle_policy", []string{"policy_details"})
	if !ok || !names["schedule"] {
		t.Fatalf("policy_details should declare `schedule`; got ok=%v names=%v", ok, keys(names))
	}

	if _, ok := idx.nestedBlocksAt("aws_not_real", nil); ok {
		t.Fatal("absent resource type must return ok=false")
	}
	if _, ok := idx.nestedBlocksAt("aws_s3_bucket_lifecycle_configuration", nil); ok {
		t.Fatal("framework-unreflected type must return ok=false")
	}
	if _, ok := idx.nestedBlocksAt("aws_iam_role", []string{"does_not_exist"}); ok {
		t.Fatal("unresolved path must return ok=false")
	}
}

func keys(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}
