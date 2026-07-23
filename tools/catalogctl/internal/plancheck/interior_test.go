package plancheck

import (
	"strings"
	"testing"

	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/manifests"
	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/request"
)

// ── op builders ────────────────────────────────────────────────────────────────

// resizeOp mirrors ec2-resize: flat set_attribute whose attribute resolves via
// AttrFor (the terraformCapability paren token "stop/start" is not a bare ident).
func resizeOp() manifests.Op {
	op := manifests.Op{ID: "ec2-resize", Macd: "Change", CodemodOp: "set_attribute", TerraformCapability: "~ update (stop/start)"}
	op.Target.ResourceType = "aws_instance"
	op.Params = []manifests.Param{
		{Name: "instance", Source: "inventory"},
		{Name: "new_instance_type", Source: "allowlist"},
	}
	return op
}

// toggleOp mirrors the dozens of ec2 toggle ops: the attribute name comes from the
// terraformCapability paren token, NOT from the "enabled" value param.
func toggleOp() manifests.Op {
	op := manifests.Op{ID: "ec2-toggle-termination-protection", Macd: "Change", CodemodOp: "set_attribute",
		TerraformCapability: "~ update (disable_api_termination)"}
	op.Target.ResourceType = "aws_instance"
	op.Params = []manifests.Param{
		{Name: "instance", Source: "inventory"},
		{Name: "enabled", Source: "allowlist", Type: "bool"},
	}
	return op
}

// imdsOp mirrors ec2-set-imds-http-tokens: nested set_attribute (path set), attr via
// AttrFor on the value param (the paren token is ignored for nested ops).
func imdsOp() manifests.Op {
	op := manifests.Op{ID: "ec2-set-imds-http-tokens", Macd: "Change", CodemodOp: "set_attribute",
		TerraformCapability: "~ update (metadata_options.http_tokens)"}
	op.Target.ResourceType = "aws_instance"
	op.Target.Path = []string{"metadata_options"}
	op.Params = []manifests.Param{
		{Name: "instance", Source: "inventory"},
		{Name: "http_tokens", Source: "allowlist"},
	}
	return op
}

// foreachNestedOp mirrors fx-append-foreach-nested: add a key to root_block_device.tags.
func foreachNestedOp() manifests.Op {
	op := manifests.Op{ID: "fx-append-foreach-nested", Macd: "Add", CodemodOp: "append_foreach_entry"}
	op.Target.ResourceType = "aws_instance"
	op.Target.Block = "tags"
	op.Target.Path = []string{"root_block_device"}
	op.Params = []manifests.Param{
		{Name: "target", Source: "inventory"},
		{Name: "key", Source: "user_input"},
		{Name: "value", Source: "user_input"},
	}
	return op
}

// gsiGrowOp mirrors the nested selector-keyed grow-only op: read_capacity inside the
// global_secondary_index selected by name.
func gsiGrowOp() manifests.Op {
	max := 40000.0
	min := 1.0
	op := manifests.Op{ID: "r6-grow-gsi-read-capacity", Macd: "Change", CodemodOp: "set_attribute"}
	op.Target.ResourceType = "aws_dynamodb_table"
	op.Target.Path = []string{"global_secondary_index"}
	op.Params = []manifests.Param{
		{Name: "table", Source: "inventory"},
		{Name: "index_name", Source: "user_input", Role: "selector", MatchAttr: "name"},
		{Name: "new_read_capacity", Source: "user_input", Attr: "read_capacity", Bounds: &manifests.Bounds{Min: &min, Max: &max, GrowOnly: true}},
	}
	return op
}

func update(addr string, before, after, afterUnknown map[string]any) ResourceChange {
	c := Change{Actions: []string{"update"}, Before: before, After: after}
	if afterUnknown != nil {
		c.AfterUnknown = afterUnknown
	}
	return ResourceChange{Address: addr, Change: c}
}

func ruleSet(vs []Violation) []string {
	out := make([]string, len(vs))
	for i, v := range vs {
		out[i] = v.Rule
	}
	return out
}

func joinInfo(info []string) string { return strings.Join(info, "\n") }

// ── checkInterior (R6a + R6b) ──────────────────────────────────────────────────

func TestCheckInterior(t *testing.T) {
	inst := "aws_instance.a"
	tests := []struct {
		name      string
		op        manifests.Op
		params    map[string]any
		change    ResourceChange
		wantRules []string
		infoHas   string // substring required in an INFO line ("" ⇒ no INFO expected)
	}{
		{
			name:   "confined flat set_attribute is clean",
			op:     resizeOp(),
			params: map[string]any{"instance": inst, "new_instance_type": "c6i.2xlarge"},
			change: update(inst, map[string]any{"instance_type": "c5.large"}, map[string]any{"instance_type": "c6i.2xlarge"}, nil),
		},
		{
			name:   "provider noise (tags_all subtree, id) is excluded",
			op:     resizeOp(),
			params: map[string]any{"instance": inst, "new_instance_type": "c6i.2xlarge"},
			change: update(inst,
				map[string]any{"instance_type": "c5.large", "tags_all": map[string]any{"a": "1"}, "id": "i-old"},
				map[string]any{"instance_type": "c6i.2xlarge", "tags_all": map[string]any{"a": "1", "b": "2"}, "id": "i-old"}, nil),
		},
		{
			name:      "undeclared attr change is interior-escape",
			op:        resizeOp(),
			params:    map[string]any{"instance": inst, "new_instance_type": "c6i.2xlarge"},
			change:    update(inst, map[string]any{"instance_type": "c5.large", "monitoring": false}, map[string]any{"instance_type": "c6i.2xlarge", "monitoring": true}, nil),
			wantRules: []string{"interior-escape"},
		},
		{
			name:      "after != requested is value-mismatch",
			op:        resizeOp(),
			params:    map[string]any{"instance": inst, "new_instance_type": "c6i.2xlarge"},
			change:    update(inst, map[string]any{"instance_type": "c5.large"}, map[string]any{"instance_type": "r6i.large"}, nil),
			wantRules: []string{"value-mismatch"},
		},
		{
			name:    "computed after (after_unknown) is INFO, not a violation",
			op:      resizeOp(),
			params:  map[string]any{"instance": inst, "new_instance_type": "c6i.2xlarge"},
			change:  update(inst, map[string]any{"instance_type": "c5.large"}, map[string]any{"instance_type": nil}, map[string]any{"instance_type": true}),
			infoHas: "known only after apply",
		},
		{
			name:   "toggle op resolves its attr from the paren token, not the value param",
			op:     toggleOp(),
			params: map[string]any{"instance": inst, "enabled": true},
			change: update(inst, map[string]any{"disable_api_termination": false}, map[string]any{"disable_api_termination": true}, nil),
		},
		{
			name:   "nested set_attribute confined to the declared leaf is clean",
			op:     imdsOp(),
			params: map[string]any{"instance": inst, "http_tokens": "required"},
			change: update(inst,
				map[string]any{"metadata_options": []any{map[string]any{"http_tokens": "optional", "http_endpoint": "enabled"}}},
				map[string]any{"metadata_options": []any{map[string]any{"http_tokens": "required", "http_endpoint": "enabled"}}}, nil),
		},
		{
			name:   "wrong nested attr trips BOTH interior-escape and value-mismatch",
			op:     imdsOp(),
			params: map[string]any{"instance": inst, "http_tokens": "required"},
			change: update(inst,
				map[string]any{"metadata_options": []any{map[string]any{"http_tokens": "optional", "http_endpoint": "enabled"}}},
				map[string]any{"metadata_options": []any{map[string]any{"http_tokens": "optional", "http_endpoint": "disabled"}}}, nil),
			wantRules: []string{"interior-escape", "value-mismatch"},
		},
		{
			name:   "foreach map add is confined to the new key",
			op:     foreachNestedOp(),
			params: map[string]any{"target": inst, "key": "Snap", "value": "daily"},
			change: update(inst,
				map[string]any{"root_block_device": []any{map[string]any{"tags": map[string]any{"Name": "root"}}}},
				map[string]any{"root_block_device": []any{map[string]any{"tags": map[string]any{"Name": "root", "Snap": "daily"}}}}, nil),
		},
		{
			name:   "foreach map add with the wrong value is value-mismatch",
			op:     foreachNestedOp(),
			params: map[string]any{"target": inst, "key": "Snap", "value": "daily"},
			change: update(inst,
				map[string]any{"root_block_device": []any{map[string]any{"tags": map[string]any{"Name": "root"}}}},
				map[string]any{"root_block_device": []any{map[string]any{"tags": map[string]any{"Name": "root", "Snap": "hourly"}}}}, nil),
			wantRules: []string{"value-mismatch"},
		},
		{
			name:   "selector picks the right sibling; a change in another sibling escapes",
			op:     gsiGrowOp(),
			params: map[string]any{"table": "aws_dynamodb_table.t", "index_name": "by-status", "new_read_capacity": 20},
			change: update("aws_dynamodb_table.t",
				map[string]any{"global_secondary_index": []any{
					map[string]any{"name": "by-status", "read_capacity": 5.0},
					map[string]any{"name": "by-date", "read_capacity": 10.0},
				}},
				map[string]any{"global_secondary_index": []any{
					map[string]any{"name": "by-status", "read_capacity": 20.0},
					map[string]any{"name": "by-date", "read_capacity": 99.0}, // wrong sibling changed
				}}, nil),
			wantRules: []string{"interior-escape"}, // by-date read_capacity is outside the by-status interior
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := &request.Request{Schema: "ccp.request/v1", Item: tt.op.ID, Params: tt.params}
			vs, info := checkInterior(tt.op, req, tt.change)
			got := ruleSet(vs)
			if strings.Join(got, ",") != strings.Join(tt.wantRules, ",") {
				t.Fatalf("rules = %v, want %v\ninfo: %s", got, tt.wantRules, joinInfo(info))
			}
			if tt.infoHas != "" && !strings.Contains(joinInfo(info), tt.infoHas) {
				t.Fatalf("info = %q, want a line containing %q", joinInfo(info), tt.infoHas)
			}
		})
	}
}

// TestR4Interior proves the 0013b R4 fix: grow-only reads its value at the target's
// INTERIOR path (nested, selector-keyed), where the pre-0013b top-level lookup was
// blind. Run through the public Check so R4's own code path is exercised.
func TestR4Interior(t *testing.T) {
	op := gsiGrowOp()
	ddb := "aws_dynamodb_table.t"
	mk := func(readcap float64) map[string]any {
		return map[string]any{"global_secondary_index": []any{
			map[string]any{"name": "by-status", "read_capacity": readcap},
			map[string]any{"name": "by-date", "read_capacity": 10.0},
		}}
	}

	// Grow 5 → 20: the interior read succeeds and R4 is clean (a top-level-only R4
	// would have emitted "cannot read numeric").
	req := &request.Request{Schema: "ccp.request/v1", Item: op.ID,
		Params: map[string]any{"table": ddb, "index_name": "by-status", "new_read_capacity": 20}}
	vs, _ := Check(Plan{ResourceChanges: []ResourceChange{update(ddb, mk(5), mk(20), nil)}}, op, req)
	if len(vs) != 0 {
		t.Fatalf("grow: want no violations, got %v", ruleSet(vs))
	}

	// Shrink 5 → 2: interior R4 fires grow-only.
	req2 := &request.Request{Schema: "ccp.request/v1", Item: op.ID,
		Params: map[string]any{"table": ddb, "index_name": "by-status", "new_read_capacity": 2}}
	vs2, _ := Check(Plan{ResourceChanges: []ResourceChange{update(ddb, mk(5), mk(2), nil)}}, op, req2)
	if len(vs2) == 0 || vs2[0].Rule != "grow-only" {
		t.Fatalf("shrink: want a grow-only violation, got %v", ruleSet(vs2))
	}
}
