package main_test

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/cli"
	_ "github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/edit" // installs cli.Edit
)

type caseMeta struct {
	ExitCode int    `json:"exitCode"`
	Refuse   string `json:"refuse"`
	// Manifests optionally overrides the manifests dir (default testdata/manifests).
	// Used by refusal fixtures that need a variant op (e.g. forcesReplace:true).
	Manifests string `json:"manifests"`
	// Idempotent, when explicitly false, skips the second-run no-op assertion.
	// Delete-style ops (remove_block, moved_block) consume their target address,
	// so a re-run cannot resolve it — spec §3: "except where noted a second run is a refusal".
	Idempotent *bool `json:"idempotent"`
}

func (m caseMeta) manifestsDir() string {
	if m.Manifests != "" {
		return m.Manifests
	}
	return "testdata/manifests"
}

func (m caseMeta) idempotent() bool { return m.Idempotent == nil || *m.Idempotent }

// copyTree copies src dir to dst (files only; fixture trees are flat).
func copyTree(t *testing.T, src, dst string) {
	t.Helper()
	entries, err := os.ReadDir(src)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(dst, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		b, err := os.ReadFile(filepath.Join(src, e.Name()))
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dst, e.Name()), b, 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

func mustEqualTree(t *testing.T, wantDir, gotDir string) {
	t.Helper()
	entries, err := os.ReadDir(wantDir)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		want, _ := os.ReadFile(filepath.Join(wantDir, e.Name()))
		got, _ := os.ReadFile(filepath.Join(gotDir, e.Name()))
		if !bytes.Equal(want, got) {
			t.Fatalf("%s differs from expected (got %d bytes, want %d)\n--- want ---\n%s\n--- got ---\n%s", e.Name(), len(got), len(want), want, got)
		}
	}
}

func TestGolden(t *testing.T) {
	items, err := filepath.Glob("testdata/golden/*/*")
	if err != nil || len(items) == 0 {
		t.Fatalf("no golden cases found: %v", err)
	}
	for _, dir := range items {
		dir := dir
		t.Run(strings.TrimPrefix(dir, "testdata/golden/"), func(t *testing.T) {
			var meta caseMeta
			mb, err := os.ReadFile(filepath.Join(dir, "case.json"))
			if err != nil {
				t.Fatal(err)
			}
			if err := json.Unmarshal(mb, &meta); err != nil {
				t.Fatal(err)
			}

			work := t.TempDir()
			copyTree(t, filepath.Join(dir, "before"), work)
			beforeSnapshot := t.TempDir()
			copyTree(t, filepath.Join(dir, "before"), beforeSnapshot)

			var out, errb bytes.Buffer
			code := cli.Run([]string{
				"edit",
				"--request", filepath.Join(dir, "request.yaml"),
				"--manifests", meta.manifestsDir(),
				"--env", work,
			}, &out, &errb)

			if code != meta.ExitCode {
				t.Fatalf("exit = %d, want %d (stderr: %s)", code, meta.ExitCode, errb.String())
			}
			if meta.ExitCode != 0 {
				if !strings.Contains(errb.String(), meta.Refuse) {
					t.Fatalf("stderr = %q, want contains %q", errb.String(), meta.Refuse)
				}
				mustEqualTree(t, beforeSnapshot, work) // non-zero exit ⇒ untouched tree (spec A2)
				return
			}
			mustEqualTree(t, filepath.Join(dir, "expected"), work)
			wantDiff, _ := os.ReadFile(filepath.Join(dir, "expected.diff"))
			if !bytes.Equal(wantDiff, out.Bytes()) {
				t.Fatalf("diff mismatch:\n--- want ---\n%s\n--- got ---\n%s", wantDiff, out.String())
			}

			if !meta.idempotent() {
				return
			}
			// Idempotence (spec A11): second run over the edited tree = no-op exit 0, empty diff.
			out.Reset()
			errb.Reset()
			if code2 := cli.Run([]string{"edit", "--request", filepath.Join(dir, "request.yaml"), "--manifests", meta.manifestsDir(), "--env", work}, &out, &errb); code2 != 0 {
				t.Fatalf("idempotent rerun exit = %d, want 0 (stderr: %s)", code2, errb.String())
			}
			if out.Len() != 0 {
				t.Fatalf("idempotent rerun diff not empty:\n%s", out.String())
			}
		})
	}
}
