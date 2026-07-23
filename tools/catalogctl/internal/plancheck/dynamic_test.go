package plancheck

import (
	"strings"
	"testing"

	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/manifests"
)

// dynamic_test.go pins the 0013b R6 handshake: checkInterior resolves the op's
// {param:<discriminator>} tokens (manifests.ResolveTarget) BEFORE deriving the
// interior, so the declared interior is concrete — a write to the resolved sibling
// passes, and a write to the WRONG sibling (a buggy/stale resolution) is caught as
// an interior-escape. Without the seam wiring the declared path stays
// "{param:app_type}", never matches the plan tree, and every leaf reads as an escape.

const kgArnOld = "arn:aws:sagemaker:ap-southeast-5:123456789012:studio-lifecycle-config/kg-old"
const kgArnNew = "arn:aws:sagemaker:ap-southeast-5:123456789012:studio-lifecycle-config/kg-new"
const jupArn = "arn:aws:sagemaker:ap-southeast-5:123456789012:studio-lifecycle-config/jupyter-baseline"

// smAttachDynamicOp mirrors the manifests-0013b sagemaker op (PATH discriminator).
func smAttachDynamicOp() manifests.Op {
	op := manifests.Op{ID: "sm-attach", Macd: "Change", CodemodOp: "set_attribute"}
	op.Target.ResourceType = "aws_sagemaker_domain"
	op.Target.Path = []string{"default_user_settings", "{param:app_type}"}
	op.Target.EnsurePath = true
	op.Params = []manifests.Param{
		{Name: "domain", Source: "inventory", Required: true},
		{Name: "app_type", Source: "allowlist", Required: true, Role: "discriminator",
			Bounds:   &manifests.Bounds{Allowlist: []any{"JupyterServer", "KernelGateway"}},
			Segments: map[string]string{"JupyterServer": "jupyter_server_app_settings", "KernelGateway": "kernel_gateway_app_settings"}},
		{Name: "lifecycle_config_arn", Source: "user_input", Required: true, Attr: "lifecycle_config_arns", Wrap: "list"},
	}
	return op
}

// domainState builds a plan before/after node for aws_sagemaker_domain with the two
// app-settings families each carrying a lifecycle_config_arns list.
func domainState(kgArn, jupArn string) map[string]any {
	return map[string]any{
		"default_user_settings": []any{map[string]any{
			"kernel_gateway_app_settings": []any{map[string]any{"lifecycle_config_arns": []any{kgArn}}},
			"jupyter_server_app_settings": []any{map[string]any{"lifecycle_config_arns": []any{jupArn}}},
		}},
	}
}

func TestR6DynamicResolvedInteriorClean(t *testing.T) {
	op := smAttachDynamicOp()
	r := req("sm-attach", map[string]any{
		"domain":               "aws_sagemaker_domain.bird",
		"app_type":             "KernelGateway",
		"lifecycle_config_arn": kgArnNew,
	})
	// Correct resolution: only the kernel_gateway sibling's arn changes.
	plan := Plan{ResourceChanges: []ResourceChange{{
		Address: "aws_sagemaker_domain.bird",
		Change: Change{
			Actions: []string{"update"},
			Before:  domainState(kgArnOld, jupArn),
			After:   domainState(kgArnNew, jupArn),
		},
	}}}
	vs, _ := Check(plan, op, r)
	if len(vs) != 0 {
		t.Fatalf("clean resolved plan produced violations: %v", vs)
	}
}

func TestR6DynamicWrongSiblingCaught(t *testing.T) {
	op := smAttachDynamicOp()
	r := req("sm-attach", map[string]any{
		"domain":               "aws_sagemaker_domain.bird",
		"app_type":             "KernelGateway",
		"lifecycle_config_arn": kgArnNew,
	})
	// Buggy resolution: the write landed in jupyter_server_app_settings, NOT the
	// requested kernel_gateway family. R6b (interior-escape) must fire.
	plan := Plan{ResourceChanges: []ResourceChange{{
		Address: "aws_sagemaker_domain.bird",
		Change: Change{
			Actions: []string{"update"},
			Before:  domainState(kgArnOld, jupArn),
			After:   domainState(kgArnOld, kgArnNew), // jupyter changed, kernel_gateway untouched
		},
	}}}
	vs, _ := Check(plan, op, r)
	if len(vs) == 0 {
		t.Fatalf("wrong-sibling plan passed R6 — the resolved interior was not confined")
	}
	var gotEscape bool
	for _, v := range vs {
		if v.Rule == "interior-escape" {
			gotEscape = true
		}
	}
	if !gotEscape {
		t.Fatalf("violations = %v, want an interior-escape", vs)
	}
}

// TestR6DynamicUnresolvedIsInfo confirms a request value with no segments entry does
// not crash or block plan-check: it degrades to INFO interior-unverifiable.
func TestR6DynamicUnresolvedIsInfo(t *testing.T) {
	op := smAttachDynamicOp()
	op.Params[1].Segments = map[string]string{"JupyterServer": "jupyter_server_app_settings"} // drop KernelGateway
	r := req("sm-attach", map[string]any{
		"domain":               "aws_sagemaker_domain.bird",
		"app_type":             "KernelGateway",
		"lifecycle_config_arn": kgArnNew,
	})
	plan := Plan{ResourceChanges: []ResourceChange{{
		Address: "aws_sagemaker_domain.bird",
		Change: Change{
			Actions: []string{"update"},
			Before:  domainState(kgArnOld, jupArn),
			After:   domainState(kgArnNew, jupArn),
		},
	}}}
	vs, info := Check(plan, op, r)
	if len(vs) != 0 {
		t.Fatalf("unresolved-segment plan produced violations (should be INFO only): %v", vs)
	}
	joined := strings.Join(info, "\n")
	if !strings.Contains(joined, "dynamic target unresolved") || !strings.Contains(joined, "UNRESOLVED_DYNAMIC_SEGMENT") {
		t.Fatalf("info = %v, want an INFO noting the unresolved dynamic target", info)
	}
}
