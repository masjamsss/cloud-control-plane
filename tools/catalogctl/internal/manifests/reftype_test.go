package manifests

import (
	"reflect"
	"testing"
)

// TestParamAllowedRefTypes pins the enumSource type-parse (0031 M2): the SPA picker
// encodes a role:"reference" param's required target type as inventory://<type>/<attr>.
// AllowedRefTypes must extract exactly the <type> segment(s) so value.go can refuse a
// cross-type reference — while returning nil (⇒ existence-only, unchanged) for an
// absent or unparseable enumSource so a reference that never declared a type is never
// newly broken.
func TestParamAllowedRefTypes(t *testing.T) {
	cases := []struct {
		enumSource string
		want       []string
	}{
		// The real shapes in the eight manifests — single type, /address or /arn attr.
		{"inventory://aws_kms_key/arn", []string{"aws_kms_key"}},
		{"inventory://aws_iam_role/arn", []string{"aws_iam_role"}},
		{"inventory://aws_iam_role/address", []string{"aws_iam_role"}},
		{"inventory://aws_s3_bucket/bucket", []string{"aws_s3_bucket"}},
		{"inventory://aws_acm_certificate/address", []string{"aws_acm_certificate"}},
		// Multi-type (none ship today) — allow any of the set (task: "allow any of the set").
		{"inventory://aws_lb_target_group,aws_lb/arn", []string{"aws_lb_target_group", "aws_lb"}},
		{"inventory://aws_a , aws_b/address", []string{"aws_a", "aws_b"}}, // spaces trimmed
		// Absent or unparseable ⇒ nil ⇒ existence-only (pre-M2 behavior preserved).
		{"", nil},
		{"aws_kms_key", nil},             // no scheme
		{"https://aws_kms_key/arn", nil}, // wrong scheme
		{"inventory://", nil},            // no type
		{"inventory:///arn", nil},        // empty type before slash
		{"inventory://aws_kms_key", nil}, // no attr segment ⇒ not the full shape
		{"inventory://,,/arn", nil},      // only empty type tokens
	}
	for _, c := range cases {
		got := Param{EnumSource: c.enumSource}.AllowedRefTypes()
		if !reflect.DeepEqual(got, c.want) {
			t.Errorf("AllowedRefTypes(%q) = %#v, want %#v", c.enumSource, got, c.want)
		}
	}
}
