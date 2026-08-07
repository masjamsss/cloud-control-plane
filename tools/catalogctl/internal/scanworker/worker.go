// Package scanworker is the isolated process on the OTHER end of the control
// plane's scanner lane (ADR-0033): it asks the server for the next repository
// to scan, clones it, prescans it, and uploads the result over the same
// pre-trust lane a local `catalogctl onboard` uses.
//
// THE POINT OF THIS PROCESS IS THAT IT IS THE ONLY THING THAT TOUCHES
// UNTRUSTED CODE. Everything about it is arranged so that a hostile repository
// gains nothing by being scanned:
//
//   - IT NEVER EXECUTES THE REPO. No terraform init, no providers schema, no
//     hooks, no submodules. The scan is `prescan.Scan` — static HCL parsing of
//     files on disk — which is precisely the step `catalogctl onboard` runs
//     BEFORE any trust decision exists. Reaching terraform is not gated here,
//     it is structurally unreachable: the worker calls the onboard flow with an
//     empty TrustedCommit, the branch that stops at the trust request.
//   - IT REFUSES TO START HOLDING A CLOUD CREDENTIAL
//     (onboard.AssertNoCloudCreds — the same guard as the sandbox contract).
//     A process that parses hostile code must not also be able to reach an
//     account.
//   - IT REFUSES TO START IF TERRAFORM IS ON PATH. Not because it would call it
//     — it cannot — but because the deployment intent is a scanner image with
//     no executor in it, and a check is how that intent survives someone
//     rebuilding the image from a convenient base later.
//   - IT NEVER CHOOSES ITS OWN TARGET. The clone URL comes from the server's
//     claim response, which the server built from the stored repo reference
//     through its forge-host allowlist. The worker cannot ask for a project by
//     name, and the URL it is handed can only address an allowlisted host over
//     https — re-checked here before the clone, since a client that blindly
//     executes whatever a server hands it is one compromised server away from
//     an SSRF tool.
//   - ITS CREDENTIALS ARE SEPARATE AND SHORT-LIVED. The long-lived
//     `CCP_SCANNER_KEY` talks ONLY to the claim/status lane. The per-job
//     onboarding token, valid about an hour, uploads exactly one artifact pair
//     for exactly one project. Neither is ever written to disk, passed as a
//     flag, or printed.
//
// What it does NOT do is decide anything. The prescan verdict is uploaded
// whether it is clean or a reject — a reject's findings are exactly what the
// two reviewing admins need — and the two-admin trust ceremony downstream is
// untouched. This removes the typing, not the human judgment.
package scanworker

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/onboard"
)

// ScannerKeyEnv holds the shared key the worker presents to the claim/status
// lane. ENV ONLY, never a flag — the same rule the onboarding token follows, so
// it cannot leak into a process listing, a shell history, or a CI log.
const ScannerKeyEnv = "CCP_SCANNER_KEY"

// Job is the work packet the server hands back from a claim. It is the ONLY
// place the worker learns what to do, and it carries no free-form instruction:
// a URL the server built and a token the server minted.
type Job struct {
	JobID          string `json:"jobId"`
	ProjectID      string `json:"projectId"`
	CloneURL       string `json:"cloneUrl"`
	OnboardToken   string `json:"onboardToken"`
	TokenExpiresAt string `json:"tokenExpiresAt"`
	// CloneAuthHeader is the ready-to-use `Authorization` header value for a
	// PRIVATE repository — a per-job GitHub App installation token, or the
	// operator's stored forge token, whichever the server resolved. EMPTY for a
	// public repo, which is the case that needs no credential at all.
	//
	// The worker never learns which kind it holds and never parses it: the
	// server assembled the scheme and the encoding, so there is exactly one
	// place that can get them wrong.
	CloneAuthHeader string `json:"cloneAuthHeader,omitempty"`
}

// Opts configures a worker process.
type Opts struct {
	// Server is the control-plane base URL (required).
	Server string
	// Key is the shared scanner key, read from ScannerKeyEnv by the CLI layer.
	Key string
	// WorkDir is the parent for each job's throwaway checkout. Empty ⇒ the OS
	// temp dir. In the container this is a tmpfs, which is also what bounds how
	// much disk a hostile repository can consume.
	WorkDir string
	// Once stops after a single poll (whether or not it found work) instead of
	// looping. The one-shot mode a cron or a test uses.
	Once bool
	// Poll is the idle wait between empty claims.
	Poll time.Duration
	// CloneTimeout bounds a single clone. A repository that will not finish in
	// this long is a failed job, not a stuck worker.
	CloneTimeout time.Duration
	// Heartbeat, if set, is a path `Run` touches (creates, or updates the mtime
	// of) once per loop iteration — OPS-12's liveness signal, read back by the
	// `--healthcheck` probe below. Empty disables it entirely; a write failure
	// is best-effort and never stops the loop, matching every other failure
	// posture in this file (one bad thing must not take the worker down).
	Heartbeat string
}

// HeartbeatStaleness is how old Opts.Heartbeat may get before `--healthcheck`
// calls the worker unhealthy.
//
// The file is touched once per `Run` LOOP ITERATION — at the top, before the
// next claim — so its age is bounded by however long the CURRENT iteration
// has been running: an idle wait (capped at Poll), or one full job (clone,
// bounded by CloneTimeout; then prescan+upload, which has no explicit
// timeout of its own). If a job's prescan phase hangs forever — OPS-12's
// "stuck prescan" case, same as a hung poll — `runJob` never returns, the
// loop never comes back around, and the file simply stops being touched: the
// staleness check is what eventually notices, not a per-phase heartbeat.
// Comfortably above `DefaultCloneTimeout` (10m) so a normal job's clone
// finishing right at its own bound is never mistaken for a wedge.
const HeartbeatStaleness = 20 * time.Minute

// touchHeartbeat creates or updates path's mtime. Best-effort and silent on
// failure (a misconfigured heartbeat path must never take an otherwise-healthy
// worker down) — `path == ""` is the ordinary "disabled" case, not an error.
func touchHeartbeat(path string) {
	if path == "" {
		return
	}
	now := time.Now()
	if err := os.Chtimes(path, now, now); err != nil {
		_ = os.WriteFile(path, nil, 0o600) // first run: the file does not exist yet
	}
}

// Defaults for the two timing knobs, chosen so an idle worker is cheap and a
// hostile repository cannot hold a slot indefinitely.
const (
	DefaultPoll         = 15 * time.Second
	DefaultCloneTimeout = 10 * time.Minute
	// httpTimeout bounds one claim/status call. Short: these are tiny JSON
	// round-trips to the control plane, not the clone.
	httpTimeout = 30 * time.Second
)

// Control is the control-plane seam (claim + status). Tests inject a fake so
// the whole job lifecycle is asserted without a server.
type Control interface {
	// Claim asks for the next job. A nil Job with a nil error means "nothing
	// queued" — an ordinary idle result, never an error.
	Claim(ctx context.Context) (*Job, error)
	// Report records a status transition. `reason` is only meaningful for
	// "failed"; the server sanitizes it regardless.
	Report(ctx context.Context, job *Job, status, reason string) error
}

// Cloner is the checkout seam. The real one shells to git with a stripped
// environment (clone.go); tests inject a fake that just materializes files.
type Cloner interface {
	Clone(ctx context.Context, cloneURL, dest, authHeader string) error
}

// Scanner is the prescan+upload seam — in production, the SAME onboard flow a
// local run uses, so the artifact bytes are identical whichever lane produced
// them. Returns whether the artifacts actually reached the server.
type Scanner interface {
	ScanAndUpload(job *Job, repoDir, outDir, server string, out io.Writer) (uploaded bool, err error)
}

// Run polls for work until the context is cancelled (or once, with Opts.Once).
// It returns an error for a refused startup, for `--once` hitting a claim it
// could not make (a single shot has no loop to retry into), or for anything
// that makes the process itself unusable. In the ordinary LOOPING case, a
// claim failure is transient by default — ERR-15 / OPS-12: a connection
// refused during a control-plane restart, or the 409 CHAIN_CONTENTION the
// claim route can emit, used to be treated exactly like "the deployment is
// broken", exiting the process and leaving Docker's restart policy to
// crash-loop it back in. It is instead logged and retried after the SAME
// poll backoff an idle "nothing queued" result already waits out — the
// worker just looks like it is idling through an outage, which is what an
// outage that recovers on its own should look like. A job that fails is
// reported as a failed job and the worker keeps going regardless: one bad
// repository must not take the scanner down either.
func Run(ctx context.Context, opts Opts, ctrl Control, cloner Cloner, scanner Scanner, out io.Writer) error {
	if err := Preflight(); err != nil {
		return err
	}
	poll := opts.Poll
	if poll <= 0 {
		poll = DefaultPoll
	}
	for {
		touchHeartbeat(opts.Heartbeat)
		job, err := ctrl.Claim(ctx)
		if err != nil {
			if opts.Once {
				return fmt.Errorf("claim: %w", err)
			}
			fmt.Fprintf(out, "claim: %v (retrying in %s)\n", err, poll)
			select {
			case <-ctx.Done():
				return nil
			case <-time.After(poll):
			}
			continue
		}
		if job != nil {
			// A job's own failure is reported and swallowed on purpose: the
			// next repository is unrelated to this one's problems.
			if err := runJob(ctx, opts, ctrl, cloner, scanner, job, out); err != nil {
				fmt.Fprintf(out, "job %s (project %s) failed: %v\n", job.JobID, job.ProjectID, err)
			}
		} else if opts.Once {
			fmt.Fprintln(out, "no scan jobs queued")
		}
		if opts.Once {
			return nil
		}
		if job != nil {
			continue // drain the queue before idling
		}
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(poll):
		}
	}
}

// runJob takes one claimed job all the way to a terminal status. Every exit
// path reports one: a job the worker walks away from silently is a job the
// operator watches spin forever.
func runJob(ctx context.Context, opts Opts, ctrl Control, cloner Cloner, scanner Scanner, job *Job, out io.Writer) error {
	// Re-check the server's URL rather than trusting it. The server is the one
	// that enforces the forge allowlist, but a client that clones whatever it
	// is told is a confused deputy waiting to happen.
	if err := checkCloneURL(job.CloneURL); err != nil {
		return fail(ctx, ctrl, job, "refusing the target the server supplied: "+err.Error())
	}

	dir, err := os.MkdirTemp(opts.WorkDir, "ccp-scan-")
	if err != nil {
		return fail(ctx, ctrl, job, "could not create a workspace")
	}
	// The checkout is destroyed whatever happens — nothing from an untrusted
	// repository outlives the job that scanned it.
	defer os.RemoveAll(dir)
	repoDir := filepath.Join(dir, "repo")
	outDir := filepath.Join(dir, "out")
	if err := os.MkdirAll(outDir, 0o700); err != nil {
		return fail(ctx, ctrl, job, "could not create a workspace")
	}

	if err := ctrl.Report(ctx, job, "cloning", ""); err != nil {
		// ERR-15 — a transient failure to report "cloning" used to abandon the
		// job right here with no terminal status at all: the server-side row
		// stays wherever it last was (often still "claimed"), and nothing tells
		// the operator the worker gave up rather than still being at work —
		// domain/scanJobLease.ts's 30-minute lease is the only thing that would
		// eventually notice, and only after sitting wedged that whole time.
		// `fail` makes a best-effort attempt at the terminal "failed" report
		// before returning — the same one every other failure path here
		// already gets (clone failure, scan failure, a refused clone URL).
		return fail(ctx, ctrl, job, "could not report cloning: "+err.Error())
	}
	timeout := opts.CloneTimeout
	if timeout <= 0 {
		timeout = DefaultCloneTimeout
	}
	cctx, cancel := context.WithTimeout(ctx, timeout)
	err = cloner.Clone(cctx, job.CloneURL, repoDir, job.CloneAuthHeader)
	cancel()
	if err != nil {
		return fail(ctx, ctrl, job, "clone failed: "+err.Error())
	}

	if err := ctrl.Report(ctx, job, "scanning", ""); err != nil {
		// ERR-15 — same reasoning as the "cloning" report above: attempt the
		// terminal report rather than just walking away.
		return fail(ctx, ctrl, job, "could not report scanning: "+err.Error())
	}
	uploaded, serr := scanner.ScanAndUpload(job, repoDir, outDir, opts.Server, out)
	if !uploaded {
		reason := "scan produced no upload"
		if serr != nil {
			reason = "scan failed: " + serr.Error()
		}
		return fail(ctx, ctrl, job, reason)
	}
	// A REJECT VERDICT IS A SUCCESSFUL SCAN. The findings are the deliverable —
	// they are what the two admins review — so the job is `uploaded`, not
	// `failed`. Only "the artifacts never reached the server" is a failure.
	return ctrl.Report(ctx, job, "uploaded", "")
}

// fail reports the terminal failure and returns the reason as an error so the
// caller can log it. A failure to REPORT the failure is surfaced too, since
// that means the operator's view of this job is now wrong.
func fail(ctx context.Context, ctrl Control, job *Job, reason string) error {
	if err := ctrl.Report(ctx, job, "failed", reason); err != nil {
		return fmt.Errorf("%s (and reporting it failed: %v)", reason, err)
	}
	return errors.New(reason)
}

// PreflightError is a REFUSED STARTUP — the deployment is wrong, not the run.
// A distinct type so the CLI can map it to the greppable REFUSE line and exit 2
// without matching on message text.
type PreflightError struct{ Reason string }

func (e *PreflightError) Error() string { return "scan-worker refuses to start: " + e.Reason }

// Preflight is the startup refusal set — the invariants that must hold before
// this process is allowed to touch a single untrusted repository. Both are
// deliberately hard refusals with no override flag: an escape hatch here is an
// escape hatch in the one process that handles hostile input.
func Preflight() error {
	if err := onboard.AssertNoCloudCreds(); err != nil {
		return &PreflightError{Reason: err.Error()}
	}
	if p, err := exec.LookPath("terraform"); err == nil {
		return &PreflightError{Reason: "terraform is on PATH (" + p + "). " +
			"This process only ever parses HCL statically and must never be able to execute a repository; " +
			"run it from the scanner image, which ships no terraform"}
	}
	return nil
}

// checkCloneURL re-applies, client-side, the shape the server promises: plain
// https, no embedded credentials, no explicit port, and a real host. It cannot
// re-check the deployment's forge allowlist (that list lives on the server),
// which is exactly why the server refuses off-list hosts before a job is ever
// queued — this is the second, narrower guard, not the first.
func checkCloneURL(raw string) error {
	u, err := url.Parse(raw)
	if err != nil {
		return errors.New("not a URL")
	}
	if u.Scheme != "https" {
		return errors.New("not https")
	}
	if u.User != nil {
		return errors.New("credentials embedded in the URL")
	}
	if u.Port() != "" {
		return errors.New("explicit port")
	}
	if u.Hostname() == "" {
		return errors.New("no host")
	}
	return nil
}

/* ── the real control-plane client ─────────────────────────────────────────── */

// HTTPControl talks to the server's `/scan-jobs` lane with the shared key.
type HTTPControl struct {
	Server string
	Key    string
	Client *http.Client
}

// NewHTTPControl builds the production client. The key is held in memory only.
func NewHTTPControl(server, key string) *HTTPControl {
	return &HTTPControl{
		Server: strings.TrimRight(server, "/"),
		Key:    key,
		Client: &http.Client{Timeout: httpTimeout},
	}
}

func (h *HTTPControl) do(ctx context.Context, path string, body any) (*http.Response, error) {
	var rdr io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		rdr = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, h.Server+path, rdr)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+h.Key)
	return h.Client.Do(req)
}

// Claim implements Control. A 204 is "nothing queued" — an idle result, not an
// error. Anything else non-2xx is an error the caller treats as fatal, because
// a worker that cannot talk to its control plane has nothing useful to do.
func (h *HTTPControl) Claim(ctx context.Context) (*Job, error) {
	resp, err := h.do(ctx, "/scan-jobs/claim", nil)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNoContent {
		return nil, nil
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, serverError(resp)
	}
	var job Job
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&job); err != nil {
		return nil, fmt.Errorf("decode claim response: %w", err)
	}
	if job.JobID == "" || job.ProjectID == "" || job.CloneURL == "" || job.OnboardToken == "" {
		return nil, errors.New("claim response is missing required fields")
	}
	return &job, nil
}

// Report implements Control.
func (h *HTTPControl) Report(ctx context.Context, job *Job, status, reason string) error {
	body := map[string]string{"projectId": job.ProjectID, "status": status}
	if status == "failed" && reason != "" {
		body["error"] = reason
	}
	resp, err := h.do(ctx, "/scan-jobs/"+url.PathEscape(job.JobID)+"/status", body)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return serverError(resp)
	}
	return nil
}

// serverError renders a non-2xx without ever echoing back a credential: only
// the status line and a bounded snippet of the server's own error body, which
// is the error taxonomy's {code, reason} and contains no secrets.
func serverError(resp *http.Response) error {
	snippet, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
	return fmt.Errorf("server responded %s: %s", resp.Status, strings.TrimSpace(string(snippet)))
}

/* ── the real scanner: the SAME onboard flow a local run uses ───────────────── */

// OnboardScanner runs the standard onboard flow against the checkout. It passes
// an EMPTY TrustedCommit on purpose: that is the branch that prescans, writes
// the artifact pair, uploads, and stops — the terraform branch is not merely
// skipped, it is unreachable from here.
type OnboardScanner struct{}

// uploadWatcher wraps the production uploader so the worker learns whether the
// PUT actually landed. onboard.Run deliberately does not surface that (a local
// operator still has the files on disk); the worker has nothing on disk to fall
// back to, so for it "did the upload land" IS the outcome.
type uploadWatcher struct {
	inner    onboard.Uploader
	uploaded bool
	lastErr  error
}

func (u *uploadWatcher) UploadTrustRequest(server, projectID, token string, body onboard.TrustRequestUpload) error {
	err := u.inner.UploadTrustRequest(server, projectID, token, body)
	u.lastErr = err
	u.uploaded = err == nil
	return err
}

// ScanAndUpload implements Scanner.
func (OnboardScanner) ScanAndUpload(job *Job, repoDir, outDir, server string, out io.Writer) (bool, error) {
	w := &uploadWatcher{inner: onboard.HTTPUploader()}
	code := onboard.Run(onboard.Opts{
		Root:      repoDir,
		ProjectID: job.ProjectID,
		// EMPTY on purpose — see the type doc. This is the trust-request stop.
		TrustedCommit: "",
		OutDir:        outDir,
		Server:        server,
		OnboardToken:  job.OnboardToken,
		// No CI provenance: this scan was run by the control plane itself, not
		// by a forge pipeline, so there is no run URL to point the reviewing
		// admins at. Claiming one would be a lie in the trust review.
		CI: nil,
	}, nil, w, out)

	if w.uploaded {
		// Exit 0 (clean verdict) and exit 2 (PRESCAN_REJECT) are BOTH successful
		// scans — see runJob. The distinction the operator cares about is the
		// verdict, which is in the uploaded report.
		return true, nil
	}
	if w.lastErr != nil {
		return false, w.lastErr
	}
	return false, fmt.Errorf("onboard exited %d without uploading", code)
}
