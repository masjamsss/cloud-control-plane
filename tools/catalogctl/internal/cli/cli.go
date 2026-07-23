// Package cli is the single entrypoint: subcommand dispatch, exit codes, REFUSE format.
// Exit codes (spec): 0 ok · 2 refusal · 3 resolution/schema error · 1 internal.
package cli

import (
	"fmt"
	"io"
)

// Edit and Onboard are installed by their packages' init() (blank-imported in
// main) to avoid an import cycle while keeping Run the only entrypoint. Nil until then.
var (
	DriftEdit    func(args []string, stdout, stderr io.Writer) int
	DriftPropose func(args []string, stdout, stderr io.Writer) int
	Edit         func(args []string, stdout, stderr io.Writer) int
	Onboard      func(args []string, stdout, stderr io.Writer) int
	PlanCheck    func(args []string, stdout, stderr io.Writer) int
	PRPrepare    func(args []string, stdout, stderr io.Writer) int
	WindowCheck  func(args []string, stdout, stderr io.Writer) int
)

func Run(args []string, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		fmt.Fprintln(stderr, "usage: catalogctl <drift-edit|drift-propose|edit|expected-diff|onboard|plan-check|pr-prepare|window-check> [flags]")
		return 3
	}
	switch args[0] {
	case "drift-edit": // apply-time edit replay for a drift bundle request (spec)
		if DriftEdit == nil {
			fmt.Fprintln(stderr, "internal: drift-edit not wired")
			return 1
		}
		return DriftEdit(args[1:], stdout, stderr)
	case "drift-propose": // deterministic drift adopt/revert proposal generator (spec)
		if DriftPropose == nil {
			fmt.Fprintln(stderr, "internal: drift-propose not wired")
			return 1
		}
		return DriftPropose(args[1:], stdout, stderr)
	case "edit":
		if Edit == nil {
			fmt.Fprintln(stderr, "internal: edit not wired")
			return 1
		}
		return Edit(args[1:], stdout, stderr)
	case "expected-diff": // alias: edit --dry-run (spec)
		if Edit == nil {
			fmt.Fprintln(stderr, "internal: edit not wired")
			return 1
		}
		return Edit(append([]string{"--dry-run"}, args[1:]...), stdout, stderr)
	case "onboard": // untrusted-repo onboarding pipeline (spec)
		if Onboard == nil {
			fmt.Fprintln(stderr, "internal: onboard not wired")
			return 1
		}
		return Onboard(args[1:], stdout, stderr)
	case "plan-check": // request↔plan contract, the mechanical L2 verifier (spec)
		if PlanCheck == nil {
			fmt.Fprintln(stderr, "internal: plan-check not wired")
			return 1
		}
		return PlanCheck(args[1:], stdout, stderr)
	case "pr-prepare": // approved request → bot-PR artifact bundle
		if PRPrepare == nil {
			fmt.Fprintln(stderr, "internal: pr-prepare not wired")
			return 1
		}
		return PRPrepare(args[1:], stdout, stderr)
	case "window-check": // maintenance-window + cooling-off gate at a supplied instant
		if WindowCheck == nil {
			fmt.Fprintln(stderr, "internal: window-check not wired")
			return 1
		}
		return WindowCheck(args[1:], stdout, stderr)
	default:
		fmt.Fprintf(stderr, "unknown subcommand %q\n", args[0])
		return 3
	}
}

// Refuse prints the machine-greppable refusal line and returns exit code 2.
func Refuse(stderr io.Writer, code, reason string) int {
	fmt.Fprintf(stderr, "REFUSE %s: %s\n", code, reason)
	return 2
}
