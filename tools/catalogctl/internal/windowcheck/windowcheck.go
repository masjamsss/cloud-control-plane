// Package windowcheck evaluates the scheduling composition rule — the
// cooling gate and the maintenance-window gate — for a ccp.request/v1 at a
// SUPPLIED instant. It reads no wall clock: the instant is injected (--at, required),
// so every verdict is a deterministic table test (testability-first mandate).
//
// Freeze — the absolute veto that precedes both gates — is deliberately
// NOT evaluated here. The api's freeze state is invisible to CI (no api reachability;
// ), so it is sourced from the CI plane as the CCP_FREEZE repo variable
// by scripts/ci/apply-window-gate.sh, which prepends the freeze veto before calling
// this subcommand. This library owns exactly the two time gates.
//
// Composition, applied at instant now (cooling ∧ window):
//
//	(earliestApplyAt = ∅ ∨ now ≥ earliestApplyAt) ∧ (window = ∅ ∨ start ≤ now < end)
//
// with expiry (now ≥ end) taking precedence over every other reason: an expired window
// is a hard, terminal refusal with its own exit code.
package windowcheck

import (
	"fmt"
	"time"

	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/estatecfg"
	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/request"
)

// Verdict is the machine-readable outcome token (stable across releases; scripts and
// golden tests grep it).
type Verdict string

const (
	// InWindow: a window is set and start ≤ now < end, and cooling (if any) is satisfied.
	InWindow Verdict = "IN_WINDOW"
	// NoWindow: no maintenance window, and cooling (if any) is satisfied — proceed.
	NoWindow Verdict = "NO_WINDOW"
	// BeforeWindow: not yet — now < earliestApplyAt and/or now < start.
	BeforeWindow Verdict = "BEFORE_WINDOW"
	// WindowExpired: now ≥ end — hard, terminal refusal (re-window required).
	WindowExpired Verdict = "WINDOW_EXPIRED"
	// ScheduleInvalid: window/earliest fields malformed — fail closed, never "apply freely".
	ScheduleInvalid Verdict = "SCHEDULE_INVALID"
)

// ExitCode maps a verdict to the process exit code:
//
//	0  IN_WINDOW / NO_WINDOW   → proceed
//	5  BEFORE_WINDOW           → not yet (cooling and/or window); stderr says when it opens
//	6  WINDOW_EXPIRED          → hard refusal, its own code
//	3  SCHEDULE_INVALID        → parse/schema, fail closed
func (v Verdict) ExitCode() int {
	switch v {
	case InWindow, NoWindow:
		return 0
	case BeforeWindow:
		return 5
	case WindowExpired:
		return 6
	default:
		return 3
	}
}

// Result is the machine-readable outcome of one evaluation.
type Result struct {
	Verdict         Verdict
	Now             time.Time
	Start           *time.Time // window bounds, when a window is set and well-formed
	End             *time.Time
	EarliestApplyAt *time.Time // cooling instant, when set
	OpensAt         *time.Time // when a BEFORE_WINDOW refusal clears: max(earliest, start)
	Reason          string     // human sentence (RFC3339), for stderr
}

// Evaluate applies the composition rule at instant now. It is pure: no clock, no I/O,
// no env/flag reads. cfg is the estate's resolved operating timezone (estate-config,
// ADR-0028) — a plain value the caller resolved once at startup (e.g. via
// estatecfg.Resolve); Evaluate only compares r.Window.TZ against cfg.EstateTZ and
// uses cfg.Loc to render estate-local wall-clock time in refusal reasons. Enforcement
// itself stays pure UTC-instant math: cfg feeds display and the tz recheck only. The
// request is assumed to have passed request.Load (which hardens the fields); any
// residual parse failure is still treated as SCHEDULE_INVALID so the function stays
// total and fail-closed even if called on an unvalidated request.
func Evaluate(r *request.Request, now time.Time, cfg estatecfg.Config) Result {
	res := Result{Now: now.UTC()}

	var earliest *time.Time
	if r.EarliestApplyAt != "" {
		t, err := time.Parse(time.RFC3339, r.EarliestApplyAt)
		if err != nil {
			res.Verdict = ScheduleInvalid
			res.Reason = fmt.Sprintf("earliest_apply_at %q is not RFC3339", r.EarliestApplyAt)
			return res
		}
		tu := t.UTC()
		earliest = &tu
		res.EarliestApplyAt = &tu
	}

	if r.Window == nil {
		// No maintenance window: the cooling gate is the only gate. window-check is thus
		// also the pipeline half of the cooling-off enforcement, even
		// for kind:'now' requests (window absent, earliest_apply_at present).
		if earliest != nil && res.Now.Before(*earliest) {
			res.Verdict = BeforeWindow
			res.OpensAt = earliest
			res.Reason = fmt.Sprintf("cooling-off until %s — not yet (no maintenance window)", renderEstateLocal(*earliest, cfg.Loc))
			return res
		}
		res.Verdict = NoWindow
		res.Reason = "no maintenance window; cooling-off satisfied"
		return res
	}

	start, err1 := time.Parse(time.RFC3339, r.Window.Start)
	end, err2 := time.Parse(time.RFC3339, r.Window.End)
	if err1 != nil || err2 != nil || !start.Before(end) || r.Window.TZ != cfg.EstateTZ {
		res.Verdict = ScheduleInvalid
		res.Reason = fmt.Sprintf("window fields malformed (start/end not RFC3339, start≥end, or tz≠%s)", cfg.EstateTZ)
		return res
	}
	su, eu := start.UTC(), end.UTC()
	res.Start, res.End = &su, &eu

	// 1. Expiry is terminal and takes precedence over cooling: once
	//    now ≥ end the window is dead regardless of any other gate.
	if !res.Now.Before(eu) {
		res.Verdict = WindowExpired
		res.Reason = fmt.Sprintf("window closed at %s — re-window required", renderEstateLocal(eu, cfg.Loc))
		return res
	}
	// 2. Cooling gate: the gates are conjunctive; report the later of the
	//    two opening instants so the operator sees when the change can actually proceed.
	if earliest != nil && res.Now.Before(*earliest) {
		opensAt := *earliest
		if su.After(opensAt) {
			opensAt = su
		}
		res.Verdict = BeforeWindow
		res.OpensAt = &opensAt
		res.Reason = fmt.Sprintf("cooling-off until %s (window opens %s) — not yet", renderEstateLocal(*earliest, cfg.Loc), renderEstateLocal(su, cfg.Loc))
		return res
	}
	// 3. Window not yet open.
	if res.Now.Before(su) {
		res.Verdict = BeforeWindow
		res.OpensAt = &su
		res.Reason = fmt.Sprintf("window opens %s — re-run inside the window", renderEstateLocal(su, cfg.Loc))
		return res
	}
	// 4. In window and past cooling — proceed.
	res.Verdict = InWindow
	res.Reason = fmt.Sprintf("window open — closes %s", renderEstateLocal(eu, cfg.Loc))
	return res
}

// Line is the deterministic machine-readable verdict written to stdout. Tokens are in
// a fixed order and every instant is RFC3339 UTC — greppable by apply-window-gate.sh
// and stable for golden tests.
func (r Result) Line() string {
	s := fmt.Sprintf("verdict=%s now=%s", r.Verdict, r.Now.UTC().Format(time.RFC3339))
	if r.Start != nil {
		s += " start=" + r.Start.UTC().Format(time.RFC3339)
	}
	if r.End != nil {
		s += " end=" + r.End.UTC().Format(time.RFC3339)
	}
	if r.EarliestApplyAt != nil {
		s += " earliest_apply_at=" + r.EarliestApplyAt.UTC().Format(time.RFC3339)
	}
	if r.OpensAt != nil {
		s += " opens_at=" + r.OpensAt.UTC().Format(time.RFC3339)
	}
	return s
}

// renderEstateLocal formats a UTC instant as "2026-07-14T15:00:00Z (2026-07-14 11:00
// EDT)": the machine RFC3339 alongside the estate-local wall clock in loc — the
// *time.Location estatecfg.Resolve loaded once at startup from the estate's
// configured operating timezone (estate-config, ADR-0028). loc supplies its own zone
// abbreviation via the "MST" format verb, so this renders correctly for whatever
// zone the estate is configured with, not just a single hardcoded offset.
func renderEstateLocal(t time.Time, loc *time.Location) string {
	return fmt.Sprintf("%s (%s)", t.UTC().Format(time.RFC3339), t.In(loc).Format("2006-01-02 15:04 MST"))
}
