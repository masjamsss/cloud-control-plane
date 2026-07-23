package main_test

// manifest_lint_test.go is the CI-red wiring for proposal 0028's manifest lints
// (backlog #1 prose-attr demotion, #5 arity/positional asserts) against the REAL
// production catalog — the same ccp/app/src/data/manifests the executor runs on
// in .github/workflows/ccp-apply.yml. Detection lives in internal/manifests
// (pure, unit-tested); the RATCHET POLICY lives here.
//
// Two gates, each "visible now, red on regression":
//   - prose-attr: the core L1 services (EC2/EBS/RDS/S3/EFS/Backup/SG/ALB) must carry
//     an explicit target.attr on every flat set_attribute op — zero may resolve their
//     write target from the free-text terraformCapability prose (the retired D1
//     hazard). Non-core prose ops are reported as tracked debt (the full 324-op
//     migration is an explicit follow-up), not failed.
//   - arity: the pre-existing param-shape gaps (the census's ERROR-bucket ops +
//     positionally-fragile 2-locator ops) are grandfathered in arityBaseline; any NEW
//     arity finding fails the gate.
//
// Plus a parity gate proving every migrated target.attr resolves to the SAME
// attribute the prose/param fallback did (the non-negotiable: explicit == prose).

import (
	"os"
	"testing"

	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/manifests"
)

// realManifestsDir is the production catalog (relative to tools/catalogctl, the test
// CWD). Skipped when absent so `go test` still works in a standalone catalogctl
// checkout; in CI (gate.sh runs from the repo root) the app tree is always present.
const realManifestsDir = "../../ccp/app/src/data/manifests"

// coreServices are the L1-driven services whose flat set_attribute ops this change
// migrates to explicit target.attr. They are held to ZERO prose dependence.
var coreServices = map[string]bool{
	"ec2": true, "ebs": true, "rds": true, "s3": true,
	"efs": true, "backup": true, "security-groups": true, "alb": true,
}

// arityBaseline grandfathers the pre-existing param-shape findings (0028 #5) that this
// change SURFACES but deliberately does NOT fix (surface-don't-fix): the census's
// ERROR-bucket ops (a set_attribute with no value provider, a mis-shaped foreach) and
// positionally-fragile ops carrying two inventory locators (edit.targetAddress binds
// the first, so they rely on param order). Key = "<rule>\t<opID>". Do NOT grow this
// list to silence a new op — fix the op's param shape (tag the selector/reference, add
// the value/const param) so the finding clears. A stale entry (baselined but no longer
// firing) is harmless.
var arityBaseline = map[string]bool{
	"target-arity\tacm-attach-sni-certificate":                        true,
	"target-arity\tacm-lb-listener-set-forward-target-group-weight":   true,
	"target-arity\talb-add-listener-rule":                             true,
	"target-arity\talb-set-listener-rule-forward-target-group-weight": true,
	"no-value-provider\tbackup-change-selection-plan":                 true,
	"target-arity\tbackup-change-selection-plan":                      true,
	"foreach-arity\tefs-add-mount-target":                             true,
	"target-arity\tefs-add-mount-target":                              true,
	"no-value-provider\tefs-disable-backup-policy":                    true,
	"no-value-provider\tefs-enable-backup-policy":                     true,
	"no-value-provider\tefs-mt-add-security-group":                    true,
	"target-arity\tefs-mt-add-security-group":                         true,
	"no-value-provider\tefs-mt-remove-security-group":                 true,
	"target-arity\tefs-mt-remove-security-group":                      true,
	// efs-mt-update-security-groups + rds-change-subnet-group-subnets FIXED (0036):
	// their type:"list" value param now carries role:"reference"+refAttr, so it is a
	// value provider AND no longer a bare inventory locator — both the no-value-provider
	// and target-arity findings clear, so their baseline entries are removed (not stale).
	"target-arity\teventbridge-set-target-dead-letter-queue":                     true,
	"no-value-provider\tiam-move-role-policy":                                    true,
	"target-arity\tiam-move-role-policy":                                         true,
	"no-value-provider\tlicensemanager-change-association-license-configuration": true,
	"target-arity\tlicensemanager-change-association-license-configuration":      true,
	"no-value-provider\trds-snapshot-make-private":                               true,
	"target-arity\troute53-zone-associate-vpc":                                   true,
	"no-value-provider\troute53-zone-change-delegation-set":                      true,
	"target-arity\troute53-zone-change-delegation-set":                           true,
	"target-arity\trouting-move-subnet-association":                              true,
	"target-arity\ts3-set-abort-incomplete-multipart-upload-days":                true,
	"target-arity\ts3-set-expiration-date":                                       true,
	"target-arity\ts3-set-expired-object-delete-marker":                          true,
	"target-arity\ts3-set-noncurrent-version-expiration":                         true,
	"target-arity\ts3-set-noncurrent-version-transition":                         true,
	"target-arity\ts3-set-transition-date":                                       true,
	"target-arity\tsecurity-groups-add-egress-rule-to-security-group":            true,
	"target-arity\tsecurity-groups-add-ingress-rule-from-security-group":         true,
	"foreach-arity\twaf-add-ip-set-entry":                                        true,
}

func loadRealCatalogOrSkip(t *testing.T) map[string]manifests.Op {
	t.Helper()
	if _, err := os.Stat(realManifestsDir); err != nil {
		t.Skipf("real manifest catalog not present at %s (standalone checkout) — skipping", realManifestsDir)
	}
	ops, err := manifests.LoadDir(realManifestsDir)
	if err != nil {
		// A strict-decode failure here (DisallowUnknownFields) means the real catalog
		// carries a field the Go structs do not model — the same failure that would
		// break ccp-apply.yml. Surface it loudly.
		t.Fatalf("LoadDir(%s) failed (strict decode?): %v", realManifestsDir, err)
	}
	return ops
}

// TestManifestLint_ProseAttrCoreGate — the demotion gate (0028 #1). Core services must
// be fully migrated (zero prose-dependent set_attribute ops); non-core prose ops are
// reported as tracked follow-up debt but do not fail.
func TestManifestLint_ProseAttrCoreGate(t *testing.T) {
	ops := loadRealCatalogOrSkip(t)
	var core, nonCore []manifests.Finding
	for _, f := range manifests.Lint(ops) {
		if f.Rule != manifests.RuleProseAttr {
			continue
		}
		if coreServices[f.Service] {
			core = append(core, f)
		} else {
			nonCore = append(nonCore, f)
		}
	}
	// Visible-now: the tracked debt (full 324-op migration is an explicit follow-up).
	t.Logf("prose-attr tracked debt: %d non-core set_attribute ops still resolve their "+
		"write target from prose (migrate to target.attr as follow-up)", len(nonCore))
	// Red: a core-service op resolving its write target from prose is the retired
	// hazard — it must declare target.attr.
	for _, f := range core {
		t.Errorf("core service %q op %q still resolves its write attribute from prose — "+
			"declare target.attr: %s", f.Service, f.OpID, f.Detail)
	}
}

// TestManifestLint_ArityRatchet — the arity gate (0028 #5). Fails on any param-shape
// finding not already grandfathered in arityBaseline.
func TestManifestLint_ArityRatchet(t *testing.T) {
	ops := loadRealCatalogOrSkip(t)
	tracked := 0
	for _, f := range manifests.Lint(ops) {
		if f.Rule == manifests.RuleProseAttr {
			continue
		}
		if arityBaseline[f.Rule+"\t"+f.OpID] {
			tracked++
			continue
		}
		t.Errorf("NEW arity finding — fix the op's param shape (do not add to arityBaseline): %s", f)
	}
	t.Logf("arity: %d grandfathered param-shape findings tracked (census ERROR bucket + "+
		"positional fragility)", tracked)
}

// TestMigratedAttrParity — the non-negotiable parity proof: every op that carries an
// explicit target.attr must resolve to the SAME attribute the retired prose/param
// fallback did. A discrepancy is a PRE-EXISTING wrong-attr bug the migration surfaced
// (0028: surface, do not silently "fix" the output) — it fails loudly here.
func TestMigratedAttrParity(t *testing.T) {
	ops := loadRealCatalogOrSkip(t)
	migrated := 0
	for _, op := range ops {
		if op.Target.Attr == "" {
			continue
		}
		migrated++
		if fb := fallbackAttr(op); op.Target.Attr != fb {
			t.Errorf("PARITY: op %q target.attr=%q but prose/param fallback resolves %q — "+
				"explicit != prose (a surfaced pre-existing bug; do not fix silently)",
				op.ID, op.Target.Attr, fb)
		}
	}
	if migrated == 0 && !testing.Short() {
		t.Error("expected migrated ops (target.attr set) in the real catalog, found none")
	}
	t.Logf("parity verified for %d migrated ops (target.attr == prose/param fallback)", migrated)
}

// fallbackAttr reconstructs edit.attrName's resolution with target.attr EMPTY — the
// prose paren token (manifests.ProseAttrToken) else manifests.AttrFor on the first
// value provider. It is the exact rule a migrated op's target.attr must equal.
func fallbackAttr(op manifests.Op) string {
	if tok := manifests.ProseAttrToken(op.TerraformCapability); tok != "" {
		return tok
	}
	for _, p := range op.Params {
		if manifests.IsValueProvider(p) {
			return manifests.AttrFor(op, p)
		}
	}
	return ""
}
