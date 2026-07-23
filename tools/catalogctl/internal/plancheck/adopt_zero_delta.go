package plancheck

import "fmt"

// adopt_zero_delta.go implements spec docs/superpowers/specs/2026-07-20-ccp-drift-portal.md
// §7's R7 — adopt-zero-delta — the bundle-gate plan-check for a system-drift-adopt
// request (WI-5). This is a DIFFERENT numbering series than this package's own base
// R1-R7 (plancheck.go/publicingress.go): the two specs both happened to reach for
// "R7" for an unrelated rule. They never collide in practice — Check() (the
// manifests.Op path) never runs CheckAdoptZeroDelta, and a system-drift-adopt
// request never resolves to a manifests.Op (driftgate.go routes it here instead,
// before Check() is ever reached).
//
// By the time this runs, the identical mechanical edit (driftpropose.GenerateAdopt)
// has already been re-applied to the checkout and a fresh `terraform plan` taken —
// that ordering is the CALLER's job (edit, then plan, then verify); this function is
// pure over the resulting plan, matching this package's "Check is pure: no file
// access" discipline (plancheck.go).

// CheckAdoptZeroDelta runs R7 against a plan taken after the adopt edit: the WHOLE
// plan — every resource, not only the adopted address(es) — must show zero changes
// (0 add / 0 change / 0 destroy). That single assertion is simultaneously:
//
//   - the proof the edit reproduced live reality byte-for-byte (if it did not, the
//     adopted address itself still shows a diff here);
//   - the freshness proof (spec §7: "if live moved again after the snapshot, the
//     plan shows a residual diff and R7 is a VIOLATION" — no trust in snapshot
//     recency is needed, the plan re-derives it);
//   - the blast-radius net (spec §7 "Blast-radius honesty": this estate applies one
//     root with no `-target`, so any OTHER outstanding drift anywhere in the estate
//     also surfaces here and must be adopted/reverted/registered/triaged first).
//
// No violation ever distinguishes "the adopted address" from "some other address" —
// deliberately: any changed entry anywhere is disqualifying. This mirrors the
// existing R5 moved-zero-delta idiom in plancheck.go ("no resource may change"),
// applied here to the whole plan rather than to one moved resource.
func CheckAdoptZeroDelta(plan Plan) []Violation {
	var vs []Violation
	for _, c := range plan.ResourceChanges {
		if !changed(c.Change.Actions) {
			continue
		}
		vs = append(vs, Violation{
			Rule:    "adopt-zero-delta",
			Address: c.Address,
			Reason:  fmt.Sprintf("plan is not zero-delta after the adopt edit: actions %v — live moved again since the drift snapshot, or unrelated drift is still outstanding", c.Change.Actions),
		})
	}
	return vs
}
