package driftpropose

import (
	"fmt"
	"strconv"
	"strings"
)

// Bucket is the partition outcome for one verdict (spec §6.2): every verdict lands
// in exactly one.
type Bucket string

const (
	BucketAdopt       Bucket = "adopt"
	BucketRevert      Bucket = "revert"
	BucketRestore     Bucket = "restore"
	BucketUngenerable Bucket = "ungenerable"
)

// classInfo pairs a known class's runbook id with the enriched, byte-pinned
// operator note (plan 2026-07-20-drift-audit-fixes.md §2 "Reason-string
// enrichment" table) that replaces the old generic "see runbook %s" text.
// benign_inplace/security_posture/oob_deletion carry no note: none of the three
// ever reaches the generic "class %q is not auto-generable" message below
// (benign_inplace is the one class that DOES generate; security_posture is
// routed by IsSecurityPosture before knownClasses is ever consulted for a
// message; oob_deletion is routed by the restore branch in ClassifyByFields,
// plan 2026-07-20-drift-restore-tranche.md §2.1, before the generic message too
// — its note is therefore dead and deliberately left empty rather than deleted
// from the map, since the class id (D4) is still consulted elsewhere).
type classInfo struct {
	id   string
	note string
}

// knownClasses is the closed, versioned eleven-class enum (D1-D11,
// docs/runbooks/drift-detection.md) classify.py emits. Stability contract
// (0027 §2.4.3): renaming or removing a class is a breaking envelope-schema
// change; every consumer — this one included — fails closed (ungenerable, never
// adopt-eligible) on a class id it doesn't recognize, so an additive classifier
// class can never brick generation.
var knownClasses = map[string]classInfo{
	"benign_inplace":   {id: "D1"},
	"security_posture": {id: "D2"},
	"replacement_forcenew": {id: "D3", note: "ADOPT arm is safe and human-preparable today " +
		"(runbook D3 adopt-PR, docs/runbooks/drift-detection.md); a guided portal lane is tracked in the limitations register"},
	"replacement_risk": {id: "D3b", note: "ADOPT arm is safe and human-preparable today " +
		"(runbook D3b adopt-PR, docs/runbooks/drift-detection.md); a guided portal lane is tracked in the limitations register"},
	"oob_deletion":   {id: "D4"}, // note intentionally empty — see classInfo doc comment: unreachable
	"legit_churn":    {id: "D6", note: "ignore_changes + registry row — an engineer PR per runbook D6"},
	"provider_noise": {id: "D7", note: "adopt the provider's canonical form per runbook D7 (phase-2 candidate, 0027 §3.4)"},
	"state_anomaly":  {id: "D8", note: "state surgery per docs/runbooks/state-recovery.md (runbook D8)"},
	"moved_refactor": {id: "D9", note: "verify the moved{} no-op per runbook D9"},
	"unapplied_config": {id: "D10", note: "merged code awaiting the normal apply lane (runbook D10) — " +
		"not console drift"},
	"churn_absorbed": {id: "D11", note: "already absorbed by an existing ignore_changes (runbook D11)"},
}

// IsSecurityPosture is the fail-closed union predicate of spec §2.3:
// isSecurityPosture(v) := v.class == 'security_posture' OR v.securityHits.length > 0.
// The watchlist (curated, reviewed, versioned in scripts/drift/security-watchlist.json)
// is the single authority; this predicate only WIDENS on top of the class label, never
// narrows — a verdict relabeled away from security_posture is still caught the instant
// it carries a securityHits row (§8 enforcement point 1).
func IsSecurityPosture(v Verdict) bool {
	return v.Class == "security_posture" || len(v.SecurityHits) > 0
}

// SegKind is NormalizeSegments' outcome classification (spec addendum A4 / F8).
type SegKind int

const (
	// SegLegacy means the row carried no pathSegments at all — the caller falls
	// back to the pre-F8 display-path string rules (legacySegments), byte-for-byte.
	SegLegacy SegKind = iota
	// SegNormalized means raw was a well-formed ≥1-element array of strings and/or
	// non-negative integers — segs is ready to use.
	SegNormalized
	// SegMalformed means raw was PRESENT but not well-formed (empty, or an element
	// that is neither a string nor a non-negative integer) — never expressible,
	// regardless of what the display path alone might otherwise allow.
	SegMalformed
)

// NormalizeSegments applies spec addendum A4's normalization contract — identical
// in all three implementations (Go here, the api TS re-check, the app TS
// mock/UI): absent (raw == nil, the JSON key was never present) ⇒ SegLegacy; an
// array of ≥1 elements each a string or a non-negative integer ⇒ SegNormalized,
// with every element returned as `string` or `int` (accepting float64 too, since
// a JSON-decoded pathSegments row conveys integers that way — encoding/json's
// own generic-decode shape — while Go-authored test data commonly uses literal
// ints; both normalize identically); anything else ⇒ SegMalformed. Malformed is
// deliberately NOT the same outcome as absent: a present-but-broken pathSegments
// value must never quietly fall back to the legacy string rules (fail-closed).
func NormalizeSegments(raw []any) ([]any, SegKind) {
	if raw == nil {
		return nil, SegLegacy
	}
	if len(raw) == 0 {
		return nil, SegMalformed
	}
	out := make([]any, 0, len(raw))
	for _, v := range raw {
		switch x := v.(type) {
		case string:
			out = append(out, x)
		case int:
			if x < 0 {
				return nil, SegMalformed
			}
			out = append(out, x)
		case float64:
			if x < 0 || x != float64(int64(x)) {
				return nil, SegMalformed
			}
			out = append(out, int(x))
		default:
			return nil, SegMalformed
		}
	}
	return out, SegNormalized
}

// legacySegments re-derives segments from a changedAttrs[].path DISPLAY string
// under the PRE-F8 expressibility rule, byte-for-byte: no bracket ("[]") anywhere
// and at most two dot-separated parts. This is deliberately STRICTER than
// legacyDisplaySegments below (which is bracket-aware and any-depth) — it is the
// only fallback ExpressibleSegments uses, so a legacy envelope's adopt behavior
// is unchanged by F8 to the byte.
func legacySegments(path string) ([]any, bool) {
	if path == "" || strings.ContainsAny(path, "[]") {
		return nil, false
	}
	parts := strings.Split(path, ".")
	if len(parts) > 2 {
		return nil, false
	}
	out := make([]any, len(parts))
	for i, p := range parts {
		out[i] = p
	}
	return out, true
}

// legacyDisplaySegments re-derives the FULL segment form (any depth, bracket
// indices included) from a classify.py display_path string, e.g.
// "ingress[0].cidr_blocks" -> ["ingress", 0, "cidr_blocks"]. Unlike legacySegments
// (adopt's STRICTER ≤2-part, no-bracket expressibility rule), this is used only
// to POPULATE Attr.PathSegments on an output row when the source verdict supplied
// none — display/digest/revert-cover population, never a decision about whether
// adopt.go can mechanically write the path. Mirrors plancheck's own
// parsePinnedPath/splitTrailingIndex (re-implemented, not imported — the same
// scoped-sibling doctrine adopt.go's literal-object surgery already follows).
func legacyDisplaySegments(path string) []any {
	if path == "" {
		return nil
	}
	var out []any
	for _, seg := range strings.Split(path, ".") {
		name, idx, hasIdx := splitTrailingIndex(seg)
		if name != "" {
			out = append(out, name)
		}
		if hasIdx {
			out = append(out, idx)
		}
	}
	return out
}

// splitTrailingIndex splits a single path segment like "ingress[0]" into its
// name ("ingress") and index (0, true); a segment with no bracket, or one that
// fails to parse as name[<int>], is returned unsplit (ok=false).
func splitTrailingIndex(seg string) (name string, idx int, ok bool) {
	i := strings.IndexByte(seg, '[')
	if i < 0 || !strings.HasSuffix(seg, "]") {
		return seg, 0, false
	}
	n, err := strconv.Atoi(seg[i+1 : len(seg)-1])
	if err != nil {
		return seg, 0, false
	}
	return seg[:i], n, true
}

// shapeOf accepts segs only when it is one of the three expressible shapes spec
// addendum A4 names: [s] a top-level scalar · [s, s] a map key (any key bytes —
// dotted/slashed/spaced keys included, since a structured segment carries the
// key verbatim, never re-split) · [s, 0, s] a single-instance nested-block leaf
// (W1; the index MUST be the literal int 0 — anything else is ambiguous and
// refused, register 0009 L28). Everything else (4+ segments, a non-zero index,
// wrong element types) is not expressible.
func shapeOf(segs []any) ([]any, bool) {
	switch len(segs) {
	case 1:
		if _, ok := segs[0].(string); ok {
			return segs, true
		}
	case 2:
		_, ok0 := segs[0].(string)
		_, ok1 := segs[1].(string)
		if ok0 && ok1 {
			return segs, true
		}
	case 3:
		_, ok0 := segs[0].(string)
		idx, ok1 := segs[1].(int)
		_, ok2 := segs[2].(string)
		if ok0 && ok1 && ok2 && idx == 0 {
			return segs, true
		}
	}
	return nil, false
}

// ExpressibleSegments resolves ca's AUTHORITATIVE segment form and reports
// whether it is a shape adopt.go's edit engine can mechanically write (see
// shapeOf). Structured pathSegments (§2.2/F8) are authoritative when present and
// well-formed (SegNormalized); ONLY when the row carries none at all
// (SegLegacy) does this fall back to legacySegments' pre-F8 display-path rule —
// preserving every pre-F8 envelope's adopt behavior exactly. A malformed
// pathSegments value (SegMalformed) is never expressible, regardless of what the
// display path alone might otherwise allow (fail-closed: spec addendum A4
// "malformed segments ⇒ not expressible").
func ExpressibleSegments(ca ChangedAttr) ([]any, bool) {
	segs, kind := NormalizeSegments(ca.PathSegments)
	switch kind {
	case SegMalformed:
		return nil, false
	case SegLegacy:
		return legacySegments(ca.Path)
	default: // SegNormalized
		return shapeOf(segs)
	}
}

// resolvedSegments returns the segments to STORE on a generated Attr row (spec
// F8: "Attr gains pathSegments — always populated by the generator"): ca's own
// normalized pathSegments when well-formed, at ANY depth/shape (this is
// POPULATION for display/digest/revert-cover purposes, not an editability gate),
// else derived from the legacy display-path parse (bracket-aware, any depth) —
// so every Attr this engine emits, adopt or revert, carries a usable structured
// path whether or not the source envelope supplied one.
func resolvedSegments(ca ChangedAttr) []any {
	if segs, kind := NormalizeSegments(ca.PathSegments); kind == SegNormalized {
		return segs
	}
	return legacyDisplaySegments(ca.Path)
}

// PathExpressible reports whether ca is a shape the adopt edit engine (adopt.go)
// can mechanically write — see ExpressibleSegments for the full contract
// (structured pathSegments when present and well-formed; the legacy ≤2-part,
// no-bracket display-path rule otherwise; never expressible when pathSegments is
// present but malformed).
func PathExpressible(ca ChangedAttr) bool {
	_, ok := ExpressibleSegments(ca)
	return ok
}

// actionsAreUpdate reports actions == ["update"] — required, exactly, by both the
// ADOPT-eligible and REVERT-eligible rows of §6.2's table.
func actionsAreUpdate(actions []string) bool {
	return len(actions) == 1 && actions[0] == "update"
}

// actionsAreCreate reports actions == ["create"] — required, exactly, by the
// RESTORE-eligible row of plan 2026-07-20-drift-restore-tranche.md §2.1's table
// (a restore is THE plan wanting to re-create a deleted resource; anything else
// is not mechanically restorable).
func actionsAreCreate(actions []string) bool {
	return len(actions) == 1 && actions[0] == "create"
}

// ClassifyByFields partitions one verdict per spec §6.2's table, re-deriving every
// condition from verdict FIELDS — the class label is never trusted alone (the same
// doctrine as the ForceNew gate never trusting prose). It is pure and
// checkout-independent: this is the ONE shared implementation
// testdata/driftpropose/eligibility-cases.json pins byte-for-byte, consumed
// identically by the Go generator, the api's TS re-check and the app's TS mock/UI
// (§6.2: "one table, three implementations, one fixture"). The catalogctl-only
// checkout-dependent refinement — does the address resolve, could the edit actually
// be spliced — is layered on top by GenerateAdopt/GenerateRevert/GenerateRestore; it
// can only DEMOTE an eligible verdict further to ungenerable, never promote one this
// function refused.
func ClassifyByFields(v Verdict) (Bucket, string) {
	// isSecurityPosture wins over every other screen (§8 enforcement point 1): an
	// unknown-class verdict that also carries a securityHits row is still routed
	// here, never reaching the adopt path below.
	if IsSecurityPosture(v) {
		if !actionsAreUpdate(v.Actions) {
			return BucketUngenerable, fmt.Sprintf(
				"security-posture drift with actions %v (not a pure in-place update) — not mechanically revertible, human decision required (runbook D2)", v.Actions)
		}
		if len(v.ForceNewAttrs) > 0 {
			return BucketUngenerable,
				"security-posture drift with forceNew attribute(s) present — replacement-flavored security drift is a human conversation, never a portal button (runbook D2/D3)"
		}
		return BucketRevert, "security-posture drift — revert-only"
	}

	if _, known := knownClasses[v.Class]; !known {
		return BucketUngenerable, fmt.Sprintf(
			"unknown class %q — fail-closed, needs-human (the eleven-class D1-D11 enum is closed)", v.Class)
	}

	// RESTORE (plan 2026-07-20-drift-restore-tranche.md §2.1, register 0009 L29):
	// an oob_deletion verdict — a resource present in code+state but GONE in AWS,
	// the plan wants to re-create it — gets its own portal flavor, slotted here:
	// AFTER the security-posture and unknown-class screens, BEFORE the generic
	// "class %q is not auto-generable" fallback below (which is why
	// knownClasses["oob_deletion"].note is now dead, see the classInfo doc
	// comment). The three conditions below are checked in this exact order —
	// wrong actions before missing evidence — matching the table's row order.
	if v.Class == "oob_deletion" {
		if !actionsAreCreate(v.Actions) {
			return BucketUngenerable, fmt.Sprintf(
				"oob_deletion drift with actions %v (not a pure create) — not mechanically restorable, human decision required (runbook D4)", v.Actions)
		}
		if !v.DriftEvidence {
			return BucketUngenerable, "no drift evidence — unapplied config, not drift (see runbook D10)"
		}
		return BucketRestore, "out-of-band deletion — restore-eligible (re-assert code; the plan re-creates the deleted resource)"
	}

	if v.Class != "benign_inplace" {
		return BucketUngenerable, fmt.Sprintf(
			"class %q is not auto-generable in v1 — %s", v.Class, knownClasses[v.Class].note)
	}
	if v.RiskTier != "low" {
		return BucketUngenerable, fmt.Sprintf("riskTier %q is not low", v.RiskTier)
	}
	if !actionsAreUpdate(v.Actions) {
		return BucketUngenerable, fmt.Sprintf("actions %v are not exactly [update]", v.Actions)
	}
	if len(v.ForceNewAttrs) > 0 {
		return BucketUngenerable, "forceNew attribute(s) present — not generable in v1 (see runbook D3b)"
	}
	if !v.DriftEvidence {
		return BucketUngenerable, "no drift evidence — unapplied config, not drift (see runbook D10)"
	}
	if len(v.ChangedAttrs) == 0 {
		return BucketUngenerable, "no changed attributes to adopt"
	}
	for _, a := range v.ChangedAttrs {
		if a.Sensitive || len(a.LiveJSON) == 0 {
			return BucketUngenerable, fmt.Sprintf("attribute %q is sensitive or missing a machine (liveJson) value", a.Path)
		}
		if !PathExpressible(a) {
			return BucketUngenerable, fmt.Sprintf("attribute %q has a value shape not expressible by the edit engine", a.Path)
		}
	}
	return BucketAdopt, "benign in-place drift — adopt-eligible"
}
