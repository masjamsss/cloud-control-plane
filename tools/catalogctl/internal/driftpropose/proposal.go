package driftpropose

// Proposal is one generated fix (spec §6.1, extended by
// 2026-07-20-ccp-oob-provisioning-import.md §5.1 for the "import" flavor and
// by plan 2026-07-20-drift-restore-tranche.md §2.2 for the "restore" flavor):
// the digest-pinned adopt/revert/import/restore action for exactly one resource
// address — one proposal per resource (per-resource actions, per the owner
// direction); batching multiple proposals into a single change-set request
// happens at submit (§4.3 alsoDigests / oob §6 / restore tranche §2.5), never here.
type Proposal struct {
	Digest    string   `json:"digest"`
	Flavor    string   `json:"flavor"` // "adopt" | "revert" | "import" | "restore"
	Addresses []string `json:"addresses"`
	Attrs     []Attr   `json:"attrs"` // import: always []  (a payload, not attribute edits)
	// ImportPayload is additive and import-only (omitted entirely for adopt/
	// revert — nil + omitempty keeps every existing proposal byte-identical).
	ImportPayload   *ImportProposalPayload `json:"importPayload,omitempty"`
	Diff            *string                `json:"diff"` // the unified edit diff (adopt); nil for revert/import
	RequestSkeleton RequestSkeleton        `json:"requestSkeleton"`
}

// ImportProposalPayload is the import flavor's payload (spec §5.1/§2.6): the
// pinned live-resource identity plus the exact reviewed bytes that will land
// in oob-adopted.tf. Arn/TfType/LiveID feed the §5.4 digest formula
// alongside a hash of ImportBlock/SkeletonHcl; Address is deliberately NOT
// repeated here — it already is Proposal.Addresses[0] /
// RequestItem.TargetAddress.
type ImportProposalPayload struct {
	Arn         *string `json:"arn"`
	TfType      string  `json:"tfType"`
	LiveID      string  `json:"liveId"`
	TargetFile  string  `json:"targetFile"`
	ImportBlock string  `json:"importBlock"`
	SkeletonHcl string  `json:"skeletonHcl"`
}

// RequestSkeleton is the draft request shape a submit turns into a real request
// (§6.1). "items" is plural because a submitted change-set can batch several adopt
// proposals (§4.3); a single generated proposal always carries exactly one.
type RequestSkeleton struct {
	Items []RequestItem `json:"items"`
}

// RequestItem is one operation inside the skeleton: which system op, on which
// address, with which params.
type RequestItem struct {
	OperationID   string        `json:"operationId"`
	TargetAddress string        `json:"targetAddress"`
	Params        RequestParams `json:"params"`
}

// RequestParams is catalogctl's DRAFT of the operation params — spec §4.4 states
// plainly that "params are server-authored": the api completes and pins the real
// request params server-side at submit time (§4.3 "build the request entirely
// server-side from the stored skeleton"). ReportVersion is deliberately the Go zero
// value here: the envelope this engine reads carries no report-version field at all
// (that number is assigned by the api when it STAGES the report, §3.1's version row —
// see §6.3's DRIFT_ENVELOPE/DRIFT_OUT seam), so it cannot be a pure function of this
// engine's own documented inputs (envelope bytes, checkout tree). The api fills it in
// when it persists the stored proposal from this skeleton.
// Attrs carries `omitempty` for the import flavor's sake ONLY: spec §5.1's
// import requestSkeleton.items[].params shape has no "attrs" key at all
// (`{importPayload, proposalDigest, reportVersion}`, no attrs). Every
// existing adopt/revert call site always populates a non-empty Attrs slice
// (ClassifyByFields already refuses an empty-changedAttrs adopt verdict, and
// no revert fixture pins a zero-attrs shape), so this is byte-identical for
// every proposal this package already generates.
type RequestParams struct {
	Attrs          []Attr                 `json:"attrs,omitempty"`
	ImportPayload  *ImportProposalPayload `json:"importPayload,omitempty"`
	ProposalDigest string                 `json:"proposalDigest"`
	ReportVersion  int                    `json:"reportVersion"`
}

// Ungenerable is one verdict this engine could not turn into a proposal, with the
// mechanical reason (spec §6.1's ungenerable[] shape).
type Ungenerable struct {
	Address string `json:"address"`
	Class   string `json:"class"`
	Reason  string `json:"reason"`
}

// operation ids the system ops resolve to (spec §4.4; opImport added by
// 2026-07-20-ccp-oob-provisioning-import.md §6; opRestore added by plan
// 2026-07-20-drift-restore-tranche.md §2.2) — adopt/revert/import/restore are
// never submitted through the normal `POST /requests` lane
// (DRIFT_PROPOSAL_REQUIRED, §4.3/§4.5), only through
// `POST /projects/:id/drift/proposals/:digest/submit`. opLegitimize (plan
// §4/L32) is the one exception: it is a route this package never GENERATES a
// proposal for (there is nothing to propose — the engineer's linked PR already
// converged the code; legitimize just closes the loop), so it is typed here
// only as the string constant isDriftEditOp (driftedit.go) needs to recognise
// the op by name, never as a GenerateX emitter's own OperationID.
const (
	opAdopt      = "system-drift-adopt"
	opRevert     = "system-drift-revert"
	opImport     = "system-drift-import"
	opRestore    = "system-drift-restore"
	opLegitimize = "system-drift-legitimize"
)
