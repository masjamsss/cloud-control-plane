package driftpropose

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestRevertEmitsNoEdit pins spec §6.4: "REVERT — no edit." A REVERT-bucket verdict
// yields a proposal whose Diff is nil and whose operation is system-drift-revert —
// the mechanical meaning is "an apply of current HEAD, scoped to the drifted
// addresses" (enforced later by plan-check R8, WI-5), never a catalogctl-authored
// text change. This also proves revert never requires a machine value at all: the
// fixture's changed row carries liveJson/codeJson, but a sensitive row with NEITHER
// would generate identically (see TestRevertPinsRowsWithoutMachineValues below).
func TestRevertEmitsNoEdit(t *testing.T) {
	checkout := copyCheckoutFixture(t)
	env, err := LoadEnvelope("../../testdata/driftpropose/envelopes/watchlisted-sg.json")
	if err != nil {
		t.Fatalf("load envelope fixture: %v", err)
	}
	if len(env.Report.Verdicts) != 1 {
		t.Fatalf("fixture carries %d verdicts, want 1", len(env.Report.Verdicts))
	}
	v := env.Report.Verdicts[0]

	bucket, _ := ClassifyByFields(v)
	if bucket != BucketRevert {
		t.Fatalf("fixture verdict classified %q, want %q", bucket, BucketRevert)
	}

	p, ungenReason, err := GenerateRevert(v, filepath.Join(checkout, "environments/prod"))
	if err != nil {
		t.Fatalf("GenerateRevert: %v", err)
	}
	if ungenReason != "" {
		t.Fatalf("unexpected ungenerable reason: %s", ungenReason)
	}
	if p == nil {
		t.Fatal("GenerateRevert returned a nil proposal with no reason and no error")
	}

	if p.Diff != nil {
		t.Fatalf("revert proposal carries a non-nil diff: %q", *p.Diff)
	}
	if p.Flavor != "revert" {
		t.Errorf("flavor = %q, want revert", p.Flavor)
	}
	if len(p.Addresses) != 1 || p.Addresses[0] != "aws_security_group.sg1" {
		t.Errorf("addresses = %v, want [aws_security_group.sg1]", p.Addresses)
	}
	if len(p.Attrs) != 1 || p.Attrs[0].Path != "ingress[0].cidr_blocks" {
		t.Errorf("attrs = %+v, want the pinned ingress[0].cidr_blocks row", p.Attrs)
	}
	if len(p.RequestSkeleton.Items) != 1 {
		t.Fatalf("requestSkeleton.items has %d entries, want 1", len(p.RequestSkeleton.Items))
	}
	item := p.RequestSkeleton.Items[0]
	if item.OperationID != "system-drift-revert" {
		t.Errorf("operationId = %q, want system-drift-revert", item.OperationID)
	}
	if item.TargetAddress != "aws_security_group.sg1" {
		t.Errorf("targetAddress = %q, want aws_security_group.sg1", item.TargetAddress)
	}

	// Belt-and-braces: the checkout's actual file bytes must be untouched — a
	// revert proposal, unlike adopt, never even parses toward a write.
	before, err := os.ReadFile(filepath.Join(checkout, "environments/prod/main.tf"))
	if err != nil {
		t.Fatal(err)
	}
	golden, err := os.ReadFile("../../testdata/driftpropose/checkout/environments/prod/main.tf")
	if err != nil {
		t.Fatal(err)
	}
	if string(before) != string(golden) {
		t.Fatal("GenerateRevert mutated the checkout tree on disk — revert must never edit")
	}
}

// TestRevertPinsRowsWithoutMachineValues proves a revert proposal never requires a
// machine value: a sensitive changed row (no liveJson/codeJson at all, §2.2) still
// produces a pinned attrs row with null liveJson/codeJson — a revert only needs to
// know WHICH paths are in scope for plan-check R8, never the secret value itself.
func TestRevertPinsRowsWithoutMachineValues(t *testing.T) {
	checkout := copyCheckoutFixture(t)
	v := Verdict{
		Address:       "aws_db_instance.db1",
		Class:         "security_posture",
		RiskTier:      "high",
		DriftEvidence: true,
		Actions:       []string{"update"},
		SecurityHits:  []SecurityHit{{Path: "master_user_password", Why: "credential posture"}},
		ChangedAttrs: []ChangedAttr{
			{Path: "master_user_password", Sensitive: true}, // no liveJson/codeJson
		},
	}
	bucket, _ := ClassifyByFields(v)
	if bucket != BucketRevert {
		t.Fatalf("classified %q, want %q", bucket, BucketRevert)
	}
	p, reason, err := GenerateRevert(v, filepath.Join(checkout, "environments/prod"))
	if err != nil || reason != "" {
		t.Fatalf("GenerateRevert(err=%v, reason=%q)", err, reason)
	}
	if len(p.Attrs) != 1 {
		t.Fatalf("attrs = %+v, want exactly one row", p.Attrs)
	}
	a := p.Attrs[0]
	if a.LiveJSON != nil || a.CodeJSON != nil {
		t.Fatalf("attrs[0] = %+v, want liveJson/codeJson both nil for a sensitive row", a)
	}
	b, err := json.Marshal(a)
	if err != nil {
		t.Fatal(err)
	}
	// Explicit JSON null, never an omitted key (spec §2.4: "liveJson|null").
	got := string(b)
	if !strings.Contains(got, `"liveJson":null`) || !strings.Contains(got, `"codeJson":null`) {
		t.Fatalf("marshaled attr row = %s, want explicit liveJson/codeJson null", got)
	}
}

// TestRevertSensitivePinsAreValueless pins spec F5: even a CRAFTED/hostile
// envelope that carries liveJson/codeJson on a sensitive row (violating
// classify.py's own §2.2 contract) is pinned value-less — ca.Sensitive wins
// UNCONDITIONALLY, never merely "when the producer happened to omit them" (the
// pre-F5 code's actual behavior, which trusted the row). No secret bytes may
// reach the proposal body, the digest input, or the request evidence.
func TestRevertSensitivePinsAreValueless(t *testing.T) {
	checkout := copyCheckoutFixture(t)
	env, err := LoadEnvelope("../../testdata/driftpropose/envelopes/sensitive-revert-values.json")
	if err != nil {
		t.Fatalf("load envelope fixture: %v", err)
	}
	if len(env.Report.Verdicts) != 1 {
		t.Fatalf("fixture carries %d verdicts, want 1", len(env.Report.Verdicts))
	}
	v := env.Report.Verdicts[0]

	bucket, _ := ClassifyByFields(v)
	if bucket != BucketRevert {
		t.Fatalf("fixture verdict classified %q, want %q", bucket, BucketRevert)
	}

	p, reason, err := GenerateRevert(v, filepath.Join(checkout, "environments/prod"))
	if err != nil || reason != "" {
		t.Fatalf("GenerateRevert(err=%v, reason=%q)", err, reason)
	}
	if len(p.Attrs) != 1 {
		t.Fatalf("attrs = %+v, want exactly one row", p.Attrs)
	}
	a := p.Attrs[0]
	if a.LiveJSON != nil || a.CodeJSON != nil {
		t.Fatalf("attrs[0] = %+v — a crafted sensitive row's values leaked into the pinned proposal", a)
	}
	b, err := json.Marshal(p)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(b), "hostile-leaked-live-secret") || strings.Contains(string(b), "hostile-leaked-code-secret") {
		t.Fatalf("proposal JSON contains the sensitive secret bytes: %s", b)
	}
}
