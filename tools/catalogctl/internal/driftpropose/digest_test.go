package driftpropose

import "testing"

// TestDigestStableAcrossSnapshots pins spec §2.4: the proposalDigest formula
// deliberately EXCLUDES capturedAt/runId/commit/diff text, "so the same drift
// observed by the next snapshot yields the same digest, so regeneration is
// idempotent and duplicate proposals cannot exist." This drives the FULL Generate()
// pipeline (not just ProposalDigest in isolation) against two envelopes whose
// envelope-level provenance (runId, commit, capturedAt) differs but whose
// report.verdicts content is identical, and asserts every resulting proposal
// digest is byte-identical across both runs.
func TestDigestStableAcrossSnapshots(t *testing.T) {
	checkout := copyCheckoutFixture(t)

	base := loadCombinedEnvelope(t)

	snapshot1 := *base
	snapshot1.RunID = "16234500001"
	snapshot1.Commit = "1111111111111111111111111111111111111111"
	snapshot1.CapturedAt = "2026-07-20T03:17:04Z"

	snapshot2 := *base
	snapshot2.RunID = "16234599999" // a completely different CI run id
	snapshot2.Commit = "2222222222222222222222222222222222222222"
	snapshot2.CapturedAt = "2026-07-20T09:17:04Z" // the NEXT scheduled snapshot, 6h later

	doc1, err := Generate(&snapshot1, checkout, "environments/prod")
	if err != nil {
		t.Fatalf("Generate(snapshot1): %v", err)
	}
	doc2, err := Generate(&snapshot2, checkout, "environments/prod")
	if err != nil {
		t.Fatalf("Generate(snapshot2): %v", err)
	}

	if len(doc1.Proposals) == 0 {
		t.Fatal("snapshot1 produced zero proposals — fixture regressed, nothing to compare")
	}
	if len(doc1.Proposals) != len(doc2.Proposals) {
		t.Fatalf("proposal count differs: %d vs %d", len(doc1.Proposals), len(doc2.Proposals))
	}
	for i := range doc1.Proposals {
		p1, p2 := doc1.Proposals[i], doc2.Proposals[i]
		if p1.Addresses[0] != p2.Addresses[0] {
			t.Fatalf("proposal[%d] address differs: %s vs %s (sort order should be identical)", i, p1.Addresses[0], p2.Addresses[0])
		}
		if p1.Digest != p2.Digest {
			t.Errorf("proposal for %s: digest differs across snapshots with only runId/commit/capturedAt changed: %s vs %s", p1.Addresses[0], p1.Digest, p2.Digest)
		}
	}
}

// TestDigestChangesWithContent is TestDigestStableAcrossSnapshots' converse: when
// the ACTUAL drift changes (a different liveJson value at the same path), the
// digest MUST change too — otherwise a genuinely new drift value could collide with
// a stale, already-submitted proposal's digest and never surface as a fresh one.
func TestDigestChangesWithContent(t *testing.T) {
	attrsA := []Attr{{Address: "aws_instance.x", Path: "tags.Owner", LiveJSON: "bi-team", CodeJSON: "platform"}}
	attrsB := []Attr{{Address: "aws_instance.x", Path: "tags.Owner", LiveJSON: "someone-else", CodeJSON: "platform"}}
	d1 := ProposalDigest("adopt", []string{"aws_instance.x"}, attrsA)
	d2 := ProposalDigest("adopt", []string{"aws_instance.x"}, attrsB)
	if d1 == d2 {
		t.Fatalf("digest did not change when liveJson changed: both %s", d1)
	}
}

// TestDigestOrderIndependent proves addresses/attrs order never affects the digest
// (spec §2.4: "addresses (sorted)", "attrs (sorted rows)") — generation order must
// never matter to the storage key.
func TestDigestOrderIndependent(t *testing.T) {
	attrs1 := []Attr{
		{Address: "aws_instance.x", Path: "tags.CostCenter", LiveJSON: "cc-42", CodeJSON: "cc-01"},
		{Address: "aws_instance.x", Path: "tags.Owner", LiveJSON: "bi-team", CodeJSON: "platform"},
	}
	attrs2 := []Attr{
		{Address: "aws_instance.x", Path: "tags.Owner", LiveJSON: "bi-team", CodeJSON: "platform"},
		{Address: "aws_instance.x", Path: "tags.CostCenter", LiveJSON: "cc-42", CodeJSON: "cc-01"},
	}
	d1 := ProposalDigest("adopt", []string{"aws_instance.x"}, attrs1)
	d2 := ProposalDigest("adopt", []string{"aws_instance.x"}, attrs2)
	if d1 != d2 {
		t.Fatalf("digest depends on attrs order: %s vs %s", d1, d2)
	}
	// The caller's slice must not be mutated in place (ProposalDigest sorts copies).
	if attrs1[0].Path != "tags.CostCenter" {
		t.Fatalf("ProposalDigest mutated the caller's attrs slice: %+v", attrs1)
	}
}

// TestImportDigestStable pins spec 2026-07-20-ccp-oob-provisioning-import.md
// §5.4's proposalDigest(import) formula: same inputs (arn, tfType, liveId,
// importBlock, skeletonHcl) always yield the same digest — regardless of
// address slice order (sorted, mirroring ProposalDigest's own order
// independence) — and, run end-to-end through GenerateWithImport twice
// against fresh checkout copies of the SAME finding, the digest is stable
// (no capturedAt/runId/commit ever enters the input, exactly like
// TestDigestStableAcrossSnapshots proves for adopt/revert).
func TestImportDigestStable(t *testing.T) {
	arn := "arn:aws:iam::123456789012:policy/x"

	d1 := ImportProposalDigest([]string{"aws_iam_policy.x"}, &arn, "aws_iam_policy", arn, cleanImportBlock, cleanSkeleton)
	d2 := ImportProposalDigest([]string{"aws_iam_policy.x"}, &arn, "aws_iam_policy", arn, cleanImportBlock, cleanSkeleton)
	if d1 != d2 {
		t.Fatalf("ImportProposalDigest is not deterministic on identical inputs: %s vs %s", d1, d2)
	}

	// Address-slice order never matters (sorted on a copy).
	addrsA := []string{"aws_iam_policy.x", "aws_iam_policy.y"}
	addrsB := []string{"aws_iam_policy.y", "aws_iam_policy.x"}
	dA := ImportProposalDigest(addrsA, &arn, "aws_iam_policy", arn, cleanImportBlock, cleanSkeleton)
	dB := ImportProposalDigest(addrsB, &arn, "aws_iam_policy", arn, cleanImportBlock, cleanSkeleton)
	if dA != dB {
		t.Fatalf("ImportProposalDigest depends on addresses order: %s vs %s", dA, dB)
	}
	if addrsA[0] != "aws_iam_policy.x" {
		t.Fatalf("ImportProposalDigest mutated the caller's addresses slice: %+v", addrsA)
	}

	// Content changes must change the digest (skeleton, arn, tfType, liveId
	// each independently) — the §6.3 reconcile / supersede sweep depends on this.
	dSkeletonChanged := ImportProposalDigest([]string{"aws_iam_policy.x"}, &arn, "aws_iam_policy", arn, cleanImportBlock, cleanSkeleton+"\n# a byte moved live\n")
	if d1 == dSkeletonChanged {
		t.Fatal("digest did not change when skeletonHcl changed")
	}
	otherArn := "arn:aws:iam::123456789012:policy/y"
	dArnChanged := ImportProposalDigest([]string{"aws_iam_policy.x"}, &otherArn, "aws_iam_policy", arn, cleanImportBlock, cleanSkeleton)
	if d1 == dArnChanged {
		t.Fatal("digest did not change when arn changed")
	}
	dTypeChanged := ImportProposalDigest([]string{"aws_iam_policy.x"}, &arn, "aws_instance", arn, cleanImportBlock, cleanSkeleton)
	if d1 == dTypeChanged {
		t.Fatal("digest did not change when tfType changed")
	}
	dLiveIDChanged := ImportProposalDigest([]string{"aws_iam_policy.x"}, &arn, "aws_iam_policy", "a-different-live-id", cleanImportBlock, cleanSkeleton)
	if d1 == dLiveIDChanged {
		t.Fatal("digest did not change when liveId changed")
	}

	// A nil arn must never collide with a non-nil one (belt-and-braces:
	// confirms Go's json.Marshal renders *string(nil) as JSON null, distinct
	// from any string value).
	dNilArn := ImportProposalDigest([]string{"aws_iam_policy.x"}, nil, "aws_iam_policy", arn, cleanImportBlock, cleanSkeleton)
	if d1 == dNilArn {
		t.Fatal("digest did not change when arn went from set to nil")
	}

	// End-to-end: GenerateWithImport on two FRESH checkout copies of the same
	// finding produces the same digest — no wall-clock, no per-run entropy.
	checkoutA := copyCheckoutFixture(t)
	checkoutB := copyCheckoutFixture(t)
	f := cleanImportFinding()
	envA := &Envelope{Schema: EnvelopeSchema, ProjectID: "sample", PlanExitCode: 2, Sweep: &Sweep{Findings: []Finding{f}}}
	envB := &Envelope{Schema: EnvelopeSchema, ProjectID: "sample", PlanExitCode: 2, Sweep: &Sweep{Findings: []Finding{f}}}
	docA, err := GenerateWithImport(envA, checkoutA, "environments/prod", true)
	if err != nil {
		t.Fatalf("GenerateWithImport (A): %v", err)
	}
	docB, err := GenerateWithImport(envB, checkoutB, "environments/prod", true)
	if err != nil {
		t.Fatalf("GenerateWithImport (B): %v", err)
	}
	if len(docA.Proposals) != 1 || len(docB.Proposals) != 1 {
		t.Fatalf("expected exactly 1 import proposal each: A=%d B=%d", len(docA.Proposals), len(docB.Proposals))
	}
	if docA.Proposals[0].Digest != docB.Proposals[0].Digest {
		t.Fatalf("end-to-end import digest differs across two fresh checkout copies of the same finding: %s vs %s", docA.Proposals[0].Digest, docB.Proposals[0].Digest)
	}
}
