package prprep

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	_ "github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/edit" // installs cli.Edit
)

// prprep_create_test.go is 0036 T6: the pr-prepare CREATE path. pr-prepare orchestrates
// the edit pipeline against a throwaway copy of the env tree and harvests the changed
// files into the bundle — so a create_resource op (which authors a NET-NEW service
// file) needs no special-casing: the authored file is a NEW file in the copy, picked up
// by changedFiles as an all-additions change. This proves the accept path (authored
// file lands in the bundle) and the refusal path (ALREADY_EXISTS ⇒ edit exits 2 ⇒ no
// PR bundle).

const realManifestsDir = "../../../../ccp/app/src/data/manifests"

// approvedCreateRequest writes an APPROVED ccp.request/v1 for a create op.
func approvedCreateRequest(t *testing.T, dir, opID string, params map[string]any) string {
	t.Helper()
	var b strings.Builder
	b.WriteString("schema: ccp.request/v1\n")
	b.WriteString("id: REQ-00000000000000000000000000\n")
	b.WriteString("item: " + opID + "\n")
	b.WriteString("requester_login: ops-lead\n")
	b.WriteString("justification: T6 create path\n")
	b.WriteString("params:\n")
	for k, v := range params {
		if s, ok := v.(string); ok {
			b.WriteString("  " + k + ": " + quoteYAML(s) + "\n")
		}
	}
	b.WriteString("approvals:\n")
	b.WriteString("  - approver: ops-lead\n")
	b.WriteString("    approved_at: \"2026-07-15T10:00:00Z\"\n")
	b.WriteString("    policy_version: v1\n")
	b.WriteString("    digest: deadbeefdeadbeef\n")
	b.WriteString("    decision: approve\n")
	p := filepath.Join(dir, "request.yaml")
	if err := os.WriteFile(p, []byte(b.String()), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

func quoteYAML(s string) string {
	return "\"" + strings.ReplaceAll(s, "\"", "\\\"") + "\""
}

// snsParams are sns-create-topic's non-empty params (no references → no env stubs).
var snsParams = map[string]any{
	"topic_name":      "erp-oncall-alerts",
	"display_name":    "ERP on-call",
	"resource_name":   "erp-oncall-alerts",
	"description_tag": "On-call notifications for the ERP estate",
	"pic":             "Ops team",
}

func TestPRPrepare_CreatePath_Accept(t *testing.T) {
	if _, err := os.Stat(realManifestsDir); err != nil {
		t.Skipf("real manifest catalog not present — skipping")
	}
	env := t.TempDir() // empty env: the create authors a brand-new sns.tf
	out := t.TempDir()
	reqPath := approvedCreateRequest(t, t.TempDir(), "sns-create-topic", snsParams)

	var stdout, stderr bytes.Buffer
	code := run([]string{
		"--request", reqPath, "--manifests", realManifestsDir, "--env", env, "--out", out,
	}, &stdout, &stderr)
	if code != 0 {
		t.Fatalf("exit %d, want 0; stderr=%s", code, stderr.String())
	}

	// The authored service file is in the bundle at its repo-relative env path, and it
	// carries the created resource (all-additions).
	authored := filepath.Join(out, "environments", "prod", "sns.tf")
	got, err := os.ReadFile(authored)
	if err != nil {
		t.Fatalf("authored file missing from bundle: %v", err)
	}
	if !strings.Contains(string(got), `resource "aws_sns_topic" "erp_oncall_alerts"`) {
		t.Errorf("bundle sns.tf missing the created resource:\n%s", got)
	}
	if !strings.HasPrefix(string(got), "# TODO:") {
		t.Errorf("authored file should start with the decisions TODO (banner stripped), got:\n%s", got)
	}
	if _, err := os.Stat(filepath.Join(out, "PR_BODY.md")); err != nil {
		t.Errorf("PR_BODY.md missing from bundle: %v", err)
	}
}

func TestPRPrepare_CreatePath_AlreadyExistsNoBundle(t *testing.T) {
	if _, err := os.Stat(realManifestsDir); err != nil {
		t.Skipf("real manifest catalog not present — skipping")
	}
	env := t.TempDir()
	// Pre-place the idiom's primary address so the create refuses ALREADY_EXISTS.
	if err := os.WriteFile(filepath.Join(env, "sns.tf"),
		[]byte("resource \"aws_sns_topic\" \"erp_oncall_alerts\" {}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	out := t.TempDir()
	reqPath := approvedCreateRequest(t, t.TempDir(), "sns-create-topic", snsParams)

	var stdout, stderr bytes.Buffer
	code := run([]string{
		"--request", reqPath, "--manifests", realManifestsDir, "--env", env, "--out", out,
	}, &stdout, &stderr)
	if code != 2 {
		t.Fatalf("exit %d, want 2 (ALREADY_EXISTS); stderr=%s", code, stderr.String())
	}
	if !strings.Contains(stderr.String(), "ALREADY_EXISTS") {
		t.Errorf("stderr missing ALREADY_EXISTS: %s", stderr.String())
	}
	// No PR bundle on a refusal.
	if _, err := os.Stat(filepath.Join(out, "PR_BODY.md")); !os.IsNotExist(err) {
		t.Errorf("no bundle should be written on ALREADY_EXISTS refusal")
	}
}
