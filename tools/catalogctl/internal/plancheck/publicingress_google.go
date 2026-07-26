package plancheck

import (
	"fmt"
	"strings"

	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/manifests"
)

// publicingress_google.go implements the google twin of plan-check R7 (see
// publicingress.go and publicingress_azure.go, ADR-0034 lane G1): a NON-
// engineer_only op may never INTRODUCE a public source range on an ingress-allow
// google_compute_firewall rule.
//
// GCP's firewall shape differs from both incumbents: one google_compute_firewall
// resource IS one rule, carrying an explicit direction (INGRESS/EGRESS), a set of
// allow{} and/or deny{} blocks, and source_ranges[] (CIDRs only — GCP has no
// "Internet"/"*" service-tag vocabulary; the world-open spelling is 0.0.0.0/0 or
// ::/0, and any public CIDR is equally a finding, judged by the same RFC1918
// containment the azure twin uses). Deny-only rules and EGRESS rules are never in
// scope. source_tags / source_service_accounts are identity-scoped (private by
// construction) and out of scope.
//
// Two deliberate strictness choices, each documented for the reviewer:
//   - An ABSENT/empty direction counts as INGRESS — that is the provider's own
//     default, so an author who omits direction gets the ingress reading GCP
//     itself will apply.
//   - A disabled=true rule is still in scope: exempting it would open a two-step
//     bypass (land the world-open rule disabled — unflagged — then flip disabled
//     to false, which introduces no new source and so would pass the
//     introduced-not-preexisting diff). Flagging at introduction closes it.
//
// It is additive and independent of R7 and R7-azure: same Violation shape, same
// engineer_only exemption, same introduced-not-preexisting diff.

// googlePublicSource reports whether a google_compute_firewall source_ranges
// element denotes a public source: a parseable CIDR/IP that is not wholly
// contained in RFC1918 private space (0.0.0.0/0, ::/0, and any public range or
// host). A value net/netip cannot parse is out of this guard's scope and passes
// — belt-and-braces for the declared spellings, not a general validator (the
// same posture as azurePublicSource, whose parse/containment helpers this
// reuses; they are package-level and provider-neutral).
func googlePublicSource(src string) bool {
	s := strings.TrimSpace(src)
	if s == "" {
		return false
	}
	p, ok := parseAzureCIDR(s)
	if !ok {
		return false
	}
	return !withinRFC1918(p)
}

// checkPublicIngressGoogle is the google twin of R7. For each changed
// google_compute_firewall under a non-engineer op, it returns a Violation for
// every public ingress-allow source range the change introduces (in after, not
// in before).
func checkPublicIngressGoogle(op manifests.Op, plan Plan) []Violation {
	if op.Exposure == "engineer_only" {
		return nil // engineer-authored public rules are out of scope for this L1 guard.
	}
	var violations []Violation
	for _, c := range plan.ResourceChanges {
		if !changed(c.Change.Actions) {
			continue
		}
		if resourceType(c.Address) != "google_compute_firewall" {
			continue
		}
		before := map[string]bool{}
		for _, src := range ingressAllowSourceRanges(c.Change.Before) {
			before[src] = true
		}
		for _, src := range ingressAllowSourceRanges(c.Change.After) {
			if googlePublicSource(src) && !before[src] {
				violations = append(violations, Violation{
					Rule:    "no-public-ingress-google",
					Address: c.Address,
					Reason:  fmt.Sprintf("a non-engineer op introduces a public ingress source range %q on google_compute_firewall — public ingress must be engineer-authored", src),
				})
			}
		}
	}
	return violations
}

// ingressAllowSourceRanges extracts every source_ranges element of a
// google_compute_firewall state map (a plan change's before or after) when the
// rule is an ingress ALLOW rule: direction is INGRESS or absent (the provider's
// own default), and at least one allow{} block is present. A deny-only rule and
// an EGRESS rule contribute nothing (an egress rule's source_ranges is not a
// meaningful exposure surface; its reach is destination_ranges, out of scope
// here for the same reason egress is out of scope in both incumbent twins).
func ingressAllowSourceRanges(state map[string]any) []string {
	if state == nil {
		return nil
	}
	if dir, _ := state["direction"].(string); dir != "" && !strings.EqualFold(dir, "INGRESS") {
		return nil
	}
	if len(asSlice(state["allow"])) == 0 {
		return nil
	}
	return asStringSlice(state["source_ranges"])
}
