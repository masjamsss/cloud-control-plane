package prescan

import (
	"bytes"
	"encoding/json"
	"flag"
	"os"
	"path/filepath"
	"testing"
)

// update regenerates the expected-prescan.json goldens from the current Scan
// output. The goldens are the frozen oracle (spec §6.2 Accept 22): they are
// generated once, hand-verified against the independent expectations encoded in
// this test (verdict + finding code + census), and then never edited to pass.
var update = flag.Bool("update", false, "regenerate expected-prescan.json goldens")

const fixtureRoot = "../../testdata/onboarding"

// wantVerdict/wantCode are the INDEPENDENT oracle: what each fixture MUST
// produce, asserted regardless of the golden bytes. A regenerated golden that
// disagrees with these is a Scan bug to fix, never a golden to accept.
var wantVerdict = map[string]string{
	"clean-repo":              "clean",
	"malicious-data-external": "reject",
	"malicious-provisioner":   "reject",
	"off-allowlist-provider":  "reject",
	"off-allowlist-module":    "reject",
	"malicious-tfjson":        "reject",
	"nonstatic-source":        "reject",
}

var wantCode = map[string]string{
	"malicious-data-external": "DATA_EXTERNAL",
	"malicious-provisioner":   "PROVISIONER",
	"off-allowlist-provider":  "PROVIDER_SOURCE",
	"off-allowlist-module":    "MODULE_SOURCE",
	"malicious-tfjson":        "PROVISIONER", // gap G2: provisioner hidden in JSON syntax
	"nonstatic-source":        "NONSTATIC_SOURCE",
}

func TestScanGolden(t *testing.T) {
	entries, err := os.ReadDir(fixtureRoot)
	if err != nil {
		t.Fatalf("read fixture root: %v", err)
	}
	seen := 0
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		name := e.Name()
		seen++
		t.Run(name, func(t *testing.T) {
			dir := filepath.Join(fixtureRoot, name)
			rep, err := Scan(dir, nil) // nil ⇒ default hashicorp allowlist
			if err != nil {
				t.Fatalf("Scan: %v", err)
			}

			got, err := json.MarshalIndent(rep, "", "  ")
			if err != nil {
				t.Fatal(err)
			}
			got = append(got, '\n')

			goldenPath := filepath.Join(dir, "expected-prescan.json")
			if *update {
				if err := os.WriteFile(goldenPath, got, 0o644); err != nil {
					t.Fatal(err)
				}
			}
			want, err := os.ReadFile(goldenPath)
			if err != nil {
				t.Fatalf("missing golden (regenerate with -update, then hand-verify): %v", err)
			}
			if !bytes.Equal(want, got) {
				t.Fatalf("golden mismatch for %s:\n--- want ---\n%s\n--- got ---\n%s", name, want, got)
			}

			// Independent oracle — never sourced from the golden bytes.
			if wv, ok := wantVerdict[name]; ok && rep.Verdict != wv {
				t.Errorf("verdict = %q, want %q", rep.Verdict, wv)
			}
			if wc, ok := wantCode[name]; ok {
				if len(rep.Findings) != 1 {
					t.Fatalf("findings = %d, want exactly 1 (%s)", len(rep.Findings), wc)
				}
				if rep.Findings[0].Code != wc {
					t.Errorf("finding code = %q, want %q", rep.Findings[0].Code, wc)
				}
			}
			if name == "clean-repo" && len(rep.Findings) != 0 {
				t.Errorf("clean-repo findings = %d, want 0", len(rep.Findings))
			}
		})
	}
	if seen == 0 {
		t.Fatal("no fixtures found under " + fixtureRoot)
	}
}

// TestScanReportShape pins the census fields that onboarding reads (0007 §5.2).
func TestScanReportShape(t *testing.T) {
	rep, err := Scan(filepath.Join(fixtureRoot, "clean-repo"), nil)
	if err != nil {
		t.Fatal(err)
	}
	if rep.ResourceBlocks != 2 {
		t.Errorf("resourceBlocks = %d, want 2", rep.ResourceBlocks)
	}
	if rep.ProviderPins["aws"] != "~> 6.0" {
		t.Errorf("providerPins[aws] = %q, want %q", rep.ProviderPins["aws"], "~> 6.0")
	}
	if rep.FmtDirtyFiles != 0 {
		t.Errorf("clean-repo fmtDirtyFiles = %d, want 0 (fixture must be canonical)", rep.FmtDirtyFiles)
	}

	// tfjson census: the JSON file is counted and its provisioner is caught.
	jrep, err := Scan(filepath.Join(fixtureRoot, "malicious-tfjson"), nil)
	if err != nil {
		t.Fatal(err)
	}
	if jrep.TfJsonFiles != 1 {
		t.Errorf("malicious-tfjson tfJsonFiles = %d, want 1", jrep.TfJsonFiles)
	}
	if jrep.Verdict != "reject" {
		t.Errorf("malicious-tfjson verdict = %q, want reject", jrep.Verdict)
	}
}
