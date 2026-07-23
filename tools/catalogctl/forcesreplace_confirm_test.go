package main_test

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/cli"
	_ "github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/edit" // installs cli.Edit
)

// These lock the forces-replace confirmed-override lane end-to-end through cli.Run,
// the same entrypoint the golden harness and CI use. The invariants under test:
//
//   - a forcesReplace op still REFUSES FORCES_REPLACE when no typed confirmation is
//     present (unchanged from the pre-override behaviour) and leaves the tree untouched;
//   - it also refuses when a confirmation is present but names a DIFFERENT resource — a
//     confirmation cannot be replayed onto another target;
//   - it AUTHORS the change (exit 0, real diff) only when the confirmation names exactly
//     the resource being replaced;
//   - PREVENT_DESTROY is NEVER overridable — a lifecycle.prevent_destroy target refuses
//     even with a correct confirmation, and nothing is written.

const frManifests = "testdata/manifests-fx"

const frInstanceTf = `resource "aws_instance" "web" {
  instance_type = "t3.small"
}
`

const frProtectedTf = `resource "aws_instance" "web" {
  instance_type = "t3.small"

  lifecycle {
    prevent_destroy = true
  }
}
`

// prevent_destroy written as a STRING — a legal-but-unusual encoding the veto
// must still catch (Terraform coerces it to a bool). Fail-closed.
const frProtectedStringTf = `resource "aws_instance" "web" {
  instance_type = "t3.small"

  lifecycle {
    prevent_destroy = "true"
  }
}
`

// prevent_destroy set from an expression the tool cannot statically evaluate
// (no eval context). Not provably false → protected. Fail-closed.
const frProtectedExprTf = `resource "aws_instance" "web" {
  instance_type = "t3.small"

  lifecycle {
    prevent_destroy = var.protect
  }
}
`

// prevent_destroy explicitly disabled — the veto must NOT fire here, or
// "fail closed" would degrade into "refuse everything". This target authors.
const frUnprotectedTf = `resource "aws_instance" "web" {
  instance_type = "t3.small"

  lifecycle {
    prevent_destroy = false
  }
}
`

// frRequest builds a fx-set-attr-fr (forcesReplace:true set_attribute) request. A
// non-empty confirm adds the typed replace confirmation naming that address.
func frRequest(confirm string) string {
	base := `schema: ccp.request/v1
id: REQ-01JZTC4QWERTY0123456789AAB
item: fx-set-attr-fr
created_at: "2026-07-10T00:00:00Z"
requester_login: fixture-l1
params:
  instance: aws_instance.web
  new_instance_type: m5.large
justification: "forces-replace confirmed-override fixture"
`
	if confirm != "" {
		base += "confirmations:\n  replace: " + confirm + "\n"
	}
	return base
}

// writeFRCase writes an env tree (one main.tf) and a request.yaml, returning their paths.
func writeFRCase(t *testing.T, tf, reqYAML string) (envDir, reqPath string) {
	t.Helper()
	envDir = t.TempDir()
	if err := os.WriteFile(filepath.Join(envDir, "main.tf"), []byte(tf), 0o644); err != nil {
		t.Fatal(err)
	}
	reqPath = filepath.Join(t.TempDir(), "request.yaml")
	if err := os.WriteFile(reqPath, []byte(reqYAML), 0o644); err != nil {
		t.Fatal(err)
	}
	return envDir, reqPath
}

func runFREdit(t *testing.T, envDir, reqPath string) (code int, stdout, stderr string) {
	t.Helper()
	var out, errb bytes.Buffer
	code = cli.Run([]string{"edit", "--request", reqPath, "--manifests", frManifests, "--env", envDir}, &out, &errb)
	return code, out.String(), errb.String()
}

func assertFRUnchanged(t *testing.T, envDir, want string) {
	t.Helper()
	got, err := os.ReadFile(filepath.Join(envDir, "main.tf"))
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != want {
		t.Fatalf("tree mutated on a refusal:\n--- want ---\n%s\n--- got ---\n%s", want, got)
	}
}

// A correct typed confirmation opens the lane: the change is authored (exit 0, real diff).
func TestForcesReplace_AuthorsWithMatchingConfirmation(t *testing.T) {
	envDir, reqPath := writeFRCase(t, frInstanceTf, frRequest("aws_instance.web"))
	code, stdout, stderr := runFREdit(t, envDir, reqPath)
	if code != 0 {
		t.Fatalf("exit = %d, want 0 (stderr: %s)", code, stderr)
	}
	got, _ := os.ReadFile(filepath.Join(envDir, "main.tf"))
	if !strings.Contains(string(got), `instance_type = "m5.large"`) {
		t.Fatalf("authored file missing the new value:\n%s", got)
	}
	if !strings.Contains(stdout, "m5.large") || !strings.Contains(stdout, "-") {
		t.Fatalf("diff did not carry the change:\n%s", stdout)
	}
}

// No confirmation → still refuses FORCES_REPLACE, tree untouched (pre-override behaviour).
func TestForcesReplace_RefusesWithoutConfirmation(t *testing.T) {
	envDir, reqPath := writeFRCase(t, frInstanceTf, frRequest(""))
	code, _, stderr := runFREdit(t, envDir, reqPath)
	if code != 2 {
		t.Fatalf("exit = %d, want 2 (stderr: %s)", code, stderr)
	}
	if !strings.Contains(stderr, "REFUSE FORCES_REPLACE") {
		t.Fatalf("stderr = %q, want REFUSE FORCES_REPLACE", stderr)
	}
	assertFRUnchanged(t, envDir, frInstanceTf)
}

// A confirmation naming a DIFFERENT resource is treated as absent — it cannot be
// replayed onto this target. Refuses FORCES_REPLACE, tree untouched.
func TestForcesReplace_RefusesMismatchedConfirmation(t *testing.T) {
	envDir, reqPath := writeFRCase(t, frInstanceTf, frRequest("aws_instance.other"))
	code, _, stderr := runFREdit(t, envDir, reqPath)
	if code != 2 || !strings.Contains(stderr, "REFUSE FORCES_REPLACE") {
		t.Fatalf("exit=%d stderr=%q, want 2 + REFUSE FORCES_REPLACE", code, stderr)
	}
	assertFRUnchanged(t, envDir, frInstanceTf)
}

// PREVENT_DESTROY is never overridable: even a correct confirmation refuses a
// lifecycle.prevent_destroy target, and nothing is written.
func TestForcesReplace_PreventDestroyNeverOverridable(t *testing.T) {
	envDir, reqPath := writeFRCase(t, frProtectedTf, frRequest("aws_instance.web"))
	code, _, stderr := runFREdit(t, envDir, reqPath)
	if code != 2 || !strings.Contains(stderr, "REFUSE PREVENT_DESTROY") {
		t.Fatalf("exit=%d stderr=%q, want 2 + REFUSE PREVENT_DESTROY", code, stderr)
	}
	assertFRUnchanged(t, envDir, frProtectedTf)
}

// The veto fails CLOSED: prevent_destroy encoded as a non-literal (a string, or
// an unevaluable expression) still refuses PREVENT_DESTROY with a correct
// confirmation, and nothing is written. Guards against a guardrail that only
// recognises the literal `true` form.
func TestForcesReplace_PreventDestroyFailsClosedOnNonLiteral(t *testing.T) {
	for _, tc := range []struct {
		name string
		tf   string
	}{
		{"string", frProtectedStringTf},
		{"expression", frProtectedExprTf},
	} {
		t.Run(tc.name, func(t *testing.T) {
			envDir, reqPath := writeFRCase(t, tc.tf, frRequest("aws_instance.web"))
			code, _, stderr := runFREdit(t, envDir, reqPath)
			if code != 2 || !strings.Contains(stderr, "REFUSE PREVENT_DESTROY") {
				t.Fatalf("exit=%d stderr=%q, want 2 + REFUSE PREVENT_DESTROY", code, stderr)
			}
			assertFRUnchanged(t, envDir, tc.tf)
		})
	}
}

// "Fail closed" must not become "refuse everything": a target that explicitly
// sets prevent_destroy = false is NOT protected, so a confirmed forces-replace
// authors the change (exit 0, real diff).
func TestForcesReplace_AuthorsWhenPreventDestroyFalse(t *testing.T) {
	envDir, reqPath := writeFRCase(t, frUnprotectedTf, frRequest("aws_instance.web"))
	code, stdout, stderr := runFREdit(t, envDir, reqPath)
	if code != 0 {
		t.Fatalf("exit = %d, want 0 (stderr: %s)", code, stderr)
	}
	got, _ := os.ReadFile(filepath.Join(envDir, "main.tf"))
	if !strings.Contains(string(got), `instance_type = "m5.large"`) {
		t.Fatalf("authored file missing the new value:\n%s", got)
	}
	if !strings.Contains(stdout, "m5.large") {
		t.Fatalf("diff did not carry the change:\n%s", stdout)
	}
}
