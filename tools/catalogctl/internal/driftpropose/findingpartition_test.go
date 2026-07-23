package driftpropose

import (
	"encoding/json"
	"os"
	"testing"
)

// unmanagedFixture mirrors testdata/driftpropose/unmanaged-cases.json — the
// cross-language fixture spec 2026-07-20-ccp-oob-provisioning-import.md
// §5.2 names: "finding → expected bucket + reason", consumed identically by
// the Go tests here and (per WI-S6/WI-S7) the api/app vitest suites. A
// separate file from eligibility-cases.json (spec: "a separate file from
// eligibility-cases.json so the verdict fixture's single-writer story is
// undisturbed").
type unmanagedFixture struct {
	Version int             `json:"version"`
	Cases   []unmanagedCase `json:"cases"`
}

type unmanagedCase struct {
	Name    string  `json:"name"`
	Finding Finding `json:"finding"`
	Bucket  string  `json:"bucket"`
	Reason  string  `json:"reason"`
}

func loadUnmanagedFixture(t *testing.T) unmanagedFixture {
	t.Helper()
	b, err := os.ReadFile("../../testdata/driftpropose/unmanaged-cases.json")
	if err != nil {
		t.Fatalf("read unmanaged-cases.json: %v", err)
	}
	var f unmanagedFixture
	if err := json.Unmarshal(b, &f); err != nil {
		t.Fatalf("parse unmanaged-cases.json: %v", err)
	}
	if len(f.Cases) == 0 {
		t.Fatalf("unmanaged-cases.json carries no cases")
	}
	return f
}

// TestFindingPartitionMatchesFixture drives EVERY case in the shared
// cross-language unmanaged-cases fixture through ClassifyFinding and asserts
// both the bucket and the reason match exactly — the "one table, three
// implementations, one fixture" doctrine's Go half for findings (spec §5.2).
// A case added to the fixture that this implementation disagrees with must
// fail here.
func TestFindingPartitionMatchesFixture(t *testing.T) {
	fixture := loadUnmanagedFixture(t)
	for _, c := range fixture.Cases {
		c := c
		t.Run(c.Name, func(t *testing.T) {
			bucket, reason := ClassifyFinding(c.Finding)
			if string(bucket) != c.Bucket {
				t.Fatalf("bucket = %q, want %q (reason=%q)", bucket, c.Bucket, reason)
			}
			if reason != c.Reason {
				t.Fatalf("reason = %q, want %q", reason, c.Reason)
			}
		})
	}
}

// TestClassifyFindingSecurityFamilyIndependentOfPayload pins that the F-2
// screen (finding.SecurityFamily) is evaluated BEFORE the F-4 payload
// completeness check, so a security-family finding is always routed to
// BucketCreationSecurity — never BucketPayloadWithheld — regardless of
// whether an importPayload happens to be present (a well-behaved publisher
// never attaches one to a security-family finding, spec §2.6 step 1's own
// "not creation-security" precondition, but this engine trusts no producer).
func TestClassifyFindingSecurityFamilyIndependentOfPayload(t *testing.T) {
	f := Finding{
		Class:          findingClass,
		TfType:         "aws_iam_role",
		LiveID:         "forged-with-payload",
		SecurityFamily: true,
		ImportPayload: &FindingImportPayload{
			Address: "aws_iam_role.oob_forged01", TargetFile: "oob-adopted.tf",
			ImportBlock: "import {\n  to = aws_iam_role.oob_forged01\n  id = \"forged-with-payload\"\n}\n",
			SkeletonHcl: "resource \"aws_iam_role\" \"oob_forged01\" {\n  name = \"forged\"\n}\n",
		},
	}
	bucket, reason := ClassifyFinding(f)
	if bucket != BucketCreationSecurity {
		t.Fatalf("bucket = %q, want %q even though importPayload was present (reason=%q)", bucket, BucketCreationSecurity, reason)
	}
}

// TestFindingKey pins findingKey's fallback contract: arn when derivable,
// else tfType/liveId.
func TestFindingKey(t *testing.T) {
	arn := "arn:aws:iam::123456789012:policy/x"
	withArn := Finding{Arn: &arn, TfType: "aws_iam_policy", LiveID: arn}
	if got := findingKey(withArn); got != arn {
		t.Errorf("findingKey with arn = %q, want %q", got, arn)
	}
	empty := ""
	withEmptyArn := Finding{Arn: &empty, TfType: "aws_instance", LiveID: "i-0abc"}
	if got := findingKey(withEmptyArn); got != "aws_instance/i-0abc" {
		t.Errorf("findingKey with empty-string arn = %q, want the tfType/liveId fallback", got)
	}
	noArn := Finding{TfType: "aws_instance", LiveID: "i-0abc"}
	if got := findingKey(noArn); got != "aws_instance/i-0abc" {
		t.Errorf("findingKey with nil arn = %q, want %q", got, "aws_instance/i-0abc")
	}
}
