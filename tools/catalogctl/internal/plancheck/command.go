package plancheck

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/cli"
	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/estatecfg"
	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/manifests"
	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/request"
)

// init installs cli.PlanCheck so cli.Run stays the single entrypoint (mirrors the
// edit package's seam; avoids an import cycle since cli imports nothing here).
func init() { cli.PlanCheck = run }

// run is the `plan-check` subcommand: load plan+request+op, assert the plan
// format version, run Check, and map the result to exit codes (spec):
//
//	0 clean (prints INFO) · 2 PLAN_VIOLATION (prints one VIOLATION line each) ·
//	3 parse error / unknown op / unsupported format_version.
//
// spec docs/superpowers/specs/2026-07-20-ccp-drift-portal.md §4.4/§7 (WI-5): a
// --request naming one of the two drift system ops is never a manifests.Op — routed
// to RunDriftGate (driftgate.go) before the ordinary YAML+manifest resolution below,
// which would otherwise refuse it as an unknown/unparseable request. Every other
// --request (including every existing fixture) falls straight through unchanged:
// peekDriftOp never matches a genuine ccp.request/v1 YAML file.
func run(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("plan-check", flag.ContinueOnError)
	fs.SetOutput(stderr)
	planPath := fs.String("plan", "", "path to `terraform show -json` output")
	reqPath := fs.String("request", "", "path to the ccp.request/v1 YAML (or a drift system op's .bundle-request.json)")
	manifestsDir := fs.String("manifests", "", "directory of ServiceManifest JSONs")
	_ = fs.String("rules", "", "accepted for CLI parity (spec §1); unused by plan-check")
	estateTZ := fs.String("estate-tz", "", estatecfg.FlagUsage)
	if err := fs.Parse(args); err != nil {
		return 3
	}

	// Resolved once, before any verdict (estate-config, ADR-0028) — ahead of the
	// drift-gate dispatch below, so a startup config error refuses uniformly
	// regardless of which downstream path (drift-gate or ordinary request.Load) would
	// otherwise run.
	cfg, err := estatecfg.Resolve(*estateTZ)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 3
	}

	switch opID, items, kind := peekDriftOp(*reqPath); kind {
	case malformedDrift:
		// spec addendum A2: a mix of drift and non-drift ops (or mixed drift
		// ops) in one request has no honest producer — refused here, never
		// fallen through to the YAML+manifest path below (which would also
		// fail, but for the wrong, confusing reason).
		fmt.Fprintln(stderr, "plan-check: bundle request items do not honestly agree on a single drift system op")
		return 3
	case driftMatch:
		plan, err := loadPlanVersioned(*planPath)
		if err != nil {
			fmt.Fprintln(stderr, err)
			return 3
		}
		violations, info, err := RunDriftGate(opID, items, plan)
		if err != nil {
			fmt.Fprintln(stderr, err)
			return 3
		}
		if len(violations) > 0 {
			for _, v := range violations {
				fmt.Fprintln(stderr, v.String())
			}
			return 2 // PLAN_VIOLATION
		}
		for _, line := range info {
			fmt.Fprintln(stdout, line)
		}
		return 0
	}

	req, err := request.Load(*reqPath, cfg)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 3
	}
	ops, err := manifests.LoadDir(*manifestsDir)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 3
	}
	op, ok := ops[req.Item]
	if !ok {
		fmt.Fprintf(stderr, "unknown op %q\n", req.Item)
		return 3
	}
	plan, err := loadPlanVersioned(*planPath)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 3
	}

	violations, info := Check(plan, op, req)
	if len(violations) > 0 {
		for _, v := range violations {
			fmt.Fprintln(stderr, v.String())
		}
		return 2 // PLAN_VIOLATION
	}
	for _, line := range info {
		fmt.Fprintln(stdout, line)
	}
	return 0
}

// loadPlan reads and decodes the plan JSON. A read or parse failure is a
// resolution error (exit 3).
func loadPlan(path string) (Plan, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return Plan{}, err
	}
	var p Plan
	if err := json.Unmarshal(b, &p); err != nil {
		return Plan{}, fmt.Errorf("parse plan json: %w", err)
	}
	if p.FormatVersion == "" {
		return Plan{}, fmt.Errorf("plan json missing format_version")
	}
	return p, nil
}

// loadPlanVersioned wraps loadPlan with the format_version major-version assertion —
// shared by both the drift-gate path and the ordinary manifests.Op path (run, above)
// so the version contract is enforced identically either way.
func loadPlanVersioned(path string) (Plan, error) {
	plan, err := loadPlan(path)
	if err != nil {
		return Plan{}, err
	}
	if major := majorVersion(plan.FormatVersion); major != "1" {
		return Plan{}, fmt.Errorf("unsupported plan format_version %q (want major 1)", plan.FormatVersion)
	}
	return plan, nil
}

// majorVersion returns the leading component of a dotted version string.
func majorVersion(v string) string {
	if i := strings.Index(v, "."); i >= 0 {
		return v[:i]
	}
	return v
}
