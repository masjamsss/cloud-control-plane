package main_test

import (
	"bytes"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

// windowGateScript is scripts/ci/apply-window-gate.sh relative to this package dir
// (tools/catalogctl → repo root is two levels up).
const windowGateScript = "../../scripts/ci/apply-window-gate.sh"

// TestApplyWindowGateScript drives the REAL apply-time gate script offline against the
// testdata/windows fixtures at SUPPLIED instants (--now), proving proposal 0024's
// pipeline enforcement: a request before its window / after its window / with a garbled
// schedule is REFUSED with the right exit code, an in-window request PASSES, and the
// CCP_FREEZE veto refuses regardless of the window (freeze is absolute, §0.2/§3.5).
// ccp-apply.yml invokes this same script, so a green run here is a green gate in CI.
func TestApplyWindowGateScript(t *testing.T) {
	if _, err := exec.LookPath("bash"); err != nil {
		t.Skip("bash not available")
	}
	if _, err := os.Stat(windowGateScript); err != nil {
		t.Fatalf("gate script not found at %s: %v", windowGateScript, err)
	}

	// Build catalogctl once and hand the script the binary (--catalogctl) so it never
	// shells out to `go run` mid-test.
	bin := filepath.Join(t.TempDir(), "catalogctl")
	build := exec.Command("go", "build", "-o", bin, "./cmd/catalogctl")
	build.Stderr = os.Stderr
	if err := build.Run(); err != nil {
		t.Fatalf("build catalogctl: %v", err)
	}

	// runGate runs the script for a fixture at a supplied --now, with optional extra env
	// (e.g. CCP_FREEZE), returning the exit code and combined output. Every case in
	// this test's table is tz: America/New_York (or tz-agnostic, no window), so the harness
	// projects CCP_ESTATE_TZ=America/New_York the same way apply-window-gate.sh expects
	// the estate account repo's CI variable to arrive (estate-config, ADR-0028) — the
	// gate script itself defaults --estate-tz to "${CCP_ESTATE_TZ:-UTC}".
	runGate := func(t *testing.T, fixture, now string, env ...string) (int, string) {
		t.Helper()
		args := []string{windowGateScript,
			"--request", filepath.Join("testdata/windows", fixture),
			"--now", now,
			"--catalogctl", bin,
		}
		cmd := exec.Command("bash", args...)
		estateEnv := append([]string{"CCP_ESTATE_TZ=America/New_York"}, env...)
		cmd.Env = append(os.Environ(), estateEnv...)
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

	// --- verdict → exit-code matrix (the same instants window-check's unit tests use) ---
	cases := []struct {
		name    string
		fixture string
		now     string
		env     []string
		want    int
		marker  string // a substring the output must contain
	}{
		{"in-window passes", "windowed.yaml", "2026-07-12T19:00:00Z", nil, 0, "PASS"},
		{"before window refuses", "windowed.yaml", "2026-07-12T17:00:00Z", nil, 5, "not yet"},
		{"after window refuses", "windowed.yaml", "2026-07-12T23:00:00Z", nil, 6, "expired"},
		{"no window passes", "no-window.yaml", "2000-01-01T00:00:00Z", nil, 0, "PASS"},
		{"cooling not met refuses", "cooling.yaml", "2026-07-11T05:00:00Z", nil, 5, "not yet"},
		{"cooling met passes", "cooling.yaml", "2026-07-11T06:00:00Z", nil, 0, "PASS"},
		{"garbled schedule fails closed", "garbled-window.yaml", "2026-07-12T19:00:00Z", nil, 3, "fails closed"},
		// Freeze is absolute (§0.2): it refuses even when the window is open, and even
		// when the window would otherwise refuse — the freeze verdict precedes the window.
		{"freeze overrides open window", "windowed.yaml", "2026-07-12T19:00:00Z", []string{"CCP_FREEZE=true"}, 7, "freeze active"},
		{"freeze precedes before-window", "windowed.yaml", "2026-07-12T17:00:00Z", []string{"CCP_FREEZE=1"}, 7, "freeze active"},
		{"freeze off (false) is not frozen", "windowed.yaml", "2026-07-12T19:00:00Z", []string{"CCP_FREEZE=false"}, 0, "PASS"},
	}
	for _, c := range cases {
		c := c
		t.Run(c.name, func(t *testing.T) {
			code, output := runGate(t, c.fixture, c.now, c.env...)
			if code != c.want {
				t.Fatalf("exit = %d, want %d\n%s", code, c.want, output)
			}
			if c.marker != "" && !bytes.Contains([]byte(output), []byte(c.marker)) {
				t.Fatalf("output missing marker %q\n%s", c.marker, output)
			}
		})
	}
}

// TestApplyWindowGateBundleLocate proves the script locates the single
// requests/REQ-*.yaml inside a --bundle DIR (the shape the ccp bot PR carries), and
// no-ops (exit 0) when a bundle carries no request — an ordinary push stays inert.
func TestApplyWindowGateBundleLocate(t *testing.T) {
	if _, err := exec.LookPath("bash"); err != nil {
		t.Skip("bash not available")
	}
	bin := filepath.Join(t.TempDir(), "catalogctl")
	build := exec.Command("go", "build", "-o", bin, "./cmd/catalogctl")
	build.Stderr = os.Stderr
	if err := build.Run(); err != nil {
		t.Fatalf("build catalogctl: %v", err)
	}

	// A bundle with one requests/REQ-*.yaml → the gate finds and enforces it.
	bundle := t.TempDir()
	reqDir := filepath.Join(bundle, "requests")
	if err := os.MkdirAll(reqDir, 0o755); err != nil {
		t.Fatal(err)
	}
	src, err := os.ReadFile("testdata/windows/windowed.yaml")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(reqDir, "REQ-01JZTC4QWERTY0123456789AAB.yaml"), src, 0o644); err != nil {
		t.Fatal(err)
	}

	runBundle := func(t *testing.T, dir, now string) (int, string) {
		t.Helper()
		cmd := exec.Command("bash", windowGateScript, "--bundle", dir, "--now", now, "--catalogctl", bin)
		// The bundled request is windowed.yaml (tz: America/New_York) — project the matching
		// estate config the same way runGate above does.
		cmd.Env = append(os.Environ(), "CCP_ESTATE_TZ=America/New_York")
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

	t.Run("locates and enforces the bundle request", func(t *testing.T) {
		if code, out := runBundle(t, bundle, "2026-07-12T23:00:00Z"); code != 6 {
			t.Fatalf("exit = %d, want 6 (expired)\n%s", code, out)
		}
	})
	t.Run("empty bundle is inert", func(t *testing.T) {
		if code, out := runBundle(t, t.TempDir(), "2026-07-12T19:00:00Z"); code != 0 {
			t.Fatalf("exit = %d, want 0 (inert; no request to gate)\n%s", code, out)
		}
	})
}
