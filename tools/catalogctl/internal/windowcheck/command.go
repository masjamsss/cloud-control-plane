package windowcheck

import (
	"flag"
	"fmt"
	"io"
	"time"

	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/cli"
	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/estatecfg"
	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/request"
)

// init installs cli.WindowCheck so cli.Run stays the single entrypoint (mirrors the
// plancheck/prprep seams; avoids an import cycle since cli imports nothing here).
func init() { cli.WindowCheck = run }

// run is the `window-check` subcommand: load+harden the request, evaluate
// the composition rule at the REQUIRED --at instant, print the machine verdict to
// stdout and a human reason to stderr, and return the exit code.
//
//	catalogctl window-check --request requests/REQ-….yaml --at <RFC3339>
//	  exit 0  IN_WINDOW / NO_WINDOW   → proceed
//	  exit 5  BEFORE_WINDOW           → not yet (cooling and/or window)
//	  exit 6  WINDOW_EXPIRED          → hard refusal
//	  exit 3  SCHEDULE_INVALID / usage → parse/schema, fail closed
//
// --at is REQUIRED and there is NO wall-clock fallback: the library reads no clock, so
// every verdict is deterministic. scripts/ci/apply-window-gate.sh is the sole place the
// pipeline reads the wall clock, injecting it as --at "$now".
func run(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("window-check", flag.ContinueOnError)
	fs.SetOutput(stderr)
	reqPath := fs.String("request", "", "path to the ccp.request/v1 YAML")
	atFlag := fs.String("at", "", "RFC3339 instant to evaluate at (REQUIRED; no wall-clock fallback)")
	nowFlag := fs.String("now", "", "alias for --at (0024 §3.2 prose uses --now); neither defaults to the wall clock")
	estateTZ := fs.String("estate-tz", "", estatecfg.FlagUsage)
	if err := fs.Parse(args); err != nil {
		return 3
	}

	// Resolved once, before any verdict (estate-config, ADR-0028): a startup config
	// error (e.g. an unresolvable --estate-tz/CCP_ESTATE_TZ) refuses here, ahead of
	// even the --request/--at usage checks below.
	cfg, err := estatecfg.Resolve(*estateTZ)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 3
	}

	if *reqPath == "" {
		fmt.Fprintln(stderr, "window-check: --request is required")
		return 3
	}
	at := *atFlag
	if at == "" {
		at = *nowFlag
	}
	if at == "" {
		fmt.Fprintln(stderr, "window-check: --at <RFC3339> is required — the evaluation instant is injected, never read from the wall clock (0024 §3.2)")
		return 3
	}
	now, err := time.Parse(time.RFC3339, at)
	if err != nil {
		fmt.Fprintf(stderr, "window-check: --at %q is not RFC3339: %v\n", at, err)
		return 3
	}

	req, err := request.Load(*reqPath, cfg)
	if err != nil {
		// Load hardens the window/earliest fields; a malformed schedule is fail-closed
		// SCHEDULE_INVALID (exit 3), never "no window = apply freely".
		fmt.Fprintln(stdout, Result{Verdict: ScheduleInvalid, Now: now}.Line())
		fmt.Fprintf(stderr, "window-check: REFUSE %s — %v\n", ScheduleInvalid, err)
		return ScheduleInvalid.ExitCode()
	}

	res := Evaluate(req, now, cfg)
	fmt.Fprintln(stdout, res.Line())
	code := res.Verdict.ExitCode()
	if code == 0 {
		fmt.Fprintf(stderr, "window-check: OK %s — %s\n", res.Verdict, res.Reason)
	} else {
		fmt.Fprintf(stderr, "window-check: REFUSE %s — %s\n", res.Verdict, res.Reason)
	}
	return code
}
