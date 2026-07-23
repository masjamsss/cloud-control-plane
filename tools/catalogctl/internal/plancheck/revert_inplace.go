package plancheck

import (
	"fmt"
	"strconv"
	"strings"

	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/driftpropose"
)

// revert_inplace.go implements spec docs/superpowers/specs/2026-07-20-ccp-drift-portal.md
// §7's R8 — revert-in-place-only — the bundle-gate plan-check for a
// system-drift-revert request (WI-5). A revert proposal carries NO edit (spec §6.4):
// its mechanical meaning is "an apply of current HEAD, scoped to the drifted
// addresses" — and since this estate's apply is always the full single root (no
// `-target`, house rule), the scoping is enforced by REFUSAL here, not by targeting.

// CheckRevertInPlace runs R8 against a plan taken for a system-drift-revert request:
// attrs is the pinned {address, path} evidence the revert proposal carries (spec
// §3.2/§6.4 — driftpropose.Attr; LiveJSON/CodeJSON are display evidence this rule
// does not need). Every pinned target address must plan EITHER:
//
//   - actions == ["update"], with every changed leaf-path within the pinned drifted
//     paths for that address (the classifier's dotted/bracketed display_path
//     convention, e.g. "tags.Owner", "ingress[0].cidr_blocks" — matched via this
//     package's existing R6 deep-diff primitives, changedLeaves/coveredBy/coverPath,
//     so a revert's path confinement reuses exactly the same walker and the exact
//     same subtree-cover treatment the ordinary interior-confinement rule gives a
//     list/map-valued attribute: a pinned path covers everything AT or BELOW it, so
//     e.g. a changed "cidr_blocks" list still confines every "cidr_blocks[N]"
//     element leaf changedLeaves reports, not just an impossible exact match on the
//     bare attribute path); or
//   - no-op (already converged out-of-band since the drift snapshot — legal, the
//     apply is then vacuous for that address).
//
// Any replace/delete/create action on a target, or an in-place update that touches a
// path outside the pinned set, is a VIOLATION ("the replacement asymmetry can never
// sneak in at apply time"). Any address OUTSIDE the pinned targets that shows a real
// change is ALSO a VIOLATION ("revert-scope") — the standard scope rule that makes
// "scoped to the drifted addresses" real without `-target`. Outstanding unrelated
// drift or unapplied code therefore always reds this rule — spec §7: "triage per
// runbook first".
func CheckRevertInPlace(plan Plan, attrs []driftpropose.Attr) []Violation {
	covers := map[string][]coverPath{} // address -> pinned drifted paths, as subtree covers
	for _, a := range attrs {
		if a.Address == "" || a.Path == "" {
			// Malformed pinned data never widens scope: an empty path parses to an
			// empty []any, and coveredBy/hasPrefix treats an empty prefix as
			// matching EVERY leaf — a silent wildcard cover. Skip it instead of
			// registering a target, so the address (if it appears in the plan at
			// all) falls through to the revert-scope / no-covers path, where any
			// real change is a VIOLATION rather than silently permitted.
			continue
		}
		// spec addendum A4/F8: prefer the pinned attr's own structured
		// pathSegments when well-formed (any depth/shape — R8 covers a subtree,
		// it never edits, so it has no reason to restrict to adopt's [s]/[s,s]/
		// [s,0,s] expressibility shapes). Absent or malformed pathSegments falls
		// back to parsePinnedPath's display-string parse — legacy pins keep
		// today's behavior byte-for-byte: a mis-split pin covers nothing real, so
		// any change on the true leaf is still a VIOLATION (fail-closed, never
		// widened by a bad or missing pathSegments value).
		segs, kind := driftpropose.NormalizeSegments(a.PathSegments)
		if kind != driftpropose.SegNormalized {
			segs = parsePinnedPath(a.Path)
		}
		covers[a.Address] = append(covers[a.Address], coverPath{path: segs, subtree: true})
	}

	var vs []Violation
	for _, c := range plan.ResourceChanges {
		cvs, isTarget := covers[c.Address]
		if !isTarget {
			if changed(c.Change.Actions) {
				vs = append(vs, Violation{
					Rule:    "revert-scope",
					Address: c.Address,
					Reason:  "changed address is outside the pinned revert targets — this estate's apply is the full single root (no -target), so scope is enforced by refusal",
				})
			}
			continue
		}
		if !changed(c.Change.Actions) {
			continue // no-op — already converged out-of-band; legal, the apply is vacuous
		}
		if !pureUpdate(c.Change.Actions) || isReplace(c) {
			vs = append(vs, Violation{
				Rule:    "revert-in-place",
				Address: c.Address,
				Reason:  fmt.Sprintf("planned actions %v are not a pure in-place update — the replacement asymmetry can never sneak in at apply time", c.Change.Actions),
			})
			continue
		}
		for _, leaf := range changedLeaves(c.Change.Before, c.Change.After, anyOf(c.Change.AfterUnknown)) {
			if !coveredBy(leaf, cvs) {
				vs = append(vs, Violation{
					Rule:    "revert-in-place",
					Address: c.Address,
					Reason:  fmt.Sprintf("changed path %s is outside the pinned drifted paths for this revert", pathStr(leaf)),
				})
			}
		}
	}
	return vs
}

// pureUpdate is exactly ["update"] — mirrors this file's plancheck.go sibling
// pureDelete (exactly ["delete"]).
func pureUpdate(actions []string) bool {
	return len(actions) == 1 && actions[0] == "update"
}

// parsePinnedPath is pathStr's (interior.go) inverse: it turns a dotted/bracketed
// pinned path string — classify.py's display_path convention, e.g. "tags.Owner" or
// "ingress[0].cidr_blocks", the exact strings driftpropose.Attr.Path carries — into
// the []any segment form changedLeaves/coveredBy operate on, so a pinned path can be
// used as a hasPrefix subtree cover over the plan's deep diff. Each dot-separated
// segment may carry at most one trailing [N] index, the only shape display_path
// emits (pathStr's own encoder never produces more than one bracket per segment
// either).
func parsePinnedPath(s string) []any {
	var out []any
	for _, seg := range strings.Split(s, ".") {
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

// splitTrailingIndex splits a single path segment like "ingress[0]" into its name
// ("ingress") and index (0, true). A segment with no bracket, or one that fails to
// parse as name[<int>], is returned unsplit (ok=false) — never guessed.
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
