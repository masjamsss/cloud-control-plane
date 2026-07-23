package plancheck

import "fmt"

// import_exact.go implements spec docs/superpowers/specs/2026-07-20-ccp-oob-provisioning-import.md
// §7.2's R10 — import-exact — the bundle-gate plan-check for a
// system-drift-import request (WI-S5). Drift-series numbering: R9 is
// reserved for the L29 restore flavor (spec: "drift-series numbering — R9 is
// reserved for L29 restore"); this is R10. By the time this runs, drift-edit
// has already appended the pinned import{}+resource{} blocks to
// environments/prod/oob-adopted.tf and a fresh `terraform plan` has been
// taken — that ordering is the CALLER's job; this function is pure over the
// resulting plan, matching this package's "Check is pure: no file access"
// discipline (plancheck.go).

// CheckImportExact runs R10 against a plan taken after the import edit:
// addresses is the pinned, approved set of Terraform addresses this request
// authorizes importing (one per batched item — spec §6: "one bundle
// importing N resources"). Three violation shapes, matching spec §7.2
// exactly:
//
//   - a pinned address whose ONLY matching plan entries carry
//     change.importing but actions != ["no-op"] — rule "import-exact",
//     "skeleton does not match live" (regenerate; the same freshness proof
//     R7 gives adopt, restated for import: no trust in snapshot recency, the
//     plan re-derives it);
//   - a pinned address with NO plan entry carrying change.importing at all
//     — rule "import-exact", "import did not register" (resource deleted
//     since detection, or the import id was rejected);
//   - any OTHER resource_changes entry (not in the pinned set):
//     change.importing set is a scope violation — rule "import-scope",
//     "nothing imports that was not approved"; any other non-no-op change is
//     the SAME whole-plan zero-delta idiom R7 already enforces (§7
//     blast-radius honesty) — rule "import-exact" again, since it is the
//     identical invariant restated over a different address.
//
// Together these are exactly what "N to import, 0 to add, 0 to change, 0 to
// destroy" asserts, without `-target` and without parsing the plan's text
// summary.
func CheckImportExact(plan Plan, addresses []string) []Violation {
	pinned := make(map[string]bool, len(addresses))
	for _, a := range addresses {
		pinned[a] = true
	}

	byAddr := make(map[string][]ResourceChange, len(plan.ResourceChanges))
	for _, c := range plan.ResourceChanges {
		byAddr[c.Address] = append(byAddr[c.Address], c)
	}

	var vs []Violation

	for _, addr := range addresses {
		clean := false
		sawImporting := false
		var lastActions []string
		for _, c := range byAddr[addr] {
			if c.Change.Importing == nil {
				continue
			}
			sawImporting = true
			lastActions = c.Change.Actions
			if len(c.Change.Actions) == 1 && c.Change.Actions[0] == "no-op" {
				clean = true
				break
			}
		}
		switch {
		case clean:
			// fine — exactly the shape R10 requires.
		case sawImporting:
			vs = append(vs, Violation{
				Rule:    "import-exact",
				Address: addr,
				Reason: fmt.Sprintf(
					"skeleton does not match live — live moved since the snapshot (or generation drifted); regenerate (planned actions %v)",
					lastActions),
			})
		default:
			vs = append(vs, Violation{
				Rule:    "import-exact",
				Address: addr,
				Reason:  "import did not register — resource deleted since detection or import id rejected",
			})
		}
	}

	for _, c := range plan.ResourceChanges {
		if pinned[c.Address] {
			continue
		}
		switch {
		case c.Change.Importing != nil:
			vs = append(vs, Violation{
				Rule:    "import-scope",
				Address: c.Address,
				Reason:  "resource is importing but was not in the approved pinned address set — nothing imports that was not approved",
			})
		case changed(c.Change.Actions):
			vs = append(vs, Violation{
				Rule:    "import-exact",
				Address: c.Address,
				Reason: fmt.Sprintf(
					"plan is not zero-delta for the import: actions %v — outstanding drift elsewhere in the estate must be adopted/reverted/registered/triaged first, or batched into this import (§7 blast-radius honesty)",
					c.Change.Actions),
			})
		}
	}

	return vs
}
