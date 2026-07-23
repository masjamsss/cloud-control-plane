package idioms

import (
	"reflect"
	"testing"
)

// TestTfLocalName mirrors hclSkeleton.test.ts's tfLocalName cases byte-for-byte —
// the Go port must agree with the TS renderer or the block LABELS diverge.
func TestTfLocalName(t *testing.T) {
	cases := map[string]any{
		"app01_sdd":                "APP01 sdd",
		"sample_finance_interface": "sample-finance-interface",
		"weird_name":               "  weird---name!! ",
		"r_42east":                 "42east",
	}
	for want, in := range cases {
		if got := TfLocalName(in); got != want {
			t.Errorf("TfLocalName(%q) = %q, want %q", in, got, want)
		}
	}
	// Empty and nil both fall back to the safe placeholder.
	if got := TfLocalName(""); got != "new_resource" {
		t.Errorf(`TfLocalName("") = %q, want new_resource`, got)
	}
	if got := TfLocalName(nil); got != "new_resource" {
		t.Errorf("TfLocalName(nil) = %q, want new_resource", got)
	}
}

func TestIsAddressShaped(t *testing.T) {
	yes := []any{
		"aws_subnet.app_a", "aws_instance.bastion", "aws_kms_key.shared_cmk",
		// 0039 S1 lane B: azurerm_* is a recognized provider prefix too.
		"azurerm_resource_group.main", "azurerm_storage_account.appdata001",
	}
	no := []any{"", "not-an-address", "aws_subnet", "azurerm_", `evil; } resource "x" "y" {`, 42, nil}
	for _, v := range yes {
		if !IsAddressShaped(v) {
			t.Errorf("IsAddressShaped(%v) = false, want true", v)
		}
	}
	for _, v := range no {
		if IsAddressShaped(v) {
			t.Errorf("IsAddressShaped(%v) = true, want false", v)
		}
	}
}

func TestAddresses(t *testing.T) {
	tests := []struct {
		name   string
		rt     string
		local  string
		params map[string]any
		want   AddressSet
	}{
		{
			name: "aws_instance single block",
			rt:   "aws_instance", local: "erp_app_02", params: map[string]any{},
			want: AddressSet{Mandatory: []string{"aws_instance.erp_app_02"}},
		},
		{
			name: "aws_ebs_volume attached emits the attachment companion",
			rt:   "aws_ebs_volume", local: "app01_sdd", params: map[string]any{"attach_to": "aws_instance.bastion"},
			want: AddressSet{
				Mandatory:   []string{"aws_ebs_volume.app01_sdd"},
				Conditional: []string{"aws_volume_attachment.app01_sdd"},
			},
		},
		{
			name: "aws_ebs_volume unattached is single block",
			rt:   "aws_ebs_volume", local: "v", params: map[string]any{"attach_to": ""},
			want: AddressSet{Mandatory: []string{"aws_ebs_volume.v"}},
		},
		{
			name: "aws_s3_bucket mandatory pab+sse, both conditionals",
			rt:   "aws_s3_bucket", local: "b", params: map[string]any{"versioning": true, "lifecycle_cleanup_days": 365},
			want: AddressSet{
				Mandatory: []string{
					"aws_s3_bucket.b",
					"aws_s3_bucket_public_access_block.b",
					"aws_s3_bucket_server_side_encryption_configuration.b",
				},
				Conditional: []string{
					"aws_s3_bucket_versioning.b",
					"aws_s3_bucket_lifecycle_configuration.b",
				},
			},
		},
		{
			name: "aws_s3_bucket versioning off + no cleanup drops both conditionals",
			rt:   "aws_s3_bucket", local: "b", params: map[string]any{"versioning": false},
			want: AddressSet{Mandatory: []string{
				"aws_s3_bucket.b",
				"aws_s3_bucket_public_access_block.b",
				"aws_s3_bucket_server_side_encryption_configuration.b",
			}},
		},
		{
			// 0036 §5.3 — EFS is SINGLE-block after the reconciliation: NO
			// aws_efs_backup_policy companion, regardless of enable_backups.
			name: "aws_efs_file_system is single block (no backup-policy companion)",
			rt:   "aws_efs_file_system", local: "s", params: map[string]any{"enable_backups": true},
			want: AddressSet{Mandatory: []string{"aws_efs_file_system.s"}},
		},
		{
			name: "unknown/default renders one block",
			rt:   "aws_sns_topic", local: "t", params: map[string]any{},
			want: AddressSet{Mandatory: []string{"aws_sns_topic.t"}},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := Addresses(tt.rt, tt.local, tt.params)
			if !reflect.DeepEqual(got, tt.want) {
				t.Errorf("Addresses(%q,%q,…) =\n  %+v\nwant\n  %+v", tt.rt, tt.local, got, tt.want)
			}
		})
	}
}
