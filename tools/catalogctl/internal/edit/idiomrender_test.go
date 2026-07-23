package edit

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/manifests"
)

// idiomrender_test.go is the toolchain-independent backstop for the 0036 T2 render
// port (idiomrender.go): it drives renderCreateSkeleton with the SAME manifest ops
// and the SAME baseline values the TS golden test uses (baselineSkeletons.test.ts)
// and asserts byte-equality with the banner-stripped golden. Together with the live
// TS↔Go parity harness (createResourceParity.test.ts, T4) this proves
// Go-render == TS-render == golden.

const (
	realManifestsDir = "../../../../ccp/app/src/data/manifests"
	baselineGoldnDir = "../../../../ccp/app/src/test/fixtures/skeletons/baselines"
)

// baselineValues mirrors app/.../baselines/values.ts (BASELINE_VALUES + variants).
// Numbers are Go ints (as a YAML request decodes them); lists are []any.
var baselineValues = map[string]map[string]any{
	"ec2-provision-instance": {
		"host_name": "app-02", "instance_type": "m5.xlarge", "ami": "engineer-decides",
		"key_pair": "aws_key_pair.admin_ops", "subnet": "aws_subnet.backup",
		"security_groups": []any{"aws_security_group.access_to_app01", "aws_security_group.allinternal_to_backupproxy"},
		"private_ip":      "", "iam_instance_profile": "ssm-instance-profile", "root_volume_gib": 200,
		"root_volume_type": "gp3", "resource_name": "APP-02",
		"description_tag": "Application server for the cluster", "pic": "Ops team",
	},
	"ebs-create-volume": {
		"volume_name": "APP01 sdd", "attach_to": "aws_instance.bastion", "device_name": "/dev/sdd",
		"size_gib": 500, "volume_type": "gp3", "iops": 3000, "throughput_mibps": 125,
		"kms_key": "", "snapshot": "", "description_tag": "Data volume", "pic": "Ops team",
	},
	"s3-create-bucket": {
		"bucket_name": "finance-interface", "versioning": true, "encryption": "aws:kms",
		"kms_key": "aws_kms_key.shared_cmk", "lifecycle_cleanup_days": 365,
		"resource_name": "finance-interface", "description_tag": "Finance interface drop bucket", "pic": "Ops team",
	},
	"s3-create-lifecycle-setup": {
		"bucket": "aws_s3_bucket.alarm_ticket_table", "rule_id": "expire-old-logs", "prefix": "logs/",
		"transition_days": 90, "storage_class": "GLACIER_IR", "expiration_days": 365,
	},
	"s3-start-versioning-setup": {
		"bucket": "aws_s3_bucket.alarm_ticket_table",
	},
	"sg-create-security-group": {
		"group_name": "cache-tier", "description": "Allows the app tier to reach the new cache tier",
		"vpc": "aws_vpc.prod_sample", "first_rule_protocol": "tcp", "first_rule_from_port": 8443,
		"first_rule_to_port": 8443, "first_rule_cidr": "10.0.0.0/16", "resource_name": "cache-tier",
		"description_tag": "Cache tier traffic policy", "pic": "Ops team",
	},
	"alb-add-target-group": {
		"tg_name": "api-v2-blue", "protocol": "HTTPS", "port": 443, "vpc": "aws_vpc.prod_sample",
		"target_type": "instance", "health_path": "/health", "healthy_threshold": 3, "unhealthy_threshold": 3,
		"interval_seconds": 30, "matcher": "200-399", "deregistration_delay": 300, "resource_name": "api-v2-blue",
		"description_tag": "Blue target group for the api-v2 cutover", "pic": "Ops team",
	},
	"efs-create-filesystem": {
		"share_name": "interface-share", "performance_mode": "generalPurpose", "throughput_mode": "bursting",
		"enable_backups": true, "lifecycle_to_ia": "AFTER_30_DAYS", "kms_key": "", "resource_name": "interface-share",
		"description_tag": "Shared interface file share", "pic": "Ops team",
	},
	"rds-provision-instance": {
		"db_name": "app-reporting", "engine": "postgres", "engine_version": "", "instance_class": "db.t3.xlarge",
		"allocated_storage_gib": 52, "storage_type": "gp3", "multi_az": true, "backup_retention_days": 7,
		"backup_window": "", "subnet_group": "aws_db_subnet_group.app_db",
		"security_groups": []any{"aws_security_group.access_to_app01"}, "resource_name": "app-reporting",
		"description_tag": "Reporting database for the app workload", "pic": "Ops team",
	},
	"backup-create-vault": {
		"vault_name": "daily", "kms_key": "", "resource_name": "daily",
		"description_tag": "Daily recovery points", "pic": "Ops team",
	},
	"backup-create-plan": {
		"plan_name": "standard", "rule_name": "daily", "vault": "aws_backup_vault.erp_daily",
		"schedule": "cron(0 17 ? * * *)", "retention_days": 35, "start_window_minutes": 60,
		"completion_window_minutes": 180, "continuous_backup": false, "resource_name": "standard",
		"description_tag": "Standard daily backup plan", "pic": "Ops team",
	},
	"vpn-add-static-route": {
		"vpn_connection": "aws_vpn_connection.prod_onprem_dc1", "destination_cidr": "10.2.0.0/16",
	},
	"sns-create-topic": {
		"topic_name": "oncall-alerts", "display_name": "On-call", "kms_key": "",
		"resource_name": "oncall-alerts", "description_tag": "On-call notifications", "pic": "Ops team",
	},
	"lambda-create-function": {
		"function_name": "ticket-webhook", "runtime": "python3.12", "handler": "", "memory_mb": 512,
		"timeout_seconds": 60, "inside_vpc": true, "subnets": []any{"aws_subnet.backup"},
		"security_groups": []any{"aws_security_group.access_to_app01"}, "resource_name": "ticket-webhook",
		"description_tag": "Posts alarm tickets to the service desk", "pic": "Ops team",
	},
}

// baselineVariants mirrors BASELINE_VARIANTS in values.ts.
func baselineVariants() map[string]map[string]any {
	clone := func(base map[string]any, over map[string]any) map[string]any {
		out := map[string]any{}
		for k, v := range base {
			out[k] = v
		}
		for k, v := range over {
			out[k] = v
		}
		return out
	}
	return map[string]map[string]any{
		"sg-create-security-group--no-rule": clone(baselineValues["sg-create-security-group"], map[string]any{"first_rule_protocol": "none"}),
		"efs-create-filesystem--no-backup":  clone(baselineValues["efs-create-filesystem"], map[string]any{"enable_backups": false, "lifecycle_to_ia": "never"}),
		"lambda-create-function--no-vpc":    clone(baselineValues["lambda-create-function"], map[string]any{"inside_vpc": false}),
	}
}

// stripDraftBanner removes hclSkeleton.ts's two-line DRAFT banner (and its trailing
// blank line) from a golden, plus a single trailing newline — leaving exactly the
// bytes the create verb authors (0036 §5.2).
func stripDraftBanner(golden string) string {
	golden = strings.TrimRight(golden, "\n")
	lines := strings.Split(golden, "\n")
	if len(lines) >= 2 && strings.HasPrefix(lines[0], "# DRAFT") && strings.Contains(lines[1], "NOT applied by any pipeline") {
		lines = lines[2:]
		if len(lines) > 0 && lines[0] == "" {
			lines = lines[1:]
		}
	}
	return strings.Join(lines, "\n")
}

func loadRealOpsOrSkip(t *testing.T) map[string]manifests.Op {
	t.Helper()
	if _, err := os.Stat(realManifestsDir); err != nil {
		t.Skipf("real manifest catalog not present at %s — skipping", realManifestsDir)
	}
	ops, err := manifests.LoadDir(realManifestsDir)
	if err != nil {
		t.Fatalf("LoadDir(%s): %v", realManifestsDir, err)
	}
	return ops
}

func goldenBaseline(t *testing.T, name string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(baselineGoldnDir, name+".golden.tf"))
	if err != nil {
		t.Fatalf("read golden %s: %v", name, err)
	}
	return string(b)
}

func TestRenderCreateSkeleton_BaselineParity(t *testing.T) {
	ops := loadRealOpsOrSkip(t)

	check := func(t *testing.T, goldenName, opID string, values map[string]any) {
		op, ok := ops[opID]
		if !ok {
			t.Fatalf("op %q not in catalog", opID)
		}
		got, _, _ := renderCreateSkeleton(op, values)
		want := stripDraftBanner(goldenBaseline(t, goldenName))
		if got != want {
			t.Errorf("render mismatch for %s\n--- got ---\n%s\n--- want ---\n%s", goldenName, got, want)
		}
	}

	for id, values := range baselineValues {
		t.Run(id, func(t *testing.T) { check(t, id, id, values) })
	}
	for name, values := range baselineVariants() {
		baseID := strings.Split(name, "--")[0]
		t.Run(name, func(t *testing.T) { check(t, name, baseID, values) })
	}
}
