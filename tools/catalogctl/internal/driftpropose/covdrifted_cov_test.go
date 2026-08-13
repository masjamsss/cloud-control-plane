package driftpropose

import (
	"bytes"
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// covdrifted_cov_test.go closes the coverage holes in the drift-edit apply-time
// edit replay (driftedit.go), the drift-propose flag surface (command.go), the
// ccp.drift/v1 envelope parse (envelope.go), the segment normalization/legacy
// path parse (partition.go), the fourth screen's matcher (watchlist.go) and the
// §2.4 digest (digest.go).
//
// Everything here asserts an observable contract: the exit CODE the gate script
// branches on, the refusal text on stderr, the bytes actually composed into
// oob-adopted.tf, or the returned bucket/segments/digest — never that a function
// merely ran.

// covdriftedCleanWatchlist is a well-formed checkout watchlist that loads
// cleanly and screens NOTHING: no resource_types, no attribute_patterns, and a
// present-but-empty creation_security_types key (present, so the fail-closed
// "key absent" refusal in importwatchlist.go never fires). Any refusal a test
// using it observes therefore comes from the branch under test, never from a
// screen.
const covdriftedCleanWatchlist = `{
  "version": 1,
  "doctrine": "covdrifted slot fixture: loads cleanly, screens nothing",
  "resource_types": {},
  "attribute_patterns": [],
  "creation_security_types": []
}`

// covdriftedBrokenTF is HCL that fails to parse — hclops.Locate reports it as an
// I/O/parse error on the CHECKOUT (exit code 1), which is the one input both
// drift-edit and drift-propose must surface as an internal error (exit 1) rather
// than a per-verdict refusal.
const covdriftedBrokenTF = "resource \"aws_instance\" \"sample01\" {\n  ami = \n"

// covdriftedAdoptEnvelope is a minimal envelope carrying exactly one
// ADOPT-eligible verdict against aws_instance.sample01 — enough for
// drift-propose to reach GenerateAdopt (and therefore the checkout).
const covdriftedAdoptEnvelope = `{"schema":"ccp.drift/v1","projectId":"sample","planExitCode":2,"report":{"verdicts":[
  {"address":"aws_instance.sample01","type":"aws_instance","class":"benign_inplace","riskTier":"low",
   "driftEvidence":true,"actions":["update"],"forceNewAttrs":[],"securityHits":[],
   "changedAttrs":[{"path":"tags.Owner","sensitive":false,"liveJson":"bi-team","codeJson":"platform",
                    "pathSegments":["tags","Owner"]}]}]}}`

// covdriftedRepo builds a checkout root in a fresh t.TempDir(): files land in
// <repo>/environments/prod, and watchlist (when non-empty) in
// <repo>/scripts/drift/security-watchlist.json — the repo-root location
// LoadWatchlist reads, independent of --root. The TempDir carries no .git of its
// own, so generate.go's gitHead fails closed to "" deterministically.
func covdriftedRepo(t *testing.T, watchlist string, files map[string]string) string {
	t.Helper()
	repo := t.TempDir()
	envDir := filepath.Join(repo, "environments", "prod")
	if err := os.MkdirAll(envDir, 0o755); err != nil {
		t.Fatal(err)
	}
	for name, body := range files {
		if err := os.WriteFile(filepath.Join(envDir, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if watchlist != "" {
		wlDir := filepath.Join(repo, "scripts", "drift")
		if err := os.MkdirAll(wlDir, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(wlDir, "security-watchlist.json"), []byte(watchlist), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return repo
}

// covdriftedWrite writes body into a fresh t.TempDir() and returns the path.
func covdriftedWrite(t *testing.T, name, body string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

// covdriftedEdit drives the real drift-edit entrypoint, keeping stdout and
// stderr APART: the exit code plus the stream a message landed on is the
// contract (README "Safety model" — refusals go to stderr, INFO to stdout).
func covdriftedEdit(args []string) (code int, stdout, stderr string) {
	var out, errb bytes.Buffer
	code = runDriftEdit(args, &out, &errb)
	return code, out.String(), errb.String()
}

// covdriftedPropose is covdriftedEdit's drift-propose twin.
func covdriftedPropose(args []string) (code int, stdout, stderr string) {
	var out, errb bytes.Buffer
	code = run(args, &out, &errb)
	return code, out.String(), errb.String()
}

// covdriftedRawRequest writes a bundle request whose params are the RAW JSON
// text given — the only way to exercise the "pinned params do not decode" arms,
// which a typed builder can never produce.
func covdriftedRawRequest(t *testing.T, op, paramsJSON string) string {
	t.Helper()
	return covdriftedWrite(t, "req.json", `{"operationId":"`+op+`","params":`+paramsJSON+`}`)
}

// covdriftedImportRequest writes a system-drift-import bundle request from
// already-built ImportParams — unlike mustImportRequestFile, the caller keeps
// control of every pinned field (so a test can deviate exactly one of them,
// e.g. targetFile, WITHOUT invalidating the §5.4 digest, which hashes only
// arn/tfType/liveId/importBlock/skeletonHcl).
func covdriftedImportRequest(t *testing.T, params ...ImportParams) string {
	t.Helper()
	items := make([]map[string]any, len(params))
	for i, p := range params {
		items[i] = map[string]any{"operationId": opImport, "params": p}
	}
	body, err := json.Marshal(map[string]any{"operationId": opImport, "items": items})
	if err != nil {
		t.Fatal(err)
	}
	return covdriftedWrite(t, "req.json", string(body))
}

// covdriftedAdoptRequest writes a system-drift-adopt bundle request from
// already-built AdoptParams — covdriftedImportRequest's adopt twin, for the
// same reason: a test can hand-build one item's params with a deliberately
// wrong field (e.g. proposalDigest) without disturbing another item's.
func covdriftedAdoptRequest(t *testing.T, params ...AdoptParams) string {
	t.Helper()
	items := make([]map[string]any, len(params))
	for i, p := range params {
		items[i] = map[string]any{"operationId": opAdopt, "params": p}
	}
	body, err := json.Marshal(map[string]any{"operationId": opAdopt, "items": items})
	if err != nil {
		t.Fatal(err)
	}
	return covdriftedWrite(t, "req.json", string(body))
}

// covdriftedSample01Adopt is the ADOPT-eligible (attrs, verdicts) pair for
// aws_instance.sample01 / tags.Owner that every drift-edit adopt case here
// pins — matching covdriftedAdoptEnvelope's single verdict.
func covdriftedSample01Adopt() ([]Attr, []Verdict) {
	attrs := []Attr{{
		Address: "aws_instance.sample01", Path: "tags.Owner",
		PathSegments: []any{"tags", "Owner"}, LiveJSON: "bi-team", CodeJSON: "platform",
	}}
	verdicts := []Verdict{{
		Address: "aws_instance.sample01", Type: "aws_instance", Class: "benign_inplace", RiskTier: "low",
		DriftEvidence: true, Actions: []string{"update"},
		ChangedAttrs: []ChangedAttr{{
			Path: "tags.Owner", Sensitive: false,
			LiveJSON: json.RawMessage(`"bi-team"`), CodeJSON: json.RawMessage(`"platform"`),
			PathSegments: []any{"tags", "Owner"},
		}},
	}}
	return attrs, verdicts
}

// --- drift-edit: the flag surface and the pinned-params refusals -------------

// TestCovdriftedDriftEditFlagParseFails pins the flag-parse arm of the exit-code
// contract: an unparseable flag surface is a RESOLUTION failure (exit 3), never
// a silent run with defaults — the gate script must be able to tell "I was
// invoked wrong" from "I refused you" (exit 2).
func TestCovdriftedDriftEditFlagParseFails(t *testing.T) {
	cases := []struct {
		name string
		args []string
	}{
		{name: "unknown flag", args: []string{"--not-a-real-flag", "x"}},
		{name: "help request", args: []string{"-h"}},
		{name: "flag missing its value", args: []string{"--request"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			code, stdout, _ := covdriftedEdit(tc.args)
			if code != 3 {
				t.Fatalf("code = %d, want 3", code)
			}
			if stdout != "" {
				t.Errorf("stdout = %q, want the flag surface to write nothing to stdout", stdout)
			}
		})
	}
}

// TestCovdriftedDriftEditAdoptParamsRefusals pins the three malformed-pinned-
// params refusals of the adopt replay (spec addendum A2's F1(a) schema): params
// that do not decode, params carrying no attrs, and params carrying no verdicts
// are all exit 3 (the request is malformed — no honest producer emits it), never
// exit 2 (a refusal of a well-formed request) and never a partial edit.
func TestCovdriftedDriftEditAdoptParamsRefusals(t *testing.T) {
	const tf = "resource \"aws_instance\" \"sample01\" {\n  ami = \"ami-0123456789abcdef0\"\n\n  tags = {\n    Owner = \"platform\"\n  }\n}\n"
	cases := []struct {
		name   string
		params string
		want   string
	}{
		{
			name:   "params are not an object at all",
			params: `"not-an-object"`,
			want:   "item 0: pinned params",
		},
		{
			name:   "params carry no attrs",
			params: `{"attrs":[],"verdicts":[{"address":"aws_instance.sample01"}],"proposalDigest":"x"}`,
			want:   "item 0: pinned params carry no attrs",
		},
		{
			name:   "params carry no verdicts",
			params: `{"attrs":[{"address":"aws_instance.sample01","path":"tags.Owner"}],"verdicts":[],"proposalDigest":"x"}`,
			want:   "item 0: pinned params carry no verdicts",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			repo := covdriftedRepo(t, covdriftedCleanWatchlist, map[string]string{"main.tf": tf})
			req := covdriftedRawRequest(t, opAdopt, tc.params)

			code, stdout, stderr := covdriftedEdit([]string{"--request", req, "--repo", repo, "--root", "environments/prod"})
			if code != 3 {
				t.Fatalf("code = %d, want 3 (stderr=%q)", code, stderr)
			}
			if !strings.Contains(stderr, tc.want) {
				t.Errorf("stderr = %q, want it to contain %q", stderr, tc.want)
			}
			if stdout != "" {
				t.Errorf("stdout = %q, want a malformed request to write nothing to stdout", stdout)
			}
			got, err := os.ReadFile(filepath.Join(repo, "environments/prod/main.tf"))
			if err != nil {
				t.Fatal(err)
			}
			if string(got) != tf {
				t.Fatalf("a malformed request still edited the checkout:\n%s", got)
			}
		})
	}
}

// TestCovdriftedDriftEditAdoptSurfacesCheckoutErrorAsExit1 pins the ONE adopt
// replay outcome that is an INTERNAL error (exit 1) rather than a refusal (exit
// 2): the checkout itself does not parse. An unparseable tree is not a fact
// about this pinned verdict, so it must never be reported as "this item is
// ungenerable" — the operator has to fix the checkout, not the request.
func TestCovdriftedDriftEditAdoptSurfacesCheckoutErrorAsExit1(t *testing.T) {
	repo := covdriftedRepo(t, covdriftedCleanWatchlist, map[string]string{"main.tf": covdriftedBrokenTF})
	attrs, verdicts := covdriftedSample01Adopt()
	req := mustAdoptRequestFile(t, attrs, verdicts)

	code, stdout, stderr := covdriftedEdit([]string{"--request", req, "--repo", repo, "--root", "environments/prod"})
	if code != 1 {
		t.Fatalf("code = %d, want 1 (stderr=%q)", code, stderr)
	}
	if !containsAll(stderr, "item 0", "aws_instance.sample01", "parse") {
		t.Errorf("stderr = %q, want it to name the item, the address and the parse failure", stderr)
	}
	if strings.Contains(stdout, "wrote") {
		t.Errorf("stdout = %q, want no write to be claimed", stdout)
	}
}

// --- drift-edit: import (spec 2026-07-20-ccp-oob-provisioning-import.md §7.1) --

// TestCovdriftedDriftEditImportParamsRefusals pins import's malformed-pinned-
// params refusals (exit 3, the request is malformed): params that do not decode,
// an incomplete importPayload, and a pinned finding with no tfType. Each is
// checked BEFORE the digest cross-check, so none of these needs a valid digest —
// and none of them may write oob-adopted.tf.
func TestCovdriftedDriftEditImportParamsRefusals(t *testing.T) {
	completePayload := `{"address":"aws_instance.oob_bastion01","targetFile":"oob-adopted.tf",` +
		`"importBlock":"import {}\n","skeletonHcl":"resource \"aws_instance\" \"oob_bastion01\" {}\n"}`
	cases := []struct {
		name   string
		params string
		want   string
	}{
		{
			name:   "params are not an object at all",
			params: `"not-an-object"`,
			want:   "item 0: pinned params",
		},
		{
			name: "importPayload is missing its skeletonHcl",
			params: `{"finding":{"class":"unmanaged_resource","tfType":"aws_instance","liveId":"i-0abc123def456789a"},` +
				`"importPayload":{"address":"aws_instance.oob_bastion01","targetFile":"oob-adopted.tf","importBlock":"import {}\n","skeletonHcl":""},` +
				`"proposalDigest":"x"}`,
			want: "item 0: pinned params carry an incomplete importPayload",
		},
		{
			name: "pinned finding carries no tfType",
			params: `{"finding":{"class":"unmanaged_resource","tfType":"","liveId":"i-0abc123def456789a"},` +
				`"importPayload":` + completePayload + `,"proposalDigest":"x"}`,
			want: "aws_instance.oob_bastion01: pinned finding carries no tfType",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			repo := covdriftedRepo(t, covdriftedCleanWatchlist, nil)
			req := covdriftedRawRequest(t, opImport, tc.params)

			code, stdout, stderr := covdriftedEdit([]string{"--request", req, "--repo", repo, "--root", "environments/prod"})
			if code != 3 {
				t.Fatalf("code = %d, want 3 (stderr=%q)", code, stderr)
			}
			if !strings.Contains(stderr, tc.want) {
				t.Errorf("stderr = %q, want it to contain %q", stderr, tc.want)
			}
			if stdout != "" {
				t.Errorf("stdout = %q, want a malformed request to write nothing to stdout", stdout)
			}
			if _, err := os.Stat(filepath.Join(repo, "environments/prod", oobAdoptedFile)); err == nil {
				t.Fatal("a malformed import request still created oob-adopted.tf")
			}
		})
	}
}

// TestCovdriftedDriftEditImportRefusalsBeforeAnyWrite pins the three remaining
// screens of the import replay, each on an otherwise perfectly-digest-consistent
// request — so the deviation under test is the ONLY thing that can refuse:
//
//   - a pinned targetFile that is not the v1 constant (tamper evidence: targetFile
//     is deliberately NOT in the §5.4 digest formula, so the digest alone would
//     not catch it);
//   - a pinned finding whose class re-derives §5.2 as NOT import-eligible
//     (enforcement point 3, independent of points 1-2);
//   - a payload whose own bytes fail the §5.3a prescan.
//
// All three are exit 2 (a refusal of a well-formed request) and none may write.
func TestCovdriftedDriftEditImportRefusalsBeforeAnyWrite(t *testing.T) {
	provisionerSkeleton := "resource \"aws_instance\" \"oob_bastion01\" {\n" +
		"  ami = \"ami-0123456789abcdef0\"\n\n" +
		"  provisioner \"local-exec\" {\n    command = \"echo pwned\"\n  }\n}\n"

	cases := []struct {
		name   string
		params func() ImportParams
		want   []string
	}{
		{
			name: "pinned targetFile is not the v1 constant",
			params: func() ImportParams {
				p := importParamsFor(bastionImportItem())
				p.ImportPayload.TargetFile = "somewhere-else.tf" // digest-invisible on purpose
				return p
			},
			want: []string{"somewhere-else.tf", "does not match the v1 constant", "tamper evidence"},
		},
		{
			name: "pinned finding class is not the unmanaged_resource id",
			params: func() ImportParams {
				item := bastionImportItem()
				item.Finding.Class = "some_future_finding_class"
				return importParamsFor(item)
			},
			want: []string{"re-derived §5.2 eligibility failed", "enforcement point 3", "fail-closed"},
		},
		{
			name: "payload bytes fail the §5.3a prescan",
			params: func() ImportParams {
				item := bastionImportItem()
				item.Payload.SkeletonHcl = provisionerSkeleton
				return importParamsFor(item)
			},
			want: []string{"payload prescan refused", "PROVISIONER"},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			checkout := copyCheckoutFixture(t)
			req := covdriftedImportRequest(t, tc.params())

			code, stdout, stderr := covdriftedEdit([]string{"--request", req, "--repo", checkout, "--root", "environments/prod"})
			if code != 2 {
				t.Fatalf("code = %d, want 2 (stdout=%q stderr=%q)", code, stdout, stderr)
			}
			if !containsAll(stderr, tc.want...) {
				t.Errorf("stderr = %q, want it to name %v", stderr, tc.want)
			}
			if _, err := os.Stat(filepath.Join(checkout, "environments/prod", oobAdoptedFile)); err == nil {
				t.Fatal("a refused import still created oob-adopted.tf")
			}
		})
	}
}

// TestCovdriftedDriftEditImportGatesWholeBatchBeforeAnyWrite pins CTL-5
// directly, across ITEMS rather than within one: item 0 is a fully valid
// import that would succeed on its own; item 1's digest is tampered. Before
// CTL-5, the per-item loop interleaved gate-then-write, so item 0's write
// landed before the loop ever reached item 1's failing digest check — exit 2
// with a MODIFIED checkout. Phase 1 now gates every item in the request
// before phase 2 writes any of them, so item 0's write must never happen.
func TestCovdriftedDriftEditImportGatesWholeBatchBeforeAnyWrite(t *testing.T) {
	checkout := copyCheckoutFixture(t)
	good := importParamsFor(bastionImportItem())
	bad := importParamsFor(secondImportItem())
	bad.ProposalDigest = "0000000000000000000000000000000000000000000000000000000000000000"
	req := covdriftedImportRequest(t, good, bad)

	code, stdout, stderr := covdriftedEdit([]string{"--request", req, "--repo", checkout, "--root", "environments/prod"})
	if code != 2 {
		t.Fatalf("code = %d, want 2 (stdout=%q stderr=%q)", code, stdout, stderr)
	}
	if !containsAll(stderr, "item 1", "digest mismatch") {
		t.Errorf("stderr = %q, want it to name item 1's digest mismatch", stderr)
	}
	if strings.Contains(stdout, "imported") {
		t.Errorf("stdout = %q, want item 0's import never claimed", stdout)
	}
	if _, err := os.Stat(filepath.Join(checkout, "environments/prod", oobAdoptedFile)); err == nil {
		t.Fatal("item 1's refusal still let item 0 write oob-adopted.tf — the batch is not gated before any write (CTL-5)")
	}
}

// TestCovdriftedDriftEditAdoptGatesWholeBatchBeforeAnyWrite is
// TestCovdriftedDriftEditImportGatesWholeBatchBeforeAnyWrite's adopt twin:
// item 0 is a fully valid adopt (aws_instance.sample01's tags.Owner) that
// would edit main.tf on its own; item 1's digest is tampered. main.tf must
// survive byte-for-byte.
func TestCovdriftedDriftEditAdoptGatesWholeBatchBeforeAnyWrite(t *testing.T) {
	const tf = "resource \"aws_instance\" \"sample01\" {\n  ami = \"ami-0123456789abcdef0\"\n\n  tags = {\n    Owner = \"platform\"\n  }\n}\n"
	repo := covdriftedRepo(t, covdriftedCleanWatchlist, map[string]string{"main.tf": tf})
	attrs, verdicts := covdriftedSample01Adopt()
	good := AdoptParams{Attrs: attrs, Verdicts: verdicts, ProposalDigest: ProposalDigest("adopt", addressesFromAttrs(attrs), attrs)}
	bad := AdoptParams{Attrs: attrs, Verdicts: verdicts, ProposalDigest: "0000000000000000000000000000000000000000000000000000000000000000"}
	req := covdriftedAdoptRequest(t, good, bad)

	code, stdout, stderr := covdriftedEdit([]string{"--request", req, "--repo", repo, "--root", "environments/prod"})
	if code != 2 {
		t.Fatalf("code = %d, want 2 (stdout=%q stderr=%q)", code, stdout, stderr)
	}
	if !containsAll(stderr, "item 1", "digest mismatch") {
		t.Errorf("stderr = %q, want it to name item 1's digest mismatch", stderr)
	}
	if strings.Contains(stdout, "wrote") {
		t.Errorf("stdout = %q, want item 0's write never claimed", stdout)
	}
	got, err := os.ReadFile(filepath.Join(repo, "environments/prod/main.tf"))
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != tf {
		t.Fatalf("item 1's refusal still let item 0 edit main.tf — the batch is not gated before any write (CTL-5):\n%s", got)
	}
}

// TestCovdriftedDriftEditImportUnreadableWatchlistRefuses pins the fail-closed
// doctrine at drift-edit's import layer (adopt's twin is
// TestDriftEditUnreadableWatchlistRefusesAdopt): a checkout carrying no
// scripts/drift/security-watchlist.json refuses EVERY import item — never
// guessed item-by-item, never written.
func TestCovdriftedDriftEditImportUnreadableWatchlistRefuses(t *testing.T) {
	checkout := copyCheckoutFixtureWithoutWatchlist(t)
	req := covdriftedImportRequest(t, importParamsFor(bastionImportItem()))

	code, _, stderr := covdriftedEdit([]string{"--request", req, "--repo", checkout, "--root", "environments/prod"})
	if code != 2 {
		t.Fatalf("code = %d, want 2 (stderr=%q)", code, stderr)
	}
	if !containsAll(stderr, "security watchlist unreadable in checkout", "refusing every import", "aws_instance.oob_bastion01") {
		t.Errorf("stderr = %q, want it to name the unreadable watchlist and the refused address", stderr)
	}
	if _, err := os.Stat(filepath.Join(checkout, "environments/prod", oobAdoptedFile)); err == nil {
		t.Fatal("a fail-closed refusal still created oob-adopted.tf")
	}
}

// TestCovdriftedDriftEditImportWriteFailuresExit1 pins appendImportBlock's
// read arm as an INTERNAL error (exit 1), not a refusal: the target cannot be
// read for a reason other than "absent." A fact about the checkout's
// filesystem, never about the pinned request — provoked without depending on
// mode bits, so it is exercised as root too.
func TestCovdriftedDriftEditImportWriteFailuresExit1(t *testing.T) {
	cases := []struct {
		name  string
		setup func(t *testing.T, envDir string)
		want  []string
	}{
		{
			// A directory where oob-adopted.tf should be: os.ReadFile fails with
			// something that is NOT os.IsNotExist, i.e. appendImportBlock's
			// default (read-error) arm.
			name: "target path is a directory",
			setup: func(t *testing.T, envDir string) {
				if err := os.MkdirAll(filepath.Join(envDir, oobAdoptedFile), 0o755); err != nil {
					t.Fatal(err)
				}
			},
			want: []string{"read", oobAdoptedFile},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			checkout := copyCheckoutFixture(t)
			envDir := filepath.Join(checkout, "environments/prod")
			tc.setup(t, envDir)
			req := covdriftedImportRequest(t, importParamsFor(bastionImportItem()))

			code, stdout, stderr := covdriftedEdit([]string{"--request", req, "--repo", checkout, "--root", "environments/prod"})
			if code != 1 {
				t.Fatalf("code = %d, want 1 (stdout=%q stderr=%q)", code, stdout, stderr)
			}
			if !containsAll(stderr, tc.want...) {
				t.Errorf("stderr = %q, want it to name %v", stderr, tc.want)
			}
			if strings.Contains(stdout, "imported") {
				t.Errorf("stdout = %q, want no import to be claimed after an I/O failure", stdout)
			}
		})
	}
}

// TestCovdriftedDriftEditImportThroughDanglingSymlinkSucceeds pins a CTL-5
// behavior change directly: appendImportBlock used to write via a bare
// os.WriteFile, which FOLLOWS a symlink at the target path — a dangling one
// (pointing into a directory that does not exist) made the write fail, an
// exit-1 case this file used to pin. Now that the write goes through
// hclops.AtomicWrite (temp file + rename, CTL-5), the rename REPLACES
// whatever sits at the target path — file or symlink — rather than
// traversing it, so a dangling symlink no longer matters: the import
// succeeds and oob-adopted.tf ends up a REGULAR file holding the composed
// bytes, not a symlink into nowhere. This is strictly safer (a planted
// symlink can no longer redirect the write outside the checkout) and is
// worth pinning as a positive fact about the new behavior, not just noting
// where the old negative test went.
func TestCovdriftedDriftEditImportThroughDanglingSymlinkSucceeds(t *testing.T) {
	checkout := copyCheckoutFixture(t)
	envDir := filepath.Join(checkout, "environments/prod")
	target := filepath.Join(envDir, oobAdoptedFile)
	if err := os.Symlink(filepath.Join(envDir, "no-such-dir", "target.tf"), target); err != nil {
		t.Fatal(err)
	}
	req := covdriftedImportRequest(t, importParamsFor(bastionImportItem()))

	code, stdout, stderr := covdriftedEdit([]string{"--request", req, "--repo", checkout, "--root", "environments/prod"})
	if code != 0 {
		t.Fatalf("code = %d, want 0 (stdout=%q stderr=%q)", code, stdout, stderr)
	}
	if !strings.Contains(stdout, "imported") {
		t.Fatalf("stdout = %q, want the import claimed", stdout)
	}
	info, err := os.Lstat(target)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode()&os.ModeSymlink != 0 {
		t.Fatalf("oob-adopted.tf is still a symlink after the write — the atomic rename should have replaced it with a regular file")
	}
	got, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(got), "import {") {
		t.Fatalf("oob-adopted.tf does not contain the composed import block:\n%s", got)
	}
}

// TestCovdriftedDriftEditImportIntoEmptyTargetFile pins ensureTrailingBlankLine's
// empty-buffer arm through the composed bytes: an oob-adopted.tf that already
// exists but is EMPTY is appended to as-is — no banner is invented for it (it is
// not absent), and no leading blank line is manufactured (there is nothing to
// separate from), so the file begins exactly at the reviewed import block.
func TestCovdriftedDriftEditImportIntoEmptyTargetFile(t *testing.T) {
	checkout := copyCheckoutFixture(t)
	target := filepath.Join(checkout, "environments/prod", oobAdoptedFile)
	if err := os.WriteFile(target, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	item := bastionImportItem()
	req := covdriftedImportRequest(t, importParamsFor(item))

	code, stdout, stderr := covdriftedEdit([]string{"--request", req, "--repo", checkout, "--root", "environments/prod"})
	if code != 0 {
		t.Fatalf("code = %d, want 0 (stderr=%q)", code, stderr)
	}
	if !strings.Contains(stdout, "imported aws_instance.oob_bastion01") {
		t.Fatalf("stdout = %q, want the import confirmed", stdout)
	}
	got, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	content := string(got)
	if strings.Contains(content, "Generated by catalogctl drift-edit") {
		t.Fatalf("a banner was invented for an existing (empty) file:\n%s", content)
	}
	if !strings.HasPrefix(content, item.Payload.ImportBlock) {
		t.Fatalf("composition into an empty file did not start at the import block:\n%q", content)
	}
	if !strings.HasSuffix(content, item.Payload.SkeletonHcl) {
		t.Fatalf("composition into an empty file did not end at the skeleton:\n%q", content)
	}
	if strings.Contains(content, "\n\n\n") {
		t.Fatalf("more than one blank line between the composed blocks:\n%q", content)
	}
}

// TestCovdriftedAppendComposition pins the two byte-level helpers
// appendImportBlock composes with, directly: ensureTrailingBlankLine normalizes
// any run of trailing newlines to exactly one blank line (and leaves an EMPTY
// buffer alone — there is nothing to separate from), and normalizeTrailingNewline
// normalizes a pinned payload string to exactly one trailing newline whether the
// producer supplied none, one, or several.
func TestCovdriftedAppendComposition(t *testing.T) {
	t.Run("ensureTrailingBlankLine", func(t *testing.T) {
		cases := []struct {
			name, in, want string
		}{
			{name: "empty stays empty", in: "", want: ""},
			{name: "only newlines collapse to empty", in: "\n\n\n", want: ""},
			{name: "no trailing newline gains a blank line", in: "a", want: "a\n\n"},
			{name: "one trailing newline gains a blank line", in: "a\n", want: "a\n\n"},
			{name: "a run of trailing newlines collapses to one blank line", in: "a\n\n\n\n", want: "a\n\n"},
			{name: "interior newlines are untouched", in: "a\n\nb\n", want: "a\n\nb\n\n"},
		}
		for _, tc := range cases {
			t.Run(tc.name, func(t *testing.T) {
				if got := string(ensureTrailingBlankLine([]byte(tc.in))); got != tc.want {
					t.Fatalf("ensureTrailingBlankLine(%q) = %q, want %q", tc.in, got, tc.want)
				}
			})
		}
	})

	t.Run("normalizeTrailingNewline", func(t *testing.T) {
		cases := []struct {
			name, in, want string
		}{
			{name: "empty gains the one newline", in: "", want: "\n"},
			{name: "no trailing newline gains one", in: "import {}", want: "import {}\n"},
			{name: "one trailing newline is kept", in: "import {}\n", want: "import {}\n"},
			{name: "several trailing newlines collapse to one", in: "import {}\n\n\n", want: "import {}\n"},
		}
		for _, tc := range cases {
			t.Run(tc.name, func(t *testing.T) {
				if got := string(normalizeTrailingNewline(tc.in)); got != tc.want {
					t.Fatalf("normalizeTrailingNewline(%q) = %q, want %q", tc.in, got, tc.want)
				}
			})
		}
	})
}

// --- drift-propose: the flag surface and the internal-error arms -------------

// TestCovdriftedDriftProposeFlagParseFails is drift-edit's twin for the
// drift-propose flag surface: an unparseable invocation is exit 3, and nothing
// is written to stdout.
func TestCovdriftedDriftProposeFlagParseFails(t *testing.T) {
	cases := []struct {
		name string
		args []string
	}{
		{name: "unknown flag", args: []string{"--not-a-real-flag", "x"}},
		{name: "help request", args: []string{"-h"}},
		{name: "non-boolean value for a bool flag", args: []string{"--enable-import=maybe"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			code, stdout, _ := covdriftedPropose(tc.args)
			if code != 3 {
				t.Fatalf("code = %d, want 3", code)
			}
			if stdout != "" {
				t.Errorf("stdout = %q, want the flag surface to write nothing to stdout", stdout)
			}
		})
	}
}

// TestCovdriftedDriftProposeInternalErrorsExit1 pins the two exit-1 arms of
// drift-propose (spec §6.1: "exit 1 = internal"), distinguishing them from the
// exit-3 (envelope) and exit-4 (checkout unusable) arms already pinned by
// TestExitCodes: a checkout that stat()s fine but does not PARSE, and an --out
// path that cannot be written. Neither is a fact about the envelope, so neither
// may be reported as a validation failure.
func TestCovdriftedDriftProposeInternalErrorsExit1(t *testing.T) {
	t.Run("unparseable checkout", func(t *testing.T) {
		repo := covdriftedRepo(t, covdriftedCleanWatchlist, map[string]string{"main.tf": covdriftedBrokenTF})
		outPath := filepath.Join(t.TempDir(), "proposals.json")

		code, stdout, stderr := covdriftedPropose([]string{
			"--envelope", covdriftedWrite(t, "envelope.json", covdriftedAdoptEnvelope),
			"--repo", repo, "--root", "environments/prod", "--out", outPath,
		})
		if code != 1 {
			t.Fatalf("code = %d, want 1 (stderr=%q)", code, stderr)
		}
		if !containsAll(stderr, "drift-propose:", "parse") {
			t.Errorf("stderr = %q, want it to name the parse failure", stderr)
		}
		if stdout != "" {
			t.Errorf("stdout = %q, want no success line on an internal error", stdout)
		}
		if _, err := os.Stat(outPath); err == nil {
			t.Fatal("proposals.json was written despite the internal error")
		}
	})

	t.Run("unwritable --out path", func(t *testing.T) {
		repo := covdriftedRepo(t, covdriftedCleanWatchlist, map[string]string{
			"main.tf": "resource \"aws_instance\" \"sample01\" {\n  ami = \"ami-0123456789abcdef0\"\n}\n",
		})
		outPath := filepath.Join(t.TempDir(), "no-such-dir", "proposals.json")

		code, stdout, stderr := covdriftedPropose([]string{
			"--envelope", covdriftedWrite(t, "envelope.json", `{"schema":"ccp.drift/v1","projectId":"sample","planExitCode":0,"report":{"verdicts":[]}}`),
			"--repo", repo, "--root", "environments/prod", "--out", outPath,
		})
		if code != 1 {
			t.Fatalf("code = %d, want 1 (stderr=%q)", code, stderr)
		}
		if !containsAll(stderr, "drift-propose:", "proposals.json") {
			t.Errorf("stderr = %q, want it to name the unwritable output path", stderr)
		}
		if stdout != "" {
			t.Errorf("stdout = %q, want no success line when the output was never written", stdout)
		}
	})
}

// --- envelope.go -------------------------------------------------------------

// TestCovdriftedLoadEnvelopeUnreadable pins LoadEnvelope's read arm: an absent
// file is an error naming the read (mapped by command.go to exit 3, "the engine
// never guesses at untrusted input"), never an empty envelope.
func TestCovdriftedLoadEnvelopeUnreadable(t *testing.T) {
	env, err := LoadEnvelope(filepath.Join(t.TempDir(), "does-not-exist.json"))
	if err == nil {
		t.Fatalf("LoadEnvelope succeeded on an absent file: %+v", env)
	}
	if env != nil {
		t.Errorf("envelope = %+v, want nil alongside the error", env)
	}
	if !strings.Contains(err.Error(), "read envelope") {
		t.Errorf("err = %v, want it to name the read failure", err)
	}
}

// TestCovdriftedParseEnvelopeValidation pins every §2.1 whole-envelope
// validation as a table — including the projectId requirement, which is the one
// required-field refusal with no other coverage. Each case asserts the error
// names the offending field, so an operator can tell WHICH validation failed.
func TestCovdriftedParseEnvelopeValidation(t *testing.T) {
	cases := []struct {
		name string
		body string
		want string
	}{
		{name: "invalid JSON", body: `{not json`, want: "invalid JSON"},
		{
			name: "wrong schema",
			body: `{"schema":"ccp.drift/v2","projectId":"sample","planExitCode":0,"report":{"verdicts":[]}}`,
			want: "schema",
		},
		{
			name: "projectId absent",
			body: `{"schema":"ccp.drift/v1","planExitCode":0,"report":{"verdicts":[]}}`,
			want: "projectId is required",
		},
		{
			name: "projectId present but empty",
			body: `{"schema":"ccp.drift/v1","projectId":"","planExitCode":0,"report":{"verdicts":[]}}`,
			want: "projectId is required",
		},
		{
			name: "planExitCode 1 never publishes",
			body: `{"schema":"ccp.drift/v1","projectId":"sample","planExitCode":1,"report":{"verdicts":[]}}`,
			want: "planExitCode",
		},
		{
			name: "verdict with no address",
			body: `{"schema":"ccp.drift/v1","projectId":"sample","planExitCode":2,"report":{"verdicts":[{"class":"benign_inplace"}]}}`,
			want: "report.verdicts[0] has no address",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			env, err := ParseEnvelope([]byte(tc.body))
			if err == nil {
				t.Fatalf("ParseEnvelope accepted %s: %+v", tc.name, env)
			}
			if env != nil {
				t.Errorf("envelope = %+v, want nil alongside the error", env)
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Errorf("err = %v, want it to name %q", err, tc.want)
			}
		})
	}

	t.Run("planExitCode 0 and 2 are both accepted", func(t *testing.T) {
		for _, code := range []string{"0", "2"} {
			env, err := ParseEnvelope([]byte(`{"schema":"ccp.drift/v1","projectId":"sample","planExitCode":` + code + `,"report":{"verdicts":[]}}`))
			if err != nil {
				t.Fatalf("planExitCode %s: %v", code, err)
			}
			if env.ProjectID != "sample" {
				t.Fatalf("projectId = %q, want %q", env.ProjectID, "sample")
			}
		}
	})
}

// TestCovdriftedChangedAttrMachineValues pins liveValue/codeValue's contract
// symmetrically: ok=false means "this row carries no machine value AT ALL",
// which must cover both an absent key and bytes that do not decode — never a
// guess from the display-only live/code strings (which stay populated in the
// undecodable case here, proving they are not consulted).
func TestCovdriftedChangedAttrMachineValues(t *testing.T) {
	cases := []struct {
		name    string
		raw     string
		wantOK  bool
		wantVal any
	}{
		{name: "absent key", raw: "", wantOK: false, wantVal: nil},
		{name: "string value", raw: `"bi-team"`, wantOK: true, wantVal: "bi-team"},
		{name: "null value is present", raw: `null`, wantOK: true, wantVal: nil},
		{name: "number decodes as float64", raw: `80`, wantOK: true, wantVal: float64(80)},
		{name: "undecodable bytes", raw: `{not json`, wantOK: false, wantVal: nil},
		{name: "truncated bytes", raw: `[1,`, wantOK: false, wantVal: nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ca := ChangedAttr{Path: "tags.Owner", Live: "display-live", Code: "display-code"}
			if tc.raw != "" {
				ca.LiveJSON = json.RawMessage(tc.raw)
				ca.CodeJSON = json.RawMessage(tc.raw)
			}
			live, liveOK := ca.liveValue()
			code, codeOK := ca.codeValue()
			if liveOK != tc.wantOK || codeOK != tc.wantOK {
				t.Fatalf("ok = (live=%v, code=%v), want %v for both", liveOK, codeOK, tc.wantOK)
			}
			if live != tc.wantVal || code != tc.wantVal {
				t.Fatalf("value = (live=%#v, code=%#v), want %#v", live, code, tc.wantVal)
			}
		})
	}
}

// --- partition.go ------------------------------------------------------------

// TestCovdriftedNormalizeSegments pins spec addendum A4's normalization contract
// exhaustively, including the fail-closed distinction that matters most:
// ABSENT (nil) is SegLegacy — fall back to the pre-F8 display-path rules — while
// PRESENT-BUT-BROKEN is SegMalformed, which must never quietly fall back.
// JSON-decoded integers arrive as float64 and Go-authored ones as int; both
// normalize to the same int.
func TestCovdriftedNormalizeSegments(t *testing.T) {
	cases := []struct {
		name     string
		raw      []any
		wantKind SegKind
		wantSegs []any
	}{
		{name: "absent is legacy", raw: nil, wantKind: SegLegacy},
		{name: "empty array is malformed", raw: []any{}, wantKind: SegMalformed},
		{name: "single string", raw: []any{"instance_type"}, wantKind: SegNormalized, wantSegs: []any{"instance_type"}},
		{name: "string pair", raw: []any{"tags", "Owner"}, wantKind: SegNormalized, wantSegs: []any{"tags", "Owner"}},
		{
			name: "float64 index normalizes to int", raw: []any{"ingress", float64(0), "cidr_blocks"},
			wantKind: SegNormalized, wantSegs: []any{"ingress", 0, "cidr_blocks"},
		},
		{
			name: "int index stays int", raw: []any{"ingress", 2, "cidr_blocks"},
			wantKind: SegNormalized, wantSegs: []any{"ingress", 2, "cidr_blocks"},
		},
		{name: "negative int index is malformed", raw: []any{"ingress", -1}, wantKind: SegMalformed},
		{name: "negative float index is malformed", raw: []any{"ingress", float64(-1)}, wantKind: SegMalformed},
		{name: "fractional float index is malformed", raw: []any{"ingress", 1.5}, wantKind: SegMalformed},
		{name: "bool element is malformed", raw: []any{"ingress", true}, wantKind: SegMalformed},
		{name: "null element is malformed", raw: []any{"ingress", nil}, wantKind: SegMalformed},
		{name: "nested array element is malformed", raw: []any{"ingress", []any{0}}, wantKind: SegMalformed},
		{name: "object element is malformed", raw: []any{map[string]any{"k": "v"}}, wantKind: SegMalformed},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			segs, kind := NormalizeSegments(tc.raw)
			if kind != tc.wantKind {
				t.Fatalf("kind = %v, want %v (segs=%#v)", kind, tc.wantKind, segs)
			}
			if tc.wantKind != SegNormalized {
				if segs != nil {
					t.Fatalf("segs = %#v, want nil for a non-normalized outcome", segs)
				}
				return
			}
			if len(segs) != len(tc.wantSegs) {
				t.Fatalf("segs = %#v, want %#v", segs, tc.wantSegs)
			}
			for i := range segs {
				if segs[i] != tc.wantSegs[i] {
					t.Fatalf("segs[%d] = %#v (%T), want %#v (%T)", i, segs[i], segs[i], tc.wantSegs[i], tc.wantSegs[i])
				}
			}
		})
	}

	// Fail-closed, end to end: a PRESENT-but-broken pathSegments value is never
	// expressible even when the display path alone (a clean 2-part, no-bracket
	// string) would have been accepted under the legacy rule.
	t.Run("malformed never falls back to the display path", func(t *testing.T) {
		legacy := ChangedAttr{Path: "tags.Owner"}
		broken := ChangedAttr{Path: "tags.Owner", PathSegments: []any{"tags", true}}
		if !PathExpressible(legacy) {
			t.Fatal("the legacy display path tags.Owner is not expressible — the contrast this case rests on is gone")
		}
		if PathExpressible(broken) {
			t.Fatal("a malformed pathSegments row fell back to the legacy display-path rule")
		}
	})
}

// TestCovdriftedLegacyDisplaySegments pins the bracket-aware, any-depth parse
// that POPULATES Attr.PathSegments when the source verdict supplied none —
// distinct from legacySegments' stricter adopt-expressibility rule. A segment
// whose bracket contents are not an integer is deliberately left UNSPLIT rather
// than guessed at.
func TestCovdriftedLegacyDisplaySegments(t *testing.T) {
	cases := []struct {
		name, path string
		want       []any
	}{
		{name: "empty path yields nothing", path: "", want: nil},
		{name: "single segment", path: "instance_type", want: []any{"instance_type"}},
		{name: "dotted pair", path: "tags.Owner", want: []any{"tags", "Owner"}},
		{name: "bracket index is split out", path: "ingress[0].cidr_blocks", want: []any{"ingress", 0, "cidr_blocks"}},
		{name: "non-zero bracket index", path: "ingress[2].from_port", want: []any{"ingress", 2, "from_port"}},
		{name: "bare index segment keeps only the index", path: "[0]", want: []any{0}},
		{name: "several bracketed segments", path: "a[1].b[2]", want: []any{"a", 1, "b", 2}},
		{name: "non-integer bracket contents stay unsplit", path: "ingress[abc]", want: []any{"ingress[abc]"}},
		{name: "unterminated bracket stays unsplit", path: "ingress[0", want: []any{"ingress[0"}},
		{name: "no opening bracket stays unsplit", path: "ingress0]", want: []any{"ingress0]"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := legacyDisplaySegments(tc.path)
			if len(got) != len(tc.want) {
				t.Fatalf("legacyDisplaySegments(%q) = %#v, want %#v", tc.path, got, tc.want)
			}
			for i := range got {
				if got[i] != tc.want[i] {
					t.Fatalf("segment %d = %#v (%T), want %#v (%T)", i, got[i], got[i], tc.want[i], tc.want[i])
				}
			}
		})
	}

	// The observable consequence (spec F8: "always populated by the generator"):
	// a legacy verdict carrying only a bracketed display path still emits an
	// Attr with structured segments on the generated proposal.
	t.Run("populates pathSegments on a generated revert proposal", func(t *testing.T) {
		checkout := copyCheckoutFixture(t)
		v := Verdict{
			Address: "aws_security_group.sg1", Type: "aws_security_group",
			Class: "security_posture", RiskTier: "high", DriftEvidence: true, Actions: []string{"update"},
			ChangedAttrs: []ChangedAttr{{
				Path:     "ingress[0].cidr_blocks", // legacy row: no pathSegments at all
				LiveJSON: json.RawMessage(`["0.0.0.0/0"]`), CodeJSON: json.RawMessage(`["10.0.0.0/16"]`),
			}},
		}
		if bucket, reason := ClassifyByFields(v); bucket != BucketRevert {
			t.Fatalf("precondition failed: bucket = %q (reason=%q), want %q", bucket, reason, BucketRevert)
		}
		p, reason, err := GenerateRevert(v, filepath.Join(checkout, "environments/prod"))
		if err != nil {
			t.Fatalf("GenerateRevert: %v", err)
		}
		if p == nil {
			t.Fatalf("GenerateRevert refused a revert-eligible verdict: %s", reason)
		}
		if len(p.Attrs) != 1 {
			t.Fatalf("attrs = %+v, want exactly one row", p.Attrs)
		}
		want := []any{"ingress", 0, "cidr_blocks"}
		got := p.Attrs[0].PathSegments
		if len(got) != len(want) {
			t.Fatalf("pathSegments = %#v, want %#v", got, want)
		}
		for i := range want {
			if got[i] != want[i] {
				t.Fatalf("pathSegments[%d] = %#v, want %#v", i, got[i], want[i])
			}
		}
	})
}

// --- watchlist.go ------------------------------------------------------------

// covdriftedExceptWatchlist parses a hand-written watchlist carrying an
// attribute_patterns entry with except_types — a shape the committed fixture
// checkout deliberately does not carry, and the only way to exercise the
// per-type exemption.
func covdriftedExceptWatchlist(t *testing.T) *Watchlist {
	t.Helper()
	const body = `{
	  "version": 1,
	  "resource_types": {},
	  "attribute_patterns": [
	    {"pattern": "policy", "why": "resource policy = access grants", "except_types": ["aws_s3_bucket", "aws_sqs_queue"]},
	    {"pattern": "publicly_*", "why": "direct public exposure"}
	  ],
	  "creation_security_types": []
	}`
	var w Watchlist
	if err := json.Unmarshal([]byte(body), &w); err != nil {
		t.Fatalf("parse covdrifted watchlist: %v", err)
	}
	return &w
}

// TestCovdriftedWatchlistExceptTypes pins the attribute_patterns exemption
// (classify.py's own "skip any entry whose except_types names the resource
// type"): the SAME path hits on a type outside the exemption and misses on one
// inside it — and the exemption is scoped to its OWN pattern entry, never
// disabling the other patterns for that type.
func TestCovdriftedWatchlistExceptTypes(t *testing.T) {
	w := covdriftedExceptWatchlist(t)
	cases := []struct {
		name    string
		rtype   string
		segs    []any
		wantHit bool
		wantWhy string
	}{
		{
			name: "exempted type does not hit its own pattern", rtype: "aws_s3_bucket",
			segs: []any{"policy"}, wantHit: false,
		},
		{
			name: "second exempted type does not hit either", rtype: "aws_sqs_queue",
			segs: []any{"policy"}, wantHit: false,
		},
		{
			name: "unexempted type hits the same pattern", rtype: "aws_kms_key",
			segs: []any{"policy"}, wantHit: true, wantWhy: "resource policy = access grants",
		},
		{
			name: "the exemption is scoped to its own entry", rtype: "aws_s3_bucket",
			segs: []any{"publicly_accessible"}, wantHit: true, wantWhy: "direct public exposure",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			why, hit := w.Hit(tc.rtype, tc.segs)
			if hit != tc.wantHit {
				t.Fatalf("hit = %v (why=%q), want %v", hit, why, tc.wantHit)
			}
			if why != tc.wantWhy {
				t.Fatalf("why = %q, want %q", why, tc.wantWhy)
			}
		})
	}
}

// TestCovdriftedWatchlistIndexOnlySegments pins normPath/topAndLeaf's
// index-stripping contract at its degenerate edge: a segment list made up
// ENTIRELY of list indices normalizes to no string parts at all, so there is
// nothing to match and the screen misses — it must not fall through to matching
// an empty candidate string against a curated pattern.
func TestCovdriftedWatchlistIndexOnlySegments(t *testing.T) {
	checkout := copyCheckoutFixture(t)
	w, err := LoadWatchlist(checkout)
	if err != nil {
		t.Fatalf("LoadWatchlist: %v", err)
	}
	cases := []struct {
		name  string
		rtype string
		segs  []any
	}{
		{name: "single index on an unlisted type", rtype: "aws_db_instance", segs: []any{0}},
		{name: "several indices on an unlisted type", rtype: "aws_db_instance", segs: []any{0, 1}},
		{name: "no segments at all", rtype: "aws_db_instance", segs: nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if why, hit := w.Hit(tc.rtype, tc.segs); hit {
				t.Fatalf("index-only segments hit the watchlist (why=%q)", why)
			}
		})
	}

	// Contrast: the wildcard resource_types entry still hits regardless of the
	// path, so the miss above is genuinely about the path candidates.
	if _, hit := w.Hit("aws_security_group", []any{0}); !hit {
		t.Fatal("the wildcarded resource type stopped hitting — the contrast this test rests on is gone")
	}
}

// TestCovdriftedScreenVerdictSkipsInexpressibleRows pins ScreenVerdict's
// documented skip: a changed row whose segments this engine cannot resolve is
// SKIPPED (deciding expressibility is ClassifyByFields'/GenerateAdopt's job,
// not the fourth screen's) — never treated as a hit, and never as a
// pass-through that clears the rest of the verdict. The two cases differ only in
// the row's segment DEPTH, so the skip is the only thing under test.
func TestCovdriftedScreenVerdictSkipsInexpressibleRows(t *testing.T) {
	checkout := copyCheckoutFixture(t)
	w, err := LoadWatchlist(checkout)
	if err != nil {
		t.Fatalf("LoadWatchlist: %v", err)
	}

	t.Run("expressible watchlisted row hits", func(t *testing.T) {
		v := Verdict{
			Address: "aws_db_instance.db1", Type: "aws_db_instance",
			ChangedAttrs: []ChangedAttr{{Path: "publicly_accessible", PathSegments: []any{"publicly_accessible"}}},
		}
		reason, hit := w.ScreenVerdict(v)
		if !hit {
			t.Fatal("an expressible watchlisted row did not hit")
		}
		if !containsAll(reason, "publicly_accessible", "checkout security watchlist", "fourth screen") {
			t.Fatalf("reason = %q, want it to name the path, the watchlist and the screen", reason)
		}
	})

	t.Run("inexpressible row carrying the same leaf is skipped", func(t *testing.T) {
		v := Verdict{
			Address: "aws_db_instance.db1", Type: "aws_db_instance",
			ChangedAttrs: []ChangedAttr{{
				Path:         "a.b.c.publicly_accessible",
				PathSegments: []any{"a", "b", "c", "publicly_accessible"}, // 4 segments: not expressible
			}},
		}
		if PathExpressible(v.ChangedAttrs[0]) {
			t.Fatal("the 4-segment row is expressible — the skip this case rests on is gone")
		}
		if reason, hit := w.ScreenVerdict(v); hit {
			t.Fatalf("an inexpressible row was screened as a hit (reason=%q)", reason)
		}
	})

	t.Run("a skipped row does not stop later rows from hitting", func(t *testing.T) {
		v := Verdict{
			Address: "aws_db_instance.db1", Type: "aws_db_instance",
			ChangedAttrs: []ChangedAttr{
				{Path: "a.b.c.d", PathSegments: []any{"a", "b", "c", "d"}},
				{Path: "publicly_accessible", PathSegments: []any{"publicly_accessible"}},
			},
		}
		reason, hit := w.ScreenVerdict(v)
		if !hit {
			t.Fatal("a watchlisted row after a skipped one did not hit")
		}
		if !strings.Contains(reason, "publicly_accessible") {
			t.Fatalf("reason = %q, want it to name the row that actually hit", reason)
		}
	})
}

// --- digest.go ---------------------------------------------------------------

// TestCovdriftedProposalDigestIsOrderIndependent pins §2.4's "the digest IS the
// storage key" property across the BOTH comparator arms (differing addresses,
// and differing paths within one address): the same drift observed in any
// generation order hashes identically, so regenerating it can never create a
// duplicate proposal — while any change to the pinned content still changes the
// digest. The caller's own slices must come back unreordered.
func TestCovdriftedProposalDigestIsOrderIndependent(t *testing.T) {
	a1 := Attr{Address: "aws_instance.b", Path: "tags.Owner", PathSegments: []any{"tags", "Owner"}, LiveJSON: "bi-team", CodeJSON: "platform"}
	a2 := Attr{Address: "aws_instance.a", Path: "tags.Env", PathSegments: []any{"tags", "Env"}, LiveJSON: "prod", CodeJSON: "staging"}
	a3 := Attr{Address: "aws_instance.a", Path: "tags.Owner", PathSegments: []any{"tags", "Owner"}, LiveJSON: "bi-team", CodeJSON: "platform"}

	addrs := []string{"aws_instance.b", "aws_instance.a"}
	attrs := []Attr{a1, a2, a3}
	want := ProposalDigest("adopt", addrs, attrs)

	t.Run("caller slices are not reordered", func(t *testing.T) {
		if addrs[0] != "aws_instance.b" || attrs[0].Address != "aws_instance.b" {
			t.Fatalf("ProposalDigest mutated its caller's slices: addrs=%v attrs[0]=%+v", addrs, attrs[0])
		}
	})

	t.Run("permutations hash identically", func(t *testing.T) {
		perms := [][]Attr{
			{a3, a2, a1},
			{a2, a1, a3},
			{a2, a3, a1},
			{a1, a3, a2},
		}
		for i, p := range perms {
			if got := ProposalDigest("adopt", []string{"aws_instance.a", "aws_instance.b"}, p); got != want {
				t.Fatalf("permutation %d hashed to %s, want %s", i, got, want)
			}
		}
	})

	t.Run("content changes still change the digest", func(t *testing.T) {
		changed := []Attr{a1, a2, {Address: a3.Address, Path: a3.Path, PathSegments: a3.PathSegments, LiveJSON: "someone-else", CodeJSON: a3.CodeJSON}}
		if got := ProposalDigest("adopt", addrs, changed); got == want {
			t.Fatal("a changed liveJson value produced the same digest")
		}
		if got := ProposalDigest("revert", addrs, attrs); got == want {
			t.Fatal("a different flavor produced the same digest")
		}
	})
}

// TestCovdriftedProposalDigestPanicsOnUncanonicalAttr pins the documented
// fail-fast: Attr.LiveJSON/CodeJSON are contractually the output of
// json.Unmarshal into `any`, so a value that cannot be re-marshaled (here a NaN,
// which no JSON document can express) means a caller synthesized an Attr outside
// that contract. The engine must abort loudly rather than return a digest
// computed from partial bytes — a silently wrong digest IS the storage key.
func TestCovdriftedProposalDigestPanicsOnUncanonicalAttr(t *testing.T) {
	defer func() {
		r := recover()
		if r == nil {
			t.Fatal("ProposalDigest returned normally for an unmarshalable attr, want a fail-fast panic")
		}
		msg, ok := r.(string)
		if !ok {
			t.Fatalf("panic value = %#v, want a string message", r)
		}
		if !strings.HasPrefix(msg, "driftpropose: canonical digest marshal: ") {
			t.Fatalf("panic message = %q, want the canonical-digest-marshal prefix", msg)
		}
	}()

	got := ProposalDigest("adopt", []string{"aws_autoscaling_policy.cpu01"}, []Attr{{
		Address: "aws_autoscaling_policy.cpu01", Path: "target_value", LiveJSON: math.NaN(),
	}})
	t.Fatalf("ProposalDigest = %q, want a panic", got)
}

// TestCovdriftedImportProposalDigest pins §5.4's import formula as the distinct
// shape it is: address order does not matter, the payload texts are hashed (so
// a one-byte change to either moves the digest), and an import digest can never
// collide with the adopt/revert formula for the same address.
func TestCovdriftedImportProposalDigest(t *testing.T) {
	arn := "arn:aws:ec2:eu-west-1:111111111111:instance/i-0abc123def456789a"
	base := ImportProposalDigest([]string{"aws_instance.a", "aws_instance.b"}, &arn, "aws_instance", "i-0abc123def456789a", cleanImportBlock, cleanSkeleton)

	t.Run("address order does not matter", func(t *testing.T) {
		if got := ImportProposalDigest([]string{"aws_instance.b", "aws_instance.a"}, &arn, "aws_instance", "i-0abc123def456789a", cleanImportBlock, cleanSkeleton); got != base {
			t.Fatalf("digest = %s, want %s (addresses are sorted on a copy)", got, base)
		}
	})

	t.Run("every hashed input moves the digest", func(t *testing.T) {
		other := arn + "b"
		cases := []struct {
			name string
			got  string
		}{
			{name: "arn", got: ImportProposalDigest([]string{"aws_instance.a", "aws_instance.b"}, &other, "aws_instance", "i-0abc123def456789a", cleanImportBlock, cleanSkeleton)},
			{name: "nil arn", got: ImportProposalDigest([]string{"aws_instance.a", "aws_instance.b"}, nil, "aws_instance", "i-0abc123def456789a", cleanImportBlock, cleanSkeleton)},
			{name: "tfType", got: ImportProposalDigest([]string{"aws_instance.a", "aws_instance.b"}, &arn, "aws_db_instance", "i-0abc123def456789a", cleanImportBlock, cleanSkeleton)},
			{name: "liveId", got: ImportProposalDigest([]string{"aws_instance.a", "aws_instance.b"}, &arn, "aws_instance", "i-0000000000000000b", cleanImportBlock, cleanSkeleton)},
			{name: "importBlock", got: ImportProposalDigest([]string{"aws_instance.a", "aws_instance.b"}, &arn, "aws_instance", "i-0abc123def456789a", cleanImportBlock+"\n", cleanSkeleton)},
			{name: "skeletonHcl", got: ImportProposalDigest([]string{"aws_instance.a", "aws_instance.b"}, &arn, "aws_instance", "i-0abc123def456789a", cleanImportBlock, cleanSkeleton+"# x\n")},
		}
		for _, tc := range cases {
			if tc.got == base {
				t.Errorf("changing %s did not change the digest", tc.name)
			}
		}
	})

	t.Run("never collides with the adopt formula", func(t *testing.T) {
		if base == ProposalDigest("import", []string{"aws_instance.a", "aws_instance.b"}, nil) {
			t.Fatal("the import formula collided with the adopt/revert canonical-JSON formula")
		}
	})
}
