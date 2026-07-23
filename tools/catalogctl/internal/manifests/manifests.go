// Package manifests loads ServiceManifest JSONs and re-validates request params
// against the op's bounds ("the authority is the bound").
package manifests

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/netip"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// Op mirrors the ServiceManifest operation shape (app/src/types/manifest.ts).
// Extra JSON fields are ignored by encoding/json.
type Op struct {
	ID        string `json:"id"`
	Service   string `json:"service"`
	Macd      string `json:"macd"`
	CodemodOp string `json:"codemodOp"`
	Title     string `json:"title"`
	// Summary is the app-side plain operator headline (app/src/types/manifest.ts).
	// The Go verbs never use it; it exists ONLY so LoadDir's strict decode
	// (DisallowUnknownFields) accepts the real manifests, which now carry a
	// `summary` on every operation.
	Summary string `json:"summary,omitempty"`
	// ConsoleLabel is the app-side AWS Management Console field name the SPA now
	// leads each operation's headline with (app/src/types/manifest.ts). Passive,
	// exactly like Summary: the Go verbs never read it; it exists ONLY so LoadDir's
	// strict decode (DisallowUnknownFields) accepts the core-service manifests that
	// now carry the optional `consoleLabel`. catalogctl never emits it.
	ConsoleLabel string `json:"consoleLabel,omitempty"`
	Target       struct {
		ResourceType string `json:"resourceType"`
		// Attr is the EXPLICIT, authoritative
		// scalar attribute a set_attribute op writes. When non-empty it is the single
		// source of truth for the write target: edit.attrName / edit.nestedAttrName and
		// the plancheck.scalarAttr mirror return it verbatim and NEVER consult the
		// free-text terraformCapability prose. This retires the paren-attr hazard:
		// the pre-existing `attrName` parsed the write target out of the first
		// parenthesized token of human-readable prose ahead of the param name, so a
		// natural-phrase paren or reordered params could yield an exit-0 wrong-attribute
		// write from a malformed manifest. Migrated ops declare `target.attr` and are
		// immune. Backward-compatible: an op WITHOUT target.attr keeps the exact
		// pre-migration resolution (prose paren token, else AttrFor on the value param),
		// so un-migrated ops are byte-for-byte unchanged. Applies to the single-attribute
		// set_attribute verb only; set_attributes stays per-param via AttrFor. Additive/
		// optional.
		Attr  string `json:"attr"`
		Block string `json:"block"`
		// Path is a nested-block path walked from the located top-level
		// block, e.g. ["metadata_options"] or ["rule","lifecycle"]. Empty for the
		// top-level shapes. Additive/optional — existing manifests still load.
		// For append_block it addresses the PARENT the new block is appended
		// into ([] = the resource top level, the behavior).
		Path []string `json:"path"`
		// Singleton marks an append_block target whose block may exist at
		// most once at the addressed level (provider MaxItems:1). A second,
		// non-deep-equal instance is refused BLOCK_EXISTS (idempotent when the
		// existing one is deep-equal). Additive/optional.
		Singleton bool `json:"singleton"`
		// EmptyBlocks are attr-less sub-block chains the synthesized
		// append_block must contain, e.g. [["override_action","count"]] renders
		// `override_action { count {} }`. Declarative, no template language.
		// Additive/optional.
		EmptyBlocks [][]string `json:"emptyBlocks"`
		// EnsurePath opts a descent into create-on-missing: while walking
		// Target.Path, a missing intermediate NON-REPEATED block is appended on demand
		// (inside the located resource block only, so the one-block splice + changed-set
		// invariant holds). It never creates a level for which a selector is pending —
		// that level is keyed/repeated and which sibling to create is ambiguous, so the
		// descent fails closed (PATH_NOT_FOUND) instead. Additive/optional; default
		// false preserves the PATH_NOT_FOUND-on-absent behavior exactly.
		EnsurePath bool `json:"ensurePath"`
		// MatchPresence disambiguates shape C: repeated sibling blocks told
		// apart by WHICH attribute each carries, not by any attribute's VALUE (efs
		// lifecycle_policy blocks: one holds transition_to_ia, another
		// transition_to_archive — there is no request input at all to key a
		// role:"selector" on). Keyed by PATH SEGMENT: MatchPresence[s] = a means "while
		// descending the Target.Path segment named s, among its same-type siblings
		// select the one whose body declares attribute a" (Body().GetAttribute(a) !=
		// nil). Every key must name an element of Target.Path (manifest-authoring
		// invariant — the zod schema enforces it; unreachable via the SPA repo).
		// Exactly one carrier descends; zero refuses PATH_NOT_FOUND unless EnsurePath is
		// also set, in which case a NEW sibling of that type is appended (the one shape
		// where ensure creates a sibling among repeated blocks, not a missing
		// singleton); more than one carrier refuses SELECTOR_AMBIGUOUS (malformed
		// config — never guessed). Additive/optional; a segment with no entry keeps the
		// value-selector/single-child descent exactly as it was.
		MatchPresence map[string]string `json:"matchPresence"`
		// EnsureAttr opts a map/list-attribute edit into create-on-absent,
		// the attribute-level analog of EnsurePath's block-level create-on-missing.
		// When set, append_foreach_entry / set_attribute(mergeMap) / append_list_entry
		// treat a MISSING target attribute as an empty literal `{}` / `[]` and write the
		// added/merged entry into it, instead of the exit-1 error
		// (`map attribute %q not found` / `attribute %q not found for map merge` /
		// `attribute %q not found for list edit`). Additive/optional; default false
		// preserves that exit-1-on-absent behavior byte-for-byte — a manifest without
		// the flag still hard-errors, so there is no silent behavior change. It is
		// idempotent (once the key/element exists a re-run finds the literal and no-ops)
		// and guard-respecting (the NOT_LITERAL / KEY_CONFLICT / block-ident guards all
		// still run). The REMOVE verbs (remove_foreach_entry / remove_list_entry) are
		// NOT gated by this flag: a remove of a key/element from an absent map/list is a
		// vacuous NOOP (nothing to remove) regardless — executor robustness, not
		// authorable data.
		EnsureAttr bool `json:"ensureAttr"`
	} `json:"target"`
	Params              []Param `json:"params"`
	RiskFloor           string  `json:"riskFloor"`
	Exposure            string  `json:"exposure"`
	TerraformCapability string  `json:"terraformCapability"`
	ForcesReplace       bool    `json:"forcesReplace"`

	// ── SPA/UI catalog fields — modeled but NOT read by the executor ──────────
	// These carry the operator-facing catalog (titles, help, routing hints, search
	// terms). They exist ONLY so LoadDir's strict decode (DisallowUnknownFields,
	// ) accepts the real production catalog while still rejecting a
	// TYPO'd field (e.g. forceReplace vs forcesReplace) as an exit-3 schema error
	// instead of silently dropping it to a false zero. They mirror the zod fields in
	// app/src/types/manifestSchema.ts (manifestOperation). Uninterpreted here.
	Description   string          `json:"description"`
	Reversible    bool            `json:"reversible"`
	Downtime      string          `json:"downtime"`
	AutoEligible  bool            `json:"autoEligible"`
	Group         string          `json:"group"`
	Pinned        json.RawMessage `json:"pinned"`
	Keywords      []string        `json:"keywords"`
	DraftSkeleton bool            `json:"draftSkeleton"`
	Decisions     []string        `json:"decisions"`
}

type Param struct {
	Name     string  `json:"name"`
	Type     string  `json:"type"`
	Source   string  `json:"source"`
	Required bool    `json:"required"`
	Bounds   *Bounds `json:"bounds"`
	// Role marks a param's job. "selector" means its value picks ONE
	// sibling repeated block along target.path by matching MatchAttr. Empty for an
	// ordinary value/inventory param. Additive/optional.
	Role string `json:"role"`
	// MatchAttr is the sibling-block attribute a role:"selector" param's
	// value is compared against (e.g. "rule_name", "name", "schedule_name").
	MatchAttr string `json:"matchAttr"`
	// Attr overrides the target attribute this param writes. Empty means "no
	// override" — AttrFor falls back to TrimPrefix(Name,"new_") + the
	// resourceType's rename table (the behavior). Additive/optional.
	Attr string `json:"attr"`
	// RefAttr — for a role:"reference" param, the attribute to read off the
	// located referenced block and write as the value (e.g. "arn", "id", "name").
	RefAttr string `json:"refAttr"`
	// EnumSource — the SPA picker's allowed-inventory URI for this param,
	// shaped inventory://<type>/<attr> (e.g. inventory://aws_kms_key/arn). For a
	// role:"reference" param it names the REQUIRED target resource type; the executor
	// now parses it (AllowedRefTypes) to refuse a cross-type reference. Empty or
	// unparseable ⇒ existence-only (behavior). Additive/optional.
	EnumSource string `json:"enumSource"`
	// Wrap — "list" wraps the resolved value in a 1-element tuple before it
	// is written (e.g. a single subnet-id reference written as `[aws_subnet.x.id]`).
	Wrap string `json:"wrap"`
	// Const — for a role:"const" param, the fixed value the executor writes.
	// There is no request/user input for these: Validate skips them and the UI
	// never renders or submits a field for one.
	Const any `json:"const"`
	// Path places this param's attribute inside a SUB-BLOCK of the block an
	// append_block synthesizes, e.g. ["create_rule"] → the attr lands in
	// `create_rule { … }`. Empty = the new block's own body. Relative to the new
	// block, never the resource (Target.Path addresses the parent). The value still
	// flows through AttrFor (name) + valueTokens (value). Additive/optional.
	Path []string `json:"path"`
	// Role gains "discriminator": the param's VALUE picks WHICH block or
	// attribute is edited, via Segments — never a value written to HCL. A discriminator
	// leaves the value-provider set (edit.isValueProvider), so the true value param is
	// still resolved with no other change; it MUST be required with a non-empty
	// allowlist (so manifests.Validate closes the missing/unbounded skips) and MUST NOT
	// be role:"const". Additive/optional.
	//
	// Segments — the closed map from each allowed request value (canonical
	// string form, fmt.Sprint) to the HCL identifier it selects. Required iff
	// role=="discriminator". Its VALUES must each be a valid HCL identifier
	// (IsValidBlockIdent), re-checked at resolve time (defense in depth). ResolveTarget
	// emits ONLY these values — never a raw request byte — so the map's co-domain IS
	// the closed set of reachable names.
	Segments map[string]string `json:"segments"`

	// ── SPA/UI param fields — modeled but NOT read by the executor ────────────
	// Present ONLY so LoadDir's strict decode (DisallowUnknownFields) accepts the real
	// catalog and still flags a typo'd param field. Mirror app/src/types/
	// manifestSchema.ts (manifestParam). Uninterpreted here. Default/DependsOn are
	// json.RawMessage because their zod shapes are unions/objects the executor never
	// reads — capturing raw bytes avoids any decode-type coupling to UI schema drift.
	Label     string          `json:"label"`
	Help      string          `json:"help"`
	Default   json.RawMessage `json:"default"`
	Sensitive bool            `json:"sensitive"`
	Group     string          `json:"group"`
	Tier      string          `json:"tier"`
	UIWidget  string          `json:"uiWidget"`
	DependsOn json.RawMessage `json:"dependsOn"`
}

type Bounds struct {
	Allowlist []any    `json:"allowlist"`
	Min       *float64 `json:"min"`
	Max       *float64 `json:"max"`
	MinItems  *int     `json:"minItems"`
	MaxItems  *int     `json:"maxItems"`
	MaxLength *int     `json:"maxLength"`
	Pattern   string   `json:"pattern"`
	GrowOnly  bool     `json:"growOnly"`
	// CidrPolicy (networking-readiness audit) is the machine-enforceable SEMANTIC
	// layer for a CIDR-valued param — the guardrail the old human-only `bounds.semantic`
	// prose could never enforce (the executor ignored `semantic` entirely, so a request
	// with cidr_block:0.0.0.0/0 on sg-add-internal-ingress-rule executed at exit 0 and
	// emitted a world-open ingress rule). Pattern (shape) still runs; CidrPolicy is the
	// semantic layer ON TOP of it. Three closed values:
	//
	//	"internal-only" — accept ONLY a CIDR/IP wholly inside RFC1918 private space
	//	  (10/8, 172.16/12, 192.168/16). Everything else is refused: public ranges, the
	//	  default routes 0.0.0.0/0 and ::/0 (hard), and ALL IPv6 (RFC1918 is IPv4-only,
	//	  matching the SPA's isInternalCidr first line).
	//	"no-public" — refuse the default routes (0.0.0.0/0, ::/0) and any prefix that
	//	  overlaps public (globally-routable) unicast space; allow private/special hosts
	//	  (RFC1918 v4, IPv6 ULA, loopback, link-local, …).
	//	"link-local-30" — accept ONLY a /30 wholly inside 169.254.0.0/16 (RFC3927
	//	  link-local); refuse any other size, any non-link-local block, all IPv6, and
	//	  malformed input. The exact shape a site-to-site VPN tunnel inside CIDR requires
	//	  (vpn-set-tunnel-inside-cidr.new_inside_cidr).
	//
	// Parsed with net/netip (both a bare IP and a CIDR, IPv4 and IPv6); a malformed value
	// is refused OUT_OF_BOUNDS. An unrecognized policy string is also refused (fail-closed
	// — a manifest typo must never silently pass). Empty = no CIDR check (pre-fix behavior).
	// Additive/optional.
	CidrPolicy string `json:"cidrPolicy"`
	// MaxPrefixLen bounds the maximum ADDRESS-BLOCK SIZE a CIDR-valued
	// param may request, expressed as the smallest prefix length allowed. A value of N
	// refuses any CIDR BROADER than /N — i.e. a prefix length SHORTER than N. With
	// maxPrefixLen:16 a /8 is refused (too broad), /16 is the inclusive floor (allowed),
	// and /24 is allowed (narrower). A bare host (→ /32 or /128) always passes. It is the
	// machine-enforceable half of waf-add-ip-set-entry's "/16-minimum-prefix" rule, which
	// bounds how much of the internet a single WAF IP-set entry can allow/block in one
	// stroke; CidrPolicy no-public rejects the public/default-route cases, MaxPrefixLen
	// rejects an over-broad private-or-otherwise block. Parsed with net/netip like
	// CidrPolicy; a malformed value fails closed OUT_OF_BOUNDS. nil = no size bound
	// (behavior). Additive/optional.
	MaxPrefixLen *int `json:"maxPrefixLen"`
	// Semantic — the human-only CIDR/semantic prose (superseded by CidrPolicy
	// for enforcement). Modeled but NOT read by the executor; present so strict decode
	// accepts the real catalog. Mirrors paramBounds.semantic in manifestSchema.ts.
	Semantic string `json:"semantic"`
}

type serviceManifest struct {
	// Wrapper metadata (service/scope/resourceTypes/summary) is SPA-facing and unused
	// by the executor, modeled only so LoadDir's strict decode accepts the real
	// per-service catalog files (each is a ServiceManifest, not a bare operations
	// array). Mirrors ServiceManifestSchema in manifestSchema.ts.
	Service       string   `json:"service"`
	Scope         string   `json:"scope"`
	ResourceTypes []string `json:"resourceTypes"`
	Summary       string   `json:"summary"`
	Operations    []Op     `json:"operations"`
}

// LoadDir indexes every operation across all *.json in dir by op id.
func LoadDir(dir string) (map[string]Op, error) {
	files, err := filepath.Glob(filepath.Join(dir, "*.json"))
	if err != nil {
		return nil, err
	}
	ops := map[string]Op{}
	for _, f := range files {
		b, err := os.ReadFile(f)
		if err != nil {
			return nil, err
		}
		// Strict decode: DisallowUnknownFields is the manifest-side
		// analog of the request loader's yaml KnownFields(true) (request.go:100). A
		// field the structs above do not model — most importantly a TYPO of a
		// safety-bearing field (forceReplace vs forcesReplace, riskFLoor vs riskFloor)
		// — is now an exit-3 schema error at load, not a silent drop to a false zero
		// that quietly disables a guard. Every legitimate catalog field (executor +
		// SPA/UI) is modeled above, so the real production catalog decodes clean; a new
		// legitimate field must be added to the structs (and is caught loudly here until
		// it is), which is the intended fail-visible coupling.
		dec := json.NewDecoder(bytes.NewReader(b))
		dec.DisallowUnknownFields()
		var sm serviceManifest
		if err := dec.Decode(&sm); err != nil {
			return nil, fmt.Errorf("%s: %w", f, err)
		}
		for _, op := range sm.Operations {
			ops[op.ID] = op
		}
	}
	return ops, nil
}

// renameTable maps a resourceType's provider-schema attribute name (as it must be
// written in HCL) from the manifest's canonical param-derived name. Moved here
// from edit/setattr.go so every codemod — not just set_attribute — shares
// one rename source via AttrFor.
var renameTable = map[string]map[string]string{
	"aws_ebs_volume": {"size_gib": "size"},
}

// proseAttrTokRe is the ONE regex deciding whether a terraformCapability paren token
// is a bare HCL attribute identifier usable as a write target. Before this it lived
// twice — edit.attrTokRe and plancheck.attrParenRe — a mirror the hazard note
// called out (a silent drift between executor and verifier). ProseAttrToken is now the
// single source both call, so they cannot disagree.
var proseAttrTokRe = regexp.MustCompile(`^[a-z0-9_.]+$`)

// ProseAttrToken extracts the bare attribute identifier from the FIRST parenthesized
// span of a terraformCapability string, or "" when that span is not a bare token
// (prose like "in place", "rule priority, in-place", "backup_policy.status → ENABLED").
// It is the retired-but-still-live fallback that resolves an un-migrated op's write
// target from human-readable prose (the hazard). Migrated ops carry an explicit
// target.attr and never reach it. Kept as one shared function so edit.attrName, the
// plancheck.scalarAttr mirror, and the demotion lint decide "does prose name the
// attribute" identically.
func ProseAttrToken(terraformCapability string) string {
	i := strings.IndexByte(terraformCapability, '(')
	if i < 0 {
		return ""
	}
	j := strings.IndexByte(terraformCapability[i+1:], ')')
	if j < 0 {
		return ""
	}
	if tok := strings.TrimSpace(terraformCapability[i+1 : i+1+j]); proseAttrTokRe.MatchString(tok) {
		return tok
	}
	return ""
}

// AttrFor resolves the target attribute a param writes: p.Attr when the
// manifest sets an explicit override, else the frozen fallback rule —
// TrimPrefix(p.Name, "new_") with op.Target.ResourceType's renameTable applied.
func AttrFor(op Op, p Param) string {
	if p.Attr != "" {
		return p.Attr
	}
	name := strings.TrimPrefix(p.Name, "new_")
	if tbl, ok := renameTable[op.Target.ResourceType]; ok {
		if mapped, ok := tbl[name]; ok {
			name = mapped
		}
	}
	return name
}

// AllowedRefTypes parses the resource type(s) a role:"reference" param may
// point at from its enumSource. The SPA picker encodes the required target type as
// inventory://<type>/<attr> (e.g. inventory://aws_kms_key/arn → aws_kms_key); the Go
// executor never read it, so a hand-authored request could point a KMS-key reference at
// an IAM role and it was written (a probe emitted
// `kms_key_id = aws_iam_role.application_migration.arn` at exit 0). value.go uses this
// to refuse REFERENCE_TYPE_MISMATCH when a reference resolves to a type outside the set.
//
// Returns the <type> segment(s), comma-split so a future multi-type enumSource
// (inventory://aws_a,aws_b/arn) admits ANY of the set. Returns nil when enumSource is
// empty or not the inventory://<type>/<attr> shape — the caller then keeps the
// existence-only behavior, so a reference that never declared a type is never newly
// broken (task invariant).
func (p Param) AllowedRefTypes() []string {
	const scheme = "inventory://"
	rest, ok := strings.CutPrefix(p.EnumSource, scheme)
	if !ok {
		return nil
	}
	typePart, _, ok := strings.Cut(rest, "/")
	if !ok || typePart == "" {
		return nil // no attr segment / no type ⇒ not the full shape ⇒ existence-only
	}
	var out []string
	for _, t := range strings.Split(typePart, ",") {
		if t = strings.TrimSpace(t); t != "" {
			out = append(out, t)
		}
	}
	return out
}

// IsValidBlockIdent reports whether s is a single valid HCL identifier usable as a
// block type, path segment, or attribute name (letter/underscore start; then
// letters, digits, underscore, hyphen). It is the one canonical name-safety
// predicate — edit.isValidBlockIdent delegates here so the executor's structural
// guards and ResolveTarget's co-domain check can never drift apart. It deliberately
// REJECTS path-like ("a/b", "x.tf"), dotted, whitespace, and alternation
// ("ingress/egress") values.
func IsValidBlockIdent(s string) bool {
	if s == "" {
		return false
	}
	for i, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r == '_':
		case i > 0 && (r >= '0' && r <= '9' || r == '-'):
		default:
			return false
		}
	}
	return true
}

// Refusal codes emitted by ResolveTarget. Both are fail-closed: the
// caller returns nil bytes + the code and leaves the tree untouched.
const (
	// RefuseMalformedDynamicTarget — a {param:<name>} token is not a whole token
	// (infix / stray brace), names a param that is not a role:"discriminator" of
	// this op, references a discriminator with no segments map, or resolves to a
	// value that is not a valid HCL identifier. Every one of these is a manifest /
	// schema-drift error the zod schema + CI manifest lint make unreachable via the
	// SPA repo; ResolveTarget re-checks at run time (defense in depth).
	RefuseMalformedDynamicTarget = "MALFORMED_DYNAMIC_TARGET"
	// RefuseUnresolvedDynamicSegment — the request value (fmt.Sprint-canonical) has
	// no entry in the discriminator's segments map. Nearly unreachable behind
	// Validate's allowlist check (a value outside the allowlist dies OUT_OF_BOUNDS
	// first), kept fail-closed for manifest-drift defense.
	RefuseUnresolvedDynamicSegment = "UNRESOLVED_DYNAMIC_SEGMENT"
)

// ResolveTarget returns a copy of op with every {param:<name>} token in
// Target.Path, Target.Block and Params[i].Attr replaced by the discriminator's
// Segments entry for the request value, so every downstream verb then works on a
// fully static op. Resolution is ONLY a map lookup: the emitted name is always a
// manifest constant (Segments value), never a raw request byte; the request value
// participates only as key = fmt.Sprint(v) — matching Validate's own fmt.Sprint
// allowlist comparison, so 1 and "1" canonicalize identically.
//
// Returns (resolvedOp, "", "") on success, or (op, code, reason) on a fail-closed
// refusal (see the Refuse* codes). The input op is never mutated: Target.Path and
// Params are deep-copied before any token is rewritten, so the shared LoadDir index
// is safe. Static ops (no {param:…} tokens anywhere) are returned unchanged.
func ResolveTarget(op Op, params map[string]any) (Op, string, string) {
	if !hasDynamicToken(op) {
		return op, "", ""
	}

	// Index the op's discriminator params by name. A token may reference ONLY one of
	// these; anything else is MALFORMED (a non-discriminator can never carry segments).
	disc := map[string]*Param{}
	for i := range op.Params {
		if op.Params[i].Role == "discriminator" {
			disc[op.Params[i].Name] = &op.Params[i]
		}
	}

	resolve := func(s string) (string, string, string) {
		if !strings.Contains(s, "{") {
			return s, "", "" // static segment/attr — unchanged.
		}
		name, ok := wholeParamToken(s)
		if !ok {
			return "", RefuseMalformedDynamicTarget, fmt.Sprintf("%q is not a whole {param:<name>} token — infix templates and stray braces are refused", s)
		}
		p, ok := disc[name]
		if !ok {
			return "", RefuseMalformedDynamicTarget, fmt.Sprintf("{param:%s} does not name a role:\"discriminator\" param of this op", name)
		}
		return resolveSegment(p, params)
	}

	out := op

	if len(op.Target.Path) > 0 {
		np := make([]string, len(op.Target.Path))
		for i, seg := range op.Target.Path {
			r, code, reason := resolve(seg)
			if code != "" {
				return op, code, reason
			}
			np[i] = r
		}
		out.Target.Path = np
	}

	if r, code, reason := resolve(op.Target.Block); code != "" {
		return op, code, reason
	} else {
		out.Target.Block = r
	}

	if len(op.Params) > 0 {
		nparams := make([]Param, len(op.Params))
		copy(nparams, op.Params)
		for i := range nparams {
			if strings.Contains(nparams[i].Attr, "{") {
				r, code, reason := resolve(nparams[i].Attr)
				if code != "" {
					return op, code, reason
				}
				nparams[i].Attr = r
			}
		}
		out.Params = nparams
	}

	return out, "", ""
}

// resolveSegment resolves discriminator param p's Segments entry for the request
// value in params — the single map-lookup implementation ResolveTarget's
// {param:x} token substitution (above) and ResolveDiscriminator (below) both
// share, so the two call sites can never diverge ("one resolver,
// three consumers" — every dynamic-target consumer answers "which manifest string
// do I emit" through this one lookup). Same fail-closed refusals either way:
// MALFORMED_DYNAMIC_TARGET (no segments map, or a segments value that is not a
// valid HCL identifier — defense in depth) or
// UNRESOLVED_DYNAMIC_SEGMENT (the request value has no entry in the map).
func resolveSegment(p *Param, params map[string]any) (string, string, string) {
	if len(p.Segments) == 0 {
		return "", RefuseMalformedDynamicTarget, fmt.Sprintf("discriminator %q has no segments map to resolve", p.Name)
	}
	key := fmt.Sprint(params[p.Name])
	seg, ok := p.Segments[key]
	if !ok {
		return "", RefuseUnresolvedDynamicSegment, fmt.Sprintf("%s=%q has no entry in the segments map of discriminator %q", p.Name, key, p.Name)
	}
	if !IsValidBlockIdent(seg) {
		return "", RefuseMalformedDynamicTarget, fmt.Sprintf("segments[%q]=%q is not a valid HCL identifier", key, seg)
	}
	return seg, "", ""
}

// ResolveDiscriminator resolves a role:"discriminator" param directly —
// resolveSegment exposed for a verb whose target shape has no {param:x} token to
// substitute. swap_child_block is the first consumer: the choice it needs is WHICH
// SIBLING BLOCK is present under a manifest-addressed parent, not a path or attr
// segment, so there is nothing for ResolveTarget's token substitution to rewrite —
// the verb resolves the op's discriminator param itself, through the identical
// segments-map lookup, so it can never disagree with what ResolveTarget would have
// produced had the shape carried a token. p must be role:"discriminator"
// (re-checked here, defense in depth — manifest authoring/validation is expected
// to guarantee it) or this refuses MALFORMED_DYNAMIC_TARGET like every other
// discriminator-shape violation.
func ResolveDiscriminator(p Param, params map[string]any) (string, string, string) {
	if p.Role != "discriminator" {
		return "", RefuseMalformedDynamicTarget, fmt.Sprintf("%q is not a role:\"discriminator\" param", p.Name)
	}
	return resolveSegment(&p, params)
}

// hasDynamicToken reports whether any resolvable field carries a "{" (a candidate
// {param:…} token). The cheap pre-check keeps every static op allocation-free and
// byte-identical to its resolution.
func hasDynamicToken(op Op) bool {
	if strings.Contains(op.Target.Block, "{") {
		return true
	}
	for _, s := range op.Target.Path {
		if strings.Contains(s, "{") {
			return true
		}
	}
	for i := range op.Params {
		if strings.Contains(op.Params[i].Attr, "{") {
			return true
		}
	}
	return false
}

// wholeParamToken extracts NAME from a string that is EXACTLY "{param:NAME}". A token
// that is empty, infixed (leading/trailing text), or carries a nested brace returns
// ok=false — whole-segment substitution only, so no request fragment
// can ever be smuggled into a name's interior.
func wholeParamToken(s string) (string, bool) {
	const pre, suf = "{param:", "}"
	if !strings.HasPrefix(s, pre) || !strings.HasSuffix(s, suf) || len(s) <= len(pre) {
		return "", false
	}
	inner := s[len(pre) : len(s)-len(suf)]
	if inner == "" || strings.ContainsAny(inner, "{}") {
		return "", false
	}
	return inner, true
}

// Validate re-checks every param against its bounds. Returns ("OUT_OF_BOUNDS",
// reason) on the first violation, ("","") when clean. GrowOnly needs the file
// bytes and is NOT checked here (done at edit time). Role=="const"
// params are skipped: they carry no request input, so there is nothing to
// re-validate — the executor writes p.Const straight from the manifest.
func Validate(op Op, params map[string]any) (string, string) {
	for _, p := range op.Params {
		if p.Role == "const" {
			continue
		}
		// dependsOn: an INACTIVE param is never required and its bounds
		// are not applied — the SPA strips it from the request, and ccp-api's
		// validateParams skips it, so the executor must too (one predicate, zero drift).
		// Without this, a required param gated behind an unsatisfied dependsOn (e.g. efs
		// provisioned_mibps under throughput_mode==provisioned) would be spuriously
		// refused for a request the form legitimately hid it from.
		if !IsParamActive(p, params) {
			continue
		}
		v, present := params[p.Name]
		if !present {
			if p.Required {
				return "OUT_OF_BOUNDS", fmt.Sprintf("%s: required param missing", p.Name)
			}
			continue
		}
		if p.Bounds == nil {
			continue
		}
		b := p.Bounds
		if len(b.Allowlist) > 0 {
			// A list-typed value's allowlist constrains each ELEMENT (the bound lists
			// allowed members, not the list's string form), so every element is
			// checked; a scalar is checked whole. Passes iff every value is allowed.
			for _, elem := range elementsOf(v) {
				allowed := false
				for _, e := range b.Allowlist {
					if fmt.Sprint(elem) == fmt.Sprint(e) {
						allowed = true
						break
					}
				}
				if !allowed {
					return "OUT_OF_BOUNDS", fmt.Sprintf("%s %q not in allowlist", p.Name, fmt.Sprint(elem))
				}
			}
		}
		if b.Min != nil || b.Max != nil {
			if p.Type == "string" {
				// On a string param min/max bound its LENGTH, not a numeric magnitude
				// (a description / display-name has none). Real ops:
				// secretsmanager-edit-description, sns-set-display-name.
				n := len(fmt.Sprint(v))
				if b.Min != nil && float64(n) < *b.Min {
					return "OUT_OF_BOUNDS", fmt.Sprintf("%s: length %d below min %v", p.Name, n, *b.Min)
				}
				if b.Max != nil && float64(n) > *b.Max {
					return "OUT_OF_BOUNDS", fmt.Sprintf("%s: length %d above max %v", p.Name, n, *b.Max)
				}
			} else {
				f, ok := toFloat(v)
				if !ok {
					return "OUT_OF_BOUNDS", fmt.Sprintf("%s: %v is not numeric", p.Name, v)
				}
				if b.Min != nil && f < *b.Min {
					return "OUT_OF_BOUNDS", fmt.Sprintf("%s: %v below min %v", p.Name, f, *b.Min)
				}
				if b.Max != nil && f > *b.Max {
					return "OUT_OF_BOUNDS", fmt.Sprintf("%s: %v above max %v", p.Name, f, *b.Max)
				}
			}
		}
		if b.MinItems != nil || b.MaxItems != nil {
			list, ok := v.([]any)
			if !ok {
				return "OUT_OF_BOUNDS", fmt.Sprintf("%s: %v is not a list", p.Name, v)
			}
			if b.MinItems != nil && len(list) < *b.MinItems {
				return "OUT_OF_BOUNDS", fmt.Sprintf("%s: %d items below minItems %d", p.Name, len(list), *b.MinItems)
			}
			if b.MaxItems != nil && len(list) > *b.MaxItems {
				return "OUT_OF_BOUNDS", fmt.Sprintf("%s: %d items above maxItems %d", p.Name, len(list), *b.MaxItems)
			}
		}
		if b.MaxLength != nil {
			if s := fmt.Sprint(v); len(s) > *b.MaxLength {
				return "OUT_OF_BOUNDS", fmt.Sprintf("%s: length %d above maxLength %d", p.Name, len(s), *b.MaxLength)
			}
		}
		if b.Pattern != "" {
			re, err := regexp.Compile(b.Pattern)
			if err != nil {
				return "OUT_OF_BOUNDS", fmt.Sprintf("%s: invalid bound pattern %q", p.Name, b.Pattern)
			}
			// Per-element for a list value (each member must match), whole for a scalar.
			for _, elem := range elementsOf(v) {
				if !re.MatchString(fmt.Sprint(elem)) {
					return "OUT_OF_BOUNDS", fmt.Sprintf("%s %q does not match pattern %s", p.Name, fmt.Sprint(elem), b.Pattern)
				}
			}
		}
		if b.CidrPolicy != "" {
			// The semantic CIDR layer. Per-element like Pattern, so a list of CIDRs
			// is checked member-by-member; a scalar is checked whole. A malformed value,
			// a policy violation, or an unrecognized policy all fail closed OUT_OF_BOUNDS.
			for _, elem := range elementsOf(v) {
				if reason := checkCidrPolicy(b.CidrPolicy, fmt.Sprint(elem)); reason != "" {
					return "OUT_OF_BOUNDS", fmt.Sprintf("%s %q %s", p.Name, fmt.Sprint(elem), reason)
				}
			}
		}
		if b.MaxPrefixLen != nil {
			// The CIDR block-size layer. Per-element like CidrPolicy/Pattern; a
			// too-broad prefix or a malformed value fails closed OUT_OF_BOUNDS.
			for _, elem := range elementsOf(v) {
				if reason := checkMaxPrefixLen(*b.MaxPrefixLen, fmt.Sprint(elem)); reason != "" {
					return "OUT_OF_BOUNDS", fmt.Sprintf("%s %q %s", p.Name, fmt.Sprint(elem), reason)
				}
			}
		}
	}
	return "", ""
}

// rfc1918Blocks is the closed set of IPv4 private prefixes (RFC1918). internal-only
// admits only a CIDR wholly inside one of these; no-public additionally treats them
// (and other non-public space) as allowed. Declared as parsed prefixes so the check is
// net/netip containment, never hand-rolled octet/mask arithmetic.
var rfc1918Blocks = []netip.Prefix{
	netip.MustParsePrefix("10.0.0.0/8"),
	netip.MustParsePrefix("172.16.0.0/12"),
	netip.MustParsePrefix("192.168.0.0/16"),
}

// checkCidrPolicy returns "" when value satisfies the named CIDR policy, else a
// human-readable reason (the caller prefixes it with the param name + value). It never
// hand-rolls range math: value is parsed with net/netip and every decision is a library
// classification or a prefix-containment test. Fail-closed on a malformed value OR an
// unrecognized policy name.
func checkCidrPolicy(policy, value string) string {
	p, ok := parseCIDRorIP(value)
	if !ok {
		return fmt.Sprintf("is not a valid IP or CIDR (cidrPolicy %q requires a parseable address)", policy)
	}
	switch policy {
	case "internal-only":
		if !prefixWithinAny(p, rfc1918Blocks) {
			return "is not an internal RFC1918 CIDR (cidrPolicy internal-only rejects public ranges, 0.0.0.0/0, ::/0, and IPv6)"
		}
	case "no-public":
		if reason := violatesNoPublic(p); reason != "" {
			return reason
		}
	case "link-local-30":
		if reason := violatesLinkLocal30(p); reason != "" {
			return reason
		}
	default:
		return fmt.Sprintf("cannot be checked: unrecognized cidrPolicy %q (fail-closed)", policy)
	}
	return ""
}

// linkLocalV4Blocks is the RFC3927 IPv4 link-local block (169.254.0.0/16). The
// link-local-30 policy admits ONLY a /30 wholly inside it — the exact shape AWS
// requires for a site-to-site VPN tunnel's inside interface
// (vpn-set-tunnel-inside-cidr.new_inside_cidr). Declared as a parsed prefix so the
// containment check reuses prefixWithinAny (net/netip), never hand-rolled mask math.
var linkLocalV4Blocks = []netip.Prefix{netip.MustParsePrefix("169.254.0.0/16")}

// violatesLinkLocal30 returns "" when p is a /30 wholly inside 169.254.0.0/16, else the
// reason. Fail-closed on both axes: a prefix that is not exactly /30 (a bare host parses
// to /32, a /29 is broader, a /31 narrower) and a /30 outside the link-local block are
// both refused. IPv6 fails the containment test (cross-family Contains is false), so the
// IPv4-only RFC3927 rule rejects all v6.
func violatesLinkLocal30(p netip.Prefix) string {
	if p.Bits() != 30 {
		return "is not a /30 (cidrPolicy link-local-30 requires exactly a /30 tunnel inside CIDR)"
	}
	if !prefixWithinAny(p, linkLocalV4Blocks) {
		return "is not inside 169.254.0.0/16 (cidrPolicy link-local-30 requires an RFC3927 link-local /30)"
	}
	return ""
}

// checkMaxPrefixLen returns "" when value's CIDR is no broader than /min (its prefix
// length is >= min), else a reason. It rejects a prefix SHORTER than /min: with min=16
// a /8 is refused as too broad, /16 is the inclusive floor (accepted) and /24 is
// narrower (accepted). A bare host address parses to its full bit length (/32 or /128),
// always narrower than any sane min, so single hosts pass. Family-agnostic on Bits()
// — the only caller (waf new_cidr) is IPv4-only by pattern, and a raw-bits floor is the
// conservative reading for any v6 that reached here. Fail-closed on a malformed value.
func checkMaxPrefixLen(min int, value string) string {
	p, ok := parseCIDRorIP(value)
	if !ok {
		return fmt.Sprintf("is not a valid IP or CIDR (maxPrefixLen %d requires a parseable address)", min)
	}
	if p.Bits() < min {
		return fmt.Sprintf("is a /%d, broader than the /%d minimum prefix (maxPrefixLen %d rejects blocks larger than /%d)", p.Bits(), min, min, min)
	}
	return ""
}

// parseCIDRorIP accepts EITHER a CIDR ("10.0.0.0/8", "::/0") or a bare IP ("8.8.8.8",
// "fd00::1"), IPv4 or IPv6, and returns it as a netip.Prefix (a bare IP becomes a host
// prefix — /32 or /128). Anything net/netip cannot parse is refused (ok=false), so a
// malformed value never reaches a policy check.
func parseCIDRorIP(s string) (netip.Prefix, bool) {
	s = strings.TrimSpace(s)
	if p, err := netip.ParsePrefix(s); err == nil {
		return p, true
	}
	if a, err := netip.ParseAddr(s); err == nil {
		return netip.PrefixFrom(a, a.BitLen()), true
	}
	return netip.Prefix{}, false
}

// prefixWithinAny reports whether prefix p is ENTIRELY contained in one of blocks — p is
// at least as specific as the block (block.Bits() <= p.Bits()) and p's network address
// falls inside it. Because every address in p shares its first p.Bits() bits, a base
// inside the block plus a longer-or-equal mask means the whole of p is inside. A
// cross-family p (e.g. IPv6 against IPv4 blocks) is never contained (Contains is
// family-aware), so internal-only rejects all IPv6.
func prefixWithinAny(p netip.Prefix, blocks []netip.Prefix) bool {
	base := p.Masked()
	for _, b := range blocks {
		if b.Bits() <= base.Bits() && b.Contains(base.Addr()) {
			return true
		}
	}
	return false
}

// violatesNoPublic returns "" when p is safe under no-public, else the reason. It refuses
// the default route (a /0), the unspecified address, and any prefix that overlaps public
// unicast space. Overlap is decided soundly WITHOUT computing ranges by hand: a prefix
// that contains any public address always has a public network-base OR a public
// last-address (a private "island" can only sit fully inside a prefix whose base is at/
// near 0 or otherwise public — verified by the unit tests), so checking both endpoints is
// sufficient. isPublic keys on net/netip's own classification.
func violatesNoPublic(p netip.Prefix) string {
	base := p.Masked()
	if base.Bits() == 0 {
		return "is a default route (cidrPolicy no-public rejects 0.0.0.0/0 and ::/0)"
	}
	if base.Addr().IsUnspecified() {
		return "is the unspecified address (cidrPolicy no-public)"
	}
	if isPublic(base.Addr()) || isPublic(lastAddr(base)) {
		return "overlaps public address space (cidrPolicy no-public rejects public unicast ranges)"
	}
	return ""
}

// isPublic reports whether a is a globally-routable public unicast address — a global
// unicast that is NOT RFC1918/RFC4193 private. Loopback, link-local, multicast and the
// unspecified address are not global unicast, so they read as non-public (no-public
// allows those specific hosts). CGNAT (100.64/10) is non-private per net/netip, so it
// reads as public and is refused — the safe default for a public-blocking guardrail.
func isPublic(a netip.Addr) bool {
	return a.IsValid() && a.IsGlobalUnicast() && !a.IsPrivate()
}

// lastAddr returns the highest address in prefix p (all host bits set to 1). It operates
// on net/netip's own 4-/16-byte form — no textual octet parsing — and needs no special
// case for a host prefix (/32 or /128): the host loop simply does not run, so last==base.
func lastAddr(p netip.Prefix) netip.Addr {
	p = p.Masked()
	a := p.Addr()
	if a.Is4() {
		b := a.As4()
		for i := p.Bits(); i < 32; i++ {
			b[i/8] |= 1 << (7 - uint(i%8))
		}
		return netip.AddrFrom4(b)
	}
	b := a.As16()
	for i := p.Bits(); i < 128; i++ {
		b[i/8] |= 1 << (7 - uint(i%8))
	}
	return netip.AddrFrom16(b)
}

// elementsOf returns the values a per-element bound (allowlist/pattern) checks:
//   - a list ([]any — how a list-typed param's value arrives, matching the
//     minItems/maxItems check) yields each member;
//   - a map (map[string]any from YAML/JSON, or the map[any]any shape toStringMap
//     also tolerates) yields BOTH every KEY and every VALUE, so the bound constrains
//     the keys a caller supplies — not just the values. Before the fix a
//     map collapsed to ONE element, its fmt.Sprint form `map[k:v …]`, so the
//     bound never saw the keys and a crafted key carrying the confirmed HCL-injection
//     alphabet ("/=/newline) bypassed validation entirely. Keys are emitted in sorted
//     order (Go map iteration is randomized) so the first-violation reason is stable.
//   - anything else (a scalar) yields v itself: one check with output identical to
//     the pre-fix whole-value comparison.
func elementsOf(v any) []any {
	switch m := v.(type) {
	case []any:
		return m
	case map[string]any:
		return mapElements(m)
	case map[any]any:
		sm := make(map[string]any, len(m))
		for k, val := range m {
			sm[fmt.Sprint(k)] = val
		}
		return mapElements(sm)
	}
	return []any{v}
}

// mapElements flattens a map to its keys and values as bound-checkable elements, in
// sorted-key order (key then its value) for deterministic violation reporting.
func mapElements(m map[string]any) []any {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	out := make([]any, 0, 2*len(m))
	for _, k := range keys {
		out = append(out, k, m[k])
	}
	return out
}

func toFloat(v any) (float64, bool) {
	switch n := v.(type) {
	case float64:
		return n, true
	case float32:
		return float64(n), true
	case int:
		return float64(n), true
	case int64:
		return float64(n), true
	case json.Number:
		f, err := n.Float64()
		return f, err == nil
	case string:
		f, err := strconv.ParseFloat(n, 64)
		return f, err == nil
	}
	return 0, false
}
