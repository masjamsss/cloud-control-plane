package plancheck

import (
	"strings"
	"testing"
)

// TestCheckRestoreScopedCreateCleanCreate is R9's primary happy path: the
// pinned address plans exactly a pure create (before null) — THE restore
// landing.
func TestCheckRestoreScopedCreateCleanCreate(t *testing.T) {
	plan := planOf(sgChange("aws_flow_log.vpc1", []string{"create"}, nil, map[string]any{"traffic_type": "ALL"}))
	if got := CheckRestoreScopedCreate(plan, []string{"aws_flow_log.vpc1"}); len(got) != 0 {
		t.Fatalf("violations = %v, want none", got)
	}
}

// TestCheckRestoreScopedCreateCleanNoOp pins §2.3's R8-converged precedent:
// someone already restored the address out-of-band since the drift snapshot
// — legal, the apply is then vacuous for that address.
func TestCheckRestoreScopedCreateCleanNoOp(t *testing.T) {
	plan := planOf(sgChange("aws_flow_log.vpc1", []string{"no-op"}, nil, nil))
	if got := CheckRestoreScopedCreate(plan, []string{"aws_flow_log.vpc1"}); len(got) != 0 {
		t.Fatalf("violations = %v, want none", got)
	}
}

// TestCheckRestoreScopedCreateNotPureCreate pins the freshness-proof reason:
// an in-place update on the pinned address (live moved since the snapshot,
// or a partial recreation) is refused, never silently accepted.
func TestCheckRestoreScopedCreateNotPureCreate(t *testing.T) {
	plan := planOf(sgChange("aws_flow_log.vpc1", []string{"update"},
		map[string]any{"traffic_type": "REJECT"}, map[string]any{"traffic_type": "ALL"}))
	got := CheckRestoreScopedCreate(plan, []string{"aws_flow_log.vpc1"})
	if len(got) != 1 {
		t.Fatalf("violations = %v, want exactly 1", got)
	}
	if got[0].Rule != "restore-scoped-create" {
		t.Errorf("rule = %q, want restore-scoped-create", got[0].Rule)
	}
	if got[0].Address != "aws_flow_log.vpc1" {
		t.Errorf("address = %q, want aws_flow_log.vpc1", got[0].Address)
	}
	if !containsAll(got[0].Reason, "not a pure create", "regenerate or triage") {
		t.Errorf("reason = %q, want it to name the freshness proof", got[0].Reason)
	}
}

// TestCheckRestoreScopedCreateDeleteReplace pins §2.3's "delete/replace can
// never ride a restore" shape — both a pure delete and a create+delete
// replace.
func TestCheckRestoreScopedCreateDeleteReplace(t *testing.T) {
	t.Run("pure delete", func(t *testing.T) {
		plan := planOf(sgChange("aws_flow_log.vpc1", []string{"delete"}, map[string]any{"traffic_type": "ALL"}, nil))
		got := CheckRestoreScopedCreate(plan, []string{"aws_flow_log.vpc1"})
		if len(got) != 1 || got[0].Rule != "restore-scoped-create" {
			t.Fatalf("violations = %v, want exactly 1 restore-scoped-create", got)
		}
		if !containsAll(got[0].Reason, "delete/replace can never ride a restore") {
			t.Errorf("reason = %q, want it to name the delete/replace refusal", got[0].Reason)
		}
	})
	t.Run("create+delete replace", func(t *testing.T) {
		plan := planOf(sgChange("aws_flow_log.vpc1", []string{"create", "delete"},
			map[string]any{"traffic_type": "ALL"}, map[string]any{"traffic_type": "REJECT"}))
		got := CheckRestoreScopedCreate(plan, []string{"aws_flow_log.vpc1"})
		if len(got) != 1 || got[0].Rule != "restore-scoped-create" {
			t.Fatalf("violations = %v, want exactly 1 restore-scoped-create", got)
		}
		if !containsAll(got[0].Reason, "delete/replace can never ride a restore") {
			t.Errorf("reason = %q, want it to name the delete/replace refusal", got[0].Reason)
		}
	})
}

// TestCheckRestoreScopedCreateAbsent pins the "nothing to re-assert" shape:
// the pinned address never appears in resource_changes at all (the resource
// block was removed from code since the snapshot).
func TestCheckRestoreScopedCreateAbsent(t *testing.T) {
	plan := planOf(sgChange("aws_security_group.sg1", []string{"no-op"}, nil, nil))
	got := CheckRestoreScopedCreate(plan, []string{"aws_flow_log.vpc1"})
	if len(got) != 1 || got[0].Rule != "restore-scoped-create" {
		t.Fatalf("violations = %v, want exactly 1 restore-scoped-create", got)
	}
	if got[0].Address != "aws_flow_log.vpc1" {
		t.Errorf("address = %q, want aws_flow_log.vpc1", got[0].Address)
	}
	if !containsAll(got[0].Reason, "absent from the plan", "nothing to re-assert") {
		t.Errorf("reason = %q, want it to name the absence", got[0].Reason)
	}
}

// TestCheckRestoreScopedCreateImportingRefused pins §2.3's "nothing imports
// under a restore request" — both on the pinned address itself and on an
// unrelated one, since the rule is unconditional (pinned or not).
func TestCheckRestoreScopedCreateImportingRefused(t *testing.T) {
	t.Run("pinned address carries importing", func(t *testing.T) {
		plan := planOf(importingChange("aws_flow_log.vpc1", importingID("fl-123"), []string{"no-op"}, nil, nil))
		got := CheckRestoreScopedCreate(plan, []string{"aws_flow_log.vpc1"})
		if len(got) != 1 {
			t.Fatalf("violations = %v, want exactly 1", got)
		}
		if got[0].Rule != "restore-scope" {
			t.Errorf("rule = %q, want restore-scope", got[0].Rule)
		}
		if !containsAll(got[0].Reason, "importing in a restore plan", "nothing imports under a restore request") {
			t.Errorf("reason = %q, want it to name the importing refusal", got[0].Reason)
		}
	})
	t.Run("non-pinned address carries importing", func(t *testing.T) {
		plan := planOf(
			sgChange("aws_flow_log.vpc1", []string{"create"}, nil, map[string]any{"traffic_type": "ALL"}),
			importingChange("aws_instance.oob_a", importingID("i-a"), []string{"no-op"}, nil, nil),
		)
		got := CheckRestoreScopedCreate(plan, []string{"aws_flow_log.vpc1"})
		if len(got) != 1 {
			t.Fatalf("violations = %v, want exactly 1", got)
		}
		if got[0].Rule != "restore-scope" || got[0].Address != "aws_instance.oob_a" {
			t.Fatalf("violation = %+v, want restore-scope on aws_instance.oob_a", got[0])
		}
	})
}

// TestCheckRestoreScopedCreateScope pins the whole-plan zero-delta idiom
// shared verbatim with R7/R10: an unrelated address showing a real change is
// disqualifying, without `-target`.
func TestCheckRestoreScopedCreateScope(t *testing.T) {
	plan := planOf(
		sgChange("aws_flow_log.vpc1", []string{"create"}, nil, map[string]any{"traffic_type": "ALL"}),
		sgChange("aws_security_group.sg1", []string{"update"},
			map[string]any{"ingress": []any{}},
			map[string]any{"ingress": []any{map[string]any{"cidr_blocks": []any{"10.0.0.0/16"}}}}),
	)
	got := CheckRestoreScopedCreate(plan, []string{"aws_flow_log.vpc1"})
	if len(got) != 1 {
		t.Fatalf("violations = %v, want exactly 1", got)
	}
	if got[0].Rule != "restore-scope" || got[0].Address != "aws_security_group.sg1" {
		t.Fatalf("violation = %+v, want restore-scope on aws_security_group.sg1", got[0])
	}
	if !containsAll(got[0].Reason, "not zero-delta beyond the pinned restore targets", "blast-radius honesty") {
		t.Errorf("reason = %q, want the blast-radius idiom", got[0].Reason)
	}
}

// TestCheckRestoreScopedCreateBatchedMultipleAddresses proves a batch of
// several pinned addresses (plan §2.5: "restore batches restore-only via
// alsoDigests") is checked independently, address by address.
func TestCheckRestoreScopedCreateBatchedMultipleAddresses(t *testing.T) {
	plan := planOf(
		sgChange("aws_flow_log.vpc1", []string{"create"}, nil, map[string]any{"traffic_type": "ALL"}),
		sgChange("aws_flow_log.vpc2", []string{"update"},
			map[string]any{"traffic_type": "REJECT"}, map[string]any{"traffic_type": "ALL"}),
	)
	got := CheckRestoreScopedCreate(plan, []string{"aws_flow_log.vpc1", "aws_flow_log.vpc2"})
	if len(got) != 1 {
		t.Fatalf("violations = %v, want exactly 1 (only vpc2 is not a pure create)", got)
	}
	if got[0].Address != "aws_flow_log.vpc2" {
		t.Errorf("address = %q, want aws_flow_log.vpc2", got[0].Address)
	}
}

// containsAll mirrors driftpropose's own test helper of the same name (a
// different package — no collision), re-implemented here per this repo's
// scoped-sibling doctrine: reports whether s contains every one of subs.
func containsAll(s string, subs ...string) bool {
	for _, sub := range subs {
		if !strings.Contains(s, sub) {
			return false
		}
	}
	return true
}
