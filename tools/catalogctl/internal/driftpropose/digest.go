package driftpropose

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"sort"
)

// Attr is one changed-attribute row inside a generated proposal (spec §6.1/§3.2):
// the resource address, the classifier's dotted/bracketed attribute path, the
// structured segment form of that same path (spec addendum A4/F8 — always
// populated by the generator, from the verdict's own pathSegments or derived from
// the legacy display-path parse; PREFER this field over re-splitting Path), and
// the exact JSON values — nil renders as JSON null (absent/sensitive), matching
// §2.4's digest formula and §6.1's proposals.json attrs shape. PathSegments sits
// right after Path in this struct — the field order the §2.4 digest formula now
// hashes (see digestInput below): two different drifts can share one display
// string (`tags.a.b` = map key "a.b" OR a nested block "a"."b") — excluding
// segments from the digest would collide their storage keys.
type Attr struct {
	Address      string `json:"address"`
	Path         string `json:"path"`
	PathSegments []any  `json:"pathSegments,omitempty"`
	LiveJSON     any    `json:"liveJson"`
	CodeJSON     any    `json:"codeJson"`
}

// digestInput is the exact, order-controlled shape §2.4 hashes:
// {flavor, addresses (sorted), attrs (sorted rows)} — deliberately excludes
// capturedAt/runId/commit/diff text, so the digest IS the storage key and
// regenerating identical drift from a later snapshot is idempotent (no duplicate
// proposal can exist). Attrs' own field order carries PathSegments right after
// Path (spec addendum A4) — a pre-arming formula change, authorized because the
// generation lane has never been armed (0018: WI-8 not started; no production
// digest exists to invalidate).
type digestInput struct {
	Flavor    string   `json:"flavor"`
	Addresses []string `json:"addresses"`
	Attrs     []Attr   `json:"attrs"`
}

// ProposalDigest computes spec §2.4's proposalDigest (as amended by addendum A4):
// sha256 hex over the canonical JSON of {flavor, addresses (sorted), attrs
// (sorted rows of {address, path, pathSegments, liveJson|null, codeJson|null})}.
// addresses/attrs are sorted on COPIES (the caller's slices are never mutated or
// reordered) so the digest never depends on generation order. "Canonical" here
// means encoding/json's own output: compact, no insignificant whitespace, and —
// the load-bearing guarantee — map/object keys are rendered in a fixed order
// because every value marshaled here is either a fixed-field Go struct or a
// pre-sorted slice, never a bare Go map.
func ProposalDigest(flavor string, addresses []string, attrs []Attr) string {
	addrs := append([]string(nil), addresses...)
	sort.Strings(addrs)
	rows := append([]Attr(nil), attrs...)
	sort.Slice(rows, func(i, j int) bool {
		if rows[i].Address != rows[j].Address {
			return rows[i].Address < rows[j].Address
		}
		return rows[i].Path < rows[j].Path
	})
	in := digestInput{Flavor: flavor, Addresses: addrs, Attrs: rows}
	b, err := json.Marshal(in)
	if err != nil {
		// Attr.LiveJSON/CodeJSON are always produced by json.Unmarshal into `any`
		// (string/float64/bool/nil/[]any/map[string]any — see envelope.go's
		// liveValue/codeValue) so a re-Marshal here cannot fail; a panic would mean a
		// caller synthesized an Attr outside that contract.
		panic("driftpropose: canonical digest marshal: " + err.Error())
	}
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

// importDigestInput is the exact, order-controlled shape
// 2026-07-20-ccp-oob-provisioning-import.md §5.4 hashes for the "import"
// flavor — deliberately NOT digestInput (adopt/revert's own canonical shape:
// attrs rows, no arn/tfType/liveId; import carries a payload, not attribute
// edits, so it has no Attrs to hash at all). ImportBlock/SkeletonHcl are
// hashed (sha256 hex) rather than embedded verbatim, exactly as the spec
// formula states — the digest computation never depends on how a caller
// chose to represent/escape the payload text; two byte-identical skeletons
// always hash identically. No capturedAt/runId/commit in the input, mirroring
// digestInput: the same drift observed twice yields the same digest.
type importDigestInput struct {
	Flavor            string   `json:"flavor"`
	Addresses         []string `json:"addresses"`
	Arn               *string  `json:"arn"`
	TfType            string   `json:"tfType"`
	LiveID            string   `json:"liveId"`
	ImportBlockSHA256 string   `json:"importBlockSha256"`
	SkeletonHclSHA256 string   `json:"skeletonHclSha256"`
}

// ImportProposalDigest computes spec §5.4's proposalDigest(import): sha256
// hex over the canonical JSON of {flavor:"import", addresses (sorted), arn,
// tfType, liveId, sha256(importBlock), sha256(skeletonHcl)}. addresses is
// sorted on a copy, matching ProposalDigest's own never-mutate-the-caller's-
// slice discipline (a single-address import proposal today, per-batched-item
// tomorrow — sorting is free insurance either way).
func ImportProposalDigest(addresses []string, arn *string, tfType, liveID, importBlock, skeletonHcl string) string {
	addrs := append([]string(nil), addresses...)
	sort.Strings(addrs)
	in := importDigestInput{
		Flavor:            "import",
		Addresses:         addrs,
		Arn:               arn,
		TfType:            tfType,
		LiveID:            liveID,
		ImportBlockSHA256: sha256Hex(importBlock),
		SkeletonHclSHA256: sha256Hex(skeletonHcl),
	}
	b, err := json.Marshal(in)
	if err != nil {
		// Every field here is a plain string/*string/[]string — a re-Marshal
		// cannot fail; a panic would mean encoding/json itself is broken.
		panic("driftpropose: canonical import digest marshal: " + err.Error())
	}
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

// sha256Hex is the plain sha256-hex-digest helper the import digest formula
// names twice (sha256(importBlock), sha256(skeletonHcl)) — distinct from
// ProposalDigest's own canonical-JSON digest, this just hashes raw text.
func sha256Hex(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}
