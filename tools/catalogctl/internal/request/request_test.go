package request

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/estatecfg"
)

func write(t *testing.T, body string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "req.yaml")
	if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

// mustCfg resolves an estatecfg.Config for tz (empty string ⇒ the compiled default,
// "UTC") or fails the test — the estate-config parameterization (ADR-0028) means
// every Load call now needs one; most fixtures here carry no window (cfg is
// irrelevant to them) or are windowed at the pre-existing fixtures' own literal tz
// value (unchanged — see AGENTS fixture law), so a caller-selected cfg per test
// proves the parameterization rather than hard-coding the old default in Load.
func mustCfg(t *testing.T, tz string) estatecfg.Config {
	t.Helper()
	cfg, err := estatecfg.Resolve(tz)
	if err != nil {
		t.Fatalf("estatecfg.Resolve(%q): %v", tz, err)
	}
	return cfg
}

const validReq = `schema: ccp.request/v1
id: REQ-01JZTC4QWERTY0123456789AAB
item: ec2-resize
created_at: "2026-07-10T00:00:00Z"
requester_login: fixture-l1
params:
  instance: aws_instance.foo
  new_instance_type: c6i.2xlarge
justification: test justification
computed:
  stamped: yes
`

func TestLoadValid(t *testing.T) {
	r, err := Load(write(t, validReq), mustCfg(t, "UTC"))
	if err != nil {
		t.Fatalf("Load err = %v, want nil", err)
	}
	if r.Schema != "ccp.request/v1" {
		t.Fatalf("Schema = %q", r.Schema)
	}
	if r.ID != "REQ-01JZTC4QWERTY0123456789AAB" {
		t.Fatalf("ID = %q", r.ID)
	}
	if r.Item != "ec2-resize" {
		t.Fatalf("Item = %q", r.Item)
	}
	if r.CreatedAt != "2026-07-10T00:00:00Z" {
		t.Fatalf("CreatedAt = %q", r.CreatedAt)
	}
	if r.RequesterLogin != "fixture-l1" {
		t.Fatalf("RequesterLogin = %q", r.RequesterLogin)
	}
	if r.Justification != "test justification" {
		t.Fatalf("Justification = %q", r.Justification)
	}
	if got := r.Params["new_instance_type"]; got != "c6i.2xlarge" {
		t.Fatalf("Params[new_instance_type] = %v", got)
	}
	if got := r.Computed["stamped"]; got != "yes" {
		t.Fatalf("Computed[stamped] = %v (%T)", got, got)
	}
}

func TestLoadUnknownKey(t *testing.T) {
	_, err := Load(write(t, validReq+"extra: 1\n"), mustCfg(t, "UTC"))
	if err == nil || !strings.Contains(strings.ToLower(err.Error()), "unknown") {
		t.Fatalf("err = %v, want contains 'unknown'", err)
	}
}

func TestLoadBadID(t *testing.T) {
	body := strings.Replace(validReq, "REQ-01JZTC4QWERTY0123456789AAB", "REQ-lowercase", 1)
	_, err := Load(write(t, body), mustCfg(t, "UTC"))
	if err == nil || !strings.Contains(err.Error(), "id") {
		t.Fatalf("err = %v, want contains 'id'", err)
	}
}

func TestLoadBadSchema(t *testing.T) {
	body := strings.Replace(validReq, "ccp.request/v1", "ccp.request/v2", 1)
	_, err := Load(write(t, body), mustCfg(t, "UTC"))
	if err == nil || !strings.Contains(err.Error(), "schema") {
		t.Fatalf("err = %v, want contains 'schema'", err)
	}
}

// --- plan-8 W1 production-wiring extensions ---

const approvedReq = `schema: ccp.request/v1
id: REQ-01JZTC4QWERTY0123456789AAB
item: ec2-resize
target: aws_instance.foo
created_at: "2026-07-10T00:00:00Z"
requester_login: fixture-l1
params:
  instance: aws_instance.foo
  new_instance_type: c6i.2xlarge
justification: test justification
earliest_apply_at: "2026-07-11T00:00:00Z"
window:
  start: "2026-07-12T18:00:00Z"
  end: "2026-07-12T22:00:00Z"
  tz: America/New_York
approvals:
  - approver: alice
    approved_at: "2026-07-10T09:00:00Z"
    policy_version: pol-2026-07
    digest: abc123
    decision: approve
  - approver: bob
    approved_at: "2026-07-10T09:05:00Z"
    policy_version: pol-2026-07
    digest: abc123
    decision: approve
`

func TestLoadExtensions(t *testing.T) {
	// approvedReq's window carries the pre-existing fixture's own literal tz value
	// (unchanged, AGENTS fixture law) — cfg must match for Load to succeed, proving
	// the parameterization.
	r, err := Load(write(t, approvedReq), mustCfg(t, "America/New_York"))
	if err != nil {
		t.Fatalf("Load err = %v, want nil", err)
	}
	if r.Target != "aws_instance.foo" {
		t.Fatalf("Target = %q", r.Target)
	}
	if r.EarliestApplyAt != "2026-07-11T00:00:00Z" {
		t.Fatalf("EarliestApplyAt = %q", r.EarliestApplyAt)
	}
	if r.Window == nil || r.Window.TZ != "America/New_York" || r.Window.Start == "" || r.Window.End == "" {
		t.Fatalf("Window = %+v", r.Window)
	}
	if len(r.Approvals) != 2 {
		t.Fatalf("Approvals len = %d, want 2", len(r.Approvals))
	}
	if r.Approvals[0].Approver != "alice" || r.Approvals[0].Digest != "abc123" || r.Approvals[0].Decision != "approve" {
		t.Fatalf("Approvals[0] = %+v", r.Approvals[0])
	}
	d, ok := r.ApprovedDigest()
	if !ok || d != "abc123" {
		t.Fatalf("ApprovedDigest = %q,%v want abc123,true", d, ok)
	}
}

// A null window and no approvals still load (a bare/pre-approval request); the
// extensions are optional so edit/plan-check fixtures without them keep working.
func TestLoadExtensionsOptional(t *testing.T) {
	body := strings.Replace(validReq, "computed:\n  stamped: yes\n", "window: null\n", 1)
	r, err := Load(write(t, body), mustCfg(t, "UTC"))
	if err != nil {
		t.Fatalf("Load err = %v, want nil", err)
	}
	if r.Window != nil {
		t.Fatalf("Window = %+v, want nil for `window: null`", r.Window)
	}
	if len(r.Approvals) != 0 {
		t.Fatalf("Approvals len = %d, want 0", len(r.Approvals))
	}
	if d, ok := r.ApprovedDigest(); !ok || d != "" {
		t.Fatalf("ApprovedDigest = %q,%v want \"\",true (nothing to bind)", d, ok)
	}
}

// Two approvals naming different plan digests is a split-brain quorum: ApprovedDigest
// refuses it so pr-prepare can never fold two-different-plan sign-offs into one PR.
func TestApprovedDigestDisagreement(t *testing.T) {
	body := strings.Replace(approvedReq,
		"    digest: abc123\n    decision: approve\n  - approver: bob\n    approved_at: \"2026-07-10T09:05:00Z\"\n    policy_version: pol-2026-07\n    digest: abc123",
		"    digest: abc123\n    decision: approve\n  - approver: bob\n    approved_at: \"2026-07-10T09:05:00Z\"\n    policy_version: pol-2026-07\n    digest: DIFFERENT",
		1)
	r, err := Load(write(t, body), mustCfg(t, "America/New_York"))
	if err != nil {
		t.Fatalf("Load err = %v", err)
	}
	if _, ok := r.ApprovedDigest(); ok {
		t.Fatalf("ApprovedDigest ok = true, want false for disagreeing digests")
	}
}

// An unknown key inside a nested extension (approvals[].) is still a schema error —
// yaml.v3 KnownFields recurses, so a typo'd approval field fails closed (exit 3).
func TestLoadUnknownNestedKey(t *testing.T) {
	body := approvedReq + "    typo_field: 1\n"
	// The unknown-key decode error fires before the tz check is ever reached, so cfg's
	// value is immaterial here — UTC keeps this test independent of the fixture's window.
	_, err := Load(write(t, body), mustCfg(t, "UTC"))
	if err == nil {
		t.Fatalf("err = nil, want schema error for unknown nested key")
	}
}

// --- 0024 §3.2: window/earliest hardening. A gate cannot trust fields nobody checks;
//     Load now rejects a malformed schedule so window-check fails closed (exit 3). ---

func TestLoadWindowHardening(t *testing.T) {
	// windowBlock builds a valid request whose window block is replaced with the given
	// start/end/tz lines, so each case isolates one malformed field.
	base := `schema: ccp.request/v1
id: REQ-01JZTC4QWERTY0123456789AAB
item: ec2-resize
created_at: "2026-07-10T00:00:00Z"
requester_login: fixture-l1
justification: t
window:
`
	cases := []struct {
		name string
		body string
		// wantErr substring; empty means Load must SUCCEED.
		wantErr string
	}{
		{"valid window loads", base + "  start: \"2026-07-12T18:00:00Z\"\n  end: \"2026-07-12T22:00:00Z\"\n  tz: America/New_York\n", ""},
		{"start not RFC3339", base + "  start: \"not-a-date\"\n  end: \"2026-07-12T22:00:00Z\"\n  tz: America/New_York\n", "window.start"},
		{"end not RFC3339", base + "  start: \"2026-07-12T18:00:00Z\"\n  end: \"soon\"\n  tz: America/New_York\n", "window.end"},
		{"start not before end", base + "  start: \"2026-07-12T22:00:00Z\"\n  end: \"2026-07-12T18:00:00Z\"\n  tz: America/New_York\n", "before"},
		{"start equals end", base + "  start: \"2026-07-12T18:00:00Z\"\n  end: \"2026-07-12T18:00:00Z\"\n  tz: America/New_York\n", "before"},
		{"wrong tz", base + "  start: \"2026-07-12T18:00:00Z\"\n  end: \"2026-07-12T22:00:00Z\"\n  tz: Europe/London\n", "America/New_York"},
	}
	// The estate is configured to America/New_York to match every valid case body's tz
	// (re-oracled from the original estate zone for the public scrub); the "wrong tz"
	// case uses a different zone (Europe/London) to prove the mismatch refusal, and its
	// wantErr substring matches because the message embeds cfg.EstateTZ verbatim.
	cfg := mustCfg(t, "America/New_York")
	for _, c := range cases {
		c := c
		t.Run(c.name, func(t *testing.T) {
			_, err := Load(write(t, c.body), cfg)
			if c.wantErr == "" {
				if err != nil {
					t.Fatalf("Load err = %v, want nil", err)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), c.wantErr) {
				t.Fatalf("Load err = %v, want contains %q", err, c.wantErr)
			}
		})
	}
}

// earliest_apply_at, when present, must parse (even with no window) — the cooling gate
// compares it as an instant. A null window with a valid earliest still loads.
func TestLoadEarliestHardening(t *testing.T) {
	base := `schema: ccp.request/v1
id: REQ-01JZTC4QWERTY0123456789AAB
item: ec2-resize
created_at: "2026-07-10T00:00:00Z"
requester_login: fixture-l1
justification: t
window: null
`
	cfg := mustCfg(t, "UTC")
	if _, err := Load(write(t, base+"earliest_apply_at: \"2026-07-11T06:00:00Z\"\n"), cfg); err != nil {
		t.Fatalf("valid earliest_apply_at: Load err = %v, want nil", err)
	}
	_, err := Load(write(t, base+"earliest_apply_at: \"whenever\"\n"), cfg)
	if err == nil || !strings.Contains(err.Error(), "earliest_apply_at") {
		t.Fatalf("Load err = %v, want contains 'earliest_apply_at'", err)
	}
}

// --- estate-config (ADR-0028, #37): window.tz is checked against the estate's
//     resolved operating timezone (cfg.EstateTZ) instead of a hard-coded literal. ---

// TestLoadWindowTZUTCDefault proves the blank-install default path (spec §7): a
// request windowed at "UTC" loads cleanly against the compiled DefaultEstateTZ, with
// no flag/env involved. This is the "small tz: UTC fixture" the spec calls for,
// expressed inline rather than as a new on-disk fixture (mirrors this file's
// existing style of literal YAML bodies).
func TestLoadWindowTZUTCDefault(t *testing.T) {
	body := `schema: ccp.request/v1
id: REQ-01JZTC4QWERTY0123456789AAB
item: ec2-resize
created_at: "2026-07-10T00:00:00Z"
requester_login: fixture-l1
justification: t
window:
  start: "2026-07-12T18:00:00Z"
  end: "2026-07-12T22:00:00Z"
  tz: UTC
`
	r, err := Load(write(t, body), mustCfg(t, "")) // "" resolves to DefaultEstateTZ ("UTC")
	if err != nil {
		t.Fatalf("Load err = %v, want nil (UTC request against the UTC default estate)", err)
	}
	if r.Window == nil || r.Window.TZ != "UTC" {
		t.Fatalf("Window = %+v, want tz UTC", r.Window)
	}
}

// TestLoadWindowTZMismatch is the mismatch test (spec §5.4): an estate configured
// for UTC must fail closed, exit-3-shaped (a non-nil schema error; the CLI layer
// maps it to exit 3), when a request claims a DIFFERENT tz (America/New_York — any
// value other than the configured estate proves the same codepath; TestLoadExtensions
// and TestLoadWindowHardening above already cover the pre-existing fixtures' own
// literal tz value end-to-end). The message must name both the offending value and
// the estate's actual configured expectation, and cite ADR-0028.
func TestLoadWindowTZMismatch(t *testing.T) {
	body := `schema: ccp.request/v1
id: REQ-01JZTC4QWERTY0123456789AAB
item: ec2-resize
created_at: "2026-07-10T00:00:00Z"
requester_login: fixture-l1
justification: t
window:
  start: "2026-07-12T18:00:00Z"
  end: "2026-07-12T22:00:00Z"
  tz: America/New_York
`
	_, err := Load(write(t, body), mustCfg(t, "UTC"))
	if err == nil {
		t.Fatal("Load err = nil, want a fail-closed schema error for tz != the configured estate")
	}
	for _, want := range []string{"America/New_York", "UTC", "estate operating timezone", "ADR-0028"} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("Load err = %v, want it to contain %q", err, want)
		}
	}
}
