package driftpropose

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

// eligibilityFixture mirrors testdata/driftpropose/eligibility-cases.json — the
// cross-language fixture spec §6.2 names: "verdict → expected bucket + reason",
// consumed identically by the Go tests here and (per WI-6/WI-7) the api/app vitest
// suites. A case added there must fail every implementation that disagrees.
type eligibilityFixture struct {
	Version int               `json:"version"`
	Cases   []eligibilityCase `json:"cases"`
}

type eligibilityCase struct {
	Name    string  `json:"name"`
	Verdict Verdict `json:"verdict"`
	Bucket  string  `json:"bucket"`
	Reason  string  `json:"reason"`
}

func loadEligibilityFixture(t *testing.T) eligibilityFixture {
	t.Helper()
	b, err := os.ReadFile("../../testdata/driftpropose/eligibility-cases.json")
	if err != nil {
		t.Fatalf("read eligibility-cases.json: %v", err)
	}
	var f eligibilityFixture
	if err := json.Unmarshal(b, &f); err != nil {
		t.Fatalf("parse eligibility-cases.json: %v", err)
	}
	if len(f.Cases) == 0 {
		t.Fatalf("eligibility-cases.json carries no cases")
	}
	return f
}

// TestPartitionMatchesFixture drives EVERY case in the shared cross-language
// eligibility fixture through ClassifyByFields and asserts both the bucket and the
// reason match exactly — this is the "one table, three implementations, one
// fixture" doctrine's Go half (spec §6.2). A case added to the fixture that this
// implementation disagrees with must fail here.
func TestPartitionMatchesFixture(t *testing.T) {
	fixture := loadEligibilityFixture(t)
	for _, c := range fixture.Cases {
		c := c
		t.Run(c.Name, func(t *testing.T) {
			bucket, reason := ClassifyByFields(c.Verdict)
			if string(bucket) != c.Bucket {
				t.Fatalf("bucket = %q, want %q (reason=%q)", bucket, c.Bucket, reason)
			}
			if reason != c.Reason {
				t.Fatalf("reason = %q, want %q", reason, c.Reason)
			}
		})
	}
}

// TestSecurityNeverReachesAdopt pins spec §8 enforcement point 1 verbatim: "a
// watchlisted verdict relabeled benign_inplace with securityHits present still
// cannot produce an adopt proposal." isSecurityPosture (§2.3) is a fail-closed
// UNION over class and securityHits — it only widens, never narrows — so a verdict
// whose class was (correctly or maliciously) relabeled away from security_posture
// is still routed to revert-only the instant it carries a securityHits row, never
// to the ADOPT bucket. This is the partitioner half of the three independently
// tested enforcement points; the api re-check (§8 point 2) and the bundle gate
// (§8 point 3) are WI-6/WI-5's job, but this test is what makes point 1 fail
// closed even if nothing else does.
func TestSecurityNeverReachesAdopt(t *testing.T) {
	v := Verdict{
		Address:       "aws_iam_role.app1",
		Type:          "aws_iam_role",
		Class:         "benign_inplace", // mislabeled — this is the attack this test pins
		RiskTier:      "low",
		DriftEvidence: true,
		Actions:       []string{"update"},
		ForceNewAttrs: nil,
		SecurityHits:  []SecurityHit{{Path: "assume_role_policy", Why: "role trust policy"}},
		ChangedAttrs: []ChangedAttr{
			{Path: "assume_role_policy", Sensitive: false, LiveJSON: json.RawMessage(`"console-authored"`), CodeJSON: json.RawMessage(`"repo-authored"`)},
		},
	}
	bucket, reason := ClassifyByFields(v)
	if bucket == BucketAdopt {
		t.Fatalf("a securityHits-bearing verdict reached the ADOPT bucket (reason=%q) — enforcement point 1 is broken", reason)
	}
	if bucket != BucketRevert {
		t.Fatalf("bucket = %q, want %q (a securityHits row with otherwise-clean fields is still mechanically revertible)", bucket, BucketRevert)
	}
	if !IsSecurityPosture(v) {
		t.Fatalf("IsSecurityPosture(v) = false for a verdict carrying a securityHits row")
	}
}

// TestUnknownClassUngenerable pins §6.2: "Unknown class ⇒ ungenerable, always" —
// even when every OTHER field on the verdict looks adopt-shaped (low risk, a pure
// update, drift evidence present, a clean non-sensitive changed attribute). The
// closed eleven-class D1-D11 enum (0027 §2.4.3) is never guessed past.
func TestUnknownClassUngenerable(t *testing.T) {
	v := Verdict{
		Address:       "aws_instance.futurebox01",
		Class:         "some_future_class_never_seen_before",
		RiskTier:      "low",
		DriftEvidence: true,
		Actions:       []string{"update"},
		ChangedAttrs: []ChangedAttr{
			{Path: "tags.Owner", Sensitive: false, LiveJSON: json.RawMessage(`"a"`), CodeJSON: json.RawMessage(`"b"`)},
		},
	}
	bucket, reason := ClassifyByFields(v)
	if bucket != BucketUngenerable {
		t.Fatalf("bucket = %q, want %q for an unrecognized class", bucket, BucketUngenerable)
	}
	if !containsAll(reason, "unknown class", "fail-closed") {
		t.Fatalf("reason = %q, want it to explain the unknown-class fail-closed refusal", reason)
	}
}

// TestSensitiveUngenerable pins §6.2's ADOPT-eligible row: "every changed row has
// sensitive:false AND liveJson present." A sensitive changed attribute (no machine
// value ever leaves the runner, §2.2) makes the whole verdict ungenerable — never
// silently skipped-and-adopted-anyway on its other clean rows, and never adopted
// with a guessed/placeholder value.
func TestSensitiveUngenerable(t *testing.T) {
	v := Verdict{
		Address:       "aws_db_instance.db3",
		Class:         "benign_inplace",
		RiskTier:      "low",
		DriftEvidence: true,
		Actions:       []string{"update"},
		ChangedAttrs: []ChangedAttr{
			{Path: "master_password", Sensitive: true}, // no liveJson/codeJson at all
		},
	}
	bucket, reason := ClassifyByFields(v)
	if bucket != BucketUngenerable {
		t.Fatalf("bucket = %q, want %q for a sensitive changed attribute", bucket, BucketUngenerable)
	}
	if !containsAll(reason, "master_password", "sensitive") {
		t.Fatalf("reason = %q, want it to name the sensitive attribute", reason)
	}
}

func containsAll(s string, subs ...string) bool {
	for _, sub := range subs {
		if !strings.Contains(s, sub) {
			return false
		}
	}
	return true
}
