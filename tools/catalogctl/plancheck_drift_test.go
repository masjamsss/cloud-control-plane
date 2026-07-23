package main_test

import (
	"bytes"
	"path/filepath"
	"strings"
	"testing"

	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/cli"
	_ "github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/plancheck" // installs cli.PlanCheck
)

// TestR7Green .. TestR8ScopeViolation drive the REAL `plan-check` entrypoint
// (cli.Run, exactly what scripts/ci/plancheck-gate.sh and an operator's
// CCP_BUNDLE_GATE_CMD invoke) against testdata/driftgate/* fixtures — proving
// spec docs/superpowers/specs/2026-07-20-ccp-drift-portal.md §7's R7/R8 through
// the actual gate path (driftgate.go's peekDriftOp+RunDriftGate dispatch inside
// command.go), not just the underlying Check functions in isolation.
//
// These fixtures deliberately live under testdata/driftgate/, a sibling of
// testdata/plans/ rather than a member of it: plancheck_test.go's TestPlanCheck
// globs testdata/plans/* and feeds every entry through the ordinary
// ccp.request/v1 YAML + ServiceManifest path — a bundle-request.json fixture
// dropped in there would break that unrelated, existing test. --manifests is
// deliberately omitted from every case below: the drift gate path never reaches
// manifests.LoadDir (command.go routes on the JSON operationId peek before that
// call), so leaving it unset also proves the short-circuit is real.
func runDriftGateFixture(t *testing.T, fixture string) (int, string) {
	t.Helper()
	dir := filepath.Join("testdata", "driftgate", fixture)
	var out, errb bytes.Buffer
	code := cli.Run([]string{
		"plan-check",
		"--plan", filepath.Join(dir, "plan.json"),
		"--request", filepath.Join(dir, "bundle-request.json"),
	}, &out, &errb)
	return code, out.String() + errb.String()
}

// TestR7Green: "adopt-clean" — the adopted address plans no-op; the pinned verdict
// is adopt-eligible. R7 must pass clean.
func TestR7Green(t *testing.T) {
	code, out := runDriftGateFixture(t, "adopt-clean")
	if code != 0 {
		t.Fatalf("exit = %d, want 0\n%s", code, out)
	}
	if !strings.Contains(out, "adopt-zero-delta") {
		t.Fatalf("output missing the adopt-zero-delta INFO confirmation\n%s", out)
	}
}

// TestR7ResidualDiffViolation: "adopt-residual" (live moved again) — the adopted
// address still plans an update after the edit. R7 must VIOLATION — the freshness
// proof spec §7 describes.
func TestR7ResidualDiffViolation(t *testing.T) {
	code, out := runDriftGateFixture(t, "adopt-residual")
	if code != 2 {
		t.Fatalf("exit = %d, want 2\n%s", code, out)
	}
	if !strings.Contains(out, "VIOLATION adopt-zero-delta") {
		t.Fatalf("output missing a VIOLATION adopt-zero-delta line\n%s", out)
	}
}

// TestR8Green: "revert-clean" — the target plans a pure update confined to the one
// pinned drifted path. R8 must pass clean.
func TestR8Green(t *testing.T) {
	code, out := runDriftGateFixture(t, "revert-clean")
	if code != 0 {
		t.Fatalf("exit = %d, want 0\n%s", code, out)
	}
	if !strings.Contains(out, "revert-in-place") {
		t.Fatalf("output missing the revert-in-place INFO confirmation\n%s", out)
	}
}

// TestR8ConvergedNoopGreen: "revert-already-converged" — the target already matches
// code (no-op) since the drift snapshot. Spec §7: legal, the apply is then vacuous.
func TestR8ConvergedNoopGreen(t *testing.T) {
	code, out := runDriftGateFixture(t, "revert-already-converged")
	if code != 0 {
		t.Fatalf("exit = %d, want 0\n%s", code, out)
	}
}

// TestR8ReplaceViolation: "revert-replace-action" — the target plans a
// destroy+recreate instead of an in-place update. Spec §7: "any replace/delete/
// create on a target ⇒ VIOLATION (the replacement asymmetry can never sneak in at
// apply time)".
func TestR8ReplaceViolation(t *testing.T) {
	code, out := runDriftGateFixture(t, "revert-replace-action")
	if code != 2 {
		t.Fatalf("exit = %d, want 2\n%s", code, out)
	}
	if !strings.Contains(out, "VIOLATION revert-in-place") {
		t.Fatalf("output missing a VIOLATION revert-in-place line\n%s", out)
	}
}

// TestR8ScopeViolation: "revert-out-of-scope-address" — an address OUTSIDE the
// pinned revert targets also shows a real change. Spec §7: "any address outside the
// pinned targets appearing in the plan ⇒ VIOLATION" — the rule that makes "scoped to
// the drifted addresses" real without `-target`.
func TestR8ScopeViolation(t *testing.T) {
	code, out := runDriftGateFixture(t, "revert-out-of-scope-address")
	if code != 2 {
		t.Fatalf("exit = %d, want 2\n%s", code, out)
	}
	if !strings.Contains(out, "VIOLATION revert-scope") {
		t.Fatalf("output missing a VIOLATION revert-scope line\n%s", out)
	}
	if !strings.Contains(out, "aws_instance.other01") {
		t.Fatalf("output does not name the out-of-scope address\n%s", out)
	}
}

// TestR10Green: "import-clean" — the pinned address plans exactly
// change.importing set with actions ["no-op"]. R10 must pass clean.
func TestR10Green(t *testing.T) {
	code, out := runDriftGateFixture(t, "import-clean")
	if code != 0 {
		t.Fatalf("exit = %d, want 0\n%s", code, out)
	}
	if !strings.Contains(out, "import-exact") {
		t.Fatalf("output missing the import-exact INFO confirmation\n%s", out)
	}
}

// TestR10ResidualViolation: "import-residual" (live moved, or generation
// drifted, since the snapshot) — the pinned address still plans an update
// alongside change.importing. R10 must VIOLATION with the regenerate reason.
func TestR10ResidualViolation(t *testing.T) {
	code, out := runDriftGateFixture(t, "import-residual")
	if code != 2 {
		t.Fatalf("exit = %d, want 2\n%s", code, out)
	}
	if !strings.Contains(out, "VIOLATION import-exact") {
		t.Fatalf("output missing a VIOLATION import-exact line\n%s", out)
	}
	if !strings.Contains(out, "regenerate") {
		t.Fatalf("output missing the 'regenerate' reason\n%s", out)
	}
}

// TestR10ScopeViolation: "import-scope" — the pinned address is clean, but a
// SECOND, non-pinned address also shows change.importing set. Spec §7.2:
// "Any NON-pinned address with change.importing ⇒ VIOLATION (scope —
// nothing imports that was not approved)."
func TestR10ScopeViolation(t *testing.T) {
	code, out := runDriftGateFixture(t, "import-scope")
	if code != 2 {
		t.Fatalf("exit = %d, want 2\n%s", code, out)
	}
	if !strings.Contains(out, "VIOLATION import-scope") {
		t.Fatalf("output missing a VIOLATION import-scope line\n%s", out)
	}
	if !strings.Contains(out, "aws_instance.other01") {
		t.Fatalf("output does not name the unapproved importing address\n%s", out)
	}
}

// TestR10AbsentViolation: "import-absent" — the plan carries no
// change.importing entry for the pinned address at all (resource deleted
// since detection, or the import id was rejected). R10 must VIOLATION.
func TestR10AbsentViolation(t *testing.T) {
	code, out := runDriftGateFixture(t, "import-absent")
	if code != 2 {
		t.Fatalf("exit = %d, want 2\n%s", code, out)
	}
	if !strings.Contains(out, "VIOLATION import-exact") {
		t.Fatalf("output missing a VIOLATION import-exact line\n%s", out)
	}
	if !strings.Contains(out, "did not register") {
		t.Fatalf("output missing the 'did not register' reason\n%s", out)
	}
	if !strings.Contains(out, "aws_instance.oob_bastion01") {
		t.Fatalf("output does not name the absent pinned address\n%s", out)
	}
}

// TestDriftGateFallsThroughForOrdinaryRequests is a regression guard for the
// peekDriftOp short-circuit added to command.go: an ordinary, non-drift plan-check
// fixture (from the pre-existing testdata/plans suite) must behave EXACTLY as before
// — this drives the same r1-pass-single-change fixture TestPlancheckGateScript uses,
// through cli.Run directly, with the two drift env vars nowhere in sight.
func TestDriftGateFallsThroughForOrdinaryRequests(t *testing.T) {
	var out, errb bytes.Buffer
	code := cli.Run([]string{
		"plan-check",
		"--plan", filepath.Join("testdata", "plans", "r1-pass-single-change", "plan.json"),
		"--request", filepath.Join("testdata", "plans", "r1-pass-single-change", "request.yaml"),
		"--manifests", "testdata/manifests",
	}, &out, &errb)
	if code != 0 {
		t.Fatalf("exit = %d, want 0\n--- stdout ---\n%s--- stderr ---\n%s", code, out.String(), errb.String())
	}
}
