package driftpropose

import (
	"encoding/json"
	"os"
	"testing"
)

// TestGenerateProposalsGolden drives the whole pipeline (LoadEnvelope semantics via
// the six spec-named envelope fixtures — benign tags, watchlisted SG, forceNew,
// sensitive-masked, unknown-class, oob-deletion — combined into one envelope,
// against the mini checkout) through Generate and compares the resulting
// proposals.json byte-for-byte against the committed golden (the exact bytes
// command.go writes: json.MarshalIndent + a trailing newline). This is the
// integration counterpart to TestPartitionMatchesFixture (pure partition truth
// table) and TestAdoptEditGolden (one proposal's diff in isolation): it proves the
// whole documented §6.1 proposals.json shape — schema, baseCommit, sorted
// proposals[], sorted ungenerable[] — end to end.
func TestGenerateProposalsGolden(t *testing.T) {
	checkout := copyCheckoutFixture(t)
	env := loadCombinedEnvelope(t)

	doc, err := Generate(env, checkout, "environments/prod")
	if err != nil {
		t.Fatalf("Generate: %v", err)
	}

	if doc.Schema != ProposalsSchema {
		t.Errorf("schema = %q, want %q", doc.Schema, ProposalsSchema)
	}
	if doc.BaseCommit != "" {
		t.Errorf("baseCommit = %q, want empty (the temp-dir checkout copy carries no .git)", doc.BaseCommit)
	}
	if len(doc.Proposals) != 2 {
		t.Fatalf("proposals = %d, want 2 (one adopt, one revert)", len(doc.Proposals))
	}
	if len(doc.Ungenerable) != 4 {
		t.Fatalf("ungenerable = %d, want 4 (forceNew, sensitive, unknown-class, oob-deletion)", len(doc.Ungenerable))
	}
	// Deterministic ordering: proposals and ungenerable rows are both sorted by
	// address, independent of the source envelope's own verdict order.
	for i := 1; i < len(doc.Proposals); i++ {
		if doc.Proposals[i-1].Addresses[0] >= doc.Proposals[i].Addresses[0] {
			t.Errorf("proposals not sorted by address: %s >= %s", doc.Proposals[i-1].Addresses[0], doc.Proposals[i].Addresses[0])
		}
	}
	for i := 1; i < len(doc.Ungenerable); i++ {
		if doc.Ungenerable[i-1].Address >= doc.Ungenerable[i].Address {
			t.Errorf("ungenerable not sorted by address: %s >= %s", doc.Ungenerable[i-1].Address, doc.Ungenerable[i].Address)
		}
	}

	// The exact bytes command.go's `run` writes to --out.
	got, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	got = append(got, '\n')

	want, err := os.ReadFile("../../testdata/driftpropose/golden/proposals.json")
	if err != nil {
		t.Fatalf("read golden: %v", err)
	}
	if string(got) != string(want) {
		t.Fatalf("proposals.json mismatch.\n--- got ---\n%s\n--- want ---\n%s", got, want)
	}
}

// TestGenerateProposalsRestoreGolden is TestGenerateProposalsGolden's restore-
// armed sibling (plan 2026-07-20-drift-restore-tranche.md §5): the SAME
// combined envelope + checkout, but through GenerateOpts with EnableRestore
// true — the flow-log row (aws_flow_log.vpc1, oob_deletion, restore-eligible)
// becomes a restore PROPOSAL instead of an ungenerable arming-reason row, so
// proposals goes 2 -> 3 and ungenerable goes 4 -> 3. Proves the restore
// proposal shape byte-stable end to end, against its own golden fixture
// (deliberately NOT proposals.json — the flag-off golden must stay pinned to
// today's arming-reason-only behavior, §5's "exactly ONE row changes" rule).
func TestGenerateProposalsRestoreGolden(t *testing.T) {
	checkout := copyCheckoutFixture(t)
	env := loadCombinedEnvelope(t)

	doc, err := GenerateOpts(env, checkout, "environments/prod", GenOptions{EnableRestore: true})
	if err != nil {
		t.Fatalf("GenerateOpts: %v", err)
	}

	if len(doc.Proposals) != 3 {
		t.Fatalf("proposals = %d, want 3 (adopt, revert, restore)", len(doc.Proposals))
	}
	if len(doc.Ungenerable) != 3 {
		t.Fatalf("ungenerable = %d, want 3 (forceNew, sensitive, unknown-class)", len(doc.Ungenerable))
	}
	var sawRestore bool
	for _, p := range doc.Proposals {
		if p.Flavor == "restore" {
			sawRestore = true
			if len(p.Addresses) != 1 || p.Addresses[0] != "aws_flow_log.vpc1" {
				t.Errorf("restore proposal addresses = %v, want [aws_flow_log.vpc1]", p.Addresses)
			}
		}
	}
	if !sawRestore {
		t.Fatalf("no restore proposal in %+v", doc.Proposals)
	}
	for _, u := range doc.Ungenerable {
		if u.Address == "aws_flow_log.vpc1" {
			t.Fatalf("aws_flow_log.vpc1 is still ungenerable with --enable-restore on: %+v", u)
		}
	}

	got, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	got = append(got, '\n')

	want, err := os.ReadFile("../../testdata/driftpropose/golden/proposals-restore.json")
	if err != nil {
		t.Fatalf("read golden: %v", err)
	}
	if string(got) != string(want) {
		t.Fatalf("proposals-restore.json mismatch.\n--- got ---\n%s\n--- want ---\n%s", got, want)
	}
}

// TestGenerateIsIdempotent regenerates from the same envelope+checkout twice and
// asserts byte-identical output — the "possibly zero proposals, all-ungenerable is
// a valid outcome" contract (§6.1) plus the digest idempotency spine (§2.4) taken
// together: nothing about generation is order- or time-dependent.
func TestGenerateIsIdempotent(t *testing.T) {
	checkout := copyCheckoutFixture(t)
	env := loadCombinedEnvelope(t)

	doc1, err := Generate(env, checkout, "environments/prod")
	if err != nil {
		t.Fatalf("Generate (1st): %v", err)
	}
	doc2, err := Generate(env, checkout, "environments/prod")
	if err != nil {
		t.Fatalf("Generate (2nd): %v", err)
	}
	b1, _ := json.Marshal(doc1)
	b2, _ := json.Marshal(doc2)
	if string(b1) != string(b2) {
		t.Fatalf("Generate is not idempotent on identical inputs:\n%s\nvs\n%s", b1, b2)
	}
}

// TestGenerateCleanEnvelopeYieldsNoProposals covers §6.1's explicit "possibly zero
// proposals, all-ungenerable is a valid outcome" for the OTHER edge: an envelope
// with report.verdicts == [] entirely (planExitCode 0, "verified clean") is exit-0
// with an empty document, never an error.
func TestGenerateCleanEnvelopeYieldsNoProposals(t *testing.T) {
	checkout := copyCheckoutFixture(t)
	env := &Envelope{Schema: EnvelopeSchema, ProjectID: "sample", PlanExitCode: 0, Report: Report{}}
	doc, err := Generate(env, checkout, "environments/prod")
	if err != nil {
		t.Fatalf("Generate: %v", err)
	}
	if len(doc.Proposals) != 0 || len(doc.Ungenerable) != 0 {
		t.Fatalf("doc = %+v, want an empty document for a clean envelope", doc)
	}
}
