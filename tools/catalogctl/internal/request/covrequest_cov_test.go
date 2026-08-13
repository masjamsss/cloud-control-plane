package request

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/estatecfg"
)

// covrequestwrite writes body to a fresh temp dir under the given base name and
// returns the path. Mirrors the package's existing write() helper but is
// slot-prefixed and lets a case choose the file name (used by the read-error cases).
func covrequestwrite(t *testing.T, name, body string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

// covrequestmustCfg resolves the compiled-default estate config ("UTC"). Every case
// in this file fails (or succeeds) before validateSchedule ever compares a tz, so the
// estate zone is immaterial here — the default keeps these tests independent of it.
func covrequestmustCfg(t *testing.T) estatecfg.Config {
	t.Helper()
	cfg, err := estatecfg.Resolve("")
	if err != nil {
		t.Fatalf("estatecfg.Resolve(\"\"): %v", err)
	}
	return cfg
}

// covrequestbase is a minimal, schedule-free valid request: no window and no
// earliest_apply_at, so validateSchedule is a no-op and each case below isolates
// exactly one Load failure mode.
const covrequestbase = `schema: ccp.request/v1
id: REQ-01JZTC4QWERTY0123456789AAB
item: ec2-resize
created_at: "2026-07-10T00:00:00Z"
requester_login: fixture-l1
justification: t
`

// TestCovrequestLoadReadError covers Load's os.ReadFile failure: the error is
// returned unwrapped (callers map any Load error to exit 3), and must be a
// recognisable fs error naming the path rather than a "request schema:" message —
// a missing file is not a malformed one.
func TestCovrequestLoadReadError(t *testing.T) {
	t.Run("missing file", func(t *testing.T) {
		missing := filepath.Join(t.TempDir(), "no-such-request.yaml")
		r, err := Load(missing, covrequestmustCfg(t))
		if err == nil {
			t.Fatalf("Load(%q) err = nil, want a read error", missing)
		}
		if r != nil {
			t.Fatalf("Load returned %+v, want nil Request on error", r)
		}
		if !errors.Is(err, fs.ErrNotExist) {
			t.Fatalf("Load err = %v, want errors.Is(err, fs.ErrNotExist)", err)
		}
		if !strings.Contains(err.Error(), missing) {
			t.Fatalf("Load err = %v, want it to name the path %q", err, missing)
		}
		if strings.Contains(err.Error(), "request schema") {
			t.Fatalf("Load err = %v, want a read error, not a schema error", err)
		}
	})

	t.Run("path is a directory", func(t *testing.T) {
		dir := t.TempDir()
		r, err := Load(dir, covrequestmustCfg(t))
		if err == nil {
			t.Fatalf("Load(%q) err = nil, want a read error for a directory", dir)
		}
		if r != nil {
			t.Fatalf("Load returned %+v, want nil Request on error", r)
		}
		if !strings.Contains(err.Error(), dir) {
			t.Fatalf("Load err = %v, want it to name the path %q", err, dir)
		}
	})
}

// TestCovrequestLoadMalformedYAML covers the non-KnownFields decode failure branch:
// any YAML that will not decode into a Request is wrapped as "request schema: <cause>"
// (exit 3) and must NOT be mislabelled as an unknown-top-level-field error, which is
// the sibling branch keyed off yaml.v3's "not found in type" text.
func TestCovrequestLoadMalformedYAML(t *testing.T) {
	cases := []struct {
		name string
		body string
		// wantCause is a substring of the underlying yaml error the wrap must carry
		// through, proving the cause is not swallowed.
		wantCause string
	}{
		{
			name:      "unparseable scalar/flow syntax",
			body:      "schema: ccp.request/v1\nparams: [unclosed\n",
			wantCause: "did not find expected",
		},
		{
			name:      "document is a scalar, not a mapping",
			body:      "just-a-string\n",
			wantCause: "cannot unmarshal",
		},
		{
			name:      "params is a string, not a mapping",
			body:      covrequestbase + "params: not-a-mapping\n",
			wantCause: "cannot unmarshal",
		},
		{
			name:      "approvals is a scalar, not a sequence",
			body:      covrequestbase + "approvals: 7\n",
			wantCause: "cannot unmarshal",
		},
		{
			name:      "window is a scalar, not a mapping",
			body:      covrequestbase + "window: tomorrow\n",
			wantCause: "cannot unmarshal",
		},
		{
			name:      "id is a mapping, not a string",
			body:      "schema: ccp.request/v1\nid:\n  nested: 1\nitem: ec2-resize\n",
			wantCause: "cannot unmarshal",
		},
		{
			name:      "tab-indented block is not valid YAML",
			body:      "schema: ccp.request/v1\nparams:\n\tinstance: aws_instance.foo\n",
			wantCause: "cannot start any token",
		},
	}
	for _, c := range cases {
		c := c
		t.Run(c.name, func(t *testing.T) {
			r, err := Load(covrequestwrite(t, "req.yaml", c.body), covrequestmustCfg(t))
			if err == nil {
				t.Fatalf("Load err = nil, want a schema error; got request %+v", r)
			}
			if r != nil {
				t.Fatalf("Load returned %+v, want nil Request on error", r)
			}
			if !strings.HasPrefix(err.Error(), "request schema: ") {
				t.Fatalf("Load err = %q, want prefix %q", err.Error(), "request schema: ")
			}
			if strings.Contains(err.Error(), "unknown top-level field") {
				t.Fatalf("Load err = %q, want the generic decode wrap, not the unknown-field wrap", err.Error())
			}
			if !strings.Contains(err.Error(), c.wantCause) {
				t.Fatalf("Load err = %q, want it to carry the yaml cause %q", err.Error(), c.wantCause)
			}
		})
	}
}

// TestCovrequestLoadItemRequired covers the `item` validation: schema and id may be
// perfectly well-formed, but an empty/absent item is still a fail-closed schema error
// with the exact message "request item is required" — an op cannot be dispatched
// without knowing which catalog item is being requested.
func TestCovrequestLoadItemRequired(t *testing.T) {
	const noItem = `schema: ccp.request/v1
id: REQ-01JZTC4QWERTY0123456789AAB
created_at: "2026-07-10T00:00:00Z"
requester_login: fixture-l1
justification: t
`
	cases := []struct {
		name string
		body string
	}{
		{"item key absent", noItem},
		{"item empty quoted string", noItem + "item: \"\"\n"},
		{"item null", noItem + "item: null\n"},
	}
	for _, c := range cases {
		c := c
		t.Run(c.name, func(t *testing.T) {
			r, err := Load(covrequestwrite(t, "req.yaml", c.body), covrequestmustCfg(t))
			if err == nil {
				t.Fatalf("Load err = nil, want 'request item is required'; got %+v", r)
			}
			if r != nil {
				t.Fatalf("Load returned %+v, want nil Request on error", r)
			}
			if got, want := err.Error(), "request item is required"; got != want {
				t.Fatalf("Load err = %q, want %q", got, want)
			}
		})
	}

	// Control: the same body WITH an item loads, proving the cases above fail on the
	// item alone and not on some other field of the fixture.
	t.Run("item present loads", func(t *testing.T) {
		r, err := Load(covrequestwrite(t, "req.yaml", noItem+"item: ec2-resize\n"), covrequestmustCfg(t))
		if err != nil {
			t.Fatalf("Load err = %v, want nil", err)
		}
		if r.Item != "ec2-resize" {
			t.Fatalf("Item = %q, want ec2-resize", r.Item)
		}
	})
}

// TestCovrequestApprovedDigestMixedEmpty pins the empty-digest skip in
// ApprovedDigest: approve-decision entries that carry no digest (pre-plan sign-offs)
// are ignored rather than treated as a disagreeing value, so a quorum where only some
// approvers bound a plan still yields that one digest. Every entry here carries
// Decision: DecisionApprove — CTL-9 made ApprovedDigest count only those, so a case
// meant to test the digest-merge logic in isolation must opt every entry in
// explicitly; TestCovrequestApprovedDigestDecisionFiltering below pins the
// decision-filtering behavior itself.
func TestCovrequestApprovedDigestMixedEmpty(t *testing.T) {
	cases := []struct {
		name       string
		approvals  []Approval
		wantDigest string
		wantOK     bool
	}{
		{"no approvals at all", nil, "", true},
		{"all approvals digest-less", []Approval{{Approver: "a", Decision: DecisionApprove}, {Approver: "b", Decision: DecisionApprove}}, "", true},
		{
			name:       "leading empty digest is skipped",
			approvals:  []Approval{{Approver: "a", Decision: DecisionApprove}, {Approver: "b", Decision: DecisionApprove, Digest: "abc123"}},
			wantDigest: "abc123",
			wantOK:     true,
		},
		{
			name:       "trailing empty digest is skipped",
			approvals:  []Approval{{Approver: "a", Decision: DecisionApprove, Digest: "abc123"}, {Approver: "b", Decision: DecisionApprove}},
			wantDigest: "abc123",
			wantOK:     true,
		},
		{
			name:       "empty between two agreeing digests is skipped",
			approvals:  []Approval{{Approver: "a", Decision: DecisionApprove, Digest: "abc123"}, {Approver: "b", Decision: DecisionApprove}, {Approver: "c", Decision: DecisionApprove, Digest: "abc123"}},
			wantDigest: "abc123",
			wantOK:     true,
		},
		{
			name:      "empty does not mask a real disagreement",
			approvals: []Approval{{Approver: "a", Decision: DecisionApprove, Digest: "abc123"}, {Approver: "b", Decision: DecisionApprove}, {Approver: "c", Decision: DecisionApprove, Digest: "def456"}},
			wantOK:    false,
		},
	}
	for _, c := range cases {
		c := c
		t.Run(c.name, func(t *testing.T) {
			r := &Request{Approvals: c.approvals}
			got, ok := r.ApprovedDigest()
			if ok != c.wantOK {
				t.Fatalf("ApprovedDigest ok = %v, want %v", ok, c.wantOK)
			}
			if got != c.wantDigest {
				t.Fatalf("ApprovedDigest digest = %q, want %q", got, c.wantDigest)
			}
		})
	}
}

// TestCovrequestApprovedDigestDecisionFiltering pins CTL-9's fix: an entry that is
// not an approve decision — blank (no vote recorded) or an explicit reject — never
// contributes its digest, so it can neither bind a quorum to a plan nor manufacture a
// false split-brain disagreement against the real approvers.
func TestCovrequestApprovedDigestDecisionFiltering(t *testing.T) {
	cases := []struct {
		name       string
		approvals  []Approval
		wantDigest string
		wantOK     bool
	}{
		{
			name:       "a blank-decision entry's digest is ignored, even though it disagrees",
			approvals:  []Approval{{Approver: "a", Decision: DecisionApprove, Digest: "abc123"}, {Approver: "b", Digest: "def456"}},
			wantDigest: "abc123",
			wantOK:     true,
		},
		{
			name:       "an explicit-reject entry's digest is ignored, even though it disagrees",
			approvals:  []Approval{{Approver: "a", Decision: DecisionApprove, Digest: "abc123"}, {Approver: "b", Decision: "reject", Digest: "def456"}},
			wantDigest: "abc123",
			wantOK:     true,
		},
		{
			name:       "all entries blank or rejected yields nothing to bind, not a disagreement",
			approvals:  []Approval{{Approver: "a"}, {Approver: "b", Decision: "changes_requested", Digest: "def456"}},
			wantDigest: "",
			wantOK:     true,
		},
	}
	for _, c := range cases {
		c := c
		t.Run(c.name, func(t *testing.T) {
			r := &Request{Approvals: c.approvals}
			got, ok := r.ApprovedDigest()
			if ok != c.wantOK {
				t.Fatalf("ApprovedDigest ok = %v, want %v", ok, c.wantOK)
			}
			if got != c.wantDigest {
				t.Fatalf("ApprovedDigest digest = %q, want %q", got, c.wantDigest)
			}
		})
	}
}

// TestCovrequestApprovedEntriesAndRejection pins ApprovedEntries (only Decision ==
// approve counts) and HasExplicitRejection (fires on a non-blank, non-approve
// Decision; a blank one is "no vote yet", not a rejection) directly.
func TestCovrequestApprovedEntriesAndRejection(t *testing.T) {
	r := &Request{Approvals: []Approval{
		{Approver: "a", Decision: DecisionApprove},
		{Approver: "b"},
		{Approver: "c", Decision: "reject"},
	}}
	entries := r.ApprovedEntries()
	if len(entries) != 1 || entries[0].Approver != "a" {
		t.Fatalf("ApprovedEntries = %+v, want just [a]", entries)
	}
	if !r.HasExplicitRejection() {
		t.Fatalf("HasExplicitRejection = false, want true (c rejected)")
	}
	clean := &Request{Approvals: []Approval{{Approver: "a", Decision: DecisionApprove}, {Approver: "b"}}}
	if clean.HasExplicitRejection() {
		t.Fatalf("HasExplicitRejection = true, want false (blank is not a rejection)")
	}
}
