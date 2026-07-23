package main_test

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/cli"
	_ "github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/driftpropose" // installs cli.DriftEdit + cli.DriftPropose
	_ "github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/plancheck"    // installs cli.PlanCheck
)

// driftedit_seam_test.go is spec 2026-07-20-drift-audit-fixes.md §2-F1(d)'s
// cross-layer proof, Go half: "the Go test drives the same fixture through
// ParseBundleRequest → drift-edit (fixture checkout) → canned plan →
// RunDriftGate to green (and a tampered twin to red)." Unlike
// plancheck_drift_test.go's testdata/driftgate/* fixtures (R7/R8-only, FROZEN
// — plan-check invoked directly against an ALREADY-edited checkout), this
// drives the REAL two-command operator sequence spec §7 documents:
//
//	catalogctl drift-edit --request … && terraform plan … && catalogctl plan-check --plan … --request …
//
// (minus the actual `terraform plan` — a canned plan.json fixture stands in
// for it, exactly as testdata/driftgate/* already does) — proving drift-edit's
// write and plan-check's verify are the SAME contract end to end, so the F1
// failure mode (two suites testing two different shapes) cannot recur here
// either.

// copyDir is a small, scoped directory copier — this package's own sibling of
// driftpropose's unexported copyCheckoutFixture (re-implemented, not
// imported: an internal test helper has no business being exported just to
// cross a package boundary for one root-level test file).
func copyDir(t *testing.T, src string) string {
	t.Helper()
	dst := t.TempDir()
	err := filepath.WalkDir(src, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}
		target := filepath.Join(dst, rel)
		if d.IsDir() {
			if rel == "." {
				return nil
			}
			return os.MkdirAll(target, 0o755)
		}
		b, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		return os.WriteFile(target, b, 0o644)
	})
	if err != nil {
		t.Fatalf("copy checkout fixture: %v", err)
	}
	return dst
}

func runCLI(args []string) (int, string) {
	var out, errb bytes.Buffer
	code := cli.Run(args, &out, &errb)
	return code, out.String() + errb.String()
}

// TestDriftEditThenPlanCheckAdoptGreen drives the seam's single-item happy
// path end to end: drift-edit actually edits the checkout, and a canned
// post-edit plan (no-op) clears R7 through the real gate dispatch
// (peekDriftOp -> RunDriftGate), not just the underlying Check functions.
func TestDriftEditThenPlanCheckAdoptGreen(t *testing.T) {
	checkout := copyDir(t, filepath.Join("testdata", "driftpropose", "checkout"))
	reqPath := filepath.Join("testdata", "driftpropose", "seam", "bundle-request-adopt.json")

	code, out := runCLI([]string{"drift-edit", "--request", reqPath, "--repo", checkout, "--root", "environments/prod"})
	if code != 0 {
		t.Fatalf("drift-edit exit = %d, want 0\n%s", code, out)
	}
	got, err := os.ReadFile(filepath.Join(checkout, "environments/prod/main.tf"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(got), `Owner = "bi-team"`) {
		t.Fatalf("drift-edit did not write the adopted value:\n%s", got)
	}

	planPath := filepath.Join("testdata", "driftpropose", "seam", "plan-adopt-clean.json")
	code, out = runCLI([]string{"plan-check", "--plan", planPath, "--request", reqPath})
	if code != 0 {
		t.Fatalf("plan-check exit = %d, want 0\n%s", code, out)
	}
	if !strings.Contains(out, "adopt-zero-delta") {
		t.Fatalf("plan-check output missing the adopt-zero-delta INFO confirmation\n%s", out)
	}
}

// TestDriftEditThenPlanCheckAdoptSetGreen is the same seam proof for a
// BATCHED change-set (spec addendum A2/F1(b)'s core fix): both items must be
// edited by drift-edit and both gated by plan-check's RunDriftGate, not only
// the primary/first one.
func TestDriftEditThenPlanCheckAdoptSetGreen(t *testing.T) {
	checkout := copyDir(t, filepath.Join("testdata", "driftpropose", "checkout"))
	reqPath := filepath.Join("testdata", "driftpropose", "seam", "bundle-request-adopt-set.json")

	code, out := runCLI([]string{"drift-edit", "--request", reqPath, "--repo", checkout, "--root", "environments/prod"})
	if code != 0 {
		t.Fatalf("drift-edit exit = %d, want 0\n%s", code, out)
	}
	main, err := os.ReadFile(filepath.Join(checkout, "environments/prod/main.tf"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(main), `Owner = "bi-team"`) {
		t.Fatalf("drift-edit did not write item 0's adopted value:\n%s", main)
	}
	dotted, err := os.ReadFile(filepath.Join(checkout, "environments/prod/extra-dotted-key.tf"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(dotted), `"kubernetes.io/role/elb" = "owned"`) {
		t.Fatalf("drift-edit did not write item 1's adopted value:\n%s", dotted)
	}

	planPath := filepath.Join("testdata", "driftpropose", "seam", "plan-adopt-set-clean.json")
	code, out = runCLI([]string{"plan-check", "--plan", planPath, "--request", reqPath})
	if code != 0 {
		t.Fatalf("plan-check exit = %d, want 0\n%s", code, out)
	}
	if !strings.Contains(out, "2 item") {
		t.Fatalf("plan-check output does not confirm both items were gated\n%s", out)
	}
}

// TestDriftEditThenPlanCheckRevertGreen proves the revert half of the seam:
// drift-edit performs NO edit (spec §6.4) and plan-check's R8 confirms the
// canned plan is confined to the pinned drifted path.
func TestDriftEditThenPlanCheckRevertGreen(t *testing.T) {
	checkout := copyDir(t, filepath.Join("testdata", "driftpropose", "checkout"))
	reqPath := filepath.Join("testdata", "driftpropose", "seam", "bundle-request-revert.json")

	before, err := os.ReadFile(filepath.Join(checkout, "environments/prod/main.tf"))
	if err != nil {
		t.Fatal(err)
	}
	code, out := runCLI([]string{"drift-edit", "--request", reqPath, "--repo", checkout, "--root", "environments/prod"})
	if code != 0 {
		t.Fatalf("drift-edit exit = %d, want 0\n%s", code, out)
	}
	after, err := os.ReadFile(filepath.Join(checkout, "environments/prod/main.tf"))
	if err != nil {
		t.Fatal(err)
	}
	if string(before) != string(after) {
		t.Fatal("drift-edit wrote to the checkout for a revert item")
	}

	planPath := filepath.Join("testdata", "driftpropose", "seam", "plan-revert-clean.json")
	code, out = runCLI([]string{"plan-check", "--plan", planPath, "--request", reqPath})
	if code != 0 {
		t.Fatalf("plan-check exit = %d, want 0\n%s", code, out)
	}
	if !strings.Contains(out, "revert-in-place") {
		t.Fatalf("plan-check output missing the revert-in-place INFO confirmation\n%s", out)
	}
}

// TestDriftEditThenPlanCheckRestoreGreen proves the restore half of the seam
// (plan 2026-07-20-drift-restore-tranche.md §2.3/§2.4): drift-edit performs
// NO edit and plan-check's R9 confirms the canned plan shows exactly the
// pinned address as a pure create, 0 add / 0 change / 0 destroy beyond it.
func TestDriftEditThenPlanCheckRestoreGreen(t *testing.T) {
	checkout := copyDir(t, filepath.Join("testdata", "driftpropose", "checkout"))
	reqPath := filepath.Join("testdata", "driftpropose", "seam", "bundle-request-restore.json")

	before, err := os.ReadFile(filepath.Join(checkout, "environments/prod/main.tf"))
	if err != nil {
		t.Fatal(err)
	}
	code, out := runCLI([]string{"drift-edit", "--request", reqPath, "--repo", checkout, "--root", "environments/prod"})
	if code != 0 {
		t.Fatalf("drift-edit exit = %d, want 0\n%s", code, out)
	}
	after, err := os.ReadFile(filepath.Join(checkout, "environments/prod/main.tf"))
	if err != nil {
		t.Fatal(err)
	}
	if string(before) != string(after) {
		t.Fatal("drift-edit wrote to the checkout for a restore item")
	}

	planPath := filepath.Join("testdata", "driftpropose", "seam", "plan-restore-clean.json")
	code, out = runCLI([]string{"plan-check", "--plan", planPath, "--request", reqPath})
	if code != 0 {
		t.Fatalf("plan-check exit = %d, want 0\n%s", code, out)
	}
	if !strings.Contains(out, "restore-scoped-create") {
		t.Fatalf("plan-check output missing the restore-scoped-create INFO confirmation\n%s", out)
	}
}

// TestDriftEditThenPlanCheckLegitimizeGreen proves the legitimize half of the
// seam (plan 2026-07-20-drift-restore-tranche.md §4, register 0009 L32):
// drift-edit performs NO edit and plan-check's R11 confirms the canned plan
// is already a clean whole-plan no-op — the closure step running after the
// engineer's linked PR landed.
func TestDriftEditThenPlanCheckLegitimizeGreen(t *testing.T) {
	checkout := copyDir(t, filepath.Join("testdata", "driftpropose", "checkout"))
	reqPath := filepath.Join("testdata", "driftpropose", "seam", "bundle-request-legitimize.json")

	before, err := os.ReadFile(filepath.Join(checkout, "environments/prod/main.tf"))
	if err != nil {
		t.Fatal(err)
	}
	code, out := runCLI([]string{"drift-edit", "--request", reqPath, "--repo", checkout, "--root", "environments/prod"})
	if code != 0 {
		t.Fatalf("drift-edit exit = %d, want 0\n%s", code, out)
	}
	after, err := os.ReadFile(filepath.Join(checkout, "environments/prod/main.tf"))
	if err != nil {
		t.Fatal(err)
	}
	if string(before) != string(after) {
		t.Fatal("drift-edit wrote to the checkout for a legitimize item")
	}

	planPath := filepath.Join("testdata", "driftpropose", "seam", "plan-legitimize-clean.json")
	code, out = runCLI([]string{"plan-check", "--plan", planPath, "--request", reqPath})
	if code != 0 {
		t.Fatalf("plan-check exit = %d, want 0\n%s", code, out)
	}
	if !strings.Contains(out, "legitimize-zero-delta") {
		t.Fatalf("plan-check output missing the legitimize-zero-delta INFO confirmation\n%s", out)
	}
}

// TestDriftEditThenPlanCheckTamperedRed is the seam's "tampered twin to red"
// half (spec §2-F1d): a pinned request whose attrs were altered after its own
// proposalDigest was computed is refused at drift-edit — the FIRST stage of
// the operator's `drift-edit && terraform plan && plan-check` chain — so the
// chain never even reaches plan-check, and the checkout is never touched.
func TestDriftEditThenPlanCheckTamperedRed(t *testing.T) {
	checkout := copyDir(t, filepath.Join("testdata", "driftpropose", "checkout"))
	reqPath := filepath.Join("testdata", "driftpropose", "seam", "bundle-request-adopt-tampered.json")

	before, err := os.ReadFile(filepath.Join(checkout, "environments/prod/main.tf"))
	if err != nil {
		t.Fatal(err)
	}
	code, out := runCLI([]string{"drift-edit", "--request", reqPath, "--repo", checkout, "--root", "environments/prod"})
	if code != 2 {
		t.Fatalf("drift-edit exit = %d, want 2 (tamper evidence)\n%s", code, out)
	}
	if !strings.Contains(out, "digest mismatch") {
		t.Fatalf("drift-edit output does not name the digest mismatch\n%s", out)
	}
	after, err := os.ReadFile(filepath.Join(checkout, "environments/prod/main.tf"))
	if err != nil {
		t.Fatal(err)
	}
	if string(before) != string(after) {
		t.Fatal("a tampered request's checkout was still edited")
	}
}
