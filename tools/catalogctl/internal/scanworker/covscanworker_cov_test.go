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

	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/onboard"
)

/*
This file covers the three seams worker_test.go leaves open:

  - cli.go — the flag surface. It is the only place that decides an EXIT CODE,
    and the exit code is the contract (0 ok · 2 refusal · 3 usage · 1 internal),
    so every branch is asserted through run() with an arg slice.
  - clone.go — GitCloner itself, driven against a FAKE git script in a temp dir
    (never the network, never a real clone): the argv and the rebuilt
    environment that actually reach the binary, and each of the failure shapes.
  - worker.go — the report-failure, workspace-failure and HTTP error paths.
*/

/* ── helpers ───────────────────────────────────────────────────────────────── */

// covscanworkerCleanEnv makes Preflight deterministic instead of host-dependent:
// every cloud/registry credential var is removed, and PATH is pointed at an
// empty dir so `terraform` cannot possibly be found.
func covscanworkerCleanEnv(t *testing.T) {
	t.Helper()
	for _, kv := range os.Environ() {
		name, _, _ := strings.Cut(kv, "=")
		for _, pfx := range []string{"AWS_", "GOOGLE_", "ARM_", "TF_TOKEN_"} {
			if strings.HasPrefix(name, pfx) {
				t.Setenv(name, "") // registers the restore…
				os.Unsetenv(name)  // …then removes it: the NAME is what is refused.
			}
		}
	}
	t.Setenv("PATH", t.TempDir())
	if err := Preflight(); err != nil {
		t.Fatalf("test env is still not clean: %v", err)
	}
}

func covscanworkerequalStrings(a, b []string) bool {
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

type covscanworkerstep struct {
	status string
	reason string
}

// covscanworkercontrol is a Control whose Report can be made to fail for ONE
// specific status, which is how the "reported a status transition and the report
// itself failed" branches are reached.
type covscanworkercontrol struct {
	jobs     []*Job
	claims   int
	steps    []covscanworkerstep
	failOn   string
	failErr  error
	onClaim  func(n int)
	claimErr error
}

func (c *covscanworkercontrol) Claim(context.Context) (*Job, error) {
	c.claims++
	if c.onClaim != nil {
		c.onClaim(c.claims)
	}
	if c.claimErr != nil {
		return nil, c.claimErr
	}
	if len(c.jobs) == 0 {
		return nil, nil
	}
	j := c.jobs[0]
	c.jobs = c.jobs[1:]
	return j, nil
}

func (c *covscanworkercontrol) Report(_ context.Context, _ *Job, status, reason string) error {
	c.steps = append(c.steps, covscanworkerstep{status, reason})
	if c.failOn != "" && status == c.failOn {
		if c.failErr == nil {
			c.failErr = errors.New("control plane said 503")
		}
		return c.failErr
	}
	return nil
}

/* ── cli.go: the flag surface and its exit codes ───────────────────────────── */

func TestCovscanworkerCLIUsageAndArgErrorsExit3(t *testing.T) {
	cases := []struct {
		name       string
		args       []string
		key        string
		wantCode   int
		wantStderr []string
	}{
		{
			name:       "unknown flag is an arg error",
			args:       []string{"--nope"},
			key:        "k",
			wantCode:   3,
			wantStderr: []string{"flag provided but not defined", "-nope"},
		},
		{
			name:       "unparseable duration is an arg error",
			args:       []string{"--server", "https://ccp.example", "--poll", "banana"},
			key:        "k",
			wantCode:   3,
			wantStderr: []string{"invalid value \"banana\""},
		},
		{
			name:     "a missing --server prints the usage line",
			args:     nil,
			key:      "k",
			wantCode: 3,
			wantStderr: []string{
				"usage: catalogctl scan-worker --server <url>",
				ScannerKeyEnv + " must be in the environment (never a flag)",
			},
		},
		{
			name:     "--workdir alone is still a missing --server",
			args:     []string{"--workdir", "/tmp/x"},
			key:      "k",
			wantCode: 3,
			wantStderr: []string{
				"usage: catalogctl scan-worker --server <url>",
			},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv(ScannerKeyEnv, tc.key)
			var out, errb strings.Builder
			got := run(tc.args, &out, &errb)
			if got != tc.wantCode {
				t.Fatalf("exit = %d, want %d (stderr: %s)", got, tc.wantCode, errb.String())
			}
			for _, want := range tc.wantStderr {
				if !strings.Contains(errb.String(), want) {
					t.Errorf("stderr missing %q\n  stderr: %s", want, errb.String())
				}
			}
			if out.Len() != 0 {
				t.Errorf("an arg error wrote to stdout: %q", out.String())
			}
		})
	}
}

func TestCovscanworkerCLIRefusesWithoutTheScannerKey(t *testing.T) {
	// ENV ONLY, and its absence is a DEPLOYMENT problem: exit 2 with the
	// greppable REFUSE line, not a usage error and not a silent start.
	t.Setenv(ScannerKeyEnv, "") // registers the restore…
	os.Unsetenv(ScannerKeyEnv)  // …then removes it entirely.

	var out, errb strings.Builder
	got := run([]string{"--server", "https://ccp.example", "--once"}, &out, &errb)
	if got != 2 {
		t.Fatalf("exit = %d, want 2 (stderr: %s)", got, errb.String())
	}
	if !strings.HasPrefix(errb.String(), "REFUSE SCANNER_KEY_MISSING: ") {
		t.Fatalf("stderr = %q, want a REFUSE SCANNER_KEY_MISSING line", errb.String())
	}
	if !strings.Contains(errb.String(), ScannerKeyEnv+" is not in the environment") {
		t.Fatalf("the refusal does not name the env var: %q", errb.String())
	}
}

func TestCovscanworkerCLIPreflightRefusalIsExit2(t *testing.T) {
	// A refused STARTUP is exit 2 and greppable, so an init system can tell
	// "this deployment is wrong" apart from "the control plane was down".
	covscanworkerCleanEnv(t)
	t.Setenv(ScannerKeyEnv, "the-shared-scanner-key-0123456789012345")
	t.Setenv("AWS_ACCESS_KEY_ID", "AKIAIOSFODNN7EXAMPLE")

	var out, errb strings.Builder
	// The server is never dialled: preflight refuses before the first claim.
	got := run([]string{"--server", "https://ccp.invalid", "--once"}, &out, &errb)
	if got != 2 {
		t.Fatalf("exit = %d, want 2 (stderr: %s)", got, errb.String())
	}
	if !strings.HasPrefix(errb.String(), "REFUSE SCANNER_PREFLIGHT: ") {
		t.Fatalf("stderr = %q, want a REFUSE SCANNER_PREFLIGHT line", errb.String())
	}
	for _, want := range []string{"scan-worker refuses to start:", "AWS_ACCESS_KEY_ID"} {
		if !strings.Contains(errb.String(), want) {
			t.Errorf("stderr missing %q\n  stderr: %s", want, errb.String())
		}
	}
	if strings.Contains(errb.String(), "the-shared-scanner-key") {
		t.Fatalf("the refusal echoed the scanner key: %q", errb.String())
	}
}

func TestCovscanworkerCLIUnreachableControlPlaneIsExit1(t *testing.T) {
	// NOT a refusal: the deployment is fine, the control plane is not. Exit 1,
	// no REFUSE line — the two are dispatched on by exit code alone.
	covscanworkerCleanEnv(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"code":"INTERNAL","reason":"nope"}`))
	}))
	defer srv.Close()
	key := "the-shared-scanner-key-0123456789012345"
	t.Setenv(ScannerKeyEnv, key)

	var out, errb strings.Builder
	got := run([]string{"--server", srv.URL, "--once"}, &out, &errb)
	if got != 1 {
		t.Fatalf("exit = %d, want 1 (stderr: %s)", got, errb.String())
	}
	if !strings.HasPrefix(errb.String(), "scan-worker: claim: ") {
		t.Fatalf("stderr = %q, want a scan-worker: claim: … line", errb.String())
	}
	if strings.Contains(errb.String(), "REFUSE") {
		t.Fatalf("a runtime failure was rendered as a refusal: %q", errb.String())
	}
	if strings.Contains(errb.String(), key) {
		t.Fatalf("the error echoed the scanner key: %q", errb.String())
	}
}

func TestCovscanworkerCLIIdleOnceRunExitsZero(t *testing.T) {
	covscanworkerCleanEnv(t)
	key := "the-shared-scanner-key-0123456789012345"
	var gotAuth, gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth, gotPath = r.Header.Get("Authorization"), r.URL.Path
		w.WriteHeader(http.StatusNoContent) // nothing queued
	}))
	defer srv.Close()
	t.Setenv(ScannerKeyEnv, key)

	var out, errb strings.Builder
	got := run([]string{"--server", srv.URL, "--once", "--workdir", t.TempDir(),
		"--poll", "1ms", "--clone-timeout", "5s"}, &out, &errb)
	if got != 0 {
		t.Fatalf("exit = %d, want 0 (stderr: %s)", got, errb.String())
	}
	if !strings.Contains(out.String(), "no scan jobs queued") {
		t.Fatalf("stdout = %q", out.String())
	}
	if errb.Len() != 0 {
		t.Fatalf("a clean idle run wrote to stderr: %q", errb.String())
	}
	// The key came from the ENVIRONMENT and reached the claim lane — the flag
	// surface has no way to supply it.
	if gotAuth != "Bearer "+key {
		t.Fatalf("claim auth = %q", gotAuth)
	}
	if gotPath != "/scan-jobs/claim" {
		t.Fatalf("claim path = %q", gotPath)
	}
	if strings.Contains(out.String(), key) {
		t.Fatalf("stdout leaked the scanner key: %q", out.String())
	}
}

/* ── clone.go: the real GitCloner, against a fake git ──────────────────────── */

// covscanworkerfakeGit writes an executable stand-in for git that records its
// cwd, argv and environment to recPath, then exits with code `exit` after
// printing `stdoutText` to stderr. NOTHING here talks to a network.
func covscanworkerfakeGit(t *testing.T, dir, recPath, emit string, exit int) string {
	t.Helper()
	bin := filepath.Join(dir, "git")
	script := "#!/bin/sh\n" +
		"{\n" +
		"  echo \"CWD=$PWD\"\n" +
		"  for a in \"$@\"; do echo \"ARG=$a\"; done\n" +
		"  env | sed 's/^/ENV=/'\n" +
		"} > " + recPath + " 2>/dev/null\n"
	if emit != "" {
		script += "printf '%s' '" + emit + "' >&2\n"
	}
	script += "exit " + covscanworkeritoa(exit) + "\n"
	if err := os.WriteFile(bin, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	return bin
}

func covscanworkeritoa(n int) string {
	if n == 0 {
		return "0"
	}
	var digits []byte
	for n > 0 {
		digits = append([]byte{byte('0' + n%10)}, digits...)
		n /= 10
	}
	return string(digits)
}

// covscanworkerrecord parses what the fake git recorded.
type covscanworkerrecord struct {
	cwd  string
	argv []string
	env  []string
}

func covscanworkerreadRecord(t *testing.T, path string) covscanworkerrecord {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("the fake git never ran (no record at %s): %v", path, err)
	}
	var rec covscanworkerrecord
	for _, line := range strings.Split(string(b), "\n") {
		switch {
		case strings.HasPrefix(line, "CWD="):
			rec.cwd = strings.TrimPrefix(line, "CWD=")
		case strings.HasPrefix(line, "ARG="):
			rec.argv = append(rec.argv, strings.TrimPrefix(line, "ARG="))
		case strings.HasPrefix(line, "ENV="):
			rec.env = append(rec.env, strings.TrimPrefix(line, "ENV="))
		}
	}
	return rec
}

func TestCovscanworkerGitClonerRunsTheHardenedArgv(t *testing.T) {
	// The worker's own secrets are in the environment; none of them may be
	// visible to the process that touches the untrusted repository.
	t.Setenv(ScannerKeyEnv, "super-secret-scanner-key-value-0123456789")
	t.Setenv("AWS_ACCESS_KEY_ID", "AKIAIOSFODNN7EXAMPLE")

	binDir := t.TempDir()
	rec := filepath.Join(t.TempDir(), "rec")
	bin := covscanworkerfakeGit(t, binDir, rec, "", 0)

	dest := filepath.Join(t.TempDir(), "repo")
	const url = "https://github.com/example-org/terraform-example.git"
	const header = "Basic eC1hY2Nlc3MtdG9rZW46Z2hzX3NlY3JldA=="

	if err := (GitCloner{Git: bin}).Clone(context.Background(), url, dest, header); err != nil {
		t.Fatalf("Clone: %v", err)
	}

	got := covscanworkerreadRecord(t, rec)
	if !covscanworkerequalStrings(got.argv, cloneArgs(url, dest)) {
		t.Fatalf("argv reaching git = %v\nwant %v", got.argv, cloneArgs(url, dest))
	}
	// The credential rides the environment, never argv.
	for _, a := range got.argv {
		if strings.Contains(a, header) || strings.Contains(a, "extraHeader") {
			t.Fatalf("the credential reached argv: %q", a)
		}
	}
	var home string
	for _, kv := range got.env {
		if strings.HasPrefix(kv, "HOME=") {
			home = strings.TrimPrefix(kv, "HOME=")
		}
		if strings.Contains(kv, "super-secret") || strings.HasPrefix(kv, "AWS_") {
			t.Fatalf("git inherited %q from the worker", kv)
		}
	}
	for _, want := range []string{
		"GIT_CONFIG_NOSYSTEM=1",
		"GIT_TERMINAL_PROMPT=0",
		"GIT_CONFIG_COUNT=1",
		"GIT_CONFIG_KEY_0=http." + url + ".extraHeader",
		"GIT_CONFIG_VALUE_0=Authorization: " + header,
	} {
		if !covscanworkercontainsString(got.env, want) {
			t.Errorf("git's environment lost %q\n  env: %v", want, got.env)
		}
	}
	// HOME is a throwaway dir ABOVE the checkout — a repo cannot ship a
	// .gitconfig at its own root and have it read — and it is the cwd.
	if home == "" {
		t.Fatal("git ran with no HOME")
	}
	if strings.HasPrefix(home, dest) {
		t.Fatalf("HOME %q is inside the checkout %q", home, dest)
	}
	if filepath.Base(got.cwd) != filepath.Base(home) {
		t.Fatalf("cwd = %q, want the throwaway HOME %q", got.cwd, home)
	}
	// …and nothing from it outlives the clone.
	if _, err := os.Stat(home); !os.IsNotExist(err) {
		t.Fatalf("the clone's HOME survived: %s", home)
	}
}

func TestCovscanworkerGitClonerDefaultsToGitOnPath(t *testing.T) {
	// An empty GitCloner.Git means the literal "git", resolved through PATH.
	binDir := t.TempDir()
	rec := filepath.Join(t.TempDir(), "rec")
	covscanworkerfakeGit(t, binDir, rec, "", 0)
	t.Setenv("PATH", binDir+":"+os.Getenv("PATH"))

	dest := filepath.Join(t.TempDir(), "repo")
	if err := (GitCloner{}).Clone(context.Background(), "https://github.com/o/r.git", dest, ""); err != nil {
		t.Fatalf("Clone: %v", err)
	}
	got := covscanworkerreadRecord(t, rec)
	if !covscanworkerequalStrings(got.argv, cloneArgs("https://github.com/o/r.git", dest)) {
		t.Fatalf("argv = %v", got.argv)
	}
	// A public clone gets no credential config at all.
	for _, kv := range got.env {
		if strings.HasPrefix(kv, "GIT_CONFIG_") && kv != "GIT_CONFIG_NOSYSTEM=1" {
			t.Fatalf("public clone set %q", kv)
		}
	}
}

func TestCovscanworkerGitClonerFailureShapes(t *testing.T) {
	cases := []struct {
		name      string
		emit      string
		exit      int
		wantSubs  []string
		wantExact string
	}{
		{
			name:     "git's own message reaches the reason",
			emit:     "fatal: repository not found",
			exit:     128,
			wantSubs: []string{"exit status 128", "fatal: repository not found"},
		},
		{
			name:      "a silent failure is the bare exec error",
			emit:      "",
			exit:      1,
			wantExact: "exit status 1",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			bin := covscanworkerfakeGit(t, t.TempDir(), filepath.Join(t.TempDir(), "rec"), tc.emit, tc.exit)
			err := (GitCloner{Git: bin}).Clone(context.Background(),
				"https://github.com/o/r.git", filepath.Join(t.TempDir(), "repo"), "")
			if err == nil {
				t.Fatal("a failing git was reported as a successful clone")
			}
			if tc.wantExact != "" && err.Error() != tc.wantExact {
				t.Fatalf("err = %q, want exactly %q", err.Error(), tc.wantExact)
			}
			for _, want := range tc.wantSubs {
				if !strings.Contains(err.Error(), want) {
					t.Errorf("err = %q, missing %q", err.Error(), want)
				}
			}
		})
	}
}

func TestCovscanworkerGitClonerBoundsUntrustedGitOutput(t *testing.T) {
	// git's stderr is untrusted text. It is kept, but bounded, so a hostile
	// repository cannot use the failure reason as a megabyte-sized channel.
	long := strings.Repeat("x", 500)
	bin := covscanworkerfakeGit(t, t.TempDir(), filepath.Join(t.TempDir(), "rec"), long, 1)
	err := (GitCloner{Git: bin}).Clone(context.Background(),
		"https://github.com/o/r.git", filepath.Join(t.TempDir(), "repo"), "")
	if err == nil {
		t.Fatal("want an error")
	}
	const prefix = "exit status 1: "
	if !strings.HasPrefix(err.Error(), prefix) {
		t.Fatalf("err lost git's exit status: %q", err.Error())
	}
	if kept := strings.TrimPrefix(err.Error(), prefix); len(kept) != 300 {
		t.Fatalf("kept %d bytes of git output, want it truncated to 300", len(kept))
	}
}

func TestCovscanworkerGitClonerCancelledContextIsATimeout(t *testing.T) {
	// A clone the worker gave up on must read as a timeout, not as whatever
	// half-written message the killed git happened to leave behind.
	bin := covscanworkerfakeGit(t, t.TempDir(), filepath.Join(t.TempDir(), "rec"), "fatal: killed", 128)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	err := (GitCloner{Git: bin}).Clone(ctx, "https://github.com/o/r.git", filepath.Join(t.TempDir(), "repo"), "")
	if err == nil || err.Error() != "timed out" {
		t.Fatalf("err = %v, want \"timed out\"", err)
	}
}

func TestCovscanworkerGitClonerReportsAWorkspaceFailure(t *testing.T) {
	// The throwaway HOME cannot be created ⇒ no git is run at all.
	rec := filepath.Join(t.TempDir(), "rec")
	bin := covscanworkerfakeGit(t, t.TempDir(), rec, "", 0)
	dest := filepath.Join(t.TempDir(), "repo")
	// Set TMPDIR only after every t.TempDir() above: os.MkdirTemp("") reads it.
	t.Setenv("TMPDIR", filepath.Join(t.TempDir(), "no-such-parent"))

	err := (GitCloner{Git: bin}).Clone(context.Background(),
		"https://github.com/o/r.git", dest, "")
	if err == nil || !strings.HasPrefix(err.Error(), "workspace: ") {
		t.Fatalf("err = %v, want a workspace: … error", err)
	}
	if _, statErr := os.Stat(rec); statErr == nil {
		t.Fatal("git ran even though the workspace could not be created")
	}
}

func TestCovscanworkerDefaultPath(t *testing.T) {
	t.Run("the ambient PATH is used when set", func(t *testing.T) {
		t.Setenv("PATH", "/opt/only")
		if got := defaultPath(); got != "/opt/only" {
			t.Fatalf("defaultPath() = %q", got)
		}
	})
	t.Run("an empty PATH falls back to the system default", func(t *testing.T) {
		t.Setenv("PATH", "")
		got := defaultPath()
		if got == "" {
			t.Fatal("defaultPath() is empty — git could not find its own helpers")
		}
		for _, want := range []string{"/usr/bin", "/bin"} {
			if !strings.Contains(got, want) {
				t.Errorf("fallback PATH %q missing %q", got, want)
			}
		}
	})
}

/* ── worker.go: the remaining failure paths ────────────────────────────────── */

func TestCovscanworkerWorkspaceFailureIsAReportedFailure(t *testing.T) {
	covscanworkerCleanEnv(t)
	ctrl := &covscanworkercontrol{jobs: []*Job{{
		JobID: "J1", ProjectID: "acme",
		CloneURL: "https://github.com/o/r.git", OnboardToken: "t.s",
	}}}
	cloner := &covscanworkercloner{}
	var out strings.Builder
	opts := Opts{
		Server:  "https://ccp.example",
		WorkDir: filepath.Join(t.TempDir(), "does-not-exist"),
		Once:    true,
	}
	if err := Run(context.Background(), opts, ctrl, cloner, &covscanworkerscanner{uploaded: true}, &out); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if got := covscanworkerstatusesOf(ctrl); !covscanworkerequalStrings(got, []string{"failed"}) {
		t.Fatalf("statuses = %v, want [failed]", got)
	}
	if ctrl.steps[0].reason != "could not create a workspace" {
		t.Fatalf("reason = %q", ctrl.steps[0].reason)
	}
	if cloner.calls != 0 {
		t.Fatal("the worker cloned without a workspace")
	}
	if !strings.Contains(out.String(), "job J1 (project acme) failed: could not create a workspace") {
		t.Fatalf("out = %q", out.String())
	}
}

func TestCovscanworkerAFailedStatusReportIsSurfaced(t *testing.T) {
	covscanworkerCleanEnv(t)
	cases := []struct {
		name         string
		cloneURL     string
		failOn       string
		wantStatuses []string
		wantOut      []string
	}{
		{
			// ERR-15 — a failed progress report is no longer a silent walk-away:
			// `fail` makes a best-effort attempt at the terminal "failed" report,
			// which SUCCEEDS here (failOn is scoped to "cloning" only), so the
			// job ends with a real terminal status instead of none at all.
			name:         "cloning could not be reported",
			cloneURL:     "https://github.com/o/r.git",
			failOn:       "cloning",
			wantStatuses: []string{"cloning", "failed"},
			wantOut:      []string{"job J1 (project acme) failed: could not report cloning:", "503"},
		},
		{
			name:         "scanning could not be reported",
			cloneURL:     "https://github.com/o/r.git",
			failOn:       "scanning",
			wantStatuses: []string{"cloning", "scanning", "failed"},
			wantOut:      []string{"job J1 (project acme) failed: could not report scanning:", "503"},
		},
		{
			name:         "the failure itself could not be reported",
			cloneURL:     "http://github.com/o/r.git", // refused before any clone
			failOn:       "failed",
			wantStatuses: []string{"failed"},
			wantOut: []string{
				"refusing the target the server supplied: not https",
				"(and reporting it failed:",
			},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ctrl := &covscanworkercontrol{
				jobs: []*Job{{
					JobID: "J1", ProjectID: "acme",
					CloneURL: tc.cloneURL, OnboardToken: "t.s",
				}},
				failOn:  tc.failOn,
				failErr: errors.New("control plane said 503"),
			}
			var out strings.Builder
			opts := Opts{Server: "https://ccp.example", WorkDir: t.TempDir(), Once: true}
			// A control plane that cannot record a transition is still not a
			// reason to take the whole worker down.
			if err := Run(context.Background(), opts, ctrl, &covscanworkercloner{},
				&covscanworkerscanner{uploaded: true}, &out); err != nil {
				t.Fatalf("Run returned an error for a per-job problem: %v", err)
			}
			if got := covscanworkerstatusesOf(ctrl); !covscanworkerequalStrings(got, tc.wantStatuses) {
				t.Fatalf("statuses = %v, want %v", got, tc.wantStatuses)
			}
			for _, want := range tc.wantOut {
				if !strings.Contains(out.String(), want) {
					t.Errorf("out missing %q\n  out: %s", want, out.String())
				}
			}
		})
	}
}

func TestCovscanworkerIdleLoopWaitsThePollIntervalThenStops(t *testing.T) {
	covscanworkerCleanEnv(t)
	// Not --once: an empty claim must sleep for Poll and come back, and a
	// cancelled context must end the loop cleanly (no error).
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	ctrl := &covscanworkercontrol{onClaim: func(n int) {
		if n == 2 {
			cancel() // only after one full idle wait has already happened
		}
	}}
	var out strings.Builder
	opts := Opts{Server: "https://ccp.example", WorkDir: t.TempDir(), Poll: time.Millisecond}
	if err := Run(ctx, opts, ctrl, &covscanworkercloner{}, &covscanworkerscanner{}, &out); err != nil {
		t.Fatalf("a cancelled worker must exit cleanly, got %v", err)
	}
	if ctrl.claims != 2 {
		t.Fatalf("claims = %d, want 2 (one idle wait, then the cancellation)", ctrl.claims)
	}
	if len(ctrl.steps) != 0 {
		t.Fatalf("an idle worker reported %v", ctrl.steps)
	}
	// Only --once announces an idle poll; a looping worker stays quiet.
	if strings.Contains(out.String(), "no scan jobs queued") {
		t.Fatalf("a looping worker logged an idle poll: %q", out.String())
	}
}

func TestCovscanworkerZeroPollFallsBackToTheDefault(t *testing.T) {
	covscanworkerCleanEnv(t)
	// Poll: 0 must not become a busy loop. With --once we only assert the run
	// completes without consulting the (default, 15s) timer.
	ctrl := &covscanworkercontrol{}
	var out strings.Builder
	if err := Run(context.Background(), Opts{Server: "https://ccp.example", Once: true, Poll: 0},
		ctrl, &covscanworkercloner{}, &covscanworkerscanner{}, &out); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if ctrl.claims != 1 {
		t.Fatalf("claims = %d, want 1", ctrl.claims)
	}
}

func TestCovscanworkercheckCloneURL(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		want string // "" ⇒ accepted
	}{
		{name: "plain https on a real host", raw: "https://github.com/o/r.git"},
		{name: "unparseable", raw: "https://exa mple.com/o/r.git", want: "not a URL"},
		{name: "control character", raw: "https://exam\x7fple.com/o/r.git", want: "not a URL"},
		{name: "downgraded scheme", raw: "http://github.com/o/r.git", want: "not https"},
		// The host here is an RFC 2606 reserved domain on purpose: `u:p@<host>`
		// is email-SHAPED, and the publish gate's PG-6 people check (correctly)
		// flags a non-example address anywhere in the public tree. The guard
		// under test reads the URL's userinfo, not its host, so the assertion is
		// unchanged.
		{name: "embedded credentials", raw: "https://u:p@example.com/o/r.git", want: "credentials embedded in the URL"},
		{name: "explicit port", raw: "https://github.com:2222/o/r.git", want: "explicit port"},
		{name: "no host", raw: "https:///o/r.git", want: "no host"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := checkCloneURL(tc.raw)
			if tc.want == "" {
				if err != nil {
					t.Fatalf("checkCloneURL(%q) = %v, want nil", tc.raw, err)
				}
				return
			}
			if err == nil {
				t.Fatalf("checkCloneURL(%q) accepted it", tc.raw)
			}
			if err.Error() != tc.want {
				t.Fatalf("err = %q, want %q", err.Error(), tc.want)
			}
		})
	}
}

/* ── worker.go: the HTTP control client's error paths ──────────────────────── */

func TestCovscanworkerHTTPControlRejectsAnUnmarshalableBody(t *testing.T) {
	c := NewHTTPControl("https://ccp.example", "k")
	_, err := c.do(context.Background(), "/scan-jobs/x/status", make(chan int))
	if err == nil {
		t.Fatal("a body that cannot be encoded should not produce a request")
	}
	if !strings.Contains(err.Error(), "unsupported type") {
		t.Fatalf("err = %v", err)
	}
}

func TestCovscanworkerHTTPControlSurfacesAnUnbuildableRequest(t *testing.T) {
	// A malformed base URL must fail before anything is dialled, on BOTH lanes.
	c := NewHTTPControl("http://ccp\x7f.example", "k")
	if _, err := c.Claim(context.Background()); err == nil {
		t.Fatal("Claim built a request from a malformed server URL")
	} else if !strings.Contains(err.Error(), "invalid control character") {
		t.Fatalf("claim err = %v", err)
	}
	err := c.Report(context.Background(), &Job{JobID: "J1", ProjectID: "acme"}, "cloning", "")
	if err == nil {
		t.Fatal("Report built a request from a malformed server URL")
	}
	if !strings.Contains(err.Error(), "invalid control character") {
		t.Fatalf("report err = %v", err)
	}
}

func TestCovscanworkerHTTPControlClaimRejectsUndecodableJSON(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"jobId": `)) // truncated
	}))
	defer srv.Close()
	_, err := NewHTTPControl(srv.URL, "k").Claim(context.Background())
	if err == nil {
		t.Fatal("a truncated claim response was accepted")
	}
	if !strings.Contains(err.Error(), "decode claim response") {
		t.Fatalf("err = %v", err)
	}
}

func TestCovscanworkerHTTPControlReportNon2xxIsAnError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = w.Write([]byte(`{"code":"SCAN_JOB_UNKNOWN","reason":"no such job"}`))
	}))
	defer srv.Close()
	key := "super-secret-scanner-key-value-0123456789"
	err := NewHTTPControl(srv.URL, key).Report(context.Background(),
		&Job{JobID: "J1", ProjectID: "acme"}, "uploaded", "")
	if err == nil {
		t.Fatal("a 503 status report should be an error")
	}
	if !strings.Contains(err.Error(), "503") || !strings.Contains(err.Error(), "SCAN_JOB_UNKNOWN") {
		t.Fatalf("err = %v", err)
	}
	if strings.Contains(err.Error(), key) {
		t.Fatalf("the error echoed the key: %v", err)
	}
}

func TestCovscanworkerHTTPControlEscapesTheJobIDInThePath(t *testing.T) {
	var gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.EscapedPath()
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()
	// A server-supplied id is still data: it must not be able to walk the path.
	err := NewHTTPControl(srv.URL+"/", "k").Report(context.Background(),
		&Job{JobID: "a/../b", ProjectID: "acme"}, "cloning", "")
	if err != nil {
		t.Fatalf("Report: %v", err)
	}
	// The id stays ONE path segment: its slashes are percent-encoded, so it
	// cannot walk out of /scan-jobs/<id>/status into another endpoint.
	if gotPath != "/scan-jobs/a%2F..%2Fb/status" {
		t.Fatalf("path = %q — the job id was not escaped into a single segment", gotPath)
	}
}

/* ── worker.go: the real scanner seam ─────────────────────────────────────── */

type covscanworkeruploader struct {
	err     error
	calls   int
	server  string
	project string
	token   string
	body    onboard.TrustRequestUpload
}

func (u *covscanworkeruploader) UploadTrustRequest(server, projectID, token string, body onboard.TrustRequestUpload) error {
	u.calls++
	u.server, u.project, u.token, u.body = server, projectID, token, body
	return u.err
}

func TestCovscanworkerUploadWatcherRecordsWhetherTheUploadLanded(t *testing.T) {
	body := onboard.TrustRequestUpload{PrescanReport: "{}"}
	t.Run("a landed upload", func(t *testing.T) {
		inner := &covscanworkeruploader{}
		w := &uploadWatcher{inner: inner}
		if err := w.UploadTrustRequest("https://ccp.example", "acme", "tok", body); err != nil {
			t.Fatalf("err = %v", err)
		}
		if !w.uploaded || w.lastErr != nil {
			t.Fatalf("uploaded=%v lastErr=%v", w.uploaded, w.lastErr)
		}
		// The wrapper forwards verbatim — it observes, it does not rewrite.
		if inner.calls != 1 || inner.server != "https://ccp.example" || inner.project != "acme" || inner.token != "tok" {
			t.Fatalf("inner saw %+v", inner)
		}
		if inner.body.PrescanReport != "{}" {
			t.Fatalf("inner body = %+v", inner.body)
		}
	})
	t.Run("an upload that did not land", func(t *testing.T) {
		boom := errors.New("server responded 401 Unauthorized")
		w := &uploadWatcher{inner: &covscanworkeruploader{err: boom}}
		err := w.UploadTrustRequest("https://ccp.example", "acme", "tok", body)
		if !errors.Is(err, boom) {
			t.Fatalf("err = %v, want it forwarded", err)
		}
		if w.uploaded {
			t.Fatal("uploaded=true for a failed PUT")
		}
		if !errors.Is(w.lastErr, boom) {
			t.Fatalf("lastErr = %v", w.lastErr)
		}
	})
}

// covscanworkerrepo writes a repo checkout containing one .tf file.
func covscanworkerrepo(t *testing.T, name, tf string) string {
	t.Helper()
	dir := filepath.Join(t.TempDir(), name)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "main.tf"), []byte(tf), 0o600); err != nil {
		t.Fatal(err)
	}
	return dir
}

const covscanworkercleanTF = `resource "aws_s3_bucket" "b" {
  bucket = "example"
}
`

const covscanworkerrejectTF = `resource "aws_s3_bucket" "b" {
  bucket = "example"

  provisioner "local-exec" {
    command = "id"
  }
}
`

func TestCovscanworkerOnboardScannerStopsAtTheTrustRequestAndUploads(t *testing.T) {
	// PATH is emptied so nothing in the onboard flow can find a binary: this is
	// the structural claim — the scan is a static parse, and the terraform
	// branch is unreachable from here because TrustedCommit is empty.
	t.Setenv("PATH", t.TempDir())

	var gotMethod, gotPath, gotAuth string
	var gotBody onboard.TrustRequestUpload
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod, gotPath, gotAuth = r.Method, r.URL.Path, r.Header.Get("Authorization")
		_ = json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&gotBody)
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	repo := covscanworkerrepo(t, "example-repo", covscanworkercleanTF)
	outDir := t.TempDir()
	job := &Job{JobID: "J1", ProjectID: "acme", OnboardToken: "the-per-job-onboard-token"}

	var out strings.Builder
	uploaded, err := OnboardScanner{}.ScanAndUpload(job, repo, outDir, srv.URL, &out)
	if err != nil || !uploaded {
		t.Fatalf("uploaded=%v err=%v\n  out: %s", uploaded, err, out.String())
	}
	if gotMethod != http.MethodPut || gotPath != "/projects/acme/trust-request" {
		t.Fatalf("upload went to %s %s", gotMethod, gotPath)
	}
	if gotAuth != "Bearer the-per-job-onboard-token" {
		t.Fatalf("upload auth = %q", gotAuth)
	}
	if gotBody.TrustRequest.Repo != "example-repo" {
		t.Fatalf("uploaded trustRequest = %+v", gotBody.TrustRequest)
	}
	if !strings.Contains(gotBody.PrescanReport, `"verdict": "clean"`) {
		t.Fatalf("uploaded prescan report = %s", gotBody.PrescanReport)
	}
	// No CI provenance is claimed: this scan was run by the control plane.
	if gotBody.Ci != nil {
		t.Fatalf("the worker claimed CI provenance: %+v", gotBody.Ci)
	}
	// It stopped at the trust request — both artifacts on disk, nothing executed.
	for _, f := range []string{"trust-request.json", "prescan-report.json"} {
		if _, err := os.Stat(filepath.Join(outDir, f)); err != nil {
			t.Errorf("%s was not written: %v", f, err)
		}
	}
	if _, err := os.Stat(filepath.Join(outDir, "providers-schema.json")); !os.IsNotExist(err) {
		t.Fatal("the worker reached the terraform branch")
	}
	if !strings.Contains(out.String(), "trust required: wrote trust-request.json") {
		t.Fatalf("out = %s", out.String())
	}
}

func TestCovscanworkerOnboardScannerTreatsARejectAsASuccessfulScan(t *testing.T) {
	t.Setenv("PATH", t.TempDir())
	var gotBody onboard.TrustRequestUpload
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&gotBody)
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	repo := covscanworkerrepo(t, "hostile-repo", covscanworkerrejectTF)
	var out strings.Builder
	uploaded, err := OnboardScanner{}.ScanAndUpload(
		&Job{JobID: "J1", ProjectID: "acme", OnboardToken: "tok"}, repo, t.TempDir(), srv.URL, &out)
	// The findings ARE the deliverable: a reject that reached the server is a
	// successful scan, not a failed job.
	if err != nil || !uploaded {
		t.Fatalf("a reject verdict was reported as a failed scan: uploaded=%v err=%v\n  out: %s",
			uploaded, err, out.String())
	}
	if !strings.Contains(gotBody.PrescanReport, "PROVISIONER") {
		t.Fatalf("the reject findings never reached the server: %s", gotBody.PrescanReport)
	}
	if !strings.Contains(gotBody.PrescanReport, `"verdict": "reject"`) {
		t.Fatalf("uploaded report = %s", gotBody.PrescanReport)
	}
}

func TestCovscanworkerOnboardScannerFailsWhenTheUploadDoesNot(t *testing.T) {
	t.Setenv("PATH", t.TempDir())
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"code":"ONBOARD_TOKEN_INVALID","reason":"expired"}`))
	}))
	defer srv.Close()

	repo := covscanworkerrepo(t, "example-repo", covscanworkercleanTF)
	var out strings.Builder
	uploaded, err := OnboardScanner{}.ScanAndUpload(
		&Job{JobID: "J1", ProjectID: "acme", OnboardToken: "tok"}, repo, t.TempDir(), srv.URL, &out)
	if uploaded {
		t.Fatal("uploaded=true for a 401")
	}
	if err == nil {
		t.Fatal("a rejected upload must be an error — the worker has nothing on disk to fall back to")
	}
	if !strings.Contains(err.Error(), "401") || !strings.Contains(err.Error(), "ONBOARD_TOKEN_INVALID") {
		t.Fatalf("err = %v", err)
	}
}

func TestCovscanworkerOnboardScannerFailsWhenNothingWasUploadedAtAll(t *testing.T) {
	t.Setenv("PATH", t.TempDir())
	// No token ⇒ onboard never attempts the upload and still exits 0. For a
	// LOCAL run that is fine (the files are on disk); for the worker it is a
	// failed job, and the exit code is reported so the operator can tell why.
	repo := covscanworkerrepo(t, "example-repo", covscanworkercleanTF)
	var out strings.Builder
	uploaded, err := OnboardScanner{}.ScanAndUpload(
		&Job{JobID: "J1", ProjectID: "acme", OnboardToken: ""}, repo, t.TempDir(), "https://ccp.example", &out)
	if uploaded {
		t.Fatal("uploaded=true without an upload")
	}
	if err == nil || !strings.Contains(err.Error(), "onboard exited 0 without uploading") {
		t.Fatalf("err = %v", err)
	}
}

func TestCovscanworkerOnboardScannerReportsAnUnscannableCheckout(t *testing.T) {
	t.Setenv("PATH", t.TempDir())
	// The clone left nothing behind: prescan cannot walk the root, so onboard
	// exits internal (1) and no artifact is uploaded.
	missing := filepath.Join(t.TempDir(), "no-such-checkout")
	var out strings.Builder
	uploaded, err := OnboardScanner{}.ScanAndUpload(
		&Job{JobID: "J1", ProjectID: "acme", OnboardToken: "tok"}, missing, t.TempDir(), "https://ccp.example", &out)
	if uploaded {
		t.Fatal("uploaded=true for a checkout that does not exist")
	}
	if err == nil || !strings.Contains(err.Error(), "onboard exited 1 without uploading") {
		t.Fatalf("err = %v", err)
	}
}

/* ── local fakes ───────────────────────────────────────────────────────────── */

type covscanworkercloner struct {
	err   error
	calls int
	url   string
	dest  string
	auth  string
}

func (c *covscanworkercloner) Clone(_ context.Context, cloneURL, dest, authHeader string) error {
	c.calls++
	c.url, c.dest, c.auth = cloneURL, dest, authHeader
	if c.err != nil {
		return c.err
	}
	return os.MkdirAll(dest, 0o700)
}

type covscanworkerscanner struct {
	uploaded bool
	err      error
	calls    int
}

func (s *covscanworkerscanner) ScanAndUpload(*Job, string, string, string, io.Writer) (bool, error) {
	s.calls++
	return s.uploaded, s.err
}

func covscanworkerstatusesOf(c *covscanworkercontrol) []string {
	out := make([]string, len(c.steps))
	for i, s := range c.steps {
		out[i] = s.status
	}
	return out
}

func covscanworkercontainsString(hay []string, needle string) bool {
	for _, h := range hay {
		if h == needle {
			return true
		}
	}
	return false
}
