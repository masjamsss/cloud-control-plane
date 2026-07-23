package driftpropose

import (
	"encoding/json"
	"fmt"
	"os"
)

// bundle.go implements spec addendum A2's F1(b)/(c) contract: the ONE shape
// `.bundle-request.json` carries for every request the ADR-0016 bundle gate
// verifies (drift or not — ccp/api/src/routes/requests.ts's apply route
// writes this for EVERY bundle request), and the pinned params schema the two
// drift system ops carry inside it (F1(a)). Moving these here (out of
// plancheck, where the params types used to live unexported) makes this ONE
// definition with TWO consumers: plancheck's RunDriftGate (the apply-time gate,
// reads only Verdicts/Attrs) and this package's own `drift-edit` command (the
// apply-time edit replay, reads the full pinned shape including the digest —
// see driftedit.go). plancheck already imports driftpropose, so there is no
// import cycle.

// BundleRequest is the top-level shape of `.bundle-request.json` — additive:
// only the fields this package's consumers need are typed (operationId, params,
// items); everything else (id, projectId, targetAddress, approvals, status, …)
// is the api's own business and is silently ignored by encoding/json, the same
// tolerant-parse doctrine every envelope/proposal type in this package follows.
type BundleRequest struct {
	OperationID string              `json:"operationId"`
	Params      json.RawMessage     `json:"params"`
	Items       []BundleRequestItem `json:"items,omitempty"`
}

// BundleRequestItem is one entry of a batched change-set's `items[]` (spec
// addendum A2: "every batched item, not only the primary") — an
// alsoDigests-batched adopt submit serializes one of these per proposal.
type BundleRequestItem struct {
	OperationID string          `json:"operationId"`
	Params      json.RawMessage `json:"params"`
}

// ItemsOrSelf resolves the "single request vs change-set" ambiguity ONCE:
// br.Items when present (a batched change-set), else a single-element slice
// built from br's own top-level {OperationID, Params} pair (spec addendum A2:
// "items when present, else the top-level pair"). Every consumer —
// plancheck.peekDriftOp, plancheck.RunDriftGate, this package's drift-edit —
// calls this instead of inspecting Items directly, so the resolution rule can
// never drift between them.
func (br BundleRequest) ItemsOrSelf() []BundleRequestItem {
	if len(br.Items) > 0 {
		return br.Items
	}
	return []BundleRequestItem{{OperationID: br.OperationID, Params: br.Params}}
}

// ParseBundleRequest reads and decodes path as a BundleRequest. A read failure
// or invalid JSON is returned as an error — the caller (plancheck's
// peekDriftOp, this package's drift-edit) maps that to "not a drift request" or
// a resolution error depending on context; ParseBundleRequest itself makes no
// judgment about drift-ness.
func ParseBundleRequest(path string) (*BundleRequest, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read bundle request: %w", err)
	}
	var br BundleRequest
	if err := json.Unmarshal(b, &br); err != nil {
		return nil, fmt.Errorf("bundle request: invalid JSON: %w", err)
	}
	return &br, nil
}

// AdoptParams is the pinned params a submitted system-drift-adopt request
// carries (spec §4.4/§7, addendum A2's full schema:
// {attrs, verdicts, diff, proposalDigest, reportVersion}):
//
//   - Verdicts is what plancheck.RunDriftGate's enforcement point 3
//     re-derives §6.2 eligibility from, independently of enforcement points 1
//     (this package's own partitioner) and 2 (the api's stored-report
//     re-check) — "even if 1-2 were somehow bypassed" (§8).
//   - Attrs + ProposalDigest are what drift-edit's digest cross-check (spec
//     addendum A3) verifies BEFORE any edit runs: recompute
//     ProposalDigest("adopt", addresses-from-attrs, Attrs) and compare to
//     ProposalDigest — a mismatch is tamper evidence, refused before the
//     eligibility re-derivation or the edit ever runs.
//   - Diff/ReportVersion are evidence-only (spec: "never byte-compared at the
//     gate") — nothing in this package reads them; they decode here only so a
//     future consumer has somewhere to land them, per the tolerant-decode
//     doctrine ("unknown params fields ignored" already covers the reverse
//     direction: params.json carrying MORE fields than this struct types).
type AdoptParams struct {
	Attrs          []Attr    `json:"attrs"`
	Verdicts       []Verdict `json:"verdicts"`
	Diff           *string   `json:"diff"`
	ProposalDigest string    `json:"proposalDigest"`
	ReportVersion  int       `json:"reportVersion"`
}

// RevertParams is the pinned params a submitted system-drift-revert request
// carries: the drifted {address, path, pathSegments} rows R8 confines the plan
// to. A revert never re-derives §6.2 eligibility at gate time or at edit-replay
// time — spec §7's text asks that only of adopt; re-imposing code over a
// security-posture console change is always the safe direction.
type RevertParams struct {
	Attrs []Attr `json:"attrs"`
}

// RestoreParams is the pinned params a submitted system-drift-restore request
// carries (plan 2026-07-20-drift-restore-tranche.md §2.3): the uniform F1(a)
// shape, {attrs, verdicts, diff, proposalDigest, reportVersion} — the SAME
// field set AdoptParams carries, attrs always [] (a restore has no attribute
// edits to pin, see restore.go). Verdicts is what plancheck.RunDriftGate's
// enforcement point 3 re-derives §2.1 eligibility from (ClassifyByFields(v) ==
// BucketRestore), independently of enforcement points 1 (this package's own
// partitioner) and 2 (the api's stored-report re-check) — mirroring
// AdoptParams' own doc comment. Unlike adopt, restore's drift-edit leg
// (driftedit.go's opRestore case) does NO digest cross-check — the plan gate
// (R9, plancheck's restore-digest rule) carries that duty instead, recomputing
// ProposalDigest("restore", <addresses derived from Verdicts>, nil) against
// ProposalDigest here.
type RestoreParams struct {
	Attrs          []Attr    `json:"attrs"`
	Verdicts       []Verdict `json:"verdicts"`
	Diff           *string   `json:"diff"`
	ProposalDigest string    `json:"proposalDigest"`
	ReportVersion  int       `json:"reportVersion"`
}

// LegitimizeParams is the pinned params a submitted system-drift-legitimize
// request carries (plan 2026-07-20-drift-restore-tranche.md §4/L32): the SAME
// field set AdoptParams carries — the route pins exactly that shape
// (ccp/api routes/drift.ts step 8) even though a legitimize has no edit and
// no digest cross-check of its own (driftedit.go's opLegitimize case is a pure
// INFO no-op; there is nothing to replay — the engineer's linked PR already
// converged the code). Verdicts is what plancheck.RunDriftGate re-derives
// eligibility from at gate time (rule drift-legitimize-eligibility): every
// pinned verdict must be IsSecurityPosture(v), mirroring the route's own
// step-7 check (security-posture only, NOT ClassifyByFields == revert).
type LegitimizeParams struct {
	Attrs          []Attr    `json:"attrs"`
	Verdicts       []Verdict `json:"verdicts"`
	Diff           *string   `json:"diff"`
	ProposalDigest string    `json:"proposalDigest"`
	ReportVersion  int       `json:"reportVersion"`
}

// ImportParams is the pinned params a submitted system-drift-import request
// carries (spec 2026-07-20-ccp-oob-provisioning-import.md §5.1/§6, the
// audit-F1(a) contract's import member): {finding, importPayload, diff: null,
// proposalDigest, reportVersion}.
//
//   - Finding is the CURRENT stored sweep row for this arn (what the api's own
//     re-check, enforcement point 2, just re-verified — an independent input,
//     playing exactly `verdicts`' role for adopt) — its own Arn/TfType/LiveID
//     feed the §5.4 digest formula, and drift-edit re-derives §5.2 eligibility
//     from it (ClassifyFinding) plus the checkout's own creation_security_types
//     screen, independent of points 1-2.
//   - ImportPayload is the reviewed bytes: drift-edit's digest cross-check
//     (§5.4) recomputes ImportProposalDigest over Finding's arn/tfType/liveId
//     plus THIS struct's importBlock/skeletonHcl and compares to
//     ProposalDigest — a mismatch is tamper evidence, refused before any
//     screen or write.
//   - Diff/ReportVersion are evidence-only, exactly like AdoptParams' own —
//     nothing in this package reads them past decoding.
type ImportParams struct {
	Finding        Finding              `json:"finding"`
	ImportPayload  FindingImportPayload `json:"importPayload"`
	Diff           *string              `json:"diff"`
	ProposalDigest string               `json:"proposalDigest"`
	ReportVersion  int                  `json:"reportVersion"`
}
