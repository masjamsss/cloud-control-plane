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
	"sync"
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

// fakeControl is driven from the goroutine running Run AND, in the
// drain-the-queue tests, read from a watchdog goroutine waiting for the queue
// to empty. Every mutable field is therefore behind mu, and the counters are
// reached through accessors rather than read directly — an unsynchronised
// `ctrl.claims` read is a data race the -race detector fails on.
type fakeControl struct {
	mu       sync.Mutex
	jobs     []*Job // handed out in order; exhausted ⇒ nil (nothing queued)
	claims   int
	attempts int // EVERY Claim() call, success or error — claims counts only the non-error path, unchanged from before
	steps    []step
	claimErr error
	// claimFailures caps how many LEADING Claim attempts return claimErr
	// before the fake starts behaving normally — 0 (with claimErr set) means
	// "every attempt fails forever", the shape
	// TestAnUnreachableControlPlaneStopsTheWorker already relies on. A
	// positive value simulates a TRANSIENT outage that recovers after that
	// many attempts (ERR-15 / OPS-12's retry-with-backoff).
	claimFailures int
	reportErr     error
	// failReportStatuses, non-nil, makes Report fail ONLY for a status in this
	// set rather than every call — proves a best-effort terminal "failed"
	// report still gets through after a "cloning"/"scanning" report failed
	// (ERR-15). nil preserves the old "reportErr applies to every call" shape.
	failReportStatuses map[string]bool
}

func (f *fakeControl) Claim(context.Context) (*Job, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.attempts++
	if f.claimErr != nil && (f.claimFailures == 0 || f.attempts <= f.claimFailures) {
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

// attemptCount reports every Claim() call, error or not — claimCount below
// only counts the non-error path, which is what a test racing a retry loop
// against the fake's OWN internal state needs.
func (f *fakeControl) attemptCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.attempts
}

func (f *fakeControl) Report(_ context.Context, _ *Job, status, reason string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.steps = append(f.steps, step{status, reason})
	if f.failReportStatuses != nil && !f.failReportStatuses[status] {
		return nil
	}
	return f.reportErr
}

func (f *fakeControl) statuses() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]string, len(f.steps))
	for i, s := range f.steps {
		out[i] = s.status
	}
	return out
}

// claimCount reports how many times Claim has been called. Safe to call while
// Run is still going, which is exactly what the watchdog goroutines need.
func (f *fakeControl) claimCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.claims
}

// stepAt returns the recorded step at i, or a zero step when the worker never
// got that far — keeps the assertion a readable failure instead of a panic.
func (f *fakeControl) stepAt(i int) step {
	f.mu.Lock()
	defer f.mu.Unlock()
	if i >= len(f.steps) {
		return step{}
	}
	return f.steps[i]
}

func (f *fakeControl) stepCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.steps)
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
	if !strings.Contains(ctrl.stepAt(1).reason, "repository not found") {
		t.Fatalf("failure reason lost git's message: %q", ctrl.stepAt(1).reason)
	}
}

func TestCloningReportFailureStillAttemptsTerminalFailed(t *testing.T) {
	requireCleanEnv(t)
	// ERR-15 — before the fix, a failure to report "cloning" abandoned the job
	// right here: runJob returned bare, with NO terminal status ever
	// attempted. The server-side row was left wherever it last was (often
	// still "claimed") until scanJobLease.ts's 30-minute lease eventually
	// noticed. The fix routes this through `fail`, the same best-effort
	// terminal-report path every other failure in this function already uses.
	ctrl := &fakeControl{
		jobs:               []*Job{job("J1")},
		reportErr:          errors.New("connection reset"),
		failReportStatuses: map[string]bool{"cloning": true}, // only "cloning" fails — "failed" must still get through
	}
	runOnce(t, ctrl, &fakeCloner{}, &fakeScanner{uploaded: true})

	want := []string{"cloning", "failed"}
	if got := ctrl.statuses(); !equal(got, want) {
		t.Fatalf("statuses = %v, want %v — a report failure must still end in an attempted terminal status", got, want)
	}
	if !strings.Contains(ctrl.stepAt(1).reason, "could not report cloning") {
		t.Fatalf("failure reason = %q, want it to explain the ORIGINAL report failure, not go silent", ctrl.stepAt(1).reason)
	}
}

func TestScanningReportFailureStillAttemptsTerminalFailed(t *testing.T) {
	requireCleanEnv(t)
	// Same defect and same fix, one Report call later — a failed "scanning"
	// report must not abandon a job that already cloned successfully.
	ctrl := &fakeControl{
		jobs:               []*Job{job("J1")},
		reportErr:          errors.New("connection reset"),
		failReportStatuses: map[string]bool{"scanning": true},
	}
	runOnce(t, ctrl, &fakeCloner{}, &fakeScanner{uploaded: true})

	want := []string{"cloning", "scanning", "failed"}
	if got := ctrl.statuses(); !equal(got, want) {
		t.Fatalf("statuses = %v, want %v", got, want)
	}
	if !strings.Contains(ctrl.stepAt(2).reason, "could not report scanning") {
		t.Fatalf("failure reason = %q", ctrl.stepAt(2).reason)
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
		for ctrl.claimCount() < 3 {
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
	if ctrl.stepCount() != 0 {
		t.Fatalf("an idle poll reported %v", ctrl.statuses())
	}
	if !strings.Contains(out, "no scan jobs queued") {
		t.Fatalf("idle output = %q", out)
	}
}

func TestAnUnreachableControlPlaneStopsTheWorker(t *testing.T) {
	requireCleanEnv(t)
	// `--once` has no loop to retry into, so a claim failure here IS still
	// fatal (a single shot that could not claim genuinely has nothing useful
	// to do) — this is the ONE case ERR-15/OPS-12's retry-with-backoff does
	// not apply to. See TestTransientClaimFailureRetriesInsteadOfExiting for
	// the looping case, which is where the fix actually changes behavior.
	ctrl := &fakeControl{claimErr: errors.New("connection refused")}
	var out strings.Builder
	err := Run(context.Background(), Opts{Server: "https://ccp.example", Once: true}, ctrl, &fakeCloner{}, &fakeScanner{}, &out)
	if err == nil || !strings.Contains(err.Error(), "connection refused") {
		t.Fatalf("err = %v", err)
	}
}

func TestTransientClaimFailureRetriesInsteadOfExiting(t *testing.T) {
	requireCleanEnv(t)
	// ERR-15 / OPS-12 — in the ordinary LOOPING mode (no --once), a claim
	// failure must no longer exit the process and rely on Docker's restart
	// policy to crash-loop back in. The first 2 attempts fail (simulating a
	// control-plane restart); the 3rd recovers and hands over a real job,
	// which must still run to completion in the SAME process.
	ctrl := &fakeControl{
		jobs:          []*Job{job("J1")},
		claimErr:      errors.New("connection refused"),
		claimFailures: 2,
	}
	var out strings.Builder
	opts := Opts{Server: "https://ccp.example", WorkDir: t.TempDir(), Poll: time.Millisecond}
	ctx, cancel := context.WithCancel(context.Background())
	// Stop once the recovered claim has landed (claimCount only counts the
	// non-error path, so 1 here means "the 3rd attempt succeeded").
	go func() {
		for ctrl.claimCount() < 1 {
			time.Sleep(time.Millisecond)
		}
		cancel()
	}()
	if err := Run(ctx, opts, ctrl, &fakeCloner{}, &fakeScanner{uploaded: true}, &out); err != nil {
		t.Fatalf("Run returned an error for a TRANSIENT claim failure: %v", err)
	}
	if n := ctrl.attemptCount(); n < 3 {
		t.Fatalf("attempts = %d, want at least 3 (2 failures then the recovering claim)", n)
	}
	if got := ctrl.statuses(); !equal(got, []string{"cloning", "scanning", "uploaded"}) {
		t.Fatalf("the recovered claim's job did not run to completion: %v", got)
	}
	if !strings.Contains(out.String(), "retrying") {
		t.Fatalf("the retry was not logged: %q", out.String())
	}
}

/* ── OPS-12: the heartbeat liveness signal + its --healthcheck probe ────────── */

func TestHeartbeatTouchedEachLoopIteration(t *testing.T) {
	requireCleanEnv(t)
	heartbeat := filepath.Join(t.TempDir(), "heartbeat")
	ctrl := &fakeControl{}
	var out strings.Builder
	opts := Opts{Server: "https://ccp.example", WorkDir: t.TempDir(), Poll: time.Millisecond, Heartbeat: heartbeat}
	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		for ctrl.claimCount() < 3 { // a few idle iterations
			time.Sleep(time.Millisecond)
		}
		cancel()
	}()
	if err := Run(ctx, opts, ctrl, &fakeCloner{}, &fakeScanner{}, &out); err != nil {
		t.Fatalf("Run: %v", err)
	}
	info, err := os.Stat(heartbeat)
	if err != nil {
		t.Fatalf("heartbeat file was never created: %v", err)
	}
	if age := time.Since(info.ModTime()); age > 5*time.Second {
		t.Fatalf("heartbeat mtime is %s old right after Run returned", age)
	}
}

func TestHeartbeatDisabledByDefaultIsANoOp(t *testing.T) {
	requireCleanEnv(t)
	// Opts.Heartbeat left empty, as every other test in this file does — Run
	// must not create anything or fail over it.
	runOnce(t, &fakeControl{}, &fakeCloner{}, &fakeScanner{})
}

func TestHealthcheckFreshHeartbeatIsHealthy(t *testing.T) {
	path := filepath.Join(t.TempDir(), "heartbeat")
	if err := os.WriteFile(path, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	var errb strings.Builder
	if got := runHealthcheck(path, &errb); got != 0 {
		t.Fatalf("exit = %d, want 0 (stderr: %s)", got, errb.String())
	}
}

func TestHealthcheckMissingHeartbeatIsUnhealthy(t *testing.T) {
	var errb strings.Builder
	if got := runHealthcheck(filepath.Join(t.TempDir(), "never-written"), &errb); got != 1 {
		t.Fatalf("exit = %d, want 1", got)
	}
	if !strings.Contains(errb.String(), "heartbeat:") {
		t.Fatalf("stderr = %q", errb.String())
	}
}

func TestHealthcheckStaleHeartbeatIsUnhealthy(t *testing.T) {
	// The whole point: a heartbeat that stopped updating — a hung poll, a
	// prescan that never returns (OPS-12's own two examples) — must be
	// distinguishable from a container that is merely "Up".
	path := filepath.Join(t.TempDir(), "heartbeat")
	if err := os.WriteFile(path, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	stale := time.Now().Add(-HeartbeatStaleness - time.Minute)
	if err := os.Chtimes(path, stale, stale); err != nil {
		t.Fatal(err)
	}
	var errb strings.Builder
	if got := runHealthcheck(path, &errb); got != 1 {
		t.Fatalf("exit = %d, want 1 (stderr: %s)", got, errb.String())
	}
	if !strings.Contains(errb.String(), "wedged") {
		t.Fatalf("stderr = %q", errb.String())
	}
}

func TestHealthcheckWithNoHeartbeatPathIsUnhealthy(t *testing.T) {
	// --healthcheck with no --heartbeat has nothing to check — refusing to
	// call that "healthy" is the fail-closed answer.
	var errb strings.Builder
	if got := runHealthcheck("", &errb); got != 1 {
		t.Fatalf("exit = %d, want 1", got)
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
	if ctrl.claimCount() != 0 {
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
