package manifests

import (
	"net/netip"
	"strings"
	"testing"
)

// sgManifestsDir holds fixture copies of the real security-groups + routing ops with
// the machine-enforceable cidrPolicy field the F1 migration will add — so these tests
// prove exactly what the post-migration production manifest does.
const sgManifestsDir = "../../testdata/manifests-sg"

// TestCheckCidrPolicyInternalOnly pins the internal-only semantics: accept ONLY a
// CIDR/IP wholly inside RFC1918, reject public, the default routes, all IPv6, and
// malformed input. This is the security-critical half — internal-only is the SG guard.
func TestCheckCidrPolicyInternalOnly(t *testing.T) {
	cases := []struct {
		value string
		ok    bool // true ⇒ policy is satisfied (no reason returned)
	}{
		// Inside RFC1918 — accepted.
		{"10.20.0.0/16", true},
		{"10.0.0.0/8", true},
		{"172.16.0.0/12", true},
		{"172.31.255.0/24", true}, // top of the 172.16/12 block
		{"192.168.1.0/24", true},
		{"10.5.5.5", true},       // bare host inside 10/8 (→ /32)
		{"192.168.0.1/32", true}, // explicit host prefix
		{"10.20.0.5/16", true},   // host bits set — masked before containment
		// Rejected — the exact F1 exploit and its neighbours.
		{"0.0.0.0/0", false},  // the world-open case that used to execute at exit 0
		{"8.8.8.8/32", false}, // public unicast
		{"8.8.8.8", false},    // bare public host
		{"1.1.1.1/32", false}, // public
		{"::/0", false},       // IPv6 default route
		{"fd00::/8", false},   // IPv6 ULA is private but NOT RFC1918 → internal-only rejects it
		{"2606:4700:4700::1111", false},
		{"172.32.0.0/16", false},  // just above 172.16/12 → public
		{"172.15.0.0/16", false},  // just below 172.16/12 → public
		{"11.0.0.0/8", false},     // adjacent to 10/8 → public
		{"10.0.0.0/7", false},     // broader than 10/8 (spans 10-11) → not wholly private
		{"169.254.0.0/16", false}, // link-local — not RFC1918
		{"100.64.0.0/10", false},  // CGNAT — not RFC1918
		// Malformed — refused, never silently allowed.
		{"not-a-cidr", false},
		{"10.0.0.0/33", false}, // invalid IPv4 mask
		{"999.1.1.1/8", false}, // invalid octet
		{"10.0.0.0/", false},
		{"", false},
	}
	for _, c := range cases {
		reason := checkCidrPolicy("internal-only", c.value)
		if (reason == "") != c.ok {
			t.Errorf("internal-only %q: reason=%q, want ok=%v", c.value, reason, c.ok)
		}
	}
}

// TestCheckCidrPolicyNoPublic pins no-public: reject the default routes and any prefix
// overlapping public unicast space; allow private/special hosts (RFC1918, IPv6 ULA,
// link-local). Includes the load-bearing straddle case (10.0.0.0/7) that proves the
// endpoint check is sound — a prefix with a private BASE but a public LAST is rejected.
func TestCheckCidrPolicyNoPublic(t *testing.T) {
	cases := []struct {
		value string
		ok    bool
	}{
		// Private / special — allowed (this is where no-public is looser than internal-only).
		{"10.2.0.0/16", true},
		{"172.16.0.0/12", true},
		{"192.168.1.0/24", true},
		{"10.5.5.5", true},
		{"fd00::/8", true}, // IPv6 ULA private — allowed here, rejected by internal-only
		{"fd12:3456::/32", true},
		{"169.254.0.0/16", true}, // link-local is not global-unicast → not public
		// Default routes — hard reject.
		{"0.0.0.0/0", false},
		{"::/0", false},
		// Public — reject.
		{"8.8.8.8/32", false},
		{"8.8.8.8", false},
		{"1.1.1.1", false},
		{"2606:4700:4700::1111", false},
		{"100.64.0.0/10", false}, // CGNAT reads as non-private → refused (safe default)
		{"11.0.0.0/8", false},
		// Straddle soundness: base in 10/8 (private) but last in 11/8 (public) ⇒ reject.
		{"10.0.0.0/7", false},
		{"8.0.0.0/6", false}, // base 8.0.0.0 public
		{"0.0.0.0/8", false}, // base is the unspecified address
		// Malformed — refused.
		{"not-a-cidr", false},
		{"::/129", false},
		{"", false},
	}
	for _, c := range cases {
		reason := checkCidrPolicy("no-public", c.value)
		if (reason == "") != c.ok {
			t.Errorf("no-public %q: reason=%q, want ok=%v", c.value, reason, c.ok)
		}
	}
}

// TestCheckCidrPolicyUnrecognized proves an unknown policy string fails CLOSED — a
// manifest typo (e.g. "internal_only") must refuse, never silently pass.
func TestCheckCidrPolicyUnrecognized(t *testing.T) {
	if reason := checkCidrPolicy("internal_only", "10.0.0.0/8"); reason == "" {
		t.Fatal("unrecognized policy on a valid internal CIDR returned clean; must fail closed")
	}
	if reason := checkCidrPolicy("", "10.0.0.0/8"); reason == "" {
		// checkCidrPolicy is only reached when b.CidrPolicy != "", but be defensive.
		t.Fatal("empty policy string returned clean; must fail closed")
	}
}

// TestLastAddr sanity-checks the highest-address helper no-public relies on, including
// the host-prefix (/32, /128) no-op and an IPv6 prefix.
func TestLastAddr(t *testing.T) {
	cases := map[string]string{
		"10.0.0.0/8":     "10.255.255.255",
		"172.16.0.0/12":  "172.31.255.255",
		"192.168.1.0/24": "192.168.1.255",
		"8.8.8.8/32":     "8.8.8.8",
		"10.0.0.0/7":     "11.255.255.255",
		"fd00::/8":       "fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
	}
	for in, want := range cases {
		p := netip.MustParsePrefix(in)
		if got := lastAddr(p); got.String() != want {
			t.Errorf("lastAddr(%s) = %s, want %s", in, got, want)
		}
	}
}

// TestValidateCidrPolicyRealOps is the end-to-end proof against the REAL op shapes: the
// same sg-add-internal-ingress-rule / routing-add-route ops the estate ships, loaded
// from a fixture whose bounds carry cidrPolicy. The 0.0.0.0/0 rows are the exact F1
// finding — a request that used to reach the executor now refuses OUT_OF_BOUNDS.
func TestValidateCidrPolicyRealOps(t *testing.T) {
	ops, err := LoadDir(sgManifestsDir)
	if err != nil {
		t.Fatal(err)
	}

	sg, ok := ops["sg-add-internal-ingress-rule"]
	if !ok {
		t.Fatal("sg-add-internal-ingress-rule not found in fixture manifest")
	}
	sgReq := func(cidr string) map[string]any {
		return map[string]any{
			"security_group": "aws_security_group.web",
			"protocol":       "tcp",
			"from_port":      443,
			"to_port":        443,
			"cidr_block":     cidr,
		}
	}
	sgCases := []struct {
		cidr    string
		wantOOB bool
	}{
		{"0.0.0.0/0", true},     // F1: world-open — refused now, executed at exit 0 before
		{"8.8.8.8/32", true},    // public
		{"::/0", true},          // IPv6 default route
		{"not-a-cidr", true},    // malformed
		{"10.20.0.0/16", false}, // internal — passes
		{"172.20.5.0/24", false},
	}
	for _, c := range sgCases {
		code, reason := Validate(sg, sgReq(c.cidr))
		if (code == "OUT_OF_BOUNDS") != c.wantOOB {
			t.Errorf("sg cidr_block=%q: code=%q reason=%q, want OUT_OF_BOUNDS=%v", c.cidr, code, reason, c.wantOOB)
		}
		if c.wantOOB && !strings.Contains(reason, "cidr_block") {
			t.Errorf("sg cidr_block=%q: reason %q should name the offending param", c.cidr, reason)
		}
	}

	rt, ok := ops["routing-add-route"]
	if !ok {
		t.Fatal("routing-add-route not found in fixture manifest")
	}
	rtReq := func(cidr string) map[string]any {
		return map[string]any{
			"route_table":      "aws_route_table.rt",
			"destination_cidr": cidr,
			"target_type":      "nat_gateway_id",
			"target_id":        "nat-0abc12345678",
		}
	}
	rtCases := []struct {
		cidr    string
		wantOOB bool
	}{
		{"0.0.0.0/0", true}, // refused under no-public
		{"8.8.8.8/32", true},
		{"10.2.0.0/16", false}, // a normal internal route — passes
		{"172.16.0.0/12", false},
	}
	for _, c := range rtCases {
		code, reason := Validate(rt, rtReq(c.cidr))
		if (code == "OUT_OF_BOUNDS") != c.wantOOB {
			t.Errorf("routing destination_cidr=%q: code=%q reason=%q, want OUT_OF_BOUNDS=%v", c.cidr, code, reason, c.wantOOB)
		}
	}
}
