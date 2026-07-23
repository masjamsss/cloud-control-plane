package main_test

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/cli"
	_ "github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/plancheck" // installs cli.PlanCheck
)

// planCase is the plan-check fixture metadata (spec §6 fixtures). Read-only: the
// harness never writes, so there is no before/after tree to compare — only the
// exit code and a machine-greppable output substring.
type planCase struct {
	ExitCode int    `json:"exitCode"`
	Contains string `json:"contains"`
	// Manifests optionally overrides the manifests dir (default testdata/manifests).
	// The moved fixtures use the fx op catalogue in testdata/manifests-fx.
	Manifests string `json:"manifests"`
}

func (c planCase) manifestsDir() string {
	if c.Manifests != "" {
		return c.Manifests
	}
	return "testdata/manifests"
}

func TestPlanCheck(t *testing.T) {
	cases, err := filepath.Glob("testdata/plans/*")
	if err != nil || len(cases) == 0 {
		t.Fatalf("no plan-check cases found: %v", err)
	}
	for _, dir := range cases {
		dir := dir
		t.Run(strings.TrimPrefix(dir, "testdata/plans/"), func(t *testing.T) {
			var meta planCase
			mb, err := os.ReadFile(filepath.Join(dir, "case.json"))
			if err != nil {
				t.Fatal(err)
			}
			if err := json.Unmarshal(mb, &meta); err != nil {
				t.Fatal(err)
			}

			var out, errb bytes.Buffer
			code := cli.Run([]string{
				"plan-check",
				"--plan", filepath.Join(dir, "plan.json"),
				"--request", filepath.Join(dir, "request.yaml"),
				"--manifests", meta.manifestsDir(),
			}, &out, &errb)

			if code != meta.ExitCode {
				t.Fatalf("exit = %d, want %d\n--- stdout ---\n%s--- stderr ---\n%s", code, meta.ExitCode, out.String(), errb.String())
			}
			// INFO lines go to stdout, VIOLATION/errors to stderr; the fixture's
			// `contains` may target either, so check the combined stream.
			combined := out.String() + errb.String()
			if meta.Contains != "" && !strings.Contains(combined, meta.Contains) {
				t.Fatalf("output missing %q\n--- stdout ---\n%s--- stderr ---\n%s", meta.Contains, out.String(), errb.String())
			}
		})
	}
}
