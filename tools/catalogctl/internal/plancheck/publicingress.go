package plancheck

import (
	"fmt"
	"strings"

	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/manifests"
)

// publicingress.go implements plan-check R7 (networking-readiness audit): a NON-
// engineer_only op may never INTRODUCE a world-open ingress CIDR (0.0.0.0/0 or ::/0)
// on a security group.
//
// R7 is belt-and-braces for manifests.Bounds.CidrPolicy (the primary, edit-time
// refusal): even an op that forgot to declare cidrPolicy — or a future op that emits
// ingress by some other path — cannot silently land a world-open ingress rule, because
// the mechanical L2 verifier vetoes the generated plan. It is INGRESS-scoped: a world-
// open EGRESS (allow-all outbound) is the normal default and never a finding. It fires
// only on an INTRODUCED CIDR (present in after, absent from before), so appending an
// internal rule to a group that already has a (previously engineer-authored) public
// rule is not falsely flagged. engineer_only ops are exempt — a deliberate public rule
// authored by an engineer is outside the L1 self-service surface this guards.

// worldOpenCIDR is the closed set of "the entire internet" ingress sources.
var worldOpenCIDR = map[string]bool{
	"0.0.0.0/0": true,
	"::/0":      true,
}

// checkPublicIngress is R7. For each changed aws_security_group /
// aws_vpc_security_group_ingress_rule under a non-engineer op, it returns a Violation
// for every world-open ingress CIDR the change introduces (in after, not in before).
func checkPublicIngress(op manifests.Op, plan Plan) []Violation {
	if op.Exposure == "engineer_only" {
		return nil // engineer-authored public rules are out of scope for this L1 guard.
	}
	var violations []Violation
	for _, c := range plan.ResourceChanges {
		if !changed(c.Change.Actions) {
			continue
		}
		rtype := resourceType(c.Address)
		if rtype != "aws_security_group" && rtype != "aws_vpc_security_group_ingress_rule" {
			continue
		}
		before := map[string]bool{}
		for _, cidr := range ingressCIDRs(c.Change.Before, rtype) {
			before[cidr] = true
		}
		for _, cidr := range ingressCIDRs(c.Change.After, rtype) {
			if worldOpenCIDR[cidr] && !before[cidr] {
				violations = append(violations, Violation{
					Rule:    "no-public-ingress",
					Address: c.Address,
					Reason:  fmt.Sprintf("a non-engineer op introduces a world-open ingress CIDR %q on %s — public ingress must be engineer-authored", cidr, rtype),
				})
			}
		}
	}
	return violations
}

// ingressCIDRs extracts every CIDR string on the INGRESS surface of a security-group
// state map (a plan change's before or after), for the given resource type. Egress is
// deliberately excluded — an allow-all egress is the normal default, not a finding.
// Two shapes:
//   - aws_security_group: inline ingress[] blocks, each with cidr_blocks[] and
//     ipv6_cidr_blocks[].
//   - aws_vpc_security_group_ingress_rule: the standalone rule resource is ingress by
//     definition; its source is the top-level cidr_ipv4 / cidr_ipv6 scalars.
func ingressCIDRs(state map[string]any, rtype string) []string {
	if state == nil {
		return nil
	}
	var out []string
	switch rtype {
	case "aws_security_group":
		for _, blk := range asSlice(state["ingress"]) {
			m, ok := blk.(map[string]any)
			if !ok {
				continue
			}
			out = append(out, asStringSlice(m["cidr_blocks"])...)
			out = append(out, asStringSlice(m["ipv6_cidr_blocks"])...)
		}
	case "aws_vpc_security_group_ingress_rule":
		if s, ok := state["cidr_ipv4"].(string); ok {
			out = append(out, s)
		}
		if s, ok := state["cidr_ipv6"].(string); ok {
			out = append(out, s)
		}
	}
	return out
}

// resourceType extracts the Terraform resource type from a plan address, stripping any
// leading module.<name>. segments and the trailing .<name>[key]. e.g.
// `module.net.aws_security_group.web["a"]` → "aws_security_group".
func resourceType(address string) string {
	s := address
	for strings.HasPrefix(s, "module.") {
		rest := s[len("module."):]
		i := strings.IndexByte(rest, '.')
		if i < 0 {
			return ""
		}
		s = rest[i+1:]
	}
	if i := strings.IndexByte(s, '.'); i >= 0 {
		return s[:i]
	}
	return s
}

// asSlice returns v as a []any, or nil.
func asSlice(v any) []any {
	if l, ok := v.([]any); ok {
		return l
	}
	return nil
}

// asStringSlice returns the string elements of v (a []any), skipping any non-strings.
func asStringSlice(v any) []string {
	l, ok := v.([]any)
	if !ok {
		return nil
	}
	out := make([]string, 0, len(l))
	for _, e := range l {
		if s, ok := e.(string); ok {
			out = append(out, s)
		}
	}
	return out
}
