package plancheck

import (
	"testing"

	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/driftpropose"
)

// TestParsePinnedPath pins parsePinnedPath as pathStr's exact inverse over the
// shapes classify.py's display_path convention emits — a round trip through both
// directions must return the original segments.
func TestParsePinnedPath(t *testing.T) {
	cases := []struct {
		s    string
		want []any
	}{
		{"tags.Owner", []any{"tags", "Owner"}},
		{"ingress[0].cidr_blocks", []any{"ingress", 0, "cidr_blocks"}},
		{"instance_type", []any{"instance_type"}},
	}
	for _, tt := range cases {
		got := parsePinnedPath(tt.s)
		if len(got) != len(tt.want) {
			t.Fatalf("parsePinnedPath(%q) = %v, want %v", tt.s, got, tt.want)
		}
		for i := range got {
			if got[i] != tt.want[i] {
				t.Fatalf("parsePinnedPath(%q)[%d] = %v (%T), want %v (%T)", tt.s, i, got[i], got[i], tt.want[i], tt.want[i])
			}
		}
		// round trip: pathStr(parsePinnedPath(s)) == s
		if roundTrip := pathStr(got); roundTrip != tt.s {
			t.Errorf("pathStr(parsePinnedPath(%q)) = %q, want %q", tt.s, roundTrip, tt.s)
		}
	}
}

// TestCheckRevertInPlacePathEscape: an update on a pinned target touches a path
// OUTSIDE the pinned drifted set — spec §7: "every changed path within the pinned
// drifted paths", a condition this test exercises directly (the six named/fixture
// cases don't happen to cover it).
func TestCheckRevertInPlacePathEscape(t *testing.T) {
	attrs := []driftpropose.Attr{{Address: "aws_instance.a", Path: "tags.Owner", LiveJSON: "bi-team", CodeJSON: "platform"}}
	plan := planOf(sgChange("aws_instance.a", []string{"update"},
		map[string]any{"tags": map[string]any{"Owner": "bi-team"}, "instance_type": "m5.large"},
		map[string]any{"tags": map[string]any{"Owner": "platform"}, "instance_type": "m5.xlarge"}))
	got := CheckRevertInPlace(plan, attrs)
	if len(got) != 1 {
		t.Fatalf("violations = %v, want exactly 1 (instance_type is not a pinned path)", got)
	}
	if got[0].Rule != "revert-in-place" {
		t.Errorf("rule = %q, want revert-in-place", got[0].Rule)
	}
}

// TestCheckRevertInPlaceListSubtreeCover directly exercises the list-valued
// attribute cover (the same shape TestGateRevertGreen proves through the whole
// gate): a pinned "ingress[0].cidr_blocks" path must cover the
// changedLeaves-reported "ingress[0].cidr_blocks[0]" element leaf, not just an
// impossible exact match on the bare list attribute.
func TestCheckRevertInPlaceListSubtreeCover(t *testing.T) {
	attrs := []driftpropose.Attr{{Address: "aws_security_group.sg1", Path: "ingress[0].cidr_blocks", LiveJSON: []any{"0.0.0.0/0"}, CodeJSON: []any{"10.0.0.0/16"}}}
	plan := planOf(sgChange("aws_security_group.sg1", []string{"update"},
		map[string]any{"ingress": []any{map[string]any{"cidr_blocks": []any{"0.0.0.0/0"}}}},
		map[string]any{"ingress": []any{map[string]any{"cidr_blocks": []any{"10.0.0.0/16"}}}}))
	if got := CheckRevertInPlace(plan, attrs); len(got) != 0 {
		t.Fatalf("violations = %v, want none", got)
	}
}

// TestCheckRevertInPlaceEmptyPathNeverWildcards pins the fail-closed guard: a
// malformed pinned attr carrying an empty Path must never become a cover-everything
// wildcard for its address (an empty parsePinnedPath is a zero-length prefix, and
// hasPrefix treats a zero-length prefix as matching any leaf) — any real change on
// that address must still violate.
func TestCheckRevertInPlaceEmptyPathNeverWildcards(t *testing.T) {
	attrs := []driftpropose.Attr{{Address: "aws_instance.a", Path: ""}}
	plan := planOf(sgChange("aws_instance.a", []string{"update"},
		map[string]any{"instance_type": "m5.large"},
		map[string]any{"instance_type": "m5.xlarge"}))
	got := CheckRevertInPlace(plan, attrs)
	if len(got) == 0 {
		t.Fatal("an empty pinned path silently covered a real change — wildcard escape")
	}
}

// TestCheckRevertInPlaceMultipleTargets: two pinned targets, one converges to
// no-op, the other stays a confined in-place update — both legal simultaneously
// (spec §4.3's alsoDigests never applies to revert, but R8 itself has no reason to
// treat a multi-target pin any differently attribute-by-attribute).
func TestCheckRevertInPlaceMultipleTargets(t *testing.T) {
	attrs := []driftpropose.Attr{
		{Address: "aws_instance.a", Path: "tags.Owner"},
		{Address: "aws_instance.b", Path: "tags.Owner"},
	}
	plan := planOf(
		sgChange("aws_instance.a", []string{"no-op"}, nil, nil),
		sgChange("aws_instance.b", []string{"update"},
			map[string]any{"tags": map[string]any{"Owner": "bi-team"}},
			map[string]any{"tags": map[string]any{"Owner": "platform"}}),
	)
	if got := CheckRevertInPlace(plan, attrs); len(got) != 0 {
		t.Fatalf("violations = %v, want none", got)
	}
}

// TestCheckRevertInPlacePrefersPathSegments pins spec addendum A4/F8's R8
// update: when a pinned attr carries valid pathSegments, R8 covers using THEM
// rather than re-splitting the (lossy) display-path string — a dotted map key
// the legacy string-splitter would mis-parse into 3 dot-parts (and therefore
// cover nothing, mis-scoping the revert) is covered correctly via segments.
func TestCheckRevertInPlacePrefersPathSegments(t *testing.T) {
	attrs := []driftpropose.Attr{
		{Address: "aws_iam_role.app1", Path: "tags.kubernetes.io/role/elb", PathSegments: []any{"tags", "kubernetes.io/role/elb"}},
	}
	plan := planOf(sgChange("aws_iam_role.app1", []string{"update"},
		map[string]any{"tags": map[string]any{"kubernetes.io/role/elb": "owned"}},
		map[string]any{"tags": map[string]any{"kubernetes.io/role/elb": "shared"}}))
	if got := CheckRevertInPlace(plan, attrs); len(got) != 0 {
		t.Fatalf("violations = %v, want none (pathSegments should cover the dotted key)", got)
	}
}

// TestCheckRevertInPlaceFallsBackOnMalformedSegments pins the fail-closed half
// of the same update: a malformed pathSegments value never widens scope — R8
// falls back to the legacy Path-string parse exactly as an absent pathSegments
// would (spec addendum A4: "legacy pins keep today's behavior").
func TestCheckRevertInPlaceFallsBackOnMalformedSegments(t *testing.T) {
	attrs := []driftpropose.Attr{
		{Address: "aws_instance.a", Path: "tags.Owner", PathSegments: []any{}}, // malformed: present but empty
	}
	plan := planOf(sgChange("aws_instance.a", []string{"update"},
		map[string]any{"tags": map[string]any{"Owner": "bi-team"}},
		map[string]any{"tags": map[string]any{"Owner": "platform"}}))
	if got := CheckRevertInPlace(plan, attrs); len(got) != 0 {
		t.Fatalf("violations = %v, want none (legacy Path-string fallback should still cover tags.Owner)", got)
	}
}

// TestCheckRevertInPlaceLegacyAbsentSegmentsUnaffected is
// TestCheckRevertInPlaceFallsBackOnMalformedSegments' twin for the OTHER
// SegKind that must fall back identically: pathSegments simply absent
// (nil, not merely empty) — the ordinary shape every pre-F8 pinned attr has.
func TestCheckRevertInPlaceLegacyAbsentSegmentsUnaffected(t *testing.T) {
	attrs := []driftpropose.Attr{
		{Address: "aws_security_group.sg1", Path: "ingress[0].cidr_blocks"}, // PathSegments: nil
	}
	plan := planOf(sgChange("aws_security_group.sg1", []string{"update"},
		map[string]any{"ingress": []any{map[string]any{"cidr_blocks": []any{"0.0.0.0/0"}}}},
		map[string]any{"ingress": []any{map[string]any{"cidr_blocks": []any{"10.0.0.0/16"}}}}))
	if got := CheckRevertInPlace(plan, attrs); len(got) != 0 {
		t.Fatalf("violations = %v, want none (absent pathSegments must fall back to parsePinnedPath exactly as before F8)", got)
	}
}
