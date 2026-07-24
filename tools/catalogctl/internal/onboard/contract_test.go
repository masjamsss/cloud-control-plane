package onboard

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
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

// ── --server upload seam (spec docs/superpowers/specs/2026-07-24-easy-first-
// import.md §3 option C; ADR-0031) ──────────────────────────────────────────
//
// These tests exercise the Uploader seam through the SAME Run() entrypoint
// the CLI uses (fixtures/withStubs/fakeRunner all come from onboard_test.go,
// same package) — never a live server. A dedicated wire-level test below
// additionally proves the real httpUploader builds the exact PUT the api
// expects (path, Bearer header, body shape).

// uploadCall records one Uploader.UploadTrustRequest invocation.
type uploadCall struct {
	server, projectID, token string
	body                     TrustRequestUpload
}

// fakeUploader is the Uploader test double. onCall, if set, runs BEFORE the
// call is recorded — tests use it to assert facts true only "at the moment
// of upload" (e.g. that the on-disk files already exist), which is the
// direct way to prove "strictly after persist" rather than inferring it from
// call order alone.
type fakeUploader struct {
	calls  []uploadCall
	err    error // returned from every call, if set — simulates an upload failure
	onCall func()
}

func (f *fakeUploader) UploadTrustRequest(server, projectID, token string, body TrustRequestUpload) error {
	if f.onCall != nil {
		f.onCall()
	}
	f.calls = append(f.calls, uploadCall{server, projectID, token, body})
	return f.err
}

// (1) No --server / no token ⇒ the Uploader is NEVER called — byte-for-byte
// today's behavior, zero network activity.
func TestUpload_ZeroCallsWithoutServerOrToken(t *testing.T) {
	cases := []struct{ name, server, token string }{
		{"neither set", "", ""},
		{"server set, token missing from env", "https://ccp.example.test", ""},
		{"token set, server missing", "", "tok"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			withStubs(t, "abc123def456", "1.15.7", nil)
			dir := t.TempDir()
			fu := &fakeUploader{}
			var out bytes.Buffer
			code := Run(Opts{
				Root: filepath.Join(fixtures, "clean-repo"), ProjectID: "p1", OutDir: dir,
				Server: c.server, OnboardToken: c.token,
			}, &fakeRunner{}, fu, &out)
			if code != 0 {
				t.Fatalf("exit = %d, want 0\n%s", code, out.String())
			}
			if len(fu.calls) != 0 {
				t.Fatalf("upload calls = %d, want 0 (server=%q token=%q)", len(fu.calls), c.server, c.token)
			}
		})
	}
}

// (2) The upload happens STRICTLY AFTER the relevant file(s) are already
// persisted to --out — checked by statting the files from inside the fake's
// onCall hook, i.e. at the exact instant Run() invokes the uploader.
func TestUpload_StrictlyAfterPersist(t *testing.T) {
	t.Run("clean untrusted stop: both files exist at call time", func(t *testing.T) {
		withStubs(t, "abc123def456", "1.15.7", nil)
		dir := t.TempDir()
		var trustReqSeen, prescanSeen bool
		fu := &fakeUploader{onCall: func() {
			_, err1 := os.Stat(filepath.Join(dir, "trust-request.json"))
			_, err2 := os.Stat(filepath.Join(dir, "prescan-report.json"))
			trustReqSeen, prescanSeen = err1 == nil, err2 == nil
		}}
		var out bytes.Buffer
		code := Run(Opts{
			Root: filepath.Join(fixtures, "clean-repo"), ProjectID: "p1", OutDir: dir,
			Server: "https://ccp.example.test", OnboardToken: "tok",
		}, &fakeRunner{}, fu, &out)
		if code != 0 {
			t.Fatalf("exit = %d, want 0\n%s", code, out.String())
		}
		if len(fu.calls) != 1 {
			t.Fatalf("upload calls = %d, want 1", len(fu.calls))
		}
		if !trustReqSeen || !prescanSeen {
			t.Errorf("upload fired before persist: trust-request.json on disk=%v prescan-report.json on disk=%v", trustReqSeen, prescanSeen)
		}
	})

	t.Run("reject: prescan-report.json exists at call time (trust-request.json is never written for a reject)", func(t *testing.T) {
		withStubs(t, "deadbeefdeadbeef", "1.15.7", nil)
		dir := t.TempDir()
		var prescanSeen bool
		fu := &fakeUploader{onCall: func() {
			_, err := os.Stat(filepath.Join(dir, "prescan-report.json"))
			prescanSeen = err == nil
		}}
		var out bytes.Buffer
		code := Run(Opts{
			Root: filepath.Join(fixtures, "malicious-provisioner"), ProjectID: "p1", OutDir: dir,
			Server: "https://ccp.example.test", OnboardToken: "tok",
		}, &fakeRunner{}, fu, &out)
		if code != 2 {
			t.Fatalf("exit = %d, want 2\n%s", code, out.String())
		}
		if len(fu.calls) != 1 {
			t.Fatalf("upload calls = %d, want 1", len(fu.calls))
		}
		if !prescanSeen {
			t.Error("upload fired before prescan-report.json was persisted")
		}
	})
}

// (3) Upload is attempted on BOTH verdicts — clean (untrusted stop) and
// reject — with the uploaded prescanReport bytes carrying the matching
// verdict; and it is NOT attempted a third time on a fully-trusted run
// (init+schema), which has no new trust-request to send at all (F2: the spec
// is explicit that only the two named branches — onboard.go's clean-stop and
// reject paths — ever call attemptUpload).
func TestUpload_AttemptedOnBothVerdicts(t *testing.T) {
	t.Run("clean, untrusted stop", func(t *testing.T) {
		withStubs(t, "abc123def456", "1.15.7", nil)
		dir := t.TempDir()
		fu := &fakeUploader{}
		var out bytes.Buffer
		code := Run(Opts{
			Root: filepath.Join(fixtures, "clean-repo"), ProjectID: "p1", OutDir: dir,
			Server: "https://ccp.example.test", OnboardToken: "tok",
		}, &fakeRunner{}, fu, &out)
		if code != 0 {
			t.Fatalf("exit = %d, want 0\n%s", code, out.String())
		}
		if len(fu.calls) != 1 {
			t.Fatalf("upload calls = %d, want 1", len(fu.calls))
		}
		var rep map[string]any
		if err := json.Unmarshal([]byte(fu.calls[0].body.PrescanReport), &rep); err != nil {
			t.Fatalf("uploaded prescanReport is not valid JSON: %v", err)
		}
		if rep["verdict"] != "clean" {
			t.Errorf("uploaded prescanReport verdict = %v, want clean", rep["verdict"])
		}
		if !strings.Contains(out.String(), "wizard step ③") {
			t.Errorf("success message should point at the next wizard step\n%s", out.String())
		}
	})

	t.Run("reject", func(t *testing.T) {
		withStubs(t, "deadbeefdeadbeef", "1.15.7", nil)
		dir := t.TempDir()
		fu := &fakeUploader{}
		var out bytes.Buffer
		code := Run(Opts{
			Root: filepath.Join(fixtures, "malicious-provisioner"), ProjectID: "p1", OutDir: dir,
			Server: "https://ccp.example.test", OnboardToken: "tok",
		}, &fakeRunner{}, fu, &out)
		if code != 2 {
			t.Fatalf("exit = %d, want 2\n%s", code, out.String())
		}
		if len(fu.calls) != 1 {
			t.Fatalf("upload calls = %d, want 1", len(fu.calls))
		}
		var rep map[string]any
		if err := json.Unmarshal([]byte(fu.calls[0].body.PrescanReport), &rep); err != nil {
			t.Fatalf("uploaded prescanReport is not valid JSON: %v", err)
		}
		if rep["verdict"] != "reject" {
			t.Errorf("uploaded prescanReport verdict = %v, want reject", rep["verdict"])
		}
	})

	t.Run("fully trusted run (init+schema) uploads nothing new", func(t *testing.T) {
		withStubs(t, "abc123def456", "1.15.7", nil)
		dir := t.TempDir()
		fu := &fakeUploader{}
		var out bytes.Buffer
		code := Run(Opts{
			Root: filepath.Join(fixtures, "clean-repo"), ProjectID: "p1", OutDir: dir,
			TrustedCommit: "abc123def456",
			Server:        "https://ccp.example.test", OnboardToken: "tok",
		}, &fakeRunner{schema: []byte(`{"format_version":"1.0","provider_schemas":{}}`)}, fu, &out)
		if code != 0 {
			t.Fatalf("exit = %d, want 0\n%s", code, out.String())
		}
		if len(fu.calls) != 0 {
			t.Fatalf("upload calls = %d, want 0 — the trusted run writes no trust-request.json to send", len(fu.calls))
		}
	})
}

// (4) An upload error (simulated: unreachable or a non-2xx response, treated
// identically) leaves the already-written files untouched and does not
// change Run's exit code — the scan itself still succeeded/refused on its
// own terms, exactly as if --server had never been passed.
func TestUpload_ErrorLeavesFilesAndExitCodeUnchanged(t *testing.T) {
	uploadErr := errors.New("simulated: connection refused")

	t.Run("clean-stop", func(t *testing.T) {
		withStubs(t, "abc123def456", "1.15.7", nil)
		dir := t.TempDir()
		fu := &fakeUploader{err: uploadErr}
		var out bytes.Buffer
		code := Run(Opts{
			Root: filepath.Join(fixtures, "clean-repo"), ProjectID: "p1", OutDir: dir,
			Server: "https://ccp.example.test", OnboardToken: "tok",
		}, &fakeRunner{}, fu, &out)
		if code != 0 {
			t.Fatalf("exit = %d, want 0 (same as an unconfigured --server run)\n%s", code, out.String())
		}
		if len(fu.calls) != 1 {
			t.Fatalf("upload calls = %d, want 1 (attempted once, then failed)", len(fu.calls))
		}
		for _, name := range []string{"trust-request.json", "prescan-report.json"} {
			b, err := os.ReadFile(filepath.Join(dir, name))
			if err != nil {
				t.Fatalf("%s missing after a failed upload: %v", name, err)
			}
			if len(b) == 0 {
				t.Errorf("%s is empty after a failed upload", name)
			}
		}
		if !strings.Contains(out.String(), "paste them by hand") {
			t.Errorf("want the manual-fallback instruction printed on upload failure\n%s", out.String())
		}
	})

	t.Run("reject", func(t *testing.T) {
		withStubs(t, "deadbeefdeadbeef", "1.15.7", nil)
		dir := t.TempDir()
		fu := &fakeUploader{err: uploadErr}
		var out bytes.Buffer
		code := Run(Opts{
			Root: filepath.Join(fixtures, "malicious-provisioner"), ProjectID: "p1", OutDir: dir,
			Server: "https://ccp.example.test", OnboardToken: "tok",
		}, &fakeRunner{}, fu, &out)
		if code != 2 {
			t.Fatalf("exit = %d, want 2 (same as an unconfigured --server run)\n%s", code, out.String())
		}
		if len(fu.calls) != 1 {
			t.Fatalf("upload calls = %d, want 1 (attempted once, then failed)", len(fu.calls))
		}
		b, err := os.ReadFile(filepath.Join(dir, "prescan-report.json"))
		if err != nil {
			t.Fatalf("prescan-report.json missing after a failed upload: %v", err)
		}
		if len(b) == 0 {
			t.Error("prescan-report.json is empty after a failed upload")
		}
		if _, err := os.Stat(filepath.Join(dir, "trust-request.json")); !os.IsNotExist(err) {
			t.Error("trust-request.json must still not exist for a rejected repo, upload error or not")
		}
	})
}

// (5) The REAL Uploader (httpUploader, net/http) PUTs to the exact path with
// the exact Bearer header and a body carrying ONLY {trustRequest,
// prescanReport} — the api's additionalProperties:false requestBody schema
// (ccp/api/openapi/ccp-api.yaml:681-686) — nothing else. This is a
// wire-level check independent of the fakeUploader tests above, so it also
// guards httpUploader itself, not just Run()'s use of the seam.
func TestHTTPUploader_PUTsExactPathHeaderAndBody(t *testing.T) {
	var (
		hits                    int
		gotMethod, gotPath      string
		gotAuth, gotContentType string
		gotBody                 []byte
	)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		gotMethod, gotPath = r.Method, r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		gotContentType = r.Header.Get("Content-Type")
		b, _ := io.ReadAll(r.Body)
		gotBody = b
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"id":"p1","status":"pending-trust"}`))
	}))
	defer srv.Close()

	want := TrustRequestUpload{
		TrustRequest:  TrustRequestTriple{Repo: "example-repo", CommitSha: "abc123def456", PrescanSha256: strings.Repeat("a", 64)},
		PrescanReport: `{"repo":"example-repo","verdict":"clean","findings":[]}` + "\n",
	}
	if err := (httpUploader{}).UploadTrustRequest(srv.URL, "p1", "sekret-token", want); err != nil {
		t.Fatalf("UploadTrustRequest: %v", err)
	}

	if hits != 1 {
		t.Fatalf("server hit %d times, want exactly 1", hits)
	}
	if gotMethod != http.MethodPut {
		t.Errorf("method = %q, want PUT", gotMethod)
	}
	if gotPath != "/projects/p1/trust-request" {
		t.Errorf("path = %q, want /projects/p1/trust-request", gotPath)
	}
	if gotAuth != "Bearer sekret-token" {
		t.Errorf("Authorization = %q, want %q", gotAuth, "Bearer sekret-token")
	}
	if gotContentType != "application/json" {
		t.Errorf("Content-Type = %q, want application/json", gotContentType)
	}

	var sent TrustRequestUpload
	if err := json.Unmarshal(gotBody, &sent); err != nil {
		t.Fatalf("body not valid JSON: %v", err)
	}
	if sent != want {
		t.Errorf("uploaded body = %+v, want %+v", sent, want)
	}
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(gotBody, &raw); err != nil {
		t.Fatalf("body not valid JSON: %v", err)
	}
	if len(raw) != 2 {
		t.Errorf("body has %d top-level key(s), want exactly 2 (trustRequest, prescanReport): %v", len(raw), raw)
	}
	if _, ok := raw["trustRequest"]; !ok {
		t.Error("body missing trustRequest")
	}
	if _, ok := raw["prescanReport"]; !ok {
		t.Error("body missing prescanReport")
	}
}

// A non-2xx response is a real failure — the caller-visible error message
// names the status, mirroring the reachability-vs-HTTP-error split
// scripts/gen-project-data.sh documents (both fold to the same "leave files,
// don't touch the exit code" handling in attemptUpload; this test pins only
// that httpUploader itself surfaces a non-nil error either way).
func TestHTTPUploader_NonSuccessStatusIsAnError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"code":"E401","reason":"bad token"}`))
	}))
	defer srv.Close()

	body := TrustRequestUpload{TrustRequest: TrustRequestTriple{Repo: "r", CommitSha: "c", PrescanSha256: strings.Repeat("a", 64)}, PrescanReport: "{}"}
	err := (httpUploader{}).UploadTrustRequest(srv.URL, "p1", "bad-token", body)
	if err == nil {
		t.Fatal("want a non-nil error for a 401 response")
	}
	if !strings.Contains(err.Error(), "401") {
		t.Errorf("error should name the status: %v", err)
	}
}

func TestHTTPUploader_UnreachableServerIsAnError(t *testing.T) {
	// A closed listener: connections to it fail immediately (connection
	// refused) — the "unreachable" half of the reachability-vs-HTTP-error
	// split, exercised without any real network dependency.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	url := srv.URL
	srv.Close()

	body := TrustRequestUpload{TrustRequest: TrustRequestTriple{Repo: "r", CommitSha: "c", PrescanSha256: strings.Repeat("a", 64)}, PrescanReport: "{}"}
	if err := (httpUploader{}).UploadTrustRequest(url, "p1", "tok", body); err == nil {
		t.Fatal("want a non-nil error when the server is unreachable")
	}
}
