package plancheck

import (
	"strings"
	"testing"

	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/manifests"
	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/request"
)

// covinterior_cov_test.go exercises interior.go (plan-check R6) exhaustively: every
// deriveInterior arm (modeled and not-modeled), every INFO interior-unverifiable
// reason, both violation rules' rendered reasons, and the walk/diff/value primitives
// the two rules are built out of. Everything is hand-built plan JSON — R6 is pure, so
// no fixtures, no disk, no clock.

// ── helpers (all covinterior-prefixed) ────────────────────────────────────────

func covinteriorOp(id, codemodOp string) manifests.Op {
	op := manifests.Op{ID: id, Macd: "Change", CodemodOp: codemodOp}
	op.Target.ResourceType = "aws_instance"
	return op
}

func covinteriorReq(params map[string]any) *request.Request {
	return &request.Request{Schema: "ccp.request/v1", Item: "covinterior", Params: params}
}

func covinteriorChange(addr string, before, after, afterUnknown map[string]any) ResourceChange {
	return ResourceChange{Address: addr, Change: Change{
		Actions:      []string{"update"},
		Before:       before,
		After:        after,
		AfterUnknown: afterUnknown,
	}}
}

func covinteriorRules(vs []Violation) []string {
	out := make([]string, 0, len(vs))
	for _, v := range vs {
		out = append(out, v.Rule)
	}
	return out
}

func covinteriorReasons(vs []Violation) string {
	out := make([]string, 0, len(vs))
	for _, v := range vs {
		out = append(out, v.Reason)
	}
	return strings.Join(out, "\n")
}

// covinteriorRender renders a declaredChange so a table can assert the derived
// interior exactly (path + how it is value-checked) rather than just its length.
func covinteriorRender(d declaredChange) string {
	var b strings.Builder
	b.WriteString(keyStr(d.keyPath))
	if d.subtree {
		b.WriteString(" subtree")
	}
	if d.valParam == nil {
		b.WriteString(" param=<nil>")
	} else {
		b.WriteString(" param=" + d.valParam.Name)
	}
	if d.growOnly {
		b.WriteString(" growOnly")
	}
	if d.sel != nil {
		b.WriteString(" sel=" + d.sel.matchAttr + "=" + d.sel.value)
	}
	return b.String()
}

func covinteriorRenderAll(changes []declaredChange) []string {
	out := make([]string, 0, len(changes))
	for _, d := range changes {
		out = append(out, covinteriorRender(d))
	}
	return out
}

func covinteriorPaths(leaves [][]any) []string {
	out := make([]string, 0, len(leaves))
	for _, l := range leaves {
		out = append(out, pathStr(l))
	}
	return out
}

func covinteriorEqStrs(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// covinteriorInvParam is the source:"inventory" locator every op carries.
func covinteriorInvParam() manifests.Param {
	return manifests.Param{Name: "instance", Source: "inventory", Required: true}
}

// ── deriveInterior: shapes R6 refuses to model (→ INFO, never a false escape) ──

func TestCovinteriorDeriveInteriorNotModeled(t *testing.T) {
	dottedBlock := covinteriorOp("map-merge-dotted", "set_attribute")
	dottedBlock.Target.Block = "spec.tags"
	dottedBlock.Params = []manifests.Param{covinteriorInvParam(), {Name: "tags", Source: "user_input"}}

	noAttrFlat := covinteriorOp("no-attr-flat", "set_attribute")
	noAttrFlat.Params = []manifests.Param{covinteriorInvParam()}

	noAttrNested := covinteriorOp("no-attr-nested", "set_attribute")
	noAttrNested.Target.Path = []string{"metadata_options"}
	noAttrNested.Params = []manifests.Param{covinteriorInvParam()}

	dottedTargetAttr := covinteriorOp("dotted-target-attr", "set_attribute")
	dottedTargetAttr.Target.Attr = "server_side_encryption.enabled"
	dottedTargetAttr.Params = []manifests.Param{covinteriorInvParam(), {Name: "enabled", Source: "allowlist"}}

	dottedProse := covinteriorOp("dotted-prose", "set_attribute")
	dottedProse.TerraformCapability = "~ update (backup_policy.status)"
	dottedProse.Params = []manifests.Param{covinteriorInvParam(), {Name: "status", Source: "allowlist"}}

	// mirrors testdata dynamodb-set-sse-dotted: the only value param is dotted, so
	// after the skip there is no verifiable leaf left at all.
	setAttrsAllDotted := covinteriorOp("set-attrs-all-dotted", "set_attributes")
	setAttrsAllDotted.Params = []manifests.Param{covinteriorInvParam(),
		{Name: "sse_enabled", Source: "user_input", Attr: "server_side_encryption.enabled"}}

	setAttrsNoValueParams := covinteriorOp("set-attrs-no-values", "set_attributes")
	setAttrsNoValueParams.Params = []manifests.Param{covinteriorInvParam(),
		{Name: "index_name", Source: "user_input", Role: "selector", MatchAttr: "name"}}

	foreachNoBlock := covinteriorOp("foreach-local-map", "append_foreach_entry")
	foreachNoBlock.Params = []manifests.Param{covinteriorInvParam(),
		{Name: "key", Source: "user_input"}, {Name: "value", Source: "user_input"}}

	foreachDottedBlock := covinteriorOp("foreach-dotted-map", "append_foreach_entry")
	foreachDottedBlock.Target.Block = "local.tags"
	foreachDottedBlock.Params = foreachNoBlock.Params

	foreachOneParam := covinteriorOp("foreach-one-param", "append_foreach_entry")
	foreachOneParam.Target.Block = "tags"
	foreachOneParam.Params = []manifests.Param{covinteriorInvParam(), {Name: "key", Source: "user_input"}}

	foreachZeroParams := covinteriorOp("foreach-zero-params", "append_foreach_entry")
	foreachZeroParams.Target.Block = "tags"
	foreachZeroParams.Params = []manifests.Param{covinteriorInvParam(),
		{Name: "which", Source: "user_input", Role: "selector", MatchAttr: "name"}}

	foreachEmptyKey := covinteriorOp("foreach-empty-key", "append_foreach_entry")
	foreachEmptyKey.Target.Block = "tags"
	foreachEmptyKey.Params = foreachNoBlock.Params

	unmodeled := covinteriorOp("append-block", "append_block")

	tests := []struct {
		name     string
		op       manifests.Op
		params   map[string]any
		wantSkip string
	}{
		{
			name:     "set_attribute map-merge into a dotted block",
			op:       dottedBlock,
			params:   map[string]any{"instance": "aws_instance.a", "tags": map[string]any{"Env": "prod"}},
			wantSkip: `set_attribute map-merge into dotted block "spec.tags" is refused by the executor`,
		},
		{
			name:     "flat set_attribute with no value param and no prose token",
			op:       noAttrFlat,
			params:   map[string]any{"instance": "aws_instance.a"},
			wantSkip: `op "no-attr-flat" has no resolvable value attribute`,
		},
		{
			name:     "nested set_attribute with no value param",
			op:       noAttrNested,
			params:   map[string]any{"instance": "aws_instance.a"},
			wantSkip: `op "no-attr-nested" has no resolvable value attribute`,
		},
		{
			name:     "explicit dotted target.attr is executor-refused",
			op:       dottedTargetAttr,
			params:   map[string]any{"instance": "aws_instance.a", "enabled": true},
			wantSkip: `attribute "server_side_encryption.enabled" is a nested path the executor refuses`,
		},
		{
			name:     "dotted prose paren token is executor-refused",
			op:       dottedProse,
			params:   map[string]any{"instance": "aws_instance.a", "status": "ENABLED"},
			wantSkip: `attribute "backup_policy.status" is a nested path the executor refuses`,
		},
		{
			name:     "set_attributes whose only value param is dotted has no verifiable leaf",
			op:       setAttrsAllDotted,
			params:   map[string]any{"instance": "aws_instance.a", "sse_enabled": true},
			wantSkip: `op "set-attrs-all-dotted" declares no verifiable value params`,
		},
		{
			name:     "set_attributes with only locator/selector params",
			op:       setAttrsNoValueParams,
			params:   map[string]any{"instance": "aws_instance.a", "index_name": "by-status"},
			wantSkip: `op "set-attrs-no-values" declares no verifiable value params`,
		},
		{
			name:     "append_foreach_entry into a local/address map (no target.block)",
			op:       foreachNoBlock,
			params:   map[string]any{"instance": "aws_instance.a", "key": "Snap", "value": "daily"},
			wantSkip: `op "foreach-local-map" foreach map attribute is not statically resolvable (local/address map)`,
		},
		{
			name:     "append_foreach_entry into a dotted map attribute",
			op:       foreachDottedBlock,
			params:   map[string]any{"instance": "aws_instance.a", "key": "Snap", "value": "daily"},
			wantSkip: `op "foreach-dotted-map" foreach map attribute is not statically resolvable (local/address map)`,
		},
		{
			name:     "append_foreach_entry with only a key param",
			op:       foreachOneParam,
			params:   map[string]any{"instance": "aws_instance.a", "key": "Snap"},
			wantSkip: `op "foreach-one-param" foreach key/value params are missing`,
		},
		{
			name:     "append_foreach_entry with no key/value params",
			op:       foreachZeroParams,
			params:   map[string]any{"instance": "aws_instance.a", "which": "x"},
			wantSkip: `op "foreach-zero-params" foreach key/value params are missing`,
		},
		{
			name:     "append_foreach_entry with an empty key value",
			op:       foreachEmptyKey,
			params:   map[string]any{"instance": "aws_instance.a", "key": "", "value": "daily"},
			wantSkip: `op "foreach-empty-key" foreach key value is empty`,
		},
		{
			name:     "a codemodOp R6 does not model at all",
			op:       unmodeled,
			params:   map[string]any{"instance": "aws_instance.a"},
			wantSkip: `codemodOp "append_block" is not modeled by interior confinement`,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			changes, modeled, skip := deriveInterior(tt.op, covinteriorReq(tt.params))
			if modeled {
				t.Fatalf("modeled = true, want false (changes: %v)", covinteriorRenderAll(changes))
			}
			if len(changes) != 0 {
				t.Fatalf("changes = %v, want none when the shape is not modeled", covinteriorRenderAll(changes))
			}
			if skip != tt.wantSkip {
				t.Fatalf("skip = %q, want %q", skip, tt.wantSkip)
			}

			// A not-modeled shape must degrade to a single INFO and never violate.
			c := covinteriorChange("aws_instance.a",
				map[string]any{"instance_type": "c5.large"},
				map[string]any{"instance_type": "c6i.large"}, nil)
			vs, info := checkInterior(tt.op, covinteriorReq(tt.params), c)
			if len(vs) != 0 {
				t.Fatalf("checkInterior violations = %v, want none for an unmodeled shape", covinteriorRules(vs))
			}
			joined := strings.Join(info, "\n")
			if !strings.Contains(joined, "INFO interior-unverifiable") || !strings.Contains(joined, tt.wantSkip) {
				t.Fatalf("info = %q, want an INFO interior-unverifiable carrying %q", joined, tt.wantSkip)
			}
		})
	}
}

// ── deriveInterior: the declared interior for every modeled shape ─────────────

func TestCovinteriorDeriveInteriorDeclaredChanges(t *testing.T) {
	mapMerge := covinteriorOp("map-merge", "set_attribute")
	mapMerge.Target.Path = []string{"root_block_device"}
	mapMerge.Target.Block = "tags"
	mapMerge.Params = []manifests.Param{covinteriorInvParam(), {Name: "tags", Source: "user_input"}}

	explicitAttr := covinteriorOp("explicit-attr", "set_attribute")
	explicitAttr.Target.Attr = "instance_type"
	explicitAttr.TerraformCapability = "~ update (stop/start)"
	explicitAttr.Params = []manifests.Param{covinteriorInvParam(), {Name: "new_instance_type", Source: "allowlist"}}

	proseAttr := covinteriorOp("prose-attr", "set_attribute")
	proseAttr.TerraformCapability = "~ update (disable_api_termination)"
	proseAttr.Params = []manifests.Param{covinteriorInvParam(), {Name: "enabled", Source: "allowlist", Type: "bool"}}

	wrapList := covinteriorOp("wrap-list", "set_attribute")
	wrapList.Params = []manifests.Param{covinteriorInvParam(),
		{Name: "lifecycle_config_arn", Source: "user_input", Attr: "lifecycle_config_arns", Wrap: "list"}}

	listValued := covinteriorOp("list-valued", "set_attribute")
	listValued.Params = []manifests.Param{covinteriorInvParam(), {Name: "new_subnets", Source: "user_input"}}

	growNestedSel := covinteriorOp("grow-nested-sel", "set_attribute")
	growNestedSel.Target.ResourceType = "aws_dynamodb_table"
	growNestedSel.Target.Path = []string{"global_secondary_index"}
	growNestedSel.Params = []manifests.Param{
		{Name: "table", Source: "inventory"},
		{Name: "index_name", Source: "user_input", Role: "selector", MatchAttr: "name"},
		{Name: "new_read_capacity", Source: "user_input", Attr: "read_capacity", Bounds: &manifests.Bounds{GrowOnly: true}},
	}

	// mirrors testdata dynamodb-resize-capacity: two grow-only value params.
	setAttrsGrow := covinteriorOp("set-attrs-grow", "set_attributes")
	setAttrsGrow.Target.ResourceType = "aws_dynamodb_table"
	setAttrsGrow.Params = []manifests.Param{
		{Name: "table", Source: "inventory"},
		{Name: "read_capacity", Source: "user_input", Bounds: &manifests.Bounds{GrowOnly: true}},
		{Name: "write_capacity", Source: "user_input", Bounds: &manifests.Bounds{GrowOnly: true}},
	}

	// mirrors testdata lb-tune-health-check plus one dotted param that must be skipped.
	setAttrsNested := covinteriorOp("set-attrs-nested", "set_attributes")
	setAttrsNested.Target.ResourceType = "aws_lb_target_group"
	setAttrsNested.Target.Path = []string{"health_check"}
	setAttrsNested.Params = []manifests.Param{
		{Name: "target_group", Source: "inventory"},
		{Name: "interval", Source: "user_input"},
		{Name: "timeout", Source: "user_input"},
		{Name: "deep", Source: "user_input", Attr: "matcher.http_code"},
	}

	foreachNested := covinteriorOp("foreach-nested", "append_foreach_entry")
	foreachNested.Target.Path = []string{"root_block_device"}
	foreachNested.Target.Block = "tags"
	foreachNested.Params = []manifests.Param{covinteriorInvParam(),
		{Name: "key", Source: "user_input"}, {Name: "value", Source: "user_input"}}

	tests := []struct {
		name   string
		op     manifests.Op
		params map[string]any
		want   []string
	}{
		{
			name:   "map-merge declares the whole map attribute as a subtree, value not derivable",
			op:     mapMerge,
			params: map[string]any{"instance": "aws_instance.a", "tags": map[string]any{"Env": "prod"}},
			want:   []string{"root_block_device.tags subtree param=<nil>"},
		},
		{
			name:   "explicit target.attr beats the prose token and the param name",
			op:     explicitAttr,
			params: map[string]any{"instance": "aws_instance.a", "new_instance_type": "c6i.large"},
			want:   []string{"instance_type param=new_instance_type"},
		},
		{
			name:   "un-migrated toggle resolves its attr from the prose token",
			op:     proseAttr,
			params: map[string]any{"instance": "aws_instance.a", "enabled": true},
			want:   []string{"disable_api_termination param=enabled"},
		},
		{
			name:   `wrap:"list" declares a subtree so the list element is not an escape`,
			op:     wrapList,
			params: map[string]any{"instance": "aws_instance.a", "lifecycle_config_arn": "arn:new"},
			want:   []string{"lifecycle_config_arns subtree param=lifecycle_config_arn"},
		},
		{
			name:   "a list-typed request value also declares a subtree",
			op:     listValued,
			params: map[string]any{"instance": "aws_instance.a", "new_subnets": []any{"subnet-1", "subnet-2"}},
			want:   []string{"subnets subtree param=new_subnets"},
		},
		{
			name:   "nested selector-keyed grow-only carries the selector and the growOnly flag",
			op:     growNestedSel,
			params: map[string]any{"table": "aws_dynamodb_table.t", "index_name": "by-status", "new_read_capacity": 20},
			want:   []string{"global_secondary_index.read_capacity param=new_read_capacity growOnly sel=name=by-status"},
		},
		{
			name:   "set_attributes declares one leaf per grow-only value param",
			op:     setAttrsGrow,
			params: map[string]any{"table": "aws_dynamodb_table.t", "read_capacity": 20, "write_capacity": 10},
			want: []string{
				"read_capacity param=read_capacity growOnly",
				"write_capacity param=write_capacity growOnly",
			},
		},
		{
			name:   "set_attributes under target.path skips the locator and the dotted param",
			op:     setAttrsNested,
			params: map[string]any{"target_group": "aws_lb_target_group.t", "interval": 30, "timeout": 5, "deep": "200"},
			want: []string{
				"health_check.interval param=interval",
				"health_check.timeout param=timeout",
			},
		},
		{
			name:   "append_foreach_entry declares exactly the new map key",
			op:     foreachNested,
			params: map[string]any{"instance": "aws_instance.a", "key": "Snap", "value": "daily"},
			want:   []string{"root_block_device.tags.Snap param=value"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			changes, modeled, skip := deriveInterior(tt.op, covinteriorReq(tt.params))
			if !modeled {
				t.Fatalf("modeled = false (skip %q), want a modeled interior", skip)
			}
			if skip != "" {
				t.Fatalf("skip = %q, want empty when modeled", skip)
			}
			got := covinteriorRenderAll(changes)
			if !covinteriorEqStrs(got, tt.want) {
				t.Fatalf("declared interior = %v, want %v", got, tt.want)
			}
		})
	}
}

// ── checkInterior: every INFO interior-unverifiable reason ─────────────────────

func TestCovinteriorCheckInteriorInfoReasons(t *testing.T) {
	const inst = "aws_instance.a"

	mapMerge := covinteriorOp("map-merge", "set_attribute")
	mapMerge.Target.Block = "tags"
	mapMerge.Params = []manifests.Param{covinteriorInvParam(), {Name: "tags", Source: "user_input"}}

	attrNoValueParam := covinteriorOp("attr-no-value-param", "set_attribute")
	attrNoValueParam.Target.Attr = "disable_api_termination"
	attrNoValueParam.Params = []manifests.Param{covinteriorInvParam()}

	refValue := covinteriorOp("ref-value", "set_attribute")
	refValue.Target.Attr = "kms_key_id"
	refValue.Params = []manifests.Param{covinteriorInvParam(),
		{Name: "key", Source: "inventory", Role: "reference", RefAttr: "arn", EnumSource: "inventory://aws_kms_key/arn"}}

	nullConst := covinteriorOp("null-const", "set_attribute")
	nullConst.Target.Attr = "http_tokens"
	nullConst.Params = []manifests.Param{covinteriorInvParam(), {Name: "mode", Role: "const"}}

	missingParam := covinteriorOp("missing-param", "set_attribute")
	missingParam.Target.Attr = "instance_type"
	missingParam.Params = []manifests.Param{covinteriorInvParam(), {Name: "new_instance_type", Source: "allowlist"}}

	nested := covinteriorOp("nested-imds", "set_attribute")
	nested.Target.Path = []string{"metadata_options"}
	nested.Params = []manifests.Param{covinteriorInvParam(), {Name: "http_tokens", Source: "allowlist"}}

	tests := []struct {
		name      string
		op        manifests.Op
		params    map[string]any
		change    ResourceChange
		wantRules []string
		wantInfo  []string
	}{
		{
			name:   "map-merge keys are a union, so their values are INFO not asserted",
			op:     mapMerge,
			params: map[string]any{"instance": inst, "tags": map[string]any{"Env": "prod"}},
			change: covinteriorChange(inst,
				map[string]any{"tags": map[string]any{"Env": "dev"}},
				map[string]any{"tags": map[string]any{"Env": "prod", "Owner": "team"}}, nil),
			wantInfo: []string{"value at tags is not request-derivable (map-merge or computed)"},
		},
		{
			name:   "an attr named by target.attr with no value param is not value-checked",
			op:     attrNoValueParam,
			params: map[string]any{"instance": inst},
			change: covinteriorChange(inst,
				map[string]any{"disable_api_termination": false},
				map[string]any{"disable_api_termination": true}, nil),
			wantInfo: []string{"value at disable_api_termination is not request-derivable (map-merge or computed)"},
		},
		{
			name:   "a reference value is resolved at apply, so it is INFO",
			op:     refValue,
			params: map[string]any{"instance": inst, "key": "aws_kms_key.k"},
			change: covinteriorChange(inst,
				map[string]any{"kms_key_id": "arn:aws:kms:::key/old"},
				map[string]any{"kms_key_id": "arn:aws:kms:::key/new"}, nil),
			wantInfo: []string{"value at kms_key_id is not request-derivable (reference value resolved at apply)"},
		},
		{
			name:   "a null const carries no comparable value",
			op:     nullConst,
			params: map[string]any{"instance": inst},
			change: covinteriorChange(inst,
				map[string]any{"http_tokens": "optional"},
				map[string]any{"http_tokens": "required"}, nil),
			wantInfo: []string{"value at http_tokens is not request-derivable (null const)"},
		},
		{
			name:   "a value param absent from the request is INFO, not a mismatch",
			op:     missingParam,
			params: map[string]any{"instance": inst},
			change: covinteriorChange(inst,
				map[string]any{"instance_type": "c5.large"},
				map[string]any{"instance_type": "c6i.large"}, nil),
			wantInfo: []string{"value at instance_type is not request-derivable (value not present in request)"},
		},
		{
			name:   "a declared leaf in neither before nor after is INFO twice and the stray leaf escapes",
			op:     missingParam,
			params: map[string]any{"instance": inst, "new_instance_type": "c6i.large"},
			change: covinteriorChange(inst,
				map[string]any{"monitoring": false},
				map[string]any{"monitoring": true}, nil),
			wantRules: []string{"interior-escape"},
			wantInfo: []string{
				"declared interior instance_type could not be located in the plan before/after tree",
				"declared leaf instance_type is absent from the plan after-state",
			},
		},
		{
			name:   "a removed leaf resolves its cover from before and is not an escape",
			op:     missingParam,
			params: map[string]any{"instance": inst, "new_instance_type": "c6i.large"},
			change: covinteriorChange(inst,
				map[string]any{"instance_type": "c5.large"},
				map[string]any{}, nil),
			wantInfo: []string{"declared leaf instance_type is absent from the plan after-state"},
		},
		{
			name:   "after_unknown masking the leaf itself (nested list shape) is INFO",
			op:     nested,
			params: map[string]any{"instance": inst, "http_tokens": "required"},
			change: covinteriorChange(inst,
				map[string]any{"metadata_options": []any{map[string]any{"http_tokens": "optional"}}},
				map[string]any{"metadata_options": []any{map[string]any{"http_tokens": nil}}},
				map[string]any{"metadata_options": []any{map[string]any{"http_tokens": true}}}),
			wantInfo: []string{"value at metadata_options.http_tokens is known only after apply"},
		},
		{
			name:   "after_unknown=true higher in the tree masks the whole subtree",
			op:     nested,
			params: map[string]any{"instance": inst, "http_tokens": "required"},
			change: covinteriorChange(inst,
				map[string]any{"metadata_options": []any{map[string]any{"http_tokens": "optional"}}},
				map[string]any{"metadata_options": []any{map[string]any{"http_tokens": "whatever"}}},
				map[string]any{"metadata_options": true}),
			wantInfo: []string{"value at metadata_options.http_tokens is known only after apply"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			vs, info := checkInterior(tt.op, covinteriorReq(tt.params), tt.change)
			if !covinteriorEqStrs(covinteriorRules(vs), tt.wantRules) {
				t.Fatalf("rules = %v, want %v (reasons: %s)", covinteriorRules(vs), tt.wantRules, covinteriorReasons(vs))
			}
			joined := strings.Join(info, "\n")
			for _, want := range tt.wantInfo {
				if !strings.Contains(joined, want) {
					t.Fatalf("info = %q, want a line containing %q", joined, want)
				}
			}
			if len(info) != len(tt.wantInfo) {
				t.Fatalf("info lines = %d (%q), want %d", len(info), joined, len(tt.wantInfo))
			}
			for _, line := range info {
				if !strings.HasPrefix(line, "INFO interior-unverifiable: "+tt.change.Address+" — ") {
					t.Fatalf("info line %q lacks the INFO interior-unverifiable <address> prefix", line)
				}
			}
		})
	}
}

// ── checkInterior: the two violations' rendered reasons ───────────────────────

func TestCovinteriorCheckInteriorViolationReasons(t *testing.T) {
	const inst = "aws_instance.a"

	resize := covinteriorOp("resize", "set_attribute")
	resize.Target.Attr = "instance_type"
	resize.Params = []manifests.Param{covinteriorInvParam(), {Name: "new_instance_type", Source: "allowlist"}}

	wrapList := covinteriorOp("attach-lcc", "set_attribute")
	wrapList.Params = []manifests.Param{covinteriorInvParam(),
		{Name: "lifecycle_config_arn", Source: "user_input", Attr: "lifecycle_config_arns", Wrap: "list"}}

	setAttrsNested := covinteriorOp("lb-tune-health-check", "set_attributes")
	setAttrsNested.Target.ResourceType = "aws_lb_target_group"
	setAttrsNested.Target.Path = []string{"health_check"}
	setAttrsNested.Params = []manifests.Param{
		{Name: "target_group", Source: "inventory"},
		{Name: "interval", Source: "user_input"},
		{Name: "timeout", Source: "user_input"},
	}

	tests := []struct {
		name        string
		op          manifests.Op
		params      map[string]any
		change      ResourceChange
		wantRules   []string
		wantReasons []string
	}{
		{
			name:   "a planned null where the request asked for a value renders as null",
			op:     resize,
			params: map[string]any{"instance": inst, "new_instance_type": "c6i.large"},
			change: covinteriorChange(inst,
				map[string]any{"instance_type": "c5.large"},
				map[string]any{"instance_type": nil}, nil),
			wantRules:   []string{"value-mismatch"},
			wantReasons: []string{`instance_type planned null but the request asked for "c6i.large"`},
		},
		{
			name:   "two undeclared leaves both escape, reported in sorted path order",
			op:     resize,
			params: map[string]any{"instance": inst, "new_instance_type": "c6i.large"},
			change: covinteriorChange(inst,
				map[string]any{"instance_type": "c5.large", "monitoring": false, "user_data": "old"},
				map[string]any{"instance_type": "c6i.large", "monitoring": true, "user_data": "new"}, nil),
			wantRules: []string{"interior-escape", "interior-escape"},
			wantReasons: []string{
				"changed leaf monitoring is outside the op's declared interior {instance_type}",
				"changed leaf user_data is outside the op's declared interior {instance_type}",
			},
		},
		{
			name:   "a nested escape renders the concrete indexed path",
			op:     setAttrsNested,
			params: map[string]any{"target_group": "aws_lb_target_group.t", "interval": 30, "timeout": 5},
			change: covinteriorChange("aws_lb_target_group.t",
				map[string]any{"health_check": []any{map[string]any{"interval": 10.0, "timeout": 5.0, "path": "/health"}}},
				map[string]any{"health_check": []any{map[string]any{"interval": 30.0, "timeout": 5.0, "path": "/ping"}}}, nil),
			wantRules: []string{"interior-escape"},
			wantReasons: []string{
				"changed leaf health_check[0].path is outside the op's declared interior {health_check.interval, health_check.timeout}",
			},
		},
		{
			name:   "set_attributes value-mismatch names the declared keyPath, not the indexed one",
			op:     setAttrsNested,
			params: map[string]any{"target_group": "aws_lb_target_group.t", "interval": 30, "timeout": 5},
			change: covinteriorChange("aws_lb_target_group.t",
				map[string]any{"health_check": []any{map[string]any{"interval": 10.0, "timeout": 5.0}}},
				map[string]any{"health_check": []any{map[string]any{"interval": 30.0, "timeout": 9.0}}}, nil),
			wantRules:   []string{"value-mismatch"},
			wantReasons: []string{`health_check.timeout planned "9" but the request asked for "5"`},
		},
		{
			name:   `wrap:"list" whose planned list lacks the requested element is a mismatch, not an escape`,
			op:     wrapList,
			params: map[string]any{"instance": inst, "lifecycle_config_arn": "arn:new"},
			change: covinteriorChange(inst,
				map[string]any{"lifecycle_config_arns": []any{"arn:old"}},
				map[string]any{"lifecycle_config_arns": []any{"arn:other"}}, nil),
			wantRules:   []string{"value-mismatch"},
			wantReasons: []string{`lifecycle_config_arns planned "[arn:other]" but the request asked for "arn:new"`},
		},
		{
			name:   `wrap:"list" planned as a bare scalar is a mismatch`,
			op:     wrapList,
			params: map[string]any{"instance": inst, "lifecycle_config_arn": "arn:new"},
			change: covinteriorChange(inst,
				map[string]any{"lifecycle_config_arns": []any{"arn:old"}},
				map[string]any{"lifecycle_config_arns": "arn:new"}, nil),
			wantRules:   []string{"value-mismatch"},
			wantReasons: []string{`lifecycle_config_arns planned "arn:new" but the request asked for "arn:new"`},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			vs, info := checkInterior(tt.op, covinteriorReq(tt.params), tt.change)
			if !covinteriorEqStrs(covinteriorRules(vs), tt.wantRules) {
				t.Fatalf("rules = %v, want %v (info: %v)", covinteriorRules(vs), tt.wantRules, info)
			}
			for i, want := range tt.wantReasons {
				if vs[i].Reason != want {
					t.Fatalf("violation[%d].Reason = %q, want %q", i, vs[i].Reason, want)
				}
				if vs[i].Address != tt.change.Address {
					t.Fatalf("violation[%d].Address = %q, want %q", i, vs[i].Address, tt.change.Address)
				}
			}
			if len(info) != 0 {
				t.Fatalf("info = %v, want none for a decided violation", info)
			}
		})
	}
}

// ── checkInterior: shapes that must stay silent ───────────────────────────────

func TestCovinteriorCheckInteriorClean(t *testing.T) {
	const inst = "aws_instance.a"

	constOp := covinteriorOp("const-value", "set_attribute")
	constOp.Target.Attr = "http_tokens"
	constOp.Params = []manifests.Param{covinteriorInvParam(), {Name: "mode", Role: "const", Const: "required"}}

	numeric := covinteriorOp("numeric", "set_attribute")
	numeric.Target.ResourceType = "aws_dynamodb_table"
	numeric.Target.Attr = "read_capacity"
	numeric.Params = []manifests.Param{{Name: "table", Source: "inventory"}, {Name: "new_read_capacity", Source: "user_input"}}

	wrapList := covinteriorOp("attach-lcc", "set_attribute")
	wrapList.Params = []manifests.Param{covinteriorInvParam(),
		{Name: "lifecycle_config_arn", Source: "user_input", Attr: "lifecycle_config_arns", Wrap: "list"}}

	growOnly := covinteriorOp("grow", "set_attribute")
	growOnly.Target.ResourceType = "aws_dynamodb_table"
	growOnly.Target.Attr = "read_capacity"
	growOnly.Params = []manifests.Param{{Name: "table", Source: "inventory"},
		{Name: "new_read_capacity", Source: "user_input", Bounds: &manifests.Bounds{GrowOnly: true}}}

	tests := []struct {
		name   string
		op     manifests.Op
		params map[string]any
		change ResourceChange
	}{
		{
			name:   "a role:const value with a non-nil const is derivable and matches",
			op:     constOp,
			params: map[string]any{"instance": inst},
			change: covinteriorChange(inst,
				map[string]any{"http_tokens": "optional"},
				map[string]any{"http_tokens": "required"}, nil),
		},
		{
			name:   "a YAML int request value matches a JSON float plan value",
			op:     numeric,
			params: map[string]any{"table": "aws_dynamodb_table.t", "new_read_capacity": 20},
			change: covinteriorChange("aws_dynamodb_table.t",
				map[string]any{"read_capacity": 5.0},
				map[string]any{"read_capacity": 20.0}, nil),
		},
		{
			name:   `wrap:"list" is satisfied by the requested element appearing in the list`,
			op:     wrapList,
			params: map[string]any{"instance": inst, "lifecycle_config_arn": "arn:new"},
			change: covinteriorChange(inst,
				map[string]any{"lifecycle_config_arns": []any{"arn:old"}},
				map[string]any{"lifecycle_config_arns": []any{"arn:new"}}, nil),
		},
		{
			name:   "a grow-only leaf is confined but its value is left to R4",
			op:     growOnly,
			params: map[string]any{"table": "aws_dynamodb_table.t", "new_read_capacity": 20},
			change: covinteriorChange("aws_dynamodb_table.t",
				map[string]any{"read_capacity": 5.0},
				map[string]any{"read_capacity": 999.0}, nil), // R6a must NOT flag this; R4 owns it
		},
		{
			name:   "a degenerate change with no before/after detail is silent",
			op:     numeric,
			params: map[string]any{"table": "aws_dynamodb_table.t", "new_read_capacity": 20},
			change: covinteriorChange("aws_dynamodb_table.t", nil, nil, nil),
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			vs, info := checkInterior(tt.op, covinteriorReq(tt.params), tt.change)
			if len(vs) != 0 {
				t.Fatalf("violations = %v (%s), want none", covinteriorRules(vs), covinteriorReasons(vs))
			}
			if len(info) != 0 {
				t.Fatalf("info = %v, want none", info)
			}
		})
	}
}

// ── walkConcrete / chooseIndex ────────────────────────────────────────────────

func TestCovinteriorWalkConcrete(t *testing.T) {
	tests := []struct {
		name     string
		root     map[string]any
		keyPath  []string
		sel      *plannedSelector
		wantOK   bool
		wantPath string
		wantVal  any
	}{
		{
			name:     "singleton nested block gets an auto-inserted index",
			root:     map[string]any{"metadata_options": []any{map[string]any{"http_tokens": "required"}}},
			keyPath:  []string{"metadata_options", "http_tokens"},
			wantOK:   true,
			wantPath: "metadata_options[0].http_tokens",
			wantVal:  "required",
		},
		{
			name: "selector picks the matching sibling",
			root: map[string]any{"global_secondary_index": []any{
				map[string]any{"name": "by-date", "read_capacity": 10.0},
				map[string]any{"name": "by-status", "read_capacity": 5.0},
			}},
			keyPath:  []string{"global_secondary_index", "read_capacity"},
			sel:      &plannedSelector{matchAttr: "name", value: "by-status"},
			wantOK:   true,
			wantPath: "global_secondary_index[1].read_capacity",
			wantVal:  5.0,
		},
		{
			name: "a selector matching two siblings is ambiguous and never guesses",
			root: map[string]any{"global_secondary_index": []any{
				map[string]any{"name": "dup", "read_capacity": 10.0},
				map[string]any{"name": "dup", "read_capacity": 5.0},
			}},
			keyPath: []string{"global_secondary_index", "read_capacity"},
			sel:     &plannedSelector{matchAttr: "name", value: "dup"},
			wantOK:  false,
		},
		{
			name:     "a selector matching nothing falls through to the singleton rule",
			root:     map[string]any{"rule": []any{map[string]any{"name": "only", "status": "Enabled"}}},
			keyPath:  []string{"rule", "status"},
			sel:      &plannedSelector{matchAttr: "name", value: "absent"},
			wantOK:   true,
			wantPath: "rule[0].status",
			wantVal:  "Enabled",
		},
		{
			name: "a selector matching nothing in a repeated block is unresolvable",
			root: map[string]any{"rule": []any{
				map[string]any{"name": "a", "status": "Enabled"},
				map[string]any{"name": "b", "status": "Enabled"},
			}},
			keyPath: []string{"rule", "status"},
			sel:     &plannedSelector{matchAttr: "name", value: "absent"},
			wantOK:  false,
		},
		{
			name: "a repeated block with no selector at all is unresolvable",
			root: map[string]any{"rule": []any{
				map[string]any{"status": "Enabled"},
				map[string]any{"status": "Disabled"},
			}},
			keyPath: []string{"rule", "status"},
			wantOK:  false,
		},
		{
			name:    "a scalar mid-path is not a map",
			root:    map[string]any{"metadata_options": "enabled"},
			keyPath: []string{"metadata_options", "http_tokens"},
			wantOK:  false,
		},
		{
			name:    "a missing key stops the walk",
			root:    map[string]any{"metadata_options": []any{map[string]any{"http_endpoint": "enabled"}}},
			keyPath: []string{"metadata_options", "http_tokens"},
			wantOK:  false,
		},
		{
			name: "an ambiguous list deeper down fails the walk",
			root: map[string]any{"rule": []any{map[string]any{
				"lifecycle": []any{map[string]any{"days": 30.0}, map[string]any{"days": 60.0}},
			}}},
			keyPath: []string{"rule", "lifecycle", "days"},
			wantOK:  false,
		},
		{
			name: "the selector is consumed at the first list level only",
			root: map[string]any{"rule": []any{
				map[string]any{"name": "keep", "lifecycle": []any{map[string]any{"days": 30.0}}},
				map[string]any{"name": "drop", "lifecycle": []any{map[string]any{"days": 1.0}}},
			}},
			keyPath:  []string{"rule", "lifecycle", "days"},
			sel:      &plannedSelector{matchAttr: "name", value: "keep"},
			wantOK:   true,
			wantPath: "rule[0].lifecycle[0].days",
			wantVal:  30.0,
		},
		{
			name:     "a map leaf under a map (foreach key) needs no index",
			root:     map[string]any{"tags": map[string]any{"Snap": "daily"}},
			keyPath:  []string{"tags", "Snap"},
			wantOK:   true,
			wantPath: "tags.Snap",
			wantVal:  "daily",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			concrete, val, ok := walkConcrete(tt.root, tt.keyPath, tt.sel)
			if ok != tt.wantOK {
				t.Fatalf("ok = %v, want %v (path %s, val %v)", ok, tt.wantOK, pathStr(concrete), val)
			}
			if !tt.wantOK {
				if concrete != nil || val != nil {
					t.Fatalf("failed walk returned path %v / val %v, want nil/nil", concrete, val)
				}
				return
			}
			if got := pathStr(concrete); got != tt.wantPath {
				t.Fatalf("concrete path = %q, want %q", got, tt.wantPath)
			}
			if val != tt.wantVal {
				t.Fatalf("val = %#v, want %#v", val, tt.wantVal)
			}
		})
	}
}

// ── changedLeaves / diffNode ──────────────────────────────────────────────────

func TestCovinteriorChangedLeaves(t *testing.T) {
	tests := []struct {
		name   string
		before map[string]any
		after  map[string]any
		au     map[string]any
		want   []string
	}{
		{
			name:   "a grown list reports the appended index",
			before: map[string]any{"security_groups": []any{"sg-1"}},
			after:  map[string]any{"security_groups": []any{"sg-1", "sg-2"}},
			want:   []string{"security_groups[1]"},
		},
		{
			name:   "a shrunk list reports the dropped index",
			before: map[string]any{"security_groups": []any{"sg-1", "sg-2"}},
			after:  map[string]any{"security_groups": []any{"sg-1"}},
			want:   []string{"security_groups[1]"},
		},
		{
			name:   "an element-level after_unknown mask prunes only that element",
			before: map[string]any{"ipv6_addresses": []any{"a", "b"}},
			after:  map[string]any{"ipv6_addresses": []any{"x", nil}},
			au:     map[string]any{"ipv6_addresses": []any{false, true}},
			want:   []string{"ipv6_addresses[0]"},
		},
		{
			name:   "an after_unknown=true subtree is excluded wholesale",
			before: map[string]any{"metadata_options": []any{map[string]any{"http_tokens": "optional"}}},
			after:  map[string]any{"metadata_options": []any{map[string]any{"http_tokens": nil}}},
			au:     map[string]any{"metadata_options": true},
			want:   nil,
		},
		{
			name:   "provider noise (id, arn, tags_all subtree) is excluded, siblings are not",
			before: map[string]any{"id": "i-1", "arn": "arn:1", "tags_all": map[string]any{"a": "1"}, "monitoring": false},
			after:  map[string]any{"id": "i-2", "arn": "arn:2", "tags_all": map[string]any{"a": "2"}, "monitoring": true},
			want:   []string{"monitoring"},
		},
		{
			name:   "output is sorted by rendered path",
			before: map[string]any{"z": "1", "a": "1", "m": "1"},
			after:  map[string]any{"z": "2", "a": "2", "m": "2"},
			want:   []string{"a", "m", "z"},
		},
		{
			name:   "an int/float numeric pair is not a change",
			before: map[string]any{"read_capacity": 5.0},
			after:  map[string]any{"read_capacity": 5},
			want:   nil,
		},
		{
			name:   "a key added only in after is a change from null",
			before: map[string]any{},
			after:  map[string]any{"root_block_device": []any{map[string]any{"tags": map[string]any{"Snap": "daily"}}}},
			want:   []string{"root_block_device[0].tags.Snap"},
		},
		{
			name:   "identical trees produce no leaves",
			before: map[string]any{"a": map[string]any{"b": []any{"c"}}},
			after:  map[string]any{"a": map[string]any{"b": []any{"c"}}},
			want:   nil,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := covinteriorPaths(changedLeaves(tt.before, tt.after, anyOf(tt.au)))
			if !covinteriorEqStrs(got, tt.want) {
				t.Fatalf("changedLeaves = %v, want %v", got, tt.want)
			}
		})
	}
}

// ── unknownAt ─────────────────────────────────────────────────────────────────

func TestCovinteriorUnknownAt(t *testing.T) {
	tests := []struct {
		name     string
		au       any
		concrete []any
		want     bool
	}{
		{
			name:     "nil after_unknown masks nothing",
			au:       anyOf(nil),
			concrete: []any{"instance_type"},
			want:     false,
		},
		{
			name:     "an exact true at the leaf masks it",
			au:       anyOf(map[string]any{"instance_type": true}),
			concrete: []any{"instance_type"},
			want:     true,
		},
		{
			name:     "an exact false at the leaf does not mask it",
			au:       anyOf(map[string]any{"instance_type": false}),
			concrete: []any{"instance_type"},
			want:     false,
		},
		{
			name:     "a true higher in the tree masks the whole subtree",
			au:       anyOf(map[string]any{"metadata_options": true}),
			concrete: []any{"metadata_options", 0, "http_tokens"},
			want:     true,
		},
		{
			name:     "a false higher in the tree does not mask the subtree",
			au:       anyOf(map[string]any{"metadata_options": false}),
			concrete: []any{"metadata_options", 0, "http_tokens"},
			want:     false,
		},
		{
			name:     "a nested list-shaped mask is walked by index",
			au:       anyOf(map[string]any{"metadata_options": []any{map[string]any{"http_tokens": true}}}),
			concrete: []any{"metadata_options", 0, "http_tokens"},
			want:     true,
		},
		{
			name:     "an index past the mask list is not masked",
			au:       anyOf(map[string]any{"rule": []any{map[string]any{"days": true}}}),
			concrete: []any{"rule", 3, "days"},
			want:     false,
		},
		{
			name:     "a string segment against a non-map node is not masked",
			au:       anyOf(map[string]any{"metadata_options": "nonsense"}),
			concrete: []any{"metadata_options", "http_tokens"},
			want:     false,
		},
		{
			name:     "an int segment against a non-list node is not masked",
			au:       anyOf(map[string]any{"metadata_options": map[string]any{"http_tokens": true}}),
			concrete: []any{"metadata_options", 0, "http_tokens"},
			want:     false,
		},
		{
			name:     "a mask that stops short of the leaf is not a mask",
			au:       anyOf(map[string]any{"metadata_options": map[string]any{}}),
			concrete: []any{"metadata_options", "http_tokens"},
			want:     false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := unknownAt(tt.au, tt.concrete); got != tt.want {
				t.Fatalf("unknownAt = %v, want %v", got, tt.want)
			}
		})
	}
}

// ── value derivation / comparison ─────────────────────────────────────────────

func TestCovinteriorRequestedValue(t *testing.T) {
	req := covinteriorReq(map[string]any{"new_instance_type": "c6i.large", "count": 3})

	tests := []struct {
		name          string
		p             manifests.Param
		wantVal       any
		wantDerivable bool
		wantKind      string
	}{
		{
			name:          "a const with a value is derivable",
			p:             manifests.Param{Name: "mode", Role: "const", Const: "required"},
			wantVal:       "required",
			wantDerivable: true,
			wantKind:      "null const",
		},
		{
			name:          "a null const is not derivable",
			p:             manifests.Param{Name: "mode", Role: "const"},
			wantVal:       nil,
			wantDerivable: false,
			wantKind:      "null const",
		},
		{
			name:          "a reference is resolved at apply, never at plan-check time",
			p:             manifests.Param{Name: "key", Role: "reference", Source: "inventory", RefAttr: "arn"},
			wantVal:       nil,
			wantDerivable: false,
			wantKind:      "reference value resolved at apply",
		},
		{
			name:          "an ordinary param present in the request is derivable",
			p:             manifests.Param{Name: "new_instance_type", Source: "allowlist"},
			wantVal:       "c6i.large",
			wantDerivable: true,
			wantKind:      "value not present in request",
		},
		{
			name:          "an ordinary param absent from the request is not derivable",
			p:             manifests.Param{Name: "missing", Source: "allowlist"},
			wantVal:       nil,
			wantDerivable: false,
			wantKind:      "value not present in request",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, derivable := requestedValue(tt.p, req)
			if derivable != tt.wantDerivable {
				t.Fatalf("derivable = %v, want %v", derivable, tt.wantDerivable)
			}
			if got != tt.wantVal {
				t.Fatalf("value = %#v, want %#v", got, tt.wantVal)
			}
			p := tt.p
			if kind := valParamKind(&p); kind != tt.wantKind {
				t.Fatalf("valParamKind = %q, want %q", kind, tt.wantKind)
			}
		})
	}
}

func TestCovinteriorValueMatches(t *testing.T) {
	tests := []struct {
		name string
		want any
		got  any
		wrap string
		ok   bool
	}{
		{name: "equal strings match", want: "required", got: "required", ok: true},
		{name: "different strings do not match", want: "required", got: "optional"},
		{name: "int request vs float plan match", want: 20, got: 20.0, ok: true},
		{name: "string request vs float plan canonicalize", want: "1", got: 1.0, ok: true},
		{name: "bool matches", want: true, got: true, ok: true},
		{name: "nil vs nil match", want: nil, got: nil, ok: true},
		{name: "nil vs value do not match", want: nil, got: "x"},
		{name: "value vs nil do not match", want: "x", got: nil},
		{name: "wrap list finds the element", want: "arn:new", got: []any{"arn:old", "arn:new"}, wrap: "list", ok: true},
		{name: "wrap list without the element fails", want: "arn:new", got: []any{"arn:old"}, wrap: "list"},
		{name: "wrap list against a scalar fails", want: "arn:new", got: "arn:new", wrap: "list"},
		{name: "wrap list against nil fails", want: "arn:new", got: nil, wrap: "list"},
		{name: "wrap list is numeric-canonical too", want: 20, got: []any{20.0}, wrap: "list", ok: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := valueMatches(tt.want, tt.got, tt.wrap); got != tt.ok {
				t.Fatalf("valueMatches(%#v, %#v, %q) = %v, want %v", tt.want, tt.got, tt.wrap, got, tt.ok)
			}
		})
	}
}

// ── executor-mirroring attr/param resolution ──────────────────────────────────

func TestCovinteriorScalarAttr(t *testing.T) {
	explicit := covinteriorOp("explicit", "set_attribute")
	explicit.Target.Attr = "instance_type"
	explicit.TerraformCapability = "~ update (disable_api_termination)"
	explicit.Target.Path = []string{"metadata_options"}
	explicit.Params = []manifests.Param{covinteriorInvParam(), {Name: "new_instance_type", Source: "allowlist"}}

	nested := covinteriorOp("nested", "set_attribute")
	nested.Target.Path = []string{"metadata_options"}
	nested.TerraformCapability = "~ update (http_endpoint)"
	nested.Params = []manifests.Param{covinteriorInvParam(), {Name: "http_tokens", Source: "allowlist"}}

	nestedNoValue := covinteriorOp("nested-no-value", "set_attribute")
	nestedNoValue.Target.Path = []string{"metadata_options"}
	nestedNoValue.Params = []manifests.Param{covinteriorInvParam()}

	prose := covinteriorOp("prose", "set_attribute")
	prose.TerraformCapability = "~ update (disable_api_termination)"
	prose.Params = []manifests.Param{covinteriorInvParam(), {Name: "enabled", Source: "allowlist"}}

	proseNotAnIdent := covinteriorOp("prose-not-ident", "set_attribute")
	proseNotAnIdent.TerraformCapability = "~ update (stop/start)"
	proseNotAnIdent.Params = []manifests.Param{covinteriorInvParam(), {Name: "new_instance_type", Source: "allowlist"}}

	renamed := covinteriorOp("renamed", "set_attribute")
	renamed.Target.ResourceType = "aws_ebs_volume"
	renamed.Params = []manifests.Param{covinteriorInvParam(), {Name: "new_size_gib", Source: "user_input"}}

	flatNoValue := covinteriorOp("flat-no-value", "set_attribute")
	flatNoValue.Params = []manifests.Param{covinteriorInvParam()}

	tests := []struct {
		name      string
		op        manifests.Op
		wantAttr  string
		wantParam string // "" ⇒ nil value param
	}{
		{name: "explicit target.attr wins over prose and path", op: explicit, wantAttr: "instance_type", wantParam: "new_instance_type"},
		{name: "a nested op ignores the prose token and uses AttrFor", op: nested, wantAttr: "http_tokens", wantParam: "http_tokens"},
		{name: "a nested op with no value param resolves nothing", op: nestedNoValue},
		{name: "a flat op takes a bare prose paren token", op: prose, wantAttr: "disable_api_termination", wantParam: "enabled"},
		{name: "a non-identifier prose token falls back to AttrFor", op: proseNotAnIdent, wantAttr: "instance_type", wantParam: "new_instance_type"},
		{name: "AttrFor applies the resourceType rename table", op: renamed, wantAttr: "size", wantParam: "new_size_gib"},
		{name: "a flat op with no prose and no value param resolves nothing", op: flatNoValue},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			attr, vp := scalarAttr(tt.op)
			if attr != tt.wantAttr {
				t.Fatalf("attr = %q, want %q", attr, tt.wantAttr)
			}
			if tt.wantParam == "" {
				if vp != nil {
					t.Fatalf("value param = %q, want nil", vp.Name)
				}
				return
			}
			if vp == nil {
				t.Fatalf("value param = nil, want %q", tt.wantParam)
			}
			if vp.Name != tt.wantParam {
				t.Fatalf("value param = %q, want %q", vp.Name, tt.wantParam)
			}
		})
	}
}

func TestCovinteriorParamHelpers(t *testing.T) {
	t.Run("firstValueParam skips locator, selector and discriminator params", func(t *testing.T) {
		op := covinteriorOp("first-value", "set_attribute")
		op.Params = []manifests.Param{
			covinteriorInvParam(),
			{Name: "which", Source: "user_input", Role: "selector", MatchAttr: "name"},
			{Name: "app_type", Source: "allowlist", Role: "discriminator"},
			{Name: "value", Source: "user_input"},
			{Name: "second", Source: "user_input"},
		}
		vp := firstValueParam(op)
		if vp == nil || vp.Name != "value" {
			t.Fatalf("firstValueParam = %v, want value", vp)
		}
		if !isValueProviderP(*vp) {
			t.Fatalf("isValueProviderP(%q) = false, want true", vp.Name)
		}
		for _, p := range op.Params[:3] {
			if isValueProviderP(p) {
				t.Fatalf("isValueProviderP(%q) = true, want false", p.Name)
			}
		}
	})

	t.Run("firstValueParam returns nil when the op writes no value", func(t *testing.T) {
		op := covinteriorOp("no-value", "set_attribute")
		op.Params = []manifests.Param{covinteriorInvParam(),
			{Name: "which", Source: "user_input", Role: "selector", MatchAttr: "name"}}
		if vp := firstValueParam(op); vp != nil {
			t.Fatalf("firstValueParam = %q, want nil", vp.Name)
		}
	})

	t.Run("plannedSelectorFor binds the selector param to its requested value", func(t *testing.T) {
		op := covinteriorOp("sel", "set_attribute")
		op.Params = []manifests.Param{covinteriorInvParam(),
			{Name: "index_name", Source: "user_input", Role: "selector", MatchAttr: "name"}}
		sel := plannedSelectorFor(op, covinteriorReq(map[string]any{"index_name": 7}))
		if sel == nil || sel.matchAttr != "name" || sel.value != "7" {
			t.Fatalf("plannedSelectorFor = %#v, want name=7 (fmt.Sprint-canonical)", sel)
		}
		if got := plannedSelectorFor(covinteriorOp("nosel", "set_attribute"), covinteriorReq(nil)); got != nil {
			t.Fatalf("plannedSelectorFor with no selector param = %#v, want nil", got)
		}
	})

	t.Run("foreachMapAttrName accepts only a bare resource block attribute", func(t *testing.T) {
		cases := []struct {
			block    string
			wantAttr string
			wantOK   bool
		}{
			{block: "tags", wantAttr: "tags", wantOK: true},
			{block: ""},
			{block: "local.tags"},
			{block: "aws_instance.a.tags"},
		}
		for _, c := range cases {
			op := covinteriorOp("foreach", "append_foreach_entry")
			op.Target.Block = c.block
			attr, ok := foreachMapAttrName(op)
			if ok != c.wantOK || attr != c.wantAttr {
				t.Fatalf("foreachMapAttrName(block=%q) = (%q,%v), want (%q,%v)", c.block, attr, ok, c.wantAttr, c.wantOK)
			}
		}
	})

	t.Run("foreachKeyValParams takes the first two non-inventory value params", func(t *testing.T) {
		op := covinteriorOp("foreach", "append_foreach_entry")
		op.Params = []manifests.Param{
			covinteriorInvParam(),
			{Name: "which", Source: "user_input", Role: "selector", MatchAttr: "name"},
			{Name: "app_type", Source: "allowlist", Role: "discriminator"},
			{Name: "key", Source: "user_input"},
			{Name: "value", Source: "user_input"},
			{Name: "extra", Source: "user_input"},
		}
		k, v := foreachKeyValParams(op)
		if k == nil || v == nil || k.Name != "key" || v.Name != "value" {
			t.Fatalf("foreachKeyValParams = (%v,%v), want (key,value)", k, v)
		}

		one := covinteriorOp("foreach-one", "append_foreach_entry")
		one.Params = []manifests.Param{covinteriorInvParam(), {Name: "key", Source: "user_input"}}
		k, v = foreachKeyValParams(one)
		if k == nil || k.Name != "key" || v != nil {
			t.Fatalf("foreachKeyValParams(one param) = (%v,%v), want (key,nil)", k, v)
		}

		none := covinteriorOp("foreach-none", "append_foreach_entry")
		none.Params = []manifests.Param{covinteriorInvParam()}
		if k, v = foreachKeyValParams(none); k != nil || v != nil {
			t.Fatalf("foreachKeyValParams(no params) = (%v,%v), want (nil,nil)", k, v)
		}
	})

	t.Run("isGrowOnly reads bounds.growOnly defensively", func(t *testing.T) {
		if isGrowOnly(nil) {
			t.Fatal("isGrowOnly(nil) = true, want false")
		}
		if isGrowOnly(&manifests.Param{Name: "x"}) {
			t.Fatal("isGrowOnly(no bounds) = true, want false")
		}
		if isGrowOnly(&manifests.Param{Name: "x", Bounds: &manifests.Bounds{}}) {
			t.Fatal("isGrowOnly(bounds without growOnly) = true, want false")
		}
		if !isGrowOnly(&manifests.Param{Name: "x", Bounds: &manifests.Bounds{GrowOnly: true}}) {
			t.Fatal("isGrowOnly(growOnly) = false, want true")
		}
	})

	t.Run("writesListValue covers wrap:list and list-typed request values", func(t *testing.T) {
		req := covinteriorReq(map[string]any{"subnets": []any{"subnet-1"}, "name": "x"})
		if writesListValue(nil, req) {
			t.Fatal("writesListValue(nil) = true, want false")
		}
		if !writesListValue(&manifests.Param{Name: "arn", Wrap: "list"}, req) {
			t.Fatal(`writesListValue(wrap:"list") = false, want true`)
		}
		if !writesListValue(&manifests.Param{Name: "subnets"}, req) {
			t.Fatal("writesListValue(list-valued request param) = false, want true")
		}
		if writesListValue(&manifests.Param{Name: "name"}, req) {
			t.Fatal("writesListValue(scalar request param) = true, want false")
		}
		if writesListValue(&manifests.Param{Name: "absent"}, req) {
			t.Fatal("writesListValue(absent request param) = true, want false")
		}
	})
}

// ── cover/path primitives ─────────────────────────────────────────────────────

func TestCovinteriorCoverPrimitives(t *testing.T) {
	t.Run("resolveCover prefers after, falls back to before, else reports why", func(t *testing.T) {
		d := declaredChange{keyPath: []string{"metadata_options", "http_tokens"}}
		after := map[string]any{"metadata_options": []any{
			map[string]any{"http_tokens": "a"},
			map[string]any{"http_tokens": "b"},
		}}
		before := map[string]any{"metadata_options": []any{map[string]any{"http_tokens": "a"}}}

		covers, ok, reason := resolveCover(d, before, map[string]any{"metadata_options": []any{map[string]any{"http_tokens": "x"}}})
		if !ok || len(covers) != 1 || pathStr(covers[0].path) != "metadata_options[0].http_tokens" {
			t.Fatalf("resolveCover(after resolvable) = (%v,%v,%q)", covers, ok, reason)
		}

		// after is ambiguous (repeated block, no selector) → fall back to before.
		covers, ok, reason = resolveCover(d, before, after)
		if !ok || len(covers) != 1 || pathStr(covers[0].path) != "metadata_options[0].http_tokens" {
			t.Fatalf("resolveCover(before fallback) = (%v,%v,%q)", covers, ok, reason)
		}

		covers, ok, reason = resolveCover(d, map[string]any{}, map[string]any{})
		if ok || covers != nil {
			t.Fatalf("resolveCover(unlocatable) = (%v,%v), want (nil,false)", covers, ok)
		}
		want := "declared interior metadata_options.http_tokens could not be located in the plan before/after tree"
		if reason != want {
			t.Fatalf("reason = %q, want %q", reason, want)
		}
	})

	t.Run("coveredBy is exact for a leaf cover and prefix for a subtree cover", func(t *testing.T) {
		leafCover := []coverPath{{path: []any{"tags"}}}
		subtreeCover := []coverPath{{path: []any{"tags"}, subtree: true}}
		cases := []struct {
			name   string
			leaf   []any
			covers []coverPath
			want   bool
		}{
			{name: "exact leaf match", leaf: []any{"tags"}, covers: leafCover, want: true},
			{name: "deeper leaf is not covered by a leaf cover", leaf: []any{"tags", "Env"}, covers: leafCover},
			{name: "shorter leaf is not covered by a leaf cover", leaf: nil, covers: leafCover},
			{name: "sibling leaf is not covered", leaf: []any{"tags_other"}, covers: leafCover},
			{name: "deeper leaf is covered by a subtree cover", leaf: []any{"tags", "Env"}, covers: subtreeCover, want: true},
			{name: "the subtree root itself is covered", leaf: []any{"tags"}, covers: subtreeCover, want: true},
			{name: "a shorter path is not inside the subtree", leaf: nil, covers: subtreeCover},
			{name: "indices compare by rendered form", leaf: []any{"rule", 0, "days"}, covers: []coverPath{{path: []any{"rule", 0, "days"}}}, want: true},
			{name: "a different index is not covered", leaf: []any{"rule", 1, "days"}, covers: []coverPath{{path: []any{"rule", 0, "days"}}}},
			{name: "no covers at all covers nothing", leaf: []any{"tags"}},
		}
		for _, c := range cases {
			if got := coveredBy(c.leaf, c.covers); got != c.want {
				t.Fatalf("%s: coveredBy(%v) = %v, want %v", c.name, c.leaf, got, c.want)
			}
		}
	})

	t.Run("pathsEqual and hasPrefix compare segment-wise on rendered form", func(t *testing.T) {
		if pathsEqual([]any{"a"}, []any{"a", "b"}) {
			t.Fatal("pathsEqual with different lengths = true, want false")
		}
		if !pathsEqual([]any{"a", 1}, []any{"a", 1}) {
			t.Fatal("pathsEqual with equal paths = false, want true")
		}
		if pathsEqual([]any{"a", 1}, []any{"a", 2}) {
			t.Fatal("pathsEqual with a different index = true, want false")
		}
		if hasPrefix([]any{"a"}, []any{"a", "b"}) {
			t.Fatal("hasPrefix with a longer prefix = true, want false")
		}
		if !hasPrefix([]any{"a", "b", 0}, []any{"a", "b"}) {
			t.Fatal("hasPrefix with a real prefix = false, want true")
		}
		if hasPrefix([]any{"a", "b"}, []any{"a", "c"}) {
			t.Fatal("hasPrefix with a diverging prefix = true, want false")
		}
	})

	t.Run("path renderers", func(t *testing.T) {
		if got := pathStr([]any{"rule", 0, "lifecycle", 2, "days"}); got != "rule[0].lifecycle[2].days" {
			t.Fatalf("pathStr = %q", got)
		}
		if got := pathStr(nil); got != "" {
			t.Fatalf("pathStr(nil) = %q, want empty", got)
		}
		if got := pathStr([]any{0, "a"}); got != "[0].a" {
			t.Fatalf("pathStr(leading index) = %q, want %q", got, "[0].a")
		}
		if got := keyStr([]string{"a", "b", "c"}); got != "a.b.c" {
			t.Fatalf("keyStr = %q", got)
		}
		if got := declaredStr([]declaredChange{{keyPath: []string{"a", "b"}}, {keyPath: []string{"c"}}}); got != "a.b, c" {
			t.Fatalf("declaredStr = %q", got)
		}
		if got := declaredStr(nil); got != "" {
			t.Fatalf("declaredStr(nil) = %q, want empty", got)
		}
		if got := showVal(nil); got != "null" {
			t.Fatalf("showVal(nil) = %q, want null", got)
		}
		if got := showVal(20.0); got != `"20"` {
			t.Fatalf("showVal(20.0) = %q, want %q", got, `"20"`)
		}
	})

	t.Run("withSeg never aliases the base path", func(t *testing.T) {
		base := []string{"root_block_device"}
		a := withSeg(base, "tags")
		b := withSeg(base, "encrypted")
		if keyStr(a) != "root_block_device.tags" || keyStr(b) != "root_block_device.encrypted" {
			t.Fatalf("withSeg aliased the base: a=%v b=%v", a, b)
		}
		if len(base) != 1 {
			t.Fatalf("withSeg mutated base: %v", base)
		}
	})
}
