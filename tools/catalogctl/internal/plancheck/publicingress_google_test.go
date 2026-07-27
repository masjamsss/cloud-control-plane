package plancheck

import (
	"testing"

	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/manifests"
)

// fwOp builds a google_compute_firewall op at the given exposure — the shape
// R7-google guards. Mirrors sgOp/nsgOp for the google side.
func fwOp(exposure string) manifests.Op {
	op := manifests.Op{ID: "fw-add-internal-ingress-rule", Macd: "Add", CodemodOp: "create_resource", Exposure: exposure}
	op.Target.ResourceType = "google_compute_firewall"
	op.Params = []manifests.Param{{Name: "firewall", Source: "inventory"}}
	return op
}

// fwRule builds a google_compute_firewall state map as it appears in plan JSON:
// one resource IS one rule, with direction, allow/deny block lists, and
// source_ranges.
func fwRule(direction string, allow bool, sources ...string) map[string]any {
	m := map[string]any{
		"name":          "rule1",
		"network":       "default",
		"priority":      1000.0,
		"source_ranges": cidrList(sources...),
		"allow":         []any{},
		"deny":          []any{},
	}
	if direction != "" {
		m["direction"] = direction
	}
	rule := map[string]any{"protocol": "tcp", "ports": []any{"443"}}
	if allow {
		m["allow"] = []any{rule}
	} else {
		m["deny"] = []any{rule}
	}
	return m
}

// withSources sets an identity-scoped source attribute (source_tags /
// source_service_accounts) on a fwRule state map — the shapes that suppress
// GCP's default-open source when source_ranges is absent.
func withSources(m map[string]any, key string, values ...string) map[string]any {
	m[key] = cidrList(values...)
	return m
}

// TestCheckPublicIngressGoogle is the R7-google matrix: a non-engineer op that
// INTRODUCES a public source range on an ingress-allow google_compute_firewall
// is a VIOLATION; deny-only rules, EGRESS rules, private sources, pre-existing
// opens, engineer_only ops, and non-firewall resources are all clean.
func TestCheckPublicIngressGoogle(t *testing.T) {
	tests := []struct {
		name     string
		op       manifests.Op
		plan     Plan
		wantVuln int
	}{
		{
			name: "ingress allow from 0.0.0.0/0 ⇒ violation",
			op:   fwOp("l1_with_guardrails"),
			plan: planOf(sgChange("google_compute_firewall.open", []string{"create"},
				nil, fwRule("INGRESS", true, "0.0.0.0/0"))),
			wantVuln: 1,
		},
		{
			name: "ingress allow from a public CIDR ⇒ violation",
			op:   fwOp("l1_with_guardrails"),
			plan: planOf(sgChange("google_compute_firewall.open", []string{"create"},
				nil, fwRule("INGRESS", true, "203.0.113.0/24"))),
			wantVuln: 1,
		},
		{
			name: "absent direction defaults to INGRESS (the provider's default) ⇒ violation",
			op:   fwOp("l1_with_guardrails"),
			plan: planOf(sgChange("google_compute_firewall.open", []string{"create"},
				nil, fwRule("", true, "0.0.0.0/0"))),
			wantVuln: 1,
		},
		{
			name: "IPv6 world-open ::/0 ⇒ violation",
			op:   fwOp("l1_with_guardrails"),
			plan: planOf(sgChange("google_compute_firewall.open", []string{"create"},
				nil, fwRule("INGRESS", true, "::/0"))),
			wantVuln: 1,
		},
		{
			name: "ingress allow from 10.0.0.0/8 ⇒ clean",
			op:   fwOp("l1_with_guardrails"),
			plan: planOf(sgChange("google_compute_firewall.internal", []string{"create"},
				nil, fwRule("INGRESS", true, "10.0.0.0/8"))),
			wantVuln: 0,
		},
		{
			name: "deny-only rule from 0.0.0.0/0 ⇒ clean",
			op:   fwOp("l1_with_guardrails"),
			plan: planOf(sgChange("google_compute_firewall.blocked", []string{"create"},
				nil, fwRule("INGRESS", false, "0.0.0.0/0"))),
			wantVuln: 0,
		},
		{
			name: "EGRESS rule is ignored (direction filter) ⇒ clean",
			op:   fwOp("l1_with_guardrails"),
			plan: planOf(sgChange("google_compute_firewall.eg", []string{"create"},
				nil, fwRule("EGRESS", true, "0.0.0.0/0"))),
			wantVuln: 0,
		},
		{
			name: "mixed list: one private, one public ⇒ one violation",
			op:   fwOp("l1_with_guardrails"),
			plan: planOf(sgChange("google_compute_firewall.open", []string{"create"},
				nil, fwRule("INGRESS", true, "10.0.0.0/8", "0.0.0.0/0"))),
			wantVuln: 1,
		},
		{
			name: "pre-existing public source, private one added ⇒ clean (not introduced)",
			op:   fwOp("l1_with_guardrails"),
			plan: planOf(sgChange("google_compute_firewall.web", []string{"update"},
				fwRule("INGRESS", true, "0.0.0.0/0"),
				fwRule("INGRESS", true, "0.0.0.0/0", "10.20.0.0/16"))),
			wantVuln: 0,
		},
		{
			name: "engineer_only op is exempt ⇒ clean",
			op:   fwOp("engineer_only"),
			plan: planOf(sgChange("google_compute_firewall.open", []string{"create"},
				nil, fwRule("INGRESS", true, "0.0.0.0/0"))),
			wantVuln: 0,
		},
		{
			name: "non-firewall resource with source_ranges ⇒ clean (wrong type)",
			op:   fwOp("l1_with_guardrails"),
			plan: planOf(sgChange("google_storage_bucket.x", []string{"update"},
				nil, fwRule("INGRESS", true, "0.0.0.0/0"))),
			wantVuln: 0,
		},
		{
			name: "no-op change is ignored ⇒ clean",
			op:   fwOp("l1_with_guardrails"),
			plan: planOf(sgChange("google_compute_firewall.open", []string{"no-op"},
				nil, fwRule("INGRESS", true, "0.0.0.0/0"))),
			wantVuln: 0,
		},
		// ── the provider-default source (no source specified = 0.0.0.0/0) ──
		{
			name: "ingress allow with NO source at all is GCP's default-open 0.0.0.0/0 ⇒ violation",
			op:   fwOp("l1_with_guardrails"),
			plan: planOf(sgChange("google_compute_firewall.defaultopen", []string{"create"},
				nil, fwRule("INGRESS", true))),
			wantVuln: 1,
		},
		{
			name: "no ranges but source_tags present suppresses the default ⇒ clean",
			op:   fwOp("l1_with_guardrails"),
			plan: planOf(sgChange("google_compute_firewall.tagged", []string{"create"},
				nil, withSources(fwRule("INGRESS", true), "source_tags", "web-tier"))),
			wantVuln: 0,
		},
		{
			name: "no ranges but source_service_accounts present suppresses the default ⇒ clean",
			op:   fwOp("l1_with_guardrails"),
			plan: planOf(sgChange("google_compute_firewall.sa", []string{"create"},
				nil, withSources(fwRule("INGRESS", true), "source_service_accounts", "svc@p.iam.gserviceaccount.example"))),
			wantVuln: 0,
		},
		{
			name: "removing every source from a private rule introduces the default-open ⇒ violation",
			op:   fwOp("l1_with_guardrails"),
			plan: planOf(sgChange("google_compute_firewall.stripped", []string{"update"},
				fwRule("INGRESS", true, "10.0.0.0/8"),
				fwRule("INGRESS", true))),
			wantVuln: 1,
		},
		{
			name: "already default-open before and after (unrelated edit) ⇒ clean (not introduced)",
			op:   fwOp("l1_with_guardrails"),
			plan: planOf(sgChange("google_compute_firewall.stayopen", []string{"update"},
				fwRule("INGRESS", true),
				fwRule("INGRESS", true))),
			wantVuln: 0,
		},
		{
			name: "explicit 0.0.0.0/0 before, implicit default after ⇒ clean (same effective source)",
			op:   fwOp("l1_with_guardrails"),
			plan: planOf(sgChange("google_compute_firewall.sameopen", []string{"update"},
				fwRule("INGRESS", true, "0.0.0.0/0"),
				fwRule("INGRESS", true))),
			wantVuln: 0,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := checkPublicIngressGoogle(tt.op, tt.plan)
			if len(got) != tt.wantVuln {
				t.Fatalf("violations = %d %v, want %d", len(got), got, tt.wantVuln)
			}
			for _, v := range got {
				if v.Rule != "no-public-ingress-google" {
					t.Errorf("rule = %q, want no-public-ingress-google", v.Rule)
				}
			}
		})
	}
}

// TestGooglePublicSource unit-tests the source classifier directly: RFC1918
// containment and the pass-through for values outside this guard's scope.
func TestGooglePublicSource(t *testing.T) {
	cases := []struct {
		src  string
		want bool
	}{
		{"0.0.0.0/0", true},
		{"::/0", true},
		{"203.0.113.0/24", true},
		{"8.8.8.8", true},
		{"10.0.0.0/8", false},
		{"172.16.0.0/12", false},
		{"192.168.1.0/24", false},
		{"10.1.2.3", false},
		{"", false},
		{"not-a-cidr", false},
	}
	for _, c := range cases {
		if got := googlePublicSource(c.src); got != c.want {
			t.Errorf("googlePublicSource(%q) = %v, want %v", c.src, got, c.want)
		}
	}
}
