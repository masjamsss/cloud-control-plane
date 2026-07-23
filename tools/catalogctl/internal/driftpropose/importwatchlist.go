package driftpropose

import "fmt"

// importwatchlist.go implements spec 2026-07-20-ccp-oob-provisioning-import.md
// §5.3's screen 1/3: the checkout's OWN scripts/drift/security-watchlist.json
// additive `creation_security_types` key (F-2) — the creation-time analog of
// watchlist.go's Hit/ScreenVerdict (which classifies attribute CHANGES). A
// CREATION has no attribute path to match against; the whole resource TYPE is
// the security decision (spec: "an aws_instance row [in the attribute
// watchlist] means 'these attributes are security-posture *when they
// change*', not 'an instance is a security object'"). Called independently at
// EVERY plane that touches a checkout for an import (generate.go's finding
// loop — screen 1; driftedit.go's import handler — screen 3), never trusting
// a finding's own advisory securityFamily field (finding.go's ClassifyFinding
// is the field-only, checkout-independent signal; this is the authoritative,
// checkout-based re-derivation).

// ScreenCreationSecurity re-derives F-2 from the checkout's OWN
// creation_security_types list, independent of what a finding's own
// securityFamily field claims. A key that is ABSENT from the parsed file (as
// opposed to present-and-empty) makes the WHOLE import bucket ungenerable —
// expressed here as every tfType hitting, fail-closed (spec: "self-heals
// when the checkout's main carries the key").
func (w *Watchlist) ScreenCreationSecurity(tfType string) (reason string, hit bool) {
	if w.CreationSecurityTypes == nil {
		return "checkout security watchlist carries no creation_security_types key — refusing every import (fail-closed; self-heals once the checkout's main carries the key, spec §5.3)", true
	}
	for _, t := range *w.CreationSecurityTypes {
		if t == tfType {
			return fmt.Sprintf(
				"tfType %q matches the checkout security watchlist's creation_security_types — creation-security is never portal-importable; investigate per runbook D2/D5 (the actor evidence is the head start), then either delete-in-AWS (human + owner sign-off) or a manual engineer-tier kit-lane import PR (§8)",
				tfType), true
		}
	}
	return "", false
}
