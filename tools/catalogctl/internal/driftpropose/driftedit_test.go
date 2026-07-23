package driftpropose

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeJSONFile(t *testing.T, dir, name, body string) string {
	t.Helper()
	p := filepath.Join(dir, name)
	if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

func runDriftEditCLI(args []string) (int, string) {
	var out, errb bytes.Buffer
	code := runDriftEdit(args, &out, &errb)
	return code, out.String() + errb.String()
}

// TestDriftEditRequiredFlags pins the flag-validation contract (spec §2-F1c
// mirrors drift-propose's own --envelope/--repo/--root/--out exit-3 contract).
func TestDriftEditRequiredFlags(t *testing.T) {
	code, out := runDriftEditCLI([]string{"--request", "x"})
	if code != 3 {
		t.Fatalf("code = %d, want 3 (%s)", code, out)
	}
}

// TestDriftEditMalformedRequest pins the unreadable/unparseable JSON contract.
func TestDriftEditMalformedRequest(t *testing.T) {
	dir := t.TempDir()
	f := writeJSONFile(t, dir, "bad.json", "{not json")
	code, _ := runDriftEditCLI([]string{"--request", f, "--repo", dir, "--root", "environments/prod"})
	if code != 3 {
		t.Fatalf("code = %d, want 3", code)
	}
}

// TestDriftEditUnknownOpRefuses pins §2-F1c: every item must name a
// gate-known drift op (adopt, revert, import, restore, or legitimize as of
// plan 2026-07-20-drift-restore-tranche.md — see TestDriftEditRestoreIsNoEdit
// and TestDriftEditLegitimizeIsNoEdit for those two) — anything else exits 3.
// Before register 0009 L32, this test's example op was system-drift-
// legitimize itself (then unrecognised, spec addendum A6/C2); L32 taught the
// switch that op, so the example is now a made-up op nobody will ever
// implement (mirrors driftgate_test.go's own "system-drift-teleport"), which
// keeps testing the SAME invariant this test has always pinned.
func TestDriftEditUnknownOpRefuses(t *testing.T) {
	dir := t.TempDir()
	f := writeJSONFile(t, dir, "req.json", `{"operationId":"system-drift-teleport","params":{}}`)
	code, out := runDriftEditCLI([]string{"--request", f, "--repo", dir, "--root", "environments/prod"})
	if code != 3 {
		t.Fatalf("code = %d, want 3 (%s)", code, out)
	}
}

// TestDriftEditMixedOpsRefuses pins the same doctrine peekDriftOp enforces at
// the gate: a batch whose items don't all name the SAME drift op is malformed
// — no honest producer, exit 3.
func TestDriftEditMixedOpsRefuses(t *testing.T) {
	dir := t.TempDir()
	body := `{"operationId":"system-drift-adopt","params":{},"items":[
		{"operationId":"system-drift-adopt","params":{"attrs":[],"verdicts":[]}},
		{"operationId":"system-drift-revert","params":{"attrs":[]}}
	]}`
	f := writeJSONFile(t, dir, "req.json", body)
	code, _ := runDriftEditCLI([]string{"--request", f, "--repo", dir, "--root", "environments/prod"})
	if code != 3 {
		t.Fatalf("code = %d, want 3", code)
	}
}

// TestDriftEditBadCheckoutExits4 pins the checkout-usability contract.
func TestDriftEditBadCheckoutExits4(t *testing.T) {
	dir := t.TempDir()
	f := writeJSONFile(t, dir, "req.json", `{"operationId":"system-drift-revert","params":{"attrs":[{"address":"a","path":"b"}]}}`)
	code, _ := runDriftEditCLI([]string{"--request", f, "--repo", dir, "--root", "does-not-exist"})
	if code != 4 {
		t.Fatalf("code = %d, want 4", code)
	}
}

// TestDriftEditRevertIsNoEdit pins spec §6.4/§7: revert carries NO edit —
// drift-edit prints an INFO line and exits 0 without touching the checkout
// (one uniform gate script calls drift-edit unconditionally for every drift op).
func TestDriftEditRevertIsNoEdit(t *testing.T) {
	checkout := copyCheckoutFixture(t)
	before, err := os.ReadFile(filepath.Join(checkout, "environments/prod/main.tf"))
	if err != nil {
		t.Fatal(err)
	}
	code, out := runDriftEditCLI([]string{
		"--request", "../../testdata/driftpropose/seam/bundle-request-revert.json",
		"--repo", checkout, "--root", "environments/prod",
	})
	if code != 0 {
		t.Fatalf("code = %d, want 0 (%s)", code, out)
	}
	if !strings.Contains(out, "no edit") {
		t.Fatalf("out = %q, want an INFO line about no edit", out)
	}
	after, err := os.ReadFile(filepath.Join(checkout, "environments/prod/main.tf"))
	if err != nil {
		t.Fatal(err)
	}
	if string(before) != string(after) {
		t.Fatal("drift-edit wrote to the checkout for a revert item")
	}
}

// TestDriftEditRestoreIsNoEdit pins plan 2026-07-20-drift-restore-tranche.md
// §2.4: restore carries NO edit, mirroring TestDriftEditRevertIsNoEdit — an
// INFO line, exit 0, and the checkout untouched (the mechanical meaning is
// "re-assert code already on main," enforced later by plan-check R9, never by
// an edit here).
func TestDriftEditRestoreIsNoEdit(t *testing.T) {
	checkout := copyCheckoutFixture(t)
	before, err := os.ReadFile(filepath.Join(checkout, "environments/prod/main.tf"))
	if err != nil {
		t.Fatal(err)
	}
	code, out := runDriftEditCLI([]string{
		"--request", "../../testdata/driftpropose/seam/bundle-request-restore.json",
		"--repo", checkout, "--root", "environments/prod",
	})
	if code != 0 {
		t.Fatalf("code = %d, want 0 (%s)", code, out)
	}
	if !strings.Contains(out, "no edit") {
		t.Fatalf("out = %q, want an INFO line about no edit", out)
	}
	if !strings.Contains(out, "system-drift-restore") {
		t.Fatalf("out = %q, want the INFO line to name the op", out)
	}
	after, err := os.ReadFile(filepath.Join(checkout, "environments/prod/main.tf"))
	if err != nil {
		t.Fatal(err)
	}
	if string(before) != string(after) {
		t.Fatal("drift-edit wrote to the checkout for a restore item")
	}
}

// TestDriftEditLegitimizeIsNoEdit pins plan
// 2026-07-20-drift-restore-tranche.md §4 (register 0009 L32): legitimize also
// carries NO edit — the engineer's convergence change already landed via its
// own linked PR before this request was ever submitted. Mirrors
// TestDriftEditRestoreIsNoEdit/TestDriftEditRevertIsNoEdit.
func TestDriftEditLegitimizeIsNoEdit(t *testing.T) {
	checkout := copyCheckoutFixture(t)
	before, err := os.ReadFile(filepath.Join(checkout, "environments/prod/main.tf"))
	if err != nil {
		t.Fatal(err)
	}
	code, out := runDriftEditCLI([]string{
		"--request", "../../testdata/driftpropose/seam/bundle-request-legitimize.json",
		"--repo", checkout, "--root", "environments/prod",
	})
	if code != 0 {
		t.Fatalf("code = %d, want 0 (%s)", code, out)
	}
	if !strings.Contains(out, "no edit") {
		t.Fatalf("out = %q, want an INFO line about no edit", out)
	}
	if !strings.Contains(out, "system-drift-legitimize") {
		t.Fatalf("out = %q, want the INFO line to name the op", out)
	}
	after, err := os.ReadFile(filepath.Join(checkout, "environments/prod/main.tf"))
	if err != nil {
		t.Fatal(err)
	}
	if string(before) != string(after) {
		t.Fatal("drift-edit wrote to the checkout for a legitimize item")
	}
}

// TestDriftEditAdoptSingleItemWrites pins the happy path: the single-item
// bundle-request-adopt.json seam fixture writes the exact edit ApplyAdopt was
// proven to produce (TestAdoptEditGolden's golden diff), then a SECOND
// invocation (checkout now already matches) reports "no edits needed" —
// verified no-op is success, not a refusal.
func TestDriftEditAdoptSingleItemWrites(t *testing.T) {
	checkout := copyCheckoutFixture(t)
	code, out := runDriftEditCLI([]string{
		"--request", "../../testdata/driftpropose/seam/bundle-request-adopt.json",
		"--repo", checkout, "--root", "environments/prod",
	})
	if code != 0 {
		t.Fatalf("code = %d, want 0 (%s)", code, out)
	}
	got, err := os.ReadFile(filepath.Join(checkout, "environments/prod/main.tf"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(got), `Owner = "bi-team"`) {
		t.Fatalf("main.tf was not edited: %s", got)
	}

	code2, out2 := runDriftEditCLI([]string{
		"--request", "../../testdata/driftpropose/seam/bundle-request-adopt.json",
		"--repo", checkout, "--root", "environments/prod",
	})
	if code2 != 0 {
		t.Fatalf("second run code = %d, want 0 (%s)", code2, out2)
	}
	if !strings.Contains(out2, "no edits needed") {
		t.Fatalf("second run out = %q, want the verified-no-op INFO line", out2)
	}
}

// TestDriftEditAdoptBatchedSetWritesBothItems pins spec addendum A2/F1(b)'s
// core fix at the drift-edit layer too: a batched adopt change-set replays
// EVERY item, not only the primary.
func TestDriftEditAdoptBatchedSetWritesBothItems(t *testing.T) {
	checkout := copyCheckoutFixture(t)
	code, out := runDriftEditCLI([]string{
		"--request", "../../testdata/driftpropose/seam/bundle-request-adopt-set.json",
		"--repo", checkout, "--root", "environments/prod",
	})
	if code != 0 {
		t.Fatalf("code = %d, want 0 (%s)", code, out)
	}
	main, err := os.ReadFile(filepath.Join(checkout, "environments/prod/main.tf"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(main), `Owner = "bi-team"`) {
		t.Fatalf("item 0 (main.tf) was not edited: %s", main)
	}
	dotted, err := os.ReadFile(filepath.Join(checkout, "environments/prod/extra-dotted-key.tf"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(dotted), `"kubernetes.io/role/elb" = "owned"`) {
		t.Fatalf("item 1 (extra-dotted-key.tf) was not edited: %s", dotted)
	}
}

// TestDriftEditDigestMismatchRefuses is the tampered-twin half of spec
// addendum A3/F1(d): a pinned request whose attrs don't hash to its own pinned
// proposalDigest is refused BEFORE any edit runs — tamper evidence.
func TestDriftEditDigestMismatchRefuses(t *testing.T) {
	checkout := copyCheckoutFixture(t)
	before, err := os.ReadFile(filepath.Join(checkout, "environments/prod/main.tf"))
	if err != nil {
		t.Fatal(err)
	}
	code, out := runDriftEditCLI([]string{
		"--request", "../../testdata/driftpropose/seam/bundle-request-adopt-tampered.json",
		"--repo", checkout, "--root", "environments/prod",
	})
	if code != 2 {
		t.Fatalf("code = %d, want 2 (%s)", code, out)
	}
	if !strings.Contains(out, "digest mismatch") {
		t.Fatalf("out = %q, want it to name the digest mismatch", out)
	}
	after, err := os.ReadFile(filepath.Join(checkout, "environments/prod/main.tf"))
	if err != nil {
		t.Fatal(err)
	}
	if string(before) != string(after) {
		t.Fatal("a tampered request's checkout was still edited — the digest check must run BEFORE any write")
	}
}

// mustAdoptRequestFile builds a minimal, internally-consistent single-item
// adopt bundle request file (correct digest so ONLY the caller's own deviation
// — a forged verdict, an absent address, … — is under test).
func mustAdoptRequestFile(t *testing.T, attrs []Attr, verdicts []Verdict) string {
	t.Helper()
	addrs := addressesFromAttrs(attrs)
	digest := ProposalDigest("adopt", addrs, attrs)
	body, err := json.Marshal(map[string]any{
		"operationId": opAdopt,
		"params":      AdoptParams{Attrs: attrs, Verdicts: verdicts, ProposalDigest: digest},
	})
	if err != nil {
		t.Fatal(err)
	}
	f := filepath.Join(t.TempDir(), "req.json")
	if err := os.WriteFile(f, body, 0o644); err != nil {
		t.Fatal(err)
	}
	return f
}

// TestDriftEditRefusesForgedSecurityVerdict pins enforcement point 3
// (independent of points 1-2, spec §8): a pinned verdict carrying a
// securityHits row is refused at drift-edit time too, not just at
// RunDriftGate (plancheck's own TestGateRefusesSecurityAdopt covers point 3
// at the LATER, plan-check layer — this is the SAME independent doctrine
// proven at the EARLIER, edit-replay layer).
func TestDriftEditRefusesForgedSecurityVerdict(t *testing.T) {
	checkout := copyCheckoutFixture(t)
	attrs := []Attr{{Address: "aws_instance.sample01", Path: "tags.Owner", PathSegments: []any{"tags", "Owner"}, LiveJSON: "bi-team", CodeJSON: "platform"}}
	v := Verdict{
		Address: "aws_instance.sample01", Type: "aws_instance", Class: "benign_inplace", RiskTier: "low",
		DriftEvidence: true, Actions: []string{"update"},
		SecurityHits: []SecurityHit{{Path: "tags.Owner", Why: "forged"}},
		ChangedAttrs: []ChangedAttr{{Path: "tags.Owner", Sensitive: false, LiveJSON: json.RawMessage(`"bi-team"`), CodeJSON: json.RawMessage(`"platform"`), PathSegments: []any{"tags", "Owner"}}},
	}
	f := mustAdoptRequestFile(t, attrs, []Verdict{v})
	code, out := runDriftEditCLI([]string{"--request", f, "--repo", checkout, "--root", "environments/prod"})
	if code != 2 {
		t.Fatalf("code = %d, want 2 (%s)", code, out)
	}
	if !strings.Contains(out, "eligibility") {
		t.Fatalf("out = %q, want it to name the eligibility failure", out)
	}
}

// TestDriftEditRefusesWatchlistedAdopt pins F4's fourth screen wired at
// enforcement point 3 (drift-edit's own pre-edit check) — independent of
// TestFourthScreenForgedEnvelope's point-1 (Generate) coverage: the SAME
// forged-envelope shape (benign class, empty securityHits, a
// watchlist-matching path made expressible by W1) is refused here too, at
// exit 2, before any edit.
func TestDriftEditRefusesWatchlistedAdopt(t *testing.T) {
	checkout := copyCheckoutFixture(t)
	attrs := []Attr{{Address: "aws_security_group.sg1", Path: "ingress[0].cidr_blocks", PathSegments: []any{"ingress", 0, "cidr_blocks"}, LiveJSON: []any{"0.0.0.0/0"}, CodeJSON: []any{"10.0.0.0/16"}}}
	v := Verdict{
		Address: "aws_security_group.sg1", Type: "aws_security_group", Class: "benign_inplace", RiskTier: "low",
		DriftEvidence: true, Actions: []string{"update"},
		ChangedAttrs: []ChangedAttr{{Path: "ingress[0].cidr_blocks", Sensitive: false, LiveJSON: json.RawMessage(`["0.0.0.0/0"]`), CodeJSON: json.RawMessage(`["10.0.0.0/16"]`), PathSegments: []any{"ingress", 0, "cidr_blocks"}}},
	}
	f := mustAdoptRequestFile(t, attrs, []Verdict{v})
	code, out := runDriftEditCLI([]string{"--request", f, "--repo", checkout, "--root", "environments/prod"})
	if code != 2 {
		t.Fatalf("code = %d, want 2 (%s)", code, out)
	}
	if !strings.Contains(out, "checkout security watchlist") {
		t.Fatalf("out = %q, want it to name the fourth screen", out)
	}
}

// TestDriftEditAddressGoneRefuses pins the "ungenerable checkout-dependent
// refinement" refusal class (spec §2-F1c: "address gone, map missing, …") —
// exit 2 (a data-driven refusal), not exit 1 (an internal error).
func TestDriftEditAddressGoneRefuses(t *testing.T) {
	checkout := copyCheckoutFixture(t)
	attrs := []Attr{{Address: "aws_instance.does_not_exist", Path: "tags.Owner", PathSegments: []any{"tags", "Owner"}, LiveJSON: "bi-team", CodeJSON: "platform"}}
	v := Verdict{
		Address: "aws_instance.does_not_exist", Type: "aws_instance", Class: "benign_inplace", RiskTier: "low",
		DriftEvidence: true, Actions: []string{"update"},
		ChangedAttrs: []ChangedAttr{{Path: "tags.Owner", Sensitive: false, LiveJSON: json.RawMessage(`"bi-team"`), CodeJSON: json.RawMessage(`"platform"`), PathSegments: []any{"tags", "Owner"}}},
	}
	f := mustAdoptRequestFile(t, attrs, []Verdict{v})
	code, out := runDriftEditCLI([]string{"--request", f, "--repo", checkout, "--root", "environments/prod"})
	if code != 2 {
		t.Fatalf("code = %d, want 2 (%s)", code, out)
	}
	if !strings.Contains(out, "not found in checkout") {
		t.Fatalf("out = %q, want it to name the missing address", out)
	}
}

// TestDriftEditUnreadableWatchlistRefusesAdopt pins F4's fail-closed doctrine
// at drift-edit's own layer (Generate's own copy is
// TestFourthScreenUnreadableWatchlistRefusesWholeAdoptBucket): a checkout with
// no watchlist file refuses every adopt item, exit 2.
func TestDriftEditUnreadableWatchlistRefusesAdopt(t *testing.T) {
	checkout := copyCheckoutFixtureWithoutWatchlist(t)
	code, out := runDriftEditCLI([]string{
		"--request", "../../testdata/driftpropose/seam/bundle-request-adopt.json",
		"--repo", checkout, "--root", "environments/prod",
	})
	if code != 2 {
		t.Fatalf("code = %d, want 2 (%s)", code, out)
	}
	if !strings.Contains(out, "watchlist unreadable") {
		t.Fatalf("out = %q, want it to name the unreadable watchlist", out)
	}
}

// --- import (spec 2026-07-20-ccp-oob-provisioning-import.md §7.1) ---

// importItemSpec pairs one finding with its reviewed import payload — the
// two pinned inputs a system-drift-import request item carries.
type importItemSpec struct {
	Finding Finding
	Payload FindingImportPayload
}

// importParamsFor also stamps s.Payload onto the pinned Finding's OWN
// ImportPayload field: in the real system the pinned `finding` IS the
// current stored sweep row, which by definition already carries this same
// payload (ClassifyFinding's BucketImport contract requires it) — a caller
// here only states the payload once (s.Payload), and this keeps both copies
// consistent rather than asking every test to duplicate it by hand.
func importParamsFor(s importItemSpec) ImportParams {
	f := s.Finding
	payload := s.Payload
	f.ImportPayload = &payload
	digest := ImportProposalDigest([]string{s.Payload.Address}, f.Arn, f.TfType, f.LiveID, s.Payload.ImportBlock, s.Payload.SkeletonHcl)
	return ImportParams{Finding: f, ImportPayload: s.Payload, ProposalDigest: digest}
}

// mustImportRequestFile builds an internally-consistent (correct digest per
// item) system-drift-import bundle request file — a single item when one
// spec is given, a batched items[] change-set otherwise (mirrors
// bundle-request-adopt-set.json's own top-level-pair-plus-items shape;
// ItemsOrSelf prefers items[] whenever it is non-empty, so the top-level
// pair here is redundant but wire-shape-faithful).
func mustImportRequestFile(t *testing.T, specs ...importItemSpec) string {
	t.Helper()
	if len(specs) == 0 {
		t.Fatal("mustImportRequestFile: at least one item required")
	}
	items := make([]map[string]any, len(specs))
	for i, s := range specs {
		items[i] = map[string]any{"operationId": opImport, "params": importParamsFor(s)}
	}
	body, err := json.Marshal(map[string]any{
		"operationId": opImport,
		"params":      importParamsFor(specs[0]),
		"items":       items,
	})
	if err != nil {
		t.Fatal(err)
	}
	f := filepath.Join(t.TempDir(), "req.json")
	if err := os.WriteFile(f, body, 0o644); err != nil {
		t.Fatal(err)
	}
	return f
}

func bastionImportItem() importItemSpec {
	return importItemSpec{
		Finding: Finding{Class: findingClass, TfType: "aws_instance", LiveID: "i-0abc123def456789a", SecurityFamily: false},
		Payload: FindingImportPayload{
			Address: "aws_instance.oob_bastion01", TargetFile: oobAdoptedFile,
			ImportBlock: cleanImportBlock, SkeletonHcl: cleanSkeleton,
		},
	}
}

func secondImportItem() importItemSpec {
	return importItemSpec{
		Finding: Finding{Class: findingClass, TfType: "aws_instance", LiveID: "i-0def456abc123789b", SecurityFamily: false},
		Payload: FindingImportPayload{
			Address:     "aws_instance.oob_second01",
			TargetFile:  oobAdoptedFile,
			ImportBlock: "import {\n  to = aws_instance.oob_second01\n  id = \"i-0def456abc123789b\"\n}\n",
			SkeletonHcl: "resource \"aws_instance\" \"oob_second01\" {\n  ami           = \"ami-0fedcba9876543210\"\n  instance_type = \"t3.small\"\n}\n",
		},
	}
}

// TestDriftEditImportComposes pins spec §7.1 step 3 end to end: a batched
// import change-set (two items, in order) writes environments/prod/oob-adopted.tf
// with the generated-by banner, both items' exact reviewed bytes, exactly
// one blank line between every pair of blocks (never a run of blank lines),
// and items composed in request order. A THIRD, re-submitted run of the
// SAME (now-satisfied) request is then refused as a collision on both
// addresses — spec §7.1 step 2: "a re-run after a prior successful import
// lands here — correctly, since the next plan would refuse the re-import."
func TestDriftEditImportComposes(t *testing.T) {
	checkout := copyCheckoutFixture(t)
	item1, item2 := bastionImportItem(), secondImportItem()
	f := mustImportRequestFile(t, item1, item2)

	code, out := runDriftEditCLI([]string{"--request", f, "--repo", checkout, "--root", "environments/prod"})
	if code != 0 {
		t.Fatalf("code = %d, want 0 (%s)", code, out)
	}
	if !strings.Contains(out, "imported aws_instance.oob_bastion01") || !strings.Contains(out, "imported aws_instance.oob_second01") {
		t.Fatalf("out = %q, want both addresses confirmed", out)
	}

	target := filepath.Join(checkout, "environments/prod", oobAdoptedFile)
	got, err := os.ReadFile(target)
	if err != nil {
		t.Fatalf("%s was not written: %v", oobAdoptedFile, err)
	}
	content := string(got)

	if !strings.Contains(content, "Generated by catalogctl drift-edit") {
		t.Fatal("missing the generated-by banner")
	}
	if !strings.Contains(content, item1.Payload.ImportBlock) || !strings.Contains(content, item1.Payload.SkeletonHcl) {
		t.Fatalf("item 1's import block/skeleton not composed verbatim:\n%s", content)
	}
	if !strings.Contains(content, item2.Payload.ImportBlock) || !strings.Contains(content, item2.Payload.SkeletonHcl) {
		t.Fatalf("item 2's import block/skeleton not composed verbatim:\n%s", content)
	}
	if strings.Index(content, "oob_bastion01") > strings.Index(content, "oob_second01") {
		t.Fatalf("items composed out of request order:\n%s", content)
	}
	if strings.Contains(content, "\n\n\n") {
		t.Fatalf("more than one blank line somewhere in the composed file (want exactly one between every pair of blocks):\n%s", content)
	}
	if !strings.HasSuffix(content, "\n") || strings.HasSuffix(content, "\n\n") {
		t.Fatalf("file must end with exactly one trailing newline:\n%q", content)
	}

	// Re-run: both addresses now resolve in the checkout (their skeletons
	// just landed in oob-adopted.tf) — the collision screen must refuse.
	code2, out2 := runDriftEditCLI([]string{"--request", f, "--repo", checkout, "--root", "environments/prod"})
	if code2 != 2 {
		t.Fatalf("re-run code = %d, want 2 (%s)", code2, out2)
	}
	if !strings.Contains(out2, "already resolves") {
		t.Fatalf("re-run out = %q, want it to name the collision", out2)
	}
	after, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	if string(after) != content {
		t.Fatal("a refused re-run still modified oob-adopted.tf")
	}
}

// TestDriftEditImportDigestMismatchRefuses is import's tamper-evidence twin
// of TestDriftEditDigestMismatchRefuses: a pinned request whose finding/
// payload bytes don't hash to its own pinned proposalDigest is refused
// BEFORE any write.
func TestDriftEditImportDigestMismatchRefuses(t *testing.T) {
	checkout := copyCheckoutFixture(t)
	item := bastionImportItem()
	params := importParamsFor(item)
	params.ProposalDigest = "0000000000000000000000000000000000000000000000000000000000000000" // wrong, on purpose
	body, err := json.Marshal(map[string]any{"operationId": opImport, "params": params})
	if err != nil {
		t.Fatal(err)
	}
	f := filepath.Join(t.TempDir(), "req.json")
	if err := os.WriteFile(f, body, 0o644); err != nil {
		t.Fatal(err)
	}

	code, out := runDriftEditCLI([]string{"--request", f, "--repo", checkout, "--root", "environments/prod"})
	if code != 2 {
		t.Fatalf("code = %d, want 2 (%s)", code, out)
	}
	if !strings.Contains(out, "digest mismatch") {
		t.Fatalf("out = %q, want it to name the digest mismatch", out)
	}
	if _, err := os.Stat(filepath.Join(checkout, "environments/prod", oobAdoptedFile)); err == nil {
		t.Fatal("a tampered import request still wrote oob-adopted.tf")
	}
}

// TestDriftEditImportRefusesCreationSecurity pins §5.3 screen 3 at
// drift-edit's own layer: the checkout's own creation_security_types
// (fixture: aws_iam_role) refuses an import even though the pinned finding's
// OWN securityFamily field claims false — independent re-derivation, not a
// trust of the pinned data.
func TestDriftEditImportRefusesCreationSecurity(t *testing.T) {
	checkout := copyCheckoutFixture(t)
	item := importItemSpec{
		Finding: Finding{Class: findingClass, TfType: "aws_iam_role", LiveID: "oob-forged-role", SecurityFamily: false},
		Payload: FindingImportPayload{
			Address: "aws_iam_role.oob_forged01", TargetFile: oobAdoptedFile,
			ImportBlock: "import {\n  to = aws_iam_role.oob_forged01\n  id = \"oob-forged-role\"\n}\n",
			SkeletonHcl: "resource \"aws_iam_role\" \"oob_forged01\" {\n  name = \"oob-forged-role\"\n}\n",
		},
	}
	f := mustImportRequestFile(t, item)

	code, out := runDriftEditCLI([]string{"--request", f, "--repo", checkout, "--root", "environments/prod"})
	if code != 2 {
		t.Fatalf("code = %d, want 2 (%s)", code, out)
	}
	if !strings.Contains(out, "creation_security_types") {
		t.Fatalf("out = %q, want it to name the checkout screen", out)
	}
	if _, err := os.Stat(filepath.Join(checkout, "environments/prod", oobAdoptedFile)); err == nil {
		t.Fatal("a creation-security import still wrote oob-adopted.tf")
	}
}

// TestDriftEditImportRefusesAddressAlreadyManaged pins the collision screen
// against an address that is managed FROM THE START (aws_instance.sample01,
// defined in the shared checkout fixture's main.tf) — distinct from
// TestDriftEditImportComposes' re-run shape, which gets there via a prior
// drift-edit write in the SAME test.
func TestDriftEditImportRefusesAddressAlreadyManaged(t *testing.T) {
	checkout := copyCheckoutFixture(t)
	item := importItemSpec{
		Finding: Finding{Class: findingClass, TfType: "aws_instance", LiveID: "i-already-managed", SecurityFamily: false},
		Payload: FindingImportPayload{
			Address: "aws_instance.sample01", TargetFile: oobAdoptedFile,
			ImportBlock: "import {\n  to = aws_instance.sample01\n  id = \"i-already-managed\"\n}\n",
			SkeletonHcl: "resource \"aws_instance\" \"sample01\" {\n  ami = \"ami-0123456789abcdef0\"\n}\n",
		},
	}
	f := mustImportRequestFile(t, item)

	code, out := runDriftEditCLI([]string{"--request", f, "--repo", checkout, "--root", "environments/prod"})
	if code != 2 {
		t.Fatalf("code = %d, want 2 (%s)", code, out)
	}
	if !strings.Contains(out, "already resolves") {
		t.Fatalf("out = %q, want it to name the collision", out)
	}
}
