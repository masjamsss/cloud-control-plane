package driftpropose

import (
	"fmt"
	"strings"
)

// finding.go carries spec 2026-07-20-ccp-oob-provisioning-import.md §2.4's
// sweep finding shape and §5.2's finding partition (Go's ClassifyFinding —
// one of the "one table, three implementations, one fixture" trio, kept
// honest by testdata/driftpropose/unmanaged-cases.json). A finding has no
// Terraform address (§3.1: "that is its defining property") — it is a
// candidate for a NEW import proposal, never an edit to an existing one, so
// none of partition.go's ClassifyByFields machinery applies to it.

// findingClass is the constant class id every sweep finding carries
// (importer/kit/statediff.py's FINDING_CLASS) — the L30/D5 unmanaged-resource
// id, distinct from the eleven verdict classes knownClasses enumerates.
const findingClass = "unmanaged_resource"

// The additive Bucket values §5.2's finding-partition table adds alongside
// the existing verdict buckets (BucketAdopt/BucketRevert/BucketUngenerable,
// partition.go). Only F-1..F-4 are reachable here: F-5 (ignored) and F-6
// (family-level-only) never become finding rows at all (statediff.py filters
// them before writing unmanaged-findings.json), and F-7 (invisible) is never
// captured — see spec §5.2's table and §10's coverage doctrine.
const (
	// BucketImport is F-1: import-eligible — a portal import proposal.
	BucketImport Bucket = "import"
	// BucketCreationSecurity is F-2: never portal-importable — the manual
	// engineer-tier kit-lane PR is the front door (spec §8 invariant 1).
	BucketCreationSecurity Bucket = "creation_security"
	// BucketTypeUnmapped is F-3: tfType absent — outside the services.json
	// 43-type map.
	BucketTypeUnmapped Bucket = "type_unmapped"
	// BucketPayloadWithheld is F-4: a mechanical publisher-side refusal
	// (secret battery, parse ambiguity, probe-plan failure, the 20-candidate
	// cap, or a label refusal) — surfaced with the reason, never guessed at.
	BucketPayloadWithheld Bucket = "payload_withheld"
)

// FindingImportPayload is one finding's own nested importPayload (spec
// §2.4/§2.6, importer/kit/payloads.py's exact attachment shape): the exact
// reviewed bytes, address-keyed. Complete reports whether every sub-field
// F-1's condition names ("importBlock + skeletonHcl + address + targetFile")
// is non-empty — nil-safe (a nil *FindingImportPayload is simply incomplete),
// so callers never need a separate nil check first.
type FindingImportPayload struct {
	Address     string `json:"address"`
	TargetFile  string `json:"targetFile"`
	ImportBlock string `json:"importBlock"`
	SkeletonHcl string `json:"skeletonHcl"`
}

func (p *FindingImportPayload) complete() bool {
	return p != nil && p.Address != "" && p.TargetFile != "" && p.ImportBlock != "" && p.SkeletonHcl != ""
}

// Finding is one envelope.sweep.findings[] row (spec §2.4) — the fields this
// engine actually consumes: class (fail-closed pinned to findingClass), arn
// (nil when not trivially derivable — importer/kit/statediff.py's
// arn_if_derivable), tfType, liveId, the finding's own ADVISORY
// securityFamily copy (§5.2's field-only F-2 signal, mirroring how
// ClassifyByFields trusts a verdict's own class/securityHits fields; the
// checkout-based re-derivation in generate.go/driftedit.go is a SEPARATE,
// authoritative screen that never trusts this field alone — spec §8
// invariant 1's "three independent screens"), and importPayload /
// payloadWithheldReason (§2.6). Display-only fields (name, service,
// stateful, region, actor) are deliberately untyped, mirroring Verdict's own
// "known fields typed" set — this engine renders no markdown.
type Finding struct {
	Class                 string                `json:"class"`
	Arn                   *string               `json:"arn"`
	TfType                string                `json:"tfType"`
	LiveID                string                `json:"liveId"`
	SecurityFamily        bool                  `json:"securityFamily"`
	ImportPayload         *FindingImportPayload `json:"importPayload"`
	PayloadWithheldReason *string               `json:"payloadWithheldReason"`
}

// Sweep is the envelope's additive "sweep" section (spec §3.1), verbatim
// from importer/kit/statediff.py's --out document (optionally actor- and
// payload-enriched). Only `findings` is typed — method/capturedAt/region/
// totalFindings/ignoredCount/coverage are display data this engine never
// reads, the same tolerant-parse doctrine Report applies to verdicts.
type Sweep struct {
	Findings []Finding `json:"findings"`
}

// findingKey is the display identifier for a finding-sourced Ungenerable row
// (which, unlike a verdict, has no Terraform address to key on — §3.1 "that
// is its defining property"): arn when derivable, else the same
// tfType+liveId compound key §3.2's duplicate-finding ingest rule uses.
func findingKey(f Finding) string {
	if f.Arn != nil && *f.Arn != "" {
		return *f.Arn
	}
	return f.TfType + "/" + f.LiveID
}

// ClassifyFinding partitions one sweep finding per spec §5.2's table (rows
// F-1..F-4 — see this file's Bucket doc for why F-5/F-6/F-7 never reach
// here). Pure and checkout-independent — the SAME shared implementation
// testdata/driftpropose/unmanaged-cases.json pins byte-for-byte, consumed
// identically by this Go generator, the api's TS re-check, and the app's TS
// advisory partition (spec: "one table, three implementations, one
// fixture"). Exactly like ClassifyByFields trusts a verdict's OWN
// class/securityHits fields for its security screen (never the checkout
// watchlist — that is a SEPARATE, Go-only fourth screen layered on top by
// Generate/drift-edit), this trusts a finding's OWN securityFamily field for
// F-2; the checkout-based creation_security_types re-derivation (§5.3
// screen 1/3, importwatchlist.go) is layered on top by
// GenerateWithImport/drift-edit, independent of and never trusting this
// field alone.
func ClassifyFinding(f Finding) (Bucket, string) {
	if f.Class != findingClass {
		return BucketUngenerable, fmt.Sprintf(
			"finding class %q is not %q — fail-closed, needs-human (the finding partition only recognizes the constant unmanaged_resource class id)", f.Class, findingClass)
	}
	if strings.TrimSpace(f.TfType) == "" {
		return BucketTypeUnmapped,
			"tfType is absent — this resource type is outside the services.json 43-type map; extend services.json (a data change + fixture) or use the manual kit import lane"
	}
	if f.SecurityFamily {
		return BucketCreationSecurity, fmt.Sprintf(
			"tfType %q is flagged securityFamily — creation-security types are never portal-importable; investigate per runbook D2/D5 (the actor evidence is the head start), then either delete-in-AWS (human + owner sign-off) or a manual engineer-tier kit-lane import PR",
			f.TfType)
	}
	if !f.ImportPayload.complete() {
		reason := "no import payload was generated for this finding — payload generation may not be armed for this sweep, this finding fell outside the 20-candidate cap, or it was excluded upstream; see the sweep run's payload step"
		if f.PayloadWithheldReason != nil && strings.TrimSpace(*f.PayloadWithheldReason) != "" {
			reason = *f.PayloadWithheldReason
		}
		return BucketPayloadWithheld, reason
	}
	return BucketImport, "unmanaged resource — import-eligible"
}
