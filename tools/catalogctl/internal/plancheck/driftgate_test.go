package plancheck

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/driftpropose"
)

// benignVerdict returns a Verdict that is, by its fields alone, adopt-eligible per
// driftpropose.ClassifyByFields — the baseline every test below mutates.
func benignVerdict() driftpropose.Verdict {
	return driftpropose.Verdict{
		Address:       "aws_instance.sample01",
		Type:          "aws_instance",
		Actions:       []string{"update"},
		DriftEvidence: true,
		Class:         "benign_inplace",
		RiskTier:      "low",
		ChangedAttrs: []driftpropose.ChangedAttr{
			{Path: "tags.Owner", Sensitive: false, LiveJSON: json.RawMessage(`"bi-team"`), CodeJSON: json.RawMessage(`"platform"`)},
		},
	}
}

func mustMarshal(t *testing.T, v any) json.RawMessage {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return b
}

// oneItem wraps a single operationId+params pair into the []BundleRequestItem
// shape RunDriftGate now takes (spec addendum A2/F1(b)) — the single-item case
// every pre-batching test below drives.
func oneItem(opID string, params json.RawMessage) []driftpropose.BundleRequestItem {
	return []driftpropose.BundleRequestItem{{OperationID: opID, Params: params}}
}

// TestGateRefusesSecurityAdopt is the WI-5-named test for spec §8 enforcement point
// 3: a verdict "relabeled" benign_inplace (the class an adopt request must carry)
// that STILL carries a securityHits row must refuse — the SAME
// IsSecurityPosture "union, never narrows" doctrine driftpropose's own
// TestSecurityNeverReachesAdopt pins at enforcement point 1, re-proven here as an
// INDEPENDENT check at the gate (enforcement point 3): this function does not trust
// that points 1-2 upstream already refused correctly. A clean (nil) Plan is passed
// deliberately — eligibility must refuse BEFORE R7 ever inspects the plan.
func TestGateRefusesSecurityAdopt(t *testing.T) {
	v := benignVerdict()
	v.SecurityHits = []driftpropose.SecurityHit{{Path: "ingress[0].cidr_blocks", Why: "watchlisted network reachability"}}

	params := mustMarshal(t, driftpropose.AdoptParams{Verdicts: []driftpropose.Verdict{v}})
	violations, info, err := RunDriftGate(OpDriftAdopt, oneItem(OpDriftAdopt, params), Plan{})
	if err != nil {
		t.Fatalf("RunDriftGate returned an error, want a clean refusal: %v", err)
	}
	if len(info) != 0 {
		t.Fatalf("info = %v, want none — a refused gate must not also claim success", info)
	}
	if len(violations) == 0 {
		t.Fatal("gate accepted a pinned verdict carrying a securityHits row — enforcement point 3 did not fire")
	}
	for _, vi := range violations {
		if vi.Rule != "drift-adopt-eligibility" {
			t.Errorf("rule = %q, want drift-adopt-eligibility", vi.Rule)
		}
		if vi.Address != v.Address {
			t.Errorf("address = %q, want %q", vi.Address, v.Address)
		}
	}
}

// TestGateRefusesExplicitSecurityPostureClass is TestGateRefusesSecurityAdopt's
// sibling: the more direct shape (class already security_posture, not merely
// carrying a stray securityHits row) must refuse identically.
func TestGateRefusesExplicitSecurityPostureClass(t *testing.T) {
	v := benignVerdict()
	v.Class = "security_posture"
	v.RiskTier = "high"

	params := mustMarshal(t, driftpropose.AdoptParams{Verdicts: []driftpropose.Verdict{v}})
	violations, _, err := RunDriftGate(OpDriftAdopt, oneItem(OpDriftAdopt, params), Plan{})
	if err != nil {
		t.Fatalf("RunDriftGate: %v", err)
	}
	if len(violations) == 0 {
		t.Fatal("gate accepted a security_posture verdict pinned to an adopt request")
	}
}

// TestGateAdoptGreen is RunDriftGate's happy path: a genuinely adopt-eligible pinned
// verdict plus a zero-delta plan clears both the eligibility recheck and R7.
func TestGateAdoptGreen(t *testing.T) {
	params := mustMarshal(t, driftpropose.AdoptParams{Verdicts: []driftpropose.Verdict{benignVerdict()}})
	plan := planOf(sgChange("aws_instance.sample01", []string{"no-op"}, nil, nil))
	violations, info, err := RunDriftGate(OpDriftAdopt, oneItem(OpDriftAdopt, params), plan)
	if err != nil {
		t.Fatalf("RunDriftGate: %v", err)
	}
	if len(violations) != 0 {
		t.Fatalf("violations = %v, want none", violations)
	}
	if len(info) == 0 {
		t.Fatal("want an INFO line confirming the clean gate")
	}
}

// TestGateAdoptEligibleButResidualDiff proves eligibility passing does not paper
// over a dirty plan: R7 still runs (and still blocks) once the pinned verdict itself
// clears enforcement point 3.
func TestGateAdoptEligibleButResidualDiff(t *testing.T) {
	params := mustMarshal(t, driftpropose.AdoptParams{Verdicts: []driftpropose.Verdict{benignVerdict()}})
	plan := planOf(sgChange("aws_instance.sample01", []string{"update"},
		map[string]any{"tags": map[string]any{"Owner": "bi-team"}},
		map[string]any{"tags": map[string]any{"Owner": "someone-else"}}))
	violations, _, err := RunDriftGate(OpDriftAdopt, oneItem(OpDriftAdopt, params), plan)
	if err != nil {
		t.Fatalf("RunDriftGate: %v", err)
	}
	if len(violations) == 0 {
		t.Fatal("want a violation: the plan still shows a change after the adopt edit")
	}
	if violations[0].Rule != "adopt-zero-delta" {
		t.Errorf("rule = %q, want adopt-zero-delta", violations[0].Rule)
	}
}

// TestGateRevertGreen is RunDriftGate's revert happy path: no eligibility recheck is
// performed (revert never re-derives §6.2 — spec §7 asks that only of adopt), only R8.
func TestGateRevertGreen(t *testing.T) {
	params := mustMarshal(t, driftpropose.RevertParams{Attrs: []driftpropose.Attr{
		{Address: "aws_security_group.sg1", Path: "ingress[0].cidr_blocks", LiveJSON: []any{"0.0.0.0/0"}, CodeJSON: []any{"10.0.0.0/16"}},
	}})
	plan := planOf(sgChange("aws_security_group.sg1", []string{"update"},
		map[string]any{"ingress": []any{map[string]any{"cidr_blocks": []any{"0.0.0.0/0"}}}},
		map[string]any{"ingress": []any{map[string]any{"cidr_blocks": []any{"10.0.0.0/16"}}}}))
	violations, info, err := RunDriftGate(OpDriftRevert, oneItem(OpDriftRevert, params), plan)
	if err != nil {
		t.Fatalf("RunDriftGate: %v", err)
	}
	if len(violations) != 0 {
		t.Fatalf("violations = %v, want none", violations)
	}
	if len(info) == 0 {
		t.Fatal("want an INFO line confirming the clean gate")
	}
}

// TestGateRevertNeverRederivesEligibility proves the asymmetry spec §7's text states:
// a revert of an explicitly security_posture-classed verdict is NOT refused by this
// gate (only R8's in-place/scope shape matters) — re-imposing code over a console
// change is always the safe direction.
func TestGateRevertNeverRederivesEligibility(t *testing.T) {
	params := mustMarshal(t, driftpropose.RevertParams{Attrs: []driftpropose.Attr{
		{Address: "aws_security_group.sg1", Path: "ingress[0].cidr_blocks", LiveJSON: []any{"0.0.0.0/0"}, CodeJSON: []any{"10.0.0.0/16"}},
	}})
	plan := planOf(sgChange("aws_security_group.sg1", []string{"no-op"}, nil, nil))
	violations, _, err := RunDriftGate(OpDriftRevert, oneItem(OpDriftRevert, params), plan)
	if err != nil {
		t.Fatalf("RunDriftGate: %v", err)
	}
	if len(violations) != 0 {
		t.Fatalf("violations = %v, want none (revert never re-derives §6.2 eligibility)", violations)
	}
}

// TestRunDriftGateBatchedAdoptSet pins spec addendum A2/F1(b)'s core fix: a
// batched adopt change-set gates EVERY item, not only items[0] (the exact F1 bug
// class — two suites tested two different shapes and no test crossed the seam).
// Two items, two different addresses, both individually adopt-eligible and both
// zero-delta: the gate must concat verdicts across both and pass.
func TestRunDriftGateBatchedAdoptSet(t *testing.T) {
	v1 := benignVerdict() // aws_instance.sample01
	v2 := driftpropose.Verdict{
		Address: "aws_instance.other02", Type: "aws_instance", Actions: []string{"update"},
		DriftEvidence: true, Class: "benign_inplace", RiskTier: "low",
		ChangedAttrs: []driftpropose.ChangedAttr{
			{Path: "tags.Env", Sensitive: false, LiveJSON: json.RawMessage(`"prod"`), CodeJSON: json.RawMessage(`"staging"`)},
		},
	}
	items := []driftpropose.BundleRequestItem{
		{OperationID: OpDriftAdopt, Params: mustMarshal(t, driftpropose.AdoptParams{Verdicts: []driftpropose.Verdict{v1}})},
		{OperationID: OpDriftAdopt, Params: mustMarshal(t, driftpropose.AdoptParams{Verdicts: []driftpropose.Verdict{v2}})},
	}
	plan := planOf(
		sgChange("aws_instance.sample01", []string{"no-op"}, nil, nil),
		sgChange("aws_instance.other02", []string{"no-op"}, nil, nil),
	)
	violations, info, err := RunDriftGate(OpDriftAdopt, items, plan)
	if err != nil {
		t.Fatalf("RunDriftGate: %v", err)
	}
	if len(violations) != 0 {
		t.Fatalf("violations = %v, want none", violations)
	}
	if len(info) == 0 || !strings.Contains(info[0], "2 item") {
		t.Fatalf("info = %v, want it to name both items gated", info)
	}
}

// TestRunDriftGateBatchedAdoptSetOneBadItemRefusesWhole proves a batch is gated
// as a whole: if ONLY the second item's verdict is security-posture, the WHOLE
// gate still refuses — item[0]'s eligibility does not paper over item[1]'s.
func TestRunDriftGateBatchedAdoptSetOneBadItemRefusesWhole(t *testing.T) {
	v1 := benignVerdict()
	v2 := benignVerdict()
	v2.Address = "aws_iam_role.other03"
	v2.SecurityHits = []driftpropose.SecurityHit{{Path: "assume_role_policy", Why: "role trust policy"}}
	items := []driftpropose.BundleRequestItem{
		{OperationID: OpDriftAdopt, Params: mustMarshal(t, driftpropose.AdoptParams{Verdicts: []driftpropose.Verdict{v1}})},
		{OperationID: OpDriftAdopt, Params: mustMarshal(t, driftpropose.AdoptParams{Verdicts: []driftpropose.Verdict{v2}})},
	}
	violations, _, err := RunDriftGate(OpDriftAdopt, items, Plan{})
	if err != nil {
		t.Fatalf("RunDriftGate: %v", err)
	}
	if len(violations) == 0 {
		t.Fatal("a batched item's security-posture verdict did not refuse the whole gate")
	}
	found := false
	for _, v := range violations {
		if v.Address == "aws_iam_role.other03" {
			found = true
		}
	}
	if !found {
		t.Fatalf("violations = %v, want one naming aws_iam_role.other03", violations)
	}
}

// TestRunDriftGateAdoptItemWithZeroVerdictsRefuses pins the per-item error
// contract (spec addendum A2: "any item with zero verdicts ⇒ error/exit 3") —
// distinct from a whole-request "no items at all" refusal.
func TestRunDriftGateAdoptItemWithZeroVerdictsRefuses(t *testing.T) {
	items := []driftpropose.BundleRequestItem{
		{OperationID: OpDriftAdopt, Params: mustMarshal(t, driftpropose.AdoptParams{Verdicts: []driftpropose.Verdict{benignVerdict()}})},
		{OperationID: OpDriftAdopt, Params: mustMarshal(t, driftpropose.AdoptParams{Verdicts: nil})},
	}
	if _, _, err := RunDriftGate(OpDriftAdopt, items, Plan{}); err == nil {
		t.Fatal("want an error: item 1 pins zero verdicts")
	}
}

// TestRunDriftGateRevertRefusesMultipleItems pins spec addendum A2/F1(b): "revert
// — refuses >1 item (api already enforces revert-submits-alone; the gate
// re-enforces)."
func TestRunDriftGateRevertRefusesMultipleItems(t *testing.T) {
	params := mustMarshal(t, driftpropose.RevertParams{Attrs: []driftpropose.Attr{
		{Address: "aws_security_group.sg1", Path: "ingress[0].cidr_blocks"},
	}})
	items := []driftpropose.BundleRequestItem{
		{OperationID: OpDriftRevert, Params: params},
		{OperationID: OpDriftRevert, Params: params},
	}
	if _, _, err := RunDriftGate(OpDriftRevert, items, Plan{}); err == nil {
		t.Fatal("want an error: revert must never gate more than one item")
	}
}

// TestGateMalformedParamsRefuses pins the parse-error contract (command.go maps this
// to exit 3): unparseable or empty pinned params never silently pass.
func TestGateMalformedParamsRefuses(t *testing.T) {
	if _, _, err := RunDriftGate(OpDriftAdopt, oneItem(OpDriftAdopt, json.RawMessage(`{not json`)), Plan{}); err == nil {
		t.Fatal("want an error for malformed JSON params")
	}
	if _, _, err := RunDriftGate(OpDriftAdopt, oneItem(OpDriftAdopt, json.RawMessage(`{"verdicts":[]}`)), Plan{}); err == nil {
		t.Fatal("want an error for zero pinned verdicts")
	}
	if _, _, err := RunDriftGate(OpDriftRevert, oneItem(OpDriftRevert, json.RawMessage(`{"attrs":[]}`)), Plan{}); err == nil {
		t.Fatal("want an error for zero pinned attrs")
	}
	if _, _, err := RunDriftGate(OpDriftRevert, nil, Plan{}); err == nil {
		t.Fatal("want an error for zero items")
	}
	if _, _, err := RunDriftGate("system-drift-teleport", oneItem("system-drift-teleport", json.RawMessage(`{}`)), Plan{}); err == nil {
		t.Fatal("want an error for an unrecognised drift op")
	}
}

// TestPeekDriftOp pins peekDriftOp's safety contract: it recognises the two drift
// ops from JSON and is a silent, harmless miss for a genuine ccp.request/v1 YAML
// file (block-style YAML is never valid JSON) — the property command.go's dispatch
// leans on to leave every other --request fixture untouched.
func TestPeekDriftOp(t *testing.T) {
	dir := t.TempDir()
	driftFile := filepath.Join(dir, "bundle-request.json")
	if err := os.WriteFile(driftFile, []byte(`{"operationId":"system-drift-adopt","params":{"verdicts":[]}}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if opID, items, kind := peekDriftOp(driftFile); kind != driftMatch || opID != OpDriftAdopt || len(items) != 1 {
		t.Fatalf("peekDriftOp(drift json) = %q, %v, %v — want OpDriftAdopt, 1 item, driftMatch", opID, items, kind)
	}

	yamlFile := filepath.Join(dir, "request.yaml")
	if err := os.WriteFile(yamlFile, []byte("schema: ccp.request/v1\nid: REQ-01ARZ3NDEKTSV4RRFFQ69G5FAV\nitem: ec2-resize\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, _, kind := peekDriftOp(yamlFile); kind != notDrift {
		t.Fatal("peekDriftOp matched a genuine ccp.request/v1 YAML file")
	}

	if _, _, kind := peekDriftOp(filepath.Join(dir, "does-not-exist.json")); kind != notDrift {
		t.Fatal("peekDriftOp matched a nonexistent path")
	}

	otherJSON := filepath.Join(dir, "other.json")
	if err := os.WriteFile(otherJSON, []byte(`{"operationId":"ec2-resize","params":{}}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, _, kind := peekDriftOp(otherJSON); kind != notDrift {
		t.Fatal("peekDriftOp matched JSON naming a non-drift operationId")
	}
}

// TestPeekDriftOpBatchedItemsAllSame pins the items[]-aware half of the
// re-based peekDriftOp: a batched change-set (items[] present) whose every
// item names the SAME drift op is driftMatch, carrying every item — not just
// the top-level {operationId, params} pair.
func TestPeekDriftOpBatchedItemsAllSame(t *testing.T) {
	dir := t.TempDir()
	f := filepath.Join(dir, "bundle-request.json")
	body := `{
		"operationId": "system-drift-adopt", "params": {"verdicts": []},
		"items": [
			{"operationId": "system-drift-adopt", "params": {"verdicts": [1]}},
			{"operationId": "system-drift-adopt", "params": {"verdicts": [2]}}
		]
	}`
	if err := os.WriteFile(f, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	opID, items, kind := peekDriftOp(f)
	if kind != driftMatch || opID != OpDriftAdopt {
		t.Fatalf("kind=%v opID=%q, want driftMatch/OpDriftAdopt", kind, opID)
	}
	if len(items) != 2 {
		t.Fatalf("items = %d, want 2 (the items[] array, not the top-level pair)", len(items))
	}
}

// TestPeekDriftOpMixedDriftOpsIsMalformed pins spec addendum A2: a batch whose
// items name DIFFERENT drift ops (adopt + revert) has no honest producer —
// malformedDrift, never notDrift (which would silently fall through to the
// YAML+manifest path for the wrong reason) and never driftMatch (which would
// pick one op arbitrarily).
func TestPeekDriftOpMixedDriftOpsIsMalformed(t *testing.T) {
	dir := t.TempDir()
	f := filepath.Join(dir, "bundle-request.json")
	body := `{
		"operationId": "system-drift-adopt", "params": {},
		"items": [
			{"operationId": "system-drift-adopt", "params": {"verdicts": []}},
			{"operationId": "system-drift-revert", "params": {"attrs": []}}
		]
	}`
	if err := os.WriteFile(f, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, _, kind := peekDriftOp(f); kind != malformedDrift {
		t.Fatalf("kind = %v, want malformedDrift", kind)
	}
}

// TestPeekDriftOpMixedDriftAndNonDriftIsMalformed is the same doctrine's other
// shape: one item names a drift op, the other names something else entirely.
func TestPeekDriftOpMixedDriftAndNonDriftIsMalformed(t *testing.T) {
	dir := t.TempDir()
	f := filepath.Join(dir, "bundle-request.json")
	body := `{
		"operationId": "system-drift-adopt", "params": {},
		"items": [
			{"operationId": "system-drift-adopt", "params": {"verdicts": []}},
			{"operationId": "ec2-resize", "params": {}}
		]
	}`
	if err := os.WriteFile(f, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, _, kind := peekDriftOp(f); kind != malformedDrift {
		t.Fatalf("kind = %v, want malformedDrift", kind)
	}
}

// TestPeekDriftOpLoneLegitimizeMatches pins plan
// 2026-07-20-drift-restore-tranche.md §4 (register 0009 L32, the owner-
// approved gate teaching): a request naming ONLY system-drift-legitimize is
// now driftMatch, ready for RunDriftGate — the SAME shape a lone adopt/revert
// request already gets. This supersedes the pre-L32 test
// TestPeekDriftOpLoneLegitimizeFallsThroughAsNotDrift (which pinned notDrift,
// back when isDriftOp did not recognise the op at all) — the ONE committed-
// test behavior flip in this tranche (plan §4/§5), owner-approved, not a
// convenience edit.
func TestPeekDriftOpLoneLegitimizeMatches(t *testing.T) {
	dir := t.TempDir()
	f := filepath.Join(dir, "bundle-request.json")
	body := `{"operationId": "system-drift-legitimize", "params": {"justification": "emergency SG opened for incident-42"}}`
	if err := os.WriteFile(f, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	opID, items, kind := peekDriftOp(f)
	if kind != driftMatch || opID != OpDriftLegitimize {
		t.Fatalf("kind=%v opID=%q, want driftMatch/OpDriftLegitimize (register 0009 L32: the gate now knows this op)", kind, opID)
	}
	if len(items) != 1 {
		t.Fatalf("items = %d, want 1", len(items))
	}
}

// --- import (spec 2026-07-20-ccp-oob-provisioning-import.md §6/§7.2) ---

// bastionFinding/bastionPayload are the shared happy-path pinned import
// inputs every RunDriftGate import test below starts from.
func bastionFinding() driftpropose.Finding {
	payload := bastionPayload()
	return driftpropose.Finding{
		Class: "unmanaged_resource", TfType: "aws_instance", LiveID: "i-0abc123def456789a",
		SecurityFamily: false, ImportPayload: &payload,
	}
}

func bastionPayload() driftpropose.FindingImportPayload {
	return driftpropose.FindingImportPayload{
		Address:     "aws_instance.oob_bastion01",
		TargetFile:  "oob-adopted.tf",
		ImportBlock: "import {\n  to = aws_instance.oob_bastion01\n  id = \"i-0abc123def456789a\"\n}\n",
		SkeletonHcl: "resource \"aws_instance\" \"oob_bastion01\" {\n  ami = \"ami-0123456789abcdef0\"\n}\n",
	}
}

// TestGateImportGreen is RunDriftGate's import happy path: a genuinely
// import-eligible pinned finding plus a plan showing exactly that address
// importing+no-op clears both the eligibility recheck and R10.
func TestGateImportGreen(t *testing.T) {
	params := mustMarshal(t, driftpropose.ImportParams{Finding: bastionFinding(), ImportPayload: bastionPayload()})
	plan := planOf(importingChange("aws_instance.oob_bastion01", importingID("i-0abc123def456789a"), []string{"no-op"}, nil, nil))
	violations, info, err := RunDriftGate(OpDriftImport, oneItem(OpDriftImport, params), plan)
	if err != nil {
		t.Fatalf("RunDriftGate: %v", err)
	}
	if len(violations) != 0 {
		t.Fatalf("violations = %v, want none", violations)
	}
	if len(info) == 0 || !strings.Contains(info[0], "import-exact") {
		t.Fatalf("info = %v, want an import-exact confirmation", info)
	}
}

// TestGateImportRefusesEligibilityFailure pins enforcement point 3 for
// import: a pinned finding that is NOT import-eligible (securityFamily
// true) must refuse — BEFORE R10 ever looks at the plan (a garbage/empty
// Plan{} is passed deliberately, mirroring TestGateRefusesSecurityAdopt).
func TestGateImportRefusesEligibilityFailure(t *testing.T) {
	f := bastionFinding()
	f.SecurityFamily = true
	params := mustMarshal(t, driftpropose.ImportParams{Finding: f, ImportPayload: bastionPayload()})
	violations, info, err := RunDriftGate(OpDriftImport, oneItem(OpDriftImport, params), Plan{})
	if err != nil {
		t.Fatalf("RunDriftGate returned an error, want a clean refusal: %v", err)
	}
	if len(info) != 0 {
		t.Fatalf("info = %v, want none — a refused gate must not also claim success", info)
	}
	if len(violations) == 0 {
		t.Fatal("gate accepted a pinned finding flagged securityFamily — enforcement point 3 did not fire")
	}
	for _, v := range violations {
		if v.Rule != "drift-import-eligibility" {
			t.Errorf("rule = %q, want drift-import-eligibility", v.Rule)
		}
		if v.Address != "aws_instance.oob_bastion01" {
			t.Errorf("address = %q, want aws_instance.oob_bastion01", v.Address)
		}
	}
}

// TestGateImportResidualDiffViolates proves eligibility passing does not
// paper over a dirty plan: R10 still runs (and still blocks) once the
// pinned finding itself clears enforcement point 3.
func TestGateImportResidualDiffViolates(t *testing.T) {
	params := mustMarshal(t, driftpropose.ImportParams{Finding: bastionFinding(), ImportPayload: bastionPayload()})
	plan := planOf(importingChange("aws_instance.oob_bastion01", importingID("i-0abc123def456789a"), []string{"update"},
		map[string]any{"instance_type": "m5.large"}, map[string]any{"instance_type": "m5.xlarge"}))
	violations, _, err := RunDriftGate(OpDriftImport, oneItem(OpDriftImport, params), plan)
	if err != nil {
		t.Fatalf("RunDriftGate: %v", err)
	}
	if len(violations) == 0 {
		t.Fatal("want a violation: the plan still shows an update after the import")
	}
	if violations[0].Rule != "import-exact" {
		t.Errorf("rule = %q, want import-exact", violations[0].Rule)
	}
}

// TestRunDriftGateBatchedImportSet pins spec §6's "one bundle importing N
// resources": a batched import change-set gates EVERY item, not only the
// first — mirroring TestRunDriftGateBatchedAdoptSet's own proof for adopt.
func TestRunDriftGateBatchedImportSet(t *testing.T) {
	f2 := driftpropose.Finding{
		Class: "unmanaged_resource", TfType: "aws_instance", LiveID: "i-0def456abc123789b", SecurityFamily: false,
		ImportPayload: &driftpropose.FindingImportPayload{
			Address: "aws_instance.oob_second01", TargetFile: "oob-adopted.tf",
			ImportBlock: "import {\n  to = aws_instance.oob_second01\n  id = \"i-0def456abc123789b\"\n}\n",
			SkeletonHcl: "resource \"aws_instance\" \"oob_second01\" {\n  ami = \"ami-0fedcba9876543210\"\n}\n",
		},
	}
	items := []driftpropose.BundleRequestItem{
		{OperationID: OpDriftImport, Params: mustMarshal(t, driftpropose.ImportParams{Finding: bastionFinding(), ImportPayload: bastionPayload()})},
		{OperationID: OpDriftImport, Params: mustMarshal(t, driftpropose.ImportParams{Finding: f2, ImportPayload: *f2.ImportPayload})},
	}
	plan := planOf(
		importingChange("aws_instance.oob_bastion01", importingID("i-0abc123def456789a"), []string{"no-op"}, nil, nil),
		importingChange("aws_instance.oob_second01", importingID("i-0def456abc123789b"), []string{"no-op"}, nil, nil),
	)
	violations, info, err := RunDriftGate(OpDriftImport, items, plan)
	if err != nil {
		t.Fatalf("RunDriftGate: %v", err)
	}
	if len(violations) != 0 {
		t.Fatalf("violations = %v, want none", violations)
	}
	if len(info) == 0 || !strings.Contains(info[0], "2") {
		t.Fatalf("info = %v, want it to name both pinned addresses gated", info)
	}
}

// TestRunDriftGateBatchedImportSetOneBadItemRefusesWhole mirrors
// TestRunDriftGateBatchedAdoptSetOneBadItemRefusesWhole: if ONLY the second
// item's finding fails eligibility, the WHOLE gate still refuses.
func TestRunDriftGateBatchedImportSetOneBadItemRefusesWhole(t *testing.T) {
	f2 := bastionFinding()
	f2.ImportPayload.Address = "aws_iam_role.oob_bad01"
	f2.SecurityFamily = true
	items := []driftpropose.BundleRequestItem{
		{OperationID: OpDriftImport, Params: mustMarshal(t, driftpropose.ImportParams{Finding: bastionFinding(), ImportPayload: bastionPayload()})},
		{OperationID: OpDriftImport, Params: mustMarshal(t, driftpropose.ImportParams{Finding: f2, ImportPayload: *f2.ImportPayload})},
	}
	violations, _, err := RunDriftGate(OpDriftImport, items, Plan{})
	if err != nil {
		t.Fatalf("RunDriftGate: %v", err)
	}
	if len(violations) == 0 {
		t.Fatal("a batched item's security-family finding did not refuse the whole gate")
	}
	found := false
	for _, v := range violations {
		if v.Address == "aws_iam_role.oob_bad01" {
			found = true
		}
	}
	if !found {
		t.Fatalf("violations = %v, want one naming aws_iam_role.oob_bad01", violations)
	}
}

// TestGateImportMalformedParamsRefuses mirrors TestGateMalformedParamsRefuses
// for the import op: unparseable JSON, zero items, and a missing pinned
// address all refuse with an error, never silently pass.
func TestGateImportMalformedParamsRefuses(t *testing.T) {
	if _, _, err := RunDriftGate(OpDriftImport, oneItem(OpDriftImport, jsonRaw(`{not json`)), Plan{}); err == nil {
		t.Fatal("want an error for malformed JSON params")
	}
	if _, _, err := RunDriftGate(OpDriftImport, oneItem(OpDriftImport, jsonRaw(`{"finding":{},"importPayload":{}}`)), Plan{}); err == nil {
		t.Fatal("want an error for a pinned importPayload with no address")
	}
	if _, _, err := RunDriftGate(OpDriftImport, nil, Plan{}); err == nil {
		t.Fatal("want an error for zero items")
	}
}

// TestIsDriftOpRecognizesImport pins spec §6/§7's "third known drift op" —
// OpDriftImport must be gate-known and share the system-drift- naming spec
// §4.4 requires, exactly like TestIsDriftOp pins the first two.
func TestIsDriftOpRecognizesImport(t *testing.T) {
	if !isDriftOp(OpDriftImport) {
		t.Fatal("isDriftOp(OpDriftImport) = false, want true")
	}
	if !strings.HasPrefix(OpDriftImport, "system-drift-") {
		t.Fatal("OpDriftImport drifted from the system-drift- naming spec §4.4 pins")
	}
	if OpDriftImport != "system-drift-import" {
		t.Fatalf("OpDriftImport = %q, want %q", OpDriftImport, "system-drift-import")
	}
}

// --- restore (plan 2026-07-20-drift-restore-tranche.md §2.3, R9) ---

// restoreEligibleVerdict returns a Verdict that is, by its fields alone,
// restore-eligible per driftpropose.ClassifyByFields — the baseline every
// restore gate test below mutates.
func restoreEligibleVerdict(addr string) driftpropose.Verdict {
	return driftpropose.Verdict{
		Address: addr, Type: "aws_flow_log", Actions: []string{"create"},
		DriftEvidence: true, Class: "oob_deletion", RiskTier: "high",
	}
}

// mustRestoreParams builds a driftpropose.RestoreParams whose ProposalDigest
// is CORRECTLY derived from verdicts (via addressesFromVerdicts +
// driftpropose.ProposalDigest("restore", ...)) — the happy-path shape every
// test below starts from; TestGateRestoreDigestMismatchRefuses deliberately
// overrides it afterward.
func mustRestoreParams(verdicts ...driftpropose.Verdict) driftpropose.RestoreParams {
	addrs := addressesFromVerdicts(verdicts)
	return driftpropose.RestoreParams{
		Verdicts:       verdicts,
		ProposalDigest: driftpropose.ProposalDigest("restore", addrs, nil),
	}
}

// TestGateRestoreGreen is RunDriftGate's restore happy path: a genuinely
// restore-eligible pinned verdict, a correct digest, and a plan showing the
// pinned address as a pure create clears both the eligibility recheck and R9.
func TestGateRestoreGreen(t *testing.T) {
	params := mustMarshal(t, mustRestoreParams(restoreEligibleVerdict("aws_flow_log.vpc1")))
	plan := planOf(sgChange("aws_flow_log.vpc1", []string{"create"}, nil, map[string]any{"traffic_type": "ALL"}))
	violations, info, err := RunDriftGate(OpDriftRestore, oneItem(OpDriftRestore, params), plan)
	if err != nil {
		t.Fatalf("RunDriftGate: %v", err)
	}
	if len(violations) != 0 {
		t.Fatalf("violations = %v, want none", violations)
	}
	if len(info) == 0 || !strings.Contains(info[0], "restore-scoped-create") {
		t.Fatalf("info = %v, want a restore-scoped-create INFO confirmation", info)
	}
}

// TestGateRestoreGreenNoOp is the R8-converged-precedent sibling: the pinned
// address already shows no-op (restored out-of-band since the snapshot) —
// still clean.
func TestGateRestoreGreenNoOp(t *testing.T) {
	params := mustMarshal(t, mustRestoreParams(restoreEligibleVerdict("aws_flow_log.vpc1")))
	plan := planOf(sgChange("aws_flow_log.vpc1", []string{"no-op"}, nil, nil))
	violations, info, err := RunDriftGate(OpDriftRestore, oneItem(OpDriftRestore, params), plan)
	if err != nil {
		t.Fatalf("RunDriftGate: %v", err)
	}
	if len(violations) != 0 {
		t.Fatalf("violations = %v, want none", violations)
	}
	if len(info) == 0 {
		t.Fatal("want an INFO line confirming the clean gate")
	}
}

// TestGateRestoreRefusesEligibilityFailure pins enforcement point 3 for
// restore: a pinned verdict that is NOT restore-eligible (wrong actions) must
// refuse — BEFORE R9 ever looks at the plan (a garbage/empty Plan{} is passed
// deliberately, mirroring TestGateRefusesSecurityAdopt/TestGateImportRefusesEligibilityFailure).
func TestGateRestoreRefusesEligibilityFailure(t *testing.T) {
	v := restoreEligibleVerdict("aws_flow_log.vpc1")
	v.Actions = []string{"update"} // no longer a pure create
	params := mustMarshal(t, mustRestoreParams(v))
	violations, info, err := RunDriftGate(OpDriftRestore, oneItem(OpDriftRestore, params), Plan{})
	if err != nil {
		t.Fatalf("RunDriftGate returned an error, want a clean refusal: %v", err)
	}
	if len(info) != 0 {
		t.Fatalf("info = %v, want none — a refused gate must not also claim success", info)
	}
	if len(violations) == 0 {
		t.Fatal("gate accepted a pinned verdict that is not restore-eligible — enforcement point 3 did not fire")
	}
	for _, vi := range violations {
		if vi.Rule != "drift-restore-eligibility" {
			t.Errorf("rule = %q, want drift-restore-eligibility", vi.Rule)
		}
		if vi.Address != v.Address {
			t.Errorf("address = %q, want %q", vi.Address, v.Address)
		}
	}
}

// TestGateRestoreDigestMismatchRefuses pins §2.3's restore-digest rule —
// tamper evidence unique to restore among the drift ops (restore's
// drift-edit leg carries no digest check of its own, spec §2.4, so the gate
// carries it here instead).
func TestGateRestoreDigestMismatchRefuses(t *testing.T) {
	p := mustRestoreParams(restoreEligibleVerdict("aws_flow_log.vpc1"))
	p.ProposalDigest = "0000000000000000000000000000000000000000000000000000000000000000" // wrong, on purpose
	params := mustMarshal(t, p)
	violations, info, err := RunDriftGate(OpDriftRestore, oneItem(OpDriftRestore, params), Plan{})
	if err != nil {
		t.Fatalf("RunDriftGate returned an error, want a clean refusal: %v", err)
	}
	if len(info) != 0 {
		t.Fatalf("info = %v, want none — a refused gate must not also claim success", info)
	}
	if len(violations) == 0 {
		t.Fatal("gate accepted a pinned request whose digest does not match its own verdicts")
	}
	for _, vi := range violations {
		if vi.Rule != "restore-digest" {
			t.Errorf("rule = %q, want restore-digest", vi.Rule)
		}
		if !strings.Contains(vi.Reason, "tamper evidence") {
			t.Errorf("reason = %q, want it to name tamper evidence", vi.Reason)
		}
	}
}

// TestGateRestoreResidualDiffViolates proves eligibility (and a correct
// digest) passing does not paper over a dirty plan: R9 still runs (and still
// blocks) once the pinned verdict itself clears enforcement point 3.
func TestGateRestoreResidualDiffViolates(t *testing.T) {
	params := mustMarshal(t, mustRestoreParams(restoreEligibleVerdict("aws_flow_log.vpc1")))
	plan := planOf(sgChange("aws_flow_log.vpc1", []string{"update"},
		map[string]any{"traffic_type": "REJECT"}, map[string]any{"traffic_type": "ALL"}))
	violations, _, err := RunDriftGate(OpDriftRestore, oneItem(OpDriftRestore, params), plan)
	if err != nil {
		t.Fatalf("RunDriftGate: %v", err)
	}
	if len(violations) == 0 {
		t.Fatal("want a violation: the plan shows an update, not a pure create")
	}
	if violations[0].Rule != "restore-scoped-create" {
		t.Errorf("rule = %q, want restore-scoped-create", violations[0].Rule)
	}
}

// TestRunDriftGateBatchedRestoreSet pins plan §2.5's "restore batches
// restore-only via alsoDigests": a batched restore change-set gates EVERY
// item, mirroring TestRunDriftGateBatchedAdoptSet/TestRunDriftGateBatchedImportSet.
func TestRunDriftGateBatchedRestoreSet(t *testing.T) {
	v1 := restoreEligibleVerdict("aws_flow_log.vpc1")
	v2 := restoreEligibleVerdict("aws_flow_log.vpc2")
	items := []driftpropose.BundleRequestItem{
		{OperationID: OpDriftRestore, Params: mustMarshal(t, mustRestoreParams(v1))},
		{OperationID: OpDriftRestore, Params: mustMarshal(t, mustRestoreParams(v2))},
	}
	plan := planOf(
		sgChange("aws_flow_log.vpc1", []string{"create"}, nil, map[string]any{"traffic_type": "ALL"}),
		sgChange("aws_flow_log.vpc2", []string{"create"}, nil, map[string]any{"traffic_type": "ALL"}),
	)
	violations, info, err := RunDriftGate(OpDriftRestore, items, plan)
	if err != nil {
		t.Fatalf("RunDriftGate: %v", err)
	}
	if len(violations) != 0 {
		t.Fatalf("violations = %v, want none", violations)
	}
	if len(info) == 0 || !strings.Contains(info[0], "2") {
		t.Fatalf("info = %v, want it to name both pinned addresses gated", info)
	}
}

// TestRunDriftGateBatchedRestoreSetOneBadItemRefusesWhole proves a batch is
// gated as a whole: if ONLY the second item's verdict fails eligibility, the
// WHOLE gate still refuses.
func TestRunDriftGateBatchedRestoreSetOneBadItemRefusesWhole(t *testing.T) {
	v1 := restoreEligibleVerdict("aws_flow_log.vpc1")
	v2 := restoreEligibleVerdict("aws_flow_log.vpc2")
	v2.DriftEvidence = false // no longer restore-eligible
	items := []driftpropose.BundleRequestItem{
		{OperationID: OpDriftRestore, Params: mustMarshal(t, mustRestoreParams(v1))},
		{OperationID: OpDriftRestore, Params: mustMarshal(t, mustRestoreParams(v2))},
	}
	violations, _, err := RunDriftGate(OpDriftRestore, items, Plan{})
	if err != nil {
		t.Fatalf("RunDriftGate: %v", err)
	}
	if len(violations) == 0 {
		t.Fatal("a batched item's ineligible verdict did not refuse the whole gate")
	}
	found := false
	for _, v := range violations {
		if v.Address == "aws_flow_log.vpc2" {
			found = true
		}
	}
	if !found {
		t.Fatalf("violations = %v, want one naming aws_flow_log.vpc2", violations)
	}
}

// TestGateRestoreMalformedParamsRefuses mirrors TestGateMalformedParamsRefuses
// for the restore op: unparseable JSON, zero verdicts, and zero items all
// refuse with an error, never silently pass.
func TestGateRestoreMalformedParamsRefuses(t *testing.T) {
	if _, _, err := RunDriftGate(OpDriftRestore, oneItem(OpDriftRestore, jsonRaw(`{not json`)), Plan{}); err == nil {
		t.Fatal("want an error for malformed JSON params")
	}
	if _, _, err := RunDriftGate(OpDriftRestore, oneItem(OpDriftRestore, jsonRaw(`{"verdicts":[]}`)), Plan{}); err == nil {
		t.Fatal("want an error for zero pinned verdicts")
	}
	if _, _, err := RunDriftGate(OpDriftRestore, nil, Plan{}); err == nil {
		t.Fatal("want an error for zero items")
	}
}

// TestIsDriftOpRecognizesRestore pins plan 2026-07-20-drift-restore-tranche.md
// §2.3's "fifth known drift op" — OpDriftRestore must be gate-known and share
// the system-drift- naming spec §4.4 requires, exactly like
// TestIsDriftOpRecognizesImport pins the third.
func TestIsDriftOpRecognizesRestore(t *testing.T) {
	if !isDriftOp(OpDriftRestore) {
		t.Fatal("isDriftOp(OpDriftRestore) = false, want true")
	}
	if !strings.HasPrefix(OpDriftRestore, "system-drift-") {
		t.Fatal("OpDriftRestore drifted from the system-drift- naming spec §4.4 pins")
	}
	if OpDriftRestore != "system-drift-restore" {
		t.Fatalf("OpDriftRestore = %q, want %q", OpDriftRestore, "system-drift-restore")
	}
}

// --- legitimize (plan 2026-07-20-drift-restore-tranche.md §4, register 0009 L32, R11) ---

// legitimizeEligibleVerdict returns a Verdict that is, by its fields alone,
// legitimize-eligible (IsSecurityPosture true) — the baseline every
// legitimize gate test below mutates.
func legitimizeEligibleVerdict(addr string) driftpropose.Verdict {
	return driftpropose.Verdict{
		Address: addr, Type: "aws_security_group", Actions: []string{"update"},
		DriftEvidence: true, Class: "security_posture", RiskTier: "high",
	}
}

// TestGateLegitimizeGreen is RunDriftGate's legitimize happy path: a
// genuinely security-posture pinned verdict plus a whole-plan no-op clears
// both the eligibility recheck and R11.
func TestGateLegitimizeGreen(t *testing.T) {
	params := mustMarshal(t, driftpropose.LegitimizeParams{Verdicts: []driftpropose.Verdict{legitimizeEligibleVerdict("aws_security_group.sg1")}})
	plan := planOf(sgChange("aws_security_group.sg1", []string{"no-op"}, nil, nil))
	violations, info, err := RunDriftGate(OpDriftLegitimize, oneItem(OpDriftLegitimize, params), plan)
	if err != nil {
		t.Fatalf("RunDriftGate: %v", err)
	}
	if len(violations) != 0 {
		t.Fatalf("violations = %v, want none", violations)
	}
	if len(info) == 0 || !strings.Contains(info[0], "legitimize-zero-delta") {
		t.Fatalf("info = %v, want a legitimize-zero-delta INFO confirmation", info)
	}
}

// TestGateLegitimizeRefusesNonSecurityVerdict pins enforcement point 3 for
// legitimize: a pinned verdict that is NOT security-posture (mirrors the
// route's own step-7 check, deliberately NOT the full adopt/revert/restore
// partition) must refuse — BEFORE R11 ever looks at the plan.
func TestGateLegitimizeRefusesNonSecurityVerdict(t *testing.T) {
	v := driftpropose.Verdict{
		Address: "aws_instance.sample01", Type: "aws_instance", Actions: []string{"update"},
		DriftEvidence: true, Class: "benign_inplace", RiskTier: "low",
	}
	params := mustMarshal(t, driftpropose.LegitimizeParams{Verdicts: []driftpropose.Verdict{v}})
	violations, info, err := RunDriftGate(OpDriftLegitimize, oneItem(OpDriftLegitimize, params), Plan{})
	if err != nil {
		t.Fatalf("RunDriftGate returned an error, want a clean refusal: %v", err)
	}
	if len(info) != 0 {
		t.Fatalf("info = %v, want none — a refused gate must not also claim success", info)
	}
	if len(violations) == 0 {
		t.Fatal("gate accepted a pinned verdict that is not security-posture — enforcement point 3 did not fire")
	}
	for _, vi := range violations {
		if vi.Rule != "drift-legitimize-eligibility" {
			t.Errorf("rule = %q, want drift-legitimize-eligibility", vi.Rule)
		}
		if vi.Address != v.Address {
			t.Errorf("address = %q, want %q", vi.Address, v.Address)
		}
	}
}

// TestGateLegitimizeResidualDiffViolates proves eligibility passing does not
// paper over a dirty plan: R11 still runs (and still blocks) once the pinned
// verdict itself clears enforcement point 3 — the linked convergence PR has
// not merged yet (or live moved again).
func TestGateLegitimizeResidualDiffViolates(t *testing.T) {
	params := mustMarshal(t, driftpropose.LegitimizeParams{Verdicts: []driftpropose.Verdict{legitimizeEligibleVerdict("aws_security_group.sg1")}})
	plan := planOf(sgChange("aws_security_group.sg1", []string{"update"},
		map[string]any{"ingress": []any{map[string]any{"cidr_blocks": []any{"0.0.0.0/0"}}}},
		map[string]any{"ingress": []any{map[string]any{"cidr_blocks": []any{"10.0.0.0/16"}}}}))
	violations, _, err := RunDriftGate(OpDriftLegitimize, oneItem(OpDriftLegitimize, params), plan)
	if err != nil {
		t.Fatalf("RunDriftGate: %v", err)
	}
	if len(violations) == 0 {
		t.Fatal("want a violation: the plan is not yet a clean no-op")
	}
	if violations[0].Rule != "legitimize-zero-delta" {
		t.Errorf("rule = %q, want legitimize-zero-delta", violations[0].Rule)
	}
}

// TestRunDriftGateLegitimizeRefusesMultipleItems mirrors
// TestRunDriftGateRevertRefusesMultipleItems: "legitimize only ever submits
// alone" — the api route never batches it.
func TestRunDriftGateLegitimizeRefusesMultipleItems(t *testing.T) {
	params := mustMarshal(t, driftpropose.LegitimizeParams{Verdicts: []driftpropose.Verdict{legitimizeEligibleVerdict("aws_security_group.sg1")}})
	items := []driftpropose.BundleRequestItem{
		{OperationID: OpDriftLegitimize, Params: params},
		{OperationID: OpDriftLegitimize, Params: params},
	}
	if _, _, err := RunDriftGate(OpDriftLegitimize, items, Plan{}); err == nil {
		t.Fatal("want an error: legitimize must never gate more than one item")
	}
}

// TestGateLegitimizeMalformedParamsRefuses mirrors
// TestGateMalformedParamsRefuses for the legitimize op: unparseable JSON,
// zero verdicts, and zero items all refuse with an error, never silently
// pass.
func TestGateLegitimizeMalformedParamsRefuses(t *testing.T) {
	if _, _, err := RunDriftGate(OpDriftLegitimize, oneItem(OpDriftLegitimize, jsonRaw(`{not json`)), Plan{}); err == nil {
		t.Fatal("want an error for malformed JSON params")
	}
	if _, _, err := RunDriftGate(OpDriftLegitimize, oneItem(OpDriftLegitimize, jsonRaw(`{"verdicts":[]}`)), Plan{}); err == nil {
		t.Fatal("want an error for zero pinned verdicts")
	}
	if _, _, err := RunDriftGate(OpDriftLegitimize, nil, Plan{}); err == nil {
		t.Fatal("want an error for zero items")
	}
}

// TestIsDriftOpRecognizesLegitimize pins register 0009 L32's gate teaching —
// OpDriftLegitimize must now be gate-known and share the system-drift-
// naming spec §4.4 requires.
func TestIsDriftOpRecognizesLegitimize(t *testing.T) {
	if !isDriftOp(OpDriftLegitimize) {
		t.Fatal("isDriftOp(OpDriftLegitimize) = false, want true (register 0009 L32)")
	}
	if !strings.HasPrefix(OpDriftLegitimize, "system-drift-") {
		t.Fatal("OpDriftLegitimize drifted from the system-drift- naming spec §4.4 pins")
	}
	if OpDriftLegitimize != "system-drift-legitimize" {
		t.Fatalf("OpDriftLegitimize = %q, want %q", OpDriftLegitimize, "system-drift-legitimize")
	}
}

func jsonRaw(s string) json.RawMessage { return json.RawMessage(s) }

func TestCountAddresses(t *testing.T) {
	got := countAddresses([]driftpropose.Attr{
		{Address: "a", Path: "p1"},
		{Address: "a", Path: "p2"},
		{Address: "b", Path: "p1"},
	})
	if got != 2 {
		t.Errorf("countAddresses = %d, want 2", got)
	}
}

// isDriftOp / OpDriftAdopt / OpDriftRevert sanity — trivial, but pins the two exact
// string constants spec §4.4 requires (a typo here would silently stop the gate from
// ever routing a real drift request).
func TestIsDriftOp(t *testing.T) {
	cases := map[string]bool{
		"system-drift-adopt":      true,
		"system-drift-revert":     true,
		"system-drift-import":     true,
		"system-drift-restore":    true,
		"system-drift-legitimize": true, // register 0009 L32: gate-known as of this tranche (was false pre-L32)
		"ec2-resize":              false,
		"":                        false,
	}
	for id, want := range cases {
		if got := isDriftOp(id); got != want {
			t.Errorf("isDriftOp(%q) = %v, want %v", id, got, want)
		}
	}
	if !strings.HasPrefix(OpDriftAdopt, "system-drift-") || !strings.HasPrefix(OpDriftRevert, "system-drift-") {
		t.Fatal("drift op constants drifted from the system-drift- naming spec §4.4 pins")
	}
}
