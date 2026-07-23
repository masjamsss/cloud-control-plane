package plancheck

import "testing"

// TestCheckLegitimizeZeroDeltaClean: an entirely no-op plan is clean — the
// engineer's linked PR already converged the code, so the closure apply's
// own plan shows nothing left to do.
func TestCheckLegitimizeZeroDeltaClean(t *testing.T) {
	plan := planOf(
		sgChange("aws_security_group.sg1", []string{"no-op"}, nil, nil),
		sgChange("aws_instance.sample01", []string{"no-op"}, nil, nil),
	)
	if got := CheckLegitimizeZeroDelta(plan); len(got) != 0 {
		t.Fatalf("violations = %v, want none", got)
	}
}

// TestCheckLegitimizeZeroDeltaResidualDiffViolates proves R11's whole-plan
// scope, mirroring TestCheckAdoptZeroDeltaAnyResidualDiffViolates: a changed
// entry ANYWHERE — not only the address the legitimize request names — is
// disqualifying, whether it is the named security group itself (the linked
// PR has not merged, or live moved again) or a wholly unrelated resource.
func TestCheckLegitimizeZeroDeltaResidualDiffViolates(t *testing.T) {
	tests := []struct {
		name string
		plan Plan
	}{
		{
			name: "the named security group itself still shows a diff",
			plan: planOf(sgChange("aws_security_group.sg1", []string{"update"},
				map[string]any{"ingress": []any{map[string]any{"cidr_blocks": []any{"0.0.0.0/0"}}}},
				map[string]any{"ingress": []any{map[string]any{"cidr_blocks": []any{"10.0.0.0/16"}}}})),
		},
		{
			name: "an unrelated address is still outstanding drift",
			plan: planOf(
				sgChange("aws_security_group.sg1", []string{"no-op"}, nil, nil),
				sgChange("aws_instance.sample01", []string{"update"},
					map[string]any{"tags": map[string]any{"Owner": "someone-else"}},
					map[string]any{"tags": map[string]any{"Owner": "bi-team"}}),
			),
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := CheckLegitimizeZeroDelta(tt.plan)
			if len(got) == 0 {
				t.Fatal("want at least one legitimize-zero-delta violation")
			}
			for _, v := range got {
				if v.Rule != "legitimize-zero-delta" {
					t.Errorf("rule = %q, want legitimize-zero-delta", v.Rule)
				}
				if !containsAll(v.Reason, "not zero-delta", "linked PR lands") {
					t.Errorf("reason = %q, want it to name the linked-PR doctrine", v.Reason)
				}
			}
		})
	}
}
