package driftpropose

import (
	"fmt"

	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/hclops"
)

// GenerateRevert builds the REVERT proposal for one REVERT-bucket verdict (spec
// §6.4): NO EDIT AT ALL. The mechanical meaning is "an apply of current HEAD,
// scoped to the drifted addresses" — enforced later at apply time by plan-check R8
// (WI-5), never by this function. This only pins the drifted
// {address, path, pathSegments, liveJson, codeJson} rows (liveJson/codeJson null
// wherever the source row is sensitive — a revert never needs the secret VALUE,
// only WHICH paths are in scope) after proving the address resolves in the
// checkout, the same checkout-dependent refinement GenerateAdopt applies. v MUST
// already be REVERT-eligible per ClassifyByFields.
//
// spec F5 (hardening): ca.Sensitive == true pins BOTH liveJson/codeJson nil
// UNCONDITIONALLY — never merely "when absent". A crafted/hostile envelope that
// carries values on a sensitive row despite classify.py's own §2.2 contract
// (machine values present only when sensitive is false) must never leak them into
// the proposal body, the digest input, or the request evidence. This is
// independent of, and does not rely on, the classifier or the api ingest having
// stripped them first.
func GenerateRevert(v Verdict, envDir string) (*Proposal, string, error) {
	if _, err, code := hclops.Locate(envDir, v.Address); err != nil {
		if code == 3 {
			return nil, fmt.Sprintf("address %q not found in checkout: %v", v.Address, err), nil
		}
		return nil, "", err // I/O or parse error on the checkout itself — not a per-verdict refusal
	}

	attrs := make([]Attr, 0, len(v.ChangedAttrs))
	for _, ca := range v.ChangedAttrs {
		var live, code any
		if !ca.Sensitive {
			live, _ = ca.liveValue() // nil when absent — fine, a revert never needs the value
			code, _ = ca.codeValue()
		}
		attrs = append(attrs, Attr{Address: v.Address, Path: ca.Path, PathSegments: resolvedSegments(ca), LiveJSON: live, CodeJSON: code})
	}

	addrs := []string{v.Address}
	digest := ProposalDigest("revert", addrs, attrs)

	return &Proposal{
		Digest:    digest,
		Flavor:    "revert",
		Addresses: addrs,
		Attrs:     attrs,
		Diff:      nil, // revert carries no edit (spec §6.4)
		RequestSkeleton: RequestSkeleton{Items: []RequestItem{{
			OperationID:   opRevert,
			TargetAddress: v.Address,
			Params:        RequestParams{Attrs: attrs, ProposalDigest: digest},
		}}},
	}, "", nil
}
