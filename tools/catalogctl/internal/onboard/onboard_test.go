package onboard

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

const fixtures = "../../testdata/onboarding"

type call struct{ op, dir string }

type fakeRunner struct {
	calls     []call
	schema    []byte
	initErr   error
	schemaErr error
}

func (f *fakeRunner) Init(dir string) error {
	f.calls = append(f.calls, call{"init", dir})
	return f.initErr
}

func (f *fakeRunner) ProvidersSchema(dir string) ([]byte, error) {
	f.calls = append(f.calls, call{"schema", dir})
	if f.schemaErr != nil {
		return nil, f.schemaErr
	}
	if f.schema != nil {
		return f.schema, nil
	}
	return []byte(`{"format_version":"1.0"}`), nil
}

// withStubs replaces the process-touching seams so the orchestrator's ordering
// is tested hermetically. addrs==nil keeps the real extractor; a non-nil (even
// empty) slice forces that extraction result.
func withStubs(t *testing.T, head, tfVer string, addrs []string) {
	t.Helper()
	oGit, oTF, oEx := gitHead, tfVersion, extractAddrs
	gitHead = func(string) (string, error) { return head, nil }
	tfVersion = func() (string, error) { return tfVer, nil }
	if addrs != nil {
		extractAddrs = func(string) ([]string, error) { return addrs, nil }
	}
	t.Cleanup(func() { gitHead, tfVersion, extractAddrs = oGit, oTF, oEx })
}

// (a)+ The security property: init is NEVER invoked for a rejected repo — even
// when a matching --trusted-commit is supplied (prescan is step 2, before
// trust). Covers the JSON-hidden provisioner (gap G2) too.
func TestRejectedRepo_InitNeverRuns(t *testing.T) {
	rejecting := []string{
		"malicious-data-external",
		"malicious-provisioner",
		"off-allowlist-provider",
		"off-allowlist-module",
		"malicious-tfjson",
		"nonstatic-source",
	}
	for _, name := range rejecting {
		t.Run(name, func(t *testing.T) {
			withStubs(t, "deadbeefdeadbeef", "1.15.7", nil)
			fr := &fakeRunner{}
			var out bytes.Buffer
			dir := t.TempDir()
			code := Run(Opts{
				Root:          filepath.Join(fixtures, name),
				ProjectID:     "x",
				TrustedCommit: "deadbeefdeadbeef", // even WITH trust, a rejected repo never inits
				OutDir:        dir,
			}, fr, &out)
			if code != 2 {
				t.Fatalf("exit = %d, want 2 (refusal)\n%s", code, out.String())
			}
			if len(fr.calls) != 0 {
				t.Fatalf("runner called %v — init must NEVER run for a rejected repo", fr.calls)
			}
			// 0033 §3 / P11: the reject verdict+findings PERSIST — the wizard renders
			// them from prescan-report.json, not from a vanished stdout.
			rep := readReport(t, dir)
			if rep["verdict"] != "reject" {
				t.Errorf("prescan-report.json verdict = %v, want reject", rep["verdict"])
			}
			findings, ok := rep["findings"].([]any)
			if !ok || len(findings) == 0 {
				t.Errorf("prescan-report.json must carry the findings for a rejected repo; got %v", rep["findings"])
			}
			if _, err := os.Stat(filepath.Join(dir, "trust-request.json")); !os.IsNotExist(err) {
				t.Error("trust-request.json must NOT be written for a rejected repo")
			}
		})
	}
}

func readReport(t *testing.T, dir string) map[string]any {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(dir, "prescan-report.json"))
	if err != nil {
		t.Fatalf("prescan-report.json not written: %v", err)
	}
	var rep map[string]any
	if err := json.Unmarshal(b, &rep); err != nil {
		t.Fatalf("prescan-report.json is not valid JSON: %v", err)
	}
	return rep
}

// (b) Clean repo without --trusted-commit stops at the trust request; nothing runs.
func TestCleanUntrusted_StopsAtTrustRequest(t *testing.T) {
	withStubs(t, "abc123def456", "1.15.7", nil)
	fr := &fakeRunner{}
	var out bytes.Buffer
	dir := t.TempDir()
	code := Run(Opts{Root: filepath.Join(fixtures, "clean-repo"), ProjectID: "bootstrap", OutDir: dir}, fr, &out)
	if code != 0 {
		t.Fatalf("exit = %d, want 0\n%s", code, out.String())
	}
	if len(fr.calls) != 0 {
		t.Fatalf("runner called %v — must stop before init without trust", fr.calls)
	}
	b, err := os.ReadFile(filepath.Join(dir, "trust-request.json"))
	if err != nil {
		t.Fatalf("trust-request.json not written: %v", err)
	}
	var tr map[string]string
	if err := json.Unmarshal(b, &tr); err != nil {
		t.Fatal(err)
	}
	if tr["commitSha"] != "abc123def456" {
		t.Errorf("commitSha = %q, want abc123def456", tr["commitSha"])
	}
	if tr["prescanSha256"] == "" {
		t.Error("trust-request.json missing prescanSha256")
	}
	if _, err := os.Stat(filepath.Join(dir, "providers-schema.json")); !os.IsNotExist(err) {
		t.Error("providers-schema.json must NOT exist before trust")
	}
	// The trust-request's schema is EXACTLY the three keys the api/UI parse
	// (0033 P1: the real artifact, nothing else).
	if len(tr) != 3 {
		t.Errorf("trust-request.json carries %d keys %v, want exactly {repo, commitSha, prescanSha256}", len(tr), tr)
	}
	// 0033 §3.2 binding: sha256(prescan-report.json bytes) == trust-request.prescanSha256 —
	// the exact recomputation ccp-api performs at upload.
	reportBytes, err := os.ReadFile(filepath.Join(dir, "prescan-report.json"))
	if err != nil {
		t.Fatalf("prescan-report.json not written on the clean-untrusted stop: %v", err)
	}
	sum := sha256.Sum256(reportBytes)
	if got := hex.EncodeToString(sum[:]); got != tr["prescanSha256"] {
		t.Errorf("sha256(prescan-report.json) = %s, want trust-request.prescanSha256 %s", got, tr["prescanSha256"])
	}
	// The next-step text points at the wizard's upload step, not a dead control (P10).
	if !strings.Contains(out.String(), "Admin → Projects") {
		t.Errorf("next-step text must point at the Admin → Projects wizard\n%s", out.String())
	}
	if !strings.Contains(out.String(), "--trusted-commit abc123def456") {
		t.Errorf("next-step text must carry the exact --trusted-commit re-run\n%s", out.String())
	}
}

// The report artifact's key set is a UI/api contract (ccp-api's zod schema and
// the wizard's findings/census render both parse these exact keys). Golden-pins the
// shape so a Go-side field rename is caught here, not in a failed upload.
func TestPrescanReportShape_IsTheWizardContract(t *testing.T) {
	withStubs(t, "abc123def456", "1.15.7", nil)
	var out bytes.Buffer
	dir := t.TempDir()
	if code := Run(Opts{Root: filepath.Join(fixtures, "clean-repo"), ProjectID: "bootstrap", OutDir: dir}, &fakeRunner{}, &out); code != 0 {
		t.Fatalf("exit = %d, want 0\n%s", code, out.String())
	}
	rep := readReport(t, dir)
	keys := make([]string, 0, len(rep))
	for k := range rep {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	want := []string{"findings", "fmtDirtyFiles", "moduleBlocks", "providerPins", "repo", "resourceBlocks", "tfJsonFiles", "verdict"}
	if strings.Join(keys, ",") != strings.Join(want, ",") {
		t.Errorf("prescan-report.json keys = %v, want %v (frozen wizard/api contract)", keys, want)
	}
	if rep["verdict"] != "clean" {
		t.Errorf("verdict = %v, want clean", rep["verdict"])
	}
	if findings, ok := rep["findings"].([]any); !ok || len(findings) != 0 {
		t.Errorf("clean report must carry an EMPTY findings array (never null/absent); got %v", rep["findings"])
	}
}

// (c) Clean repo WITH a matching --trusted-commit runs init THEN schema, in order.
func TestCleanTrusted_RunsInitThenSchema(t *testing.T) {
	withStubs(t, "abc123def456", "1.15.7", nil) // real extractor → clean-repo yields 2 addrs
	fr := &fakeRunner{schema: []byte(`{"format_version":"1.0","provider_schemas":{}}`)}
	var out bytes.Buffer
	dir := t.TempDir()
	code := Run(Opts{
		Root:          filepath.Join(fixtures, "clean-repo"),
		ProjectID:     "bootstrap",
		TrustedCommit: "abc123def456",
		OutDir:        dir,
	}, fr, &out)
	if code != 0 {
		t.Fatalf("exit = %d, want 0\n%s", code, out.String())
	}
	if len(fr.calls) != 2 || fr.calls[0].op != "init" || fr.calls[1].op != "schema" {
		t.Fatalf("calls = %v, want [init schema] in order", fr.calls)
	}
	if fr.calls[0].dir != filepath.Join(fixtures, "clean-repo") {
		t.Errorf("init dir = %q", fr.calls[0].dir)
	}
	if _, err := os.Stat(filepath.Join(dir, "providers-schema.json")); err != nil {
		t.Fatalf("providers-schema.json not written: %v", err)
	}
}

// (d) A --trusted-commit that does not match HEAD refuses; nothing runs.
func TestTrustedCommitMismatch_Refuses(t *testing.T) {
	withStubs(t, "abc123def456", "1.15.7", nil)
	fr := &fakeRunner{}
	var out bytes.Buffer
	code := Run(Opts{
		Root:          filepath.Join(fixtures, "clean-repo"),
		ProjectID:     "x",
		TrustedCommit: "0000badcommit0",
		OutDir:        t.TempDir(),
	}, fr, &out)
	if code != 2 {
		t.Fatalf("exit = %d, want 2\n%s", code, out.String())
	}
	if len(fr.calls) != 0 {
		t.Fatalf("runner called %v — a trust mismatch must not init", fr.calls)
	}
	if !strings.Contains(out.String(), "UNTRUSTED_COMMIT") {
		t.Errorf("want UNTRUSTED_COMMIT refusal\n%s", out.String())
	}
}

// (e) G1: prescan counted resources but extraction yielded 0 ⇒ REFUSE
// EMPTY_INVENTORY. The repo is trusted, so the sandbox DID run first.
func TestEmptyInventory_RefusesAfterSandbox(t *testing.T) {
	withStubs(t, "abc123def456", "1.15.7", []string{}) // force 0 extracted
	fr := &fakeRunner{}
	var out bytes.Buffer
	code := Run(Opts{
		Root:          filepath.Join(fixtures, "clean-repo"),
		ProjectID:     "x",
		TrustedCommit: "abc123def456",
		OutDir:        t.TempDir(),
	}, fr, &out)
	if code != 2 {
		t.Fatalf("exit = %d, want 2\n%s", code, out.String())
	}
	if !strings.Contains(out.String(), "EMPTY_INVENTORY") {
		t.Errorf("want EMPTY_INVENTORY refusal\n%s", out.String())
	}
	if len(fr.calls) != 2 {
		t.Errorf("calls = %v — the G1 guard is post-sandbox on a trusted repo", fr.calls)
	}
}

// (f) G8: installed terraform cannot satisfy required_version ⇒ refuse, pre-init.
func TestRequiredVersionUnsatisfied_Refuses(t *testing.T) {
	withStubs(t, "abc123def456", "1.0.0", nil) // clean-repo requires >= 1.15.0
	fr := &fakeRunner{}
	var out bytes.Buffer
	code := Run(Opts{
		Root:          filepath.Join(fixtures, "clean-repo"),
		ProjectID:     "x",
		TrustedCommit: "abc123def456",
		OutDir:        t.TempDir(),
	}, fr, &out)
	if code != 2 {
		t.Fatalf("exit = %d, want 2\n%s", code, out.String())
	}
	if len(fr.calls) != 0 {
		t.Fatalf("runner called %v — the version gate is pre-init", fr.calls)
	}
	if !strings.Contains(out.String(), "VERSION_UNSATISFIED") {
		t.Errorf("want VERSION_UNSATISFIED refusal\n%s", out.String())
	}
}

func TestVersionSatisfies(t *testing.T) {
	cases := []struct {
		installed, constraint string
		want                  bool
	}{
		{"1.15.7", ">= 1.15.0", true},
		{"1.0.0", ">= 1.15.0", false},
		{"1.15.7", "~> 1.10", true}, // bootstrap's real constraint
		{"2.0.0", "~> 1.10", false}, // pessimistic upper bound
		{"1.10.0", "~> 1.10", true},
		{"1.9.9", "~> 1.10", false},
		{"1.15.7", ">= 1.10, < 2.0", true},
		{"1.5.0", "", true}, // no constraint ⇒ satisfied
		{"1.15.7", "1.15.7", true},
		{"1.15.7", "= 1.15.7", true},
	}
	for _, c := range cases {
		got, err := versionSatisfies(c.installed, c.constraint)
		if err != nil {
			t.Fatalf("versionSatisfies(%q,%q): %v", c.installed, c.constraint, err)
		}
		if got != c.want {
			t.Errorf("versionSatisfies(%q,%q) = %v, want %v", c.installed, c.constraint, got, c.want)
		}
	}
}
