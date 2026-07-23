package edit

import (
	"testing"

	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/manifests"
)

// dynamic_test.go pins the edit-package half of 0013b M1: the discriminator is never
// treated as a written value (the probe-1/2 structural fix), and selectChild's
// ensurePath create-on-missing obeys the "no selector pending" guard.

// TestDiscriminatorNotAValueProvider pins the structural fix: a role:"discriminator"
// leaves the value-provider set, so valueParam resolves the TRUE value param instead
// of leaking the discriminator (which is what wrote `tunnel_number = 2` before 0013b).
func TestDiscriminatorNotAValueProvider(t *testing.T) {
	disc := manifests.Param{Name: "tunnel_number", Source: "allowlist", Role: "discriminator"}
	if isValueProvider(disc) {
		t.Fatalf("isValueProvider(discriminator) = true, want false")
	}
	op := manifests.Op{ID: "vpn-rotate"}
	op.Params = []manifests.Param{
		{Name: "connection", Source: "inventory"},
		disc,
		{Name: "preshared_key", Source: "user_input", Attr: "tunnel2_preshared_key"},
	}
	vp := valueParam(op)
	if vp == nil || vp.Name != "preshared_key" {
		t.Fatalf("valueParam = %v, want preshared_key (discriminator must be skipped)", vp)
	}
	if got := valueProviders(op); len(got) != 1 || got[0].Name != "preshared_key" {
		t.Fatalf("valueProviders = %v, want [preshared_key]", got)
	}
	if got := nonInvParams(op); len(got) != 1 || got[0].Name != "preshared_key" {
		t.Fatalf("nonInvParams = %v, want [preshared_key]", got)
	}
}

// TestSelectChildEnsureCreatesMissingSingleton: with ensure set and NO selector
// pending, an absent block is created and descended into (0013b ensurePath).
func TestSelectChildEnsureCreatesMissingSingleton(t *testing.T) {
	parent := parentBlock(t, "resource \"aws_sagemaker_domain\" \"x\" {\n  default_user_settings {\n  }\n}\n")
	dus := childrenOfType(parent, "default_user_settings")[0]
	selUsed := false
	got, code, reason := selectChild(dus, "kernel_gateway_app_settings", nil, &selUsed, true, "")
	if code != "" {
		t.Fatalf("ensure create refused %s: %s", code, reason)
	}
	if got == nil || got.Type() != "kernel_gateway_app_settings" {
		t.Fatalf("created block = %v, want kernel_gateway_app_settings", got)
	}
	// The block now exists exactly once under the parent (idempotent on re-descent).
	if n := len(childrenOfType(dus, "kernel_gateway_app_settings")); n != 1 {
		t.Fatalf("after ensure, kernel_gateway count = %d, want 1", n)
	}
}

// TestSelectChildNoEnsureRefusesMissing: without ensure, an absent block is
// PATH_NOT_FOUND — the pre-0013b behavior is preserved for every existing verb.
func TestSelectChildNoEnsureRefusesMissing(t *testing.T) {
	parent := parentBlock(t, "resource \"aws_sagemaker_domain\" \"x\" {\n  default_user_settings {\n  }\n}\n")
	dus := childrenOfType(parent, "default_user_settings")[0]
	selUsed := false
	_, code, _ := selectChild(dus, "kernel_gateway_app_settings", nil, &selUsed, false, "")
	if code != "PATH_NOT_FOUND" {
		t.Fatalf("no-ensure absent block code = %q, want PATH_NOT_FOUND", code)
	}
}

// TestSelectChildEnsureRefusesWhenSelectorPending: ensure must NOT create a level a
// selector is still waiting to key — that level is repeated/ambiguous, so it fails
// closed (PATH_NOT_FOUND) rather than guess which sibling to invent.
func TestSelectChildEnsureRefusesWhenSelectorPending(t *testing.T) {
	parent := parentBlock(t, "resource \"aws_efs_file_system\" \"x\" {\n}\n")
	selUsed := false
	sel := &selector{matchAttr: "transition_to_archive", value: "AFTER_90_DAYS"}
	_, code, _ := selectChild(parent, "lifecycle_policy", sel, &selUsed, true, "")
	if code != "PATH_NOT_FOUND" {
		t.Fatalf("ensure-with-pending-selector code = %q, want PATH_NOT_FOUND (never invent a keyed sibling)", code)
	}
	// The block was NOT created.
	if n := len(childrenOfType(parent, "lifecycle_policy")); n != 0 {
		t.Fatalf("a keyed block was created under ensure; count = %d, want 0", n)
	}
}

// TestSelectChildEnsureStillAmbiguousOnMultiple: ensure only fills a ZERO-child
// level; >1 existing children with no selector is SELECTOR_AMBIGUOUS exactly as today.
func TestSelectChildEnsureStillAmbiguousOnMultiple(t *testing.T) {
	src := "resource \"aws_efs_file_system\" \"x\" {\n  lifecycle_policy {\n    transition_to_ia = \"AFTER_30_DAYS\"\n  }\n\n  lifecycle_policy {\n    transition_to_archive = \"AFTER_90_DAYS\"\n  }\n}\n"
	parent := parentBlock(t, src)
	selUsed := false
	_, code, _ := selectChild(parent, "lifecycle_policy", nil, &selUsed, true, "")
	if code != "SELECTOR_AMBIGUOUS" {
		t.Fatalf("ensure over >1 children code = %q, want SELECTOR_AMBIGUOUS", code)
	}
}
