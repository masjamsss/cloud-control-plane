package manifests

import (
	"strings"
	"testing"
)

// TestCheckCidrPolicyLinkLocal30 pins the link-local-30 semantics (0031 F1 vpn
// follow-up): accept ONLY a CIDR that is BOTH inside 169.254.0.0/16 (RFC3927
// link-local) AND exactly /30 — the shape AWS requires for a site-to-site VPN tunnel's
// inside interface. Everything else — wrong size, non-link-local, IPv6, host, malformed
// — is refused fail-closed. This is the machine half of a guard that shipped as
// semantic-only prose on vpn-set-tunnel-inside-cidr.new_inside_cidr.
func TestCheckCidrPolicyLinkLocal30(t *testing.T) {
	cases := []struct {
		value string
		ok    bool // true ⇒ policy satisfied (no reason returned)
	}{
		// Inside 169.254.0.0/16 AND exactly /30 — accepted.
		{"169.254.10.0/30", true},
		{"169.254.100.0/30", true}, // the help-text example
		{"169.254.0.0/30", true},   // bottom of the block
		{"169.254.255.252/30", true},
		{"169.254.1.4/30", true},
		// Wrong size — rejected (must be exactly /30).
		{"169.254.10.0/29", false}, // broader
		{"169.254.10.0/31", false}, // narrower
		{"169.254.10.0/24", false},
		{"169.254.10.1/32", false}, // explicit host
		{"169.254.10.1", false},    // bare host ⇒ /32
		{"169.254.10.0/16", false},
		// Right size, wrong block — rejected (not link-local).
		{"10.0.0.0/30", false},
		{"192.168.1.0/30", false},
		{"172.16.0.0/30", false},
		{"8.8.8.8/30", false},
		{"169.255.0.0/30", false}, // just above the link-local block
		{"169.253.255.252/30", false},
		// IPv6 — rejected (RFC3927 link-local is IPv4-only; cross-family containment fails).
		{"fe80::/30", false},
		{"::/30", false},
		// Malformed — rejected fail-closed. 169.254.999.0/30 MATCHES the manifest's
		// \d{1,3} pattern but is not a parseable address, so cidrPolicy is the layer that
		// catches it.
		{"169.254.999.0/30", false},
		{"not-a-cidr", false},
		{"169.254.10.0/33", false},
		{"", false},
	}
	for _, c := range cases {
		reason := checkCidrPolicy("link-local-30", c.value)
		if (reason == "") != c.ok {
			t.Errorf("link-local-30 %q: reason=%q, want ok=%v", c.value, reason, c.ok)
		}
	}
}

// TestValidateLinkLocal30Wiring proves the policy is reached THROUGH manifests.Validate
// — the edit-time gate (edit.go:91) — for a new_inside_cidr-shaped param whose only
// bound is cidrPolicy:link-local-30, so a violation surfaces as OUT_OF_BOUNDS naming the
// param and every accepted value passes clean.
func TestValidateLinkLocal30Wiring(t *testing.T) {
	llPolicy := "link-local-30"
	op := Op{
		ID: "vpn-set-tunnel-inside-cidr",
		Params: []Param{{
			Name:     "new_inside_cidr",
			Type:     "string",
			Source:   "user_input",
			Required: true,
			Bounds:   &Bounds{CidrPolicy: llPolicy},
		}},
	}
	cases := []struct {
		cidr    string
		wantOOB bool
	}{
		{"169.254.10.0/30", false},  // accepted
		{"169.254.100.0/30", false}, // accepted
		{"169.254.10.0/29", true},   // wrong size
		{"10.0.0.0/30", true},       // not link-local
		{"169.254.999.0/30", true},  // pattern-passing but unparseable
		{"garbage", true},           // malformed
	}
	for _, c := range cases {
		code, reason := Validate(op, map[string]any{"new_inside_cidr": c.cidr})
		if (code == "OUT_OF_BOUNDS") != c.wantOOB {
			t.Errorf("Validate new_inside_cidr=%q: code=%q reason=%q, want OUT_OF_BOUNDS=%v", c.cidr, code, reason, c.wantOOB)
		}
		if c.wantOOB && !strings.Contains(reason, "new_inside_cidr") {
			t.Errorf("Validate new_inside_cidr=%q: reason %q should name the offending param", c.cidr, reason)
		}
	}
}
