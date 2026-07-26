package scanworker

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

/*
The scan-worker is the one process that handles hostile input, so these tests
are about REFUSALS and ORDER rather than happy paths:

  - every job reaches a terminal status, including the ones that fail early —
    a job the worker silently abandons is a job the operator watches spin;
  - a reject verdict is a SUCCESSFUL scan (its findings are the deliverable),
    not a failed one;
  - the worker refuses a target the server should never have sent;
  - it refuses to start holding a cloud credential;
  - the clone's hardening flags are present, since the flags ARE the security
    property;
  - and neither credential ever appears in what the worker says or writes.
*/

/* ── fakes ─────────────────────────────────────────────────────────────────── */

type step struct {
	status string
	reason string
}

type fakeControl struct {
	jobs      []*Job // handed out in order; exhausted ⇒ nil (nothing queued)
	claims    int
	steps     []step
	claimErr  error
	reportErr error
}

func (f *fakeControl) Claim(context.Context) (*Job, error) {
	if f.claimErr != nil {
		return nil, f.claimErr
	}
	f.claims++
	if len(f.jobs) == 0 {
		return nil, nil
	}
	j := f.jobs[0]
	f.jobs = f.jobs[1:]
	return j, nil
}

func (f *fakeControl) Report(_ context.Context, _ *Job, status, reason string) error {
	f.steps = append(f.steps, step{status, reason})
	return f.reportErr
}

func (f *fakeControl) statuses() []string {
	out := make([]string, len(f.steps))
	for i, s := range f.steps {
		out[i] = s.status
	}
	return out
}

type fakeCloner struct {
	err     error
	gotURL  string
	gotDest string
	gotAuth string
}

func (f *fakeCloner) Clone(_ context.Context, cloneURL, dest, authHeader string) error {
	f.gotURL, f.gotDest, f.gotAuth = cloneURL, dest, authHeader
	if f.err != nil {
		return f.err
	}
	return os.MkdirAll(dest, 0o700)
}

type fakeScanner struct {
	uploaded bool
	err      error
	sawToken string
	sawDir   string
}

func (f *fakeScanner) ScanAndUpload(job *Job, repoDir, _, _ string, _ io.Writer) (bool, error) {
	f.sawToken, f.sawDir = job.OnboardToken, repoDir
	return f.uploaded, f.err
}

func job(id string) *Job {
	return &Job{
		JobID:        id,
		ProjectID:    "acme",
		CloneURL:     "https://github.com/example-org/terraform-example.git",
		OnboardToken: "01ARZ3NDEKTSV4RRFFQ69G5FAV.s3cr3t-secret-value-here-okay",
	}
}

// runOnce drives exactly one poll with the given fakes. Preflight is skipped by
// the caller arranging a clean environment; see TestPreflight for its own cases.
func runOnce(t *testing.T, ctrl Control, cloner Cloner, scanner Scanner) string {
	t.Helper()
	var out strings.Builder
	opts := Opts{Server: "https://ccp.example", WorkDir: t.TempDir(), Once: true}
	if err := Run(context.Background(), opts, ctrl, cloner, scanner, &out); err != nil {
		t.Fatalf("Run: %v", err)
	}
	return out.String()
}

// requireCleanEnv makes the test hermetic instead of host-dependent. A dev
// machine (and this repo's own CI runner) legitimately has AWS_* exported, which
// is exactly what Preflight refuses — so every var Preflight looks at is removed
// for the duration of the test and restored afterwards. Skipping on a dirty host
// instead would mean these tests quietly never run where it matters most.
func requireCleanEnv(t *testing.T) {
	t.Helper()
	for _, kv := range os.Environ() {
		name, _, _ := strings.Cut(kv, "=")
		for _, pfx := range []string{"AWS_", "GOOGLE_", "ARM_", "TF_TOKEN_"} {
			if strings.HasPrefix(name, pfx) {
				t.Setenv(name, "") // registers the restore…
				os.Unsetenv(name)  // …then actually removes it, since an EMPTY
				// value still counts: assertNoCloudCreds matches on the NAME.
			}
		}
	}
	if err := Preflight(); err != nil {
		t.Fatalf("test env is still not clean: %v", err)
	}
}

/* ── the lifecycle ─────────────────────────────────────────────────────────── */

func TestJobWalksToUploaded(t *testing.T) {
	requireCleanEnv(t)
	ctrl := &fakeControl{jobs: []*Job{job("J1")}}
	cloner := &fakeCloner{}
	scanner := &fakeScanner{uploaded: true}

	runOnce(t, ctrl, cloner, scanner)

	want := []string{"cloning", "scanning", "uploaded"}
	if got := ctrl.statuses(); !equal(got, want) {
		t.Fatalf("statuses = %v, want %v", got, want)
	}
	// The worker cloned exactly the URL the server handed it — it has no other
	// source for a target.
	if cloner.gotURL != "https://github.com/example-org/terraform-example.git" {
		t.Fatalf("cloned %q", cloner.gotURL)
	}
	// …into the throwaway workspace, and the scanner got that same checkout.
	if scanner.sawDir != cloner.gotDest {
		t.Fatalf("scanner saw %q, cloner wrote %q", scanner.sawDir, cloner.gotDest)
	}
	if scanner.sawToken != job("J1").OnboardToken {
		t.Fatalf("the per-job token did not reach the uploader")
	}
}

func TestRejectVerdictIsAnUploadedJobNotAFailure(t *testing.T) {
	requireCleanEnv(t)
	// A reject verdict still UPLOADS (onboard.Run uploads on both verdicts) —
	// the findings are exactly what the reviewing admins need. The worker must
	// not relabel that as a failed scan.
	ctrl := &fakeControl{jobs: []*Job{job("J1")}}
	runOnce(t, ctrl, &fakeCloner{}, &fakeScanner{uploaded: true})
	if last := ctrl.statuses()[len(ctrl.statuses())-1]; last != "uploaded" {
		t.Fatalf("last status = %q, want uploaded", last)
	}
}

func TestCloneFailureIsReportedTerminal(t *testing.T) {
	requireCleanEnv(t)
	ctrl := &fakeControl{jobs: []*Job{job("J1")}}
	runOnce(t, ctrl, &fakeCloner{err: errors.New("repository not found")}, &fakeScanner{})

	want := []string{"cloning", "failed"}
	if got := ctrl.statuses(); !equal(got, want) {
		t.Fatalf("statuses = %v, want %v", got, want)
	}
	if !strings.Contains(ctrl.steps[1].reason, "repository not found") {
		t.Fatalf("failure reason lost git's message: %q", ctrl.steps[1].reason)
	}
}

func TestUploadFailureIsAFailedJob(t *testing.T) {
	requireCleanEnv(t)
	// The worker has NOTHING on disk to fall back to (unlike a local run, whose
	// operator still has the files), so an upload that did not land is the
	// whole job failing.
	ctrl := &fakeControl{jobs: []*Job{job("J1")}}
	runOnce(t, ctrl, &fakeCloner{}, &fakeScanner{uploaded: false, err: errors.New("server responded 401")})

	want := []string{"cloning", "scanning", "failed"}
	if got := ctrl.statuses(); !equal(got, want) {
		t.Fatalf("statuses = %v, want %v", got, want)
	}
}

func TestRefusesATargetTheServerShouldNeverHaveSent(t *testing.T) {
	requireCleanEnv(t)
	// A compromised or buggy control plane must not be able to aim the worker
	// at anything but plain https on a real host. Each of these fails BEFORE a
	// clone is attempted, and each is still reported terminal.
	for _, bad := range []string{
		"http://github.com/o/r.git",           // downgraded scheme
		"file:///etc/passwd",                  // local file
		"ssh://git@example.com/o/r.git",       // another transport
		"https://user:pw@example.com/o/r.git", // embedded credentials
		"https://github.com:2222/o/r.git",     // explicit port
		"ext::sh -c 'id'",                     // git's command transport
		"https:///no-host",                    // no host
	} {
		ctrl := &fakeControl{jobs: []*Job{{JobID: "J1", ProjectID: "acme", CloneURL: bad, OnboardToken: "t.t"}}}
		cloner := &fakeCloner{}
		runOnce(t, ctrl, cloner, &fakeScanner{uploaded: true})

		if got := ctrl.statuses(); !equal(got, []string{"failed"}) {
			t.Fatalf("%s: statuses = %v, want [failed]", bad, got)
		}
		if cloner.gotURL != "" {
			t.Fatalf("%s: the worker cloned it anyway", bad)
		}
	}
}

func TestNothingFromAnUntrustedRepoOutlivesTheJob(t *testing.T) {
	requireCleanEnv(t)
	workDir := t.TempDir()
	ctrl := &fakeControl{jobs: []*Job{job("J1")}}
	scanner := &fakeScanner{uploaded: true}
	cloner := &fakeCloner{}
	var out strings.Builder
	if err := Run(context.Background(), Opts{Server: "https://ccp.example", WorkDir: workDir, Once: true},
		ctrl, cloner, scanner, &out); err != nil {
		t.Fatal(err)
	}
	kept := scanner.sawDir
	if kept == "" {
		t.Fatal("no checkout dir observed")
	}
	if _, err := os.Stat(kept); !os.IsNotExist(err) {
		t.Fatalf("the checkout survived the job: %s", kept)
	}
	// …and the workspace parent is empty again.
	entries, _ := os.ReadDir(workDir)
	if len(entries) != 0 {
		t.Fatalf("workspace left %d entries behind", len(entries))
	}
}

func TestOneBadRepositoryDoesNotStopTheWorker(t *testing.T) {
	requireCleanEnv(t)
	// Two jobs, the first unclonable. The loop must report it and go on to the
	// second rather than returning an error and taking the scanner down.
	ctrl := &fakeControl{jobs: []*Job{job("J1"), job("J2")}}
	failing := &fakeCloner{err: errors.New("boom")}
	var out strings.Builder
	opts := Opts{Server: "https://ccp.example", WorkDir: t.TempDir(), Poll: time.Millisecond}
	ctx, cancel := context.WithCancel(context.Background())
	// Stop once the queue has drained (the third claim returns nothing).
	go func() {
		for ctrl.claims < 3 {
			time.Sleep(time.Millisecond)
		}
		cancel()
	}()
	if err := Run(ctx, opts, ctrl, failing, &fakeScanner{}, &out); err != nil {
		t.Fatalf("Run returned an error for a per-job failure: %v", err)
	}
	if got := ctrl.statuses(); !equal(got, []string{"cloning", "failed", "cloning", "failed"}) {
		t.Fatalf("statuses = %v", got)
	}
}

func TestAnIdlePollSaysSoAndClaimsNothing(t *testing.T) {
	requireCleanEnv(t)
	ctrl := &fakeControl{}
	out := runOnce(t, ctrl, &fakeCloner{}, &fakeScanner{})
	if len(ctrl.steps) != 0 {
		t.Fatalf("an idle poll reported %v", ctrl.steps)
	}
	if !strings.Contains(out, "no scan jobs queued") {
		t.Fatalf("idle output = %q", out)
	}
}

func TestAnUnreachableControlPlaneStopsTheWorker(t *testing.T) {
	requireCleanEnv(t)
	// Unlike a per-job failure, this one IS fatal: a worker that cannot claim
	// has nothing useful to do, and silently spinning would hide the outage.
	ctrl := &fakeControl{claimErr: errors.New("connection refused")}
	var out strings.Builder
	err := Run(context.Background(), Opts{Server: "https://ccp.example", Once: true}, ctrl, &fakeCloner{}, &fakeScanner{}, &out)
	if err == nil || !strings.Contains(err.Error(), "connection refused") {
		t.Fatalf("err = %v", err)
	}
}

/* ── startup refusals ──────────────────────────────────────────────────────── */

func TestPreflightRefusesACloudCredential(t *testing.T) {
	requireCleanEnv(t)
	t.Setenv("AWS_ACCESS_KEY_ID", "AKIAIOSFODNN7EXAMPLE")
	err := Preflight()
	if err == nil {
		t.Fatal("preflight allowed a cloud credential")
	}
	var pf *PreflightError
	if !errors.As(err, &pf) {
		t.Fatalf("want a PreflightError (so the CLI exits 2), got %T", err)
	}
	if !strings.Contains(err.Error(), "AWS_ACCESS_KEY_ID") {
		t.Fatalf("err = %v", err)
	}
}

func TestPreflightRefusesTerraformOnPath(t *testing.T) {
	requireCleanEnv(t)
	dir := t.TempDir()
	fake := filepath.Join(dir, "terraform")
	if err := os.WriteFile(fake, []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir)
	err := Preflight()
	if err == nil {
		t.Fatal("preflight allowed a terraform on PATH")
	}
	if !strings.Contains(err.Error(), "terraform is on PATH") {
		t.Fatalf("err = %v", err)
	}
}

func TestRunRefusesBeforeClaimingAnything(t *testing.T) {
	requireCleanEnv(t)
	t.Setenv("AWS_SECRET_ACCESS_KEY", "x")
	ctrl := &fakeControl{jobs: []*Job{job("J1")}}
	err := Run(context.Background(), Opts{Server: "https://ccp.example", Once: true}, ctrl, &fakeCloner{}, &fakeScanner{}, io.Discard)
	if err == nil {
		t.Fatal("Run started with a cloud credential present")
	}
	if ctrl.claims != 0 {
		t.Fatal("Run claimed work before refusing")
	}
}

/* ── the clone's hardening is the security property, so pin the argv ───────── */

func TestCloneArgvKeepsEveryHardeningFlag(t *testing.T) {
	argv := strings.Join(cloneArgs("https://github.com/o/r.git", "/w/repo"), " ")
	for _, want := range []string{
		"protocol.allow=never", // no transport but the one allowed below
		"protocol.https.allow=always",
		"credential.helper=",       // never consult a credential store
		"core.askPass=",            // never prompt
		"core.symlinks=false",      // a symlink cannot point outside the checkout
		"core.hooksPath=/dev/null", // no repo-supplied hook can run
		"submodule.recurse=false",  // attacker-controlled submodule URLs are never dialled
		"--depth 1",
		"--single-branch",
		"--no-tags",
		"--no-recurse-submodules",
		"-- https://github.com/o/r.git /w/repo", // the URL is after `--`, never parsed as a flag
	} {
		if !strings.Contains(argv, want) {
			t.Errorf("clone argv lost %q\n  argv: %s", want, argv)
		}
	}
}

func TestPrivateRepoCredentialReachesTheCloner(t *testing.T) {
	requireCleanEnv(t)
	j := job("J1")
	j.CloneAuthHeader = "Basic eC1hY2Nlc3MtdG9rZW46Z2hzX2V4YW1wbGU="
	ctrl := &fakeControl{jobs: []*Job{j}}
	cloner := &fakeCloner{}
	runOnce(t, ctrl, cloner, &fakeScanner{uploaded: true})
	if cloner.gotAuth != j.CloneAuthHeader {
		t.Fatalf("cloner got auth %q", cloner.gotAuth)
	}
}

func TestPublicRepoGetsNoCredentialAtAll(t *testing.T) {
	requireCleanEnv(t)
	// The empty case is the one that must stay empty: a public clone with a
	// stray header would send a credential to a host that never needed one.
	ctrl := &fakeControl{jobs: []*Job{job("J1")}}
	cloner := &fakeCloner{}
	runOnce(t, ctrl, cloner, &fakeScanner{uploaded: true})
	if cloner.gotAuth != "" {
		t.Fatalf("a public clone carried auth %q", cloner.gotAuth)
	}
}

func TestCredentialRidesTheEnvironmentNeverArgvOrTheURL(t *testing.T) {
	// The whole point of the env-config mechanism. A credential in argv is
	// readable through `ps`; a credential in the URL is written into
	// .git/config and echoed in git's error text.
	const header = "Basic eC1hY2Nlc3MtdG9rZW46Z2hzX3NlY3JldA=="
	url := "https://github.com/o/r.git"

	argv := strings.Join(cloneArgs(url, "/w/repo"), " ")
	if strings.Contains(argv, header) || strings.Contains(argv, "extraHeader") {
		t.Fatalf("the credential (or its config key) reached argv: %s", argv)
	}
	if strings.Contains(argv, "@") {
		t.Fatalf("argv carries userinfo — the credential must not be in the URL: %s", argv)
	}

	env := cloneEnv("/w/home", url, header)
	if !contains(env, "GIT_CONFIG_COUNT=1") {
		t.Error("git was not told to read config from the environment")
	}
	// Scoped to the exact clone URL, so a redirect elsewhere cannot replay it.
	if !contains(env, "GIT_CONFIG_KEY_0=http."+url+".extraHeader") {
		t.Errorf("the header key is not scoped to the clone URL: %v", env)
	}
	if !contains(env, "GIT_CONFIG_VALUE_0=Authorization: "+header) {
		t.Errorf("the header value did not reach git: %v", env)
	}
}

func TestNoCredentialMeansNoGitConfigAtAll(t *testing.T) {
	// Not "an empty header" — no config entries whatsoever, so a public clone
	// is byte-for-byte what it was before private repos were supported.
	for _, kv := range cloneEnv("/w/home", "https://github.com/o/r.git", "") {
		if strings.HasPrefix(kv, "GIT_CONFIG_") && kv != "GIT_CONFIG_NOSYSTEM=1" {
			t.Fatalf("public clone set %q", kv)
		}
	}
}

func TestCloneEnvIsAnAllowlistNotAnInheritance(t *testing.T) {
	// The worker's own scanner key must be invisible to git and to anything git
	// might run. The env is REBUILT, so a leak here means someone switched to
	// appending onto os.Environ().
	t.Setenv(ScannerKeyEnv, "super-secret-scanner-key-value-0123456789")
	t.Setenv("AWS_ACCESS_KEY_ID", "AKIAIOSFODNN7EXAMPLE")
	env := cloneEnv("/w/home", "https://github.com/o/r.git", "")
	for _, kv := range env {
		if strings.Contains(kv, "super-secret") || strings.HasPrefix(kv, "AWS_") {
			t.Fatalf("clone env leaked %q", kv)
		}
	}
	for _, want := range []string{"GIT_CONFIG_NOSYSTEM=1", "GIT_TERMINAL_PROMPT=0", "HOME=/w/home", "XDG_CONFIG_HOME=/w/home"} {
		if !contains(env, want) {
			t.Errorf("clone env lost %q", want)
		}
	}
}

/* ── the HTTP client against a real (test) server ──────────────────────────── */

func TestHTTPControlClaimAndReport(t *testing.T) {
	var gotAuth, gotPath, gotBody string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth, gotPath = r.Header.Get("Authorization"), r.URL.Path
		b, _ := io.ReadAll(r.Body)
		gotBody = string(b)
		if r.URL.Path == "/scan-jobs/claim" {
			_ = json.NewEncoder(w).Encode(Job{
				JobID: "J1", ProjectID: "acme",
				CloneURL: "https://github.com/o/r.git", OnboardToken: "t.s",
			})
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"jobId":"J1","status":"cloning"}`))
	}))
	defer srv.Close()

	c := NewHTTPControl(srv.URL, "the-shared-scanner-key-0123456789012345")
	got, err := c.Claim(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if got.JobID != "J1" || got.CloneURL != "https://github.com/o/r.git" {
		t.Fatalf("job = %+v", got)
	}
	if gotAuth != "Bearer the-shared-scanner-key-0123456789012345" {
		t.Fatalf("auth = %q", gotAuth)
	}

	if err := c.Report(context.Background(), got, "failed", "clone failed"); err != nil {
		t.Fatal(err)
	}
	if gotPath != "/scan-jobs/J1/status" {
		t.Fatalf("path = %q", gotPath)
	}
	if !strings.Contains(gotBody, `"projectId":"acme"`) || !strings.Contains(gotBody, `"error":"clone failed"`) {
		t.Fatalf("body = %s", gotBody)
	}
}

func TestHTTPControlTreats204AsIdleNotAnError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	defer srv.Close()
	job, err := NewHTTPControl(srv.URL, "k").Claim(context.Background())
	if err != nil || job != nil {
		t.Fatalf("job=%v err=%v — 204 must be an idle result", job, err)
	}
}

func TestHTTPControlRefusesAnIncompleteClaim(t *testing.T) {
	// A truncated or malformed work packet must not be half-executed: no
	// clone URL means no job, not a clone of "".
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"jobId":"J1","projectId":"acme"}`))
	}))
	defer srv.Close()
	if _, err := NewHTTPControl(srv.URL, "k").Claim(context.Background()); err == nil {
		t.Fatal("accepted a claim response with no clone URL or token")
	}
}

func TestHTTPControlDoesNotEchoTheKeyOnAnError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"code":"SCANNER_KEY_INVALID","reason":"The scanner worker key is missing or wrong."}`))
	}))
	defer srv.Close()
	key := "super-secret-scanner-key-value-0123456789"
	_, err := NewHTTPControl(srv.URL, key).Claim(context.Background())
	if err == nil {
		t.Fatal("a 401 claim should be an error")
	}
	if strings.Contains(err.Error(), key) {
		t.Fatalf("the error echoed the key: %v", err)
	}
	if !strings.Contains(err.Error(), "SCANNER_KEY_INVALID") {
		t.Fatalf("the error dropped the server's own code: %v", err)
	}
}

/* ── helpers ───────────────────────────────────────────────────────────────── */

func equal(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func contains(hay []string, needle string) bool {
	for _, h := range hay {
		if h == needle {
			return true
		}
	}
	return false
}
