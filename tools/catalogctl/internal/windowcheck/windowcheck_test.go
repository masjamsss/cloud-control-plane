package windowcheck

import (
	"bytes"
	"strings"
	"testing"
	"time"

	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/estatecfg"
	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/request"
)

// rfc parses an RFC3339 instant or fails the test — a terse helper for the tables.
func rfc(t *testing.T, s string) time.Time {
	t.Helper()
	ts, err := time.Parse(time.RFC3339, s)
	if err != nil {
		t.Fatalf("bad RFC3339 %q: %v", s, err)
	}
	return ts
}

func window(start, end string) *request.Window {
	return &request.Window{Start: start, End: end, TZ: "America/New_York"}
}

// mustCfg resolves an estatecfg.Config for tz or fails the test.
func mustCfg(t *testing.T, tz string) estatecfg.Config {
	t.Helper()
	cfg, err := estatecfg.Resolve(tz)
	if err != nil {
		t.Fatalf("estatecfg.Resolve(%q): %v", tz, err)
	}
	return cfg
}

// TestEvaluate drives the pure composition rule (0024 §0.2) across every branch at a
// SUPPLIED instant — no wall clock, so each row is deterministic. The window under test
// is 2026-07-12T18:00:00Z .. 22:00:00Z; cooling-off, when present, is called out.
func TestEvaluate(t *testing.T) {
	const (
		wStart = "2026-07-12T18:00:00Z"
		wEnd   = "2026-07-12T22:00:00Z"
	)
	cases := []struct {
		name     string
		req      *request.Request
		now      string
		want     Verdict
		wantCode int
		// wantOpens, when non-empty, asserts Result.OpensAt (the instant a BEFORE refusal clears).
		wantOpens string
	}{
		// --- no window, no cooling: always proceed ---
		{"no window / no cooling", &request.Request{}, "2026-01-01T00:00:00Z", NoWindow, 0, ""},

		// --- window gate only ---
		{"before window", &request.Request{Window: window(wStart, wEnd)}, "2026-07-12T17:00:00Z", BeforeWindow, 5, wStart},
		{"at start boundary is in-window", &request.Request{Window: window(wStart, wEnd)}, wStart, InWindow, 0, ""},
		{"inside window", &request.Request{Window: window(wStart, wEnd)}, "2026-07-12T19:30:00Z", InWindow, 0, ""},
		{"at end boundary is expired", &request.Request{Window: window(wStart, wEnd)}, wEnd, WindowExpired, 6, ""},
		{"after window is expired", &request.Request{Window: window(wStart, wEnd)}, "2026-07-12T23:00:00Z", WindowExpired, 6, ""},

		// --- cooling gate only (no window): window-check is the CI half of ADR-0009 ---
		{"cooling not met, no window", &request.Request{EarliestApplyAt: "2026-07-11T06:00:00Z"}, "2026-07-11T05:00:00Z", BeforeWindow, 5, "2026-07-11T06:00:00Z"},
		{"cooling met at boundary, no window", &request.Request{EarliestApplyAt: "2026-07-11T06:00:00Z"}, "2026-07-11T06:00:00Z", NoWindow, 0, ""},
		{"cooling met, no window", &request.Request{EarliestApplyAt: "2026-07-11T06:00:00Z"}, "2026-07-11T07:00:00Z", NoWindow, 0, ""},

		// --- both gates, conjunctive (0024 §0.2). Cooling ends at 19:00Z, inside the window. ---
		{"in window but cooling not met", &request.Request{EarliestApplyAt: "2026-07-12T19:00:00Z", Window: window(wStart, wEnd)}, "2026-07-12T18:30:00Z", BeforeWindow, 5, "2026-07-12T19:00:00Z"},
		{"in window and cooling met", &request.Request{EarliestApplyAt: "2026-07-12T19:00:00Z", Window: window(wStart, wEnd)}, "2026-07-12T19:00:00Z", InWindow, 0, ""},
		{"before both: opens_at is the later (cooling)", &request.Request{EarliestApplyAt: "2026-07-12T19:00:00Z", Window: window(wStart, wEnd)}, "2026-07-12T17:00:00Z", BeforeWindow, 5, "2026-07-12T19:00:00Z"},
		{"expiry beats cooling (both would refuse)", &request.Request{EarliestApplyAt: "2026-07-12T19:00:00Z", Window: window(wStart, wEnd)}, "2026-07-12T22:30:00Z", WindowExpired, 6, ""},

		// --- E10: cooling ends AFTER the window closes → never proceeds; opens_at is past end ---
		{"cooling after window end, still before end", &request.Request{EarliestApplyAt: "2026-07-13T00:00:00Z", Window: window(wStart, wEnd)}, "2026-07-12T19:00:00Z", BeforeWindow, 5, "2026-07-13T00:00:00Z"},
		{"cooling after window end, now past end", &request.Request{EarliestApplyAt: "2026-07-13T00:00:00Z", Window: window(wStart, wEnd)}, "2026-07-12T22:30:00Z", WindowExpired, 6, ""},

		// --- malformed schedules fail closed (0024 §5 E9), never "no window = apply freely" ---
		{"garbled window start", &request.Request{Window: &request.Window{Start: "nope", End: wEnd, TZ: "America/New_York"}}, "2026-07-12T19:00:00Z", ScheduleInvalid, 3, ""},
		{"start not before end", &request.Request{Window: &request.Window{Start: wEnd, End: wStart, TZ: "America/New_York"}}, "2026-07-12T19:00:00Z", ScheduleInvalid, 3, ""},
		{"wrong tz", &request.Request{Window: &request.Window{Start: wStart, End: wEnd, TZ: "Europe/London"}}, "2026-07-12T19:00:00Z", ScheduleInvalid, 3, ""},
		{"garbled earliest", &request.Request{EarliestApplyAt: "soon"}, "2026-07-12T19:00:00Z", ScheduleInvalid, 3, ""},
	}
	// The estate is configured to America/New_York to match the window() helper and the
	// inline window literals above (re-oracled from the original estate zone for the
	// public scrub) — so these cases keep proving the composition rule; the "wrong tz"
	// case uses a different zone (Europe/London) to prove the mismatch refusal, and the
	// tz-parameterization is proven separately below (TestEvaluateTZMismatch, TestEvaluateUTCDefaultWindow).
	cfg := mustCfg(t, "America/New_York")
	for _, c := range cases {
		c := c
		t.Run(c.name, func(t *testing.T) {
			res := Evaluate(c.req, rfc(t, c.now), cfg)
			if res.Verdict != c.want {
				t.Fatalf("verdict = %q, want %q (reason: %s)", res.Verdict, c.want, res.Reason)
			}
			if got := res.Verdict.ExitCode(); got != c.wantCode {
				t.Fatalf("exit code = %d, want %d", got, c.wantCode)
			}
			if c.wantOpens != "" {
				if res.OpensAt == nil {
					t.Fatalf("OpensAt = nil, want %s", c.wantOpens)
				}
				if !res.OpensAt.Equal(rfc(t, c.wantOpens)) {
					t.Fatalf("OpensAt = %s, want %s", res.OpensAt.Format(time.RFC3339), c.wantOpens)
				}
			}
		})
	}
}

// TestLineDeterministic proves the stdout verdict line is stable and carries UTC RFC3339
// tokens in the fixed order the gate script greps.
func TestLineDeterministic(t *testing.T) {
	res := Evaluate(&request.Request{EarliestApplyAt: "2026-07-12T19:00:00Z", Window: window("2026-07-12T18:00:00Z", "2026-07-12T22:00:00Z")}, rfc(t, "2026-07-12T17:00:00Z"), mustCfg(t, "America/New_York"))
	got := res.Line()
	want := "verdict=BEFORE_WINDOW now=2026-07-12T17:00:00Z start=2026-07-12T18:00:00Z end=2026-07-12T22:00:00Z earliest_apply_at=2026-07-12T19:00:00Z opens_at=2026-07-12T19:00:00Z"
	if got != want {
		t.Fatalf("Line() =\n  %q\nwant\n  %q", got, want)
	}
}

// TestNowNormalizedToUTC feeds a non-UTC offset instant and proves the comparison and
// the emitted tokens are UTC (0024 §0.3: instants are UTC; offsets are just notation).
func TestNowNormalizedToUTC(t *testing.T) {
	// 2026-07-12T19:00:00Z expressed as +07:00 wall time is 2026-07-13T02:00:00+07:00.
	res := Evaluate(&request.Request{Window: window("2026-07-12T18:00:00Z", "2026-07-12T22:00:00Z")}, rfc(t, "2026-07-13T02:00:00+07:00"), mustCfg(t, "America/New_York"))
	if res.Verdict != InWindow {
		t.Fatalf("verdict = %q, want IN_WINDOW (offset instant must normalize to UTC)", res.Verdict)
	}
	if !strings.Contains(res.Line(), "now=2026-07-12T19:00:00Z") {
		t.Fatalf("Line() = %q, want now token in UTC", res.Line())
	}
}

// --- the `run` seam: the subcommand exercised against the shared testdata/windows
//     fixtures at supplied instants, mirroring the golden-test harness style. ---

func runCmd(t *testing.T, args ...string) (int, string, string) {
	t.Helper()
	var out, errb bytes.Buffer
	code := run(args, &out, &errb)
	return code, out.String(), errb.String()
}

func TestRunFixtures(t *testing.T) {
	const dir = "../../testdata/windows/"
	cases := []struct {
		name        string
		fixture     string
		at          string
		wantCode    int
		wantVerdict Verdict
	}{
		{"windowed before", "windowed.yaml", "2026-07-12T17:00:00Z", 5, BeforeWindow},
		{"windowed inside", "windowed.yaml", "2026-07-12T19:00:00Z", 0, InWindow},
		{"windowed after", "windowed.yaml", "2026-07-12T23:00:00Z", 6, WindowExpired},
		{"no-window proceeds", "no-window.yaml", "2000-01-01T00:00:00Z", 0, NoWindow},
		{"cooling before", "cooling.yaml", "2026-07-11T05:00:00Z", 5, BeforeWindow},
		{"cooling met", "cooling.yaml", "2026-07-11T06:00:00Z", 0, NoWindow},
		{"cooling-window: in window, not cooled", "cooling-window.yaml", "2026-07-12T18:30:00Z", 5, BeforeWindow},
		{"cooling-window: in window, cooled", "cooling-window.yaml", "2026-07-12T20:00:00Z", 0, InWindow},
		{"garbled window fails closed", "garbled-window.yaml", "2026-07-12T19:00:00Z", 3, ScheduleInvalid},
	}
	for _, c := range cases {
		c := c
		t.Run(c.name, func(t *testing.T) {
			// These fixtures are all windowed at the pre-existing fixtures' own literal
			// tz value (or tz-agnostic, no window) — the test harness supplies the
			// matching estate config, proving the parameterization (estate-config,
			// ADR-0028); see TestRunEstateTZ* below for the UTC-default / mismatch /
			// startup coverage.
			code, out, errb := runCmd(t, "--request", dir+c.fixture, "--at", c.at, "--estate-tz", "America/New_York")
			if code != c.wantCode {
				t.Fatalf("exit = %d, want %d\nstdout: %s\nstderr: %s", code, c.wantCode, out, errb)
			}
			if !strings.Contains(out, "verdict="+string(c.wantVerdict)) {
				t.Fatalf("stdout missing verdict=%s\nstdout: %s", c.wantVerdict, out)
			}
			// A refusal must name a reason on stderr (0024 §3.2: "stderr says which, and when it opens").
			if c.wantCode != 0 && !strings.Contains(errb, "REFUSE") {
				t.Fatalf("refusal missing REFUSE line on stderr\nstderr: %s", errb)
			}
		})
	}
}

// TestRunAtIsRequired proves the library reads no wall clock: with no --at (and no --now
// alias) the subcommand refuses rather than defaulting to time.Now (0024 §3.2).
func TestRunAtIsRequired(t *testing.T) {
	code, _, errb := runCmd(t, "--request", "../../testdata/windows/windowed.yaml")
	if code != 3 {
		t.Fatalf("exit = %d, want 3 for missing --at", code)
	}
	if !strings.Contains(errb, "--at") {
		t.Fatalf("stderr = %q, want it to name the required --at flag", errb)
	}
}

// TestRunNowAlias proves --now is accepted as the 0024-prose alias for --at (still no
// wall-clock fallback).
func TestRunNowAlias(t *testing.T) {
	code, out, _ := runCmd(t, "--request", "../../testdata/windows/windowed.yaml", "--now", "2026-07-12T19:00:00Z", "--estate-tz", "America/New_York")
	if code != 0 {
		t.Fatalf("exit = %d, want 0 with --now inside the window", code)
	}
	if !strings.Contains(out, "verdict=IN_WINDOW") {
		t.Fatalf("stdout = %q, want IN_WINDOW", out)
	}
}

// TestRunBadAt proves a non-RFC3339 --at is a usage error (exit 3), not a panic.
func TestRunBadAt(t *testing.T) {
	code, _, errb := runCmd(t, "--request", "../../testdata/windows/windowed.yaml", "--at", "yesterday")
	if code != 3 {
		t.Fatalf("exit = %d, want 3 for non-RFC3339 --at", code)
	}
	if !strings.Contains(errb, "RFC3339") {
		t.Fatalf("stderr = %q, want it to explain RFC3339", errb)
	}
}

// --- estate-config (ADR-0028, #37): Evaluate's own tz recheck (defense in depth —
//     the doc comment: "any residual parse failure is still treated as
//     SCHEDULE_INVALID ... even if called on an unvalidated request"). ---

// TestEvaluateTZMismatch calls Evaluate directly (bypassing request.Load entirely)
// with a request windowed at a DIFFERENT tz than the configured estate (any
// non-matching value proves the same codepath — TestEvaluate's table above already
// covers the pre-existing fixtures' own literal tz value end-to-end) — proving the
// pure function's own recheck (windowcheck.go line ~117) fails closed, not just Load's.
func TestEvaluateTZMismatch(t *testing.T) {
	req := &request.Request{Window: &request.Window{Start: "2026-07-12T18:00:00Z", End: "2026-07-12T22:00:00Z", TZ: "America/New_York"}}
	res := Evaluate(req, rfc(t, "2026-07-12T19:00:00Z"), mustCfg(t, "UTC"))
	if res.Verdict != ScheduleInvalid {
		t.Fatalf("verdict = %q, want SCHEDULE_INVALID (reason: %s)", res.Verdict, res.Reason)
	}
	if res.Verdict.ExitCode() != 3 {
		t.Fatalf("ExitCode() = %d, want 3", res.Verdict.ExitCode())
	}
	if !strings.Contains(res.Reason, "UTC") {
		t.Fatalf("Reason = %q, want it to name the configured estate tz (UTC)", res.Reason)
	}
}

// TestEvaluateUTCDefaultWindow proves the blank-install default path at the pure
// Evaluate layer: a window declared tz: UTC validates cleanly against the compiled
// DefaultEstateTZ, with the same InWindow verdict TestEvaluate's table proves for an
// equivalent instant/window shape under a non-default estate.
func TestEvaluateUTCDefaultWindow(t *testing.T) {
	req := &request.Request{Window: &request.Window{Start: "2026-07-12T18:00:00Z", End: "2026-07-12T22:00:00Z", TZ: "UTC"}}
	res := Evaluate(req, rfc(t, "2026-07-12T19:00:00Z"), mustCfg(t, "")) // "" resolves to DefaultEstateTZ ("UTC")
	if res.Verdict != InWindow {
		t.Fatalf("verdict = %q, want IN_WINDOW (reason: %s)", res.Verdict, res.Reason)
	}
}

// --- estate-config (ADR-0028, #37): the `window-check` subcommand end-to-end —
//     UTC default, cross-estate mismatch, and the startup-config-error path. ---

// TestRunEstateTZUTCDefault proves the CLI's default path: with NO --estate-tz flag,
// a request windowed at tz: UTC passes against the compiled DefaultEstateTZ. Uses the
// new testdata/windows/windowed-utc.yaml fixture (spec §5.4: "small tz: UTC fixtures
// for the default path") — windowed.yaml's shape, mirrored, tz changed to UTC only.
func TestRunEstateTZUTCDefault(t *testing.T) {
	code, out, errb := runCmd(t, "--request", "../../testdata/windows/windowed-utc.yaml", "--at", "2026-07-12T19:00:00Z")
	if code != 0 {
		t.Fatalf("exit = %d, want 0 (UTC request against the UTC default estate)\nstdout: %s\nstderr: %s", code, out, errb)
	}
	if !strings.Contains(out, "verdict=IN_WINDOW") {
		t.Fatalf("stdout = %q, want IN_WINDOW", out)
	}
}

// TestRunEstateTZMismatch is the mismatch test (spec §5.4): windowed.yaml — windowed
// at the pre-existing fixtures' own literal tz value — run with NO --estate-tz (so
// the default estate is UTC) must fail closed as SCHEDULE_INVALID, exit 3, with the
// new message — never silently pass and never fall back to the old "no window =
// apply freely" behaviour.
func TestRunEstateTZMismatch(t *testing.T) {
	code, out, errb := runCmd(t, "--request", "../../testdata/windows/windowed.yaml", "--at", "2026-07-12T19:00:00Z")
	if code != 3 {
		t.Fatalf("exit = %d, want 3 (a cross-estate tz mismatch against the UTC default estate)\nstdout: %s\nstderr: %s", code, out, errb)
	}
	if !strings.Contains(out, "verdict="+string(ScheduleInvalid)) {
		t.Fatalf("stdout = %q, want verdict=SCHEDULE_INVALID", out)
	}
	if !strings.Contains(errb, "estate operating timezone") {
		t.Fatalf("stderr = %q, want it to name the estate operating timezone mismatch", errb)
	}
}

// TestRunEstateTZStartupError is the startup test (spec §5.3/§5.4): an unresolvable
// --estate-tz name is a startup config error, refused BEFORE any verdict is produced
// — exit 3, and (unlike a SCHEDULE_INVALID verdict) nothing at all on stdout, since
// resolution fails ahead of request.Load / Evaluate.
func TestRunEstateTZStartupError(t *testing.T) {
	code, out, errb := runCmd(t, "--request", "../../testdata/windows/windowed.yaml", "--at", "2026-07-12T19:00:00Z", "--estate-tz", "Not/AZone")
	if code != 3 {
		t.Fatalf("exit = %d, want 3 for an unresolvable --estate-tz\nstdout: %s\nstderr: %s", code, out, errb)
	}
	if out != "" {
		t.Fatalf("stdout = %q, want empty — a startup config error precedes any verdict line", out)
	}
	if !strings.Contains(errb, "Not/AZone") {
		t.Fatalf("stderr = %q, want it to name the bad --estate-tz value", errb)
	}
}
