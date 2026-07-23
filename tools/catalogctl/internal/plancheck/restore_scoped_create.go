package plancheck

import "fmt"

// restore_scoped_create.go implements plan
// docs/superpowers/plans/2026-07-20-drift-restore-tranche.md §2.3's R9 —
// restore-scoped-create — the bundle-gate plan-check for a
// system-drift-restore request. Drift-series numbering: R9 was the reserved
// number import_exact.go's own header names ("R9 is reserved for the L29
// restore flavor"); this is it. By the time this runs, drift-edit has already
// confirmed there is nothing to replay (a restore carries no edit, §2.4) and a
// fresh `terraform plan` has been taken against the checkout — that ordering
// is the CALLER's job; this function is pure over the resulting plan,
// matching this package's "Check is pure: no file access" discipline
// (plancheck.go).
//
// Strictness bar: R9 is deliberately as strict as R7/R8/R10 — a create stays
// refused EVERYWHERE else a pinned restore address is not, exactly like R7/R8
// refuse an unrequested create today. The only two legal shapes on a pinned
// address are the restore itself landing (a pure create) or the deletion
// having already been restored out-of-band since the snapshot (a no-op, R8's
// converged precedent — the apply is then vacuous for that address).

// CheckRestoreScopedCreate runs R9 against a plan taken for a system-drift-
// restore request: addresses is the pinned, approved set of deleted Terraform
// addresses this request authorizes re-creating (one per batched item — plan
// §2.5: "restore batches restore-only via alsoDigests"). Three violation
// shapes, matching §2.3 exactly:
//
//   - a pinned address whose plan entry is neither a pure create (THE
//     restore) nor a no-op (already converged out-of-band) — rule
//     restore-scoped-create: an in-place update or any other non-delete/
//     replace shape gets the freshness-proof reason ("live moved since the
//     snapshot"); any delete/replace shape gets the "can never ride a
//     restore" reason;
//   - a pinned address absent from resource_changes entirely — rule
//     restore-scoped-create, "nothing to re-assert" (the resource block was
//     removed from code since the snapshot — a DIFFERENT, checkout-dependent
//     refusal already catches this at generation time; this is the plan-time
//     re-proof);
//   - any entry (pinned or not) carrying change.importing — rule
//     restore-scope, "nothing imports under a restore request" — a restore is
//     a from-scratch create, never a satisfied import block; and any OTHER
//     non-pinned address showing a real change — rule restore-scope, the
//     SAME whole-plan zero-delta idiom R7/R10 already enforce (§7 blast-
//     radius honesty).
func CheckRestoreScopedCreate(plan Plan, addresses []string) []Violation {
	pinned := make(map[string]bool, len(addresses))
	for _, a := range addresses {
		pinned[a] = true
	}
	seen := make(map[string]bool, len(addresses))

	var vs []Violation
	for _, c := range plan.ResourceChanges {
		if c.Change.Importing != nil {
			vs = append(vs, Violation{
				Rule:    "restore-scope",
				Address: c.Address,
				Reason:  "importing in a restore plan — nothing imports under a restore request",
			})
		}

		if !pinned[c.Address] {
			if changed(c.Change.Actions) {
				vs = append(vs, Violation{
					Rule:    "restore-scope",
					Address: c.Address,
					Reason: fmt.Sprintf(
						"plan is not zero-delta beyond the pinned restore targets: actions %v — outstanding drift elsewhere must be adopted/reverted/registered/triaged first, or batched into this restore (§7 blast-radius honesty)",
						c.Change.Actions),
				})
			}
			continue
		}
		seen[c.Address] = true

		switch {
		case pureCreate(c.Change.Actions), pureNoOp(c.Change.Actions):
			// fine — exactly THE restore, or already converged out-of-band
			// since the snapshot (R8's precedent: legal, the apply is vacuous
			// for this address).
		case isReplace(c) || contains(c.Change.Actions, "delete"):
			vs = append(vs, Violation{
				Rule:    "restore-scoped-create",
				Address: c.Address,
				Reason:  fmt.Sprintf("planned actions %v — delete/replace can never ride a restore", c.Change.Actions),
			})
		default:
			vs = append(vs, Violation{
				Rule:    "restore-scoped-create",
				Address: c.Address,
				Reason:  fmt.Sprintf("planned actions %v are not a pure create — live moved since the snapshot (partial recreation?); regenerate or triage", c.Change.Actions),
			})
		}
	}

	for _, addr := range addresses {
		if !seen[addr] {
			vs = append(vs, Violation{
				Rule:    "restore-scoped-create",
				Address: addr,
				Reason:  "address is absent from the plan — the resource block was removed from code since the snapshot; nothing to re-assert",
			})
		}
	}

	return vs
}

// pureCreate is exactly ["create"] (mirrors this package's pureDelete/
// pureUpdate — plancheck.go / revert_inplace.go).
func pureCreate(actions []string) bool {
	return len(actions) == 1 && actions[0] == "create"
}

// pureNoOp is exactly ["no-op"] — R9's own name for the shape CheckImportExact
// checks inline; factored out here since R9 tests it on every pinned address,
// not only the happy path.
func pureNoOp(actions []string) bool {
	return len(actions) == 1 && actions[0] == "no-op"
}
