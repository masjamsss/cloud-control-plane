// Upload seam for `catalogctl onboard --server` (spec: docs/superpowers/specs/
// 2026-07-24-easy-first-import.md §3 option C; ADR-0031). This is purely
// additive on top of the file-writing flow in onboard.go: Run calls
// attemptUpload only AFTER an artifact is already safely on --out, on both
// verdicts, and an upload failure here never changes Run's exit code or
// touches a file already written — the operator's fallback is exactly
// today's manual paste into Admin → Projects.
package onboard

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

// TrustRequestTriple is the {repo, commitSha, prescanSha256} binding — the
// exact shape trust-request.json is written as on the clean-verdict stop
// (onboard.go's trust-gate branch) and the exact shape
// ccp/api/openapi/ccp-api.yaml's `PUT /projects/{id}/trust-request`
// requestBody.trustRequest requires (mirrors ccp/app/src/lib/httpApi.ts
// TrustRequestUpload.trustRequest byte-for-byte).
type TrustRequestTriple struct {
	Repo          string `json:"repo"`
	CommitSha     string `json:"commitSha"`
	PrescanSha256 string `json:"prescanSha256"`
}

// TrustRequestUpload is the exact `PUT /projects/:id/trust-request` body: the
// trust-request triple plus the RAW prescan-report.json bytes as text — the
// server recomputes sha256 over prescanReport itself, so it is sent verbatim
// and never re-serialized client-side (ccp/app/src/lib/httpApi.ts;
// ccp/api/openapi/ccp-api.yaml). The optional `ci` block names the CI run that
// produced the upload so the two reviewing admins can check it against the
// forge's own run log (ADR-0031 option A); it is omitted (nil) on a local run.
type TrustRequestUpload struct {
	TrustRequest  TrustRequestTriple `json:"trustRequest"`
	PrescanReport string             `json:"prescanReport"`
	Ci            *CiProvenance      `json:"ci,omitempty"`
}

// CiProvenance is the optional {host, runUrl} block identifying the CI run that
// produced an onboarding upload. It mirrors ccp/api's own CiProvenance zod
// schema (store/schema.ts) byte-for-byte: `host` is exactly "github" or
// "gitlab", `runUrl` is an https URL — the server's schema is `.strict()`, so a
// malformed block is REJECTED rather than ignored. detectCIProvenance therefore
// only ever returns a block it has already validated, and returns nil otherwise
// (a local run, or a CI env missing the vars) so the field is simply omitted.
type CiProvenance struct {
	Host   string `json:"host"`
	RunUrl string `json:"runUrl"`
}

// detectCIProvenance reads the ambient CI environment and returns the run's
// {host, runUrl} when — and only when — it can assemble a valid https URL under
// the server's length cap; otherwise nil. Kept env-driven and standalone so the
// CLI wiring (run) sets it once and the pure upload path stays deterministic
// given Opts. Supported: GitHub Actions and GitLab CI (the two forges the
// one-shot onboarding workflow ships for, ADR-0031 §3-A-i).
func detectCIProvenance() *CiProvenance {
	// GitHub Actions: GITHUB_SERVER_URL is the forge origin (https://github.com
	// or an Enterprise host), GITHUB_REPOSITORY is owner/name.
	if os.Getenv("GITHUB_ACTIONS") == "true" {
		server, repo, runID := os.Getenv("GITHUB_SERVER_URL"), os.Getenv("GITHUB_REPOSITORY"), os.Getenv("GITHUB_RUN_ID")
		if server != "" && repo != "" && runID != "" {
			u := strings.TrimRight(server, "/") + "/" + repo + "/actions/runs/" + runID
			if validRunURL(u) {
				return &CiProvenance{Host: "github", RunUrl: u}
			}
		}
	}
	// GitLab CI: CI_PIPELINE_URL is the run page directly.
	if os.Getenv("GITLAB_CI") == "true" {
		if u := os.Getenv("CI_PIPELINE_URL"); validRunURL(u) {
			return &CiProvenance{Host: "gitlab", RunUrl: u}
		}
	}
	return nil
}

// validRunURL enforces exactly what the server's CiProvenance.runUrl requires
// (https scheme, <=500 chars) so detectCIProvenance never emits a block the
// strict server schema would 422 on.
func validRunURL(u string) bool {
	return strings.HasPrefix(u, "https://") && len(u) <= 500
}

// Uploader is the upload seam: Run() calls it only after both artifacts are
// already persisted to --out, and never touches net/http directly itself —
// tests inject a fake so the contract ("zero calls without --server/token",
// "strictly after persist", "only these two files") is asserted without a
// live server.
type Uploader interface {
	// UploadTrustRequest PUTs body to <server>/projects/<projectID>/trust-request
	// with header "Authorization: Bearer <token>". A non-nil error covers BOTH
	// an unreachable server and a non-2xx response — Run() treats them
	// identically: the files already on disk are left untouched and the
	// process exit code is unaffected (see attemptUpload).
	UploadTrustRequest(server, projectID, token string, body TrustRequestUpload) error
}

// httpUploader is the real, production Uploader: plain net/http, one attempt,
// no retries. Unlike scripts/gen-project-data.sh's curl --retry (a CI
// context), a laptop run is interactive — on failure we print the manual-
// paste fallback immediately rather than blocking the operator on retries.
type httpUploader struct{}

// uploadHTTPTimeout bounds a single upload attempt so a stalled connection
// can't hang the CLI forever. Generous because a prescan report can run into
// the hundreds of KB on a large repo.
const uploadHTTPTimeout = 30 * time.Second

func (httpUploader) UploadTrustRequest(server, projectID, token string, body TrustRequestUpload) error {
	b, err := json.Marshal(body)
	if err != nil {
		return fmt.Errorf("encode upload body: %w", err)
	}
	req, err := http.NewRequest(http.MethodPut, endpointURL(server, projectID), bytes.NewReader(b))
	if err != nil {
		return fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)

	client := &http.Client{Timeout: uploadHTTPTimeout}
	resp, err := client.Do(req)
	if err != nil {
		return err // unreachable: DNS/connect/timeout/TLS — the air-gapped/offline case
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		snippet, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return fmt.Errorf("server responded %s: %s", resp.Status, strings.TrimSpace(string(snippet)))
	}
	return nil
}

// endpointURL is the exact URL httpUploader PUTs to, factored out so Run's
// success/failure messages can name it without a real request and without
// duplicating the join logic.
func endpointURL(server, projectID string) string {
	return strings.TrimRight(server, "/") + "/projects/" + url.PathEscape(projectID) + "/trust-request"
}

// attemptUpload PUTs the two just-persisted artifacts to opts.Server's
// pre-trust lane when both --server and CCP_ONBOARD_TOKEN are configured —
// pure convenience layered on files that are ALREADY safely on disk (spec §3
// option C). Callers invoke it strictly after the relevant write(s) succeed,
// on both the reject and clean-stop paths (a rejected report's findings must
// reach the wizard too), and its outcome never changes Run's return code or
// the files themselves: a reachability or HTTP error just means the operator
// falls back to pasting the two files by hand, exactly as if --server had
// never been passed (the reachability-vs-HTTP-error framing mirrors
// scripts/gen-project-data.sh, which treats both as "keep the artifact,
// don't fail the run" for a local/interactive invocation).
//
// Returns true only on a confirmed 2xx upload, so callers can skip printing
// the now-redundant "upload this by hand" instruction.
func attemptUpload(w io.Writer, opts Opts, uploader Uploader, tr TrustRequestTriple, prescanBytes []byte) bool {
	if opts.Server == "" {
		return false // today's behavior: no flag, no network activity at all
	}
	if opts.OnboardToken == "" {
		fmt.Fprintf(w, "note: --server set but %s is not in the environment — skipping upload; the files are already on disk, paste them by hand instead\n", onboardTokenEnv)
		return false
	}
	if uploader == nil {
		fmt.Fprintln(w, "internal: --server set but no uploader wired; skipping upload")
		return false
	}
	body := TrustRequestUpload{TrustRequest: tr, PrescanReport: string(prescanBytes), Ci: opts.CI}
	if err := uploader.UploadTrustRequest(opts.Server, opts.ProjectID, opts.OnboardToken, body); err != nil {
		dir := opts.OutDir
		if dir == "" {
			dir = "."
		}
		// "the scan artifact(s)" — deliberately not "both files": a reject
		// verdict never writes trust-request.json to disk (onboard.go's
		// reject branch returns before that write), so only prescan-
		// report.json exists there; the clean-stop path writes both.
		fmt.Fprintf(w, "upload to %s failed: %v\n", endpointURL(opts.Server, opts.ProjectID), err)
		fmt.Fprintf(w, "  the scan artifact(s) already saved in %s are untouched — paste them by hand instead (Admin → Projects, wizard step ②)\n", dir)
		return false
	}
	fmt.Fprintf(w, "uploaded the scan artifacts (trust-request + prescan-report) to %s\n", endpointURL(opts.Server, opts.ProjectID))
	fmt.Fprintln(w, "  next: in Admin → Projects, review the verdict and findings (wizard step ③)")
	return true
}
