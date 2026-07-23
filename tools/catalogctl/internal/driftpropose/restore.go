package driftpropose

import (
	"fmt"

	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/hclops"
)

// restore.go is the RESTORE flavor's emitter (plan
// docs/superpowers/plans/2026-07-20-drift-restore-tranche.md §2.2), the F-1
// sibling of adopt.go's GenerateAdopt / revert.go's GenerateRevert /
// importgen.go's GenerateImport. A restore proposal applies the SAME doctrine
// revert does to a different taxonomy category: category E (runbook D4), an
// oob_deletion verdict — a resource present in code+state but GONE in AWS, the
// plan wants to `create` it. The mechanical meaning is "re-assert the code
// already on main, scoped to the deleted address" — NO code edit, NO live
// values, ever (revert's own doctrine, restated for a deletion instead of an
// in-place change). GenerateRestore therefore carries no diff and no attrs,
// mirroring GenerateImport's "attrs: [] — a payload/re-assertion, not
// attribute edits" shape more than GenerateRevert's own (which still pins
// {path, pathSegments, liveJson, codeJson} rows — restore has none of that:
// there is no changed attribute to point at, only an address to re-create).
//
// Deliberate absence: unlike GenerateAdopt's caller (generate.go), NO fourth
// screen (the checkout security-watchlist) runs before this — §2.1's
// "Deliberate security stance" is load-bearing here, not an oversight. Restore
// re-creates from code already reviewed and merged to main; refusing a
// security-family type would leave the WORST deletions (a flow log, a
// CloudTrail trail) without a portal path, backwards from the runbook's own
// D4 guidance ("was the deletion wrong? -> recreate"). The D2-flavored caution
// instead lives in the evidence duty carried by the app's RestoreDrawer (spec
// §2.6) and the human approval ladder (§2.5) — never a mechanical screen here.

// GenerateRestore builds the RESTORE proposal for one RESTORE-bucket verdict
// (plan §2.2). v MUST already be RESTORE-eligible per ClassifyByFields (i.e.
// class == "oob_deletion", actions == ["create"], driftEvidence == true — see
// partition.go). The ONE catalogctl-only, checkout-DEPENDENT refinement
// ClassifyByFields cannot make on its own: the deleted resource's block must
// still be declared in the checkout (hclops.Locate) — absent means a code
// removal may already have accepted the deletion, so there is nothing left to
// re-assert; this is deliberately NOT in the shared eligibility-cases.json
// fixture (checkout-independent by construction), the same doctrine
// GenerateRevert's own address-resolution refusal follows.
func GenerateRestore(v Verdict, envDir string) (*Proposal, string, error) {
	if _, err, code := hclops.Locate(envDir, v.Address); err != nil {
		if code == 3 {
			return nil, fmt.Sprintf(
				"address %q not found in checkout — nothing to re-assert (a code removal may already have accepted the deletion): %v",
				v.Address, err), nil
		}
		return nil, "", err // I/O or parse error on the checkout itself — not a per-verdict refusal
	}

	addrs := []string{v.Address}
	// §2.2's digest formula: the EXISTING ProposalDigest, an empty (nil) attrs
	// list — no new formula. Same deletion re-observed on a later snapshot
	// therefore yields the same digest (idempotent; supersede/reopen mechanics
	// unchanged), exactly like adopt/revert's own digest already behaves.
	digest := ProposalDigest("restore", addrs, nil)

	return &Proposal{
		Digest:    digest,
		Flavor:    "restore",
		Addresses: addrs,
		Attrs:     []Attr{}, // §2.2: "Attrs: [] (empty, non-nil)" — a restore has no attribute edits to pin
		Diff:      nil,      // restore carries no edit at all (§2 intro: "no code edit, ever")
		RequestSkeleton: RequestSkeleton{Items: []RequestItem{{
			OperationID:   opRestore,
			TargetAddress: v.Address,
			// §2.2: "params {proposalDigest} only" — Attrs/ImportPayload both
			// stay their Go zero value (nil), which the RequestParams
			// `omitempty` tags drop entirely from the marshaled JSON.
			Params: RequestParams{ProposalDigest: digest},
		}}},
	}, "", nil
}
