package driftpropose

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestAdoptEditGolden drives GenerateAdopt against the real "benign tags" envelope
// fixture and the mini checkout, and asserts the edited HCL + unified diff are
// byte-stable against the committed golden (spec §6.4/§6.1: "approvers review the
// exact bytes that will land"). The diff must be the runbook's PR-#18 promise made
// literal: exactly the one changed line, nothing else — proving the map-merge token
// surgery (adopt.go's mergeSingleKey) preserves every other byte of the file,
// including the sibling `Env` key and its own alignment.
func TestAdoptEditGolden(t *testing.T) {
	checkout := copyCheckoutFixture(t)
	env, err := LoadEnvelope("../../testdata/driftpropose/envelopes/benign-tags.json")
	if err != nil {
		t.Fatalf("load envelope fixture: %v", err)
	}
	if len(env.Report.Verdicts) != 1 {
		t.Fatalf("fixture carries %d verdicts, want 1", len(env.Report.Verdicts))
	}
	v := env.Report.Verdicts[0]

	bucket, _ := ClassifyByFields(v)
	if bucket != BucketAdopt {
		t.Fatalf("fixture verdict classified %q, want %q", bucket, BucketAdopt)
	}

	p, ungenReason, err := GenerateAdopt(v, filepath.Join(checkout, "environments/prod"), "environments/prod")
	if err != nil {
		t.Fatalf("GenerateAdopt: %v", err)
	}
	if ungenReason != "" {
		t.Fatalf("unexpected ungenerable reason: %s", ungenReason)
	}
	if p == nil {
		t.Fatal("GenerateAdopt returned a nil proposal with no reason and no error")
	}

	if p.Flavor != "adopt" {
		t.Errorf("flavor = %q, want adopt", p.Flavor)
	}
	if len(p.Addresses) != 1 || p.Addresses[0] != "aws_instance.sample01" {
		t.Errorf("addresses = %v, want [aws_instance.sample01]", p.Addresses)
	}
	if p.Diff == nil {
		t.Fatal("adopt proposal carries a nil diff")
	}
	if len(p.RequestSkeleton.Items) != 1 {
		t.Fatalf("requestSkeleton.items has %d entries, want 1", len(p.RequestSkeleton.Items))
	}
	item := p.RequestSkeleton.Items[0]
	if item.OperationID != "system-drift-adopt" {
		t.Errorf("operationId = %q, want system-drift-adopt", item.OperationID)
	}
	if item.TargetAddress != "aws_instance.sample01" {
		t.Errorf("targetAddress = %q, want aws_instance.sample01", item.TargetAddress)
	}
	if item.Params.ProposalDigest != p.Digest {
		t.Errorf("params.proposalDigest = %q, want it to equal the proposal digest %q", item.Params.ProposalDigest, p.Digest)
	}

	want, err := os.ReadFile("../../testdata/driftpropose/golden/adopt-benign-tags.diff")
	if err != nil {
		t.Fatalf("read golden diff: %v", err)
	}
	if *p.Diff != string(want) {
		t.Fatalf("diff mismatch.\n--- got ---\n%s\n--- want ---\n%s", *p.Diff, string(want))
	}

	// The diff is exactly one changed line either side (plus the 3-line-context
	// unified-diff hunk header machinery) — never a whole-map re-render.
	wantJSON, err := os.ReadFile("../../testdata/driftpropose/golden/proposals.json")
	if err != nil {
		t.Fatalf("read golden proposals.json: %v", err)
	}
	var wantDoc ProposalsDoc
	if err := json.Unmarshal(wantJSON, &wantDoc); err != nil {
		t.Fatalf("parse golden proposals.json: %v", err)
	}
	if len(wantDoc.Proposals) == 0 {
		t.Fatal("golden proposals.json carries no proposals — fixture is stale")
	}
	if wantDoc.Proposals[0].Digest != p.Digest {
		t.Fatalf("golden proposals.json's first proposal digest %q != GenerateAdopt's digest %q — golden fixture is stale", wantDoc.Proposals[0].Digest, p.Digest)
	}
}

// TestAdoptRefusesAddressNotInCheckout pins the catalogctl-exclusive,
// checkout-dependent refinement layered on top of ClassifyByFields (§6.2's "every
// address resolves to a block in the checkout"): a verdict that is otherwise
// perfectly ADOPT-eligible by its FIELDS still yields an ungenerable reason, never
// an error and never a guessed edit, when the address simply is not in the tree.
func TestAdoptRefusesAddressNotInCheckout(t *testing.T) {
	checkout := copyCheckoutFixture(t)
	v := Verdict{
		Address:       "aws_instance.does_not_exist",
		Class:         "benign_inplace",
		RiskTier:      "low",
		DriftEvidence: true,
		Actions:       []string{"update"},
		ChangedAttrs: []ChangedAttr{
			{Path: "tags.Owner", Sensitive: false, LiveJSON: json.RawMessage(`"bi-team"`), CodeJSON: json.RawMessage(`"platform"`)},
		},
	}
	bucket, _ := ClassifyByFields(v)
	if bucket != BucketAdopt {
		t.Fatalf("fixture verdict classified %q, want %q (field-level check should pass)", bucket, BucketAdopt)
	}
	p, reason, err := GenerateAdopt(v, filepath.Join(checkout, "environments/prod"), "environments/prod")
	if err != nil {
		t.Fatalf("GenerateAdopt returned an error, want a clean ungenerable reason: %v", err)
	}
	if p != nil {
		t.Fatalf("GenerateAdopt returned a proposal for an address absent from the checkout: %+v", p)
	}
	if reason == "" {
		t.Fatal("GenerateAdopt returned no ungenerable reason for an address absent from the checkout")
	}
}

// writeMiniCheckout writes one *.tf file (tf content) under a fresh t.TempDir()'s
// environments/prod/ and returns that directory — a smaller, scenario-specific
// sibling of copyCheckoutFixture for the two map-merge refusal shapes below, which
// have no reason to share the main fixture's resources.
func writeMiniCheckout(t *testing.T, tf string) string {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "environments", "prod")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "main.tf"), []byte(tf), 0o644); err != nil {
		t.Fatal(err)
	}
	return dir
}

// TestAdoptRefusesMissingMapAttribute pins the checkout-dependent refinement for the
// two-segment (map-key) path shape: PathExpressible only checks the PATH STRING's
// shape ("tags.Owner" — two non-bracketed segments), it cannot know whether the
// `tags` attribute actually exists on the real block. drift-propose v1 never
// fabricates a map from nothing (adopt.go's mergeSingleKey doc) — a missing map
// attribute is an ungenerable reason, never a guessed new attribute.
func TestAdoptRefusesMissingMapAttribute(t *testing.T) {
	envDir := writeMiniCheckout(t, "resource \"aws_instance\" \"notags\" {\n  ami = \"ami-0123456789abcdef0\"\n}\n")
	v := Verdict{
		Address: "aws_instance.notags", Class: "benign_inplace", RiskTier: "low",
		DriftEvidence: true, Actions: []string{"update"},
		ChangedAttrs: []ChangedAttr{
			{Path: "tags.Owner", Sensitive: false, LiveJSON: json.RawMessage(`"bi-team"`), CodeJSON: json.RawMessage(`"platform"`)},
		},
	}
	if bucket, _ := ClassifyByFields(v); bucket != BucketAdopt {
		t.Fatalf("field-level bucket = %q, want %q", bucket, BucketAdopt)
	}
	p, reason, err := GenerateAdopt(v, envDir, "environments/prod")
	if err != nil {
		t.Fatalf("GenerateAdopt: %v", err)
	}
	if p != nil {
		t.Fatalf("GenerateAdopt fabricated a proposal for a missing map attribute: %+v", p)
	}
	if !strings.Contains(reason, "tags") {
		t.Fatalf("reason = %q, want it to name the missing tags attribute", reason)
	}
}

// TestAdoptRefusesNonLiteralMapAttribute pins the sibling refusal: a `tags` attribute
// that exists but is NOT a literal object (e.g. a variable/local reference) must
// never be blindly overwritten — the engine only ever merges into a literal map it
// can read and preserve byte-for-byte.
func TestAdoptRefusesNonLiteralMapAttribute(t *testing.T) {
	envDir := writeMiniCheckout(t, "resource \"aws_instance\" \"reftags\" {\n  ami  = \"ami-0123456789abcdef0\"\n  tags = local.common_tags\n}\n")
	v := Verdict{
		Address: "aws_instance.reftags", Class: "benign_inplace", RiskTier: "low",
		DriftEvidence: true, Actions: []string{"update"},
		ChangedAttrs: []ChangedAttr{
			{Path: "tags.Owner", Sensitive: false, LiveJSON: json.RawMessage(`"bi-team"`), CodeJSON: json.RawMessage(`"platform"`)},
		},
	}
	if bucket, _ := ClassifyByFields(v); bucket != BucketAdopt {
		t.Fatalf("field-level bucket = %q, want %q", bucket, BucketAdopt)
	}
	p, reason, err := GenerateAdopt(v, envDir, "environments/prod")
	if err != nil {
		t.Fatalf("GenerateAdopt: %v", err)
	}
	if p != nil {
		t.Fatalf("GenerateAdopt overwrote a non-literal tags expression: %+v", p)
	}
	if !strings.Contains(reason, "literal") {
		t.Fatalf("reason = %q, want it to explain the non-literal refusal", reason)
	}

	// The checkout must be untouched — a refusal never partially writes.
	got, err := os.ReadFile(filepath.Join(envDir, "main.tf"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(got), "bi-team") {
		t.Fatal("a NOT_LITERAL refusal still wrote the liveJson value to disk")
	}
}

// adoptGoldenDiff is TestAdoptEditGolden's shared shape, factored out for the
// F3/F8/W1 capability-unlock goldens below: load a single-verdict envelope
// fixture, drive it through ClassifyByFields + GenerateAdopt against the shared
// checkout fixture, and compare the resulting diff against a committed golden.
func adoptGoldenDiff(t *testing.T, envelopeName, wantAddress, goldenName string) *Proposal {
	t.Helper()
	checkout := copyCheckoutFixture(t)
	env, err := LoadEnvelope("../../testdata/driftpropose/envelopes/" + envelopeName)
	if err != nil {
		t.Fatalf("load envelope fixture: %v", err)
	}
	if len(env.Report.Verdicts) != 1 {
		t.Fatalf("fixture carries %d verdicts, want 1", len(env.Report.Verdicts))
	}
	v := env.Report.Verdicts[0]

	bucket, reason := ClassifyByFields(v)
	if bucket != BucketAdopt {
		t.Fatalf("fixture verdict classified %q (reason=%q), want %q", bucket, reason, BucketAdopt)
	}

	p, ungenReason, err := GenerateAdopt(v, filepath.Join(checkout, "environments/prod"), "environments/prod")
	if err != nil {
		t.Fatalf("GenerateAdopt: %v", err)
	}
	if ungenReason != "" {
		t.Fatalf("unexpected ungenerable reason: %s", ungenReason)
	}
	if p == nil {
		t.Fatal("GenerateAdopt returned a nil proposal with no reason and no error")
	}
	if p.Flavor != "adopt" {
		t.Errorf("flavor = %q, want adopt", p.Flavor)
	}
	if len(p.Addresses) != 1 || p.Addresses[0] != wantAddress {
		t.Errorf("addresses = %v, want [%s]", p.Addresses, wantAddress)
	}
	if p.Diff == nil {
		t.Fatal("adopt proposal carries a nil diff")
	}
	item := p.RequestSkeleton.Items[0]
	if item.Params.ProposalDigest != p.Digest {
		t.Errorf("params.proposalDigest = %q, want it to equal the proposal digest %q", item.Params.ProposalDigest, p.Digest)
	}

	want, err := os.ReadFile("../../testdata/driftpropose/golden/" + goldenName)
	if err != nil {
		t.Fatalf("read golden diff: %v", err)
	}
	if *p.Diff != string(want) {
		t.Fatalf("diff mismatch.\n--- got ---\n%s\n--- want ---\n%s", *p.Diff, string(want))
	}
	return p
}

// TestAdoptDeletedKey pins spec F3/addendum A5: a tag key deleted live (a
// 2-segment map path whose changedAttrs row carries an explicit `liveJson:
// null`) adopts by REMOVING the key from code — never writing `CostCenter =
// null` (terraform-proven non-equivalent; the old upsert-null behavior could
// never plan 0/0/0 and permanently wedged R7).
func TestAdoptDeletedKey(t *testing.T) {
	p := adoptGoldenDiff(t, "deleted-tag.json", "aws_instance.tagdel01", "adopt-deleted-tag.diff")
	if !strings.Contains(*p.Diff, `-    CostCenter = "cc-42"`) {
		t.Fatalf("diff does not show the CostCenter key being removed:\n%s", *p.Diff)
	}
	if strings.Contains(*p.Diff, "null") {
		t.Fatalf("diff writes a literal null instead of removing the key:\n%s", *p.Diff)
	}
}

// TestAdoptDottedKey pins spec F8: a dotted/slashed tag key
// ("kubernetes.io/role/elb") carried as ONE structured pathSegments element
// adopts correctly — the legacy display-path string alone would mis-split into
// 3 dot-parts and be refused, but the structured segment is never re-split.
func TestAdoptDottedKey(t *testing.T) {
	p := adoptGoldenDiff(t, "dotted-key.json", "aws_instance.dottedbox01", "adopt-dotted-key.diff")
	if !strings.Contains(*p.Diff, `"kubernetes.io/role/elb" = "owned"`) {
		t.Fatalf("diff does not show the dotted key's value changing to the live value:\n%s", *p.Diff)
	}
}

// TestAdoptNestedSingleBlock pins W1: a single-instance nested-block leaf
// (root_block_device[0].volume_size, spec addendum A4's [s, 0, s] shape) on a
// NON-watchlisted attribute adopts by writing the leaf inside the block.
func TestAdoptNestedSingleBlock(t *testing.T) {
	p := adoptGoldenDiff(t, "nested-block.json", "aws_instance.volbox01", "adopt-nested-block.diff")
	if !strings.Contains(*p.Diff, "volume_size = 100") {
		t.Fatalf("diff does not show volume_size adopting the live value:\n%s", *p.Diff)
	}
}

// TestAdoptNestedSingleBlockRefusesRepeatedBlock pins W1's checkout-dependent
// refusal for >=2 actual instances of the nested block type: the SEGMENT SHAPE
// is expressible (index 0), but the checkout itself makes plan-index↔config-block
// mapping ambiguous under set/list reordering (register 0009 L28) — never guessed.
func TestAdoptNestedSingleBlockRefusesRepeatedBlock(t *testing.T) {
	envDir := writeMiniCheckout(t, `resource "aws_security_group" "tworules" {
  name = "tworules"

  ingress {
    from_port = 80
    to_port   = 80
  }
  ingress {
    from_port = 443
    to_port   = 443
  }
}
`)
	v := Verdict{
		Address: "aws_security_group.tworules", Class: "benign_inplace", RiskTier: "low",
		DriftEvidence: true, Actions: []string{"update"},
		ChangedAttrs: []ChangedAttr{
			{Path: "ingress[0].from_port", Sensitive: false, LiveJSON: json.RawMessage(`8080`), CodeJSON: json.RawMessage(`80`),
				PathSegments: []any{"ingress", 0, "from_port"}},
		},
	}
	if bucket, _ := ClassifyByFields(v); bucket != BucketAdopt {
		t.Fatalf("field-level bucket = %q, want %q (shape is expressible; only the checkout makes it ambiguous)", bucket, BucketAdopt)
	}
	p, reason, err := GenerateAdopt(v, envDir, "environments/prod")
	if err != nil {
		t.Fatalf("GenerateAdopt: %v", err)
	}
	if p != nil {
		t.Fatalf("GenerateAdopt guessed which of 2 repeated blocks to edit: %+v", p)
	}
	if !strings.Contains(reason, "L28") {
		t.Fatalf("reason = %q, want it to point at register 0009 L28", reason)
	}
}

// TestAdoptNestedSingleBlockRefusesAttributeNotBlock pins W1's third checkout
// refusal: segs[0] names an ATTRIBUTE on the block, not a nested block — never
// silently treated as a zero-instance block.
func TestAdoptNestedSingleBlockRefusesAttributeNotBlock(t *testing.T) {
	envDir := writeMiniCheckout(t, `resource "aws_instance" "flatattr" {
  ami                  = "ami-0123456789abcdef0"
  iam_instance_profile = "flat-string-not-a-block"
}
`)
	v := Verdict{
		Address: "aws_instance.flatattr", Class: "benign_inplace", RiskTier: "low",
		DriftEvidence: true, Actions: []string{"update"},
		ChangedAttrs: []ChangedAttr{
			{Path: "iam_instance_profile[0].name", Sensitive: false, LiveJSON: json.RawMessage(`"x"`), CodeJSON: json.RawMessage(`"y"`),
				PathSegments: []any{"iam_instance_profile", 0, "name"}},
		},
	}
	if bucket, _ := ClassifyByFields(v); bucket != BucketAdopt {
		t.Fatalf("field-level bucket = %q, want %q", bucket, BucketAdopt)
	}
	p, reason, err := GenerateAdopt(v, envDir, "environments/prod")
	if err != nil {
		t.Fatalf("GenerateAdopt: %v", err)
	}
	if p != nil {
		t.Fatalf("GenerateAdopt treated an attribute as a nested block: %+v", p)
	}
	if !strings.Contains(reason, "attribute") || !strings.Contains(reason, "not a nested block") {
		t.Fatalf("reason = %q, want it to explain the attribute-not-block refusal", reason)
	}
}
