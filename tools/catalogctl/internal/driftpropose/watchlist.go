package driftpropose

import (
	"encoding/json"
	"fmt"
	"os"
	"path"
	"path/filepath"
)

// watchlist.go implements spec addendum A1's "fourth screen" (plan
// 2026-07-20-drift-audit-fixes.md finding F4): a forged envelope with
// securityHits stripped and class relabeled benign_inplace is adopt-eligible at
// every screen that only reads the envelope's OWN fields (ClassifyByFields,
// §8 enforcement point 1's IsSecurityPosture union). The fourth screen closes
// that gap on the two planes that hold a checkout — the generator (this file,
// wired from Generate) and the bundle gate's edit replay (drift-edit, Lane A2)
// — by matching every ADOPT-bucket changed path against the CHECKOUT'S OWN
// scripts/drift/security-watchlist.json, independent of what the envelope
// claims. This screen guards the drift-adopt shortcut only; C2's legitimize
// front door is deliberately outside its scope (its guard is the engineer tier
// + full ladder, not concealment).
//
// Matching mirrors scripts/drift/classify.py's _pattern_hits/security_hits
// exactly in shape: a pattern hits when it matches the full normalized dotted
// path (indices stripped), the top-level segment, or the leaf segment — first
// against resource_types[type].attributes (a literal "*" always hits), else
// against attribute_patterns (skipping any entry whose except_types names the
// resource type). Go uses path.Match where Python uses fnmatch.fnmatchcase — a
// documented divergence: path.Match treats '/' as a path separator that '*'
// does not cross, while Python's fnmatch does not special-case '/' at all. The
// curated watchlist file's patterns are all simple identifiers/globs with no
// '/' in them, so this divergence never changes a real match outcome; it is
// called out here so a future pattern author does not rely on '*' crossing '/'.

// watchlistRelPath is the fixed, checkout-relative location spec addendum A1
// names: "<repo>/scripts/drift/security-watchlist.json" — the repo ROOT,
// independent of --root (a drift envelope's resources live under
// environments/prod, but the watchlist file itself does not).
const watchlistRelPath = "scripts/drift/security-watchlist.json"

// Watchlist is the parsed scripts/drift/security-watchlist.json — the checkout
// BEING EDITED's own copy. Field names/shape mirror the real file exactly (see
// the repo's scripts/drift/security-watchlist.json) so the same JSON parses
// identically whether read from production or a test fixture.
type Watchlist struct {
	ResourceTypes     map[string]WatchlistResourceType `json:"resource_types"`
	AttributePatterns []WatchlistAttrPattern           `json:"attribute_patterns"`
	// CreationSecurityTypes is spec 2026-07-20-ccp-oob-provisioning-import.md
	// §5.3's additive top-level key: a flat list of resource types whose
	// CREATION (never merely a change) is a security decision (F-2) —
	// classify.py ignores this key (tolerant), it exists only for the
	// import screens (importwatchlist.go). A pointer so "key present but
	// empty" (a deliberately empty curated list — screens clean) is
	// distinguishable from "key absent entirely" (nil — fail-closed, spec:
	// "Missing/unparseable watchlist or key absent ⇒ the ENTIRE import
	// bucket is ungenerable").
	CreationSecurityTypes *[]string `json:"creation_security_types"`
}

// WatchlistResourceType is one resource_types[type] entry: the attribute name
// globs that make ANY change to that resource type security-posture (a literal
// "*" in Attributes matches everything, mirroring classify.py's own
// `pat == "*" or _pattern_hits(pat, path)` short-circuit).
type WatchlistResourceType struct {
	Attributes []string `json:"attributes"`
	Why        string   `json:"why"`
}

// WatchlistAttrPattern is one attribute_patterns[] entry: a glob tested against
// every resource type NOT already matched by its own resource_types entry,
// unless that type is named in ExceptTypes.
type WatchlistAttrPattern struct {
	Pattern     string   `json:"pattern"`
	Why         string   `json:"why"`
	ExceptTypes []string `json:"except_types"`
}

// LoadWatchlist reads and parses <repo>/scripts/drift/security-watchlist.json.
// A missing or unparseable file is returned as an error — the caller's doctrine
// is fail-closed (spec addendum A1): refuse the WHOLE adopt bucket, never guess
// verdict-by-verdict which paths would have been safe.
func LoadWatchlist(repo string) (*Watchlist, error) {
	p := filepath.Join(repo, filepath.FromSlash(watchlistRelPath))
	b, err := os.ReadFile(p)
	if err != nil {
		return nil, fmt.Errorf("security watchlist unreadable in checkout (%s): %w", watchlistRelPath, err)
	}
	var w Watchlist
	if err := json.Unmarshal(b, &w); err != nil {
		return nil, fmt.Errorf("security watchlist unreadable in checkout (%s): %w", watchlistRelPath, err)
	}
	return &w, nil
}

// Hit reports the fourth-screen watchlist match (if any) for one changed
// attribute — resource type rtype, structured path segs — mirroring
// classify.py's security_hits/_pattern_hits: resource_types[rtype].attributes
// is tried first (a "*" entry always hits), then attribute_patterns (skipping
// any entry whose except_types names rtype); the first hit wins. hit=false
// means no match at all.
func (w *Watchlist) Hit(rtype string, segs []any) (why string, hit bool) {
	np := normPath(segs)
	top, leaf := topAndLeaf(segs)
	candidates := []string{np, top, leaf}

	if rt, ok := w.ResourceTypes[rtype]; ok {
		for _, pat := range rt.Attributes {
			if pat == "*" || matchesAny(pat, candidates) {
				return rt.Why, true
			}
		}
	}
	for _, ap := range w.AttributePatterns {
		if containsStr(ap.ExceptTypes, rtype) {
			continue
		}
		if matchesAny(ap.Pattern, candidates) {
			return ap.Why, true
		}
	}
	return "", false
}

// ScreenVerdict runs the fourth screen over every changed attribute of an
// ADOPT-bucket verdict v. Every row is presumed already expressible (v reached
// here only after ClassifyByFields returned BucketAdopt, which already gated
// every row through PathExpressible) — a row this screen cannot resolve
// segments for is skipped, never treated as a hit or a pass-through, since that
// is ClassifyByFields'/GenerateAdopt's job, not this screen's. Returns the
// ready-to-use ungenerable reason string (spec addendum A1's exact wording) for
// the FIRST hit found; hit=false means no path on this verdict matches.
func (w *Watchlist) ScreenVerdict(v Verdict) (reason string, hit bool) {
	for _, ca := range v.ChangedAttrs {
		segs, ok := ExpressibleSegments(ca)
		if !ok {
			continue
		}
		if why, matched := w.Hit(v.Type, segs); matched {
			return fmt.Sprintf(
				"attribute %q matches the checkout security watchlist (%s) — security-posture is revert-only (fourth screen, §8)",
				ca.Path, why), true
		}
	}
	return "", false
}

// normPath mirrors classify.py's norm_path: join every NON-INT segment with
// ".", indices stripped entirely — ("root_block_device", 0, "volume_size") ->
// "root_block_device.volume_size".
func normPath(segs []any) string {
	var parts []string
	for _, s := range segs {
		if _, isInt := s.(int); isInt {
			continue
		}
		parts = append(parts, fmt.Sprint(s))
	}
	out := ""
	for i, p := range parts {
		if i > 0 {
			out += "."
		}
		out += p
	}
	return out
}

// topAndLeaf mirrors classify.py's segs[0]/segs[-1] over the non-int-filtered
// segment list — the top-level attribute and the leaf segment, each as a bare
// string (never further split, so a dotted/slashed map key stays one segment).
func topAndLeaf(segs []any) (top, leaf string) {
	var strs []string
	for _, s := range segs {
		if _, isInt := s.(int); isInt {
			continue
		}
		strs = append(strs, fmt.Sprint(s))
	}
	if len(strs) == 0 {
		return "", ""
	}
	return strs[0], strs[len(strs)-1]
}

// matchesAny reports whether pattern (a curated-file glob) matches any of
// candidates via path.Match (see this file's header for the fnmatch
// divergence). A malformed pattern (path.Match's ErrBadPattern) never matches —
// the curated file's patterns are static/trusted, so this is belt-and-braces,
// not an expected path.
func matchesAny(pattern string, candidates []string) bool {
	for _, c := range candidates {
		if ok, err := path.Match(pattern, c); err == nil && ok {
			return true
		}
	}
	return false
}

func containsStr(list []string, want string) bool {
	for _, s := range list {
		if s == want {
			return true
		}
	}
	return false
}
