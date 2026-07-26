package prprep

import (
	"bytes"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/cli"
	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/manifests"
	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/request"

	_ "github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/edit" // installs cli.Edit
)

// covprprep_cov_test.go exercises the `pr-prepare` contract end to end against the
// committed fixture manifest catalog (testdata/manifests) — no network, no AWS, no
// terraform binary, no clock. It covers the four pre-file refusal guards (UNAPPROVED,
// DIGEST_DISAGREEMENT, TARGET_MISMATCH, EMPTY_DIFF), the bubbled-up `edit` refusals
// (FMT_DIRTY), the exit-3 argument/schema surface, the exit-1 internal surface, and
// the PR body renderer.

// covprprepManifests is the committed fixture catalog (ec2-resize = set_attribute with
// a source:"inventory" param, so inventoryAddr resolves a real address).
const covprprepManifests = "../../testdata/manifests"

const covprprepID = "REQ-00000000000000000000000000"

// covprprepReqOpts describes the ccp.request/v1 YAML a case needs.
type covprprepReqOpts struct {
	id            string
	item          string
	params        map[string]string
	target        string
	createdAt     string
	justification string
	// approvals is rendered verbatim under `approvals:`; empty ⇒ the key is omitted
	// entirely (the UNAPPROVED shape).
	approvals []string
	window    [3]string // start, end, tz — all empty ⇒ no window key
	earliest  string
	schema    string
}

// covprprepWriteRequest renders opts to a request YAML in its own temp dir and returns
// the path. Deterministic: params are emitted in sorted key order.
func covprprepWriteRequest(t *testing.T, opts covprprepReqOpts) string {
	t.Helper()
	if opts.id == "" {
		opts.id = covprprepID
	}
	if opts.schema == "" {
		opts.schema = "ccp.request/v1"
	}
	if opts.justification == "" {
		opts.justification = "coverage pass justification"
	}
	var b strings.Builder
	b.WriteString("schema: " + opts.schema + "\n")
	b.WriteString("id: " + opts.id + "\n")
	b.WriteString("item: " + opts.item + "\n")
	b.WriteString("requester_login: ops-lead\n")
	b.WriteString("justification: " + covprprepQuote(opts.justification) + "\n")
	if opts.createdAt != "" {
		b.WriteString("created_at: " + covprprepQuote(opts.createdAt) + "\n")
	}
	if opts.target != "" {
		b.WriteString("target: " + covprprepQuote(opts.target) + "\n")
	}
	if opts.earliest != "" {
		b.WriteString("earliest_apply_at: " + covprprepQuote(opts.earliest) + "\n")
	}
	if opts.window[0] != "" {
		b.WriteString("window:\n")
		b.WriteString("  start: " + covprprepQuote(opts.window[0]) + "\n")
		b.WriteString("  end: " + covprprepQuote(opts.window[1]) + "\n")
		b.WriteString("  tz: " + covprprepQuote(opts.window[2]) + "\n")
	}
	if len(opts.params) > 0 {
		b.WriteString("params:\n")
		keys := make([]string, 0, len(opts.params))
		for k := range opts.params {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			b.WriteString("  " + k + ": " + covprprepQuote(opts.params[k]) + "\n")
		}
	}
	if len(opts.approvals) > 0 {
		b.WriteString("approvals:\n")
		for _, a := range opts.approvals {
			b.WriteString(a)
		}
	}
	p := filepath.Join(t.TempDir(), "request.yaml")
	if err := os.WriteFile(p, []byte(b.String()), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

func covprprepQuote(s string) string {
	return "\"" + strings.ReplaceAll(s, "\"", "\\\"") + "\""
}

// covprprepApproval renders one approvals[] entry.
func covprprepApproval(approver, digest string) string {
	return "  - approver: " + approver + "\n" +
		"    approved_at: \"2026-07-15T10:00:00Z\"\n" +
		"    policy_version: v1\n" +
		"    digest: " + covprprepQuote(digest) + "\n" +
		"    decision: approve\n"
}

// covprprepResizeParams is a valid ec2-resize param set (the allowlist is enforced by
// manifests.Validate, so the value must be a real allowlisted size).
func covprprepResizeParams(newType string) map[string]string {
	return map[string]string{"instance": "aws_instance.foo", "new_instance_type": newType}
}

// covprprepEnv writes a single fmt-canonical .tf holding aws_instance.foo at
// instanceType and returns the env dir.
func covprprepEnv(t *testing.T, instanceType string) string {
	t.Helper()
	dir := t.TempDir()
	covprprepWrite(t, filepath.Join(dir, "main.tf"),
		"resource \"aws_instance\" \"foo\" {\n  instance_type = \""+instanceType+"\"\n}\n")
	return dir
}

func covprprepWrite(t *testing.T, path, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

// covprprepBundle lists every regular file under dir, slash-relative and sorted.
func covprprepBundle(t *testing.T, dir string) []string {
	t.Helper()
	var out []string
	err := filepath.WalkDir(dir, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}
		rel, err := filepath.Rel(dir, path)
		if err != nil {
			return err
		}
		out = append(out, filepath.ToSlash(rel))
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	sort.Strings(out)
	return out
}

// --- accept path -----------------------------------------------------------------

// TestCovprprepAcceptBundle proves the whole artifact bundle: the edited .tf at its
// repo-relative env path, the verbatim request, the PENDING plan-digest placeholder,
// the redacted diff, the PR body — plus the deterministic stdout manifest and the
// invariant that the caller's env tree is never mutated.
func TestCovprprepAcceptBundle(t *testing.T) {
	env := covprprepEnv(t, "r6i.large")
	out := filepath.Join(t.TempDir(), "bundle")
	reqPath := covprprepWriteRequest(t, covprprepReqOpts{
		item:      "ec2-resize",
		params:    covprprepResizeParams("c6i.2xlarge"),
		target:    "aws_instance.foo",
		createdAt: "2026-07-01T09:00:00Z",
		approvals: []string{covprprepApproval("ops-lead", "abc123")},
	})
	reqBytes, err := os.ReadFile(reqPath)
	if err != nil {
		t.Fatal(err)
	}

	var stdout, stderr bytes.Buffer
	code := run([]string{
		"--request", reqPath, "--manifests", covprprepManifests,
		"--env", env, "--out", out,
	}, &stdout, &stderr)
	if code != 0 {
		t.Fatalf("exit %d, want 0; stderr=%s", code, stderr.String())
	}

	// (a) the exact bundle file set, at the default env prefix.
	want := []string{
		"PR_BODY.md",
		"environments/prod/main.tf",
		"requests/" + covprprepID + ".diff",
		"requests/" + covprprepID + ".plan-digest",
		"requests/" + covprprepID + ".yaml",
	}
	if got := covprprepBundle(t, out); !covprprepEqual(got, want) {
		t.Errorf("bundle files = %v, want %v", got, want)
	}

	// (b) the edited file carries the new value.
	edited := covprprepRead(t, filepath.Join(out, "environments", "prod", "main.tf"))
	if !strings.Contains(edited, `instance_type = "c6i.2xlarge"`) {
		t.Errorf("bundle main.tf not edited:\n%s", edited)
	}

	// (c) the request is copied byte-for-byte (evidence must not be re-serialized).
	if got := covprprepRead(t, filepath.Join(out, "requests", covprprepID+".yaml")); got != string(reqBytes) {
		t.Errorf("request artifact is not verbatim:\ngot:\n%s\nwant:\n%s", got, reqBytes)
	}

	// (d) the plan-digest placeholder is PENDING with an empty sha256 slot.
	digest := covprprepRead(t, filepath.Join(out, "requests", covprprepID+".plan-digest"))
	for _, sub := range []string{"# plan digest for " + covprprepID, "status: PENDING", "algorithm: sha256", "digest: \"\""} {
		if !strings.Contains(digest, sub) {
			t.Errorf("plan-digest placeholder missing %q:\n%s", sub, digest)
		}
	}

	// (e) the diff is the redacted unified diff, labelled at the env prefix.
	diff := covprprepRead(t, filepath.Join(out, "requests", covprprepID+".diff"))
	for _, sub := range []string{"a/environments/prod/main.tf", "b/environments/prod/main.tf", `-  instance_type = "r6i.large"`, `+  instance_type = "c6i.2xlarge"`} {
		if !strings.Contains(diff, sub) {
			t.Errorf("diff artifact missing %q:\n%s", sub, diff)
		}
	}

	// (f) the stdout manifest: identity, sorted file list, and the documented gh seam.
	s := stdout.String()
	for _, sub := range []string{
		"pr-prepare: " + covprprepID + " (ec2-resize)",
		"branch: ccp/" + covprprepID,
		"title:  ccp(ec2-resize): " + covprprepID,
		"seam (run from the bundle dir, not executed here):",
		"gh pr create --head ccp/" + covprprepID,
		"--body-file PR_BODY.md --label ccp:approved",
	} {
		if !strings.Contains(s, sub) {
			t.Errorf("stdout missing %q:\n%s", sub, s)
		}
	}
	// The file list is printed sorted.
	var listed []string
	for _, line := range strings.Split(s, "\n") {
		if strings.HasPrefix(line, "    ") && !strings.HasPrefix(line, "    gh ") {
			listed = append(listed, strings.TrimSpace(line))
		}
	}
	if !covprprepEqual(listed, want) {
		t.Errorf("printed file list = %v, want the sorted bundle %v", listed, want)
	}

	// (g) the caller's env tree is untouched — pr-prepare edits a throwaway copy.
	if orig := covprprepRead(t, filepath.Join(env, "main.tf")); !strings.Contains(orig, `"r6i.large"`) {
		t.Errorf("caller env tree was mutated:\n%s", orig)
	}
}

// TestCovprprepAcceptEnvPrefixAndSubtree proves --env-prefix relabels both the bundle
// path and the diff labels, that nested env subdirectories are copied into the work
// tree (and unchanged files stay out of the bundle), and that catalogctl's own
// atomic-write temp files are never harvested.
func TestCovprprepAcceptEnvPrefixAndSubtree(t *testing.T) {
	env := covprprepEnv(t, "r6i.large")
	// An untouched sibling in a nested dir, plus a stray atomic-write temp file.
	covprprepWrite(t, filepath.Join(env, "modules", "net", "net.tf"),
		"resource \"aws_instance\" \"bar\" {\n  instance_type = \"m6i.xlarge\"\n}\n")
	covprprepWrite(t, filepath.Join(env, ".catalogctl-scratch"), "junk\n")
	out := t.TempDir()
	reqPath := covprprepWriteRequest(t, covprprepReqOpts{
		item:      "ec2-resize",
		params:    covprprepResizeParams("c6i.2xlarge"),
		approvals: []string{covprprepApproval("ops-lead", "abc123")},
	})

	var stdout, stderr bytes.Buffer
	code := run([]string{
		"--request", reqPath, "--manifests", covprprepManifests,
		"--env", env, "--out", out, "--env-prefix", "envs/staging",
	}, &stdout, &stderr)
	if code != 0 {
		t.Fatalf("exit %d, want 0; stderr=%s", code, stderr.String())
	}

	want := []string{
		"PR_BODY.md",
		"envs/staging/main.tf",
		"requests/" + covprprepID + ".diff",
		"requests/" + covprprepID + ".plan-digest",
		"requests/" + covprprepID + ".yaml",
	}
	got := covprprepBundle(t, out)
	if !covprprepEqual(got, want) {
		t.Fatalf("bundle files = %v, want %v (unchanged subtree files and .catalogctl-* temps must not be harvested)", got, want)
	}
	diff := covprprepRead(t, filepath.Join(out, "requests", covprprepID+".diff"))
	if !strings.Contains(diff, "a/envs/staging/main.tf") {
		t.Errorf("diff labels ignore --env-prefix:\n%s", diff)
	}
}

// TestCovprprepAcceptForwardsEstateTZ proves the outer --estate-tz is threaded into
// the inner `edit` invocation: a request windowed at a non-default estate zone loads
// on both sides and the window is carried into the PR body verbatim.
func TestCovprprepAcceptForwardsEstateTZ(t *testing.T) {
	env := covprprepEnv(t, "r6i.large")
	out := t.TempDir()
	reqPath := covprprepWriteRequest(t, covprprepReqOpts{
		item:      "ec2-resize",
		params:    covprprepResizeParams("c6i.2xlarge"),
		approvals: []string{covprprepApproval("ops-lead", "abc123")},
		window:    [3]string{"2026-08-01T02:00:00Z", "2026-08-01T04:00:00Z", "America/New_York"},
		earliest:  "2026-07-31T00:00:00Z",
	})

	var stdout, stderr bytes.Buffer
	code := run([]string{
		"--request", reqPath, "--manifests", covprprepManifests,
		"--env", env, "--out", out, "--estate-tz", "America/New_York",
	}, &stdout, &stderr)
	if code != 0 {
		t.Fatalf("exit %d, want 0; stderr=%s", code, stderr.String())
	}
	body := covprprepRead(t, filepath.Join(out, "PR_BODY.md"))
	if !strings.Contains(body, "**Window:** 2026-08-01T02:00:00Z → 2026-08-01T04:00:00Z (America/New_York)") {
		t.Errorf("PR body missing the carried-forward window:\n%s", body)
	}
	if !strings.Contains(body, "**Earliest apply:** 2026-07-31T00:00:00Z") {
		t.Errorf("PR body missing earliest-apply:\n%s", body)
	}
}

// --- refusal guards (exit 2) ------------------------------------------------------

func TestCovprprepRefusals(t *testing.T) {
	cases := []struct {
		name    string
		code    string
		reason  string // substring of the REFUSE reason
		opts    covprprepReqOpts
		current string // env instance_type
	}{
		{
			name:   "unapproved request never becomes a PR",
			code:   "UNAPPROVED",
			reason: "carries no approvals",
			opts: covprprepReqOpts{
				item:   "ec2-resize",
				params: covprprepResizeParams("c6i.2xlarge"),
			},
			current: "r6i.large",
		},
		{
			name:   "split-brain quorum binds two different plan digests",
			code:   "DIGEST_DISAGREEMENT",
			reason: "approvals bind to different plan digests",
			opts: covprprepReqOpts{
				item:   "ec2-resize",
				params: covprprepResizeParams("c6i.2xlarge"),
				approvals: []string{
					covprprepApproval("ops-lead", "aaa111"),
					covprprepApproval("sre-oncall", "bbb222"),
				},
			},
			current: "r6i.large",
		},
		{
			name:   "stamped target disagrees with the op inventory address",
			code:   "TARGET_MISMATCH",
			reason: `request target "aws_instance.other" != op inventory address "aws_instance.foo"`,
			opts: covprprepReqOpts{
				item:      "ec2-resize",
				params:    covprprepResizeParams("c6i.2xlarge"),
				target:    "aws_instance.other",
				approvals: []string{covprprepApproval("ops-lead", "abc123")},
			},
			current: "r6i.large",
		},
		{
			name:   "verified no-op edit is not a PR",
			code:   "EMPTY_DIFF",
			reason: "edits nothing (verified no-op)",
			opts: covprprepReqOpts{
				item:      "ec2-resize",
				params:    covprprepResizeParams("c6i.2xlarge"),
				approvals: []string{covprprepApproval("ops-lead", "abc123")},
			},
			current: "c6i.2xlarge", // already at the requested size
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			env := covprprepEnv(t, tc.current)
			out := t.TempDir()
			reqPath := covprprepWriteRequest(t, tc.opts)

			var stdout, stderr bytes.Buffer
			code := run([]string{
				"--request", reqPath, "--manifests", covprprepManifests,
				"--env", env, "--out", out,
			}, &stdout, &stderr)
			if code != 2 {
				t.Fatalf("exit %d, want 2; stderr=%s", code, stderr.String())
			}
			wantLine := "REFUSE " + tc.code + ": "
			if !strings.Contains(stderr.String(), wantLine) {
				t.Errorf("stderr = %q, want a %s refusal", stderr.String(), tc.code)
			}
			if !strings.Contains(stderr.String(), tc.reason) {
				t.Errorf("refusal reason missing %q:\n%s", tc.reason, stderr.String())
			}
			// A refusal writes nothing: no bundle, ever.
			if files := covprprepBundle(t, out); len(files) != 0 {
				t.Errorf("refusal wrote a bundle: %v", files)
			}
			if stdout.Len() != 0 {
				t.Errorf("refusal printed to stdout: %q", stdout.String())
			}
		})
	}
}

// TestCovprprepAllEmptyDigestsAreNotDisagreement pins the ApprovedDigest contract at
// the pr-prepare boundary: approvals that carry NO digest yet (pre-plan quorum) are
// not a split-brain — the bundle is produced and the PR body says the binding is
// pending.
func TestCovprprepAllEmptyDigestsAreNotDisagreement(t *testing.T) {
	env := covprprepEnv(t, "r6i.large")
	out := t.TempDir()
	reqPath := covprprepWriteRequest(t, covprprepReqOpts{
		item:   "ec2-resize",
		params: covprprepResizeParams("c6i.2xlarge"),
		approvals: []string{
			covprprepApproval("ops-lead", ""),
			covprprepApproval("sre-oncall", ""),
		},
	})
	var stdout, stderr bytes.Buffer
	if code := run([]string{
		"--request", reqPath, "--manifests", covprprepManifests,
		"--env", env, "--out", out,
	}, &stdout, &stderr); code != 0 {
		t.Fatalf("exit %d, want 0 (all-empty digests are not a disagreement); stderr=%s", code, stderr.String())
	}
	body := covprprepRead(t, filepath.Join(out, "PR_BODY.md"))
	if !strings.Contains(body, "**Bound plan digest:** _pending_") {
		t.Errorf("PR body should mark the digest binding pending:\n%s", body)
	}
}

// TestCovprprepEditRefusalIsSurfacedVerbatim proves a refusal raised inside `edit`
// (here FMT_DIRTY, from the non-canonical target file) exits 2 through pr-prepare with
// the original REFUSE line intact and no bundle written.
func TestCovprprepEditRefusalIsSurfacedVerbatim(t *testing.T) {
	env := t.TempDir()
	covprprepWrite(t, filepath.Join(env, "main.tf"),
		"resource \"aws_instance\" \"foo\" {\n    instance_type=\"r6i.large\"\n}\n")
	out := t.TempDir()
	reqPath := covprprepWriteRequest(t, covprprepReqOpts{
		item:      "ec2-resize",
		params:    covprprepResizeParams("c6i.2xlarge"),
		approvals: []string{covprprepApproval("ops-lead", "abc123")},
	})

	var stdout, stderr bytes.Buffer
	code := run([]string{
		"--request", reqPath, "--manifests", covprprepManifests,
		"--env", env, "--out", out,
	}, &stdout, &stderr)
	if code != 2 {
		t.Fatalf("exit %d, want 2 (FMT_DIRTY from edit); stderr=%s", code, stderr.String())
	}
	if !strings.Contains(stderr.String(), "REFUSE FMT_DIRTY") {
		t.Errorf("stderr lost edit's refusal line:\n%s", stderr.String())
	}
	if !strings.Contains(stderr.String(), "edit did not produce a change (exit 2) — no PR artifact written") {
		t.Errorf("stderr missing the no-artifact note:\n%s", stderr.String())
	}
	if files := covprprepBundle(t, out); len(files) != 0 {
		t.Errorf("bundle written despite an edit refusal: %v", files)
	}
}

// --- exit 3: arguments, config, schema -------------------------------------------

func TestCovprprepExit3Surface(t *testing.T) {
	goodEnv := covprprepEnv(t, "r6i.large")
	goodReq := covprprepWriteRequest(t, covprprepReqOpts{
		item:      "ec2-resize",
		params:    covprprepResizeParams("c6i.2xlarge"),
		approvals: []string{covprprepApproval("ops-lead", "abc123")},
	})
	// A manifests dir whose JSON does not decode → LoadDir schema error.
	badManifests := t.TempDir()
	covprprepWrite(t, filepath.Join(badManifests, "broken.json"), "{ not json ")
	// An empty manifests dir → the op is simply unknown.
	emptyManifests := t.TempDir()

	cases := []struct {
		name string
		args func(out string) []string
		want string // stderr substring
	}{
		{
			name: "unknown flag",
			args: func(out string) []string { return []string{"--nope"} },
			want: "flag provided but not defined",
		},
		{
			name: "no flags at all",
			args: func(out string) []string { return nil },
			want: "--request, --manifests, --env and --out are all required",
		},
		{
			name: "missing --out",
			args: func(out string) []string {
				return []string{"--request", goodReq, "--manifests", covprprepManifests, "--env", goodEnv}
			},
			want: "--request, --manifests, --env and --out are all required",
		},
		{
			name: "unresolvable estate timezone is a startup config error",
			args: func(out string) []string {
				return []string{"--request", goodReq, "--manifests", covprprepManifests,
					"--env", goodEnv, "--out", out, "--estate-tz", "Not/AZone"}
			},
			want: "does not resolve to a known IANA timezone",
		},
		{
			name: "request file does not exist",
			args: func(out string) []string {
				return []string{"--request", filepath.Join(goodEnv, "absent.yaml"),
					"--manifests", covprprepManifests, "--env", goodEnv, "--out", out}
			},
			want: "no such file or directory",
		},
		{
			name: "request fails schema validation",
			args: func(out string) []string {
				bad := covprprepWriteRequest(t, covprprepReqOpts{
					item: "ec2-resize", schema: "ccp.request/v2",
					approvals: []string{covprprepApproval("ops-lead", "abc123")},
				})
				return []string{"--request", bad, "--manifests", covprprepManifests,
					"--env", goodEnv, "--out", out}
			},
			want: `want ccp.request/v1`,
		},
		{
			name: "manifest catalog does not decode",
			args: func(out string) []string {
				return []string{"--request", goodReq, "--manifests", badManifests,
					"--env", goodEnv, "--out", out}
			},
			want: "broken.json",
		},
		{
			name: "op is not in the catalog",
			args: func(out string) []string {
				return []string{"--request", goodReq, "--manifests", emptyManifests,
					"--env", goodEnv, "--out", out}
			},
			want: `unknown op "ec2-resize"`,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			out := filepath.Join(t.TempDir(), "bundle")
			var stdout, stderr bytes.Buffer
			code := run(tc.args(out), &stdout, &stderr)
			if code != 3 {
				t.Fatalf("exit %d, want 3; stderr=%s", code, stderr.String())
			}
			if !strings.Contains(stderr.String(), tc.want) {
				t.Errorf("stderr = %q, want it to contain %q", stderr.String(), tc.want)
			}
			if _, err := os.Stat(out); !os.IsNotExist(err) {
				t.Errorf("an exit-3 error must not create the output dir")
			}
		})
	}
}

// --- exit 1: internal failures ----------------------------------------------------

// TestCovprprepBundleWriteFailures walks every artifact-writing step and proves an
// unwritable destination is an internal error (exit 1) with the reason on stderr —
// never a silently incomplete bundle.
func TestCovprprepBundleWriteFailures(t *testing.T) {
	cases := []struct {
		name string
		// prep returns the --out value, after arranging for one write to fail.
		prep func(t *testing.T) string
	}{
		{
			name: "--out itself is a regular file",
			prep: func(t *testing.T) string {
				p := filepath.Join(t.TempDir(), "not-a-dir")
				covprprepWrite(t, p, "x")
				return p
			},
		},
		{
			name: "the env-prefix path is blocked by a file",
			prep: func(t *testing.T) string {
				out := t.TempDir()
				covprprepWrite(t, filepath.Join(out, "environments"), "x")
				return out
			},
		},
		{
			name: "requests/ is blocked by a file",
			prep: func(t *testing.T) string {
				out := t.TempDir()
				covprprepWrite(t, filepath.Join(out, "requests"), "x")
				return out
			},
		},
		{
			name: "the plan-digest path is a directory",
			prep: func(t *testing.T) string {
				out := t.TempDir()
				if err := os.MkdirAll(filepath.Join(out, "requests", covprprepID+".plan-digest"), 0o755); err != nil {
					t.Fatal(err)
				}
				return out
			},
		},
		{
			name: "the diff path is a directory",
			prep: func(t *testing.T) string {
				out := t.TempDir()
				if err := os.MkdirAll(filepath.Join(out, "requests", covprprepID+".diff"), 0o755); err != nil {
					t.Fatal(err)
				}
				return out
			},
		},
		{
			name: "PR_BODY.md is a directory",
			prep: func(t *testing.T) string {
				out := t.TempDir()
				if err := os.MkdirAll(filepath.Join(out, "PR_BODY.md"), 0o755); err != nil {
					t.Fatal(err)
				}
				return out
			},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			env := covprprepEnv(t, "r6i.large")
			out := tc.prep(t)
			reqPath := covprprepWriteRequest(t, covprprepReqOpts{
				item:      "ec2-resize",
				params:    covprprepResizeParams("c6i.2xlarge"),
				approvals: []string{covprprepApproval("ops-lead", "abc123")},
			})
			var stdout, stderr bytes.Buffer
			code := run([]string{
				"--request", reqPath, "--manifests", covprprepManifests,
				"--env", env, "--out", out,
			}, &stdout, &stderr)
			if code != 1 {
				t.Fatalf("exit %d, want 1 (internal); stderr=%s", code, stderr.String())
			}
			if stderr.Len() == 0 {
				t.Error("an internal error must explain itself on stderr")
			}
			// The success manifest is never printed on a failed bundle.
			if strings.Contains(stdout.String(), "pr-prepare: ") {
				t.Errorf("success manifest printed despite a write failure:\n%s", stdout.String())
			}
		})
	}
}

// TestCovprprepMissingEnvTreeIsNotAPR proves a --env directory that does not exist
// fails closed with exit 3: reading the caller-supplied tree is RESOLUTION, exactly
// like the --request read, and exit 1 is reserved for catalogctl itself
// malfunctioning — a script dispatching on the exit code alone must not read an
// operator's `--env /typo` as an internal fault.
func TestCovprprepMissingEnvTreeIsNotAPR(t *testing.T) {
	out := t.TempDir()
	missing := filepath.Join(t.TempDir(), "no-such-env")
	reqPath := covprprepWriteRequest(t, covprprepReqOpts{
		item:      "ec2-resize",
		params:    covprprepResizeParams("c6i.2xlarge"),
		approvals: []string{covprprepApproval("ops-lead", "abc123")},
	})
	var stdout, stderr bytes.Buffer
	code := run([]string{
		"--request", reqPath, "--manifests", covprprepManifests,
		"--env", missing, "--out", out,
	}, &stdout, &stderr)
	if code != 3 {
		t.Fatalf("exit %d, want 3 (an unreadable --env tree is a resolution error, not an internal one); stderr=%s", code, stderr.String())
	}
	if !strings.Contains(stderr.String(), "no-such-env") {
		t.Errorf("stderr should name the missing env tree:\n%s", stderr.String())
	}
	if files := covprprepBundle(t, out); len(files) != 0 {
		t.Errorf("bundle written for a missing env tree: %v", files)
	}
}

// TestCovprprepUnreadableEnvEntry proves an env tree pr-prepare cannot faithfully
// snapshot (here a dangling symlink, which is neither a directory nor readable bytes)
// fails closed before `edit` runs: exit 3 (reading the caller's tree is resolution),
// the offending path on stderr, no bundle. A tree that cannot be copied byte-for-byte
// must never become a PR.
func TestCovprprepUnreadableEnvEntry(t *testing.T) {
	env := covprprepEnv(t, "r6i.large")
	if err := os.Symlink(filepath.Join(env, "gone.tf"), filepath.Join(env, "dangling.tf")); err != nil {
		t.Skipf("symlinks unavailable on this filesystem: %v", err)
	}
	out := t.TempDir()
	reqPath := covprprepWriteRequest(t, covprprepReqOpts{
		item:      "ec2-resize",
		params:    covprprepResizeParams("c6i.2xlarge"),
		approvals: []string{covprprepApproval("ops-lead", "abc123")},
	})
	var stdout, stderr bytes.Buffer
	code := run([]string{
		"--request", reqPath, "--manifests", covprprepManifests,
		"--env", env, "--out", out,
	}, &stdout, &stderr)
	if code != 3 {
		t.Fatalf("exit %d, want 3 (an unsnapshottable --env tree is a resolution error); stderr=%s", code, stderr.String())
	}
	if !strings.Contains(stderr.String(), "dangling.tf") {
		t.Errorf("stderr should name the unreadable entry:\n%s", stderr.String())
	}
	if files := covprprepBundle(t, out); len(files) != 0 {
		t.Errorf("bundle written from an unsnapshottable env tree: %v", files)
	}
}

// TestCovprprepUnwritableTempRoot proves the throwaway work-tree allocation failing is
// an internal error, not a partial bundle.
func TestCovprprepUnwritableTempRoot(t *testing.T) {
	t.Setenv("TMPDIR", filepath.Join(t.TempDir(), "absent-tmp-root"))
	env := covprprepEnv(t, "r6i.large")
	out := t.TempDir()
	reqPath := covprprepWriteRequest(t, covprprepReqOpts{
		item:      "ec2-resize",
		params:    covprprepResizeParams("c6i.2xlarge"),
		approvals: []string{covprprepApproval("ops-lead", "abc123")},
	})
	var stdout, stderr bytes.Buffer
	code := run([]string{
		"--request", reqPath, "--manifests", covprprepManifests,
		"--env", env, "--out", out,
	}, &stdout, &stderr)
	if code != 1 {
		t.Fatalf("exit %d, want 1 (cannot allocate the work tree); stderr=%s", code, stderr.String())
	}
	if files := covprprepBundle(t, out); len(files) != 0 {
		t.Errorf("bundle written without a work tree: %v", files)
	}
}

// TestCovprprepEditNotWired proves the wiring seam fails closed with exit 1 when the
// edit pipeline was not blank-imported, and that it does so AFTER the approval guards
// (a refusal still wins).
func TestCovprprepEditNotWired(t *testing.T) {
	saved := cli.Edit
	cli.Edit = nil
	t.Cleanup(func() { cli.Edit = saved })

	env := covprprepEnv(t, "r6i.large")
	out := t.TempDir()
	approved := covprprepWriteRequest(t, covprprepReqOpts{
		item:      "ec2-resize",
		params:    covprprepResizeParams("c6i.2xlarge"),
		approvals: []string{covprprepApproval("ops-lead", "abc123")},
	})
	var stdout, stderr bytes.Buffer
	if code := run([]string{
		"--request", approved, "--manifests", covprprepManifests,
		"--env", env, "--out", out,
	}, &stdout, &stderr); code != 1 {
		t.Fatalf("exit %d, want 1; stderr=%s", code, stderr.String())
	}
	if !strings.Contains(stderr.String(), "internal: edit not wired") {
		t.Errorf("stderr = %q, want the not-wired diagnosis", stderr.String())
	}

	// Guard ordering: UNAPPROVED is decided before the wiring is consulted.
	unapproved := covprprepWriteRequest(t, covprprepReqOpts{
		item:   "ec2-resize",
		params: covprprepResizeParams("c6i.2xlarge"),
	})
	stdout.Reset()
	stderr.Reset()
	if code := run([]string{
		"--request", unapproved, "--manifests", covprprepManifests,
		"--env", env, "--out", out,
	}, &stdout, &stderr); code != 2 {
		t.Fatalf("exit %d, want 2 (UNAPPROVED precedes the wiring check); stderr=%s", code, stderr.String())
	}
}

// --- helpers under test directly ---------------------------------------------------

// TestCovprprepInventoryAddr pins the inventory-address resolver, the value
// TARGET_MISMATCH cross-checks against.
func TestCovprprepInventoryAddr(t *testing.T) {
	ops := covprprepLoadOps(t)
	op, ok := ops["ec2-resize"]
	if !ok {
		t.Fatal("ec2-resize missing from the fixture catalog")
	}
	cases := []struct {
		name   string
		params map[string]any
		want   string
	}{
		{"resolves the inventory param", map[string]any{"instance": "aws_instance.foo"}, "aws_instance.foo"},
		{"absent inventory param resolves to empty", map[string]any{}, ""},
		{"non-string inventory param resolves to empty", map[string]any{"instance": 7}, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := inventoryAddr(op, tc.params); got != tc.want {
				t.Errorf("inventoryAddr = %q, want %q", got, tc.want)
			}
		})
	}
}

// TestCovprprepIdentityHelpers pins the deterministic bot-PR identity the gh seam
// consumes.
func TestCovprprepIdentityHelpers(t *testing.T) {
	r := &request.Request{ID: covprprepID, Item: "ec2-resize"}
	if got, want := branchName(r), "ccp/"+covprprepID; got != want {
		t.Errorf("branchName = %q, want %q", got, want)
	}
	if got, want := prTitle(r), "ccp(ec2-resize): "+covprprepID; got != want {
		t.Errorf("prTitle = %q, want %q", got, want)
	}
	if got := digestPlaceholder(r); !strings.HasSuffix(got, "digest: \"\"\n") {
		t.Errorf("digestPlaceholder must end with the empty digest slot:\n%s", got)
	}
}

// TestCovprprepDash pins the empty-cell renderers that keep the approvals table
// well-formed.
func TestCovprprepDash(t *testing.T) {
	for _, tc := range []struct{ in, want string }{{"", "—"}, {"ops-lead", "ops-lead"}} {
		if got := dash(tc.in); got != tc.want {
			t.Errorf("dash(%q) = %q, want %q", tc.in, got, tc.want)
		}
		if got := dashRaw(tc.in); got != tc.want {
			t.Errorf("dashRaw(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

// --- PR body renderer --------------------------------------------------------------

// TestCovprprepRenderPRBodyFull covers the fully-populated request: stamped target
// wins over the resolved one, created_at/window/earliest-apply all render, the bound
// digest is announced, estate artifacts are filtered out of the changed-file list, and
// the diff is fenced with its trailing newline trimmed.
func TestCovprprepRenderPRBodyFull(t *testing.T) {
	r := &request.Request{
		ID:              covprprepID,
		Item:            "ec2-resize",
		Target:          "aws_instance.stamped",
		RequesterLogin:  "ops-lead",
		CreatedAt:       "2026-07-01T09:00:00Z",
		Justification:   "resize for month-end close\n\n\n",
		EarliestApplyAt: "2026-07-31T00:00:00Z",
		Window:          &request.Window{Start: "2026-08-01T02:00:00Z", End: "2026-08-01T04:00:00Z", TZ: "UTC"},
		Approvals: []request.Approval{
			{Approver: "ops-lead", ApprovedAt: "2026-07-15T10:00:00Z", PolicyVersion: "v1", Digest: "abc123", Decision: "approve"},
			{Approver: "sre-oncall", ApprovedAt: "2026-07-15T11:00:00Z", PolicyVersion: "v1", Digest: "abc123", Decision: "approve"},
		},
	}
	files := []string{"environments/prod/main.tf", "requests/" + covprprepID + ".yaml", "PR_BODY.md"}
	body := renderPRBody(r, "aws_instance.resolved", files, "--- a/x\n+++ b/x\n-old\n+new\n\n")

	for _, sub := range []string{
		"# ccp change request `" + covprprepID + "`",
		"- **Operation:** `ec2-resize`",
		"- **Target:** `aws_instance.stamped`", // the stamped target wins
		"- **Requester:** `ops-lead`",
		"- **Requested:** `2026-07-01T09:00:00Z`",
		"## Justification\n\nresize for month-end close\n",
		"## Approvals (quorum: 2)",
		"| ops-lead | 2026-07-15T10:00:00Z | v1 | `abc123` | approve |",
		"| sre-oncall | 2026-07-15T11:00:00Z | v1 | `abc123` | approve |",
		"**Bound plan digest:** `abc123`",
		"- **Window:** 2026-08-01T02:00:00Z → 2026-08-01T04:00:00Z (UTC)",
		"- **Earliest apply:** 2026-07-31T00:00:00Z (ADR-0009 cooling-off)",
		"- `environments/prod/main.tf`",
		"```diff\n--- a/x\n+++ b/x\n-old\n+new\n```",
		"`requests/" + covprprepID + ".plan-digest` is a PENDING placeholder",
		"gh pr create --head ccp/" + covprprepID,
	} {
		if !strings.Contains(body, sub) {
			t.Errorf("PR body missing %q:\n%s", sub, body)
		}
	}
	// Artifacts are not listed as estate edits.
	if strings.Contains(body, "- `PR_BODY.md`") || strings.Contains(body, "- `requests/") {
		t.Errorf("PR body lists bundle artifacts as estate edits:\n%s", body)
	}
	// Deterministic: the same inputs render byte-identically (no clock reads).
	if again := renderPRBody(r, "aws_instance.resolved", files, "--- a/x\n+++ b/x\n-old\n+new\n\n"); again != body {
		t.Error("renderPRBody is not deterministic for identical inputs")
	}
	if strings.Contains(body, "_pending_") {
		t.Errorf("a bound digest must not also claim pending:\n%s", body)
	}
}

// TestCovprprepRenderPRBodyMinimal covers the bare request: no stamped target (the
// resolved address is used), no created_at, no window, no cooling-off, and an approval
// row with every optional cell empty (em-dashes keep the table well-formed) so the
// digest binding renders as pending.
func TestCovprprepRenderPRBodyMinimal(t *testing.T) {
	r := &request.Request{
		ID:             covprprepID,
		Item:           "ec2-resize",
		RequesterLogin: "ops-lead",
		Justification:  "minimal",
		Approvals:      []request.Approval{{}},
	}
	body := renderPRBody(r, "aws_instance.resolved", nil, "")

	for _, sub := range []string{
		"- **Target:** `aws_instance.resolved`", // falls back to the resolved address
		"## Approvals (quorum: 1)",
		"| — | — | — | `—` | — |",
		"**Bound plan digest:** _pending_",
		"- **Window:** next scheduler tick after approval (no maintenance window)",
		"- **Earliest apply:** none",
		"```diff\n\n```",
	} {
		if !strings.Contains(body, sub) {
			t.Errorf("PR body missing %q:\n%s", sub, body)
		}
	}
	if strings.Contains(body, "**Requested:**") {
		t.Errorf("no created_at ⇒ no Requested line:\n%s", body)
	}
}

// --- small utilities ---------------------------------------------------------------

// covprprepLoadOps loads the committed fixture catalog for the direct-helper tests.
func covprprepLoadOps(t *testing.T) map[string]manifests.Op {
	t.Helper()
	ops, err := manifests.LoadDir(covprprepManifests)
	if err != nil {
		t.Fatalf("LoadDir(%s): %v", covprprepManifests, err)
	}
	return ops
}

func covprprepRead(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return string(b)
}

func covprprepEqual(a, b []string) bool {
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
