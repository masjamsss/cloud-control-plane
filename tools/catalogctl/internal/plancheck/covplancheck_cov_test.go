package plancheck

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/manifests"
	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/request"
)

// covplancheck_cov_test.go closes the remaining gaps in plancheck.go (the top-level
// L2 verifier), command.go (the `plan-check` subcommand entrypoint: flag surface,
// plan JSON loading, and every exit-3 refusal) and publicingress.go's R7 tail.
//
// Exit codes are the contract (README "Safety model"): 0 clean · 2 PLAN_VIOLATION ·
// 3 resolution/schema. Everything here is hermetic — hand-built plans for Check,
// t.TempDir() files for run(); no network, no clock, no repo .git state.

// ── shared builders (all covplancheck-prefixed) ───────────────────────────────

func covplancheckInv(name string) manifests.Param {
	return manifests.Param{Name: name, Source: "inventory"}
}

func covplancheckReq(item string, params map[string]any) *request.Request {
	return &request.Request{Schema: "ccp.request/v1", Item: item, Params: params}
}

// covplancheckRules renders the violation rules in order, so a table can pin the
// exact set Check produced (Check never fails fast — order is part of the contract).
func covplancheckRules(vs []Violation) []string {
	out := make([]string, 0, len(vs))
	for _, v := range vs {
		out = append(out, v.Rule)
	}
	return out
}

func covplancheckReasons(vs []Violation) string {
	parts := make([]string, 0, len(vs))
	for _, v := range vs {
		parts = append(parts, v.String())
	}
	return strings.Join(parts, "\n")
}

func covplancheckUpd(addr string, before, after map[string]any) ResourceChange {
	return ResourceChange{Address: addr, Change: Change{Actions: []string{"update"}, Before: before, After: after}}
}

func covplancheckCreate(addr string) ResourceChange {
	return ResourceChange{Address: addr, Change: Change{Actions: []string{"create"}, Before: nil}}
}

func covplancheckNoop(addr string) ResourceChange {
	return ResourceChange{Address: addr, Change: Change{Actions: []string{"no-op"}}}
}

// covplancheckAssertRules fails unless Check produced exactly wantRules, in order.
func covplancheckAssertRules(t *testing.T, vs []Violation, wantRules []string) {
	t.Helper()
	got := covplancheckRules(vs)
	if strings.Join(got, ",") != strings.Join(wantRules, ",") {
		t.Fatalf("violation rules = %v, want %v\n%s", got, wantRules, covplancheckReasons(vs))
	}
}

// ── R1 instantiate_module + moduleName ────────────────────────────────────────

// TestCovplancheckInstantiateModuleAddressSubset pins allowSet's instantiate_module
// arm: the expected set is the module prefix itself plus everything beneath it, and
// the module label comes from the proposed_name/name param — never from the
// source:"inventory" param, even when that param is itself literally named "name".
func TestCovplancheckInstantiateModuleAddressSubset(t *testing.T) {
	// The inventory param is deliberately named "name" so a moduleName that forgot
	// to skip source:"inventory" would pick the address string as the module label.
	op := manifests.Op{ID: "net-instantiate-module", Macd: "Add", CodemodOp: "instantiate_module"}
	op.Params = []manifests.Param{
		{Name: "name", Source: "inventory"},
		{Name: "proposed_name", Source: "user_input"},
	}
	params := map[string]any{"name": "aws_vpc.existing", "proposed_name": "net_core"}

	tests := []struct {
		name       string
		plan       Plan
		wantRules  []string
		wantReason string
	}{
		{
			name:      "the module root itself is inside the expected set",
			plan:      Plan{ResourceChanges: []ResourceChange{covplancheckCreate("module.net_core")}},
			wantRules: nil,
		},
		{
			name:      "a resource beneath the module prefix is inside the expected set",
			plan:      Plan{ResourceChanges: []ResourceChange{covplancheckCreate("module.net_core.aws_vpc.this")}},
			wantRules: nil,
		},
		{
			name:       "an address outside the module prefix is address-subset",
			plan:       Plan{ResourceChanges: []ResourceChange{covplancheckCreate("aws_instance.rogue")}},
			wantRules:  []string{"address-subset"},
			wantReason: "outside the request target set {module.net_core.*}",
		},
		{
			name:       "a sibling module sharing a name prefix is NOT inside the set",
			plan:       Plan{ResourceChanges: []ResourceChange{covplancheckCreate("module.net_core_two.aws_vpc.this")}},
			wantRules:  []string{"address-subset"},
			wantReason: "{module.net_core.*}",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			vs, info := Check(tt.plan, op, covplancheckReq("net-instantiate-module", params))
			covplancheckAssertRules(t, vs, tt.wantRules)
			if len(info) != 0 {
				t.Fatalf("info = %v, want none", info)
			}
			if tt.wantReason != "" && !strings.Contains(vs[0].Reason, tt.wantReason) {
				t.Fatalf("reason = %q, want contains %q", vs[0].Reason, tt.wantReason)
			}
		})
	}
}

// TestCovplancheckModuleNameResolution pins moduleName's three arms directly: the
// inventory param is skipped, "proposed_name" and "name" both name the module, and a
// non-string value yields no label (fail-quiet — R1 then admits nothing useful, so a
// stray address still refuses).
func TestCovplancheckModuleNameResolution(t *testing.T) {
	mk := func(ps []manifests.Param, params map[string]any) (manifests.Op, *request.Request) {
		op := manifests.Op{ID: "mod", Macd: "Add", CodemodOp: "instantiate_module"}
		op.Params = ps
		return op, covplancheckReq("mod", params)
	}
	tests := []struct {
		name   string
		params []manifests.Param
		values map[string]any
		want   string
	}{
		{
			name:   "proposed_name wins",
			params: []manifests.Param{covplancheckInv("resource"), {Name: "proposed_name", Source: "user_input"}},
			values: map[string]any{"resource": "aws_vpc.x", "proposed_name": "net_core"},
			want:   "net_core",
		},
		{
			name:   "plain name param also names the module",
			params: []manifests.Param{{Name: "name", Source: "user_input"}},
			values: map[string]any{"name": "shared_vpc"},
			want:   "shared_vpc",
		},
		{
			name:   "an inventory param named name is skipped",
			params: []manifests.Param{{Name: "name", Source: "inventory"}},
			values: map[string]any{"name": "aws_vpc.existing"},
			want:   "",
		},
		{
			name:   "a non-string proposed_name yields no label",
			params: []manifests.Param{{Name: "proposed_name", Source: "user_input"}},
			values: map[string]any{"proposed_name": 42},
			want:   "",
		},
		{
			name:   "an unrelated param name is not a module label",
			params: []manifests.Param{{Name: "cidr", Source: "user_input"}},
			values: map[string]any{"cidr": "10.0.0.0/16"},
			want:   "",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			op, r := mk(tt.params, tt.values)
			if got := moduleName(op, r); got != tt.want {
				t.Fatalf("moduleName = %q, want %q", got, tt.want)
			}
		})
	}
}

// ── create-guard: conditional companions + the unkeyed createName fallback ────

// TestCovplancheckCreateConditionalCompanions pins the create-guard's conditional
// arm: an idiom companion whose param was not chosen is legally ABSENT from the
// plan, and one that appears as a no-op is not a change either — neither is a
// violation. A conditional that IS created still has its create shape asserted.
func TestCovplancheckCreateConditionalCompanions(t *testing.T) {
	op := manifests.Op{ID: "s3-create-bucket", Macd: "Add", CodemodOp: "create_resource"}
	op.Target.ResourceType = "aws_s3_bucket"
	op.Params = []manifests.Param{{Name: "bucket_name", Source: "user_input", Role: "key"}}

	const (
		bkt = "aws_s3_bucket.cov_bucket"
		pab = "aws_s3_bucket_public_access_block.cov_bucket"
		sse = "aws_s3_bucket_server_side_encryption_configuration.cov_bucket"
		ver = "aws_s3_bucket_versioning.cov_bucket"
		lif = "aws_s3_bucket_lifecycle_configuration.cov_bucket"
	)
	// Both conditionals are DECLARED by the request (versioning + lifecycle days),
	// so both are in the idiom's expected set — what varies below is the plan.
	params := map[string]any{"bucket_name": "cov-bucket", "versioning": true, "lifecycle_cleanup_days": 30}

	tests := []struct {
		name      string
		plan      Plan
		wantRules []string
	}{
		{
			name:      "an omitted conditional companion is legal",
			plan:      Plan{ResourceChanges: []ResourceChange{covplancheckCreate(bkt), covplancheckCreate(pab), covplancheckCreate(sse), covplancheckCreate(ver)}},
			wantRules: nil,
		},
		{
			name:      "a conditional companion planned as a no-op is not a change",
			plan:      Plan{ResourceChanges: []ResourceChange{covplancheckCreate(bkt), covplancheckCreate(pab), covplancheckCreate(sse), covplancheckCreate(ver), covplancheckNoop(lif)}},
			wantRules: nil,
		},
		{
			name: "a conditional companion planned as an update is not a pure create",
			plan: Plan{ResourceChanges: []ResourceChange{
				covplancheckCreate(bkt), covplancheckCreate(pab), covplancheckCreate(sse), covplancheckCreate(ver),
				covplancheckUpd(lif, map[string]any{"id": "x"}, map[string]any{"id": "x"}),
			}},
			// The update is in the idiom set (no address-subset), but it is neither
			// [create] nor before==null — both create-guard limbs fire.
			wantRules: []string{"create-guard", "create-guard"},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			vs, _ := Check(tt.plan, op, covplancheckReq("s3-create-bucket", params))
			covplancheckAssertRules(t, vs, tt.wantRules)
		})
	}
}

// TestCovplancheckCreateNameFallback pins createName's no-role:"key" fallback: the
// local name is idioms.TfLocalName(nil) — "new_resource" — the SAME sanitizer the
// verb uses, so R1 and the create-guard still agree on one concrete address rather
// than silently admitting everything.
func TestCovplancheckCreateNameFallback(t *testing.T) {
	op := manifests.Op{ID: "ec2-provision-instance", Macd: "Add", CodemodOp: "create_resource"}
	op.Target.ResourceType = "aws_instance"
	op.Params = []manifests.Param{{Name: "host_name", Source: "user_input"}} // no Role:"key"
	r := covplancheckReq("ec2-provision-instance", map[string]any{"host_name": "erp-app-02"})

	t.Run("the fallback address is the one accepted", func(t *testing.T) {
		plan := Plan{ResourceChanges: []ResourceChange{covplancheckCreate("aws_instance.new_resource")}}
		vs, _ := Check(plan, op, r)
		covplancheckAssertRules(t, vs, nil)
	})
	t.Run("the host_name-derived address is outside the set and the mandatory one is missing", func(t *testing.T) {
		plan := Plan{ResourceChanges: []ResourceChange{covplancheckCreate("aws_instance.erp_app_02")}}
		vs, _ := Check(plan, op, r)
		covplancheckAssertRules(t, vs, []string{"address-subset", "create-guard"})
		if !strings.Contains(vs[1].Reason, "mandatory idiom address is not created by the plan") {
			t.Fatalf("reason = %q, want the missing-mandatory reason", vs[1].Reason)
		}
		if vs[1].Address != "aws_instance.new_resource" {
			t.Fatalf("address = %q, want aws_instance.new_resource", vs[1].Address)
		}
	})
}

// ── R4 grow-only: the non-target skip and the unreadable-numeric refusal ──────

// TestCovplancheckGrowOnlyEdges pins the two R4 arms the fixtures miss: a changed
// address that is NOT the op's target is skipped by the grow-only loop entirely (R1
// is what refuses it), and a before/after the numeric cannot be read from is a
// grow-only VIOLATION rather than a silent pass.
func TestCovplancheckGrowOnlyEdges(t *testing.T) {
	op := manifests.Op{ID: "ebs-grow", Macd: "Change", CodemodOp: "set_attribute"}
	op.Target.ResourceType = "aws_ebs_volume"
	op.Params = []manifests.Param{
		covplancheckInv("volume"),
		{Name: "new_size_gib", Source: "user_input", Bounds: &manifests.Bounds{GrowOnly: true}},
	}
	r := covplancheckReq("ebs-grow", map[string]any{"volume": "aws_ebs_volume.v", "new_size_gib": 40})

	tests := []struct {
		name       string
		plan       Plan
		wantRules  []string
		wantReason string
	}{
		{
			name: "a non-target address is skipped by grow-only (R1 refuses it instead)",
			plan: Plan{ResourceChanges: []ResourceChange{
				covplancheckUpd("aws_ebs_volume.v", map[string]any{"size": 20.0}, map[string]any{"size": 40.0}),
				covplancheckUpd("aws_ebs_volume.other", map[string]any{"size": 1.0}, map[string]any{"size": 2.0}),
			}},
			wantRules:  []string{"address-subset"},
			wantReason: "changed address is outside the request target set",
		},
		{
			name: "an absent before value is an unreadable numeric, not a pass",
			plan: Plan{ResourceChanges: []ResourceChange{
				covplancheckUpd("aws_ebs_volume.v", map[string]any{}, map[string]any{"size": 40.0}),
			}},
			wantRules:  []string{"grow-only"},
			wantReason: `cannot read numeric "size" from plan before/after`,
		},
		{
			name: "a non-numeric after value is an unreadable numeric",
			plan: Plan{ResourceChanges: []ResourceChange{
				covplancheckUpd("aws_ebs_volume.v", map[string]any{"size": 20.0}, map[string]any{"size": true}),
			}},
			wantRules:  []string{"grow-only"},
			wantReason: `cannot read numeric "size" from plan before/after`,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			vs, _ := Check(tt.plan, op, r)
			covplancheckAssertRules(t, vs, tt.wantRules)
			if !strings.Contains(vs[0].Reason, tt.wantReason) {
				t.Fatalf("reason = %q, want contains %q", vs[0].Reason, tt.wantReason)
			}
		})
	}
}

// TestCovplancheckGrowOnlyIntegerRequestValue pins that a request value arriving as a
// Go int (a YAML-decoded integer) compares equal to the plan's float64 after — the
// grow-only "after == requested" limb must not false-positive on numeric type.
//
// Each shape is asserted in BOTH directions. The clean half alone would also pass if
// the coercion silently failed for that type (an unreadable request value makes the
// limb skip, so "no violation" is exactly what a broken toFloat produces); the
// mismatched half is what proves the value was actually read and compared.
func TestCovplancheckGrowOnlyIntegerRequestValue(t *testing.T) {
	op := manifests.Op{ID: "ebs-grow", Macd: "Change", CodemodOp: "set_attribute"}
	op.Target.ResourceType = "aws_ebs_volume"
	op.Params = []manifests.Param{
		covplancheckInv("volume"),
		{Name: "new_size_gib", Source: "user_input", Bounds: &manifests.Bounds{GrowOnly: true}},
	}
	plan := Plan{ResourceChanges: []ResourceChange{
		covplancheckUpd("aws_ebs_volume.v", map[string]any{"size": 20.0}, map[string]any{"size": 40.0}),
	}}
	check := func(val any) []Violation {
		vs, _ := Check(plan, op, covplancheckReq("ebs-grow",
			map[string]any{"volume": "aws_ebs_volume.v", "new_size_gib": val}))
		return vs
	}
	cases := []struct{ match, mismatch any }{
		{match: 40, mismatch: 41},
		{match: int64(40), mismatch: int64(41)},
		{match: 40.0, mismatch: 41.0},
		{match: "40", mismatch: "41"},
	}
	for _, tc := range cases {
		t.Run(fmt.Sprintf("%T", tc.match), func(t *testing.T) {
			covplancheckAssertRules(t, check(tc.match), nil)

			vs := check(tc.mismatch)
			covplancheckAssertRules(t, vs, []string{"grow-only"})
			if want := "size after 40 != requested 41"; !strings.Contains(vs[0].Reason, want) {
				t.Fatalf("reason = %q, want it to contain %q", vs[0].Reason, want)
			}
		})
	}
}

// ── R5 movedTo's non-"new_name" fallback ─────────────────────────────────────

// TestCovplancheckMovedToFallback pins movedTo: the destination label comes from
// params["new_name"] when present, else from the first non-inventory string param —
// so a rename op that names its param something else still gates against the right
// destination address instead of silently gating against "<type>.".
func TestCovplancheckMovedToFallback(t *testing.T) {
	op := manifests.Op{ID: "fx-moved", Macd: "Change", CodemodOp: "moved_block"}
	op.Params = []manifests.Param{covplancheckInv("resource"), {Name: "target_label", Source: "user_input"}}

	t.Run("the first non-inventory param supplies the destination label", func(t *testing.T) {
		plan := Plan{ResourceChanges: []ResourceChange{
			{Address: "aws_instance.b", PreviousAddress: "aws_instance.a", Change: Change{Actions: []string{"no-op"}}},
		}}
		r := covplancheckReq("fx-moved", map[string]any{"resource": "aws_instance.a", "target_label": "b"})
		vs, _ := Check(plan, op, r)
		covplancheckAssertRules(t, vs, nil)
	})

	t.Run("a moved entry to some other label is refused", func(t *testing.T) {
		plan := Plan{ResourceChanges: []ResourceChange{
			{Address: "aws_instance.c", PreviousAddress: "aws_instance.a", Change: Change{Actions: []string{"no-op"}}},
		}}
		r := covplancheckReq("fx-moved", map[string]any{"resource": "aws_instance.a", "target_label": "b"})
		vs, _ := Check(plan, op, r)
		covplancheckAssertRules(t, vs, []string{"moved-zero-delta"})
		if vs[0].Address != "aws_instance.b" {
			t.Fatalf("address = %q, want the derived destination aws_instance.b", vs[0].Address)
		}
		if !strings.Contains(vs[0].Reason, `previous_address "aws_instance.a" → address "aws_instance.b"`) {
			t.Fatalf("reason = %q, want the from→to link", vs[0].Reason)
		}
	})

	t.Run("new_name still beats the positional fallback", func(t *testing.T) {
		op2 := manifests.Op{ID: "fx-moved", Macd: "Change", CodemodOp: "moved_block"}
		op2.Params = []manifests.Param{covplancheckInv("resource"), {Name: "target_label", Source: "user_input"}}
		plan := Plan{ResourceChanges: []ResourceChange{
			{Address: "aws_instance.fromnewname", PreviousAddress: "aws_instance.a", Change: Change{Actions: []string{"no-op"}}},
		}}
		r := covplancheckReq("fx-moved", map[string]any{
			"resource": "aws_instance.a", "target_label": "ignored", "new_name": "fromnewname",
		})
		vs, _ := Check(plan, op2, r)
		covplancheckAssertRules(t, vs, nil)
	})

	t.Run("a non-string fallback param leaves the destination unlabelled and refuses", func(t *testing.T) {
		plan := Plan{ResourceChanges: []ResourceChange{
			{Address: "aws_instance.b", PreviousAddress: "aws_instance.a", Change: Change{Actions: []string{"no-op"}}},
		}}
		r := covplancheckReq("fx-moved", map[string]any{"resource": "aws_instance.a", "target_label": 7})
		vs, _ := Check(plan, op, r)
		covplancheckAssertRules(t, vs, []string{"moved-zero-delta"})
	})
}

// ── changed() / toFloat() primitives ─────────────────────────────────────────

// TestCovplancheckChangedPredicate pins changed(): an EMPTY actions slice is not a
// change (a plan entry Terraform emitted with nothing to do must not trip R1), and
// neither is a lone no-op or read.
func TestCovplancheckChangedPredicate(t *testing.T) {
	cases := []struct {
		name    string
		actions []string
		want    bool
	}{
		{name: "nil actions", actions: nil, want: false},
		{name: "empty actions", actions: []string{}, want: false},
		{name: "lone no-op", actions: []string{"no-op"}, want: false},
		{name: "lone read", actions: []string{"read"}, want: false},
		{name: "update", actions: []string{"update"}, want: true},
		{name: "create", actions: []string{"create"}, want: true},
		{name: "delete then create", actions: []string{"delete", "create"}, want: true},
		{name: "no-op alongside a real action", actions: []string{"no-op", "update"}, want: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := changed(tc.actions); got != tc.want {
				t.Fatalf("changed(%v) = %v, want %v", tc.actions, got, tc.want)
			}
		})
	}

	t.Run("an actionless entry at a rogue address does not trip R1", func(t *testing.T) {
		op := manifests.Op{ID: "ec2-resize", Macd: "Change", CodemodOp: "set_attribute"}
		op.Target.ResourceType = "aws_instance"
		op.Params = []manifests.Param{covplancheckInv("instance"), {Name: "new_instance_type", Source: "allowlist"}}
		plan := Plan{ResourceChanges: []ResourceChange{{Address: "aws_instance.rogue", Change: Change{}}}}
		vs, _ := Check(plan, op, covplancheckReq("ec2-resize", map[string]any{"instance": "aws_instance.a"}))
		covplancheckAssertRules(t, vs, nil)
	})
}

// TestCovplancheckToFloat pins the numeric coercion R4 reads plan (float64) and
// request (YAML int / string) values through — every accepted arm plus the two
// rejected shapes, which is what makes "cannot read numeric" fire rather than a
// silent zero comparing as a shrink.
func TestCovplancheckToFloat(t *testing.T) {
	cases := []struct {
		name string
		in   any
		want float64
		ok   bool
	}{
		{name: "float64", in: 40.5, want: 40.5, ok: true},
		{name: "float32", in: float32(2.5), want: 2.5, ok: true},
		{name: "int", in: 40, want: 40, ok: true},
		{name: "int64", in: int64(2700), want: 2700, ok: true},
		{name: "numeric string", in: "40", want: 40, ok: true},
		{name: "non-numeric string", in: "forty", want: 0, ok: false},
		{name: "bool", in: true, want: 0, ok: false},
		{name: "nil", in: nil, want: 0, ok: false},
		{name: "map", in: map[string]any{"size": 1.0}, want: 0, ok: false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := toFloat(tc.in)
			if ok != tc.ok || got != tc.want {
				t.Fatalf("toFloat(%#v) = (%v, %v), want (%v, %v)", tc.in, got, ok, tc.want, tc.ok)
			}
		})
	}
}

// ── R7 publicingress tail ────────────────────────────────────────────────────

// TestCovplancheckPublicIngressTail closes publicingress.go's remaining arms: a
// malformed (non-map) inline ingress entry must be skipped WITHOUT masking a
// world-open sibling block, and the standalone ingress-rule resource's cidr_ipv6
// scalar is a source just like cidr_ipv4.
func TestCovplancheckPublicIngressTail(t *testing.T) {
	op := manifests.Op{ID: "sg-add-internal-ingress-rule", Macd: "Add", CodemodOp: "append_block", Exposure: "l1_with_guardrails"}
	op.Target.ResourceType = "aws_security_group"
	op.Params = []manifests.Param{covplancheckInv("security_group")}

	tests := []struct {
		name     string
		plan     Plan
		wantN    int
		wantCIDR string
	}{
		{
			name: "a non-map ingress entry is skipped but its world-open sibling still fires",
			plan: Plan{ResourceChanges: []ResourceChange{{
				Address: "aws_security_group.web",
				Change: Change{
					Actions: []string{"update"},
					Before:  map[string]any{"ingress": []any{}},
					After: map[string]any{"ingress": []any{
						"not-a-block",
						map[string]any{"cidr_blocks": []any{"0.0.0.0/0"}},
					}},
				},
			}}},
			wantN:    1,
			wantCIDR: "0.0.0.0/0",
		},
		{
			name: "only a non-map ingress entry ⇒ clean (nothing readable to flag)",
			plan: Plan{ResourceChanges: []ResourceChange{{
				Address: "aws_security_group.web",
				Change: Change{
					Actions: []string{"update"},
					Before:  map[string]any{"ingress": []any{}},
					After:   map[string]any{"ingress": []any{"not-a-block", 7.0}},
				},
			}}},
			wantN: 0,
		},
		{
			name: "standalone rule cidr_ipv6 ::/0 introduced ⇒ violation",
			plan: Plan{ResourceChanges: []ResourceChange{{
				Address: "aws_vpc_security_group_ingress_rule.open6",
				Change: Change{
					Actions: []string{"create"},
					Before:  nil,
					After:   map[string]any{"cidr_ipv6": "::/0"},
				},
			}}},
			wantN:    1,
			wantCIDR: "::/0",
		},
		{
			name: "standalone rule with a pre-existing ::/0 kept ⇒ clean (not introduced)",
			plan: Plan{ResourceChanges: []ResourceChange{{
				Address: "aws_vpc_security_group_ingress_rule.open6",
				Change: Change{
					Actions: []string{"update"},
					Before:  map[string]any{"cidr_ipv6": "::/0"},
					After:   map[string]any{"cidr_ipv6": "::/0"},
				},
			}}},
			wantN: 0,
		},
		{
			name: "standalone rule internal cidr_ipv6 ⇒ clean",
			plan: Plan{ResourceChanges: []ResourceChange{{
				Address: "aws_vpc_security_group_ingress_rule.db6",
				Change: Change{
					Actions: []string{"create"},
					Before:  nil,
					After:   map[string]any{"cidr_ipv6": "fd00::/8"},
				},
			}}},
			wantN: 0,
		},
		{
			name: "both cidr_ipv4 and cidr_ipv6 world-open ⇒ two violations",
			plan: Plan{ResourceChanges: []ResourceChange{{
				Address: "aws_vpc_security_group_ingress_rule.both",
				Change: Change{
					Actions: []string{"create"},
					Before:  nil,
					After:   map[string]any{"cidr_ipv4": "0.0.0.0/0", "cidr_ipv6": "::/0"},
				},
			}}},
			wantN: 2,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := checkPublicIngress(op, tt.plan)
			if len(got) != tt.wantN {
				t.Fatalf("violations = %d %v, want %d", len(got), got, tt.wantN)
			}
			for _, v := range got {
				if v.Rule != "no-public-ingress" {
					t.Fatalf("rule = %q, want no-public-ingress", v.Rule)
				}
			}
			if tt.wantCIDR != "" && !strings.Contains(got[0].Reason, tt.wantCIDR) {
				t.Fatalf("reason = %q, want contains %q", got[0].Reason, tt.wantCIDR)
			}
		})
	}
}

// TestCovplancheckResourceTypeDegenerate pins resourceType's two tail arms: an
// address that is a bare type (no ".name") returns that type, and a truncated
// module path that never reaches a resource type returns "" — which makes R7 skip
// the entry rather than mis-classify it as a security group.
func TestCovplancheckResourceTypeDegenerate(t *testing.T) {
	cases := map[string]string{
		"aws_security_group":            "aws_security_group",
		"":                              "",
		"module.net":                    "",
		"module.":                       "",
		"module.a.module.b":             "",
		"module.net.aws_security_group": "aws_security_group",
	}
	for in, want := range cases {
		t.Run("address="+in, func(t *testing.T) {
			if got := resourceType(in); got != want {
				t.Fatalf("resourceType(%q) = %q, want %q", in, got, want)
			}
		})
	}

	t.Run("a truncated module address is not treated as a security group", func(t *testing.T) {
		op := manifests.Op{ID: "sg", Macd: "Add", CodemodOp: "append_block", Exposure: "l1_with_guardrails"}
		plan := Plan{ResourceChanges: []ResourceChange{{
			Address: "module.net",
			Change:  Change{Actions: []string{"update"}, After: map[string]any{"cidr_ipv4": "0.0.0.0/0"}},
		}}}
		if got := checkPublicIngress(op, plan); len(got) != 0 {
			t.Fatalf("violations = %v, want none", got)
		}
	})
}

// ── command.go: the `plan-check` entrypoint and its exit codes ───────────────

const covplancheckReqYAML = "schema: ccp.request/v1\n" +
	"id: REQ-01JZTC4QWERTY0123456789C0V\n" +
	"item: ec2-resize\n" +
	"params:\n" +
	"  instance: aws_instance.a\n" +
	"  new_instance_type: c6i.2xlarge\n"

// covplancheckWrite drops body at <t.TempDir()>/name and returns the path.
func covplancheckWrite(t *testing.T, name, body string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

// covplancheckRun invokes the real subcommand entrypoint and returns its exit code
// plus both streams.
func covplancheckRun(args ...string) (code int, stdout, stderr string) {
	var out, errb bytes.Buffer
	code = run(args, &out, &errb)
	return code, out.String(), errb.String()
}

// TestCovplancheckRunFlagSurface pins the flag contract: an unknown flag is a
// resolution error (exit 3), the parity-only --rules flag is accepted and ignored,
// and an unresolvable --estate-tz refuses at startup BEFORE any verdict is produced.
func TestCovplancheckRunFlagSurface(t *testing.T) {
	const mdir = "../../testdata/manifests"
	cleanPlan := func(t *testing.T) string {
		return covplancheckWrite(t, "plan.json",
			`{"format_version":"1.2","resource_changes":[{"address":"aws_instance.a","change":{"actions":["update"]}}]}`)
	}

	t.Run("an unknown flag exits 3", func(t *testing.T) {
		code, _, errb := covplancheckRun("--not-a-flag", "x")
		if code != 3 {
			t.Fatalf("code = %d, want 3 (stderr=%q)", code, errb)
		}
		if !strings.Contains(errb, "not-a-flag") {
			t.Fatalf("stderr = %q, want it to name the offending flag", errb)
		}
	})

	t.Run("--rules is accepted for CLI parity and ignored", func(t *testing.T) {
		code, _, errb := covplancheckRun(
			"--plan", cleanPlan(t),
			"--request", covplancheckWrite(t, "request.yaml", covplancheckReqYAML),
			"--manifests", mdir,
			"--rules", "unused.json")
		if code != 0 {
			t.Fatalf("code = %d, want 0 (stderr=%q)", code, errb)
		}
	})

	t.Run("an unresolvable --estate-tz exits 3 before any verdict", func(t *testing.T) {
		code, out, errb := covplancheckRun(
			"--plan", cleanPlan(t),
			"--request", covplancheckWrite(t, "request.yaml", covplancheckReqYAML),
			"--manifests", mdir,
			"--estate-tz", "Not/AZone")
		if code != 3 {
			t.Fatalf("code = %d, want 3 (stderr=%q)", code, errb)
		}
		if !strings.Contains(errb, "estate-config") || !strings.Contains(errb, "Not/AZone") {
			t.Fatalf("stderr = %q, want the estate-config startup error naming the zone", errb)
		}
		if out != "" {
			t.Fatalf("stdout = %q, want nothing printed before the config refusal", out)
		}
	})

	t.Run("a valid --estate-tz still reaches the verdict", func(t *testing.T) {
		code, _, errb := covplancheckRun(
			"--plan", cleanPlan(t),
			"--request", covplancheckWrite(t, "request.yaml", covplancheckReqYAML),
			"--manifests", mdir,
			"--estate-tz", "Europe/London")
		if code != 0 {
			t.Fatalf("code = %d, want 0 (stderr=%q)", code, errb)
		}
	})
}

// TestCovplancheckRunResolutionErrors pins every exit-3 refusal on the ordinary
// (YAML request + ServiceManifest) path: an unreadable plan, a plan missing
// format_version, an unreadable request, and a manifests directory that does not
// load. Each must name its own cause on stderr — never a confusing surrogate.
func TestCovplancheckRunResolutionErrors(t *testing.T) {
	const mdir = "../../testdata/manifests"
	goodReq := func(t *testing.T) string { return covplancheckWrite(t, "request.yaml", covplancheckReqYAML) }
	goodPlan := func(t *testing.T) string {
		return covplancheckWrite(t, "plan.json", `{"format_version":"1.2","resource_changes":[]}`)
	}

	t.Run("a missing plan file exits 3", func(t *testing.T) {
		missing := filepath.Join(t.TempDir(), "absent-plan.json")
		code, _, errb := covplancheckRun("--plan", missing, "--request", goodReq(t), "--manifests", mdir)
		if code != 3 {
			t.Fatalf("code = %d, want 3 (stderr=%q)", code, errb)
		}
		if !strings.Contains(errb, "absent-plan.json") {
			t.Fatalf("stderr = %q, want it to name the unreadable plan path", errb)
		}
	})

	t.Run("a plan missing format_version exits 3", func(t *testing.T) {
		code, _, errb := covplancheckRun(
			"--plan", covplancheckWrite(t, "plan.json", `{"resource_changes":[]}`),
			"--request", goodReq(t), "--manifests", mdir)
		if code != 3 {
			t.Fatalf("code = %d, want 3 (stderr=%q)", code, errb)
		}
		if !strings.Contains(errb, "missing format_version") {
			t.Fatalf("stderr = %q, want the missing format_version error", errb)
		}
	})

	t.Run("a plan whose JSON is malformed exits 3 naming the parse", func(t *testing.T) {
		code, _, errb := covplancheckRun(
			"--plan", covplancheckWrite(t, "plan.json", `{"format_version": `),
			"--request", goodReq(t), "--manifests", mdir)
		if code != 3 {
			t.Fatalf("code = %d, want 3 (stderr=%q)", code, errb)
		}
		if !strings.Contains(errb, "parse plan json") {
			t.Fatalf("stderr = %q, want the parse plan json error", errb)
		}
	})

	t.Run("a missing request file exits 3", func(t *testing.T) {
		missing := filepath.Join(t.TempDir(), "absent-request.yaml")
		code, _, errb := covplancheckRun("--plan", goodPlan(t), "--request", missing, "--manifests", mdir)
		if code != 3 {
			t.Fatalf("code = %d, want 3 (stderr=%q)", code, errb)
		}
		if !strings.Contains(errb, "absent-request.yaml") {
			t.Fatalf("stderr = %q, want it to name the unreadable request path", errb)
		}
	})

	t.Run("a request that is not a ccp.request/v1 YAML exits 3", func(t *testing.T) {
		code, _, errb := covplancheckRun(
			"--plan", goodPlan(t),
			"--request", covplancheckWrite(t, "request.yaml", "schema: something/else\nitem: ec2-resize\n"),
			"--manifests", mdir)
		if code != 3 {
			t.Fatalf("code = %d, want 3 (stderr=%q)", code, errb)
		}
		// The schema error must be the one request.Load raises, naming BOTH the
		// rejected schema and the only accepted one — a bare "something went
		// wrong" would not tell an operator which field to fix, and would not
		// distinguish this from the plan/manifest failures above.
		if !strings.Contains(errb, "request schema") {
			t.Fatalf("stderr = %q, want the request-schema load error", errb)
		}
		for _, want := range []string{`"something/else"`, "ccp.request/v1"} {
			if !strings.Contains(errb, want) {
				t.Fatalf("stderr = %q, want it to mention %q", errb, want)
			}
		}
	})

	t.Run("an unloadable manifests directory exits 3", func(t *testing.T) {
		mdirBad := t.TempDir()
		if err := os.WriteFile(filepath.Join(mdirBad, "broken.json"), []byte(`{"operations":`), 0o644); err != nil {
			t.Fatal(err)
		}
		code, _, errb := covplancheckRun("--plan", goodPlan(t), "--request", goodReq(t), "--manifests", mdirBad)
		if code != 3 {
			t.Fatalf("code = %d, want 3 (stderr=%q)", code, errb)
		}
		if !strings.Contains(errb, "broken.json") {
			t.Fatalf("stderr = %q, want it to name the manifest that failed to load", errb)
		}
	})
}

// TestCovplancheckRunViolationExitCode pins the exit-2 half of the contract: every
// VIOLATION line goes to stderr in the spec's rendered form and stdout stays empty.
func TestCovplancheckRunViolationExitCode(t *testing.T) {
	const mdir = "../../testdata/manifests"
	plan := covplancheckWrite(t, "plan.json",
		`{"format_version":"1.2","resource_changes":[`+
			`{"address":"aws_instance.a","change":{"actions":["update"]}},`+
			`{"address":"aws_instance.rogue","change":{"actions":["update"]}}]}`)
	code, out, errb := covplancheckRun(
		"--plan", plan,
		"--request", covplancheckWrite(t, "request.yaml", covplancheckReqYAML),
		"--manifests", mdir)
	if code != 2 {
		t.Fatalf("code = %d, want 2 PLAN_VIOLATION (stderr=%q)", code, errb)
	}
	if !strings.Contains(errb, "VIOLATION address-subset: aws_instance.rogue — ") {
		t.Fatalf("stderr = %q, want the rendered VIOLATION line", errb)
	}
	if out != "" {
		t.Fatalf("stdout = %q, want nothing on a violation", out)
	}
}

// ── command.go: the drift-gate dispatch (spec §4.4/§7) ───────────────────────

// TestCovplancheckRunDriftDispatch pins command.go's drift-gate routing: a bundle
// request whose items do not honestly agree on ONE drift system op is refused HERE
// (exit 3, with its own reason) rather than falling through to the YAML+manifest
// path; a well-formed drift request still surfaces plan-load and gate errors as
// exit 3. --manifests is deliberately omitted throughout: the drift path must never
// reach manifests.LoadDir.
func TestCovplancheckRunDriftDispatch(t *testing.T) {
	goodPlan := func(t *testing.T) string {
		return covplancheckWrite(t, "plan.json", `{"format_version":"1.2","resource_changes":[]}`)
	}

	t.Run("mixed drift and non-drift items exit 3 with the disagreement reason", func(t *testing.T) {
		reqPath := covplancheckWrite(t, "bundle-request.json",
			`{"items":[{"operationId":"system-drift-adopt","params":{"verdicts":[]}},`+
				`{"operationId":"ec2-resize","params":{}}]}`)
		code, _, errb := covplancheckRun("--plan", goodPlan(t), "--request", reqPath)
		if code != 3 {
			t.Fatalf("code = %d, want 3 (stderr=%q)", code, errb)
		}
		if !strings.Contains(errb, "do not honestly agree on a single drift system op") {
			t.Fatalf("stderr = %q, want the A2 disagreement refusal", errb)
		}
	})

	t.Run("two different drift ops in one bundle exit 3", func(t *testing.T) {
		reqPath := covplancheckWrite(t, "bundle-request.json",
			`{"items":[{"operationId":"system-drift-adopt","params":{"verdicts":[]}},`+
				`{"operationId":"system-drift-revert","params":{"attrs":{}}}]}`)
		code, _, errb := covplancheckRun("--plan", goodPlan(t), "--request", reqPath)
		if code != 3 || !strings.Contains(errb, "do not honestly agree on a single drift system op") {
			t.Fatalf("code = %d stderr = %q, want 3 + the A2 disagreement refusal", code, errb)
		}
	})

	t.Run("a drift request with an unreadable plan exits 3", func(t *testing.T) {
		reqPath := covplancheckWrite(t, "bundle-request.json",
			`{"operationId":"system-drift-adopt","params":{"verdicts":[]}}`)
		missing := filepath.Join(t.TempDir(), "absent-plan.json")
		code, _, errb := covplancheckRun("--plan", missing, "--request", reqPath)
		if code != 3 {
			t.Fatalf("code = %d, want 3 (stderr=%q)", code, errb)
		}
		if !strings.Contains(errb, "absent-plan.json") {
			t.Fatalf("stderr = %q, want it to name the unreadable plan path", errb)
		}
	})

	t.Run("a drift request with an unsupported plan format_version exits 3", func(t *testing.T) {
		reqPath := covplancheckWrite(t, "bundle-request.json",
			`{"operationId":"system-drift-adopt","params":{"verdicts":[]}}`)
		code, _, errb := covplancheckRun(
			"--plan", covplancheckWrite(t, "plan.json", `{"format_version":"2.0","resource_changes":[]}`),
			"--request", reqPath)
		if code != 3 || !strings.Contains(errb, "unsupported plan format_version") {
			t.Fatalf("code = %d stderr = %q, want 3 + the format_version refusal", code, errb)
		}
	})

	t.Run("a gate error on malformed pinned params exits 3", func(t *testing.T) {
		reqPath := covplancheckWrite(t, "bundle-request.json",
			`{"operationId":"system-drift-adopt","params":{"verdicts":[]}}`)
		code, _, errb := covplancheckRun("--plan", goodPlan(t), "--request", reqPath)
		if code != 3 {
			t.Fatalf("code = %d, want 3 (stderr=%q)", code, errb)
		}
		if !strings.Contains(errb, "pinned params carry no verdicts") {
			t.Fatalf("stderr = %q, want the RunDriftGate malformed-params error", errb)
		}
	})

	t.Run("an undecodable pinned params payload exits 3", func(t *testing.T) {
		reqPath := covplancheckWrite(t, "bundle-request.json",
			`{"operationId":"system-drift-adopt","params":{"verdicts":"not-a-list"}}`)
		code, _, errb := covplancheckRun("--plan", goodPlan(t), "--request", reqPath)
		if code != 3 {
			t.Fatalf("code = %d, want 3 (stderr=%q)", code, errb)
		}
		if !strings.Contains(errb, "pinned params") {
			t.Fatalf("stderr = %q, want the pinned-params decode error", errb)
		}
	})

	t.Run("a non-drift JSON bundle falls through to the ordinary YAML path", func(t *testing.T) {
		// operationId names no drift op ⇒ notDrift ⇒ request.Load is what refuses
		// it, and the message must come from THAT path (not the drift one).
		reqPath := covplancheckWrite(t, "bundle-request.json",
			`{"operationId":"ec2-resize","params":{}}`)
		code, _, errb := covplancheckRun("--plan", goodPlan(t), "--request", reqPath, "--manifests", "../../testdata/manifests")
		if code != 3 {
			t.Fatalf("code = %d, want 3 (stderr=%q)", code, errb)
		}
		if strings.Contains(errb, "do not honestly agree") {
			t.Fatalf("stderr = %q, want the ordinary request-load refusal, not the drift one", errb)
		}
	})
}
