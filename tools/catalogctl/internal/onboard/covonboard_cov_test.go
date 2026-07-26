package onboard

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/hashicorp/hcl/v2/hclparse"

	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/cli"
)

// ── slot-local helpers (all identifiers prefixed covonboard) ────────────────

// covonboardstubs describes the process-touching seams to replace for one test.
type covonboardstubs struct {
	head      string
	headErr   error
	tfVer     string
	tfErr     error
	addrs     []string
	addrsErr  error
	stubAddrs bool // when false the REAL extractor stays wired
}

func covonboardstub(t *testing.T, s covonboardstubs) {
	t.Helper()
	oGit, oTF, oEx := gitHead, tfVersion, extractAddrs
	gitHead = func(string) (string, error) { return s.head, s.headErr }
	tfVersion = func() (string, error) { return s.tfVer, s.tfErr }
	if s.stubAddrs {
		extractAddrs = func(string) ([]string, error) { return s.addrs, s.addrsErr }
	}
	t.Cleanup(func() { gitHead, tfVersion, extractAddrs = oGit, oTF, oEx })
}

// covonboardrunner records the sandbox calls in order and can fail either step.
type covonboardrunner struct {
	ops       []string
	dirs      []string
	schema    []byte
	initErr   error
	schemaErr error
}

func (r *covonboardrunner) Init(dir string) error {
	r.ops, r.dirs = append(r.ops, "init"), append(r.dirs, dir)
	return r.initErr
}

func (r *covonboardrunner) ProvidersSchema(dir string) ([]byte, error) {
	r.ops, r.dirs = append(r.ops, "schema"), append(r.dirs, dir)
	if r.schemaErr != nil {
		return nil, r.schemaErr
	}
	if r.schema != nil {
		return r.schema, nil
	}
	return []byte(`{"format_version":"1.0"}`), nil
}

// covonboarduploader is a local Uploader double (independent of the one in
// contract_test.go) that can be made to fail.
type covonboarduploader struct {
	calls int
	err   error
	last  TrustRequestUpload
	token string
}

func (u *covonboarduploader) UploadTrustRequest(server, projectID, token string, body TrustRequestUpload) error {
	u.calls++
	u.last, u.token = body, token
	return u.err
}

// covonboardrepo materializes a repo from rel-path → contents and returns root.
func covonboardrepo(t *testing.T, files map[string]string) string {
	t.Helper()
	root := t.TempDir()
	for rel, body := range files {
		p := filepath.Join(root, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return root
}

// covonboardcleanRepo is a minimal prescan-clean repo: two resources, no
// provider/module source to check, no required_version.
const covonboardcleanRepo = `resource "aws_s3_bucket" "logs" {
  bucket = "b"
}

resource "aws_kms_key" "primary" {
  description = "d"
}
`

// covonboardstubBin installs an executable shell stub named `name` as the ONLY
// thing on PATH, so exec.Command(name, …) is fully deterministic and no real
// git/terraform binary can ever be reached. Returns the record-file path the
// stub appends its argv to.
func covonboardstubBin(t *testing.T, name, body string) string {
	t.Helper()
	dir := t.TempDir()
	rec := filepath.Join(dir, "argv.txt")
	script := "#!/bin/sh\nprintf '%s\\n' \"$*\" >> " + rec + "\n" + body + "\n"
	if err := os.WriteFile(filepath.Join(dir, name), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir)
	return rec
}

func covonboardrecorded(t *testing.T, rec string) string {
	t.Helper()
	b, err := os.ReadFile(rec)
	if err != nil {
		t.Fatalf("stub was never invoked (%s): %v", rec, err)
	}
	return strings.TrimSpace(string(b))
}

// covonboardclearCloudCreds removes every credential env var
// assertNoCloudCreds fails closed on, restoring them at test end. Needed
// because the ambient environment of this test host may legitimately carry
// AWS_* variables.
func covonboardclearCloudCreds(t *testing.T) {
	t.Helper()
	for _, kv := range os.Environ() {
		name := kv
		if i := strings.IndexByte(kv, '='); i >= 0 {
			name = kv[:i]
		}
		for _, pfx := range []string{"AWS_", "GOOGLE_", "ARM_", "TF_TOKEN_"} {
			if strings.HasPrefix(name, pfx) {
				old, had := os.LookupEnv(name)
				if err := os.Unsetenv(name); err != nil {
					t.Fatalf("unset %s: %v", name, err)
				}
				t.Cleanup(func() {
					if had {
						_ = os.Setenv(name, old)
					}
				})
				break
			}
		}
	}
}

// covonboardclearCI neutralizes the CI provenance detection inputs so a run
// under GitHub Actions / GitLab CI behaves like a local run.
func covonboardclearCI(t *testing.T) {
	t.Helper()
	for _, k := range []string{
		"GITHUB_ACTIONS", "GITHUB_SERVER_URL", "GITHUB_REPOSITORY", "GITHUB_RUN_ID",
		"GITLAB_CI", "CI_PIPELINE_URL",
	} {
		t.Setenv(k, "")
	}
}

// ── Run(): internal-error (exit 1) paths ────────────────────────────────────

func TestCovonboardRun_InternalErrorsExitOne(t *testing.T) {
	t.Run("prescan cannot walk a missing root", func(t *testing.T) {
		covonboardstub(t, covonboardstubs{head: "abc123def456", tfVer: "1.15.7"})
		r := &covonboardrunner{}
		var out strings.Builder
		code := Run(Opts{
			Root:      filepath.Join(t.TempDir(), "does-not-exist"),
			ProjectID: "p",
			OutDir:    t.TempDir(),
		}, r, nil, &out)
		if code != 1 {
			t.Fatalf("exit = %d, want 1 (internal)\n%s", code, out.String())
		}
		if !strings.Contains(out.String(), "internal: prescan failed:") {
			t.Errorf("want the prescan-failure diagnostic\n%s", out.String())
		}
		if len(r.ops) != 0 {
			t.Errorf("runner called %v — nothing may execute when the prescan itself failed", r.ops)
		}
	})

	t.Run("prescan-report.json unwritable because --out is a regular file", func(t *testing.T) {
		covonboardstub(t, covonboardstubs{head: "abc123def456", tfVer: "1.15.7"})
		notADir := filepath.Join(t.TempDir(), "out-is-a-file")
		if err := os.WriteFile(notADir, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
		r := &covonboardrunner{}
		var out strings.Builder
		code := Run(Opts{
			Root:          covonboardrepo(t, map[string]string{"main.tf": covonboardcleanRepo}),
			ProjectID:     "p",
			TrustedCommit: "abc123def456",
			OutDir:        notADir,
		}, r, nil, &out)
		if code != 1 {
			t.Fatalf("exit = %d, want 1\n%s", code, out.String())
		}
		if !strings.Contains(out.String(), "internal:") {
			t.Errorf("want an internal: diagnostic\n%s", out.String())
		}
		if len(r.ops) != 0 {
			t.Errorf("runner called %v — the report must persist before anything runs", r.ops)
		}
	})

	t.Run("trust-request.json unwritable", func(t *testing.T) {
		covonboardstub(t, covonboardstubs{head: "abc123def456", tfVer: "1.15.7"})
		dir := t.TempDir()
		// A directory squatting on the artifact name makes exactly the
		// trust-request.json write fail, after prescan-report.json succeeded.
		if err := os.Mkdir(filepath.Join(dir, "trust-request.json"), 0o755); err != nil {
			t.Fatal(err)
		}
		var out strings.Builder
		code := Run(Opts{
			Root:      covonboardrepo(t, map[string]string{"main.tf": covonboardcleanRepo}),
			ProjectID: "p",
			OutDir:    dir,
		}, &covonboardrunner{}, nil, &out)
		if code != 1 {
			t.Fatalf("exit = %d, want 1\n%s", code, out.String())
		}
		if !strings.Contains(out.String(), "internal:") {
			t.Errorf("want an internal: diagnostic\n%s", out.String())
		}
		if _, err := os.Stat(filepath.Join(dir, "prescan-report.json")); err != nil {
			t.Errorf("prescan-report.json should already be persisted: %v", err)
		}
	})

	t.Run("providers-schema.json unwritable", func(t *testing.T) {
		covonboardstub(t, covonboardstubs{head: "abc123def456", tfVer: "1.15.7"})
		dir := t.TempDir()
		if err := os.Mkdir(filepath.Join(dir, "providers-schema.json"), 0o755); err != nil {
			t.Fatal(err)
		}
		r := &covonboardrunner{}
		var out strings.Builder
		code := Run(Opts{
			Root:          covonboardrepo(t, map[string]string{"main.tf": covonboardcleanRepo}),
			ProjectID:     "p",
			TrustedCommit: "abc123def456",
			OutDir:        dir,
		}, r, covonboardpanicUploader{}, &out)
		if code != 1 {
			t.Fatalf("exit = %d, want 1\n%s", code, out.String())
		}
		if !strings.Contains(out.String(), "internal:") {
			t.Errorf("want an internal: diagnostic\n%s", out.String())
		}
		if strings.Join(r.ops, ",") != "init,schema" {
			t.Errorf("ops = %v, want [init schema] before the failed write", r.ops)
		}
	})

	t.Run("resource extraction fails", func(t *testing.T) {
		covonboardstub(t, covonboardstubs{
			head: "abc123def456", tfVer: "1.15.7",
			stubAddrs: true, addrsErr: errors.New("boom: unreadable file"),
		})
		r := &covonboardrunner{}
		var out strings.Builder
		code := Run(Opts{
			Root:          covonboardrepo(t, map[string]string{"main.tf": covonboardcleanRepo}),
			ProjectID:     "p",
			TrustedCommit: "abc123def456",
			OutDir:        t.TempDir(),
		}, r, nil, &out)
		if code != 1 {
			t.Fatalf("exit = %d, want 1\n%s", code, out.String())
		}
		if !strings.Contains(out.String(), "internal: resource extraction failed: boom") {
			t.Errorf("want the extraction-failure diagnostic\n%s", out.String())
		}
	})
}

// covonboardpanicUploader is only ever handed to Run with an empty Opts.Server,
// so attemptUpload must return before ever calling it.
type covonboardpanicUploader struct{}

func (covonboardpanicUploader) UploadTrustRequest(string, string, string, TrustRequestUpload) error {
	panic("upload must never be attempted without --server")
}

// ── Run(): refusal + exit-3 paths ───────────────────────────────────────────

// The version gate runs BEFORE any runner call: an installed terraform that
// cannot even be interrogated is TERRAFORM_MISSING (exit 2), never an init.
func TestCovonboardRun_TerraformMissingRefusesPreInit(t *testing.T) {
	covonboardstub(t, covonboardstubs{
		head: "abc123def456", tfErr: errors.New("exec: \"terraform\": executable file not found in $PATH"),
	})
	r := &covonboardrunner{}
	var out strings.Builder
	code := Run(Opts{
		Root:          covonboardrepo(t, map[string]string{"main.tf": covonboardcleanRepo}),
		ProjectID:     "p",
		TrustedCommit: "abc123def456",
		OutDir:        t.TempDir(),
	}, r, nil, &out)
	if code != 2 {
		t.Fatalf("exit = %d, want 2 (refusal)\n%s", code, out.String())
	}
	if !strings.Contains(out.String(), "REFUSE TERRAFORM_MISSING: exec:") {
		t.Errorf("want a REFUSE TERRAFORM_MISSING line carrying the reason\n%s", out.String())
	}
	if len(r.ops) != 0 {
		t.Errorf("runner called %v — the version gate is strictly pre-init", r.ops)
	}
}

// A satisfied required_version proceeds to the sandbox (the positive half of
// the gate, with the constraint read from the repo rather than skipped).
func TestCovonboardRun_RequiredVersionSatisfiedProceeds(t *testing.T) {
	covonboardstub(t, covonboardstubs{head: "abc123def456", tfVer: "1.15.7"})
	root := covonboardrepo(t, map[string]string{
		"versions.tf": "terraform {\n  required_version = \">= 1.10.0, < 2.0.0\"\n}\n",
		"main.tf":     covonboardcleanRepo,
	})
	r := &covonboardrunner{}
	var out strings.Builder
	dir := t.TempDir()
	code := Run(Opts{Root: root, ProjectID: "p", TrustedCommit: "abc123def456", OutDir: dir}, r, nil, &out)
	if code != 0 {
		t.Fatalf("exit = %d, want 0\n%s", code, out.String())
	}
	if strings.Join(r.ops, ",") != "init,schema" {
		t.Fatalf("ops = %v, want [init schema]", r.ops)
	}
	if strings.Join(r.dirs, ",") != root+","+root {
		t.Errorf("sandbox dirs = %v, want both calls against the repo root %s", r.dirs, root)
	}
	if !strings.Contains(out.String(), "providers-schema.json written (24 bytes)") {
		t.Errorf("want the schema byte count reported\n%s", out.String())
	}
	b, err := os.ReadFile(filepath.Join(dir, "providers-schema.json"))
	if err != nil {
		t.Fatalf("providers-schema.json not written: %v", err)
	}
	if string(b) != `{"format_version":"1.0"}` {
		t.Errorf("providers-schema.json = %q, want the sandbox output verbatim", b)
	}
}

func TestCovonboardRun_SandboxFailuresExitThree(t *testing.T) {
	t.Run("init failure stops before schema", func(t *testing.T) {
		covonboardstub(t, covonboardstubs{head: "abc123def456", tfVer: "1.15.7"})
		r := &covonboardrunner{initErr: errors.New("provider registry unreachable")}
		var out strings.Builder
		dir := t.TempDir()
		code := Run(Opts{
			Root:          covonboardrepo(t, map[string]string{"main.tf": covonboardcleanRepo}),
			ProjectID:     "p",
			TrustedCommit: "abc123def456",
			OutDir:        dir,
		}, r, nil, &out)
		if code != 3 {
			t.Fatalf("exit = %d, want 3 (terraform/schema error)\n%s", code, out.String())
		}
		if !strings.Contains(out.String(), "terraform init failed: provider registry unreachable") {
			t.Errorf("want the init-failure diagnostic\n%s", out.String())
		}
		if strings.Join(r.ops, ",") != "init" {
			t.Errorf("ops = %v — schema must not be attempted after a failed init", r.ops)
		}
		if _, err := os.Stat(filepath.Join(dir, "providers-schema.json")); !os.IsNotExist(err) {
			t.Error("providers-schema.json must not exist after a failed init")
		}
	})

	t.Run("schema failure", func(t *testing.T) {
		covonboardstub(t, covonboardstubs{head: "abc123def456", tfVer: "1.15.7"})
		r := &covonboardrunner{schemaErr: errors.New("no provider schemas")}
		var out strings.Builder
		dir := t.TempDir()
		code := Run(Opts{
			Root:          covonboardrepo(t, map[string]string{"main.tf": covonboardcleanRepo}),
			ProjectID:     "p",
			TrustedCommit: "abc123def456",
			OutDir:        dir,
		}, r, nil, &out)
		if code != 3 {
			t.Fatalf("exit = %d, want 3\n%s", code, out.String())
		}
		if !strings.Contains(out.String(), "terraform providers schema failed: no provider schemas") {
			t.Errorf("want the schema-failure diagnostic\n%s", out.String())
		}
		if strings.Join(r.ops, ",") != "init,schema" {
			t.Errorf("ops = %v, want [init schema]", r.ops)
		}
		if _, err := os.Stat(filepath.Join(dir, "providers-schema.json")); !os.IsNotExist(err) {
			t.Error("providers-schema.json must not exist after a failed schema call")
		}
	})
}

// ── census / scaffold rendering ─────────────────────────────────────────────

func TestCovonboardRun_CensusRendersSortedProviderPins(t *testing.T) {
	covonboardstub(t, covonboardstubs{head: "abc123def456", tfVer: "1.15.7"})
	root := covonboardrepo(t, map[string]string{
		"versions.tf": `terraform {
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
    }
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}
`,
		"main.tf": covonboardcleanRepo,
		"mod.tf":  "module \"vpc\" {\n  source = \"./vpc\"\n}\n",
	})
	var out strings.Builder
	code := Run(Opts{Root: root, ProjectID: "p", OutDir: t.TempDir()}, &covonboardrunner{}, nil, &out)
	if code != 0 {
		t.Fatalf("exit = %d, want 0\n%s", code, out.String())
	}
	s := out.String()
	// Two pins ⇒ the ", " join, in sorted key order (deterministic report).
	if !strings.Contains(s, "provider pins:   aws=~> 6.0, google=~> 5.0") {
		t.Errorf("want both pins joined and sorted\n%s", s)
	}
	for _, want := range []string{
		"resource blocks: 2",
		"modules:         1",
		".tf.json files:  0",
		"fmt-dirty files: 0",
	} {
		if !strings.Contains(s, want) {
			t.Errorf("census missing %q\n%s", want, s)
		}
	}
}

// A fmt-dirty repo still onboards, and the scaffold prints the normalization
// remediation while restating that edit's FMT_DIRTY refusal stays in force.
func TestCovonboardRun_ScaffoldReportsFmtDirtyRemediation(t *testing.T) {
	covonboardstub(t, covonboardstubs{head: "abc123def456", tfVer: "1.15.7"})
	root := covonboardrepo(t, map[string]string{
		"main.tf": "resource \"aws_s3_bucket\" \"logs\" {\n        bucket = \"b\"\n}\n",
	})
	var out strings.Builder
	code := Run(Opts{Root: root, ProjectID: "proj-9", TrustedCommit: "abc123def456", OutDir: t.TempDir()},
		&covonboardrunner{}, nil, &out)
	if code != 0 {
		t.Fatalf("exit = %d, want 0\n%s", code, out.String())
	}
	s := out.String()
	if !strings.Contains(s, "fmt-dirty files: 1") {
		t.Errorf("census must count the fmt-dirty file\n%s", s)
	}
	if !strings.Contains(s, "NOTE: 1 fmt-dirty file(s) — run `terraform fmt -recursive`") {
		t.Errorf("scaffold must print the fmt remediation\n%s", s)
	}
	if !strings.Contains(s, "FMT_DIRTY refusal stays in force") {
		t.Errorf("scaffold must restate that FMT_DIRTY is never auto-fixed\n%s", s)
	}
	if !strings.Contains(s, `extracted 1 resource address(es) for project "proj-9"`) {
		t.Errorf("scaffold must report the extracted address count\n%s", s)
	}
}

// ── attemptUpload edges reachable through Run ───────────────────────────────

func TestCovonboardRun_ServerSetButNoUploaderWired(t *testing.T) {
	covonboardstub(t, covonboardstubs{head: "abc123def456", tfVer: "1.15.7"})
	dir := t.TempDir()
	var out strings.Builder
	code := Run(Opts{
		Root: covonboardrepo(t, map[string]string{"main.tf": covonboardcleanRepo}), ProjectID: "p",
		OutDir: dir, Server: "https://ccp.example.test", OnboardToken: "tok",
	}, &covonboardrunner{}, nil, &out)
	if code != 0 {
		t.Fatalf("exit = %d, want 0 — a missing uploader never changes the exit code\n%s", code, out.String())
	}
	s := out.String()
	if !strings.Contains(s, "internal: --server set but no uploader wired; skipping upload") {
		t.Errorf("want the no-uploader notice\n%s", s)
	}
	// Not-uploaded ⇒ the manual wizard-upload instruction is still printed.
	if !strings.Contains(s, "upload trust-request.json + prescan-report.json (wizard step ②)") {
		t.Errorf("want the manual upload instruction when nothing was uploaded\n%s", s)
	}
	for _, name := range []string{"trust-request.json", "prescan-report.json"} {
		if _, err := os.Stat(filepath.Join(dir, name)); err != nil {
			t.Errorf("%s must still be on disk: %v", name, err)
		}
	}
}

// An empty --out means the current directory, both for the artifact writes and
// for the failed-upload fallback message.
func TestCovonboardRun_EmptyOutDirMeansCurrentDirectory(t *testing.T) {
	cwd := t.TempDir()
	t.Chdir(cwd)
	covonboardstub(t, covonboardstubs{head: "abc123def456", tfVer: "1.15.7"})
	u := &covonboarduploader{err: errors.New("simulated: connection refused")}
	var out strings.Builder
	code := Run(Opts{
		Root: covonboardrepo(t, map[string]string{"main.tf": covonboardcleanRepo}), ProjectID: "p one",
		OutDir: "", Server: "https://ccp.example.test/", OnboardToken: "tok",
	}, &covonboardrunner{}, u, &out)
	if code != 0 {
		t.Fatalf("exit = %d, want 0 (an upload failure never changes the exit code)\n%s", code, out.String())
	}
	if u.calls != 1 {
		t.Fatalf("upload calls = %d, want 1", u.calls)
	}
	if u.token != "tok" {
		t.Errorf("uploaded token = %q, want the token from Opts", u.token)
	}
	if !strings.Contains(u.last.PrescanReport, `"verdict": "clean"`) {
		t.Errorf("uploaded prescanReport must be the raw report bytes: %q", u.last.PrescanReport)
	}
	for _, name := range []string{"trust-request.json", "prescan-report.json"} {
		if _, err := os.Stat(filepath.Join(cwd, name)); err != nil {
			t.Errorf("%s must be written into the current directory: %v", name, err)
		}
	}
	s := out.String()
	if !strings.Contains(s, "the scan artifact(s) already saved in . are untouched") {
		t.Errorf("fallback message must name . as the output directory\n%s", s)
	}
	// The failure message names the exact endpoint, with the project id escaped.
	if !strings.Contains(s, "upload to https://ccp.example.test/projects/p%20one/trust-request failed:") {
		t.Errorf("failure message must name the escaped endpoint\n%s", s)
	}
}

// ── writeBytes / writeJSON ──────────────────────────────────────────────────

func TestCovonboardWriteBytesAndWriteJSON(t *testing.T) {
	t.Run("empty dir writes into the current directory", func(t *testing.T) {
		cwd := t.TempDir()
		t.Chdir(cwd)
		if err := writeBytes("", "artifact.json", []byte("{}\n")); err != nil {
			t.Fatalf("writeBytes: %v", err)
		}
		b, err := os.ReadFile(filepath.Join(cwd, "artifact.json"))
		if err != nil {
			t.Fatalf("file not written into cwd: %v", err)
		}
		if string(b) != "{}\n" {
			t.Errorf("contents = %q, want %q", b, "{}\n")
		}
	})

	t.Run("nested dir is created", func(t *testing.T) {
		root := t.TempDir()
		dir := filepath.Join(root, "a", "b")
		if err := writeBytes(dir, "x.json", []byte("1")); err != nil {
			t.Fatalf("writeBytes: %v", err)
		}
		if _, err := os.Stat(filepath.Join(dir, "x.json")); err != nil {
			t.Fatalf("nested write: %v", err)
		}
	})

	t.Run("mkdir failure surfaces as an error", func(t *testing.T) {
		f := filepath.Join(t.TempDir(), "regular-file")
		if err := os.WriteFile(f, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
		if err := writeBytes(filepath.Join(f, "nested"), "x.json", []byte("1")); err == nil {
			t.Fatal("want an error when the parent path is a regular file")
		}
	})

	t.Run("writeJSON indents and newline-terminates", func(t *testing.T) {
		dir := t.TempDir()
		if err := writeJSON(dir, "tr.json", map[string]string{"repo": "r"}); err != nil {
			t.Fatalf("writeJSON: %v", err)
		}
		b, err := os.ReadFile(filepath.Join(dir, "tr.json"))
		if err != nil {
			t.Fatal(err)
		}
		if string(b) != "{\n  \"repo\": \"r\"\n}\n" {
			t.Errorf("contents = %q", b)
		}
	})

	t.Run("writeJSON reports a marshal failure and writes nothing", func(t *testing.T) {
		dir := t.TempDir()
		err := writeJSON(dir, "bad.json", func() {})
		if err == nil {
			t.Fatal("want an error for an unmarshalable value")
		}
		if _, statErr := os.Stat(filepath.Join(dir, "bad.json")); !os.IsNotExist(statErr) {
			t.Error("no file may be written when marshalling failed")
		}
	})
}

// ── version constraint evaluation ───────────────────────────────────────────

func TestCovonboardVersionSatisfies_OperatorMatrix(t *testing.T) {
	cases := []struct {
		name                  string
		installed, constraint string
		want                  bool
	}{
		{"gt satisfied", "1.16.0", "> 1.15.0", true},
		{"gt equal is not greater", "1.15.0", "> 1.15.0", false},
		{"lte equal", "1.15.0", "<= 1.15.0", true},
		{"lte below", "1.14.9", "<= 1.15.0", true},
		{"lte above", "1.16.0", "<= 1.15.0", false},
		{"lt", "1.14.9", "< 1.15.0", true},
		{"lt equal", "1.15.0", "< 1.15.0", false},
		{"eq eq form", "1.15.7", "== 1.15.7", true},
		{"eq eq form mismatch", "1.15.8", "== 1.15.7", false},
		{"neq excludes the named version", "1.15.7", "!= 1.15.7", false},
		{"neq allows anything else", "1.15.8", "!= 1.15.7", true},
		{"empty term is ignored", "1.15.7", ">= 1.10, ", true},
		{"whitespace-only constraint is satisfied", "1.15.7", "   ", true},
		{"prerelease suffix is compared on the release part", "1.16.0-beta1", ">= 1.16.0", true},
		{"build metadata is stripped", "1.16.0+ent", ">= 1.16.0", true},
		{"shorter installed compares as zero-padded", "1", ">= 1.0.1", false},
		{"shorter constraint compares as zero-padded", "1.16", ">= 1.15.7", true},
		{"single-segment pessimistic lower bound", "1.9.9", "~> 1", true},
		{"single-segment pessimistic upper bound", "2.0.0", "~> 1", false},
		{"three-segment pessimistic upper bound", "1.11.0", "~> 1.10.2", false},
		{"three-segment pessimistic in range", "1.10.9", "~> 1.10.2", true},
		{"three-segment pessimistic below lower bound", "1.10.1", "~> 1.10.2", false},
		{"non-numeric lower bound stays lenient", "1.15.7", ">= v1.2.0", true},
		{"conjunction where the second term fails", "1.15.7", ">= 1.10, < 1.15", false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, err := versionSatisfies(c.installed, c.constraint)
			if err != nil {
				t.Fatalf("versionSatisfies(%q, %q): unexpected error %v", c.installed, c.constraint, err)
			}
			if got != c.want {
				t.Errorf("versionSatisfies(%q, %q) = %v, want %v", c.installed, c.constraint, got, c.want)
			}
		})
	}
}

func TestCovonboardParseVerAndCmpVer(t *testing.T) {
	if got := parseVer(" 1.15.7-rc1 "); len(got) != 3 || got[0] != 1 || got[1] != 15 || got[2] != 7 {
		t.Errorf("parseVer(1.15.7-rc1) = %v, want [1 15 7]", got)
	}
	if got := parseVer("1.x.3"); len(got) != 3 || got[1] != 0 {
		t.Errorf("parseVer(1.x.3) = %v, want a zero for the unparseable segment", got)
	}
	if got := cmpVer([]int{1}, []int{1, 0, 0}); got != 0 {
		t.Errorf("cmpVer([1],[1 0 0]) = %d, want 0 (missing segments are zero)", got)
	}
	if got := cmpVer([]int{1, 0}, []int{1, 0, 1}); got != -1 {
		t.Errorf("cmpVer([1 0],[1 0 1]) = %d, want -1", got)
	}
	if got := cmpVer([]int{2}, []int{1, 9, 9}); got != 1 {
		t.Errorf("cmpVer([2],[1 9 9]) = %d, want 1", got)
	}
}

func TestCovonboardPessimisticUpper(t *testing.T) {
	cases := []struct {
		in, want []int
	}{
		{[]int{1}, []int{2}},                // ~> 1      ⇒ < 2
		{[]int{1, 10}, []int{2}},            // ~> 1.10   ⇒ < 2
		{[]int{1, 10, 2}, []int{1, 11}},     // ~> 1.10.2 ⇒ < 1.11
		{[]int{1, 2, 3, 4}, []int{1, 2, 4}}, // ~> 1.2.3.4 ⇒ < 1.2.4
	}
	for _, c := range cases {
		got := pessimisticUpper(c.in)
		if len(got) != len(c.want) {
			t.Fatalf("pessimisticUpper(%v) = %v, want %v", c.in, got, c.want)
		}
		for i := range got {
			if got[i] != c.want[i] {
				t.Fatalf("pessimisticUpper(%v) = %v, want %v", c.in, got, c.want)
			}
		}
	}
}

// ── readRequiredVersion / parseTF / staticStr ───────────────────────────────

func TestCovonboardReadRequiredVersion(t *testing.T) {
	t.Run("first file in walk order wins", func(t *testing.T) {
		root := covonboardrepo(t, map[string]string{
			"a.tf": "terraform {\n  required_version = \">= 1.10.0\"\n}\n",
			"b.tf": "terraform {\n  required_version = \">= 9.0.0\"\n}\n",
		})
		got, err := readRequiredVersion(root)
		if err != nil {
			t.Fatalf("readRequiredVersion: %v", err)
		}
		if got != ">= 1.10.0" {
			t.Errorf("got %q, want %q (the first declaration found)", got, ">= 1.10.0")
		}
	})

	t.Run("reads a .tf.json declaration", func(t *testing.T) {
		root := covonboardrepo(t, map[string]string{
			"main.tf.json": `{"terraform": {"required_version": ">= 1.12.0"}}`,
		})
		got, err := readRequiredVersion(root)
		if err != nil {
			t.Fatalf("readRequiredVersion: %v", err)
		}
		if got != ">= 1.12.0" {
			t.Errorf("got %q, want %q", got, ">= 1.12.0")
		}
	})

	t.Run("ignores .terraform and .git trees", func(t *testing.T) {
		root := covonboardrepo(t, map[string]string{
			".terraform/modules/m/v.tf": "terraform {\n  required_version = \">= 9.0.0\"\n}\n",
			".git/hooks/v.tf":           "terraform {\n  required_version = \">= 9.0.0\"\n}\n",
			"main.tf":                   covonboardcleanRepo,
		})
		got, err := readRequiredVersion(root)
		if err != nil {
			t.Fatalf("readRequiredVersion: %v", err)
		}
		if got != "" {
			t.Errorf("got %q, want \"\" — vendored/VCS trees are not the repo's own config", got)
		}
	})

	t.Run("a non-static expression is not a constraint", func(t *testing.T) {
		for name, body := range map[string]string{
			"variable reference": "terraform {\n  required_version = var.tf_version\n}\n",
			"local reference":    "terraform {\n  required_version = local.v\n}\n",
			"number literal":     "terraform {\n  required_version = 1.15\n}\n",
			"function call":      "terraform {\n  required_version = nosuchfunction(\"x\")\n}\n",
		} {
			root := covonboardrepo(t, map[string]string{"main.tf": body})
			got, err := readRequiredVersion(root)
			if err != nil {
				t.Fatalf("%s: readRequiredVersion: %v", name, err)
			}
			if got != "" {
				t.Errorf("%s: got %q, want \"\" (fail closed on a non-literal)", name, got)
			}
		}
	})

	t.Run("a missing root surfaces the walk error", func(t *testing.T) {
		if _, err := readRequiredVersion(filepath.Join(t.TempDir(), "nope")); err == nil {
			t.Fatal("want an error for a nonexistent root")
		}
	})
}

func TestCovonboardParseTF(t *testing.T) {
	parser := hclparse.NewParser()
	dir := t.TempDir()
	write := func(name, body string) string {
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
		return p
	}

	if _, ok := parseTF(parser, filepath.Join(dir, "missing.tf"), "missing.tf"); ok {
		t.Error("an unreadable path must not parse")
	}
	if _, ok := parseTF(parser, write("notes.txt", "resource \"a\" \"b\" {}\n"), "notes.txt"); ok {
		t.Error("a non-terraform extension must be skipped")
	}
	if _, ok := parseTF(parser, write("broken.tf", "resource \"a\" {\n"), "broken.tf"); ok {
		t.Error("a syntactically invalid .tf must not parse")
	}
	if _, ok := parseTF(parser, write("broken.tf.json", "{not json"), "broken.tf.json"); ok {
		t.Error("an invalid .tf.json must not parse")
	}
	if _, ok := parseTF(parser, write("ok.tf.json", `{"resource": {"aws_kms_key": {"k": {}}}}`), "ok.tf.json"); !ok {
		t.Error("a valid .tf.json must parse")
	}
	if _, ok := parseTF(parser, write("ok.tf", "resource \"aws_kms_key\" \"k\" {}\n"), "ok.tf"); !ok {
		t.Error("a valid .tf must parse")
	}
}

// ── realExtractAddrs ────────────────────────────────────────────────────────

func TestCovonboardRealExtractAddrs(t *testing.T) {
	t.Run("walks .tf and .tf.json, sorted, skipping .terraform and .git", func(t *testing.T) {
		root := covonboardrepo(t, map[string]string{
			"main.tf":                covonboardcleanRepo,
			"extra.tf.json":          `{"resource": {"aws_iam_role": {"r": {}}}}`,
			".terraform/vendored.tf": "resource \"aws_instance\" \"vendored\" {}\n",
			".git/objects/staged.tf": "resource \"aws_instance\" \"staged\" {}\n",
			"nested/deep/more.tf":    "resource \"aws_sqs_queue\" \"q\" {}\n",
			"README.md":              "not terraform\n",
			"unparseable.tf":         "resource \"a\" {\n",
		})
		got, err := realExtractAddrs(root)
		if err != nil {
			t.Fatalf("realExtractAddrs: %v", err)
		}
		want := "aws_iam_role.r,aws_kms_key.primary,aws_s3_bucket.logs,aws_sqs_queue.q"
		if strings.Join(got, ",") != want {
			t.Errorf("addrs = %v, want %s (sorted; vendored/VCS trees excluded)", got, want)
		}
	})

	t.Run("a missing root surfaces the walk error", func(t *testing.T) {
		if _, err := realExtractAddrs(filepath.Join(t.TempDir(), "nope")); err == nil {
			t.Fatal("want an error for a nonexistent root")
		}
	})
}

// ── realGitHead / realTFVersion (shell stubs on an isolated PATH) ───────────

func TestCovonboardRealGitHead(t *testing.T) {
	t.Run("trims the rev-parse output and passes -C dir", func(t *testing.T) {
		rec := covonboardstubBin(t, "git", "printf '  0123456789abcdef0123456789abcdef01234567  \\n'")
		dir := t.TempDir()
		got, err := realGitHead(dir)
		if err != nil {
			t.Fatalf("realGitHead: %v", err)
		}
		if got != "0123456789abcdef0123456789abcdef01234567" {
			t.Errorf("head = %q, want the trimmed sha", got)
		}
		if argv := covonboardrecorded(t, rec); argv != "-C "+dir+" rev-parse HEAD" {
			t.Errorf("git argv = %q, want %q", argv, "-C "+dir+" rev-parse HEAD")
		}
	})

	t.Run("a failing git is an error, not an empty sha", func(t *testing.T) {
		covonboardstubBin(t, "git", "echo 'fatal: not a git repository' 1>&2; exit 128")
		got, err := realGitHead(t.TempDir())
		if err == nil {
			t.Fatal("want an error when git fails")
		}
		if got != "" {
			t.Errorf("head = %q, want empty on error", got)
		}
	})
}

func TestCovonboardRealTFVersion(t *testing.T) {
	t.Run("reads terraform_version from version -json", func(t *testing.T) {
		rec := covonboardstubBin(t, "terraform", `printf '{"terraform_version":"1.15.7","platform":"linux_amd64"}'`)
		got, err := realTFVersion()
		if err != nil {
			t.Fatalf("realTFVersion: %v", err)
		}
		if got != "1.15.7" {
			t.Errorf("version = %q, want 1.15.7", got)
		}
		if argv := covonboardrecorded(t, rec); argv != "version -json" {
			t.Errorf("terraform argv = %q, want %q", argv, "version -json")
		}
	})

	t.Run("a non-zero exit is an error", func(t *testing.T) {
		covonboardstubBin(t, "terraform", "exit 1")
		if _, err := realTFVersion(); err == nil {
			t.Fatal("want an error when terraform exits non-zero")
		}
	})

	t.Run("unparseable output is an error", func(t *testing.T) {
		covonboardstubBin(t, "terraform", "printf 'Terraform v1.15.7'")
		if _, err := realTFVersion(); err == nil {
			t.Fatal("want an error when the output is not JSON")
		}
	})

	t.Run("a JSON body without the field is an error", func(t *testing.T) {
		covonboardstubBin(t, "terraform", `printf '{"platform":"linux_amd64"}'`)
		_, err := realTFVersion()
		if err == nil {
			t.Fatal("want an error when terraform_version is absent")
		}
		if !strings.Contains(err.Error(), "could not determine terraform version") {
			t.Errorf("error = %v, want the could-not-determine message", err)
		}
	})
}

// ── execRunner (the host-side sandbox contract) ─────────────────────────────

func TestCovonboardExecRunner_InitFailsClosedOnCloudCredential(t *testing.T) {
	rec := covonboardstubBin(t, "terraform", "exit 0")
	covonboardclearCloudCreds(t)
	t.Setenv("AWS_ACCESS_KEY_ID", "AKIA-not-a-real-key")

	err := execRunner{}.Init(t.TempDir())
	if err == nil {
		t.Fatal("Init must fail closed while a cloud credential is in the environment")
	}
	if !strings.Contains(err.Error(), "AWS_ACCESS_KEY_ID") || !strings.Contains(err.Error(), "sandbox contract") {
		t.Errorf("error = %v, want it to name the offending variable and the sandbox contract", err)
	}
	// The decisive assertion: terraform was never even spawned.
	if _, statErr := os.Stat(rec); !os.IsNotExist(statErr) {
		t.Error("terraform must NOT be invoked when a credential is present")
	}
}

func TestCovonboardExecRunner_InitAndSchemaInvocations(t *testing.T) {
	t.Run("init runs with -backend=false -input=false in the target dir", func(t *testing.T) {
		rec := covonboardstubBin(t, "terraform", ": > ./ran-here")
		covonboardclearCloudCreds(t)
		dir := t.TempDir()
		if err := (execRunner{}).Init(dir); err != nil {
			t.Fatalf("Init: %v", err)
		}
		if argv := covonboardrecorded(t, rec); argv != "init -backend=false -input=false" {
			t.Errorf("terraform argv = %q, want %q", argv, "init -backend=false -input=false")
		}
		if _, err := os.Stat(filepath.Join(dir, "ran-here")); err != nil {
			t.Errorf("init must run with the repo root as its working directory: %v", err)
		}
	})

	t.Run("providers schema returns the captured stdout", func(t *testing.T) {
		rec := covonboardstubBin(t, "terraform", `: > ./ran-here; printf '{"format_version":"1.0"}'`)
		covonboardclearCloudCreds(t)
		dir := t.TempDir()
		got, err := execRunner{}.ProvidersSchema(dir)
		if err != nil {
			t.Fatalf("ProvidersSchema: %v", err)
		}
		if string(got) != `{"format_version":"1.0"}` {
			t.Errorf("schema = %q", got)
		}
		if argv := covonboardrecorded(t, rec); argv != "providers schema -json" {
			t.Errorf("terraform argv = %q, want %q", argv, "providers schema -json")
		}
		if _, err := os.Stat(filepath.Join(dir, "ran-here")); err != nil {
			t.Errorf("schema must run with the repo root as its working directory: %v", err)
		}
	})

	t.Run("a failing providers schema returns no bytes", func(t *testing.T) {
		covonboardstubBin(t, "terraform", "printf 'partial'; exit 1")
		covonboardclearCloudCreds(t)
		got, err := execRunner{}.ProvidersSchema(t.TempDir())
		if err == nil {
			t.Fatal("want an error when terraform exits non-zero")
		}
		if got != nil {
			t.Errorf("schema = %q, want nil on error (never a partial document)", got)
		}
	})
}

func TestCovonboardAssertNoCloudCreds(t *testing.T) {
	covonboardclearCloudCreds(t)
	if err := AssertNoCloudCreds(); err != nil {
		t.Fatalf("a credential-free environment must pass: %v", err)
	}
	for _, name := range []string{"AWS_SESSION_TOKEN", "GOOGLE_APPLICATION_CREDENTIALS", "ARM_CLIENT_SECRET", "TF_TOKEN_app_terraform_io"} {
		t.Run(name, func(t *testing.T) {
			t.Setenv(name, "x")
			err := AssertNoCloudCreds()
			if err == nil {
				t.Fatalf("%s must fail the sandbox guard", name)
			}
			if !strings.Contains(err.Error(), name) {
				t.Errorf("error = %v, want it to name %s", err, name)
			}
		})
	}
}

// ── HTTPUploader (exported real uploader) ───────────────────────────────────

func TestCovonboardHTTPUploaderExportedIsTheRealPUT(t *testing.T) {
	var gotMethod, gotPath, gotAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod, gotPath, gotAuth = r.Method, r.URL.Path, r.Header.Get("Authorization")
		w.WriteHeader(http.StatusNoContent)
	}))
	defer srv.Close()

	u := HTTPUploader()
	if _, ok := u.(httpUploader); !ok {
		t.Fatalf("HTTPUploader() returned %T, want the real httpUploader", u)
	}
	body := TrustRequestUpload{
		TrustRequest:  TrustRequestTriple{Repo: "r", CommitSha: "abc123def456", PrescanSha256: strings.Repeat("a", 64)},
		PrescanReport: "{}\n",
	}
	if err := u.UploadTrustRequest(srv.URL, "p 1", "tok", body); err != nil {
		t.Fatalf("UploadTrustRequest: %v", err)
	}
	if gotMethod != http.MethodPut {
		t.Errorf("method = %q, want PUT", gotMethod)
	}
	if gotPath != "/projects/p 1/trust-request" {
		t.Errorf("path = %q, want /projects/p 1/trust-request (project id path-escaped on the wire)", gotPath)
	}
	if gotAuth != "Bearer tok" {
		t.Errorf("Authorization = %q, want %q", gotAuth, "Bearer tok")
	}
}

func TestCovonboardHTTPUploader_UnbuildableRequestIsAnError(t *testing.T) {
	body := TrustRequestUpload{TrustRequest: TrustRequestTriple{Repo: "r"}, PrescanReport: "{}"}
	err := httpUploader{}.UploadTrustRequest("https://has a space.example", "p", "tok", body)
	if err == nil {
		t.Fatal("want an error for a --server value that cannot form a URL")
	}
	if !strings.Contains(err.Error(), "build request") {
		t.Errorf("error = %v, want it to name the build-request stage", err)
	}
}

func TestCovonboardEndpointURL(t *testing.T) {
	cases := []struct{ server, projectID, want string }{
		{"https://ccp.example.test", "p1", "https://ccp.example.test/projects/p1/trust-request"},
		{"https://ccp.example.test/", "p1", "https://ccp.example.test/projects/p1/trust-request"},
		{"https://ccp.example.test///", "p1", "https://ccp.example.test/projects/p1/trust-request"},
		{"https://ccp.example.test", "a/b", "https://ccp.example.test/projects/a%2Fb/trust-request"},
	}
	for _, c := range cases {
		if got := endpointURL(c.server, c.projectID); got != c.want {
			t.Errorf("endpointURL(%q, %q) = %q, want %q", c.server, c.projectID, got, c.want)
		}
	}
}

// ── run(): the CLI flag surface ─────────────────────────────────────────────

func TestCovonboardCLI_ArgumentErrorsExitThree(t *testing.T) {
	cases := []struct {
		name    string
		args    []string
		wantErr string
	}{
		{"no arguments at all", nil, "usage: catalogctl onboard <path>"},
		{"flags only, no path", []string{"--project-id", "p"}, "usage: catalogctl onboard <path>"},
		{"unknown flag", []string{"--nope"}, "flag provided but not defined"},
		{"path without --project-id", []string{"/some/path"}, "onboard: --project-id is required"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			var stdout, stderr strings.Builder
			if code := run(c.args, &stdout, &stderr); code != 3 {
				t.Fatalf("exit = %d, want 3 (usage/resolution error)\nstdout=%s\nstderr=%s", code, stdout.String(), stderr.String())
			}
			if !strings.Contains(stderr.String(), c.wantErr) {
				t.Errorf("stderr = %q, want it to contain %q", stderr.String(), c.wantErr)
			}
			if stdout.Len() != 0 {
				t.Errorf("stdout = %q, want nothing written before the arguments are valid", stdout.String())
			}
		})
	}
}

func TestCovonboardCLI_PathAcceptedBeforeAndAfterFlags(t *testing.T) {
	root := covonboardrepo(t, map[string]string{"main.tf": covonboardcleanRepo})
	for _, c := range []struct {
		name string
		args func(out string) []string
	}{
		{"path first", func(out string) []string {
			return []string{root, "--project-id", "p1", "--out", out}
		}},
		{"path last", func(out string) []string {
			return []string{"--project-id", "p1", "--out", out, root}
		}},
	} {
		t.Run(c.name, func(t *testing.T) {
			covonboardclearCI(t)
			covonboardstub(t, covonboardstubs{head: "abc123def456", tfVer: "1.15.7"})
			out := t.TempDir()
			var stdout, stderr strings.Builder
			code := run(c.args(out), &stdout, &stderr)
			if code != 0 {
				t.Fatalf("exit = %d, want 0\nstdout=%s\nstderr=%s", code, stdout.String(), stderr.String())
			}
			if !strings.Contains(stdout.String(), "trust required: wrote trust-request.json") {
				t.Errorf("want the trust-request stop\n%s", stdout.String())
			}
			b, err := os.ReadFile(filepath.Join(out, "trust-request.json"))
			if err != nil {
				t.Fatalf("trust-request.json not written to --out: %v", err)
			}
			var tr map[string]string
			if err := json.Unmarshal(b, &tr); err != nil {
				t.Fatal(err)
			}
			if tr["commitSha"] != "abc123def456" {
				t.Errorf("commitSha = %q, want abc123def456", tr["commitSha"])
			}
		})
	}
}

// --trusted-commit is threaded through from the flag, and a mismatch refuses
// with exit 2 without any terraform invocation (PATH holds no terraform here).
func TestCovonboardCLI_TrustedCommitFlagMismatchRefuses(t *testing.T) {
	covonboardclearCI(t)
	covonboardstub(t, covonboardstubs{head: "abc123def456", tfVer: "1.15.7"})
	root := covonboardrepo(t, map[string]string{"main.tf": covonboardcleanRepo})
	out := t.TempDir()
	var stdout, stderr strings.Builder
	code := run([]string{root, "--project-id", "p1", "--trusted-commit", "0000badcommit", "--out", out}, &stdout, &stderr)
	if code != 2 {
		t.Fatalf("exit = %d, want 2\nstdout=%s", code, stdout.String())
	}
	if !strings.Contains(stdout.String(), "REFUSE UNTRUSTED_COMMIT:") {
		t.Errorf("want an UNTRUSTED_COMMIT refusal\n%s", stdout.String())
	}
	if _, err := os.Stat(filepath.Join(out, "providers-schema.json")); !os.IsNotExist(err) {
		t.Error("no schema may be produced for an untrusted commit")
	}
}

// The bearer credential is read from the environment ONLY — never a flag — and
// rides the --server upload the real httpUploader performs.
func TestCovonboardCLI_ServerUploadUsesEnvToken(t *testing.T) {
	var hits int
	var gotAuth, gotPath string
	var gotBody []byte
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		gotAuth, gotPath = r.Header.Get("Authorization"), r.URL.Path
		gotBody, _ = io.ReadAll(r.Body)
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	covonboardclearCI(t)
	covonboardstub(t, covonboardstubs{head: "abc123def456", tfVer: "1.15.7"})
	t.Setenv(onboardTokenEnv, "tok-from-env")
	root := covonboardrepo(t, map[string]string{"main.tf": covonboardcleanRepo})
	out := t.TempDir()
	var stdout, stderr strings.Builder
	code := run([]string{root, "--project-id", "proj-7", "--out", out, "--server", srv.URL}, &stdout, &stderr)
	if code != 0 {
		t.Fatalf("exit = %d, want 0\nstdout=%s\nstderr=%s", code, stdout.String(), stderr.String())
	}
	if hits != 1 {
		t.Fatalf("server hit %d times, want exactly 1", hits)
	}
	if gotAuth != "Bearer tok-from-env" {
		t.Errorf("Authorization = %q, want the env-supplied token", gotAuth)
	}
	if gotPath != "/projects/proj-7/trust-request" {
		t.Errorf("path = %q", gotPath)
	}
	var body TrustRequestUpload
	if err := json.Unmarshal(gotBody, &body); err != nil {
		t.Fatalf("body not valid JSON: %v", err)
	}
	if body.TrustRequest.CommitSha != "abc123def456" {
		t.Errorf("uploaded commitSha = %q, want abc123def456", body.TrustRequest.CommitSha)
	}
	if body.Ci != nil {
		t.Errorf("body.ci = %+v, want omitted for a local (non-CI) run", body.Ci)
	}
	// The upload is additive: --out still holds both artifacts.
	for _, name := range []string{"trust-request.json", "prescan-report.json"} {
		if _, err := os.Stat(filepath.Join(out, name)); err != nil {
			t.Errorf("%s must still be written to --out: %v", name, err)
		}
	}
	if !strings.Contains(stdout.String(), "uploaded the scan artifacts") {
		t.Errorf("want the upload-success line\n%s", stdout.String())
	}
}

// A --server value with no CCP_ONBOARD_TOKEN in the environment skips the
// upload with an explanatory note and still exits 0.
func TestCovonboardCLI_ServerWithoutEnvTokenSkipsUpload(t *testing.T) {
	covonboardclearCI(t)
	covonboardstub(t, covonboardstubs{head: "abc123def456", tfVer: "1.15.7"})
	t.Setenv(onboardTokenEnv, "")
	root := covonboardrepo(t, map[string]string{"main.tf": covonboardcleanRepo})
	out := t.TempDir()
	var stdout, stderr strings.Builder
	code := run([]string{root, "--project-id", "p1", "--out", out, "--server", "https://ccp.example.test"}, &stdout, &stderr)
	if code != 0 {
		t.Fatalf("exit = %d, want 0\nstdout=%s\nstderr=%s", code, stdout.String(), stderr.String())
	}
	if !strings.Contains(stdout.String(), "--server set but "+onboardTokenEnv+" is not in the environment") {
		t.Errorf("want the missing-token note\n%s", stdout.String())
	}
}

// The command is registered on the cli seam at package init, so `catalogctl
// onboard` dispatches into exactly this run().
func TestCovonboardCLISeamIsWired(t *testing.T) {
	if cli.Onboard == nil {
		t.Fatal("cli.Onboard is nil — the onboard subcommand would not dispatch")
	}
	var stdout, stderr strings.Builder
	if code := cli.Onboard(nil, &stdout, &stderr); code != 3 {
		t.Fatalf("cli.Onboard exit = %d, want 3 (the same usage error run() returns)", code)
	}
	if !strings.Contains(stderr.String(), "usage: catalogctl onboard <path>") {
		t.Errorf("stderr = %q, want the onboard usage line", stderr.String())
	}
}
