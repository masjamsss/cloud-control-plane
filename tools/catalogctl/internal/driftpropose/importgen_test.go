package driftpropose

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// cleanImportFinding is a fresh, otherwise-import-eligible finding whose
// address ("aws_instance.oob_bastion01") is absent from the shared
// testdata/driftpropose/checkout fixture — the happy-path shape every test
// below starts from and mutates.
func cleanImportFinding() Finding {
	return Finding{
		Class:          findingClass,
		TfType:         "aws_instance",
		LiveID:         "i-0abc123def456789a",
		SecurityFamily: false,
		ImportPayload: &FindingImportPayload{
			Address:     "aws_instance.oob_bastion01",
			TargetFile:  "oob-adopted.tf",
			ImportBlock: cleanImportBlock,
			SkeletonHcl: cleanSkeleton,
		},
	}
}

// TestGenerateImportHappyPath drives GenerateImport directly against the
// shared checkout fixture (a fresh address, absent from every *.tf there)
// and asserts the proposal shape spec §5.1 pins: flavor "import", attrs: []
// (not nil — the digest/marshal contract, spec: '"attrs": []'), a non-nil
// importPayload carrying arn/tfType/liveId alongside the reviewed bytes, a
// nil diff, and a requestSkeleton item naming system-drift-import.
func TestGenerateImportHappyPath(t *testing.T) {
	checkout := copyCheckoutFixture(t)
	f := cleanImportFinding()

	p, ungenReason, err := GenerateImport(f, filepath.Join(checkout, "environments/prod"))
	if err != nil {
		t.Fatalf("GenerateImport: %v", err)
	}
	if ungenReason != "" {
		t.Fatalf("unexpected ungenerable reason: %s", ungenReason)
	}
	if p == nil {
		t.Fatal("GenerateImport returned a nil proposal with no reason and no error")
	}
	if p.Flavor != "import" {
		t.Errorf("flavor = %q, want import", p.Flavor)
	}
	if len(p.Addresses) != 1 || p.Addresses[0] != "aws_instance.oob_bastion01" {
		t.Errorf("addresses = %v, want [aws_instance.oob_bastion01]", p.Addresses)
	}
	if p.Attrs == nil || len(p.Attrs) != 0 {
		t.Errorf("attrs = %v, want a non-nil empty slice (marshals to [])", p.Attrs)
	}
	if p.Diff != nil {
		t.Errorf("diff = %v, want nil", p.Diff)
	}
	if p.ImportPayload == nil {
		t.Fatal("importPayload is nil")
	}
	if p.ImportPayload.TfType != "aws_instance" || p.ImportPayload.LiveID != "i-0abc123def456789a" {
		t.Errorf("importPayload identity = %+v, want tfType/liveId carried from the finding", p.ImportPayload)
	}
	if p.ImportPayload.ImportBlock != cleanImportBlock || p.ImportPayload.SkeletonHcl != cleanSkeleton {
		t.Error("importPayload does not carry the exact reviewed bytes")
	}
	wantDigest := ImportProposalDigest([]string{"aws_instance.oob_bastion01"}, f.Arn, "aws_instance", "i-0abc123def456789a", cleanImportBlock, cleanSkeleton)
	if p.Digest != wantDigest {
		t.Errorf("digest = %s, want %s", p.Digest, wantDigest)
	}
	if len(p.RequestSkeleton.Items) != 1 {
		t.Fatalf("requestSkeleton.items has %d entries, want 1", len(p.RequestSkeleton.Items))
	}
	item := p.RequestSkeleton.Items[0]
	if item.OperationID != "system-drift-import" {
		t.Errorf("operationId = %q, want system-drift-import", item.OperationID)
	}
	if item.TargetAddress != "aws_instance.oob_bastion01" {
		t.Errorf("targetAddress = %q, want aws_instance.oob_bastion01", item.TargetAddress)
	}
	if item.Params.ProposalDigest != p.Digest {
		t.Errorf("params.proposalDigest = %q, want it to equal the proposal digest %q", item.Params.ProposalDigest, p.Digest)
	}
	if item.Params.ImportPayload == nil || item.Params.ImportPayload.SkeletonHcl != cleanSkeleton {
		t.Error("params.importPayload does not carry the reviewed skeleton bytes")
	}
	if len(item.Params.Attrs) != 0 {
		t.Errorf("params.attrs = %v, want empty/absent for import", item.Params.Attrs)
	}

	// The exact bytes command.go's `run` writes to --out: "attrs": [] and
	// "importPayload": {...} must both render (never "attrs": null nor a
	// dropped importPayload key).
	b, err := json.Marshal(p)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if !strings.Contains(string(b), `"attrs":[]`) {
		t.Errorf("marshaled proposal does not carry a literal empty attrs array: %s", b)
	}
	if !strings.Contains(string(b), `"importPayload":{`) {
		t.Errorf("marshaled proposal does not carry an importPayload object: %s", b)
	}
}

// TestGenerateImportRefusesAddressAlreadyInCheckout pins spec §5.2 F-1's
// checkout-dependent condition ("address absent from the checkout") and
// §7.1 step 2's collision doctrine restated at generation time: an address
// that already resolves to a block in the checkout (aws_instance.sample01,
// defined in the shared fixture's main.tf) is ungenerable, never re-proposed.
func TestGenerateImportRefusesAddressAlreadyInCheckout(t *testing.T) {
	checkout := copyCheckoutFixture(t)
	f := cleanImportFinding()
	f.ImportPayload.Address = "aws_instance.sample01"
	f.ImportPayload.ImportBlock = "import {\n  to = aws_instance.sample01\n  id = \"i-0abc123def456789a\"\n}\n"

	p, reason, err := GenerateImport(f, filepath.Join(checkout, "environments/prod"))
	if err != nil {
		t.Fatalf("GenerateImport returned an error, want a clean ungenerable reason: %v", err)
	}
	if p != nil {
		t.Fatalf("GenerateImport proposed importing an address already managed in the checkout: %+v", p)
	}
	if !containsAll(reason, "aws_instance.sample01", "already resolves", "already managed") {
		t.Fatalf("reason = %q, want it to name the collision", reason)
	}
}

// TestGenerateWithImportOffIsByteIdenticalToGenerate pins spec §5.1: "off ⇒
// behavior today, byte-identical." An envelope carrying BOTH verdicts and a
// sweep section produces the EXACT SAME proposals.json through
// GenerateWithImport(..., false) as through the plain, pre-existing
// Generate() — the sweep section is silently, completely ignored.
func TestGenerateWithImportOffIsByteIdenticalToGenerate(t *testing.T) {
	checkout := copyCheckoutFixture(t)
	env := loadCombinedEnvelope(t)
	env.Sweep = &Sweep{Findings: []Finding{cleanImportFinding()}}

	withoutFlag, err := Generate(env, checkout, "environments/prod")
	if err != nil {
		t.Fatalf("Generate: %v", err)
	}
	flagOff, err := GenerateWithImport(env, checkout, "environments/prod", false)
	if err != nil {
		t.Fatalf("GenerateWithImport(false): %v", err)
	}
	b1, _ := json.Marshal(withoutFlag)
	b2, _ := json.Marshal(flagOff)
	if string(b1) != string(b2) {
		t.Fatalf("Generate and GenerateWithImport(..., false) disagree on a sweep-carrying envelope:\n%s\nvs\n%s", b1, b2)
	}

	// And bytes must match the PRE-EXISTING golden fixture too — proving env's
	// added Sweep field changes nothing about the verdict-only output.
	want, err := os.ReadFile("../../testdata/driftpropose/golden/proposals.json")
	if err != nil {
		t.Fatalf("read golden: %v", err)
	}
	got, err := json.MarshalIndent(withoutFlag, "", "  ")
	if err != nil {
		t.Fatalf("marshal indent: %v", err)
	}
	got = append(got, '\n')
	if string(got) != string(want) {
		t.Fatalf("Generate output changed by the mere presence of env.Sweep (flag off):\n--- got ---\n%s\n--- want ---\n%s", got, want)
	}
}

// TestGenerateWithImportOnEmitsImportProposal is the converse: with the flag
// on and a clean finding, Generate's finding loop (generate.go) produces the
// import proposal alongside whatever the verdicts already produced.
func TestGenerateWithImportOnEmitsImportProposal(t *testing.T) {
	checkout := copyCheckoutFixture(t)
	env := &Envelope{Schema: EnvelopeSchema, ProjectID: "sample", PlanExitCode: 2,
		Sweep: &Sweep{Findings: []Finding{cleanImportFinding()}}}

	doc, err := GenerateWithImport(env, checkout, "environments/prod", true)
	if err != nil {
		t.Fatalf("GenerateWithImport(true): %v", err)
	}
	if len(doc.Proposals) != 1 {
		t.Fatalf("proposals = %d, want 1: %+v", len(doc.Proposals), doc.Proposals)
	}
	if doc.Proposals[0].Flavor != "import" {
		t.Errorf("flavor = %q, want import", doc.Proposals[0].Flavor)
	}
	if len(doc.Ungenerable) != 0 {
		t.Errorf("ungenerable = %+v, want none", doc.Ungenerable)
	}
}

// TestGenerateWithImportNilSweepIsSafe is a belt-and-braces nil-safety
// check: enableImport=true with env.Sweep == nil (an ordinary pre-sweep
// envelope) must not panic and must produce zero import proposals.
func TestGenerateWithImportNilSweepIsSafe(t *testing.T) {
	checkout := copyCheckoutFixture(t)
	env := &Envelope{Schema: EnvelopeSchema, ProjectID: "sample", PlanExitCode: 0}
	doc, err := GenerateWithImport(env, checkout, "environments/prod", true)
	if err != nil {
		t.Fatalf("GenerateWithImport: %v", err)
	}
	if len(doc.Proposals) != 0 || len(doc.Ungenerable) != 0 {
		t.Fatalf("doc = %+v, want empty for a nil-Sweep envelope even with the flag on", doc)
	}
}

// TestImportSecurityFamilyRefused is spec §8 invariant 1's "three
// independent screens" proof for findings, mirroring
// TestFourthScreenForgedEnvelope's proof for verdicts: a finding whose OWN
// advisory securityFamily field FALSELY claims false, but whose tfType DOES
// match the CHECKOUT's own creation_security_types (aws_iam_role, per the
// fixture checkout's watchlist), must still be refused by
// GenerateWithImport's checkout-based screen — never emitted as an import
// proposal.
func TestImportSecurityFamilyRefused(t *testing.T) {
	checkout := copyCheckoutFixture(t)
	f := Finding{
		Class:          findingClass,
		TfType:         "aws_iam_role",
		LiveID:         "oob-forged-role",
		SecurityFamily: false, // forged: the checkout's own list still names aws_iam_role
		ImportPayload: &FindingImportPayload{
			Address:     "aws_iam_role.oob_forged01",
			TargetFile:  "oob-adopted.tf",
			ImportBlock: "import {\n  to = aws_iam_role.oob_forged01\n  id = \"oob-forged-role\"\n}\n",
			SkeletonHcl: "resource \"aws_iam_role\" \"oob_forged01\" {\n  name = \"oob-forged-role\"\n}\n",
		},
	}

	// Sanity: the field-level partitioner alone (no checkout) is fooled by
	// the forgery — this is exactly why the checkout screen exists.
	if bucket, reason := ClassifyFinding(f); bucket != BucketImport {
		t.Fatalf("fixture precondition failed: field-level bucket = %q (reason=%q), want %q (the forgery should fool the field-only partitioner)", bucket, reason, BucketImport)
	}

	env := &Envelope{Schema: EnvelopeSchema, ProjectID: "sample", PlanExitCode: 2, Sweep: &Sweep{Findings: []Finding{f}}}
	doc, err := GenerateWithImport(env, checkout, "environments/prod", true)
	if err != nil {
		t.Fatalf("GenerateWithImport: %v", err)
	}
	if len(doc.Proposals) != 0 {
		t.Fatalf("forged finding produced %d proposals, want 0: %+v", len(doc.Proposals), doc.Proposals)
	}
	if len(doc.Ungenerable) != 1 {
		t.Fatalf("ungenerable = %d, want 1: %+v", len(doc.Ungenerable), doc.Ungenerable)
	}
	reason := doc.Ungenerable[0].Reason
	if !containsAll(reason, "aws_iam_role", "creation_security_types") {
		t.Fatalf("reason = %q, want it to name the type and the checkout screen", reason)
	}
}

// TestImportUnreadableWatchlistRefusesWholeImportBucket mirrors
// TestFourthScreenUnreadableWatchlistRefusesWholeAdoptBucket for the import
// bucket: a checkout with no watchlist file at all refuses every import
// finding, fail-closed.
func TestImportUnreadableWatchlistRefusesWholeImportBucket(t *testing.T) {
	checkout := copyCheckoutFixtureWithoutWatchlist(t)
	env := &Envelope{Schema: EnvelopeSchema, ProjectID: "sample", PlanExitCode: 2,
		Sweep: &Sweep{Findings: []Finding{cleanImportFinding()}}}

	doc, err := GenerateWithImport(env, checkout, "environments/prod", true)
	if err != nil {
		t.Fatalf("GenerateWithImport: %v", err)
	}
	if len(doc.Proposals) != 0 {
		t.Fatalf("proposals = %+v, want none (watchlist unreadable)", doc.Proposals)
	}
	if len(doc.Ungenerable) != 1 || !containsAll(doc.Ungenerable[0].Reason, "security watchlist unreadable") {
		t.Fatalf("ungenerable = %+v, want one row naming the unreadable watchlist", doc.Ungenerable)
	}
}

// TestImportCreationSecurityKeyAbsentRefusesWholeImportBucket pins spec
// §5.3's other fail-closed shape: the watchlist file itself is readable, but
// it carries no creation_security_types key AT ALL (as opposed to
// present-and-empty) — every import finding is refused, self-healing only
// once the checkout's main carries the key.
func TestImportCreationSecurityKeyAbsentRefusesWholeImportBucket(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "environments", "prod")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	wlDir := filepath.Join(filepath.Dir(filepath.Dir(dir)), "scripts", "drift")
	if err := os.MkdirAll(wlDir, 0o755); err != nil {
		t.Fatal(err)
	}
	// A well-formed watchlist file, but with no creation_security_types key.
	wl := `{"version":1,"doctrine":"fixture, no creation_security_types key","resource_types":{},"attribute_patterns":[]}`
	if err := os.WriteFile(filepath.Join(wlDir, "security-watchlist.json"), []byte(wl), 0o644); err != nil {
		t.Fatal(err)
	}
	repo := filepath.Dir(filepath.Dir(dir))

	env := &Envelope{Schema: EnvelopeSchema, ProjectID: "sample", PlanExitCode: 2,
		Sweep: &Sweep{Findings: []Finding{cleanImportFinding()}}}
	doc, err := GenerateWithImport(env, repo, "environments/prod", true)
	if err != nil {
		t.Fatalf("GenerateWithImport: %v", err)
	}
	if len(doc.Proposals) != 0 {
		t.Fatalf("proposals = %+v, want none (creation_security_types key absent)", doc.Proposals)
	}
	if len(doc.Ungenerable) != 1 || !containsAll(doc.Ungenerable[0].Reason, "creation_security_types", "fail-closed") {
		t.Fatalf("ungenerable = %+v, want one row naming the absent key, fail-closed", doc.Ungenerable)
	}
}
