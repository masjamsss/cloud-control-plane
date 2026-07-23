package plancheck

import (
	"fmt"
	"net/netip"
	"strings"

	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/manifests"
)

// publicingress_azure.go implements the azurerm twin of plan-check R7 (see
// publicingress.go): a NON-engineer_only op may never INTRODUCE an INBOUND ALLOW rule
// that exposes a public source on an Azure network security group.
//
// Azure has no AWS-style implicit-allow security group: an
// azurerm_network_security_rule / azurerm_network_security_group security_rule block
// carries an explicit direction (Inbound/Outbound) and access (Allow/Deny), so unlike
// ingressCIDRs (which trusts the AWS resource shape itself to mean "ingress = allow"),
// this file also gates on direction=="Inbound" && access=="Allow" before a source is
// even considered. Two shapes, mirroring aws_security_group /
// aws_vpc_security_group_ingress_rule:
//   - azurerm_network_security_group: inline security_rule[] blocks.
//   - azurerm_network_security_rule: the standalone rule resource, same fields at the
//     top level.
//
// It is additive and independent of R7 (checkPublicIngress): same Violation shape,
// same engineer_only exemption, same introduced-not-preexisting diff (a public rule
// already present in `before` is not re-flagged when an unrelated edit changes the
// resource). Deny rules and outbound rules are never in scope; a private-source allow
// rule passes.

// azureRFC1918Blocks is the closed set of IPv4 private prefixes (RFC1918) a source
// CIDR must sit wholly inside of to pass. Declared as parsed prefixes so containment
// is net/netip, never hand-rolled octet/mask arithmetic — the same discipline as
// manifests.go's rfc1918Blocks (unexported there and scoped to request-param bounds
// checking, so mirrored locally here rather than imported across the package
// boundary).
var azureRFC1918Blocks = []netip.Prefix{
	netip.MustParsePrefix("10.0.0.0/8"),
	netip.MustParsePrefix("172.16.0.0/12"),
	netip.MustParsePrefix("192.168.0.0/16"),
}

// azurePublicSource reports whether an Azure NSG source_address_prefix /
// source_address_prefixes element denotes a public source. Three closed-vocabulary
// tokens Azure/Terraform authors use for "the whole internet" — the wildcard "*", the
// "Internet" service tag, and the "any" spelling some authors substitute for it — are
// matched case-insensitively (operators do not reliably case service-tag strings).
// Anything else is treated as a CIDR/IP: net/netip parses it and a prefix wholly
// contained in RFC1918 private space passes, everything else (a public range, the
// default route 0.0.0.0/0, IPv6, or a block broader than the RFC1918 range it
// partially overlaps) is public. A value that is neither a recognized token nor a
// parseable address — an Azure service tag other than Internet, e.g. VirtualNetwork or
// AzureLoadBalancer, or plain garbage — is out of this guard's scope and passes; R7-
// azure is belt-and-braces for the declared spellings, not a general validator.
func azurePublicSource(src string) bool {
	s := strings.TrimSpace(src)
	if s == "" {
		return false
	}
	if s == "*" || strings.EqualFold(s, "internet") || strings.EqualFold(s, "any") {
		return true
	}
	p, ok := parseAzureCIDR(s)
	if !ok {
		return false
	}
	return !withinRFC1918(p)
}

// parseAzureCIDR accepts EITHER a CIDR ("10.0.0.0/8") or a bare IP ("8.8.8.8"), IPv4
// or IPv6, and returns it as a netip.Prefix (a bare IP becomes a host prefix — /32 or
// /128). Anything net/netip cannot parse is refused (ok=false), so a malformed value
// never reaches the RFC1918 containment test.
func parseAzureCIDR(s string) (netip.Prefix, bool) {
	if p, err := netip.ParsePrefix(s); err == nil {
		return p, true
	}
	if a, err := netip.ParseAddr(s); err == nil {
		return netip.PrefixFrom(a, a.BitLen()), true
	}
	return netip.Prefix{}, false
}

// withinRFC1918 reports whether p is ENTIRELY contained in one of azureRFC1918Blocks —
// p is at least as specific as the block (block.Bits() <= p.Bits()) and p's network
// address falls inside it. A cross-family p (IPv6 against the IPv4-only RFC1918
// blocks) is never contained, so every IPv6 source reads as public under this guard.
func withinRFC1918(p netip.Prefix) bool {
	base := p.Masked()
	for _, b := range azureRFC1918Blocks {
		if b.Bits() <= base.Bits() && b.Contains(base.Addr()) {
			return true
		}
	}
	return false
}

// checkPublicIngressAzure is the azurerm twin of R7 (checkPublicIngress). For each
// changed azurerm_network_security_group / azurerm_network_security_rule under a
// non-engineer op, it returns a Violation for every public inbound-allow source the
// change introduces (in after, not in before).
func checkPublicIngressAzure(op manifests.Op, plan Plan) []Violation {
	if op.Exposure == "engineer_only" {
		return nil // engineer-authored public rules are out of scope for this L1 guard.
	}
	var violations []Violation
	for _, c := range plan.ResourceChanges {
		if !changed(c.Change.Actions) {
			continue
		}
		rtype := resourceType(c.Address)
		if rtype != "azurerm_network_security_group" && rtype != "azurerm_network_security_rule" {
			continue
		}
		before := map[string]bool{}
		for _, src := range inboundAllowSources(c.Change.Before, rtype) {
			before[src] = true
		}
		for _, src := range inboundAllowSources(c.Change.After, rtype) {
			if azurePublicSource(src) && !before[src] {
				violations = append(violations, Violation{
					Rule:    "no-public-ingress-azure",
					Address: c.Address,
					Reason:  fmt.Sprintf("a non-engineer op introduces a public inbound-allow source %q on %s — public ingress must be engineer-authored", src, rtype),
				})
			}
		}
	}
	return violations
}

// inboundAllowSources extracts every source_address_prefix / source_address_prefixes
// element of the INBOUND ALLOW rules on an Azure NSG state map (a plan change's before
// or after), for the given resource type. Two shapes:
//   - azurerm_network_security_group: inline security_rule[] blocks, each checked for
//     direction=="Inbound" && access=="Allow" individually (a group can mix both
//     directions and both accesses across its rules).
//   - azurerm_network_security_rule: the standalone resource IS one rule; its own
//     direction/access gate whether its source fields are collected at all.
//
// Outbound rules and Deny rules are excluded at this layer (same rationale as
// publicingress.go's ingressCIDRs excluding egress): neither is a finding.
func inboundAllowSources(state map[string]any, rtype string) []string {
	if state == nil {
		return nil
	}
	switch rtype {
	case "azurerm_network_security_group":
		var out []string
		for _, blk := range asSlice(state["security_rule"]) {
			m, ok := blk.(map[string]any)
			if !ok {
				continue
			}
			out = append(out, ruleSourcesIfInboundAllow(m)...)
		}
		return out
	case "azurerm_network_security_rule":
		return ruleSourcesIfInboundAllow(state)
	}
	return nil
}

// ruleSourcesIfInboundAllow returns rule's source_address_prefix /
// source_address_prefixes when direction=="Inbound" && access=="Allow" (the exact
// Terraform-normalized spellings the azurerm provider emits), else nil.
func ruleSourcesIfInboundAllow(rule map[string]any) []string {
	direction, _ := rule["direction"].(string)
	access, _ := rule["access"].(string)
	if direction != "Inbound" || access != "Allow" {
		return nil
	}
	var out []string
	if s, ok := rule["source_address_prefix"].(string); ok && s != "" {
		out = append(out, s)
	}
	out = append(out, asStringSlice(rule["source_address_prefixes"])...)
	return out
}
