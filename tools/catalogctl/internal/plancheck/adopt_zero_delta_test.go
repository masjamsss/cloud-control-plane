package plancheck

import "testing"

// TestCheckAdoptZeroDeltaClean: an entirely no-op plan is clean — the direct,
// package-level counterpart of the fixture-driven TestR7Green (plancheck_drift_test.go).
func TestCheckAdoptZeroDeltaClean(t *testing.T) {
	plan := planOf(
		sgChange("aws_instance.sample01", []string{"no-op"}, nil, nil),
		sgChange("aws_security_group.sg1", []string{"no-op"}, nil, nil),
	)
	if got := CheckAdoptZeroDelta(plan); len(got) != 0 {
		t.Fatalf("violations = %v, want none", got)
	}
}

// TestCheckAdoptZeroDeltaAnyResidualDiffViolates proves R7's "whole plan" scope: a
// changed entry ANYWHERE — not only the adopted address — is disqualifying (spec §7
// "Blast-radius honesty": any outstanding drift elsewhere in the estate rides along
// with a single-root apply). No violation distinguishes "the adopted address" from
// "some other address".
func TestCheckAdoptZeroDeltaAnyResidualDiffViolates(t *testing.T) {
	tests := []struct {
		name string
		plan Plan
	}{
		{
			name: "the adopted address itself still shows a diff",
			plan: planOf(sgChange("aws_instance.sample01", []string{"update"},
				map[string]any{"tags": map[string]any{"Owner": "someone-else"}},
				map[string]any{"tags": map[string]any{"Owner": "bi-team"}})),
		},
		{
			name: "an unrelated address is still outstanding drift",
			plan: planOf(
				sgChange("aws_instance.sample01", []string{"no-op"}, nil, nil),
				sgChange("aws_security_group.sg1", []string{"update"},
					map[string]any{"ingress": []any{}},
					map[string]any{"ingress": []any{map[string]any{"cidr_blocks": []any{"10.0.0.0/16"}}}}),
			),
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := CheckAdoptZeroDelta(tt.plan)
			if len(got) == 0 {
				t.Fatal("want at least one adopt-zero-delta violation")
			}
			for _, v := range got {
				if v.Rule != "adopt-zero-delta" {
					t.Errorf("rule = %q, want adopt-zero-delta", v.Rule)
				}
			}
		})
	}
}
