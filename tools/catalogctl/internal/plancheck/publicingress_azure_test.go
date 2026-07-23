package plancheck

import (
	"testing"

	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/manifests"
)

// nsgOp builds a network-security-group append op at the given exposure — the shape
// R7-azure guards. Mirrors sgOp (publicingress_test.go) for the azurerm side.
func nsgOp(exposure string) manifests.Op {
	op := manifests.Op{ID: "nsg-add-internal-ingress-rule", Macd: "Add", CodemodOp: "append_block", Exposure: exposure}
	op.Target.ResourceType = "azurerm_network_security_group"
	op.Params = []manifests.Param{{Name: "network_security_group", Source: "inventory"}}
	return op
}

// nsgRule builds a standalone azurerm_network_security_rule / inline security_rule
// block as it appears in plan JSON, with a single source_address_prefix.
func nsgRule(direction, access, source string) map[string]any {
	return map[string]any{
		"name":                    "rule1",
		"priority":                100.0,
		"direction":               direction,
		"access":                  access,
		"protocol":                "Tcp",
		"source_port_range":       "*",
		"destination_port_range":  "443",
		"source_address_prefix":   source,
		"source_address_prefixes": []any{},
	}
}

// nsgRuleMulti is nsgRule but with a source_address_prefixes list instead of the
// singular scalar (the azurerm schema's other source shape).
func nsgRuleMulti(direction, access string, sources ...string) map[string]any {
	return map[string]any{
		"name":                    "rule1",
		"priority":                100.0,
		"direction":               direction,
		"access":                  access,
		"protocol":                "Tcp",
		"source_port_range":       "*",
		"destination_port_range":  "443",
		"source_address_prefix":   "",
		"source_address_prefixes": cidrList(sources...),
	}
}

// TestCheckPublicIngressAzure is the R7-azure matrix: a non-engineer op that
// INTRODUCES a public inbound-allow source on an Azure NSG is a VIOLATION; Deny
// rules, outbound rules, private sources, pre-existing opens, engineer_only ops, and
// non-NSG resources are all clean.
func TestCheckPublicIngressAzure(t *testing.T) {
	tests := []struct {
		name     string
		op       manifests.Op
		plan     Plan
		wantVuln int
	}{
		{
			name: "standalone inbound-allow from Internet service tag ⇒ violation",
			op:   nsgOp("l1_with_guardrails"),
			plan: planOf(sgChange("azurerm_network_security_rule.open", []string{"create"},
				nil,
				nsgRule("Inbound", "Allow", "Internet"))),
			wantVuln: 1,
		},
		{
			name: "standalone inbound-allow from wildcard * ⇒ violation",
			op:   nsgOp("l1_with_guardrails"),
			plan: planOf(sgChange("azurerm_network_security_rule.open", []string{"create"},
				nil,
				nsgRule("Inbound", "Allow", "*"))),
			wantVuln: 1,
		},
		{
			name: "standalone inbound-allow from a public CIDR ⇒ violation",
			op:   nsgOp("l1_with_guardrails"),
			plan: planOf(sgChange("azurerm_network_security_rule.open", []string{"create"},
				nil,
				nsgRule("Inbound", "Allow", "203.0.113.0/24"))),
			wantVuln: 1,
		},
		{
			name: "standalone inbound-allow from 10.0.0.0/8 ⇒ clean",
			op:   nsgOp("l1_with_guardrails"),
			plan: planOf(sgChange("azurerm_network_security_rule.internal", []string{"create"},
				nil,
				nsgRule("Inbound", "Allow", "10.0.0.0/8"))),
			wantVuln: 0,
		},
		{
			name: "standalone DENY rule from * ⇒ clean",
			op:   nsgOp("l1_with_guardrails"),
			plan: planOf(sgChange("azurerm_network_security_rule.denied", []string{"create"},
				nil,
				nsgRule("Inbound", "Deny", "*"))),
			wantVuln: 0,
		},
		{
			name: "inline security_rule block on an NSG: public rule flags, private rule passes",
			op:   nsgOp("l1_with_guardrails"),
			plan: planOf(sgChange("azurerm_network_security_group.web", []string{"update"},
				map[string]any{"security_rule": []any{}},
				map[string]any{"security_rule": []any{
					nsgRule("Inbound", "Allow", "Internet"),
					nsgRule("Inbound", "Allow", "192.168.1.0/24"),
				}})),
			wantVuln: 1,
		},
		{
			name: "outbound allow-all is ignored (direction filter) ⇒ clean",
			op:   nsgOp("l1_with_guardrails"),
			plan: planOf(sgChange("azurerm_network_security_rule.eg", []string{"create"},
				nil,
				nsgRule("Outbound", "Allow", "*"))),
			wantVuln: 0,
		},
		{
			name: "case-insensitive 'any' spelling ⇒ violation",
			op:   nsgOp("l1_with_guardrails"),
			plan: planOf(sgChange("azurerm_network_security_rule.open", []string{"create"},
				nil,
				nsgRule("Inbound", "Allow", "ANY"))),
			wantVuln: 1,
		},
		{
			name: "source_address_prefixes list carrying a public entry ⇒ violation",
			op:   nsgOp("l1_with_guardrails"),
			plan: planOf(sgChange("azurerm_network_security_rule.open", []string{"create"},
				nil,
				nsgRuleMulti("Inbound", "Allow", "10.0.0.0/8", "0.0.0.0/0"))),
			wantVuln: 1,
		},
		{
			name: "pre-existing public ingress, private one added ⇒ clean (not introduced)",
			op:   nsgOp("l1_with_guardrails"),
			plan: planOf(sgChange("azurerm_network_security_group.web", []string{"update"},
				map[string]any{"security_rule": []any{nsgRule("Inbound", "Allow", "Internet")}},
				map[string]any{"security_rule": []any{
					nsgRule("Inbound", "Allow", "Internet"),
					nsgRule("Inbound", "Allow", "10.20.0.0/16"),
				}})),
			wantVuln: 0,
		},
		{
			name: "engineer_only op is exempt ⇒ clean",
			op:   nsgOp("engineer_only"),
			plan: planOf(sgChange("azurerm_network_security_rule.open", []string{"create"},
				nil,
				nsgRule("Inbound", "Allow", "*"))),
			wantVuln: 0,
		},
		{
			name: "non-NSG resource with a '*' field ⇒ clean (wrong type)",
			op:   nsgOp("l1_with_guardrails"),
			plan: planOf(sgChange("azurerm_storage_account.x", []string{"update"},
				nil, map[string]any{"source_address_prefix": "*", "direction": "Inbound", "access": "Allow"})),
			wantVuln: 0,
		},
		{
			name: "no-op change is ignored ⇒ clean",
			op:   nsgOp("l1_with_guardrails"),
			plan: planOf(sgChange("azurerm_network_security_rule.open", []string{"no-op"},
				nil, nsgRule("Inbound", "Allow", "*"))),
			wantVuln: 0,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := checkPublicIngressAzure(tt.op, tt.plan)
			if len(got) != tt.wantVuln {
				t.Fatalf("violations = %d %v, want %d", len(got), got, tt.wantVuln)
			}
			for _, v := range got {
				if v.Rule != "no-public-ingress-azure" {
					t.Errorf("rule = %q, want no-public-ingress-azure", v.Rule)
				}
			}
		})
	}
}

// TestAzurePublicSource unit-tests the source classifier directly: the closed-
// vocabulary tokens, RFC1918 containment, and the pass-through for values outside
// this guard's scope (other Azure service tags, empty/garbage strings).
func TestAzurePublicSource(t *testing.T) {
	cases := []struct {
		src  string
		want bool
	}{
		{"*", true},
		{"Internet", true},
		{"internet", true},
		{"any", true},
		{"ANY", true},
		{"0.0.0.0/0", true},
		{"203.0.113.0/24", true},
		{"8.8.8.8", true},
		{"10.0.0.0/8", false},
		{"172.16.0.0/12", false},
		{"192.168.1.0/24", false},
		{"10.1.2.3", false},
		{"VirtualNetwork", false},
		{"AzureLoadBalancer", false},
		{"", false},
		{"not-a-cidr", false},
	}
	for _, c := range cases {
		if got := azurePublicSource(c.src); got != c.want {
			t.Errorf("azurePublicSource(%q) = %v, want %v", c.src, got, c.want)
		}
	}
}
