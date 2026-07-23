package main_test

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// scriptPath is scripts/ci/plancheck-gate.sh relative to this package dir
// (tools/catalogctl → repo root is two levels up).
const scriptPath = "../../scripts/ci/plancheck-gate.sh"

// TestPlancheckGateScript drives the REAL CI gate script offline against the
// testdata/plans fixtures, proving the load-bearing property of plan-8 W2: a
// violating plan (interior-escape / unexpected replace / stray delete / shrink)
// FAILS the gate, a clean plan PASSES it, and the approve-this-exact-plan digest
// binding hard-fails on a mismatch. The ccp-apply.yml workflow invokes this
// same script, so a green run here is a green gate in CI (modulo the terraform
// plan step, which is env-gated / W6).
func TestPlancheckGateScript(t *testing.T) {
	if _, err := exec.LookPath("bash"); err != nil {
		t.Skip("bash not available")
	}
	if _, err := os.Stat(scriptPath); err != nil {
		t.Fatalf("gate script not found at %s: %v", scriptPath, err)
	}

	// Build catalogctl once and hand the script the binary (--catalogctl), so the
	// script never shells out to `go run` mid-test.
	bin := filepath.Join(t.TempDir(), "catalogctl")
	build := exec.Command("go", "build", "-o", bin, "./cmd/catalogctl")
	build.Stderr = os.Stderr
	if err := build.Run(); err != nil {
		t.Fatalf("build catalogctl: %v", err)
	}

	// runGate runs the script for a fixture with optional extra flags, returning
	// the exit code and the combined output.
	runGate := func(t *testing.T, fixture string, extra ...string) (int, string) {
		t.Helper()
		dir := filepath.Join("testdata/plans", fixture)
		args := []string{scriptPath,
			"--plan", filepath.Join(dir, "plan.json"),
			"--request", filepath.Join(dir, "request.yaml"),
			"--manifests", "testdata/manifests",
			"--catalogctl", bin,
		}
		args = append(args, extra...)
		cmd := exec.Command("bash", args...)
		var out, errb bytes.Buffer
		cmd.Stdout, cmd.Stderr = &out, &errb
		err := cmd.Run()
		code := 0
		if err != nil {
			var ee *exec.ExitError
			if errors.As(err, &ee) {
				code = ee.ExitCode()
			} else {
				t.Fatalf("run gate script: %v", err)
			}
		}
		return code, out.String() + errb.String()
	}

	// --- the gate: clean passes, every rule's violation blocks ---
	rules := []struct {
		name    string
		fixture string
		want    int
	}{
		{"clean plan passes", "r1-pass-single-change", 0},
		{"R1 extra address blocks", "r1-fail-extra-address", 2},
		{"R2 stray delete blocks", "r2-fail-delete-on-change-op", 2},
		{"R3 unexpected replace blocks", "r3-fail-unexpected-replace", 2},
		{"R4 shrink blocks", "r4-fail-shrink", 2},
		{"R6 interior-escape blocks", "r6-fail-interior-escape", 2},
	}
	for _, r := range rules {
		r := r
		t.Run(r.name, func(t *testing.T) {
			code, output := runGate(t, r.fixture)
			if code != r.want {
				t.Fatalf("exit = %d, want %d\n%s", code, r.want, output)
			}
			if r.want == 0 && !strings.Contains(output, "PASS") {
				t.Fatalf("clean plan output missing PASS marker\n%s", output)
			}
			if r.want == 2 && !strings.Contains(output, "VIOLATION") {
				t.Fatalf("blocking output missing VIOLATION line\n%s", output)
			}
		})
	}

	// --- the digest the gate emits is exactly sha256(plan.json) ---
	planPath := "testdata/plans/r1-pass-single-change/plan.json"
	want := sha256Hex(t, planPath)
	digestOut := filepath.Join(t.TempDir(), "digest.txt")
	code, output := runGate(t, "r1-pass-single-change", "--digest-out", digestOut)
	if code != 0 {
		t.Fatalf("clean run exit = %d\n%s", code, output)
	}
	got, err := os.ReadFile(digestOut)
	if err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(string(got)) != want {
		t.Fatalf("--digest-out = %q, want sha256(plan.json) = %q", strings.TrimSpace(string(got)), want)
	}
	if !strings.Contains(output, want) {
		t.Fatalf("stdout did not carry the digest %q\n%s", want, output)
	}

	// --- approve-this-exact-plan binding: match passes, mismatch hard-fails (4) ---
	t.Run("digest binding matches", func(t *testing.T) {
		code, output := runGate(t, "r1-pass-single-change", "--expect-digest", want)
		if code != 0 {
			t.Fatalf("matching digest exit = %d, want 0\n%s", code, output)
		}
	})
	t.Run("digest binding mismatch hard-fails", func(t *testing.T) {
		code, output := runGate(t, "r1-pass-single-change", "--expect-digest", strings.Repeat("0", 64))
		if code != 4 {
			t.Fatalf("mismatched digest exit = %d, want 4\n%s", code, output)
		}
		if !strings.Contains(output, "mismatch") {
			t.Fatalf("mismatch output missing reason\n%s", output)
		}
	})
}

func sha256Hex(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}
