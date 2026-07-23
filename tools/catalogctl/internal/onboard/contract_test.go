package onboard

import (
	"os"
	"strings"
	"testing"
)

// TestSandboxWrapperContract pins the committed sandbox guarantees (spec §6.3
// Accept 23): no credentials, backend disabled, schema-only.
func TestSandboxWrapperContract(t *testing.T) {
	b, err := os.ReadFile("../../sandbox/run.sh")
	if err != nil {
		t.Fatalf("read run.sh: %v", err)
	}
	s := string(b)
	for _, must := range []string{
		"-backend=false", // backend disabled by the wrapper, not convention
		"AWS_",           // credential fail-closed check
		"GOOGLE_",
		"ARM_",
		"TF_TOKEN_",
		"terraform providers schema", // schema extraction
		"exit 1",                     // fails closed on credentials
	} {
		if !strings.Contains(s, must) {
			t.Errorf("sandbox/run.sh missing required literal %q", must)
		}
	}
}

func TestSandboxDockerfileContract(t *testing.T) {
	b, err := os.ReadFile("../../sandbox/Dockerfile")
	if err != nil {
		t.Fatalf("read Dockerfile: %v", err)
	}
	s := string(b)
	for _, must := range []string{
		"FROM hashicorp/terraform", // official terraform base image
		"USER onboard",             // non-root
		"run.sh",                   // wrapper is the entrypoint
	} {
		if !strings.Contains(s, must) {
			t.Errorf("sandbox/Dockerfile missing required literal %q", must)
		}
	}
	if strings.Contains(s, "AWS_ACCESS_KEY") || strings.Contains(s, "aws_secret") {
		t.Error("sandbox/Dockerfile must not embed credentials")
	}
}

// verbatimSentences are the four concerns 0007 requires stated word-for-word in
// the security doc (C2/C4/C8/C9). Reproduced here as the oracle.
var verbatimSentences = []string{
	"Blocks for any project are generated only through the redacting extractor; the canonical `catalog/redaction-rules.json` always applies, an optional per-project extension may add rules, and the extension's absence never disables the canonical rules (fail-closed).",
	"Onboarding and every project's request path are deterministic code — no AI component anywhere (ADR-0007), for imported projects exactly as for sample.",
	"An onboarded project gains no apply path; no project — imported or sample — may arm apply until the approved-plan = applied-plan digest guard exists for that project.",
	"`catalogctl edit`'s `FMT_DIRTY` refusal applies unchanged to onboarded projects — a non-canonical imported file is refused, never reformatted or corrupted; onboarding reports the fmt-dirty file count with the remediation (`terraform fmt -recursive` as a one-time normalization PR).",
}

// TestSecurityDocVerbatim guards the four verbatim sentences and the five reject
// codes in ccp/docs/onboarding-security.md. Skips if the doc is absent so
// the module stays testable if extracted from the monorepo.
func TestSecurityDocVerbatim(t *testing.T) {
	const p = "../../../../ccp/docs/onboarding-security.md"
	b, err := os.ReadFile(p)
	if err != nil {
		t.Skipf("security doc not present at %s: %v", p, err)
	}
	doc := string(b)
	for i, s := range verbatimSentences {
		if !strings.Contains(doc, s) {
			t.Errorf("onboarding-security.md missing verbatim sentence %d:\n%q", i+1, s)
		}
	}
	for _, code := range []string{"DATA_EXTERNAL", "PROVISIONER", "PROVIDER_SOURCE", "MODULE_SOURCE", "NONSTATIC_SOURCE"} {
		if !strings.Contains(doc, code) {
			t.Errorf("onboarding-security.md missing reject code %q", code)
		}
	}
	if !strings.Contains(doc, "-backend=false") {
		t.Error("onboarding-security.md must explain -backend=false")
	}
}
