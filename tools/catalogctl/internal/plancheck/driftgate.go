package plancheck

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/driftpropose"
)

// driftgate.go extends the plan-check entrypoint (command.go — the operator's
// CCP_BUNDLE_GATE_CMD half that verifies a plan, spec
// docs/superpowers/specs/2026-07-20-ccp-approval-to-apply-bundle.md) for spec
// docs/superpowers/specs/2026-07-20-ccp-drift-portal.md §4.4/§7's system ops —
// grown from two (adopt/revert) to five by 2026-07-20-ccp-oob-provisioning-
// import.md §6/§7 (import) and plan 2026-07-20-drift-restore-tranche.md
// §2.3/§4 (restore, legitimize).
//
// A drift request is never a manifests.Op: §4.4 states plainly that its params are
// server-authored, pinned proposal content, not manifest bounds — so it cannot flow
// through command.go's ordinary ccp.request/v1 YAML + ServiceManifest resolution.
// ccp/api/src/routes/requests.ts POST /:id/apply instead writes
// `.bundle-request.json` = `JSON.stringify({id, projectId, operationId,
// targetAddress, params, approvals, status, ...(req.items ? {items: req.items} : {})})`
// for EVERY request the bundle gate verifies, drift or not — command.go's --request
// flag already accepts an arbitrary path, so this file teaches it to recognise that
// JSON shape and route every drift op here instead of refusing them as an
// unresolvable op.
//
// spec addendum A2/F1(b) re-bases this on driftpropose.BundleRequest/ItemsOrSelf: a
// batched adopt change-set (§4.3 alsoDigests) serializes every proposal into
// items[], not only the primary — the F1 bug this closes is that the old code (and
// the pre-A2 version of this file) only ever read the TOP-LEVEL {operationId,
// params} pair, silently gating only items[0] of a batch.

// The five system op IDs (spec §4.4; OpDriftImport added by
// 2026-07-20-ccp-oob-provisioning-import.md §6/§7 as the third known drift
// op; OpDriftRestore and OpDriftLegitimize added by plan
// 2026-07-20-drift-restore-tranche.md §2.3/§4, register 0009 L29/L32) —
// duplicated (not imported) from driftpropose's unexported
// opAdopt/opRevert/opImport/opRestore/opLegitimize: this package has no
// reason to reach into driftpropose's internals for a bare string constant,
// and the value is pinned by the spec, not by driftpropose's implementation.
const (
	OpDriftAdopt      = "system-drift-adopt"
	OpDriftRevert     = "system-drift-revert"
	OpDriftImport     = "system-drift-import"
	OpDriftRestore    = "system-drift-restore"
	OpDriftLegitimize = "system-drift-legitimize"
)

// isDriftOp reports whether id is one of the five system ops the gate learns
// (spec §4.4; OpDriftImport per 2026-07-20-ccp-oob-provisioning-import.md
// §6/§7's F1(b): "import batches are import-only"; OpDriftRestore/
// OpDriftLegitimize per plan 2026-07-20-drift-restore-tranche.md §2.3/§4) —
// resolvable by neither manifests.LoadDir nor request.Load's
// ccp.request/v1 schema. Adding an op to this predicate is ALSO what makes
// peekDriftOp's existing, op-agnostic "every item must name the SAME drift
// op" rule enforce "mixed-op batches exit 3" for it automatically — no
// separate mixing rule needed. Through L32 (this tranche), system-drift-
// legitimize was deliberately NOT one of these ("never reaches the bundle
// gate in this program", spec addendum A6/C2) — register 0009 L32 is what
// teaches this predicate the op, landed here: the api route's tier/ladder
// already authorizes a legitimize request identically to any other open
// request, and the ONLY prior refusal was this Go gate not knowing the op id
// (plan §4: "teaching the gate completes the loop with zero api route
// changes").
func isDriftOp(id string) bool {
	return id == OpDriftAdopt || id == OpDriftRevert || id == OpDriftImport || id == OpDriftRestore || id == OpDriftLegitimize
}

// addressesFromVerdicts returns the unique addresses named across verdicts,
// in first-seen order — the plancheck-side mirror of driftpropose's own
// unexported addressesFromAttrs (driftedit.go), needed here because restore's
// pinned params (driftpropose.RestoreParams) carry verdicts, not attrs: R9's
// digest cross-check (rule restore-digest) recomputes
// driftpropose.ProposalDigest("restore", <this>, nil) per item.
func addressesFromVerdicts(verdicts []driftpropose.Verdict) []string {
	seen := map[string]bool{}
	var out []string
	for _, v := range verdicts {
		if !seen[v.Address] {
			seen[v.Address] = true
			out = append(out, v.Address)
		}
	}
	return out
}

// driftPeekKind classifies what peekDriftOp found in reqPath.
type driftPeekKind int

const (
	// notDrift means reqPath did not parse as a BundleRequest naming ANY drift
	// op — either it is not JSON at all (a genuine ccp.request/v1 YAML file,
	// or a nonexistent path), or every item names some other, non-drift op
	// (e.g. "ec2-resize"). command.go's ordinary YAML+manifest path is
	// completely unaffected either way.
	notDrift driftPeekKind = iota
	// driftMatch means every item of the parsed request names the SAME
	// recognised drift op — opID (peekDriftOp's first return) is that op, and
	// items is ready for RunDriftGate.
	driftMatch
	// malformedDrift means reqPath parsed as JSON and AT LEAST ONE item names a
	// drift op, but the items do NOT all honestly agree on ONE (a mix of drift
	// and non-drift ops, or a mix of two different drift ops, e.g. adopt and
	// revert) — spec addendum A2: "a mix of drift and non-drift ops (or mixed
	// drift ops) in one request has no honest producer ⇒ exit 3." command.go
	// must NOT fall through to the YAML path here (that would fail too, but
	// for the wrong, confusing reason). A LONE system-drift-legitimize item is
	// NOT this case as of register 0009 L32 — isDriftOp now recognises it, so
	// it is driftMatch (see TestPeekDriftOpLoneLegitimizeMatches).
	malformedDrift
)

// peekDriftOp reads reqPath and classifies it per driftPeekKind. This is a
// safe, side-effect-free peek for every OTHER --request fixture: a genuine
// ccp.request/v1 file is block-style YAML, which is never valid JSON, so
// ParseBundleRequest fails immediately and kind is notDrift — command.go's
// ordinary path is completely unaffected.
func peekDriftOp(reqPath string) (opID string, items []driftpropose.BundleRequestItem, kind driftPeekKind) {
	br, err := driftpropose.ParseBundleRequest(reqPath)
	if err != nil {
		return "", nil, notDrift
	}
	its := br.ItemsOrSelf()
	if len(its) == 0 {
		return "", nil, notDrift
	}
	first := its[0].OperationID
	anyDrift, allSame := false, true
	for _, it := range its {
		if isDriftOp(it.OperationID) {
			anyDrift = true
		}
		if it.OperationID != first {
			allSame = false
		}
	}
	switch {
	case !anyDrift:
		return "", nil, notDrift
	case allSame: // anyDrift && allSame together prove isDriftOp(first)
		return first, its, driftMatch
	default:
		return "", nil, malformedDrift
	}
}

// RunDriftGate is the bundle-gate path for the drift system ops (spec §7,
// re-signatured per addendum A2/F1(b) to take EVERY item of the parsed
// BundleRequest): given the operationId every item has already been proven (by
// peekDriftOp) to share, the request's items (each carrying its own pinned
// params), and the plan already taken against the gate-re-edited checkout, it
// returns the R7/R8/R9/R10/R11 violations (and any INFO), or a non-nil error
// for a malformed pinned-params payload or a request-shape problem (command.go
// maps that to exit 3, the same "parse/resolution error" contract every other
// plan-check refusal uses).
//
// Editing the checkout (system-drift-adopt's "re-run the identical edit", spec §7)
// is NOT this function's job: CheckAdoptZeroDelta/CheckRevertInPlace/
// CheckRestoreScopedCreate/CheckLegitimizeZeroDelta are pure, no file access
// (this package's "Check is pure" discipline, plancheck.go) — the caller
// re-edits the checkout via `catalogctl drift-edit` (addendum A3 — internally the
// exact driftpropose.ApplyAdopt core GenerateAdopt used to produce the original
// proposal, so replaying it is provably the identical mechanical edit) BEFORE
// taking the plan this function verifies. What this function DOES do for adopt is
// re-derive §6.2 eligibility independently, via driftpropose.ClassifyByFields — the
// SAME single implementation enforcement point 1 already runs, but as an
// INDEPENDENT call site: it does not trust that the edit step (or points 1-2
// upstream) already refused correctly. A forged or tampered pinned verdict is
// refused here even if every earlier gate somehow let it through. Restore and
// legitimize re-derive their own eligibility identically (BucketRestore /
// IsSecurityPosture respectively, see their case blocks below).
//
// adopt: verdicts are concatenated across EVERY item (a batched change-set gates
// every proposal, not only the first — the F1 bug); any item with zero verdicts is
// a malformed request (error, not a violation). revert: the api already enforces
// "revert submits alone"; this re-enforces it — more than one item is refused as a
// malformed request, never silently gated on item[0]. restore: batches like adopt/
// import (concatenated across items), PLUS a per-item digest cross-check (rule
// restore-digest) since restore's drift-edit leg carries none of its own.
// legitimize: submits alone like revert, re-enforced the same way.
func RunDriftGate(operationID string, items []driftpropose.BundleRequestItem, plan Plan) (violations []Violation, info []string, err error) {
	switch operationID {
	case OpDriftAdopt:
		var allVerdicts []driftpropose.Verdict
		for i, item := range items {
			var p driftpropose.AdoptParams
			if err := json.Unmarshal(item.Params, &p); err != nil {
				return nil, nil, fmt.Errorf("system-drift-adopt: item %d: pinned params: %w", i, err)
			}
			if len(p.Verdicts) == 0 {
				return nil, nil, fmt.Errorf("system-drift-adopt: item %d: pinned params carry no verdicts", i)
			}
			allVerdicts = append(allVerdicts, p.Verdicts...)
		}
		for _, v := range allVerdicts {
			if bucket, reason := driftpropose.ClassifyByFields(v); bucket != driftpropose.BucketAdopt {
				violations = append(violations, Violation{
					Rule:    "drift-adopt-eligibility",
					Address: v.Address,
					Reason:  fmt.Sprintf("re-derived §6.2 eligibility failed (enforcement point 3): %s", reason),
				})
			}
		}
		if len(violations) > 0 {
			return violations, nil, nil // refuse BEFORE R7 even looks at the plan
		}
		violations = CheckAdoptZeroDelta(plan)
		if len(violations) == 0 {
			info = append(info, fmt.Sprintf("INFO adopt-zero-delta: plan is a clean no-op — %d pinned verdict(s) across %d item(s) re-confirmed adopt-eligible and reproduced", len(allVerdicts), len(items)))
		}
		return violations, info, nil

	case OpDriftRevert:
		if len(items) == 0 {
			return nil, nil, fmt.Errorf("system-drift-revert: bundle request carries no items")
		}
		if len(items) > 1 {
			return nil, nil, fmt.Errorf("system-drift-revert: bundle request carries %d items — revert only ever submits alone", len(items))
		}
		var p driftpropose.RevertParams
		if err := json.Unmarshal(items[0].Params, &p); err != nil {
			return nil, nil, fmt.Errorf("system-drift-revert: pinned params: %w", err)
		}
		if len(p.Attrs) == 0 {
			return nil, nil, fmt.Errorf("system-drift-revert: pinned params carry no attrs")
		}
		violations = CheckRevertInPlace(plan, p.Attrs)
		if len(violations) == 0 {
			info = append(info, fmt.Sprintf("INFO revert-in-place: plan confines every change to the %d pinned drifted address(es)", countAddresses(p.Attrs)))
		}
		return violations, info, nil

	case OpDriftImport:
		// spec 2026-07-20-ccp-oob-provisioning-import.md §6/§7.2: a
		// batched import change-set gates EVERY item (one bundle importing N
		// resources), mirroring adopt's own batching — never only item[0].
		if len(items) == 0 {
			return nil, nil, fmt.Errorf("system-drift-import: bundle request carries no items")
		}
		var addresses []string
		for i, item := range items {
			var p driftpropose.ImportParams
			if err := json.Unmarshal(item.Params, &p); err != nil {
				return nil, nil, fmt.Errorf("system-drift-import: item %d: pinned params: %w", i, err)
			}
			if p.ImportPayload.Address == "" {
				return nil, nil, fmt.Errorf("system-drift-import: item %d: pinned params carry no importPayload.address", i)
			}
			// Re-derive §5.2 eligibility from the pinned finding —
			// enforcement point 3, independent of points 1 (drift-propose)
			// and 2 (the api's stored-report re-check): a forged or
			// tampered pinned finding is refused here even if every earlier
			// gate somehow let it through. This is the checkout-INDEPENDENT
			// half only (ClassifyFinding); the checkout-dependent
			// creation_security_types re-derivation already ran at
			// drift-edit time, before this plan was ever taken — this
			// package has no checkout to re-run it against (Check is pure).
			if bucket, reason := driftpropose.ClassifyFinding(p.Finding); bucket != driftpropose.BucketImport {
				violations = append(violations, Violation{
					Rule:    "drift-import-eligibility",
					Address: p.ImportPayload.Address,
					Reason:  fmt.Sprintf("re-derived §5.2 eligibility failed (enforcement point 3): %s", reason),
				})
			}
			addresses = append(addresses, p.ImportPayload.Address)
		}
		if len(violations) > 0 {
			return violations, nil, nil // refuse BEFORE R10 even looks at the plan
		}
		violations = CheckImportExact(plan, addresses)
		if len(violations) == 0 {
			info = append(info, fmt.Sprintf("INFO import-exact: plan shows exactly %d pinned address(es) importing, 0 add / 0 change / 0 destroy", len(addresses)))
		}
		return violations, info, nil

	case OpDriftRestore:
		// plan 2026-07-20-drift-restore-tranche.md §2.3: a batched restore
		// change-set gates EVERY item (multi-deletion incidents batch via
		// alsoDigests, mirroring adopt/import's own batching) — never only
		// item[0].
		if len(items) == 0 {
			return nil, nil, fmt.Errorf("system-drift-restore: bundle request carries no items")
		}
		var allAddresses []string
		for i, item := range items {
			var p driftpropose.RestoreParams
			if err := json.Unmarshal(item.Params, &p); err != nil {
				return nil, nil, fmt.Errorf("system-drift-restore: item %d: pinned params: %w", i, err)
			}
			if len(p.Verdicts) == 0 {
				return nil, nil, fmt.Errorf("system-drift-restore: item %d: pinned params carry no verdicts", i)
			}
			itemAddresses := addressesFromVerdicts(p.Verdicts)
			// Re-derive §2.1 eligibility per pinned verdict — enforcement
			// point 3, independent of points 1 (drift-propose) and 2 (the
			// api's stored-report re-check): a forged or tampered pinned
			// verdict is refused here even if every earlier gate somehow
			// let it through. Deliberately ClassifyByFields == BucketRestore
			// (the full partition, not merely a class-string check).
			for _, v := range p.Verdicts {
				if bucket, reason := driftpropose.ClassifyByFields(v); bucket != driftpropose.BucketRestore {
					violations = append(violations, Violation{
						Rule:    "drift-restore-eligibility",
						Address: v.Address,
						Reason:  fmt.Sprintf("re-derived §2.1 eligibility failed (enforcement point 3): %s", reason),
					})
				}
			}
			// Digest cross-check — tamper evidence. Restore's own
			// drift-edit leg does NO digest check (§2.4: it is a pure
			// INFO no-op), so this gate is the one place that catches a
			// pinned request whose verdicts/addresses were altered after
			// the proposal's own digest was computed.
			gotDigest := driftpropose.ProposalDigest("restore", itemAddresses, nil)
			if gotDigest != p.ProposalDigest {
				violations = append(violations, Violation{
					Rule:    "restore-digest",
					Address: strings.Join(itemAddresses, ","),
					Reason:  fmt.Sprintf("digest mismatch — recomputed %s, pinned %s (tamper evidence)", gotDigest, p.ProposalDigest),
				})
			}
			allAddresses = append(allAddresses, itemAddresses...)
		}
		if len(violations) > 0 {
			return violations, nil, nil // refuse BEFORE R9 even looks at the plan
		}
		violations = CheckRestoreScopedCreate(plan, allAddresses)
		if len(violations) == 0 {
			info = append(info, fmt.Sprintf("INFO restore-scoped-create: plan re-creates exactly %d pinned address(es), 0 add / 0 change / 0 destroy beyond them", len(allAddresses)))
		}
		return violations, info, nil

	case OpDriftLegitimize:
		// plan 2026-07-20-drift-restore-tranche.md §4 (register 0009 L32):
		// "legitimize only ever submits alone" — the api route never
		// batches it, so more than one item is a malformed request,
		// refused exactly like revert's own "submits alone" enforcement,
		// never silently gated on item[0].
		if len(items) == 0 {
			return nil, nil, fmt.Errorf("system-drift-legitimize: bundle request carries no items")
		}
		if len(items) > 1 {
			return nil, nil, fmt.Errorf("system-drift-legitimize: bundle request carries %d items — legitimize only ever submits alone", len(items))
		}
		var p driftpropose.LegitimizeParams
		if err := json.Unmarshal(items[0].Params, &p); err != nil {
			return nil, nil, fmt.Errorf("system-drift-legitimize: pinned params: %w", err)
		}
		if len(p.Verdicts) == 0 {
			return nil, nil, fmt.Errorf("system-drift-legitimize: pinned params carry no verdicts")
		}
		// Re-derive eligibility — enforcement point 3, mirroring the
		// route's OWN step-7 check: security-posture ONLY
		// (driftpropose.IsSecurityPosture), deliberately NOT
		// ClassifyByFields == revert — a legitimize closes an already-
		// authorized security exception, it does not re-derive the full
		// adopt/revert/restore partition.
		for _, v := range p.Verdicts {
			if !driftpropose.IsSecurityPosture(v) {
				violations = append(violations, Violation{
					Rule:    "drift-legitimize-eligibility",
					Address: v.Address,
					Reason:  "re-derived eligibility failed (enforcement point 3): verdict is not security-posture drift (class != security_posture and no securityHits) — legitimize only closes an already-authorized security exception",
				})
			}
		}
		if len(violations) > 0 {
			return violations, nil, nil // refuse BEFORE R11 even looks at the plan
		}
		violations = CheckLegitimizeZeroDelta(plan)
		if len(violations) == 0 {
			info = append(info, fmt.Sprintf("INFO legitimize-zero-delta: plan is a clean no-op — %d pinned verdict(s) already converged", len(p.Verdicts)))
		}
		return violations, info, nil

	default:
		return nil, nil, fmt.Errorf("RunDriftGate: %q is not a recognised drift system op", operationID)
	}
}

// countAddresses returns the number of distinct addresses named across attrs.
func countAddresses(attrs []driftpropose.Attr) int {
	seen := map[string]bool{}
	for _, a := range attrs {
		seen[a.Address] = true
	}
	return len(seen)
}
