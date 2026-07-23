package plancheck

import (
	"fmt"
	"sort"
	"strings"

	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/manifests"
	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/request"
)

// interior.go implements plan-check R6: interior confinement
// and requested-value-at-path.
//
// R1 is ADDRESS-level (plancheck.go): a wrong edit INSIDE the right resource — a
// stale attr name, a buggy dynamic-target resolution, an L2-edited draft — passes
// R1–R5 today. R6 closes that hole. For the op's target resource it:
//
//   - R6b interior confinement: deep-diffs the plan's before vs after and requires
//     every changed leaf-path to fall within the interior the op DECLARES it edits
//     (target.path + each value param's executor attribute). A changed leaf outside
//     that interior is a VIOLATION "interior-escape".
//   - R6a requested-value-at-path: where the value is request-derivable, the planned
//     after-value at each declared leaf must equal the request's param value; a
//     mismatch is a VIOLATION "value-mismatch".
//
// Honesty: the rule NEVER guesses. Provider-computed
// noise — anything flagged in after_unknown ("known after apply") at any depth, plus
// the provider-injected top-level identity attributes below — is excluded from the
// changed set so it can never read as an escape. Any leaf whose value cannot be
// derived confidently (references, computed values, unmodeled op shapes) is reported
// as INFO "interior-unverifiable" with a reason and never blocks.
//
// deriveInterior is the single extension
// point. Today it reads the STATIC op.Target.Path and the value params' attributes.
// When the caller resolves {param:<discriminator>} tokens first
// (manifests.ResolveTarget) and passes the resolved op here unchanged — every
// keyPath produced below is then concrete and the confinement/value walkers work
// without modification. See deriveInterior's doc for the exact contract.

// providerNoiseTopLevel are provider-injected top-level attributes that routinely
// carry a delta the op never authored (resource identity / derived aggregates), so
// they are excluded from the changed-leaf set. Everything else computed is caught
// structurally by the after_unknown mask (unknownAt), so this list is deliberately
// tiny and only covers the known-value aggregates the mask does not flag:
//   - id, arn   : resource identity; usually unchanged on an in-place update, but
//     excluded defensively so an identity churn never reads as an escape.
//   - tags_all  : the provider's merge of tags + provider default_tags; changes
//     whenever tags change (which several ops legitimately do) yet is
//     never a leaf the op writes directly.
var providerNoiseTopLevel = map[string]bool{
	"id":       true,
	"arn":      true,
	"tags_all": true,
}

// declaredChange is one leaf (or subtree) the op is permitted to change, with how to
// value-check it. keyPath is the block/attr/map-key path from the resource root with
// NO array indices — indices are resolved structurally against the plan tree during
// the walk, so keyPath stays identical whether a block is a singleton or a keyed
// repeated sibling.
type declaredChange struct {
	keyPath  []string         // e.g. ["metadata_options","http_tokens"]; ["root_block_device","tags","Env"]
	subtree  bool             // whole keyPath subtree is declared (map-merge) rather than a single leaf
	valParam *manifests.Param // param supplying the leaf value; nil ⇒ value not request-derivable (INFO)
	growOnly bool             // R4 already asserts before<after ∧ after==requested; R6a skips the value
	sel      *plannedSelector // selector disambiguating ONE repeated block along keyPath
}

// plannedSelector mirrors edit.selector: it picks the one repeated sibling whose
// matchAttr literal equals value (addressing), applied against the plan JSON.
type plannedSelector struct {
	matchAttr string
	value     string
}

// checkInterior runs R6a+R6b for one target resource change. All violations are
// returned (never fail-fast); unverifiable cases become INFO and never block.
func checkInterior(op manifests.Op, req *request.Request, c ResourceChange) (vs []Violation, info []string) {
	addr := c.Address
	before := c.Change.Before
	after := c.Change.After
	// Nothing to verify when the plan carries no before/after detail (a degenerate
	// change) — stay silent rather than emit an unverifiable note for every rule.
	if len(before) == 0 && len(after) == 0 {
		return nil, nil
	}

	// seam: resolve {param:<discriminator>} tokens so the declared interior
	// deriveInterior builds is concrete — the verifier resolves the target IDENTICALLY
	// to the executor (manifests.ResolveTarget), so a wrong-sibling write shows up as
	// an interior-escape / value-mismatch below. A resolution refusal means we cannot
	// model this op's interior for this request → INFO, never a false escape/block.
	rop, rcode, rreason := manifests.ResolveTarget(op, req.Params)
	if rcode != "" {
		return nil, []string{fmt.Sprintf("INFO interior-unverifiable: %s — dynamic target unresolved (%s: %s)", addr, rcode, rreason)}
	}

	changes, modeled, skip := deriveInterior(rop, req)
	if !modeled {
		return nil, []string{fmt.Sprintf("INFO interior-unverifiable: %s — %s", addr, skip)}
	}
	au := anyOf(c.Change.AfterUnknown)

	// R6b — interior confinement. Resolve each declared change to its concrete
	// cover path(s) in the plan tree, then require every changed leaf to be covered.
	var covers []coverPath
	for _, d := range changes {
		cp, ok, reason := resolveCover(d, before, after)
		if !ok {
			info = append(info, fmt.Sprintf("INFO interior-unverifiable: %s — %s", addr, reason))
			continue
		}
		covers = append(covers, cp...)
	}
	for _, leaf := range changedLeaves(before, after, au) {
		if !coveredBy(leaf, covers) {
			vs = append(vs, Violation{
				Rule:    "interior-escape",
				Address: addr,
				Reason:  fmt.Sprintf("changed leaf %s is outside the op's declared interior {%s}", pathStr(leaf), declaredStr(changes)),
			})
		}
	}

	// R6a — requested-value-at-path.
	for _, d := range changes {
		if d.growOnly {
			continue // R4 owns before<after ∧ after==requested for grow-only leaves.
		}
		if d.valParam == nil {
			info = append(info, fmt.Sprintf("INFO interior-unverifiable: %s — value at %s is not request-derivable (map-merge or computed)", addr, keyStr(d.keyPath)))
			continue
		}
		want, derivable := requestedValue(*d.valParam, req)
		if !derivable {
			info = append(info, fmt.Sprintf("INFO interior-unverifiable: %s — value at %s is not request-derivable (%s)", addr, keyStr(d.keyPath), valParamKind(d.valParam)))
			continue
		}
		concrete, got, ok := walkConcrete(after, d.keyPath, d.sel)
		if !ok {
			info = append(info, fmt.Sprintf("INFO interior-unverifiable: %s — declared leaf %s is absent from the plan after-state", addr, keyStr(d.keyPath)))
			continue
		}
		if unknownAt(au, concrete) {
			info = append(info, fmt.Sprintf("INFO interior-unverifiable: %s — value at %s is known only after apply", addr, keyStr(d.keyPath)))
			continue
		}
		if !valueMatches(want, got, d.valParam.Wrap) {
			vs = append(vs, Violation{
				Rule:    "value-mismatch",
				Address: addr,
				Reason:  fmt.Sprintf("%s planned %s but the request asked for %s", keyStr(d.keyPath), showVal(got), showVal(want)),
			})
		}
	}
	return vs, info
}

// deriveInterior computes op's declared interior for req — the set of leaf/subtree
// paths the op is permitted to change — and how to value-check each. This is the
// SINGLE SEAM (dynamic target resolution).
//
// Today it reads the STATIC op.Target.Path plus each value param's executor
// attribute (mirroring edit.attrName / edit.nestedAttrName / edit.foreachMapAttr so
// the verifier's idea of "what was written where" matches the executor exactly).
// When the caller first rewrites {param:<discriminator>} tokens in
// Target.Path / Target.Block / Params[i].Attr via manifests.ResolveTarget and passes
// the RESOLVED op here; the keyPaths below are then concrete with no other change
// needed. To also value-check the discriminator itself,
// append a declaredChange for the resolved segment.
//
// modeled=false means R6 does not verify this op shape (→ INFO interior-unverifiable,
// never a false escape): the caller skips confinement entirely for it.
func deriveInterior(op manifests.Op, req *request.Request) (changes []declaredChange, modeled bool, skip string) {
	sel := plannedSelectorFor(op, req)
	base := op.Target.Path

	switch op.CodemodOp {
	case "set_attribute":
		// Map-merge: target.block names a map-typed attribute the value merges into.
		// The verifier confines to that attribute's subtree; individual merged keys
		// are a union (mergeMap never drops), so their values are reported as INFO
		// rather than asserted here.
		if op.Target.Block != "" {
			if strings.Contains(op.Target.Block, ".") {
				return nil, false, fmt.Sprintf("set_attribute map-merge into dotted block %q is refused by the executor", op.Target.Block)
			}
			return []declaredChange{{keyPath: withSeg(base, op.Target.Block), subtree: true, sel: sel}}, true, ""
		}
		attr, vp := scalarAttr(op)
		if attr == "" {
			return nil, false, fmt.Sprintf("op %q has no resolvable value attribute", op.ID)
		}
		if strings.Contains(attr, ".") {
			// A flat op whose attribute resolves dotted is refused by the executor
			// (UNSUPPORTED_PATH), so no in-place plan exists to confine.
			return nil, false, fmt.Sprintf("attribute %q is a nested path the executor refuses", attr)
		}
		return []declaredChange{{keyPath: withSeg(base, attr), subtree: writesListValue(vp, req), valParam: vp, growOnly: isGrowOnly(vp), sel: sel}}, true, ""

	case "set_attributes":
		for i := range op.Params {
			p := &op.Params[i]
			if !isValueProviderP(*p) {
				continue
			}
			attr := manifests.AttrFor(op, *p)
			if attr == "" || strings.Contains(attr, ".") {
				continue // dotted attrs are executor-refused; skip (not a modeled leaf).
			}
			changes = append(changes, declaredChange{keyPath: withSeg(base, attr), subtree: writesListValue(p, req), valParam: p, growOnly: isGrowOnly(p), sel: sel})
		}
		if len(changes) == 0 {
			return nil, false, fmt.Sprintf("op %q declares no verifiable value params", op.ID)
		}
		return changes, true, ""

	case "append_foreach_entry":
		mapAttr, ok := foreachMapAttrName(op)
		if !ok {
			return nil, false, fmt.Sprintf("op %q foreach map attribute is not statically resolvable (local/address map)", op.ID)
		}
		keyParam, valParam := foreachKeyValParams(op)
		if keyParam == nil || valParam == nil {
			return nil, false, fmt.Sprintf("op %q foreach key/value params are missing", op.ID)
		}
		key := fmt.Sprint(req.Params[keyParam.Name])
		if key == "" {
			return nil, false, fmt.Sprintf("op %q foreach key value is empty", op.ID)
		}
		kp := append(withSeg(base, mapAttr), key)
		return []declaredChange{{keyPath: kp, valParam: valParam, sel: sel}}, true, ""

	default:
		// remove_block / moved_block / instantiate_module never reach here (r6Applies
		// filters them); append_block / *_list_entry / remove_foreach_entry /
		// set_association_attribute are honestly not yet modeled.
		return nil, false, fmt.Sprintf("codemodOp %q is not modeled by interior confinement", op.CodemodOp)
	}
}

// ── confinement primitives ────────────────────────────────────────────────────

// coverPath is a declared region of the plan tree: an exact leaf path, or (subtree)
// a prefix under which any change is permitted.
type coverPath struct {
	path    []any
	subtree bool
}

// resolveCover turns a declared change into the concrete plan-tree path(s) it covers,
// resolving array indices against after (falling back to before for a removed leaf).
func resolveCover(d declaredChange, before, after map[string]any) (covers []coverPath, ok bool, reason string) {
	if concrete, _, found := walkConcrete(after, d.keyPath, d.sel); found {
		return []coverPath{{path: concrete, subtree: d.subtree}}, true, ""
	}
	if concrete, _, found := walkConcrete(before, d.keyPath, d.sel); found {
		return []coverPath{{path: concrete, subtree: d.subtree}}, true, ""
	}
	return nil, false, fmt.Sprintf("declared interior %s could not be located in the plan before/after tree", keyStr(d.keyPath))
}

// coveredBy reports whether a changed leaf falls inside any declared cover: an exact
// path match, or a prefix match for a subtree cover.
func coveredBy(leaf []any, covers []coverPath) bool {
	for _, c := range covers {
		if c.subtree {
			if hasPrefix(leaf, c.path) {
				return true
			}
		} else if pathsEqual(leaf, c.path) {
			return true
		}
	}
	return false
}

// walkConcrete walks root along keyPath, auto-inserting an array index at every level
// whose node is a nested-block list: the selector-matched element when sel applies
// and matches exactly one sibling, else index 0 of a singleton list. Returns the
// concrete path (indices included), the value at the leaf, and ok. An ambiguous list
// (selector matches ≠1, or a multi-element list with no applicable selector) or a
// missing key returns ok=false — the walker never guesses which sibling was meant.
func walkConcrete(root map[string]any, keyPath []string, sel *plannedSelector) (concrete []any, val any, ok bool) {
	var cur any = root
	selUsed := false
	for _, seg := range keyPath {
		if lst, isList := cur.([]any); isList {
			idx, good := chooseIndex(lst, sel, &selUsed)
			if !good {
				return nil, nil, false
			}
			concrete = append(concrete, idx)
			cur = lst[idx]
		}
		m, isMap := cur.(map[string]any)
		if !isMap {
			return nil, nil, false
		}
		v, present := m[seg]
		if !present {
			return nil, nil, false
		}
		concrete = append(concrete, seg)
		cur = v
	}
	return concrete, cur, true
}

// chooseIndex picks the element of a nested-block list to descend into.
func chooseIndex(lst []any, sel *plannedSelector, selUsed *bool) (int, bool) {
	if sel != nil && !*selUsed {
		var matched []int
		for i, e := range lst {
			if m, ok := e.(map[string]any); ok {
				if v, present := m[sel.matchAttr]; present && fmt.Sprint(v) == sel.value {
					matched = append(matched, i)
				}
			}
		}
		if len(matched) == 1 {
			*selUsed = true
			return matched[0], true
		}
		if len(matched) > 1 {
			return 0, false // ambiguous selector match — never guess.
		}
		// zero matches at this level: fall through to the singleton rule.
	}
	if len(lst) == 1 {
		return 0, true
	}
	return 0, false // repeated block with no way to choose one.
}

// ── deep diff ──────────────────────────────────────────────────────────────────

// changedLeaves deep-diffs before vs after and returns every changed leaf-path, with
// provider-computed noise excluded: leaves masked unknown by after_unknown (at any
// depth) and the providerNoiseTopLevel identity attributes. Output is sorted for
// deterministic reporting.
func changedLeaves(before, after map[string]any, au any) [][]any {
	var raw [][]any
	diffNode(nil, anyOf(before), anyOf(after), au, &raw)

	out := make([][]any, 0, len(raw))
	for _, p := range raw {
		// Exclude a provider-injected top-level attribute and everything under it
		// (e.g. the whole tags_all map, not just tags_all itself).
		if len(p) >= 1 {
			if s, ok := p[0].(string); ok && providerNoiseTopLevel[s] {
				continue
			}
		}
		out = append(out, p)
	}
	sort.Slice(out, func(i, j int) bool { return pathStr(out[i]) < pathStr(out[j]) })
	return out
}

// diffNode records the changed leaf-paths between before and after. A subtree masked
// unknown in after_unknown (au == true) is pruned — its value is provider-computed,
// not something the op authored, so it can never be an interior-escape.
func diffNode(path []any, before, after, au any, out *[][]any) {
	if b, ok := au.(bool); ok && b {
		return // known only after apply — excluded wholesale.
	}
	bm, bMap := before.(map[string]any)
	am, aMap := after.(map[string]any)
	if bMap || aMap {
		aum, _ := au.(map[string]any)
		for _, k := range unionStringKeys(bm, am) {
			diffNode(appendPath(path, k), childOf(bm, k), childOf(am, k), childOf(aum, k), out)
		}
		return
	}
	bl, bList := before.([]any)
	al, aList := after.([]any)
	if bList || aList {
		aul, _ := au.([]any)
		n := len(bl)
		if len(al) > n {
			n = len(al)
		}
		for i := 0; i < n; i++ {
			diffNode(appendPath(path, i), atIdx(bl, i), atIdx(al, i), atIdxAny(aul, i), out)
		}
		return
	}
	if !scalarEqual(before, after) {
		*out = append(*out, clonePath(path))
	}
}

// unknownAt reports whether after_unknown masks concrete as known-after-apply.
func unknownAt(au any, concrete []any) bool {
	cur := au
	for _, seg := range concrete {
		if b, ok := cur.(bool); ok {
			return b // a true higher in the tree masks the whole subtree.
		}
		switch s := seg.(type) {
		case string:
			m, ok := cur.(map[string]any)
			if !ok {
				return false
			}
			cur = m[s]
		case int:
			l, ok := cur.([]any)
			if !ok || s < 0 || s >= len(l) {
				return false
			}
			cur = l[s]
		}
	}
	b, ok := cur.(bool)
	return ok && b
}

// ── value derivation ───────────────────────────────────────────────────────────

// requestedValue returns the value the request supplies for p, and whether it is
// derivable at all. A role:"reference" writes a resolved traversal (unknown at plan
// time), and a null const carries no comparable value — both are non-derivable.
func requestedValue(p manifests.Param, req *request.Request) (any, bool) {
	switch p.Role {
	case "const":
		return p.Const, p.Const != nil
	case "reference":
		return nil, false
	default:
		v, ok := req.Params[p.Name]
		return v, ok
	}
}

// valueMatches compares a requested value against the planned after-value, honouring
// wrap:"list" (the request scalar must appear as an element of the after list).
func valueMatches(want, got any, wrap string) bool {
	if wrap == "list" {
		lst, ok := got.([]any)
		if !ok {
			return false
		}
		for _, e := range lst {
			if scalarEqual(want, e) {
				return true
			}
		}
		return false
	}
	return scalarEqual(want, got)
}

// scalarEqual compares two plan/request scalars, canonicalizing numerics (JSON
// float64 vs YAML int) and otherwise comparing string form (matching manifests.
// Validate's fmt.Sprint allowlist comparison, so "1" and 1 agree).
func scalarEqual(a, b any) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	if af, aok := toFloat(a); aok {
		if bf, bok := toFloat(b); bok {
			return af == bf
		}
	}
	return fmt.Sprint(a) == fmt.Sprint(b)
}

// ── executor-mirroring attr/param resolution ──────────────────────────────────

// isValueProviderP mirrors edit.isValueProvider: a param supplies a written value
// unless it is a role:"selector", a role:"discriminator" (it only picks WHICH
// block/attr is edited), or a plain source:"inventory" target. Keeping this in lockstep
// with the executor is what lets deriveInterior name the SAME value leaf the executor
// wrote, so a resolved discriminator is never mistaken for a value to check.
func isValueProviderP(p manifests.Param) bool {
	return manifests.IsValueProvider(p)
}

// firstValueParam returns the op's first value-provider (edit.valueParam).
func firstValueParam(op manifests.Op) *manifests.Param {
	for i := range op.Params {
		if isValueProviderP(op.Params[i]) {
			return &op.Params[i]
		}
	}
	return nil
}

// scalarAttr resolves the attribute a set_attribute op writes and the param whose
// value fills it, mirroring the executor EXACTLY (a divergence here would make R6
// interior confinement false-positive or miss a wrong-attr write):
//   - an explicit op.Target.Attr is authoritative — the executor's
//     attrName/nestedAttrName return it verbatim and never read the prose, so the
//     verifier must too; this is what makes a migrated op's declared interior the
//     structured attribute rather than the retired paren token;
//   - else a nested op (target.path set) names it via manifests.AttrFor on the value
//     param (edit.nestedAttrName);
//   - else a flat op takes the terraformCapability paren token when it is a bare
//     attribute identifier, else AttrFor (edit.attrName). Getting this exactly right
//     matters — dozens of un-migrated toggle ops still name their attribute via the
//     paren token (e.g. "disable_api_termination"), not via the "enabled" param, so an
//     AttrFor-only derivation would false-positive on all of them.
func scalarAttr(op manifests.Op) (string, *manifests.Param) {
	vp := firstValueParam(op)
	if op.Target.Attr != "" {
		return op.Target.Attr, vp
	}
	if len(op.Target.Path) > 0 {
		if vp == nil {
			return "", nil
		}
		return manifests.AttrFor(op, *vp), vp
	}
	if tok := manifests.ProseAttrToken(op.TerraformCapability); tok != "" {
		return tok, vp
	}
	if vp == nil {
		return "", nil
	}
	return manifests.AttrFor(op, *vp), vp
}

// plannedSelectorFor mirrors edit.selectorFor, binding the op's role:"selector" param
// to its requested value for repeated-block disambiguation in the plan tree.
func plannedSelectorFor(op manifests.Op, req *request.Request) *plannedSelector {
	for _, p := range op.Params {
		if p.Role == "selector" {
			return &plannedSelector{matchAttr: p.MatchAttr, value: fmt.Sprint(req.Params[p.Name])}
		}
	}
	return nil
}

// foreachMapAttrName resolves the map attribute an append_foreach_entry edits when it
// is a resource block attribute (target.block). A local/address-keyed map is not a
// plan resource_change, so it is not modeled here.
func foreachMapAttrName(op manifests.Op) (string, bool) {
	if op.Target.Block != "" && !strings.Contains(op.Target.Block, ".") {
		return op.Target.Block, true
	}
	return "", false
}

// foreachKeyValParams returns the key and value params of a foreach op: the first two
// non-inventory, non-selector, non-discriminator params, matching edit.nonInvParams
// ordering (a discriminator is not a foreach key or value).
func foreachKeyValParams(op manifests.Op) (keyParam, valParam *manifests.Param) {
	var nonInv []*manifests.Param
	for i := range op.Params {
		p := &op.Params[i]
		if p.Source != "inventory" && p.Role != "selector" && p.Role != "discriminator" {
			nonInv = append(nonInv, p)
		}
	}
	if len(nonInv) >= 2 {
		return nonInv[0], nonInv[1]
	}
	if len(nonInv) == 1 {
		return nonInv[0], nil
	}
	return nil, nil
}

func isGrowOnly(p *manifests.Param) bool {
	return p != nil && p.Bounds != nil && p.Bounds.GrowOnly
}

// writesListValue reports whether p's written value is a LIST — a wrap:"list" scalar
// (e.g. lifecycle_config_arns) or a list-typed request value. Such a leaf must be
// declared as a SUBTREE cover: in plan JSON the list's elements sit one index below
// the attribute path, so an exact-leaf cover would (wrongly) read the element change
// as an interior-escape. The op authored the whole attribute, so the whole subtree is
// its declared interior; R6a still value-checks the requested element via valueMatches.
func writesListValue(p *manifests.Param, req *request.Request) bool {
	if p == nil {
		return false
	}
	if p.Wrap == "list" {
		return true
	}
	_, ok := req.Params[p.Name].([]any)
	return ok
}

func valParamKind(p *manifests.Param) string {
	switch p.Role {
	case "reference":
		return "reference value resolved at apply"
	case "const":
		return "null const"
	default:
		return "value not present in request"
	}
}

// ── small path/tree helpers ────────────────────────────────────────────────────

// anyOf boxes a possibly-nil map so a nil map[string]any reads as a typed map (not a
// nil interface) in the diff/walk type switches.
func anyOf(m map[string]any) any {
	if m == nil {
		return map[string]any(nil)
	}
	return m
}

func withSeg(base []string, seg string) []string {
	out := make([]string, 0, len(base)+1)
	out = append(out, base...)
	return append(out, seg)
}

func appendPath(path []any, seg any) []any {
	out := make([]any, len(path)+1)
	copy(out, path)
	out[len(path)] = seg
	return out
}

func clonePath(path []any) []any {
	out := make([]any, len(path))
	copy(out, path)
	return out
}

func pathsEqual(a, b []any) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if fmt.Sprint(a[i]) != fmt.Sprint(b[i]) {
			return false
		}
	}
	return true
}

func hasPrefix(leaf, prefix []any) bool {
	if len(prefix) > len(leaf) {
		return false
	}
	for i := range prefix {
		if fmt.Sprint(prefix[i]) != fmt.Sprint(leaf[i]) {
			return false
		}
	}
	return true
}

func unionStringKeys(a, b map[string]any) []string {
	seen := map[string]bool{}
	var keys []string
	for k := range a {
		if !seen[k] {
			seen[k] = true
			keys = append(keys, k)
		}
	}
	for k := range b {
		if !seen[k] {
			seen[k] = true
			keys = append(keys, k)
		}
	}
	sort.Strings(keys)
	return keys
}

func childOf(m map[string]any, k string) any {
	if m == nil {
		return nil
	}
	return m[k]
}

func atIdx(l []any, i int) any {
	if i < 0 || i >= len(l) {
		return nil
	}
	return l[i]
}

func atIdxAny(l []any, i int) any {
	if i < 0 || i >= len(l) {
		return nil
	}
	return l[i]
}

// pathStr renders a concrete plan path (indices included): a.b[0].c
func pathStr(path []any) string {
	var b strings.Builder
	for _, seg := range path {
		switch s := seg.(type) {
		case int:
			fmt.Fprintf(&b, "[%d]", s)
		default:
			if b.Len() > 0 {
				b.WriteByte('.')
			}
			fmt.Fprintf(&b, "%v", s)
		}
	}
	return b.String()
}

// keyStr renders a declared keyPath (no indices): a.b.c
func keyStr(keyPath []string) string {
	return strings.Join(keyPath, ".")
}

func declaredStr(changes []declaredChange) string {
	parts := make([]string, 0, len(changes))
	for _, d := range changes {
		parts = append(parts, keyStr(d.keyPath))
	}
	return strings.Join(parts, ", ")
}

func showVal(v any) string {
	if v == nil {
		return "null"
	}
	return fmt.Sprintf("%q", fmt.Sprint(v))
}
