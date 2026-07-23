package plancheck

import "fmt"

// legitimize_zero_delta.go implements plan
// docs/superpowers/plans/2026-07-20-drift-restore-tranche.md §4's R11 —
// legitimize-zero-delta — the bundle-gate plan-check for a
// system-drift-legitimize request (register 0009 L32). A legitimize request
// carries no edit of its own (driftedit.go's opLegitimize case is a pure INFO
// no-op): the engineer's convergence change already landed via its OWN linked
// PR before this request was ever submitted — this request is only the
// closure step that lets the bundle apply run. R11 is therefore a tiny
// sibling of R7 (adopt_zero_delta.go's bytes are untouched by this file): the
// WHOLE plan, not merely one target address, must already show zero changes.
// By the time this runs, a fresh `terraform plan` has been taken against the
// checkout — that ordering is the CALLER's job; this function is pure over
// the resulting plan, matching this package's "Check is pure: no file
// access" discipline (plancheck.go).

// CheckLegitimizeZeroDelta runs R11 against a plan taken for a
// system-drift-legitimize request: the WHOLE plan — every resource, not only
// the one the legitimize request names — must show zero changes (0 add / 0
// change / 0 destroy). Exactly CheckAdoptZeroDelta's own doctrine (R7),
// restated for legitimize: if the linked convergence PR has not yet merged
// (or live moved again since), the plan shows a residual diff and R11 is a
// VIOLATION — self-explaining, telling the operator to wait for the PR and
// run the closure apply after. No violation ever distinguishes "the named
// address" from "some other address" — deliberately: any changed entry
// anywhere is disqualifying.
func CheckLegitimizeZeroDelta(plan Plan) []Violation {
	var vs []Violation
	for _, c := range plan.ResourceChanges {
		if !changed(c.Change.Actions) {
			continue
		}
		vs = append(vs, Violation{
			Rule:    "legitimize-zero-delta",
			Address: c.Address,
			Reason:  fmt.Sprintf("plan is not zero-delta: actions %v — the engineer's convergence change has not merged (or live moved again); the legitimize apply is only the closure step, run after the linked PR lands", c.Change.Actions),
		})
	}
	return vs
}
