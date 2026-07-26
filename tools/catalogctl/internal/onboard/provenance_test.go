package onboard

import (
	"bytes"
	"path/filepath"
	"testing"
)

// clearCIEnv resets every CI variable detectCIProvenance reads, so a case runs
// hermetically even ON GitHub Actions / GitLab CI (where these are really set).
// t.Setenv restores the originals when the test ends.
func clearCIEnv(t *testing.T) {
	for _, k := range []string{
		"GITHUB_ACTIONS", "GITHUB_SERVER_URL", "GITHUB_REPOSITORY", "GITHUB_RUN_ID",
		"GITLAB_CI", "CI_PIPELINE_URL",
	} {
		t.Setenv(k, "")
	}
}

// detectCIProvenance only ever returns a block it has already validated against
// the server's strict CiProvenance schema (host ∈ {github,gitlab}, https runUrl,
// ≤500 chars); anything else ⇒ nil, so the optional field is omitted rather than
// sent malformed.
func TestCIProvenance_Detection(t *testing.T) {
	t.Run("github actions -> {github, run url}", func(t *testing.T) {
		clearCIEnv(t)
		t.Setenv("GITHUB_ACTIONS", "true")
		t.Setenv("GITHUB_SERVER_URL", "https://github.com")
		t.Setenv("GITHUB_REPOSITORY", "example-org/terraform-example")
		t.Setenv("GITHUB_RUN_ID", "42")
		got := detectCIProvenance()
		want := &CiProvenance{Host: "github", RunUrl: "https://github.com/example-org/terraform-example/actions/runs/42"}
		if got == nil || *got != *want {
			t.Fatalf("got %+v, want %+v", got, want)
		}
	})

	t.Run("gitlab ci -> {gitlab, pipeline url}", func(t *testing.T) {
		clearCIEnv(t)
		t.Setenv("GITLAB_CI", "true")
		t.Setenv("CI_PIPELINE_URL", "https://gitlab.com/example-org/terraform-example/-/pipelines/7")
		got := detectCIProvenance()
		want := &CiProvenance{Host: "gitlab", RunUrl: "https://gitlab.com/example-org/terraform-example/-/pipelines/7"}
		if got == nil || *got != *want {
			t.Fatalf("got %+v, want %+v", got, want)
		}
	})

	t.Run("no CI env -> nil (local run)", func(t *testing.T) {
		clearCIEnv(t)
		if got := detectCIProvenance(); got != nil {
			t.Fatalf("got %+v, want nil (a local run adds no provenance)", got)
		}
	})

	t.Run("github with a missing var -> nil (omit, never send an incomplete block)", func(t *testing.T) {
		clearCIEnv(t)
		t.Setenv("GITHUB_ACTIONS", "true")
		t.Setenv("GITHUB_SERVER_URL", "https://github.com")
		t.Setenv("GITHUB_REPOSITORY", "example-org/terraform-example")
		// GITHUB_RUN_ID deliberately unset
		if got := detectCIProvenance(); got != nil {
			t.Fatalf("got %+v, want nil", got)
		}
	})

	t.Run("non-https forge origin -> nil (server schema requires https)", func(t *testing.T) {
		clearCIEnv(t)
		t.Setenv("GITHUB_ACTIONS", "true")
		t.Setenv("GITHUB_SERVER_URL", "http://insecure.example")
		t.Setenv("GITHUB_REPOSITORY", "example-org/terraform-example")
		t.Setenv("GITHUB_RUN_ID", "42")
		if got := detectCIProvenance(); got != nil {
			t.Fatalf("got %+v, want nil (http:// must never be sent)", got)
		}
	})
}

// The provenance on Opts.CI rides the upload body verbatim, and is omitted when
// nil (a local run) — so the reviewing admins see a CI run link only for a scan
// that actually came from CI.
func TestUpload_CarriesCIProvenance(t *testing.T) {
	ci := &CiProvenance{Host: "github", RunUrl: "https://github.com/example-org/terraform-example/actions/runs/42"}

	t.Run("Opts.CI set -> body.Ci carries it", func(t *testing.T) {
		withStubs(t, "abc123def456", "1.15.7", nil)
		dir := t.TempDir()
		fu := &fakeUploader{}
		var out bytes.Buffer
		code := Run(Opts{
			Root: filepath.Join(fixtures, "clean-repo"), ProjectID: "p1", OutDir: dir,
			Server: "https://ccp.example.test", OnboardToken: "tok", CI: ci,
		}, &fakeRunner{}, fu, &out)
		if code != 0 {
			t.Fatalf("exit = %d\n%s", code, out.String())
		}
		if len(fu.calls) != 1 || fu.calls[0].body.Ci == nil || *fu.calls[0].body.Ci != *ci {
			t.Fatalf("body.Ci = %+v, want %+v", fu.calls[0].body.Ci, ci)
		}
	})

	t.Run("Opts.CI nil -> body.Ci omitted", func(t *testing.T) {
		withStubs(t, "abc123def456", "1.15.7", nil)
		dir := t.TempDir()
		fu := &fakeUploader{}
		var out bytes.Buffer
		code := Run(Opts{
			Root: filepath.Join(fixtures, "clean-repo"), ProjectID: "p1", OutDir: dir,
			Server: "https://ccp.example.test", OnboardToken: "tok", // CI left nil
		}, &fakeRunner{}, fu, &out)
		if code != 0 {
			t.Fatalf("exit = %d\n%s", code, out.String())
		}
		if len(fu.calls) != 1 || fu.calls[0].body.Ci != nil {
			t.Fatalf("body.Ci = %+v, want nil", fu.calls[0].body.Ci)
		}
	})
}
