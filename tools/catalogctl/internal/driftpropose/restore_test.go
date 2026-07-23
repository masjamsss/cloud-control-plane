package driftpropose

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestRestoreEmitsNoEditNoAttrs pins plan
// 2026-07-20-drift-restore-tranche.md §2.2: a RESTORE-bucket verdict yields a
// proposal whose Diff is nil, whose Attrs is a non-nil EMPTY slice (marshals
// to "[]", never "null" nor a populated attrs row — a restore has no
// attribute edits to pin, unlike revert), and whose operation is
// system-drift-restore. This also proves restore never touches the checkout
// on disk — the mechanical meaning is "re-assert code already on main,"
// enforced later by plan-check R9, never by an edit here.
func TestRestoreEmitsNoEditNoAttrs(t *testing.T) {
	checkout := copyCheckoutFixture(t)
	env, err := LoadEnvelope("../../testdata/driftpropose/envelopes/oob-deletion.json")
	if err != nil {
		t.Fatalf("load envelope fixture: %v", err)
	}
	if len(env.Report.Verdicts) != 1 {
		t.Fatalf("fixture carries %d verdicts, want 1", len(env.Report.Verdicts))
	}
	v := env.Report.Verdicts[0]

	bucket, _ := ClassifyByFields(v)
	if bucket != BucketRestore {
		t.Fatalf("fixture verdict classified %q, want %q", bucket, BucketRestore)
	}

	p, ungenReason, err := GenerateRestore(v, filepath.Join(checkout, "environments/prod"))
	if err != nil {
		t.Fatalf("GenerateRestore: %v", err)
	}
	if ungenReason != "" {
		t.Fatalf("unexpected ungenerable reason: %s", ungenReason)
	}
	if p == nil {
		t.Fatal("GenerateRestore returned a nil proposal with no reason and no error")
	}

	if p.Diff != nil {
		t.Fatalf("restore proposal carries a non-nil diff: %q", *p.Diff)
	}
	if p.Flavor != "restore" {
		t.Errorf("flavor = %q, want restore", p.Flavor)
	}
	if len(p.Addresses) != 1 || p.Addresses[0] != "aws_flow_log.vpc1" {
		t.Errorf("addresses = %v, want [aws_flow_log.vpc1]", p.Addresses)
	}
	if p.Attrs == nil || len(p.Attrs) != 0 {
		t.Errorf("attrs = %v, want a non-nil empty slice (marshals to [])", p.Attrs)
	}
	if len(p.RequestSkeleton.Items) != 1 {
		t.Fatalf("requestSkeleton.items has %d entries, want 1", len(p.RequestSkeleton.Items))
	}
	item := p.RequestSkeleton.Items[0]
	if item.OperationID != "system-drift-restore" {
		t.Errorf("operationId = %q, want system-drift-restore", item.OperationID)
	}
	if item.TargetAddress != "aws_flow_log.vpc1" {
		t.Errorf("targetAddress = %q, want aws_flow_log.vpc1", item.TargetAddress)
	}
	if item.Params.ProposalDigest != p.Digest {
		t.Errorf("params.proposalDigest = %q, want it to equal the proposal digest %q", item.Params.ProposalDigest, p.Digest)
	}
	if len(item.Params.Attrs) != 0 {
		t.Errorf("params.attrs = %v, want empty/absent for restore", item.Params.Attrs)
	}
	if item.Params.ImportPayload != nil {
		t.Errorf("params.importPayload = %+v, want nil for restore", item.Params.ImportPayload)
	}

	// The exact bytes command.go's `run` writes to --out: "attrs": [] (never
	// "attrs": null), and no "importPayload" key at all in params (omitempty).
	b, err := json.Marshal(p)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if !strings.Contains(string(b), `"attrs":[]`) {
		t.Errorf("marshaled proposal does not carry a literal empty attrs array: %s", b)
	}
	if strings.Contains(string(b), `"importPayload"`) {
		t.Errorf("marshaled proposal carries an importPayload key, want none for restore: %s", b)
	}
	if !strings.Contains(string(b), `"diff":null`) {
		t.Errorf("marshaled proposal does not carry an explicit null diff: %s", b)
	}

	// Belt-and-braces: the checkout's actual file bytes must be untouched — a
	// restore proposal, like revert, never even parses toward a write.
	before, err := os.ReadFile(filepath.Join(checkout, "environments/prod/main.tf"))
	if err != nil {
		t.Fatal(err)
	}
	golden, err := os.ReadFile("../../testdata/driftpropose/checkout/environments/prod/main.tf")
	if err != nil {
		t.Fatal(err)
	}
	if string(before) != string(golden) {
		t.Fatal("GenerateRestore mutated the checkout tree on disk — restore must never edit")
	}
}

// TestRestoreDigestFormula pins §2.2's digest formula verbatim: the EXISTING
// ProposalDigest("restore", addresses, nil) — no new formula, attrs
// deliberately nil (not the empty-but-non-nil slice the OUTPUT Attrs field
// carries — see restore.go's doc comment on why these are two different
// things).
func TestRestoreDigestFormula(t *testing.T) {
	checkout := copyCheckoutFixture(t)
	v := Verdict{
		Address: "aws_flow_log.vpc1", Type: "aws_flow_log", Class: "oob_deletion", RiskTier: "high",
		DriftEvidence: true, Actions: []string{"create"},
	}
	bucket, _ := ClassifyByFields(v)
	if bucket != BucketRestore {
		t.Fatalf("classified %q, want %q", bucket, BucketRestore)
	}
	p, reason, err := GenerateRestore(v, filepath.Join(checkout, "environments/prod"))
	if err != nil || reason != "" {
		t.Fatalf("GenerateRestore(err=%v, reason=%q)", err, reason)
	}
	want := ProposalDigest("restore", []string{"aws_flow_log.vpc1"}, nil)
	if p.Digest != want {
		t.Errorf("digest = %s, want %s", p.Digest, want)
	}

	// Idempotent: the SAME deletion re-observed on a later snapshot yields
	// the SAME digest (spec §2.2: "supersede/reopen mechanics unchanged").
	p2, _, err := GenerateRestore(v, filepath.Join(checkout, "environments/prod"))
	if err != nil {
		t.Fatal(err)
	}
	if p2.Digest != p.Digest {
		t.Errorf("second GenerateRestore digest = %s, want %s (idempotent)", p2.Digest, p.Digest)
	}
}

// TestRestoreRefusesAddressNotInCheckout pins §2.2's ONE checkout-dependent
// refinement: the deleted resource's block must still be declared in the
// checkout (hclops.Locate) — absent means a code removal may already have
// accepted the deletion, so there is nothing left to re-assert. Deliberately
// NOT in the shared eligibility-cases.json fixture (checkout-independent by
// construction), the same doctrine GenerateRevert's own address-resolution
// refusal follows.
func TestRestoreRefusesAddressNotInCheckout(t *testing.T) {
	checkout := copyCheckoutFixture(t)
	v := Verdict{
		Address: "aws_flow_log.does_not_exist", Type: "aws_flow_log", Class: "oob_deletion", RiskTier: "high",
		DriftEvidence: true, Actions: []string{"create"},
	}
	bucket, _ := ClassifyByFields(v)
	if bucket != BucketRestore {
		t.Fatalf("classified %q, want %q", bucket, BucketRestore)
	}
	p, reason, err := GenerateRestore(v, filepath.Join(checkout, "environments/prod"))
	if err != nil {
		t.Fatalf("GenerateRestore returned an error, want a clean ungenerable reason: %v", err)
	}
	if p != nil {
		t.Fatalf("GenerateRestore proposed restoring an address absent from the checkout: %+v", p)
	}
	if !containsAll(reason, "aws_flow_log.does_not_exist", "not found in checkout", "nothing to re-assert") {
		t.Fatalf("reason = %q, want it to name the address and the doctrine", reason)
	}
}
