package driftpropose

import (
	"fmt"

	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/hclops"
)

// importgen.go is the import flavor's emitter (spec
// 2026-07-20-ccp-oob-provisioning-import.md §5.1), the F-1 sibling of
// adopt.go's GenerateAdopt / revert.go's GenerateRevert. Mirroring their own
// split: the checkout-INDEPENDENT screens (ClassifyFinding, the
// creation_security_types re-derivation, the payload prescan) all run in the
// CALLER (generate.go's finding loop; driftedit.go's import handler) as
// independent, repeated screens — exactly like GenerateAdopt's caller runs
// the fourth-screen watchlist check inline rather than bundling it inside
// GenerateAdopt. GenerateImport itself only adds the ONE catalogctl-
// exclusive, checkout-DEPENDENT refinement ClassifyFinding cannot make on
// its own (spec §5.2 F-1's own condition list): "address absent from the
// checkout (Go plane)."

// GenerateImport performs the mechanical emission for one IMPORT-bucket
// finding. f MUST already be classified BucketImport by ClassifyFinding, AND
// already have cleared the checkout-dependent creation_security_types
// re-derivation (importwatchlist.go) and the payload prescan
// (payloadprescan.go) — the caller's job, run BEFORE this (see doc above).
// A non-empty ungenerable reason (with a nil proposal and nil error) is the
// checkout-dependent "address already resolves" refinement firing; a non-nil
// error is an unexpected internal failure.
func GenerateImport(f Finding, envDir string) (*Proposal, string, error) {
	p := f.ImportPayload // non-nil + complete: guaranteed by ClassifyFinding's BucketImport contract

	if _, err, _ := hclops.Locate(envDir, p.Address); err == nil {
		// Locate SUCCEEDED: the address already resolves to a block in the
		// checkout — already managed, cannot import (spec §7.1 step 2's
		// exact collision doctrine, caught here too, before generation ever
		// proposes a doomed-to-fail import).
		return nil, fmt.Sprintf(
			"address %q already resolves in the checkout — already managed, cannot import (a re-run after a prior successful import; the next plan would refuse the collision anyway)",
			p.Address), nil
	}

	digest := ImportProposalDigest([]string{p.Address}, f.Arn, f.TfType, f.LiveID, p.ImportBlock, p.SkeletonHcl)
	payload := &ImportProposalPayload{
		Arn:         f.Arn,
		TfType:      f.TfType,
		LiveID:      f.LiveID,
		TargetFile:  p.TargetFile,
		ImportBlock: p.ImportBlock,
		SkeletonHcl: p.SkeletonHcl,
	}

	return &Proposal{
		Digest:        digest,
		Flavor:        "import",
		Addresses:     []string{p.Address},
		Attrs:         []Attr{}, // spec §5.1: "attrs: []" — import carries a payload, not attr edits
		ImportPayload: payload,
		Diff:          nil,
		RequestSkeleton: RequestSkeleton{Items: []RequestItem{{
			OperationID:   opImport,
			TargetAddress: p.Address,
			Params:        RequestParams{ImportPayload: payload, ProposalDigest: digest},
		}}},
	}, "", nil
}
