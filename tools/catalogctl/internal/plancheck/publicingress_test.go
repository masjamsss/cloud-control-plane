package plancheck

import (
	"testing"

	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/manifests"
)

// sgOp builds a security-group append op at the given exposure — the shape R7 guards.
func sgOp(exposure string) manifests.Op {
	op := manifests.Op{ID: "sg-add-internal-ingress-rule", Macd: "Add", CodemodOp: "append_block", Exposure: exposure}
	op.Target.ResourceType = "aws_security_group"
	op.Params = []manifests.Param{{Name: "security_group", Source: "inventory"}}
	return op
}

// cidrList boxes CIDR strings into the []any shape plan JSON uses.
func cidrList(cidrs ...string) []any {
	l := make([]any, len(cidrs))
	for i, c := range cidrs {
		l[i] = c
	}
	return l
}

// ingressBlock / egressBlock build an inline SG rule block as it appears in plan JSON.
func ingressBlock(cidrs ...string) map[string]any {
	return map[string]any{"from_port": 443.0, "to_port": 443.0, "protocol": "tcp", "cidr_blocks": cidrList(cidrs...)}
}
func ingressBlockV6(cidrs ...string) map[string]any {
	return map[string]any{"from_port": 443.0, "to_port": 443.0, "protocol": "tcp", "ipv6_cidr_blocks": cidrList(cidrs...)}
}

func sgChange(addr string, actions []string, before, after map[string]any) ResourceChange {
	return ResourceChange{Address: addr, Change: Change{Actions: actions, Before: before, After: after}}
}

func planOf(cs ...ResourceChange) Plan { return Plan{ResourceChanges: cs} }

// TestCheckPublicIngress is the R7 matrix: a non-engineer op that INTRODUCES a world-
// open ingress CIDR is a VIOLATION; egress opens, pre-existing opens, internal CIDRs,
// engineer_only ops, and non-SG resources are all clean.
func TestCheckPublicIngress(t *testing.T) {
	tests := []struct {
		name     string
		op       manifests.Op
		plan     Plan
		wantVuln int
	}{
		{
			name: "world-open v4 ingress introduced ⇒ violation",
			op:   sgOp("l1_with_guardrails"),
			plan: planOf(sgChange("aws_security_group.web", []string{"update"},
				map[string]any{"ingress": []any{ingressBlock("10.200.0.0/16")}},
				map[string]any{"ingress": []any{ingressBlock("10.200.0.0/16"), ingressBlock("0.0.0.0/0")}})),
			wantVuln: 1,
		},
		{
			name: "world-open v6 (::/0) ingress introduced ⇒ violation",
			op:   sgOp("l1_with_guardrails"),
			plan: planOf(sgChange("aws_security_group.web", []string{"update"},
				map[string]any{"ingress": []any{}},
				map[string]any{"ingress": []any{ingressBlockV6("::/0")}})),
			wantVuln: 1,
		},
		{
			name: "internal ingress ⇒ clean",
			op:   sgOp("l1_with_guardrails"),
			plan: planOf(sgChange("aws_security_group.web", []string{"update"},
				map[string]any{"ingress": []any{}},
				map[string]any{"ingress": []any{ingressBlock("10.20.0.0/16")}})),
			wantVuln: 0,
		},
		{
			name: "world-open EGRESS is ignored ⇒ clean",
			op:   sgOp("l1_with_guardrails"),
			plan: planOf(sgChange("aws_security_group.web", []string{"update"},
				map[string]any{"egress": []any{}},
				map[string]any{
					"ingress": []any{ingressBlock("10.20.0.0/16")},
					"egress":  []any{map[string]any{"from_port": 0.0, "to_port": 0.0, "protocol": "-1", "cidr_blocks": cidrList("0.0.0.0/0")}},
				})),
			wantVuln: 0,
		},
		{
			name: "pre-existing world-open ingress, internal added ⇒ clean (not introduced)",
			op:   sgOp("l1_with_guardrails"),
			plan: planOf(sgChange("aws_security_group.web", []string{"update"},
				map[string]any{"ingress": []any{ingressBlock("0.0.0.0/0")}},
				map[string]any{"ingress": []any{ingressBlock("0.0.0.0/0"), ingressBlock("10.20.0.0/16")}})),
			wantVuln: 0,
		},
		{
			name: "engineer_only op is exempt ⇒ clean",
			op:   sgOp("engineer_only"),
			plan: planOf(sgChange("aws_security_group.web", []string{"update"},
				map[string]any{"ingress": []any{}},
				map[string]any{"ingress": []any{ingressBlock("0.0.0.0/0")}})),
			wantVuln: 0,
		},
		{
			name: "create introducing world-open ingress (nil before) ⇒ violation",
			op:   sgOp("l1_with_guardrails"),
			plan: planOf(sgChange("aws_security_group.web", []string{"create"},
				nil,
				map[string]any{"ingress": []any{ingressBlock("0.0.0.0/0")}})),
			wantVuln: 1,
		},
		{
			name: "standalone ingress-rule resource, cidr_ipv4 world-open ⇒ violation",
			op:   sgOp("l1_with_guardrails"),
			plan: planOf(sgChange("aws_vpc_security_group_ingress_rule.open", []string{"create"},
				nil,
				map[string]any{"cidr_ipv4": "0.0.0.0/0"})),
			wantVuln: 1,
		},
		{
			name: "standalone ingress-rule resource, cidr_ipv4 internal ⇒ clean",
			op:   sgOp("l1_with_guardrails"),
			plan: planOf(sgChange("aws_vpc_security_group_ingress_rule.db", []string{"create"},
				nil,
				map[string]any{"cidr_ipv4": "10.0.0.0/8"})),
			wantVuln: 0,
		},
		{
			name: "module-nested SG address ⇒ violation (type stripped from module path)",
			op:   sgOp("l1_with_guardrails"),
			plan: planOf(sgChange(`module.net.aws_security_group.web["a"]`, []string{"update"},
				map[string]any{"ingress": []any{}},
				map[string]any{"ingress": []any{ingressBlock("0.0.0.0/0")}})),
			wantVuln: 1,
		},
		{
			name: "non-SG resource with a 0.0.0.0/0 field ⇒ clean (wrong type)",
			op:   sgOp("l1_with_guardrails"),
			plan: planOf(sgChange("aws_instance.x", []string{"update"},
				nil, map[string]any{"some_cidr": "0.0.0.0/0"})),
			wantVuln: 0,
		},
		{
			name: "no-op change is ignored ⇒ clean",
			op:   sgOp("l1_with_guardrails"),
			plan: planOf(sgChange("aws_security_group.web", []string{"no-op"},
				nil, map[string]any{"ingress": []any{ingressBlock("0.0.0.0/0")}})),
			wantVuln: 0,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := checkPublicIngress(tt.op, tt.plan)
			if len(got) != tt.wantVuln {
				t.Fatalf("violations = %d %v, want %d", len(got), got, tt.wantVuln)
			}
			for _, v := range got {
				if v.Rule != "no-public-ingress" {
					t.Errorf("rule = %q, want no-public-ingress", v.Rule)
				}
			}
		})
	}
}

func TestResourceType(t *testing.T) {
	cases := map[string]string{
		"aws_security_group.web":                   "aws_security_group",
		`aws_security_group.web["a"]`:              "aws_security_group",
		"module.net.aws_security_group.web":        "aws_security_group",
		`module.net.aws_security_group.web["a"]`:   "aws_security_group",
		"module.a.module.b.aws_route.r":            "aws_route",
		"aws_vpc_security_group_ingress_rule.open": "aws_vpc_security_group_ingress_rule",
		"aws_instance.x":                           "aws_instance",
	}
	for in, want := range cases {
		if got := resourceType(in); got != want {
			t.Errorf("resourceType(%q) = %q, want %q", in, got, want)
		}
	}
}
