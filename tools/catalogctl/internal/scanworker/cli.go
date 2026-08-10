package scanworker

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/cli"
)

func init() { cli.ScanWorker = run }

// run is the `catalogctl scan-worker` entrypoint.
//
// Exit codes follow the CLI's convention: 0 ok · 2 refusal · 3 usage/arg error
// · 1 internal. A REFUSED STARTUP IS EXIT 2 and prints the machine-greppable
// REFUSE line, so an init system or a container healthcheck can tell "this
// deployment is wrong" apart from "the control plane was unreachable".
func run(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("scan-worker", flag.ContinueOnError)
	fs.SetOutput(stderr)
	server := fs.String("server", "", "control-plane base URL (required, except with --healthcheck)")
	workDir := fs.String("workdir", "", "parent directory for each job's throwaway checkout (default: OS temp)")
	once := fs.Bool("once", false, "poll once and exit instead of looping")
	poll := fs.Duration("poll", DefaultPoll, "idle wait between empty polls")
	cloneTimeout := fs.Duration("clone-timeout", DefaultCloneTimeout, "bound on a single clone")
	// OPS-12 — the two --healthcheck flags. Kept in the SAME flag set / SAME
	// binary rather than a separate command: a container HEALTHCHECK can then
	// invoke `catalogctl scan-worker --healthcheck ...` directly (CMD form, no
	// shell) — this image ships no shell tooling on purpose (see
	// scanner/Dockerfile), so a stat/find/date one-liner was never an option.
	heartbeat := fs.String("heartbeat", "", "path the running worker touches once per loop iteration; empty disables liveness tracking")
	healthcheck := fs.Bool("healthcheck", false, "check --heartbeat's freshness and exit 0 (fresh) or 1 (missing/stale/unset) instead of running the worker")
	if err := fs.Parse(args); err != nil {
		return 3
	}
	if *healthcheck {
		return runHealthcheck(*heartbeat, stderr)
	}
	if *server == "" {
		fmt.Fprintln(stderr, "usage: catalogctl scan-worker --server <url> [--once] [--workdir <dir>] [--poll 15s] [--clone-timeout 10m] [--heartbeat <path>]")
		fmt.Fprintf(stderr, "  %s must be in the environment (never a flag)\n", ScannerKeyEnv)
		return 3
	}
	// ENV ONLY — never a flag, so the key cannot land in a process listing.
	key := os.Getenv(ScannerKeyEnv)
	if key == "" {
		return cli.Refuse(stderr, "SCANNER_KEY_MISSING",
			ScannerKeyEnv+" is not in the environment; the worker has no way to authenticate to the control plane")
	}

	// Ctrl-C / SIGTERM stops the loop cleanly: the in-flight job finishes its
	// current step and reports a terminal status rather than being abandoned
	// mid-scan for an operator to wonder about.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	opts := Opts{
		Server:       *server,
		Key:          key,
		WorkDir:      *workDir,
		Once:         *once,
		Poll:         *poll,
		CloneTimeout: *cloneTimeout,
		Heartbeat:    *heartbeat,
	}
	if err := Run(ctx, opts, NewHTTPControl(*server, key), GitCloner{}, OnboardScanner{}, stdout); err != nil {
		// A refused startup is a DEPLOYMENT problem (exit 2, greppable REFUSE
		// line); anything else is a runtime one (exit 1). Told apart by a
		// sentinel error, not by matching on message text.
		var pf *PreflightError
		if errors.As(err, &pf) {
			return cli.Refuse(stderr, "SCANNER_PREFLIGHT", pf.Error())
		}
		fmt.Fprintf(stderr, "scan-worker: %v\n", err)
		return 1
	}
	return 0
}

// runHealthcheck is `--healthcheck`'s whole body: exit 0 if `heartbeat` was
// touched within HeartbeatStaleness, exit 1 otherwise (missing file, stale
// file, or no --heartbeat path given at all — a healthcheck with nothing to
// check is not a passing one). Deliberately not wired through `cli.Refuse` —
// this is a routine liveness answer for Docker/orchestrator polling, not a
// deployment refusal, and should not print the greppable REFUSE line other
// tooling scans for.
func runHealthcheck(heartbeat string, stderr io.Writer) int {
	if heartbeat == "" {
		fmt.Fprintln(stderr, "--healthcheck needs --heartbeat <path> (the same path the running worker was started with)")
		return 1
	}
	info, err := os.Stat(heartbeat)
	if err != nil {
		fmt.Fprintf(stderr, "heartbeat: %v\n", err)
		return 1
	}
	if age := time.Since(info.ModTime()); age > HeartbeatStaleness {
		fmt.Fprintf(stderr, "heartbeat is %s old (limit %s) — the worker looks wedged\n", age.Round(time.Second), HeartbeatStaleness)
		return 1
	}
	return 0
}
