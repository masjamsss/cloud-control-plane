package manifests

import (
	"strings"
	"testing"
)

// realManifestsDir is the PRODUCTION catalog — the M3 tests prove the actual shipped
// ops enforce their CIDR guards, not a fixture that could drift. Precedent:
// onboard/contract_test.go reaches into ccp/ the same relative way.
const realManifestsDir = "../../../../ccp/app/src/data/manifests"

// TestCheckMaxPrefixLen pins the CIDR block-size floor (M3): a prefix broader than
// /min is rejected, /min itself is the inclusive boundary, narrower passes, a bare
// host passes, and a malformed value fails closed. The /8-rejected, /24-accepted and
// /16-boundary rows are the cases the fix backlog calls out.
func TestCheckMaxPrefixLen(t *testing.T) {
	cases := []struct {
		value string
		min   int
		ok    bool
	}{
		{"10.0.0.0/8", 16, false},  // /8 far broader than /16 → reject (the backlog row)
		{"10.0.0.0/15", 16, false}, // one bit too broad
		{"10.0.0.0/16", 16, true},  // boundary — inclusive floor (the backlog row)
		{"10.1.2.0/24", 16, true},  // narrower → allowed (the backlog row)
		{"10.1.2.3/32", 16, true},  // host prefix
		{"8.8.8.8", 16, true},      // bare host parses to /32
		{"0.0.0.0/0", 16, false},   // default route is /0
		// min is honored, not hard-coded to 16.
		{"10.0.0.0/23", 24, false},
		{"10.0.0.0/24", 24, true},
		// malformed → fail closed.
		{"not-a-cidr", 16, false},
		{"10.0.0.0/33", 16, false},
		{"", 16, false},
	}
	for _, c := range cases {
		reason := checkMaxPrefixLen(c.min, c.value)
		if (reason == "") != c.ok {
			t.Errorf("checkMaxPrefixLen(%d, %q): reason=%q, want ok=%v", c.min, c.value, reason, c.ok)
		}
	}
}

// TestValidateM3RealOps is the end-to-end proof against the THREE real networking ops
// the M3 fix wired: each now refuses a world-open / too-broad / public CIDR at
// Validate — the machine gate the old semantic-only prose could never enforce — while
// a legitimate internal CIDR still passes. Loaded from the production manifests.
func TestValidateM3RealOps(t *testing.T) {
	ops, err := LoadDir(realManifestsDir)
	if err != nil {
		t.Fatalf("LoadDir(%s): %v", realManifestsDir, err)
	}

	// check asserts Validate's OUT_OF_BOUNDS verdict for op[opID] with the cidr param
	// set to cidr and every OTHER param supplied from base (so the cidr is the only
	// possible violation — Validate returns the FIRST failing param).
	check := func(t *testing.T, opID, cidrParam string, base map[string]any, cidr string, wantOOB bool) {
		t.Helper()
		op, ok := ops[opID]
		if !ok {
			t.Fatalf("%s not found in the real manifests", opID)
		}
		params := map[string]any{cidrParam: cidr}
		for k, v := range base {
			params[k] = v
		}
		code, reason := Validate(op, params)
		if (code == "OUT_OF_BOUNDS") != wantOOB {
			t.Errorf("%s %s=%q: code=%q reason=%q, want OUT_OF_BOUNDS=%v", opID, cidrParam, cidr, code, reason, wantOOB)
		}
		if wantOOB && !strings.Contains(reason, cidrParam) {
			t.Errorf("%s %s=%q: reason %q should name the offending param", opID, cidrParam, cidr, reason)
		}
	}

	// vpn-add-static-route · destination_cidr · cidrPolicy no-public (on-prem ranges
	// may be non-RFC1918, so no-public not internal-only).
	vpnBase := map[string]any{"vpn_connection": "aws_vpn_connection.main"}
	for _, c := range []struct {
		cidr    string
		wantOOB bool
	}{
		{"0.0.0.0/0", true},    // world-open default route — refused now, executed at exit 0 before
		{"8.8.8.8/32", true},   // public unicast
		{"10.2.0.0/16", false}, // on-prem private range — passes
		{"172.16.0.0/12", false},
	} {
		check(t, "vpn-add-static-route", "destination_cidr", vpnBase, c.cidr, c.wantOOB)
	}

	// vpc-add-nacl-rule · cidr_block · cidrPolicy internal-only (RFC1918 only).
	naclBase := map[string]any{
		"nacl": "aws_network_acl.main", "direction": "ingress", "rule_no": 100,
		"protocol": "tcp", "rule_action": "allow", "from_port": 443, "to_port": 443,
	}
	for _, c := range []struct {
		cidr    string
		wantOOB bool
	}{
		{"0.0.0.0/0", true},      // world-open — refused
		{"8.8.8.8/32", true},     // public
		{"169.254.1.0/24", true}, // link-local — not RFC1918, internal-only rejects
		{"10.20.0.0/16", false},  // internal — passes
		{"192.168.1.0/24", false},
	} {
		check(t, "vpc-add-nacl-rule", "cidr_block", naclBase, c.cidr, c.wantOOB)
	}

	// waf-add-ip-set-entry · new_cidr · maxPrefixLen 16 ONLY (no cidrPolicy). WAF IP
	// sets legitimately hold PUBLIC IPs — partner allowlists, attacker blocklists —
	// so no-public would break the op's own partner-egress example. maxPrefixLen
	// alone enforces the op's stated semantic ("no 0.0.0.0/0; reject prefixes < /16"):
	// it kills over-broad blocks incl. the default route while allowing tight public
	// entries; the shape pattern and no-policy both accept 10.0.0.0/8, so this bound
	// is what adds the enforcement.
	wafBase := map[string]any{"ip_set": "aws_wafv2_ip_set.main"}
	for _, c := range []struct {
		cidr    string
		wantOOB bool
	}{
		{"0.0.0.0/0", true},        // world-open — /0 far broader than /16 → refused
		{"10.0.0.0/8", true},       // too broad (even though private) — maxPrefixLen refuses
		{"10.0.0.0/15", true},      // one bit too broad
		{"8.8.8.8/32", false},      // tight PUBLIC IP — ALLOWED (WAF IP sets need this)
		{"203.0.113.12/32", false}, // partner-egress public /32 (the op's own example) — allowed
		{"10.20.0.0/16", false},    // /16 boundary — passes
		{"10.1.2.0/24", false},     // narrow — passes
	} {
		check(t, "waf-add-ip-set-entry", "new_cidr", wafBase, c.cidr, c.wantOOB)
	}
}
