package windowcheck

import (
	"bytes"
	"strings"
	"testing"
	"time"

	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/estatecfg"
	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/request"
)

// covwindowRFC parses an RFC3339 instant or fails the test.
func covwindowRFC(t *testing.T, s string) time.Time {
	t.Helper()
	ts, err := time.Parse(time.RFC3339, s)
	if err != nil {
		t.Fatalf("bad RFC3339 %q: %v", s, err)
	}
	return ts
}

// covwindowCfg resolves an estatecfg.Config for tz or fails the test.
func covwindowCfg(t *testing.T, tz string) estatecfg.Config {
	t.Helper()
	cfg, err := estatecfg.Resolve(tz)
	if err != nil {
		t.Fatalf("estatecfg.Resolve(%q): %v", tz, err)
	}
	return cfg
}

// covwindowRun invokes the subcommand seam and returns (exit, stdout, stderr).
func covwindowRun(t *testing.T, args ...string) (int, string, string) {
	t.Helper()
	var out, errb bytes.Buffer
	code := run(args, &out, &errb)
	return code, out.String(), errb.String()
}

// TestCovwindowOpensAtIsTheLaterGate closes the conjunction's remaining arm: when the
// cooling instant clears BEFORE the maintenance window opens, the reported opens_at is
// the WINDOW START, not the (already earlier) cooling instant — the composition rule
// says the change can only proceed once both gates are open, so the operator must be
// told the later of the two. The mirror case (cooling later than the window start) is
// already covered by TestEvaluate; both are asserted here side by side so the "later
// of the two" contract is legible in one place.
func TestCovwindowOpensAtIsTheLaterGate(t *testing.T) {
	const (
		wStart = "2026-07-12T18:00:00Z"
		wEnd   = "2026-07-12T22:00:00Z"
	)
	cases := []struct {
		name      string
		earliest  string
		now       string
		wantOpens string
	}{
		{
			// Cooling ends at 17:00, window opens at 18:00 → opens_at is the window start.
			name:      "cooling clears before the window opens",
			earliest:  "2026-07-12T17:00:00Z",
			now:       "2026-07-12T16:00:00Z",
			wantOpens: wStart,
		},
		{
			// Degenerate tie: cooling ends exactly when the window opens.
			name:      "cooling ends exactly at the window start",
			earliest:  wStart,
			now:       "2026-07-12T17:59:59Z",
			wantOpens: wStart,
		},
		{
			// Cooling ends at 19:00, inside the window → cooling is the later gate.
			name:      "window opens before cooling clears",
			earliest:  "2026-07-12T19:00:00Z",
			now:       "2026-07-12T16:00:00Z",
			wantOpens: "2026-07-12T19:00:00Z",
		},
	}
	cfg := covwindowCfg(t, "UTC")
	for _, c := range cases {
		c := c
		t.Run(c.name, func(t *testing.T) {
			req := &request.Request{
				EarliestApplyAt: c.earliest,
				Window:          &request.Window{Start: wStart, End: wEnd, TZ: "UTC"},
			}
			res := Evaluate(req, covwindowRFC(t, c.now), cfg)
			if res.Verdict != BeforeWindow {
				t.Fatalf("verdict = %q, want BEFORE_WINDOW (reason: %s)", res.Verdict, res.Reason)
			}
			if got := res.Verdict.ExitCode(); got != 5 {
				t.Fatalf("exit code = %d, want 5", got)
			}
			if res.OpensAt == nil {
				t.Fatalf("OpensAt = nil, want %s", c.wantOpens)
			}
			if !res.OpensAt.Equal(covwindowRFC(t, c.wantOpens)) {
				t.Fatalf("OpensAt = %s, want %s (opens_at must be the LATER of cooling and window start)",
					res.OpensAt.UTC().Format(time.RFC3339), c.wantOpens)
			}
			// The stdout token the gate script greps must agree with the struct field.
			if !strings.Contains(res.Line(), "opens_at="+c.wantOpens) {
				t.Fatalf("Line() = %q, want opens_at=%s", res.Line(), c.wantOpens)
			}
			// The cooling-gate refusal names BOTH instants so the operator sees why.
			if !strings.Contains(res.Reason, "cooling-off until") || !strings.Contains(res.Reason, "window opens") {
				t.Fatalf("Reason = %q, want it to name both the cooling instant and the window start", res.Reason)
			}
		})
	}
}

// TestCovwindowRunFlagParseError proves a malformed flag surface is a usage error
// (exit 3, fail closed), never a silent proceed and never a panic. -h is included
// because flag.ContinueOnError reports help as an error too, and printing usage must
// not be mistaken for a passing gate.
func TestCovwindowRunFlagParseError(t *testing.T) {
	cases := []struct {
		name    string
		args    []string
		wantErr string
	}{
		{"undefined flag", []string{"--bogus", "1", "--request", "x.yaml", "--at", "2026-07-12T19:00:00Z"}, "bogus"},
		{"missing value for --at", []string{"--request", "x.yaml", "--at"}, "-at"},
		{"help request", []string{"-h"}, "-request"},
	}
	for _, c := range cases {
		c := c
		t.Run(c.name, func(t *testing.T) {
			code, out, errb := covwindowRun(t, c.args...)
			if code != 3 {
				t.Fatalf("exit = %d, want 3 for a flag-parse failure\nstdout: %s\nstderr: %s", code, out, errb)
			}
			if out != "" {
				t.Fatalf("stdout = %q, want empty — a usage failure must not emit a verdict line", out)
			}
			if !strings.Contains(errb, c.wantErr) {
				t.Fatalf("stderr = %q, want it to mention %q", errb, c.wantErr)
			}
		})
	}
}

// TestCovwindowRunRequestRequired proves --request is mandatory: with a perfectly good
// --at but no request path the subcommand refuses with exit 3 and no verdict line,
// rather than evaluating an empty request as "no window = apply freely".
func TestCovwindowRunRequestRequired(t *testing.T) {
	t.Run("missing --request with a valid --at", func(t *testing.T) {
		code, out, errb := covwindowRun(t, "--at", "2026-07-12T19:00:00Z", "--estate-tz", "UTC")
		if code != 3 {
			t.Fatalf("exit = %d, want 3\nstdout: %s\nstderr: %s", code, out, errb)
		}
		if out != "" {
			t.Fatalf("stdout = %q, want empty — a usage failure precedes any verdict", out)
		}
		if !strings.Contains(errb, "--request is required") {
			t.Fatalf("stderr = %q, want it to name the required --request flag", errb)
		}
	})

	t.Run("neither --request nor --at names --request first", func(t *testing.T) {
		code, out, errb := covwindowRun(t, "--estate-tz", "UTC")
		if code != 3 {
			t.Fatalf("exit = %d, want 3\nstdout: %s\nstderr: %s", code, out, errb)
		}
		if !strings.Contains(errb, "--request is required") {
			t.Fatalf("stderr = %q, want the --request usage error to be reported first", errb)
		}
	})

	t.Run("estate-config startup error precedes the --request check", func(t *testing.T) {
		// Documented ordering: the estate config is resolved before any usage check, so
		// an unresolvable zone is reported even when --request is also missing.
		code, out, errb := covwindowRun(t, "--estate-tz", "Not/AZone")
		if code != 3 {
			t.Fatalf("exit = %d, want 3\nstdout: %s\nstderr: %s", code, out, errb)
		}
		if out != "" {
			t.Fatalf("stdout = %q, want empty", out)
		}
		if !strings.Contains(errb, "Not/AZone") {
			t.Fatalf("stderr = %q, want the estate-tz startup error, not the --request usage error", errb)
		}
		if strings.Contains(errb, "--request is required") {
			t.Fatalf("stderr = %q, want the startup config error to short-circuit the --request check", errb)
		}
	})
}

// TestCovwindowRunMissingRequestFile proves a --request path that does not exist is a
// fail-closed SCHEDULE_INVALID: exit 3, a verdict line on stdout carrying the supplied
// --at instant, and a greppable REFUSE line on stderr.
func TestCovwindowRunMissingRequestFile(t *testing.T) {
	missing := t.TempDir() + "/absent.yaml"
	code, out, errb := covwindowRun(t, "--request", missing, "--at", "2026-07-12T19:00:00Z", "--estate-tz", "UTC")
	if code != ScheduleInvalid.ExitCode() {
		t.Fatalf("exit = %d, want %d\nstdout: %s\nstderr: %s", code, ScheduleInvalid.ExitCode(), out, errb)
	}
	if !strings.Contains(out, "verdict="+string(ScheduleInvalid)) {
		t.Fatalf("stdout = %q, want verdict=SCHEDULE_INVALID", out)
	}
	if !strings.Contains(out, "now=2026-07-12T19:00:00Z") {
		t.Fatalf("stdout = %q, want the supplied --at instant echoed as the now token", out)
	}
	if !strings.Contains(errb, "REFUSE "+string(ScheduleInvalid)) {
		t.Fatalf("stderr = %q, want a greppable REFUSE SCHEDULE_INVALID line", errb)
	}
}

// TestCovwindowVerdictExitCodeTotality pins the verdict→exit-code contract, including
// the fail-closed default for an unknown token: exit codes are the whole interface CI
// dispatches on, so an unmapped verdict must never read as 0.
func TestCovwindowVerdictExitCodeTotality(t *testing.T) {
	cases := map[Verdict]int{
		InWindow:                 0,
		NoWindow:                 0,
		BeforeWindow:             5,
		WindowExpired:            6,
		ScheduleInvalid:          3,
		Verdict(""):              3,
		Verdict("SOMETHING_NEW"): 3,
	}
	for v, want := range cases {
		if got := v.ExitCode(); got != want {
			t.Errorf("Verdict(%q).ExitCode() = %d, want %d", string(v), got, want)
		}
	}
}
