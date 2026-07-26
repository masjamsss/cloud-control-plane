package idioms

import (
	"reflect"
	"testing"
)

// TestCovidiomsIsTrue pins the `value === true` gate's full input domain: a real
// bool (SPA/JSON request) and the canonical string form (YAML request) are the
// ONLY two shapes that can say "yes"; every other Go type is a hard false so a
// stray param can never conjure a conditional companion block.
func TestCovidiomsIsTrue(t *testing.T) {
	tests := []struct {
		name string
		in   any
		want bool
	}{
		{name: "bool true", in: true, want: true},
		{name: "bool false", in: false, want: false},
		{name: "canonical string true", in: "true", want: true},
		{name: "string false", in: "false", want: false},
		{name: "empty string", in: "", want: false},
		// Only the canonical lower-case spelling counts — the TS gate compares
		// against the canonicalized value, not a case-folded one.
		{name: "uppercase TRUE is not canonical", in: "TRUE", want: false},
		{name: "string yes is not canonical", in: "yes", want: false},
		{name: "nil is not true", in: nil, want: false},
		{name: "int 1 is not true", in: 1, want: false},
		{name: "float 1 is not true", in: 1.0, want: false},
		{name: "slice is not true", in: []any{true}, want: false},
		{name: "map is not true", in: map[string]any{"v": true}, want: false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := isTrue(tt.in); got != tt.want {
				t.Errorf("isTrue(%#v) = %v, want %v", tt.in, got, tt.want)
			}
		})
	}
}

// TestCovidiomsIsEmpty pins the isEmptyValue port: null/""/[] are "not given",
// and anything else — including the falsy-in-JS values 0 and false — IS given.
func TestCovidiomsIsEmpty(t *testing.T) {
	tests := []struct {
		name string
		in   any
		want bool
	}{
		{name: "nil is empty", in: nil, want: true},
		{name: "empty string is empty", in: "", want: true},
		{name: "non-empty string is given", in: "365", want: false},
		{name: "whitespace string is given", in: " ", want: false},
		{name: "empty slice is empty", in: []any{}, want: true},
		{name: "nil slice is empty", in: []any(nil), want: true},
		{name: "non-empty slice is given", in: []any{"rule"}, want: false},
		// 0 and false are NOT empty — only null/""/[] are "not given".
		{name: "zero int is given", in: 0, want: false},
		{name: "bool false is given", in: false, want: false},
		{name: "empty map is given", in: map[string]any{}, want: false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := isEmpty(tt.in); got != tt.want {
				t.Errorf("isEmpty(%#v) = %v, want %v", tt.in, got, tt.want)
			}
		})
	}
}

// TestCovidiomsAddressSetString pins the human-readable R1 reason rendering:
// mandatory first, then conditional, comma-space joined.
func TestCovidiomsAddressSetString(t *testing.T) {
	tests := []struct {
		name string
		set  AddressSet
		want string
	}{
		{name: "empty set renders empty", set: AddressSet{}, want: ""},
		{
			name: "single mandatory",
			set:  AddressSet{Mandatory: []string{"aws_instance.app"}},
			want: "aws_instance.app",
		},
		{
			name: "mandatory before conditional",
			set: AddressSet{
				Mandatory:   []string{"aws_ebs_volume.v"},
				Conditional: []string{"aws_volume_attachment.v"},
			},
			want: "aws_ebs_volume.v, aws_volume_attachment.v",
		},
		{
			name: "conditional only",
			set:  AddressSet{Conditional: []string{"aws_s3_bucket_versioning.b"}},
			want: "aws_s3_bucket_versioning.b",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := tt.set.String(); got != tt.want {
				t.Errorf("AddressSet.String() = %q, want %q", got, tt.want)
			}
		})
	}
	// The rendered reason for a real s3 idiom names every address the guard
	// expects, so an operator reading the refusal sees the whole topology.
	got := Addresses("aws_s3_bucket", "b", map[string]any{"versioning": true, "lifecycle_cleanup_days": 7}).String()
	want := "aws_s3_bucket.b, aws_s3_bucket_public_access_block.b, " +
		"aws_s3_bucket_server_side_encryption_configuration.b, " +
		"aws_s3_bucket_versioning.b, aws_s3_bucket_lifecycle_configuration.b"
	if got != want {
		t.Errorf("s3 idiom String() =\n  %q\nwant\n  %q", got, want)
	}
}

// TestCovidiomsAddressesGateShapes drives the same two gates through the public
// Addresses topology, so the observable contract (which companion blocks the
// verb emits and the plancheck create-guard expects) is what is asserted, not
// just the private helpers.
func TestCovidiomsAddressesGateShapes(t *testing.T) {
	mandatory := []string{
		"aws_s3_bucket.b",
		"aws_s3_bucket_public_access_block.b",
		"aws_s3_bucket_server_side_encryption_configuration.b",
	}
	tests := []struct {
		name   string
		params map[string]any
		want   AddressSet
	}{
		{
			name:   "versioning as canonical YAML string emits the versioning companion",
			params: map[string]any{"versioning": "true"},
			want: AddressSet{
				Mandatory:   mandatory,
				Conditional: []string{"aws_s3_bucket_versioning.b"},
			},
		},
		{
			name:   "versioning string false drops the versioning companion",
			params: map[string]any{"versioning": "false"},
			want:   AddressSet{Mandatory: mandatory},
		},
		{
			name:   "versioning non-canonical string drops the versioning companion",
			params: map[string]any{"versioning": "TRUE"},
			want:   AddressSet{Mandatory: mandatory},
		},
		{
			name:   "empty-string cleanup days is not given",
			params: map[string]any{"lifecycle_cleanup_days": ""},
			want:   AddressSet{Mandatory: mandatory},
		},
		{
			name:   "empty-slice cleanup days is not given",
			params: map[string]any{"lifecycle_cleanup_days": []any{}},
			want:   AddressSet{Mandatory: mandatory},
		},
		{
			name:   "non-empty-slice cleanup days emits the lifecycle companion",
			params: map[string]any{"lifecycle_cleanup_days": []any{30}},
			want: AddressSet{
				Mandatory:   mandatory,
				Conditional: []string{"aws_s3_bucket_lifecycle_configuration.b"},
			},
		},
		{
			name:   "cleanup days as string emits the lifecycle companion",
			params: map[string]any{"lifecycle_cleanup_days": "90"},
			want: AddressSet{
				Mandatory:   mandatory,
				Conditional: []string{"aws_s3_bucket_lifecycle_configuration.b"},
			},
		},
		{
			name:   "explicit nil cleanup days is not given",
			params: map[string]any{"lifecycle_cleanup_days": nil},
			want:   AddressSet{Mandatory: mandatory},
		},
		{
			// 0 is a real, given value (isEmptyValue is not JS falsiness), so the
			// lifecycle companion IS part of the topology.
			name:   "zero cleanup days is still given",
			params: map[string]any{"lifecycle_cleanup_days": 0},
			want: AddressSet{
				Mandatory:   mandatory,
				Conditional: []string{"aws_s3_bucket_lifecycle_configuration.b"},
			},
		},
		{
			name:   "nil params map yields mandatory-only topology",
			params: nil,
			want:   AddressSet{Mandatory: mandatory},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := Addresses("aws_s3_bucket", "b", tt.params)
			if !reflect.DeepEqual(got, tt.want) {
				t.Errorf("Addresses(aws_s3_bucket, b, %#v) =\n  %+v\nwant\n  %+v", tt.params, got, tt.want)
			}
			// Every address the idiom may create must be a member of the set —
			// that is the R1 predicate both locks share.
			for _, a := range tt.want.All() {
				if !got.Contains(a) {
					t.Errorf("Contains(%q) = false, want true", a)
				}
			}
			if got.Contains("aws_s3_bucket.other") {
				t.Error(`Contains("aws_s3_bucket.other") = true, want false`)
			}
		})
	}
}
