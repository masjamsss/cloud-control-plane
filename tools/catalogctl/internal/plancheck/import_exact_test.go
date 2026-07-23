package plancheck

import "testing"

// importingChange builds a ResourceChange carrying change.importing (nil
// importingID means the change carries NO importing field at all) — the one
// shape sgChange (publicingress_test.go) has no reason to express.
func importingChange(addr string, importingID *string, actions []string, before, after map[string]any) ResourceChange {
	var imp *Importing
	if importingID != nil {
		imp = &Importing{ID: *importingID}
	}
	return ResourceChange{Address: addr, Change: Change{Actions: actions, Before: before, After: after, Importing: imp}}
}

func importingID(id string) *string { return &id }

// TestCheckImportExactClean is the direct, package-level counterpart of the
// fixture-driven TestR10Green: every pinned address plans exactly
// change.importing + ["no-op"], nothing else in the plan.
func TestCheckImportExactClean(t *testing.T) {
	plan := planOf(
		importingChange("aws_instance.oob_a", importingID("i-a"), []string{"no-op"}, nil, nil),
		importingChange("aws_instance.oob_b", importingID("i-b"), []string{"no-op"}, nil, nil),
	)
	if got := CheckImportExact(plan, []string{"aws_instance.oob_a", "aws_instance.oob_b"}); len(got) != 0 {
		t.Fatalf("violations = %v, want none", got)
	}
}

// TestCheckImportExactResidual pins the freshness reason: importing set but
// actions != ["no-op"].
func TestCheckImportExactResidual(t *testing.T) {
	plan := planOf(importingChange("aws_instance.oob_a", importingID("i-a"), []string{"update"},
		map[string]any{"instance_type": "m5.large"}, map[string]any{"instance_type": "m5.xlarge"}))
	got := CheckImportExact(plan, []string{"aws_instance.oob_a"})
	if len(got) != 1 {
		t.Fatalf("violations = %v, want exactly 1", got)
	}
	if got[0].Rule != "import-exact" {
		t.Errorf("rule = %q, want import-exact", got[0].Rule)
	}
	if got[0].Address != "aws_instance.oob_a" {
		t.Errorf("address = %q, want aws_instance.oob_a", got[0].Address)
	}
}

// TestCheckImportExactAbsent pins the "no importing entry at all" reason —
// covering BOTH sub-shapes: the address entirely missing from the plan, and
// present but never carrying change.importing.
func TestCheckImportExactAbsent(t *testing.T) {
	t.Run("address missing from the plan entirely", func(t *testing.T) {
		plan := planOf(importingChange("aws_security_group.sg1", nil, []string{"no-op"}, nil, nil))
		got := CheckImportExact(plan, []string{"aws_instance.oob_a"})
		if len(got) != 1 || got[0].Rule != "import-exact" {
			t.Fatalf("violations = %v, want exactly 1 import-exact", got)
		}
	})
	t.Run("address present but never carries importing", func(t *testing.T) {
		plan := planOf(importingChange("aws_instance.oob_a", nil, []string{"no-op"}, nil, nil))
		got := CheckImportExact(plan, []string{"aws_instance.oob_a"})
		if len(got) != 1 || got[0].Rule != "import-exact" {
			t.Fatalf("violations = %v, want exactly 1 import-exact", got)
		}
	})
}

// TestCheckImportExactScope pins the non-pinned-address-importing violation
// — distinct from the generic whole-plan-changed violation below.
func TestCheckImportExactScope(t *testing.T) {
	plan := planOf(
		importingChange("aws_instance.oob_a", importingID("i-a"), []string{"no-op"}, nil, nil),
		importingChange("aws_instance.unapproved", importingID("i-unapproved"), []string{"no-op"}, nil, nil),
	)
	got := CheckImportExact(plan, []string{"aws_instance.oob_a"})
	if len(got) != 1 {
		t.Fatalf("violations = %v, want exactly 1", got)
	}
	if got[0].Rule != "import-scope" || got[0].Address != "aws_instance.unapproved" {
		t.Fatalf("violation = %+v, want import-scope on aws_instance.unapproved", got[0])
	}
}

// TestCheckImportExactWholePlanZeroDelta pins spec §7.2's "whole-plan
// zero-delta idiom shared verbatim with R7": any OTHER resource change
// anywhere in the plan (non-no-op, NOT importing) is disqualifying — the
// blast-radius net, applied without `-target`.
func TestCheckImportExactWholePlanZeroDelta(t *testing.T) {
	plan := planOf(
		importingChange("aws_instance.oob_a", importingID("i-a"), []string{"no-op"}, nil, nil),
		sgChange("aws_security_group.sg1", []string{"update"},
			map[string]any{"ingress": []any{}},
			map[string]any{"ingress": []any{map[string]any{"cidr_blocks": []any{"10.0.0.0/16"}}}}),
	)
	got := CheckImportExact(plan, []string{"aws_instance.oob_a"})
	if len(got) != 1 {
		t.Fatalf("violations = %v, want exactly 1", got)
	}
	if got[0].Rule != "import-exact" || got[0].Address != "aws_security_group.sg1" {
		t.Fatalf("violation = %+v, want import-exact on aws_security_group.sg1", got[0])
	}
}

// TestCheckImportExactBatchedMultipleAddresses proves a batch of several
// pinned addresses (spec §6: "one bundle importing N resources") is checked
// independently, address by address — one bad apple does not hide another's
// cleanliness, and does not spuriously flag it either.
func TestCheckImportExactBatchedMultipleAddresses(t *testing.T) {
	plan := planOf(
		importingChange("aws_instance.oob_a", importingID("i-a"), []string{"no-op"}, nil, nil),
		importingChange("aws_instance.oob_b", importingID("i-b"), []string{"update"}, nil, nil),
	)
	got := CheckImportExact(plan, []string{"aws_instance.oob_a", "aws_instance.oob_b"})
	if len(got) != 1 {
		t.Fatalf("violations = %v, want exactly 1 (only oob_b is residual)", got)
	}
	if got[0].Address != "aws_instance.oob_b" {
		t.Errorf("address = %q, want aws_instance.oob_b", got[0].Address)
	}
}
