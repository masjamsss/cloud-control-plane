package plancheck

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/manifests"
	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/request"
)

// invParam / valParam build the two param shapes Check inspects.
func invParam(name string) manifests.Param { return manifests.Param{Name: name, Source: "inventory"} }
func growParam(name string) manifests.Param {
	return manifests.Param{Name: name, Source: "user_input", Bounds: &manifests.Bounds{GrowOnly: true}}
}

func req(item string, params map[string]any) *request.Request {
	return &request.Request{Schema: "ccp.request/v1", Item: item, Params: params}
}

func rules(vs []Violation) string {
	var b strings.Builder
	for _, v := range vs {
		b.WriteString(v.Rule)
		b.WriteByte(' ')
	}
	return b.String()
}

func TestCheckRules(t *testing.T) {
	ec2 := manifests.Op{ID: "ec2-resize", Macd: "Change", CodemodOp: "set_attribute"}
	ec2.Target.ResourceType = "aws_instance"
	ec2.Params = []manifests.Param{invParam("instance"), {Name: "new_instance_type", Source: "allowlist"}}

	del := manifests.Op{ID: "ebs-delete-volume", Macd: "Delete", CodemodOp: "remove_block"}
	del.Params = []manifests.Param{invParam("volume")}

	enc := manifests.Op{ID: "ebs-set-encrypted", Macd: "Change", CodemodOp: "set_attribute", ForcesReplace: true}
	enc.Params = []manifests.Param{invParam("volume"), {Name: "encrypted", Source: "allowlist"}}

	grow := manifests.Op{ID: "ebs-grow", Macd: "Change", CodemodOp: "set_attribute"}
	grow.Target.ResourceType = "aws_ebs_volume"
	grow.Params = []manifests.Param{invParam("volume"), growParam("new_size_gib")}

	moved := manifests.Op{ID: "fx-moved", Macd: "Change", CodemodOp: "moved_block"}
	moved.Params = []manifests.Param{invParam("resource"), {Name: "new_name", Source: "user_input"}}

	// 0036 create ops: an Add whose codemodOp is create_resource, keyed by its
	// single role:"key" param (the local name the idiom addresses derive from).
	s3c := manifests.Op{ID: "s3-create-bucket", Macd: "Add", CodemodOp: "create_resource"}
	s3c.Target.ResourceType = "aws_s3_bucket"
	s3c.Params = []manifests.Param{{Name: "bucket_name", Source: "user_input", Role: "key"}}
	s3Req := func() *request.Request {
		return req("s3-create-bucket", map[string]any{"bucket_name": "sample-finance-interface", "versioning": true, "lifecycle_cleanup_days": 365})
	}
	ec2c := manifests.Op{ID: "ec2-provision-instance", Macd: "Add", CodemodOp: "create_resource"}
	ec2c.Target.ResourceType = "aws_instance"
	ec2c.Params = []manifests.Param{{Name: "host_name", Source: "user_input", Role: "key"}}

	// S3 idiom addresses for name "sample_finance_interface".
	const (
		bkt = "aws_s3_bucket.sample_finance_interface"
		pab = "aws_s3_bucket_public_access_block.sample_finance_interface"
		sse = "aws_s3_bucket_server_side_encryption_configuration.sample_finance_interface"
		ver = "aws_s3_bucket_versioning.sample_finance_interface"
		lif = "aws_s3_bucket_lifecycle_configuration.sample_finance_interface"
	)
	cre := func(addr string) ResourceChange {
		return ResourceChange{Address: addr, Change: Change{Actions: []string{"create"}, Before: nil}}
	}

	upd := func(addr string, before, after map[string]any) ResourceChange {
		return ResourceChange{Address: addr, Change: Change{Actions: []string{"update"}, Before: before, After: after}}
	}

	tests := []struct {
		name       string
		plan       Plan
		op         manifests.Op
		req        *request.Request
		wantRules  []string // exact set of violation rules, in order
		wantInfo   int
		wantInfoIn string
	}{
		{
			name: "R1 clean single change",
			plan: Plan{ResourceChanges: []ResourceChange{upd("aws_instance.a", nil, nil)}},
			op:   ec2, req: req("ec2-resize", map[string]any{"instance": "aws_instance.a"}),
			wantRules: nil,
		},
		{
			name: "R1 extra address",
			plan: Plan{ResourceChanges: []ResourceChange{upd("aws_instance.a", nil, nil), upd("aws_instance.b", nil, nil)}},
			op:   ec2, req: req("ec2-resize", map[string]any{"instance": "aws_instance.a"}),
			wantRules: []string{"address-subset"},
		},
		{
			name: "R1 for_each instance key allowed",
			plan: Plan{ResourceChanges: []ResourceChange{upd(`aws_instance.a["k"]`, nil, nil)}},
			op:   ec2, req: req("ec2-resize", map[string]any{"instance": "aws_instance.a"}),
			wantRules: nil,
		},
		{
			name: "R2 pure delete under Change op",
			plan: Plan{ResourceChanges: []ResourceChange{{Address: "aws_instance.a", Change: Change{Actions: []string{"delete"}}}}},
			op:   ec2, req: req("ec2-resize", map[string]any{"instance": "aws_instance.a"}),
			wantRules: []string{"delete-guard"},
		},
		{
			name: "R2 Delete op exactly one destroy",
			plan: Plan{ResourceChanges: []ResourceChange{{Address: "aws_ebs_volume.v", Change: Change{Actions: []string{"delete"}}}}},
			op:   del, req: req("ebs-delete-volume", map[string]any{"volume": "aws_ebs_volume.v"}),
			wantRules: nil,
		},
		{
			name: "R2 Delete op two destroys",
			plan: Plan{ResourceChanges: []ResourceChange{
				{Address: "aws_ebs_volume.v", Change: Change{Actions: []string{"delete"}}},
				{Address: "aws_ebs_volume.w", Change: Change{Actions: []string{"delete"}}},
			}},
			op: del, req: req("ebs-delete-volume", map[string]any{"volume": "aws_ebs_volume.v"}),
			// w is outside target (address-subset + delete-guard), plus exactly-one delete-guard.
			wantRules: []string{"address-subset", "delete-guard", "delete-guard"},
		},
		{
			name: "R3 replace under forcesReplace is INFO",
			plan: Plan{ResourceChanges: []ResourceChange{{Address: "aws_ebs_volume.v",
				Change: Change{Actions: []string{"delete", "create"}}}}},
			op: enc, req: req("ebs-set-encrypted", map[string]any{"volume": "aws_ebs_volume.v"}),
			wantRules: nil, wantInfo: 1, wantInfoIn: "INFO replace-guard: aws_ebs_volume.v",
		},
		{
			name: "R3 replace_paths under non-FR op",
			plan: Plan{ResourceChanges: []ResourceChange{{Address: "aws_instance.a",
				Change: Change{Actions: []string{"update"}, ReplacePaths: []any{[]any{"instance_type"}}}}}},
			op: ec2, req: req("ec2-resize", map[string]any{"instance": "aws_instance.a"}),
			wantRules: []string{"replace-guard"},
		},
		{
			name: "R3 replace_ reason under non-FR op",
			plan: Plan{ResourceChanges: []ResourceChange{{Address: "aws_instance.a",
				ActionReasons: []string{"replace_because_tainted"}, Change: Change{Actions: []string{"update"}}}}},
			op: ec2, req: req("ec2-resize", map[string]any{"instance": "aws_instance.a"}),
			wantRules: []string{"replace-guard"},
		},
		{
			name: "R4 grow matches request",
			plan: Plan{ResourceChanges: []ResourceChange{upd("aws_ebs_volume.v", map[string]any{"size": 20.0}, map[string]any{"size": 40.0})}},
			op:   grow, req: req("ebs-grow", map[string]any{"volume": "aws_ebs_volume.v", "new_size_gib": 40}),
			wantRules: nil,
		},
		{
			name: "R4 shrink",
			plan: Plan{ResourceChanges: []ResourceChange{upd("aws_ebs_volume.v", map[string]any{"size": 2700.0}, map[string]any{"size": 100.0})}},
			op:   grow, req: req("ebs-grow", map[string]any{"volume": "aws_ebs_volume.v", "new_size_gib": 100}),
			wantRules: []string{"grow-only"},
		},
		{
			name: "R4 grows but not to requested",
			plan: Plan{ResourceChanges: []ResourceChange{upd("aws_ebs_volume.v", map[string]any{"size": 20.0}, map[string]any{"size": 30.0})}},
			op:   grow, req: req("ebs-grow", map[string]any{"volume": "aws_ebs_volume.v", "new_size_gib": 40}),
			wantRules: []string{"grow-only"},
		},
		{
			name: "R5 clean moved zero-delta",
			plan: Plan{ResourceChanges: []ResourceChange{{Address: "aws_instance.b", PreviousAddress: "aws_instance.a",
				Change: Change{Actions: []string{"no-op"}}}}},
			op: moved, req: req("fx-moved", map[string]any{"resource": "aws_instance.a", "new_name": "b"}),
			wantRules: nil,
		},
		{
			name: "R5 moved missing entry",
			plan: Plan{ResourceChanges: []ResourceChange{{Address: "aws_instance.b", PreviousAddress: "",
				Change: Change{Actions: []string{"no-op"}}}}},
			op: moved, req: req("fx-moved", map[string]any{"resource": "aws_instance.a", "new_name": "b"}),
			wantRules: []string{"moved-zero-delta"},
		},
		{
			name: "R5 moved with destroy trips address-subset+delete-guard+moved",
			plan: Plan{ResourceChanges: []ResourceChange{
				{Address: "aws_instance.b", PreviousAddress: "aws_instance.a", Change: Change{Actions: []string{"no-op"}}},
				{Address: "aws_instance.doomed", Change: Change{Actions: []string{"delete"}}},
			}},
			op: moved, req: req("fx-moved", map[string]any{"resource": "aws_instance.a", "new_name": "b"}),
			wantRules: []string{"address-subset", "delete-guard", "moved-zero-delta"},
		},

		// ── 0036 create-guard (§4) ────────────────────────────────────────────
		{
			name:      "create pass — every idiom address is a pure create",
			plan:      Plan{ResourceChanges: []ResourceChange{cre(bkt), cre(pab), cre(sse), cre(ver), cre(lif)}},
			op:        s3c,
			req:       s3Req(),
			wantRules: nil,
		},
		{
			name:      "create pass — single-block default idiom (aws_instance)",
			plan:      Plan{ResourceChanges: []ResourceChange{cre("aws_instance.erp_app_02")}},
			op:        ec2c,
			req:       req("ec2-provision-instance", map[string]any{"host_name": "erp-app-02"}),
			wantRules: nil,
		},
		{
			name: "create fail — a planned replace trips replace-guard + create-guard",
			plan: Plan{ResourceChanges: []ResourceChange{
				cre(bkt), {Address: pab, Change: Change{Actions: []string{"create", "delete"}}}, cre(sse), cre(ver), cre(lif),
			}},
			op: s3c, req: s3Req(),
			wantRules: []string{"replace-guard", "create-guard"},
		},
		{
			name: "create fail — an address outside the idiom set trips address-subset",
			plan: Plan{ResourceChanges: []ResourceChange{
				cre(bkt), cre(pab), cre(sse), cre(ver), cre(lif), cre("aws_s3_bucket.rogue"),
			}},
			op: s3c, req: s3Req(),
			wantRules: []string{"address-subset"},
		},
		{
			name: "create fail — before != null means the resource already exists",
			plan: Plan{ResourceChanges: []ResourceChange{
				{Address: bkt, Change: Change{Actions: []string{"create"}, Before: map[string]any{"id": "x"}}},
				cre(pab), cre(sse), cre(ver), cre(lif),
			}},
			op: s3c, req: s3Req(),
			wantRules: []string{"create-guard"},
		},
		{
			name:      "create fail — a missing mandatory PAB trips create-guard (co-emission hole)",
			plan:      Plan{ResourceChanges: []ResourceChange{cre(bkt), cre(sse), cre(ver), cre(lif)}},
			op:        s3c,
			req:       s3Req(),
			wantRules: []string{"create-guard"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			vs, info := Check(tt.plan, tt.op, tt.req)
			gotRules := make([]string, len(vs))
			for i, v := range vs {
				gotRules[i] = v.Rule
			}
			if strings.Join(gotRules, ",") != strings.Join(tt.wantRules, ",") {
				t.Fatalf("violations = [%s], want [%s]", rules(vs), strings.Join(tt.wantRules, " "))
			}
			if len(info) != tt.wantInfo {
				t.Fatalf("info = %v, want %d line(s)", info, tt.wantInfo)
			}
			if tt.wantInfoIn != "" && (len(info) == 0 || !strings.Contains(info[0], tt.wantInfoIn)) {
				t.Fatalf("info = %v, want contains %q", info, tt.wantInfoIn)
			}
		})
	}
}

func TestViolationString(t *testing.T) {
	got := Violation{Rule: "grow-only", Address: "aws_ebs_volume.v", Reason: "size shrinks"}.String()
	want := "VIOLATION grow-only: aws_ebs_volume.v — size shrinks"
	if got != want {
		t.Fatalf("String() = %q, want %q", got, want)
	}
}

func TestMajorVersion(t *testing.T) {
	for in, want := range map[string]string{"1.2": "1", "1": "1", "2.0": "2", "": ""} {
		if got := majorVersion(in); got != want {
			t.Fatalf("majorVersion(%q) = %q, want %q", in, got, want)
		}
	}
}

// TestAttrFor pins that R4's attribute resolution delegates to manifests.AttrFor
// (0013b: the inlined copy was removed) — the "new_" strip plus the aws_ebs_volume
// size_gib→size rename still hold.
func TestAttrFor(t *testing.T) {
	ebs := manifests.Op{}
	ebs.Target.ResourceType = "aws_ebs_volume"
	if got := manifests.AttrFor(ebs, manifests.Param{Name: "new_size_gib"}); got != "size" {
		t.Fatalf("AttrFor ebs new_size_gib = %q, want size", got)
	}
	other := manifests.Op{}
	other.Target.ResourceType = "aws_instance"
	if got := manifests.AttrFor(other, manifests.Param{Name: "new_instance_type"}); got != "instance_type" {
		t.Fatalf("AttrFor = %q, want instance_type", got)
	}
}

// TestRunExitCodes exercises the command-level exit-3 paths the fixtures (0/2) don't.
func TestRunExitCodes(t *testing.T) {
	const mdir = "../../testdata/manifests"
	writeReq := func(t *testing.T) string {
		t.Helper()
		p := filepath.Join(t.TempDir(), "request.yaml")
		body := "schema: ccp.request/v1\nid: REQ-01JZTC4QWERTY0123456789R9A\nitem: ec2-resize\nparams:\n  instance: aws_instance.a\n  new_instance_type: c6i.2xlarge\n"
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
		return p
	}
	writePlan := func(t *testing.T, body string) string {
		t.Helper()
		p := filepath.Join(t.TempDir(), "plan.json")
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
		return p
	}

	t.Run("format_version major not 1 exits 3", func(t *testing.T) {
		var out, errb bytes.Buffer
		code := run([]string{"--plan", writePlan(t, `{"format_version":"2.0","resource_changes":[]}`),
			"--request", writeReq(t), "--manifests", mdir}, &out, &errb)
		if code != 3 || !strings.Contains(errb.String(), "format_version") {
			t.Fatalf("code=%d stderr=%q, want 3 + format_version", code, errb.String())
		}
	})
	t.Run("unparseable plan exits 3", func(t *testing.T) {
		var out, errb bytes.Buffer
		code := run([]string{"--plan", writePlan(t, `{not json`),
			"--request", writeReq(t), "--manifests", mdir}, &out, &errb)
		if code != 3 {
			t.Fatalf("code=%d, want 3 (stderr=%q)", code, errb.String())
		}
	})
	t.Run("unknown op exits 3", func(t *testing.T) {
		p := filepath.Join(t.TempDir(), "request.yaml")
		body := "schema: ccp.request/v1\nid: REQ-01JZTC4QWERTY0123456789R9B\nitem: no-such-op\nparams: {}\n"
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
		var out, errb bytes.Buffer
		code := run([]string{"--plan", writePlan(t, `{"format_version":"1.2","resource_changes":[]}`),
			"--request", p, "--manifests", mdir}, &out, &errb)
		if code != 3 || !strings.Contains(errb.String(), "unknown op") {
			t.Fatalf("code=%d stderr=%q, want 3 + unknown op", code, errb.String())
		}
	})
	t.Run("clean plan exits 0", func(t *testing.T) {
		var out, errb bytes.Buffer
		code := run([]string{"--plan", writePlan(t, `{"format_version":"1.2","resource_changes":[{"address":"aws_instance.a","change":{"actions":["update"]}}]}`),
			"--request", writeReq(t), "--manifests", mdir}, &out, &errb)
		if code != 0 {
			t.Fatalf("code=%d, want 0 (stderr=%q)", code, errb.String())
		}
	})
}
