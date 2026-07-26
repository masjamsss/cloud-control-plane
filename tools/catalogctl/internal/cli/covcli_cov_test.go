package cli

import (
	"bytes"
	"fmt"
	"io"
	"strings"
	"testing"
)

// covclihandler is the shape of every dispatch slot installed by a subcommand
// package's init().
type covclihandler = func(args []string, stdout, stderr io.Writer) int

// covclislots returns a pointer to every dispatch slot, keyed by the subcommand
// word Run switches on. "expected-diff" is deliberately absent: it is an alias
// that shares the Edit slot.
func covclislots() map[string]*covclihandler {
	return map[string]*covclihandler{
		"drift-edit":    &DriftEdit,
		"drift-propose": &DriftPropose,
		"edit":          &Edit,
		"onboard":       &Onboard,
		"plan-check":    &PlanCheck,
		"pr-prepare":    &PRPrepare,
		"scan-worker":   &ScanWorker,
		"window-check":  &WindowCheck,
	}
}

// covclireset clears every dispatch slot for the duration of the test and
// restores the previous values on cleanup, so a test never observes (or leaks)
// wiring installed by another test.
func covclireset(t *testing.T) {
	t.Helper()
	for _, slot := range covclislots() {
		slot := slot
		saved := *slot
		t.Cleanup(func() { *slot = saved })
		*slot = nil
	}
}

// covclicall records one invocation of an installed dispatch slot.
type covclicall struct {
	args   []string
	stdout io.Writer
	stderr io.Writer
	calls  int
}

// covcliinstall clears all slots, then installs a recording stub returning
// ret into the slot named by name.
func covcliinstall(t *testing.T, name string, ret int) *covclicall {
	t.Helper()
	covclireset(t)
	slot, ok := covclislots()[name]
	if !ok {
		t.Fatalf("no dispatch slot named %q", name)
	}
	rec := &covclicall{}
	*slot = func(args []string, stdout, stderr io.Writer) int {
		rec.calls++
		rec.args = args
		rec.stdout = stdout
		rec.stderr = stderr
		fmt.Fprintf(stdout, "stub-out:%s\n", name)
		fmt.Fprintf(stderr, "stub-err:%s\n", name)
		return ret
	}
	return rec
}

func TestCovcliRunNoArgsPrintsUsageAndExits3(t *testing.T) {
	covclireset(t)
	var out, errb bytes.Buffer
	if code := Run(nil, &out, &errb); code != 3 {
		t.Fatalf("exit = %d, want 3", code)
	}
	if out.Len() != 0 {
		t.Fatalf("stdout = %q, want empty", out.String())
	}
	got := errb.String()
	if !strings.HasPrefix(got, "usage: catalogctl ") {
		t.Fatalf("stderr = %q, want a usage line", got)
	}
	if !strings.HasSuffix(got, "\n") {
		t.Fatalf("stderr = %q, want trailing newline", got)
	}
	// The usage line is the discoverability contract: it must name every
	// subcommand Run can dispatch, including the expected-diff alias.
	for _, sub := range []string{
		"drift-edit", "drift-propose", "edit", "expected-diff", "onboard",
		"plan-check", "pr-prepare", "scan-worker", "window-check",
	} {
		if !strings.Contains(got, sub) {
			t.Errorf("usage line %q does not mention subcommand %q", got, sub)
		}
	}
	if !strings.Contains(got, "[flags]") {
		t.Errorf("usage line %q does not mention [flags]", got)
	}
}

func TestCovcliRunEmptySliceArgsPrintsUsage(t *testing.T) {
	covclireset(t)
	var out, errb bytes.Buffer
	if code := Run([]string{}, &out, &errb); code != 3 {
		t.Fatalf("exit = %d, want 3", code)
	}
	if !strings.HasPrefix(errb.String(), "usage: catalogctl ") {
		t.Fatalf("stderr = %q, want a usage line", errb.String())
	}
}

func TestCovcliRunNotWiredExits1(t *testing.T) {
	// Every subcommand has an unwired branch that must fail closed with exit
	// code 1 (internal error), not 0 and not a panic.
	cases := []struct {
		name string
		args []string
		want string
	}{
		{"drift-edit", []string{"drift-edit"}, "internal: drift-edit not wired"},
		{"drift-propose", []string{"drift-propose"}, "internal: drift-propose not wired"},
		{"edit", []string{"edit"}, "internal: edit not wired"},
		{"expected-diff", []string{"expected-diff"}, "internal: edit not wired"},
		{"onboard", []string{"onboard"}, "internal: onboard not wired"},
		{"plan-check", []string{"plan-check"}, "internal: plan-check not wired"},
		{"pr-prepare", []string{"pr-prepare"}, "internal: pr-prepare not wired"},
		{"scan-worker", []string{"scan-worker"}, "internal: scan-worker not wired"},
		{"window-check", []string{"window-check"}, "internal: window-check not wired"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			covclireset(t)
			var out, errb bytes.Buffer
			// Extra flags must not change the unwired outcome.
			args := append(append([]string{}, tc.args...), "--whatever", "x")
			if code := Run(args, &out, &errb); code != 1 {
				t.Fatalf("exit = %d, want 1", code)
			}
			if got := errb.String(); got != tc.want+"\n" {
				t.Fatalf("stderr = %q, want %q", got, tc.want+"\n")
			}
			if out.Len() != 0 {
				t.Fatalf("stdout = %q, want empty", out.String())
			}
		})
	}
}

func TestCovcliRunDispatchesToInstalledHandler(t *testing.T) {
	// slot is the dispatch slot the subcommand word must reach; wantArgs is
	// what the handler must receive for argv = append([]string{word}, "--a", "b").
	cases := []struct {
		word     string
		slot     string
		wantArgs []string
	}{
		{"drift-edit", "drift-edit", []string{"--a", "b"}},
		{"drift-propose", "drift-propose", []string{"--a", "b"}},
		{"edit", "edit", []string{"--a", "b"}},
		// expected-diff is an alias for `edit --dry-run`: it reaches the Edit
		// slot with --dry-run prepended ahead of the caller's own flags.
		{"expected-diff", "edit", []string{"--dry-run", "--a", "b"}},
		{"onboard", "onboard", []string{"--a", "b"}},
		{"plan-check", "plan-check", []string{"--a", "b"}},
		{"pr-prepare", "pr-prepare", []string{"--a", "b"}},
		{"scan-worker", "scan-worker", []string{"--a", "b"}},
		{"window-check", "window-check", []string{"--a", "b"}},
	}
	for _, tc := range cases {
		t.Run(tc.word, func(t *testing.T) {
			// A non-zero handler code must be returned verbatim: Run owns
			// dispatch, the subcommand owns the exit code.
			const want = 2
			rec := covcliinstall(t, tc.slot, want)
			var out, errb bytes.Buffer
			code := Run([]string{tc.word, "--a", "b"}, &out, &errb)
			if code != want {
				t.Fatalf("exit = %d, want %d (handler's code, passed through)", code, want)
			}
			if rec.calls != 1 {
				t.Fatalf("handler called %d times, want 1", rec.calls)
			}
			if got := strings.Join(rec.args, " "); got != strings.Join(tc.wantArgs, " ") {
				t.Fatalf("handler args = %q, want %q", rec.args, tc.wantArgs)
			}
			// The handler must get the caller's own writers, not copies.
			if rec.stdout != io.Writer(&out) {
				t.Errorf("handler stdout = %v, want the caller's stdout", rec.stdout)
			}
			if rec.stderr != io.Writer(&errb) {
				t.Errorf("handler stderr = %v, want the caller's stderr", rec.stderr)
			}
			if got := out.String(); got != "stub-out:"+tc.slot+"\n" {
				t.Errorf("stdout = %q, want the handler's output", got)
			}
			if got := errb.String(); got != "stub-err:"+tc.slot+"\n" {
				t.Errorf("stderr = %q, want the handler's output", got)
			}
		})
	}
}

func TestCovcliRunPassesThroughEveryExitCode(t *testing.T) {
	// 0 ok · 1 internal · 2 refusal · 3 resolution/schema — Run must not
	// rewrite any of them.
	for _, want := range []int{0, 1, 2, 3} {
		t.Run(fmt.Sprintf("code%d", want), func(t *testing.T) {
			covcliinstall(t, "edit", want)
			var out, errb bytes.Buffer
			if code := Run([]string{"edit", "--file", "main.tf"}, &out, &errb); code != want {
				t.Fatalf("exit = %d, want %d", code, want)
			}
		})
	}
}

func TestCovcliRunForwardsNoArgsToHandler(t *testing.T) {
	// A bare subcommand hands the handler an empty (not nil-hostile) arg list.
	rec := covcliinstall(t, "scan-worker", 0)
	var out, errb bytes.Buffer
	if code := Run([]string{"scan-worker"}, &out, &errb); code != 0 {
		t.Fatalf("exit = %d, want 0", code)
	}
	if len(rec.args) != 0 {
		t.Fatalf("handler args = %q, want none", rec.args)
	}
}

func TestCovcliExpectedDiffAlwaysPrependsDryRun(t *testing.T) {
	// The alias must not merely contain --dry-run: it must lead, so a later
	// caller-supplied flag can never be swallowed by it and the flag package
	// sees it before any positional terminator.
	cases := []struct {
		name     string
		argv     []string
		wantArgs []string
	}{
		{"bare", []string{"expected-diff"}, []string{"--dry-run"}},
		{"with flags", []string{"expected-diff", "--op", "setattr"}, []string{"--dry-run", "--op", "setattr"}},
		{"caller also passed dry-run", []string{"expected-diff", "--dry-run"}, []string{"--dry-run", "--dry-run"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := covcliinstall(t, "edit", 0)
			var out, errb bytes.Buffer
			if code := Run(tc.argv, &out, &errb); code != 0 {
				t.Fatalf("exit = %d, want 0", code)
			}
			if strings.Join(rec.args, " ") != strings.Join(tc.wantArgs, " ") {
				t.Fatalf("Edit args = %q, want %q", rec.args, tc.wantArgs)
			}
			if len(rec.args) == 0 || rec.args[0] != "--dry-run" {
				t.Fatalf("Edit args = %q, want --dry-run first", rec.args)
			}
		})
	}
}

func TestCovcliExpectedDiffDoesNotMutateCallerArgv(t *testing.T) {
	rec := covcliinstall(t, "edit", 0)
	argv := []string{"expected-diff", "--op", "setattr"}
	want := strings.Join(argv, " ")
	var out, errb bytes.Buffer
	if code := Run(argv, &out, &errb); code != 0 {
		t.Fatalf("exit = %d, want 0", code)
	}
	if got := strings.Join(argv, " "); got != want {
		t.Fatalf("argv mutated: %q, want %q", got, want)
	}
	// Writing through the handler's slice must not reach into argv either.
	rec.args[0] = "clobbered"
	if got := strings.Join(argv, " "); got != want {
		t.Fatalf("handler args alias argv: %q, want %q", got, want)
	}
}

func TestCovcliRunUnknownSubcommandQuotesItAndExits3(t *testing.T) {
	// The unknown-subcommand path must be a resolution error (3), never a
	// silent success, and must quote the token so shell noise is visible.
	cases := []struct {
		name string
		word string
		want string
	}{
		{"plain word", "frobnicate", `unknown subcommand "frobnicate"` + "\n"},
		{"looks like a flag", "--help", `unknown subcommand "--help"` + "\n"},
		{"empty string", "", `unknown subcommand ""` + "\n"},
		{"near miss", "Edit", `unknown subcommand "Edit"` + "\n"},
		{"trailing space", "edit ", `unknown subcommand "edit "` + "\n"},
		{"alias not a slot", "dry-run", `unknown subcommand "dry-run"` + "\n"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			// Wiring everything up must not rescue an unknown word.
			covcliinstall(t, "edit", 0)
			var out, errb bytes.Buffer
			if code := Run([]string{tc.word, "extra"}, &out, &errb); code != 3 {
				t.Fatalf("exit = %d, want 3", code)
			}
			if got := errb.String(); got != tc.want {
				t.Fatalf("stderr = %q, want %q", got, tc.want)
			}
			if out.Len() != 0 {
				t.Fatalf("stdout = %q, want empty", out.String())
			}
		})
	}
}

func TestCovcliRunDispatchIsExhaustiveOverSlots(t *testing.T) {
	// Guards against a slot being added to the package without a case in Run:
	// every named slot must be reachable by its own subcommand word.
	for word := range covclislots() {
		t.Run(word, func(t *testing.T) {
			rec := covcliinstall(t, word, 0)
			var out, errb bytes.Buffer
			if code := Run([]string{word}, &out, &errb); code != 0 {
				t.Fatalf("Run(%q) exit = %d, want 0 — slot not dispatched?", word, code)
			}
			if rec.calls != 1 {
				t.Fatalf("Run(%q) called slot %d times, want 1", word, rec.calls)
			}
		})
	}
}

func TestCovcliRefuse(t *testing.T) {
	cases := []struct {
		name   string
		code   string
		reason string
		want   string
	}{
		{"forces replace", "FORCES_REPLACE", "manifest does not permit replacement", "REFUSE FORCES_REPLACE: manifest does not permit replacement\n"},
		{"prevent destroy", "PREVENT_DESTROY", "lifecycle.prevent_destroy = true", "REFUSE PREVENT_DESTROY: lifecycle.prevent_destroy = true\n"},
		{"multiline reason is kept verbatim", "SELECTOR_AMBIGUOUS", "matched 2 blocks:\n  a\n  b", "REFUSE SELECTOR_AMBIGUOUS: matched 2 blocks:\n  a\n  b\n"},
		{"reason with percent verb is not expanded", "EMPTY_DIFF", "no change for %s", "REFUSE EMPTY_DIFF: no change for %s\n"},
		{"empty reason", "FMT_DIRTY", "", "REFUSE FMT_DIRTY: \n"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var errb bytes.Buffer
			if code := Refuse(&errb, tc.code, tc.reason); code != 2 {
				t.Fatalf("code = %d, want 2 (refusal)", code)
			}
			if got := errb.String(); got != tc.want {
				t.Fatalf("stderr = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestCovcliRefuseWritesOnlyToGivenWriter(t *testing.T) {
	var errb bytes.Buffer
	Refuse(&errb, "UNAPPROVED", "request lacks an approval record")
	// Greppability contract: exactly one line, prefixed REFUSE, code before
	// the first colon.
	lines := strings.Split(strings.TrimSuffix(errb.String(), "\n"), "\n")
	if len(lines) != 1 {
		t.Fatalf("got %d lines, want 1: %q", len(lines), errb.String())
	}
	fields := strings.SplitN(lines[0], " ", 3)
	if len(fields) != 3 || fields[0] != "REFUSE" || fields[1] != "UNAPPROVED:" {
		t.Fatalf("line = %q, want `REFUSE UNAPPROVED: <reason>`", lines[0])
	}
}

// covclifailingWriter fails every write, standing in for a closed pipe.
type covclifailingWriter struct{ n int }

func (w *covclifailingWriter) Write(p []byte) (int, error) {
	w.n++
	return 0, io.ErrClosedPipe
}

func TestCovcliRefuseIgnoresWriteErrors(t *testing.T) {
	// Refuse's exit code is the contract; a dead stderr must not change it.
	w := &covclifailingWriter{}
	if code := Refuse(w, "SHRINK", "capacity would shrink"); code != 2 {
		t.Fatalf("code = %d, want 2", code)
	}
	if w.n == 0 {
		t.Fatal("Refuse did not attempt a write")
	}
}

func TestCovcliRunIgnoresWriteErrors(t *testing.T) {
	// Same for the diagnostics Run itself emits: usage, unknown subcommand,
	// and the not-wired path all keep their exit codes on a dead stderr.
	cases := []struct {
		name string
		args []string
		want int
	}{
		{"usage", nil, 3},
		{"unknown", []string{"nope"}, 3},
		{"not wired", []string{"edit"}, 1},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			covclireset(t)
			w := &covclifailingWriter{}
			if code := Run(tc.args, io.Discard, w); code != tc.want {
				t.Fatalf("exit = %d, want %d", code, tc.want)
			}
			if w.n == 0 {
				t.Fatal("no diagnostic was written")
			}
		})
	}
}
