package manifests

import (
	"strings"
	"testing"
)

const manifestsDir = "../../testdata/manifests"

func TestLoadDirFindsEC2Resize(t *testing.T) {
	ops, err := LoadDir(manifestsDir)
	if err != nil {
		t.Fatalf("LoadDir err = %v", err)
	}
	op, ok := ops["ec2-resize"]
	if !ok {
		t.Fatalf("ec2-resize op not found")
	}
	if op.CodemodOp != "set_attribute" {
		t.Fatalf("CodemodOp = %q, want set_attribute", op.CodemodOp)
	}
	var p *Param
	for i := range op.Params {
		if op.Params[i].Name == "new_instance_type" {
			p = &op.Params[i]
		}
	}
	if p == nil {
		t.Fatalf("new_instance_type param not found")
	}
	if p.Bounds == nil || len(p.Bounds.Allowlist) != 7 {
		t.Fatalf("allowlist len = %v, want 7", p.Bounds)
	}
}

func TestValidateAllowlist(t *testing.T) {
	ops, err := LoadDir(manifestsDir)
	if err != nil {
		t.Fatal(err)
	}
	op := ops["ec2-resize"]

	code, _ := Validate(op, map[string]any{"instance": "aws_instance.foo", "new_instance_type": "x9.mega"})
	if code != "OUT_OF_BOUNDS" {
		t.Fatalf("off-allowlist code = %q, want OUT_OF_BOUNDS", code)
	}

	code, reason := Validate(op, map[string]any{"instance": "aws_instance.foo", "new_instance_type": "r6i.large"})
	if code != "" {
		t.Fatalf("on-allowlist code = %q reason = %q, want clean", code, reason)
	}
}

// TestValidateListAllowlistPerElement pins the fix for the whole-list-vs-element
// bug: a list-typed param's allowlist bound constrains each ELEMENT, so a list of
// allowed elements passes and a single off-allowlist element fails. (Real ops:
// autoscaling-suspend-processes, dlm-set-resource-types, cloudtrail-set-excluded-
// management-event-sources.)
func TestValidateListAllowlistPerElement(t *testing.T) {
	op := Op{Params: []Param{{
		Name:   "resource_types",
		Type:   "array",
		Source: "user_input",
		Bounds: &Bounds{Allowlist: []any{"a", "b", "c"}},
	}}}
	if code, reason := Validate(op, map[string]any{"resource_types": []any{"a", "c"}}); code != "" {
		t.Fatalf("all-allowed list code = %q reason = %q, want clean", code, reason)
	}
	if code, _ := Validate(op, map[string]any{"resource_types": []any{"a", "z"}}); code != "OUT_OF_BOUNDS" {
		t.Fatalf("off-allowlist element code = %q, want OUT_OF_BOUNDS", code)
	}
	// A scalar param is unchanged: whole-value comparison still applies.
	scalar := Op{Params: []Param{{Name: "x", Type: "string", Source: "user_input", Bounds: &Bounds{Allowlist: []any{"a", "b"}}}}}
	if code, _ := Validate(scalar, map[string]any{"x": "a"}); code != "" {
		t.Fatalf("scalar on-allowlist code = %q, want clean", code)
	}
	if code, _ := Validate(scalar, map[string]any{"x": "z"}); code != "OUT_OF_BOUNDS" {
		t.Fatalf("scalar off-allowlist code = %q, want OUT_OF_BOUNDS", code)
	}
}

// TestValidateListPatternPerElement pins the same per-element fix for pattern
// bounds: each element must match, and one non-matching element fails.
func TestValidateListPatternPerElement(t *testing.T) {
	op := Op{Params: []Param{{
		Name:   "sources",
		Type:   "array",
		Source: "user_input",
		Bounds: &Bounds{Pattern: "^[a-z]+$"},
	}}}
	if code, reason := Validate(op, map[string]any{"sources": []any{"kms", "config"}}); code != "" {
		t.Fatalf("all-matching list code = %q reason = %q, want clean", code, reason)
	}
	if code, _ := Validate(op, map[string]any{"sources": []any{"kms", "Bad1"}}); code != "OUT_OF_BOUNDS" {
		t.Fatalf("one non-matching element code = %q, want OUT_OF_BOUNDS", code)
	}
}

// TestValidateMapBoundsCheckKeysAndValues pins the fix for 0015 §B1 (0014 §4 F2/F3):
// a map-typed param's pattern/allowlist bound must constrain each KEY and each VALUE,
// not the map's Go repr. Pre-fix elementsOf collapsed a map to ONE element — its
// fmt.Sprint form `map[k:v …]` — so a param's bound never saw the keys and a crafted
// key carrying the confirmed HCL-injection alphabet ("/=/space/newline) bypassed
// validation entirely. Post-fix a clean tag map passes; a dirty KEY or VALUE is
// refused OUT_OF_BOUNDS. Scalar/list behavior is unchanged (covered above).
func TestValidateMapBoundsCheckKeysAndValues(t *testing.T) {
	// A tag op bounding keys AND values to a tight identifier-ish pattern.
	op := Op{Params: []Param{{
		Name:   "tags",
		Type:   "map",
		Source: "user_input",
		Bounds: &Bounds{Pattern: `^[A-Za-z][A-Za-z0-9_-]{1,64}$`},
	}}}

	// Clean keys AND values pass (pre-fix this was wrongly refused wholesale).
	if code, reason := Validate(op, map[string]any{"tags": map[string]any{"Owner": "platform-team", "Env": "prod"}}); code != "" {
		t.Fatalf("clean tag map code = %q reason = %q, want clean", code, reason)
	}

	// A KEY carrying an injection byte is refused, one alphabet member at a time.
	for _, badKey := range []string{`a"b`, `a=b`, `a b`, "a\nb"} {
		params := map[string]any{"tags": map[string]any{badKey: "prod"}}
		if code, _ := Validate(op, params); code != "OUT_OF_BOUNDS" {
			t.Fatalf("bad key %q code = %q, want OUT_OF_BOUNDS", badKey, code)
		}
	}

	// A dirty VALUE is refused too — keys AND values are both bound.
	if code, _ := Validate(op, map[string]any{"tags": map[string]any{"Owner": `a"=b`}}); code != "OUT_OF_BOUNDS" {
		t.Fatalf("dirty value code = %q, want OUT_OF_BOUNDS", code)
	}

	// An allowlist on a map param constrains keys+values symmetrically.
	al := Op{Params: []Param{{Name: "tags", Type: "map", Source: "user_input",
		Bounds: &Bounds{Allowlist: []any{"Env", "prod"}}}}}
	if code, reason := Validate(al, map[string]any{"tags": map[string]any{"Env": "prod"}}); code != "" {
		t.Fatalf("allowlisted key+value code = %q reason = %q, want clean", code, reason)
	}
	if code, _ := Validate(al, map[string]any{"tags": map[string]any{"Env": "staging"}}); code != "OUT_OF_BOUNDS" {
		t.Fatalf("off-allowlist value code = %q, want OUT_OF_BOUNDS", code)
	}
}

// TestValidateStringBoundsAreLength pins the fix for min/max on a STRING-typed
// param being read as numeric value comparisons: they are LENGTH constraints, so
// a mid-length string is accepted and too-short / too-long strings are rejected.
// Numeric params keep magnitude semantics. (Real ops: secretsmanager-edit-
// description, sns-set-display-name.)
func TestValidateStringBoundsAreLength(t *testing.T) {
	min1, max256 := 1.0, 256.0
	op := Op{Params: []Param{{
		Name:   "description",
		Type:   "string",
		Source: "user_input",
		Bounds: &Bounds{Min: &min1, Max: &max256},
	}}}
	if code, reason := Validate(op, map[string]any{"description": "hello"}); code != "" {
		t.Fatalf("len-5 string code = %q reason = %q, want clean", code, reason)
	}
	if code, _ := Validate(op, map[string]any{"description": ""}); code != "OUT_OF_BOUNDS" {
		t.Fatalf("empty (len 0 < min 1) code = %q, want OUT_OF_BOUNDS", code)
	}
	if code, _ := Validate(op, map[string]any{"description": strings.Repeat("x", 300)}); code != "OUT_OF_BOUNDS" {
		t.Fatalf("300-char (> max 256) code = %q, want OUT_OF_BOUNDS", code)
	}

	// A numeric param keeps magnitude semantics: min/max bound the VALUE, not len.
	nmin, nmax := 1.0, 256.0
	num := Op{Params: []Param{{Name: "n", Type: "number", Source: "user_input", Bounds: &Bounds{Min: &nmin, Max: &nmax}}}}
	if code, _ := Validate(num, map[string]any{"n": 42}); code != "" {
		t.Fatalf("numeric in-range code = %q, want clean", code)
	}
	if code, _ := Validate(num, map[string]any{"n": 999}); code != "OUT_OF_BOUNDS" {
		t.Fatalf("numeric over-max code = %q, want OUT_OF_BOUNDS", code)
	}
}

func TestValidateNumericBounds(t *testing.T) {
	ops, err := LoadDir(manifestsDir)
	if err != nil {
		t.Fatal(err)
	}
	op := ops["ebs-grow"]
	// max is 16384; 999999 exceeds it.
	if code, _ := Validate(op, map[string]any{"volume": "aws_ebs_volume.foo", "new_size_gib": 999999}); code != "OUT_OF_BOUNDS" {
		t.Fatalf("over-max code = %q, want OUT_OF_BOUNDS", code)
	}
	if code, _ := Validate(op, map[string]any{"volume": "aws_ebs_volume.foo", "new_size_gib": 40}); code != "" {
		t.Fatalf("in-bounds code = %q, want clean", code)
	}
}

// ── 0013b M0: ResolveTarget (dynamic target resolution) ────────────────────────

// smAttachOp builds the sagemaker shape-A op: a PATH segment resolved from an
// app_type discriminator's segments map.
func smAttachOp() Op {
	op := Op{ID: "sm-attach", CodemodOp: "set_attribute"}
	op.Target.ResourceType = "aws_sagemaker_domain"
	op.Target.Path = []string{"default_user_settings", "{param:app_type}"}
	op.Target.EnsurePath = true
	op.Params = []Param{
		{Name: "domain", Source: "inventory", Required: true},
		{Name: "app_type", Source: "allowlist", Required: true, Role: "discriminator",
			Bounds:   &Bounds{Allowlist: []any{"JupyterServer", "KernelGateway"}},
			Segments: map[string]string{"JupyterServer": "jupyter_server_app_settings", "KernelGateway": "kernel_gateway_app_settings"}},
		{Name: "lifecycle_config_arn", Source: "user_input", Required: true, Attr: "lifecycle_config_arns", Wrap: "list"},
	}
	return op
}

// vpnRotateOp builds the vpn shape-A op: a value param's ATTR resolved from a
// numeric tunnel_number discriminator's segments map.
func vpnRotateOp() Op {
	op := Op{ID: "vpn-rotate", CodemodOp: "set_attribute"}
	op.Target.ResourceType = "aws_vpn_connection"
	op.Params = []Param{
		{Name: "connection", Source: "inventory", Required: true},
		{Name: "tunnel_number", Type: "number", Source: "allowlist", Required: true, Role: "discriminator",
			Bounds:   &Bounds{Allowlist: []any{1, 2}},
			Segments: map[string]string{"1": "tunnel1_preshared_key", "2": "tunnel2_preshared_key"}},
		{Name: "preshared_key", Source: "user_input", Required: true, Attr: "{param:tunnel_number}"},
	}
	return op
}

func TestResolveTargetPathSegment(t *testing.T) {
	op := smAttachOp()
	got, code, reason := ResolveTarget(op, map[string]any{"app_type": "KernelGateway"})
	if code != "" {
		t.Fatalf("unexpected refusal %s: %s", code, reason)
	}
	if got.Target.Path[1] != "kernel_gateway_app_settings" {
		t.Fatalf("resolved path[1] = %q, want kernel_gateway_app_settings", got.Target.Path[1])
	}
	// The static prefix segment is untouched.
	if got.Target.Path[0] != "default_user_settings" {
		t.Fatalf("static path[0] = %q, want default_user_settings", got.Target.Path[0])
	}
	// The INPUT op must be deep-copied, never mutated (LoadDir shares one index).
	if op.Target.Path[1] != "{param:app_type}" {
		t.Fatalf("input op mutated: path[1] = %q", op.Target.Path[1])
	}
}

func TestResolveTargetAttr(t *testing.T) {
	op := vpnRotateOp()
	got, code, reason := ResolveTarget(op, map[string]any{"tunnel_number": 2, "preshared_key": "x"})
	if code != "" {
		t.Fatalf("unexpected refusal %s: %s", code, reason)
	}
	if got.Params[2].Attr != "tunnel2_preshared_key" {
		t.Fatalf("resolved attr = %q, want tunnel2_preshared_key", got.Params[2].Attr)
	}
	if op.Params[2].Attr != "{param:tunnel_number}" {
		t.Fatalf("input op mutated: params[2].Attr = %q", op.Params[2].Attr)
	}
}

// TestResolveTargetCanonicalizesLikeValidate pins the sharp edge spec §4 names:
// ResolveTarget keys segments with fmt.Sprint(v), exactly as Validate compares the
// allowlist — so an int 1, a JSON float64 1.0, and a string "1" all resolve to the
// same "tunnel1_preshared_key" and none can pass Validate yet miss the map.
func TestResolveTargetCanonicalizesLikeValidate(t *testing.T) {
	op := vpnRotateOp()
	for _, v := range []any{1, int64(1), 1.0, "1"} {
		params := map[string]any{"connection": "aws_vpn_connection.x", "tunnel_number": v, "preshared_key": "x"}
		if code, reason := Validate(op, params); code != "" {
			t.Fatalf("Validate(%T %v) = %s: %s, want clean", v, v, code, reason)
		}
		got, code, reason := ResolveTarget(op, params)
		if code != "" {
			t.Fatalf("ResolveTarget(%T %v) refused %s: %s", v, v, code, reason)
		}
		if got.Params[2].Attr != "tunnel1_preshared_key" {
			t.Fatalf("attr for %T %v = %q, want tunnel1_preshared_key", v, v, got.Params[2].Attr)
		}
	}
}

func TestResolveTargetRefusals(t *testing.T) {
	cases := []struct {
		name     string
		mutate   func(op *Op)
		params   map[string]any
		wantCode string
	}{
		{"value not in segments map (in allowlist)",
			func(op *Op) {
				op.Params[1].Segments = map[string]string{"JupyterServer": "jupyter_server_app_settings"}
			},
			map[string]any{"app_type": "KernelGateway"}, RefuseUnresolvedDynamicSegment},
		{"token names a non-discriminator param",
			func(op *Op) { op.Params[1].Role = "value" },
			map[string]any{"app_type": "KernelGateway"}, RefuseMalformedDynamicTarget},
		{"token names a missing param",
			func(op *Op) { op.Target.Path = []string{"default_user_settings", "{param:nope}"} },
			map[string]any{"app_type": "KernelGateway"}, RefuseMalformedDynamicTarget},
		{"segments value is not an HCL ident",
			func(op *Op) { op.Params[1].Segments["KernelGateway"] = "kernel gateway" },
			map[string]any{"app_type": "KernelGateway"}, RefuseMalformedDynamicTarget},
		{"discriminator has no segments map",
			func(op *Op) { op.Params[1].Segments = nil },
			map[string]any{"app_type": "KernelGateway"}, RefuseMalformedDynamicTarget},
		{"infix token (not whole-segment)",
			func(op *Op) { op.Target.Path = []string{"x{param:app_type}y"} },
			map[string]any{"app_type": "KernelGateway"}, RefuseMalformedDynamicTarget},
		{"stray brace",
			func(op *Op) { op.Target.Path = []string{"{param:app_type}{"} },
			map[string]any{"app_type": "KernelGateway"}, RefuseMalformedDynamicTarget},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			op := smAttachOp()
			tc.mutate(&op)
			_, code, reason := ResolveTarget(op, tc.params)
			if code != tc.wantCode {
				t.Fatalf("code = %q (%s), want %q", code, reason, tc.wantCode)
			}
		})
	}
}

// TestResolveTargetStaticUnchanged confirms an op with no {param:…} token is returned
// verbatim (no allocation churn, no behavior change for the U1 static path).
func TestResolveTargetStaticUnchanged(t *testing.T) {
	op := Op{ID: "static", CodemodOp: "set_attribute"}
	op.Target.Path = []string{"metadata_options"}
	op.Params = []Param{{Name: "instance", Source: "inventory"}, {Name: "http_tokens", Source: "user_input"}}
	got, code, reason := ResolveTarget(op, map[string]any{"http_tokens": "required"})
	if code != "" {
		t.Fatalf("unexpected refusal %s: %s", code, reason)
	}
	if got.Target.Path[0] != "metadata_options" || len(got.Params) != 2 {
		t.Fatalf("static op altered: %+v", got.Target)
	}
}

func TestIsValidBlockIdent(t *testing.T) {
	for _, s := range []string{"kernel_gateway_app_settings", "tunnel2_preshared_key", "rule", "a-b", "_x"} {
		if !IsValidBlockIdent(s) {
			t.Errorf("IsValidBlockIdent(%q) = false, want true", s)
		}
	}
	for _, s := range []string{"", "kernel gateway", "a.b", "ingress/egress", "1leading", "x{param:y}"} {
		if IsValidBlockIdent(s) {
			t.Errorf("IsValidBlockIdent(%q) = true, want false", s)
		}
	}
}
