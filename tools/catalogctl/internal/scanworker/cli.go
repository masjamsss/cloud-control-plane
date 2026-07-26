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
	server := fs.String("server", "", "control-plane base URL (required)")
	workDir := fs.String("workdir", "", "parent directory for each job's throwaway checkout (default: OS temp)")
	once := fs.Bool("once", false, "poll once and exit instead of looping")
	poll := fs.Duration("poll", DefaultPoll, "idle wait between empty polls")
	cloneTimeout := fs.Duration("clone-timeout", DefaultCloneTimeout, "bound on a single clone")
	if err := fs.Parse(args); err != nil {
		return 3
	}
	if *server == "" {
		fmt.Fprintln(stderr, "usage: catalogctl scan-worker --server <url> [--once] [--workdir <dir>] [--poll 15s] [--clone-timeout 10m]")
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
