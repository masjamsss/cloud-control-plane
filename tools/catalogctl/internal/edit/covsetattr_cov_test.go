package edit

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/hashicorp/hcl/v2"
	"github.com/hashicorp/hcl/v2/hclsyntax"
	"github.com/hashicorp/hcl/v2/hclwrite"
	"github.com/zclconf/go-cty/cty"

	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/hclobj"
	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/hclops"
	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/manifests"
	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/request"
)

// covsetattr_cov_test.go exercises the set_attribute / set_attributes codemods and
// the shared value layer (setattr.go, setattrs.go, value.go) — with the emphasis on
// the guard/refusal branches, which ARE the product contract: a refusal returns
// (code, reason) with nil bytes and never a partial write, an internal/manifest
// inconsistency returns a plain error (exit 1), and a reference/resolution failure
// returns an errResolution-wrapped error (exit 3).

// covsetattrLocIn returns a Located over src whose File sits in dir, so
// filepath.Dir(loc.File) is the env directory references resolve against.
func covsetattrLocIn(dir, src string) *hclops.Located {
	b := []byte(src)
	return &hclops.Located{File: filepath.Join(dir, "target.tf"), Bytes: b, Start: 0, End: len(b)}
}

// covsetattrLoc is covsetattrLocIn against a throwaway (empty) env dir — enough for
// every case whose value param is not a reference.
func covsetattrLoc(t *testing.T, src string) *hclops.Located {
	t.Helper()
	return covsetattrLocIn(t.TempDir(), src)
}

// covsetattrEnv writes refs into a fresh env dir and returns the dir.
func covsetattrEnv(t *testing.T, files map[string]string) string {
	t.Helper()
	dir := t.TempDir()
	for name, body := range files {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

// covsetattrTarget is the inventory locator param every op carries. It is NOT a
// value provider (source:"inventory", no role), so valueParam must skip it.
var covsetattrTarget = manifests.Param{Name: "target", Source: "inventory"}

// covsetattrOp builds a set_attribute-shaped op. Target.Attr / Block / Path are set
// by the caller because Op.Target is an anonymous struct.
func covsetattrOp(codemod, resourceType string, params ...manifests.Param) manifests.Op {
	op := manifests.Op{ID: "cov-op", CodemodOp: codemod, Params: params}
	op.Target.ResourceType = resourceType
	return op
}

func covsetattrReq(params map[string]any) *request.Request {
	return &request.Request{Params: params}
}

func covsetattrTok(tt hclsyntax.TokenType, s string) *hclwrite.Token {
	return &hclwrite.Token{Type: tt, Bytes: []byte(s)}
}

// covsetattrParseBlock parses src and returns its single block (for the helpers that
// operate on a live hclwrite block).
func covsetattrParseBlock(t *testing.T, src string) (*hclwrite.File, *hclwrite.Block) {
	t.Helper()
	f, diags := hclwrite.ParseConfig([]byte(src), "x.tf", hcl.Pos{Line: 1, Column: 1})
	if diags.HasErrors() {
		t.Fatalf("fixture does not parse: %s", diags.Error())
	}
	blocks := f.Body().Blocks()
	if len(blocks) != 1 {
		t.Fatalf("fixture has %d blocks, want 1", len(blocks))
	}
	return f, blocks[0]
}

// ── setAttribute: structural preconditions ──────────────────────────────────

// TestCovsetattrSetAttributeBlockPreconditions: the located bytes must reparse to
// exactly one block. Anything else is an internal error (exit 1) — never a write.
func TestCovsetattrSetAttributeBlockPreconditions(t *testing.T) {
	value := manifests.Param{Name: "new_size", Source: "user_input"}
	op := covsetattrOp("set_attribute", "aws_ebs_volume", covsetattrTarget, value)
	op.Target.Attr = "size"
	req := covsetattrReq(map[string]any{"target": "aws_ebs_volume.v", "new_size": 10})

	cases := []struct {
		name    string
		src     string
		wantErr string
	}{
		{"unparseable bytes", "a = = 1\n", "parse block"},
		{"two blocks", "resource \"aws_ebs_volume\" \"a\" {\n}\nresource \"aws_ebs_volume\" \"b\" {\n}\n", "expected exactly one block, got 2"},
		{"no block at all", "size = 1\n", "expected exactly one block, got 0"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			out, code, reason, err := setAttribute(op, req, covsetattrLoc(t, tc.src))
			if err == nil {
				t.Fatalf("want error, got out=%q code=%q reason=%q", out, code, reason)
			}
			if code != "" {
				t.Fatalf("want a plain internal error, got refuse code %q", code)
			}
			if out != nil {
				t.Fatalf("want nil bytes on error, got %q", out)
			}
			if !strings.Contains(err.Error(), tc.wantErr) {
				t.Fatalf("err = %v, want it to contain %q", err, tc.wantErr)
			}
		})
	}
}

// TestCovsetattrSetAttributeNoValueParam: an op whose only param is the inventory
// locator has nothing to write — a manifest inconsistency, so exit 1, not a write.
// Also pins valueParam's nil return and attrName's empty return for that shape.
func TestCovsetattrSetAttributeNoValueParam(t *testing.T) {
	op := covsetattrOp("set_attribute", "aws_ebs_volume", covsetattrTarget)
	op.Target.Attr = "size"
	if vp := valueParam(op); vp != nil {
		t.Fatalf("valueParam = %+v, want nil (the inventory locator is not a value)", vp)
	}
	bare := covsetattrOp("set_attribute", "aws_ebs_volume", covsetattrTarget)
	if got := attrName(bare); got != "" {
		t.Fatalf("attrName = %q, want \"\" with no value param and no target.attr/prose", got)
	}

	flat := "resource \"aws_ebs_volume\" \"v\" {\n  size = 100\n}\n"
	nested := "resource \"aws_ebs_volume\" \"v\" {\n  nested {\n    size = 100\n  }\n}\n"
	for _, path := range [][]string{nil, {"nested"}} {
		op := op // copy
		op.Target.Path = path
		src := flat
		if path != nil {
			src = nested
		}
		_, code, _, err := setAttribute(op, covsetattrReq(map[string]any{"target": "aws_ebs_volume.v"}), covsetattrLoc(t, src))
		if err == nil || code != "" {
			t.Fatalf("path=%v: want plain error, got code=%q err=%v", path, code, err)
		}
		if !strings.Contains(err.Error(), "has no value param") {
			t.Fatalf("path=%v: err = %v, want \"has no value param\"", path, err)
		}
	}
}

// TestCovsetattrSetAttributeUnnamedValueParam: a value param that resolves to no
// attribute name (no target.attr, no prose token, no param name/attr override) is a
// manifest inconsistency — exit 1 rather than writing a nameless attribute.
func TestCovsetattrSetAttributeUnnamedValueParam(t *testing.T) {
	value := manifests.Param{Name: "", Source: "user_input"}
	src := "resource \"aws_ebs_volume\" \"v\" {\n  size = 100\n}\n"
	req := covsetattrReq(map[string]any{"target": "aws_ebs_volume.v", "": "x"})

	for _, path := range [][]string{nil, {"nested"}} {
		op := covsetattrOp("set_attribute", "aws_ebs_volume", covsetattrTarget, value)
		op.Target.Path = path
		body := src
		if path != nil {
			body = "resource \"aws_ebs_volume\" \"v\" {\n  nested {\n    size = 100\n  }\n}\n"
		}
		_, code, _, err := setAttribute(op, req, covsetattrLoc(t, body))
		if err == nil || code != "" {
			t.Fatalf("path=%v: want plain error, got code=%q err=%v", path, code, err)
		}
		if !strings.Contains(err.Error(), "cannot resolve attribute name") {
			t.Fatalf("path=%v: err = %v, want \"cannot resolve attribute name\"", path, err)
		}
	}
}

// TestCovsetattrSetAttributeUnsupportedPath: a dotted write target — either a dotted
// target.block (map merge) or a dotted attribute name — would render as an invalid
// dotted LHS, so it refuses UNSUPPORTED_PATH (exit 2, routed to an engineer) instead
// of corrupting the file. Holds on both the flat and the path-addressed lane.
func TestCovsetattrSetAttributeUnsupportedPath(t *testing.T) {
	flatSrc := "resource \"aws_instance\" \"x\" {\n  instance_type = \"t3.small\"\n}\n"
	nestedSrc := "resource \"aws_instance\" \"x\" {\n  root_block_device {\n    volume_size = 100\n  }\n}\n"

	cases := []struct {
		name       string
		src        string
		path       []string
		block      string
		attr       string
		raw        any
		wantReason string
	}{
		{"flat dotted target.block", flatSrc, nil, "schedule.tags_to_add", "", map[string]any{"k": "v"}, "schedule.tags_to_add"},
		{"flat dotted attr", flatSrc, nil, "", "root_block_device.volume_size", 20, "root_block_device.volume_size"},
		{"nested dotted target.block", nestedSrc, []string{"root_block_device"}, "a.b", "", map[string]any{"k": "v"}, "a.b"},
		{"nested dotted attr", nestedSrc, []string{"root_block_device"}, "", "a.b", 20, "a.b"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			value := manifests.Param{Name: "new_v", Source: "user_input"}
			op := covsetattrOp("set_attribute", "aws_instance", covsetattrTarget, value)
			op.Target.Path = tc.path
			op.Target.Block = tc.block
			op.Target.Attr = tc.attr
			req := covsetattrReq(map[string]any{"target": "aws_instance.x", "new_v": tc.raw})

			out, code, reason, err := setAttribute(op, req, covsetattrLoc(t, tc.src))
			if err != nil {
				t.Fatalf("want a refusal, got err=%v", err)
			}
			if code != "UNSUPPORTED_PATH" {
				t.Fatalf("code = %q, want UNSUPPORTED_PATH", code)
			}
			if out != nil {
				t.Fatalf("a refusal must not write bytes, got %q", out)
			}
			if !strings.Contains(reason, tc.wantReason) {
				t.Fatalf("reason = %q, want it to name %q", reason, tc.wantReason)
			}
		})
	}
}

// TestCovsetattrSetAttributeMapParamNotAMap: target.block names a map-typed
// attribute, so a non-map request value is a manifest/request mismatch → exit 1.
func TestCovsetattrSetAttributeMapParamNotAMap(t *testing.T) {
	cases := []struct {
		name string
		src  string
		path []string
	}{
		{"flat", "resource \"aws_instance\" \"x\" {\n  tags = {\n    A = \"b\"\n  }\n}\n", nil},
		{"nested", "resource \"aws_instance\" \"x\" {\n  schedule {\n    tags_to_add = {\n      A = \"b\"\n    }\n  }\n}\n", []string{"schedule"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			value := manifests.Param{Name: "new_tags", Source: "user_input"}
			op := covsetattrOp("set_attribute", "aws_instance", covsetattrTarget, value)
			op.Target.Path = tc.path
			op.Target.Block = "tags"
			if tc.path != nil {
				op.Target.Block = "tags_to_add"
			}
			req := covsetattrReq(map[string]any{"target": "aws_instance.x", "new_tags": "not-a-map"})

			_, code, _, err := setAttribute(op, req, covsetattrLoc(t, tc.src))
			if err == nil || code != "" {
				t.Fatalf("want plain error, got code=%q err=%v", code, err)
			}
			if !strings.Contains(err.Error(), "is not a map") {
				t.Fatalf("err = %v, want \"is not a map\"", err)
			}
		})
	}
}

// TestCovsetattrSetAttributeNestedMapMergeRefusal: a map merge reached through
// target.path propagates mergeMap's refusal verbatim — a non-literal nested map
// refuses NOT_LITERAL with nil bytes rather than rewriting an expression.
func TestCovsetattrSetAttributeNestedMapMergeRefusal(t *testing.T) {
	src := "resource \"aws_instance\" \"x\" {\n  schedule {\n    tags_to_add = local.common\n  }\n}\n"
	value := manifests.Param{Name: "new_tags", Source: "user_input"}
	op := covsetattrOp("set_attribute", "aws_instance", covsetattrTarget, value)
	op.Target.Path = []string{"schedule"}
	op.Target.Block = "tags_to_add"
	req := covsetattrReq(map[string]any{"target": "aws_instance.x", "new_tags": map[string]any{"Owner": "erp"}})

	out, code, reason, err := setAttribute(op, req, covsetattrLoc(t, src))
	if err != nil {
		t.Fatalf("want a refusal, got err=%v", err)
	}
	if code != "NOT_LITERAL" {
		t.Fatalf("code = %q, want NOT_LITERAL", code)
	}
	if out != nil {
		t.Fatalf("a refusal must not write bytes, got %q", out)
	}
	if !strings.Contains(reason, "tags_to_add") {
		t.Fatalf("reason = %q, want it to name the attribute", reason)
	}
}

// TestCovsetattrSetAttributeNestedMapMergeSucceeds is the positive counterpart: a
// literal nested map merges, and the write lands INSIDE the nested block.
func TestCovsetattrSetAttributeNestedMapMergeSucceeds(t *testing.T) {
	src := "resource \"aws_instance\" \"x\" {\n  schedule {\n    tags_to_add = {\n      App = \"erp\"\n    }\n  }\n}\n"
	value := manifests.Param{Name: "new_tags", Source: "user_input"}
	op := covsetattrOp("set_attribute", "aws_instance", covsetattrTarget, value)
	op.Target.Path = []string{"schedule"}
	op.Target.Block = "tags_to_add"
	req := covsetattrReq(map[string]any{"target": "aws_instance.x", "new_tags": map[string]any{"Owner": "basis"}})

	out, code, reason, err := setAttribute(op, req, covsetattrLoc(t, src))
	if err != nil || code != "" {
		t.Fatalf("code=%q reason=%q err=%v, want a clean nested merge", code, reason, err)
	}
	want := "resource \"aws_instance\" \"x\" {\n  schedule {\n    tags_to_add = {\n      App   = \"erp\"\n      Owner = \"basis\"\n    }\n  }\n}\n"
	if string(out) != want {
		t.Fatalf("nested merge output:\n--- got ---\n%s\n--- want ---\n%s", out, want)
	}
}

// TestCovsetattrSetAttributeFlatMapMerge: the flat (no target.path) map-merge lane —
// a literal object merges and re-aligns, a non-literal object refuses NOT_LITERAL.
func TestCovsetattrSetAttributeFlatMapMerge(t *testing.T) {
	value := manifests.Param{Name: "new_tags", Source: "user_input"}
	op := covsetattrOp("set_attribute", "aws_s3_bucket", covsetattrTarget, value)
	op.Target.Block = "tags"
	req := covsetattrReq(map[string]any{
		"target":   "aws_s3_bucket.b",
		"new_tags": map[string]any{"CostCentre": "erp-basis", "Owner": "platform"},
	})

	t.Run("literal object merges", func(t *testing.T) {
		src := "resource \"aws_s3_bucket\" \"b\" {\n  tags = {\n    Owner = \"basis\"\n  }\n}\n"
		out, code, reason, err := setAttribute(op, req, covsetattrLoc(t, src))
		if err != nil || code != "" {
			t.Fatalf("code=%q reason=%q err=%v, want a clean merge", code, reason, err)
		}
		want := "resource \"aws_s3_bucket\" \"b\" {\n  tags = {\n    Owner      = \"platform\"\n    CostCentre = \"erp-basis\"\n  }\n}\n"
		if string(out) != want {
			t.Fatalf("merge output:\n--- got ---\n%s\n--- want ---\n%s", out, want)
		}
	})

	t.Run("non-literal object refuses", func(t *testing.T) {
		src := "resource \"aws_s3_bucket\" \"b\" {\n  tags = local.common_tags\n}\n"
		out, code, reason, err := setAttribute(op, req, covsetattrLoc(t, src))
		if err != nil {
			t.Fatalf("want a refusal, got err=%v", err)
		}
		if code != "NOT_LITERAL" {
			t.Fatalf("code = %q, want NOT_LITERAL", code)
		}
		if out != nil {
			t.Fatalf("a refusal must not write bytes, got %q", out)
		}
		if !strings.Contains(reason, "tags") {
			t.Fatalf("reason = %q, want it to name the attribute", reason)
		}
	})
}

// TestCovsetattrSetAttributePathRefusals: an unresolvable target.path refuses BEFORE
// any value is resolved or written — PATH_NOT_FOUND when the segment is absent,
// SELECTOR_AMBIGUOUS when siblings are repeated with no selector to choose one.
func TestCovsetattrSetAttributePathRefusals(t *testing.T) {
	cases := []struct {
		name     string
		src      string
		wantCode string
	}{
		{
			name:     "absent path segment",
			src:      "resource \"aws_instance\" \"x\" {\n  instance_type = \"t3.small\"\n}\n",
			wantCode: "PATH_NOT_FOUND",
		},
		{
			name:     "repeated siblings with no selector",
			src:      "resource \"aws_instance\" \"x\" {\n  ebs_block_device {\n    volume_size = 10\n  }\n  ebs_block_device {\n    volume_size = 20\n  }\n}\n",
			wantCode: "SELECTOR_AMBIGUOUS",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			value := manifests.Param{Name: "new_v", Source: "user_input"}
			op := covsetattrOp("set_attribute", "aws_instance", covsetattrTarget, value)
			op.Target.Path = []string{"ebs_block_device"}
			op.Target.Attr = "volume_size"
			req := covsetattrReq(map[string]any{"target": "aws_instance.x", "new_v": 40})

			out, code, reason, err := setAttribute(op, req, covsetattrLoc(t, tc.src))
			if err != nil {
				t.Fatalf("want a refusal, got err=%v", err)
			}
			if code != tc.wantCode {
				t.Fatalf("code = %q, want %q (reason %q)", code, tc.wantCode, reason)
			}
			if out != nil {
				t.Fatalf("a refusal must not write bytes, got %q", out)
			}
			if !strings.Contains(reason, "ebs_block_device") {
				t.Fatalf("reason = %q, want it to name the path segment", reason)
			}
		})
	}
}

// ── setAttribute: the grow-only direction guard ─────────────────────────────

// TestCovsetattrGrowOnlyGuard: growOnly reads the CURRENT value out of the file
// (flat: the block bytes; path-addressed: the descended block) and a strict shrink
// refuses SHRINK naming both numbers. Equal is a permitted no-op-shaped write and a
// grow is applied. A non-numeric request value or an unreadable current value is a
// manifest/file inconsistency → exit 1.
func TestCovsetattrGrowOnlyGuard(t *testing.T) {
	flat := func(body string) string {
		return "resource \"aws_ebs_volume\" \"v\" {\n" + body + "}\n"
	}
	nested := func(body string) string {
		return "resource \"aws_instance\" \"x\" {\n  root_block_device {\n" + body + "  }\n}\n"
	}

	cases := []struct {
		name       string
		src        string
		path       []string
		attr       string
		raw        any
		wantCode   string
		wantReason string
		wantErr    string
		wantHCL    string
	}{
		{
			name: "flat shrink refuses", src: flat("  size = 100\n"), attr: "size", raw: 50,
			wantCode: "SHRINK", wantReason: "new_v 50 is below current 100 (grow-only)",
		},
		{
			name: "flat fractional shrink formats both numbers", src: flat("  size = 1.5\n"), attr: "size", raw: 0.5,
			wantCode: "SHRINK", wantReason: "new_v 0.5 is below current 1.5 (grow-only)",
		},
		{
			name: "flat equal is allowed", src: flat("  size = 100\n"), attr: "size", raw: 100,
			wantHCL: "size = 100",
		},
		{
			name: "flat grow is applied", src: flat("  size = 100\n"), attr: "size", raw: 250,
			wantHCL: "size = 250",
		},
		{
			name: "flat non-numeric value errors", src: flat("  size = 100\n"), attr: "size", raw: "big",
			wantErr: "grow-only param \"new_v\" is not numeric",
		},
		{
			name: "flat unreadable current value errors", src: flat("  iops = 3000\n"), attr: "size", raw: 200,
			wantErr: "cannot read current \"size\" value",
		},
		{
			name: "nested shrink refuses", src: nested("    volume_size = 100\n"), path: []string{"root_block_device"},
			attr: "volume_size", raw: 20, wantCode: "SHRINK", wantReason: "new_v 20 is below current 100 (grow-only)",
		},
		{
			name: "nested grow is applied", src: nested("    volume_size = 100\n"), path: []string{"root_block_device"},
			attr: "volume_size", raw: 300, wantHCL: "volume_size = 300",
		},
		{
			name: "nested non-numeric value errors", src: nested("    volume_size = 100\n"), path: []string{"root_block_device"},
			attr: "volume_size", raw: "big", wantErr: "grow-only param \"new_v\" is not numeric",
		},
		{
			name: "nested unreadable current value errors", src: nested("    volume_type = \"gp3\"\n"), path: []string{"root_block_device"},
			attr: "volume_size", raw: 300, wantErr: "cannot read current \"volume_size\" value",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			value := manifests.Param{Name: "new_v", Source: "user_input", Bounds: &manifests.Bounds{GrowOnly: true}}
			op := covsetattrOp("set_attribute", "aws_ebs_volume", covsetattrTarget, value)
			op.Target.Path = tc.path
			op.Target.Attr = tc.attr
			req := covsetattrReq(map[string]any{"target": "aws_ebs_volume.v", "new_v": tc.raw})

			out, code, reason, err := setAttribute(op, req, covsetattrLoc(t, tc.src))
			switch {
			case tc.wantErr != "":
				if err == nil || code != "" {
					t.Fatalf("want plain error %q, got code=%q err=%v", tc.wantErr, code, err)
				}
				if err.Error() != tc.wantErr {
					t.Fatalf("err = %v, want %q", err, tc.wantErr)
				}
				if out != nil {
					t.Fatalf("want nil bytes on error, got %q", out)
				}
			case tc.wantCode != "":
				if err != nil {
					t.Fatalf("want refusal %s, got err=%v", tc.wantCode, err)
				}
				if code != tc.wantCode {
					t.Fatalf("code = %q, want %q", code, tc.wantCode)
				}
				if reason != tc.wantReason {
					t.Fatalf("reason = %q, want %q", reason, tc.wantReason)
				}
				if out != nil {
					t.Fatalf("a refusal must not write bytes, got %q", out)
				}
			default:
				if err != nil || code != "" {
					t.Fatalf("want a clean write, got code=%q reason=%q err=%v", code, reason, err)
				}
				if !strings.Contains(string(out), tc.wantHCL) {
					t.Fatalf("want %q in output, got:\n%s", tc.wantHCL, out)
				}
			}
		})
	}
}

// TestCovsetattrSetAttributeNestedValueTokenRefusal: a path-addressed scalar set
// whose value param is a cross-type reference refuses REFERENCE_TYPE_MISMATCH from
// inside the nested lane — the nested block is never mutated (nil bytes).
func TestCovsetattrSetAttributeNestedValueTokenRefusal(t *testing.T) {
	dir := covsetattrEnv(t, map[string]string{"refs.tf": "resource \"aws_iam_role\" \"r\" {}\n"})
	src := "resource \"aws_instance\" \"x\" {\n  root_block_device {\n    volume_size = 100\n  }\n}\n"
	value := manifests.Param{
		Name: "key", Source: "inventory", Role: "reference", RefAttr: "arn",
		EnumSource: "inventory://aws_kms_key/arn", Attr: "kms_key_id",
	}
	op := covsetattrOp("set_attribute", "aws_instance", covsetattrTarget, value)
	op.Target.Path = []string{"root_block_device"}
	req := covsetattrReq(map[string]any{"target": "aws_instance.x", "key": "aws_iam_role.r"})

	out, code, reason, err := setAttribute(op, req, covsetattrLocIn(dir, src))
	if err != nil {
		t.Fatalf("want a refusal, got err=%v", err)
	}
	if code != "REFERENCE_TYPE_MISMATCH" {
		t.Fatalf("code = %q, want REFERENCE_TYPE_MISMATCH", code)
	}
	if out != nil {
		t.Fatalf("a refusal must not write bytes, got %q", out)
	}
	if !strings.Contains(reason, "aws_kms_key") || !strings.Contains(reason, "aws_iam_role.r") {
		t.Fatalf("reason = %q, want it to name the allowed type and the offending address", reason)
	}
}

// ── currentNumber: the grow-only file read ─────────────────────────────────

// TestCovsetattrCurrentNumber: currentNumber only reports a value it can prove is a
// literal number on the block's FIRST block; every other shape reports ok=false so
// the caller fails closed instead of comparing against a guess.
func TestCovsetattrCurrentNumber(t *testing.T) {
	cases := []struct {
		name  string
		src   string
		attr  string
		want  float64
		wantK bool
	}{
		{"literal int", "resource \"aws_ebs_volume\" \"v\" {\n  size = 100\n}\n", "size", 100, true},
		{"literal float", "resource \"aws_ebs_volume\" \"v\" {\n  size = 1.5\n}\n", "size", 1.5, true},
		{"unparseable bytes", "resource \"x\" {\n  size = = 1\n", "size", 0, false},
		{"no blocks at all", "size = 100\n", "size", 0, false},
		{"attribute absent", "resource \"aws_ebs_volume\" \"v\" {\n  iops = 3000\n}\n", "size", 0, false},
		{"non-number literal", "resource \"aws_ebs_volume\" \"v\" {\n  size = \"100\"\n}\n", "size", 0, false},
		{"non-static expression", "resource \"aws_ebs_volume\" \"v\" {\n  size = var.size\n}\n", "size", 0, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := currentNumber([]byte(tc.src), tc.attr)
			if ok != tc.wantK || got != tc.want {
				t.Fatalf("currentNumber = (%v, %v), want (%v, %v)", got, ok, tc.want, tc.wantK)
			}
		})
	}
}

// ── mergeMap: value-coercion failures ───────────────────────────────────────

// TestCovsetattrMergeMapUnsupportedValue: a request map value of a type the value
// coercion does not support is an internal error (exit 1) — for an EXISTING key
// (value-token replacement) and for a NEW key (append) alike. Nothing is written.
func TestCovsetattrMergeMapUnsupportedValue(t *testing.T) {
	cases := []struct {
		name string
		key  string
	}{
		{"existing key", "Owner"},
		{"new key", "CostCentre"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			src := "resource \"aws_s3_bucket\" \"b\" {\n  tags = {\n    Owner = \"basis\"\n  }\n}\n"
			f, block := covsetattrParseBlock(t, src)
			code, reason, err := mergeMap(block, "tags", map[string]any{tc.key: uint64(7)}, false, "aws_s3_bucket")
			if err == nil {
				t.Fatalf("want an error for an unsupported value type, got code=%q reason=%q", code, reason)
			}
			if code != "" {
				t.Fatalf("want a plain error, got refuse code %q", code)
			}
			if !strings.Contains(err.Error(), "unsupported value type uint64") {
				t.Fatalf("err = %v, want it to name the unsupported type", err)
			}
			if strings.Contains(string(f.Bytes()), "7") {
				t.Fatalf("map was mutated on error, want untouched:\n%s", f.Bytes())
			}
		})
	}
}

// ── parseObject: the literal-object token splitter ──────────────────────────

// TestCovsetattrParseObjectFromHCL exercises parseObject on shapes that come out of
// real HCL: a nested object value, a bracketed list value (whose internal commas must
// NOT split the entry), and an inline block comment inside a value. Values are compared
// as concatenated token BYTES (hclwrite carries inter-token spacing out of band), so the
// assertion is about which tokens landed in which entry, not about layout.
func TestCovsetattrParseObjectFromHCL(t *testing.T) {
	cases := []struct {
		name     string
		src      string
		wantKeys []string
		wantVals []string
	}{
		{
			name:     "nested object value keeps depth",
			src:      "resource \"x\" \"y\" {\n  m = {\n    a = { b = \"c\" }\n    d = \"e\"\n  }\n}\n",
			wantKeys: []string{"a", "d"},
			wantVals: []string{"{b=\"c\"}", "\"e\""},
		},
		{
			name:     "bracketed list value keeps internal commas",
			src:      "resource \"x\" \"y\" {\n  m = {\n    a = [\"p\", \"q\"]\n    d = \"e\"\n  }\n}\n",
			wantKeys: []string{"a", "d"},
			wantVals: []string{"[\"p\",\"q\"]", "\"e\""},
		},
		{
			name:     "parenthesised value keeps depth",
			src:      "resource \"x\" \"y\" {\n  m = {\n    a = (1 + 2)\n    d = \"e\"\n  }\n}\n",
			wantKeys: []string{"a", "d"},
			wantVals: []string{"(1+2)", "\"e\""},
		},
		{
			// CTL-10: a non-trailing comment (this one doesn't end in "\n", so it
			// sits INSIDE the value, not at the end of the entry's own line) stays
			// in ValToks, in place, rather than being hoisted into Entry.Comment
			// and re-emitted after the value — hoisting it would reposition a
			// comment on an entry a merge never touched, adding a spurious second
			// changed line to what must be a one-line diff. See hclobj.ParseObject's
			// doc comment for the full reasoning (this is the one observable
			// behavior change from reconciling edit's and driftpropose's two
			// independently-diverged copies of this walker into one).
			name:     "inline block comment inside a value does not end the entry",
			src:      "resource \"x\" \"y\" {\n  m = {\n    a = /* why */ \"v\"\n    d = \"e\"\n  }\n}\n",
			wantKeys: []string{"a", "d"},
			wantVals: []string{"/* why */\"v\"", "\"e\""},
		},
		{
			name:     "single-entry map with a comma separator",
			src:      "resource \"x\" \"y\" {\n  m = { a = \"v\", d = \"e\" }\n}\n",
			wantKeys: []string{"a", "d"},
			wantVals: []string{"\"v\"", "\"e\""},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, block := covsetattrParseBlock(t, tc.src)
			entries, ok := hclobj.ParseObject(block.Body().GetAttribute("m").Expr().BuildTokens(nil))
			if !ok {
				t.Fatal("parseObject not ok on a literal object")
			}
			if len(entries) != len(tc.wantKeys) {
				t.Fatalf("got %d entries, want %d", len(entries), len(tc.wantKeys))
			}
			for i := range tc.wantKeys {
				if entries[i].Key != tc.wantKeys[i] {
					t.Fatalf("entry %d key = %q, want %q", i, entries[i].Key, tc.wantKeys[i])
				}
				if got := strings.TrimSpace(tokensString(entries[i].ValToks)); got != strings.TrimSpace(tc.wantVals[i]) {
					t.Fatalf("entry %d value = %q, want %q", i, got, tc.wantVals[i])
				}
			}
		})
	}
}

// TestCovsetattrParseObjectTokenStreams exercises the token-level contract directly:
// leading comments/newlines before the `{` are skipped, and every malformed stream
// (no brace, a key with no `=`, a truncated key, an unterminated object) reports
// ok=false so the caller refuses NOT_LITERAL rather than rewriting debris.
func TestCovsetattrParseObjectTokenStreams(t *testing.T) {
	obrace := covsetattrTok(hclsyntax.TokenOBrace, "{")
	cbrace := covsetattrTok(hclsyntax.TokenCBrace, "}")
	nl := covsetattrTok(hclsyntax.TokenNewline, "\n")
	eq := covsetattrTok(hclsyntax.TokenEqual, "=")
	k := covsetattrTok(hclsyntax.TokenIdent, "k")
	v := covsetattrTok(hclsyntax.TokenIdent, "v")

	cases := []struct {
		name     string
		toks     hclwrite.Tokens
		wantOK   bool
		wantKeys []string
	}{
		{
			name:     "leading comment and newline before the brace are skipped",
			toks:     hclwrite.Tokens{covsetattrTok(hclsyntax.TokenComment, "# lead\n"), nl, obrace, nl, k, eq, v, nl, cbrace},
			wantOK:   true,
			wantKeys: []string{"k"},
		},
		{
			name:   "empty object",
			toks:   hclwrite.Tokens{obrace, cbrace},
			wantOK: true,
		},
		{
			name:   "not an object at all",
			toks:   hclwrite.Tokens{covsetattrTok(hclsyntax.TokenIdent, "local"), covsetattrTok(hclsyntax.TokenDot, "."), covsetattrTok(hclsyntax.TokenIdent, "tags")},
			wantOK: false,
		},
		{
			name:   "empty token stream",
			toks:   hclwrite.Tokens{},
			wantOK: false,
		},
		{
			name:   "key with no equals before the newline",
			toks:   hclwrite.Tokens{obrace, nl, k, nl, cbrace},
			wantOK: false,
		},
		{
			name:   "key with no equals before the closing brace",
			toks:   hclwrite.Tokens{obrace, nl, k, cbrace},
			wantOK: false,
		},
		{
			name:   "truncated after the key",
			toks:   hclwrite.Tokens{obrace, nl, k},
			wantOK: false,
		},
		{
			name:   "unterminated object",
			toks:   hclwrite.Tokens{obrace, nl, k, eq, v},
			wantOK: false,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			entries, ok := hclobj.ParseObject(tc.toks)
			if ok != tc.wantOK {
				t.Fatalf("parseObject ok = %v, want %v (entries=%d)", ok, tc.wantOK, len(entries))
			}
			if !tc.wantOK {
				if entries != nil {
					t.Fatalf("want nil entries on failure, got %d", len(entries))
				}
				return
			}
			if len(entries) != len(tc.wantKeys) {
				t.Fatalf("got %d entries, want %d", len(entries), len(tc.wantKeys))
			}
			for i := range tc.wantKeys {
				if entries[i].Key != tc.wantKeys[i] {
					t.Fatalf("entry %d key = %q, want %q", i, entries[i].Key, tc.wantKeys[i])
				}
			}
		})
	}
}

// ── value coercion: anyToCty / toStringMap / toFloat / num ──────────────────

// TestCovsetattrAnyToCty pins the coercion of every supported request-value kind to
// its cty counterpart (the shape the emitted HCL tokens are built from), and that an
// unsupported type is a named error rather than a silent nil write.
func TestCovsetattrAnyToCty(t *testing.T) {
	cases := []struct {
		name string
		in   any
		want cty.Value
	}{
		{"string", "erp", cty.StringVal("erp")},
		{"bool", true, cty.BoolVal(true)},
		{"int", 7, cty.NumberIntVal(7)},
		{"int64", int64(9), cty.NumberIntVal(9)},
		{"integral float64 stays an int", float64(20), cty.NumberIntVal(20)},
		{"fractional float64", 1.5, cty.NumberFloatVal(1.5)},
		{"empty list", []any{}, cty.EmptyTupleVal},
		{"heterogeneous list", []any{"a", 2, true}, cty.TupleVal([]cty.Value{cty.StringVal("a"), cty.NumberIntVal(2), cty.BoolVal(true)})},
		{"empty map", map[string]any{}, cty.EmptyObjectVal},
		{"map", map[string]any{"k": "v", "n": 3}, cty.ObjectVal(map[string]cty.Value{"k": cty.StringVal("v"), "n": cty.NumberIntVal(3)})},
		{"nested map in list", []any{map[string]any{"k": "v"}}, cty.TupleVal([]cty.Value{cty.ObjectVal(map[string]cty.Value{"k": cty.StringVal("v")})})},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := anyToCty(tc.in)
			if err != nil {
				t.Fatalf("anyToCty(%#v) err = %v", tc.in, err)
			}
			if !got.RawEquals(tc.want) {
				t.Fatalf("anyToCty(%#v) = %#v, want %#v", tc.in, got, tc.want)
			}
		})
	}

	errCases := []struct {
		name string
		in   any
	}{
		{"unsupported scalar", uint64(3)},
		{"unsupported nil", nil},
		{"unsupported inside a list", []any{"ok", uint64(3)}},
		{"unsupported inside a map", map[string]any{"k": uint64(3)}},
	}
	for _, tc := range errCases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := anyToCty(tc.in)
			if err == nil {
				t.Fatalf("want an error for %#v, got %#v", tc.in, got)
			}
			if !strings.Contains(err.Error(), "unsupported value type") {
				t.Fatalf("err = %v, want \"unsupported value type\"", err)
			}
			if got != cty.NilVal {
				t.Fatalf("want cty.NilVal alongside the error, got %#v", got)
			}
		})
	}
}

// TestCovsetattrToStringMap: a YAML map decodes as either map[string]any or
// map[any]any; the latter is accepted only when every key is a string, so a
// non-string key fails closed (the caller then errors rather than dropping a key).
func TestCovsetattrToStringMap(t *testing.T) {
	cases := []struct {
		name   string
		in     any
		want   map[string]any
		wantOK bool
	}{
		{"string-keyed map", map[string]any{"a": 1}, map[string]any{"a": 1}, true},
		{"any-keyed map with string keys", map[any]any{"a": 1, "b": "c"}, map[string]any{"a": 1, "b": "c"}, true},
		{"empty any-keyed map", map[any]any{}, map[string]any{}, true},
		{"any-keyed map with an int key", map[any]any{1: "x"}, nil, false},
		{"not a map at all", "tags", nil, false},
		{"nil", nil, nil, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := toStringMap(tc.in)
			if ok != tc.wantOK {
				t.Fatalf("toStringMap ok = %v, want %v", ok, tc.wantOK)
			}
			if !tc.wantOK {
				if got != nil {
					t.Fatalf("want nil map on failure, got %#v", got)
				}
				return
			}
			if len(got) != len(tc.want) {
				t.Fatalf("got %#v, want %#v", got, tc.want)
			}
			for k, v := range tc.want {
				if got[k] != v {
					t.Fatalf("key %q = %#v, want %#v", k, got[k], v)
				}
			}
		})
	}
}

// TestCovsetattrToFloat pins which request-value types the grow-only guard accepts
// as a number. Anything else reports ok=false so the guard errors instead of
// comparing against a zero it invented.
func TestCovsetattrToFloat(t *testing.T) {
	cases := []struct {
		name   string
		in     any
		want   float64
		wantOK bool
	}{
		{"float64", float64(1.5), 1.5, true},
		{"float32", float32(2.5), 2.5, true},
		{"int", 100, 100, true},
		{"int64", int64(200), 200, true},
		{"numeric string", "300", 300, true},
		{"fractional string", "1.25", 1.25, true},
		{"non-numeric string", "big", 0, false},
		{"bool", true, 0, false},
		{"nil", nil, 0, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := toFloat(tc.in)
			if ok != tc.wantOK || got != tc.want {
				t.Fatalf("toFloat(%#v) = (%v, %v), want (%v, %v)", tc.in, got, ok, tc.want, tc.wantOK)
			}
		})
	}
}

// TestCovsetattrNum: the refusal-reason number formatter renders an integral value
// with no decimal point and a fractional one without float noise — the reason string
// is part of the machine-greppable refusal contract.
func TestCovsetattrNum(t *testing.T) {
	cases := []struct {
		in   float64
		want string
	}{
		{100, "100"},
		{0, "0"},
		{-8, "-8"},
		{1.5, "1.5"},
		{0.25, "0.25"},
	}
	for _, tc := range cases {
		t.Run(tc.want, func(t *testing.T) {
			if got := num(tc.in); got != tc.want {
				t.Fatalf("num(%v) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

// ── setAttributes: the multi-attribute driver ──────────────────────────────

// TestCovsetattrSetAttributesParseFailure: the located bytes must reparse to one
// block; otherwise exit 1 with nothing written.
func TestCovsetattrSetAttributesParseFailure(t *testing.T) {
	value := manifests.Param{Name: "new_a", Source: "user_input"}
	op := covsetattrOp("set_attributes", "aws_x", covsetattrTarget, value)
	req := covsetattrReq(map[string]any{"target": "aws_x.y", "new_a": "v"})

	out, code, _, err := setAttributes(op, req, covsetattrLoc(t, "a = = 1\n"))
	if err == nil || code != "" {
		t.Fatalf("want plain error, got out=%q code=%q err=%v", out, code, err)
	}
	if !strings.Contains(err.Error(), "parse block") {
		t.Fatalf("err = %v, want \"parse block\"", err)
	}
}

// TestCovsetattrSetAttributesOptionalAndConst: an optional value param the request
// did not supply is left as-is, while a role:"const" param is written even though it
// has no request input at all (its value comes from the manifest).
func TestCovsetattrSetAttributesOptionalAndConst(t *testing.T) {
	src := "resource \"aws_instance\" \"x\" {\n  a          = \"old-a\"\n  b          = \"keep-b\"\n  http_tokens = \"optional\"\n}\n"
	params := []manifests.Param{
		covsetattrTarget,
		{Name: "new_a", Source: "user_input"},
		{Name: "new_b", Source: "user_input"},
		{Name: "tokens", Role: "const", Attr: "http_tokens", Const: "required"},
	}
	op := covsetattrOp("set_attributes", "aws_instance", params...)
	// new_b is deliberately absent from the request.
	req := covsetattrReq(map[string]any{"target": "aws_instance.x", "new_a": "new-a"})

	out, code, reason, err := setAttributes(op, req, covsetattrLoc(t, src))
	if err != nil || code != "" {
		t.Fatalf("code=%q reason=%q err=%v, want a clean multi-attribute write", code, reason, err)
	}
	got := string(out)
	if !strings.Contains(got, "a           = \"new-a\"") && !strings.Contains(got, "a = \"new-a\"") {
		t.Fatalf("a was not updated:\n%s", got)
	}
	if !strings.Contains(got, "\"keep-b\"") {
		t.Fatalf("absent optional param must leave b untouched:\n%s", got)
	}
	if strings.Contains(got, "\"optional\"") || !strings.Contains(got, "\"required\"") {
		t.Fatalf("const param must be written without request input:\n%s", got)
	}
}

// TestCovsetattrSetAttributesUnnamedParam: a param that resolves to no attribute
// name is a manifest inconsistency → exit 1 before anything is written.
func TestCovsetattrSetAttributesUnnamedParam(t *testing.T) {
	src := "resource \"aws_instance\" \"x\" {\n  a = \"old\"\n}\n"
	params := []manifests.Param{covsetattrTarget, {Name: "", Role: "const", Const: "v"}}
	op := covsetattrOp("set_attributes", "aws_instance", params...)
	req := covsetattrReq(map[string]any{"target": "aws_instance.x"})

	out, code, _, err := setAttributes(op, req, covsetattrLoc(t, src))
	if err == nil || code != "" {
		t.Fatalf("want plain error, got out=%q code=%q err=%v", out, code, err)
	}
	if !strings.Contains(err.Error(), "cannot resolve attribute name for param") {
		t.Fatalf("err = %v, want \"cannot resolve attribute name for param\"", err)
	}
}

// TestCovsetattrSetAttributesUnsupportedDottedAttr: a dotted attribute name refuses
// UNSUPPORTED_PATH — nested writes are addressed by target.path, never a dotted LHS.
func TestCovsetattrSetAttributesUnsupportedDottedAttr(t *testing.T) {
	src := "resource \"aws_instance\" \"x\" {\n  a = \"old\"\n}\n"
	params := []manifests.Param{covsetattrTarget, {Name: "v", Attr: "root_block_device.volume_size"}}
	op := covsetattrOp("set_attributes", "aws_instance", params...)
	req := covsetattrReq(map[string]any{"target": "aws_instance.x", "v": 30})

	out, code, reason, err := setAttributes(op, req, covsetattrLoc(t, src))
	if err != nil {
		t.Fatalf("want a refusal, got err=%v", err)
	}
	if code != "UNSUPPORTED_PATH" {
		t.Fatalf("code = %q, want UNSUPPORTED_PATH", code)
	}
	if out != nil {
		t.Fatalf("a refusal must not write bytes, got %q", out)
	}
	if !strings.Contains(reason, "root_block_device.volume_size") {
		t.Fatalf("reason = %q, want it to name the dotted path", reason)
	}
}

// TestCovsetattrSetAttributesGrowOnly: the per-param grow-only guard runs BEFORE any
// mutation, so a shrink refuses SHRINK with nil bytes (all-or-nothing) even when an
// earlier param in the same op would have been a legal write. A non-numeric value or
// an unreadable current value is exit 1.
func TestCovsetattrSetAttributesGrowOnly(t *testing.T) {
	grow := manifests.Param{Name: "new_size", Source: "user_input", Bounds: &manifests.Bounds{GrowOnly: true}}
	other := manifests.Param{Name: "new_iops", Source: "user_input"}

	cases := []struct {
		name       string
		src        string
		size       any
		wantCode   string
		wantReason string
		wantErr    string
	}{
		{
			name: "shrink refuses and writes nothing",
			src:  "resource \"aws_ebs_volume\" \"v\" {\n  size = 100\n  iops = 3000\n}\n",
			size: 50, wantCode: "SHRINK", wantReason: "new_size 50 is below current 100 (grow-only)",
		},
		{
			name: "non-numeric value errors",
			src:  "resource \"aws_ebs_volume\" \"v\" {\n  size = 100\n  iops = 3000\n}\n",
			size: "big", wantErr: "grow-only param \"new_size\" is not numeric",
		},
		{
			name: "unreadable current value errors",
			src:  "resource \"aws_ebs_volume\" \"v\" {\n  iops = 3000\n}\n",
			size: 200, wantErr: "cannot read current \"size\" value",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			op := covsetattrOp("set_attributes", "aws_ebs_volume", covsetattrTarget, other, grow)
			req := covsetattrReq(map[string]any{"target": "aws_ebs_volume.v", "new_iops": 4000, "new_size": tc.size})

			out, code, reason, err := setAttributes(op, req, covsetattrLoc(t, tc.src))
			if out != nil {
				t.Fatalf("all-or-nothing violated: got bytes %q", out)
			}
			if tc.wantErr != "" {
				if err == nil || code != "" {
					t.Fatalf("want plain error %q, got code=%q err=%v", tc.wantErr, code, err)
				}
				if err.Error() != tc.wantErr {
					t.Fatalf("err = %v, want %q", err, tc.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("want refusal %s, got err=%v", tc.wantCode, err)
			}
			if code != tc.wantCode || reason != tc.wantReason {
				t.Fatalf("got (%q, %q), want (%q, %q)", code, reason, tc.wantCode, tc.wantReason)
			}
		})
	}
}

// TestCovsetattrSetAttributesValueTokenRefusal: a cross-type reference among the
// params refuses REFERENCE_TYPE_MISMATCH before any attribute is written, so the
// legal sibling param is NOT half-applied.
func TestCovsetattrSetAttributesValueTokenRefusal(t *testing.T) {
	dir := covsetattrEnv(t, map[string]string{"refs.tf": "resource \"aws_iam_role\" \"r\" {}\n"})
	src := "resource \"aws_instance\" \"x\" {\n  a = \"old\"\n}\n"
	params := []manifests.Param{
		covsetattrTarget,
		{Name: "new_a", Source: "user_input"},
		{Name: "key", Source: "inventory", Role: "reference", RefAttr: "arn",
			EnumSource: "inventory://aws_kms_key/arn", Attr: "kms_key_id"},
	}
	op := covsetattrOp("set_attributes", "aws_instance", params...)
	req := covsetattrReq(map[string]any{"target": "aws_instance.x", "new_a": "new", "key": "aws_iam_role.r"})

	out, code, reason, err := setAttributes(op, req, covsetattrLocIn(dir, src))
	if err != nil {
		t.Fatalf("want a refusal, got err=%v", err)
	}
	if code != "REFERENCE_TYPE_MISMATCH" {
		t.Fatalf("code = %q, want REFERENCE_TYPE_MISMATCH", code)
	}
	if out != nil {
		t.Fatalf("a refusal must not write bytes, got %q", out)
	}
	if !strings.Contains(reason, "aws_kms_key") {
		t.Fatalf("reason = %q, want it to name the allowed type", reason)
	}
}

// TestCovsetattrSetAttributesNested: with target.path set, every attribute lands
// INSIDE the descended block (the top-level body is untouched), the grow-only guard
// reads the current value from that nested block, and an unresolvable path refuses
// before any mutation.
func TestCovsetattrSetAttributesNested(t *testing.T) {
	src := "resource \"aws_lb_target_group\" \"g\" {\n  port = 80\n\n  health_check {\n    interval = 30\n    timeout  = 5\n  }\n}\n"
	grow := manifests.Param{Name: "new_interval", Source: "user_input", Bounds: &manifests.Bounds{GrowOnly: true}}
	other := manifests.Param{Name: "new_timeout", Source: "user_input"}

	t.Run("writes land in the descended block", func(t *testing.T) {
		op := covsetattrOp("set_attributes", "aws_lb_target_group", covsetattrTarget, grow, other)
		op.Target.Path = []string{"health_check"}
		req := covsetattrReq(map[string]any{"target": "aws_lb_target_group.g", "new_interval": 60, "new_timeout": 10})

		out, code, reason, err := setAttributes(op, req, covsetattrLoc(t, src))
		if err != nil || code != "" {
			t.Fatalf("code=%q reason=%q err=%v, want a clean nested write", code, reason, err)
		}
		want := "resource \"aws_lb_target_group\" \"g\" {\n  port = 80\n\n  health_check {\n    interval = 60\n    timeout  = 10\n  }\n}\n"
		if string(out) != want {
			t.Fatalf("nested set_attributes output:\n--- got ---\n%s\n--- want ---\n%s", out, want)
		}
	})

	t.Run("grow-only reads the nested current value", func(t *testing.T) {
		op := covsetattrOp("set_attributes", "aws_lb_target_group", covsetattrTarget, grow)
		op.Target.Path = []string{"health_check"}
		req := covsetattrReq(map[string]any{"target": "aws_lb_target_group.g", "new_interval": 10})

		out, code, reason, err := setAttributes(op, req, covsetattrLoc(t, src))
		if err != nil {
			t.Fatalf("want SHRINK, got err=%v", err)
		}
		if code != "SHRINK" {
			t.Fatalf("code = %q, want SHRINK", code)
		}
		if reason != "new_interval 10 is below current 30 (grow-only)" {
			t.Fatalf("reason = %q, want it to name the nested current value 30", reason)
		}
		if out != nil {
			t.Fatalf("a refusal must not write bytes, got %q", out)
		}
	})

	t.Run("unresolvable path refuses", func(t *testing.T) {
		op := covsetattrOp("set_attributes", "aws_lb_target_group", covsetattrTarget, other)
		op.Target.Path = []string{"stickiness"}
		req := covsetattrReq(map[string]any{"target": "aws_lb_target_group.g", "new_timeout": 10})

		out, code, reason, err := setAttributes(op, req, covsetattrLoc(t, src))
		if err != nil {
			t.Fatalf("want a refusal, got err=%v", err)
		}
		if code != "PATH_NOT_FOUND" {
			t.Fatalf("code = %q, want PATH_NOT_FOUND", code)
		}
		if out != nil {
			t.Fatalf("a refusal must not write bytes, got %q", out)
		}
		if !strings.Contains(reason, "stickiness") {
			t.Fatalf("reason = %q, want it to name the missing block", reason)
		}
	})
}

// ── value.go: valueTokens / refTokens failure modes ─────────────────────────

// TestCovsetattrRefTokensNoRefAttr: a role:"reference" param with no refAttr names no
// attribute to read off the referenced block — a resolution error (exit 3), never a
// bare `aws_kms_key.k` written as a value.
func TestCovsetattrRefTokensNoRefAttr(t *testing.T) {
	dir := covsetattrEnv(t, map[string]string{"refs.tf": "resource \"aws_kms_key\" \"k\" {}\n"})
	p := manifests.Param{Name: "key", Source: "inventory", Role: "reference"}

	toks, code, _, err := valueTokens(dir, p, "aws_kms_key.k")
	if err == nil {
		t.Fatalf("want an error for a reference with no refAttr, got toks=%q", tokensString(toks))
	}
	if code != "" {
		t.Fatalf("want a plain resolution error, got refuse code %q", code)
	}
	if !errors.Is(err, errResolution) {
		t.Fatalf("err = %v, want it wrapped in errResolution (exit 3)", err)
	}
	if !strings.Contains(err.Error(), "has no refAttr to read") {
		t.Fatalf("err = %v, want \"has no refAttr to read\"", err)
	}
}

// TestCovsetattrValueTokensCoercionErrors: a const or literal value of an
// unsupported type is an internal error (exit 1), named by type.
func TestCovsetattrValueTokensCoercionErrors(t *testing.T) {
	cases := []struct {
		name string
		p    manifests.Param
		raw  any
		want string
	}{
		{"const of an unsupported type", manifests.Param{Name: "c", Role: "const", Const: []string{"x"}}, nil, "unsupported value type []string"},
		{"literal value of an unsupported type", manifests.Param{Name: "v", Source: "user_input"}, uint64(3), "unsupported value type uint64"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			toks, code, reason, err := valueTokens(t.TempDir(), tc.p, tc.raw)
			if err == nil {
				t.Fatalf("want an error, got toks=%q code=%q reason=%q", tokensString(toks), code, reason)
			}
			if code != "" {
				t.Fatalf("want a plain error, got refuse code %q", code)
			}
			if toks != nil {
				t.Fatalf("want nil tokens alongside the error, got %q", tokensString(toks))
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("err = %v, want %q", err, tc.want)
			}
			if errors.Is(err, errResolution) {
				t.Fatalf("a coercion failure is an internal error (exit 1), not a resolution error: %v", err)
			}
		})
	}
}

// TestCovsetattrValueTokensReferenceShapeErrors: a role:"reference" param's value
// must be an address string or a list of address strings. Any other shape is an
// errResolution-wrapped error (exit 3) — the request cannot be resolved.
func TestCovsetattrValueTokensReferenceShapeErrors(t *testing.T) {
	p := manifests.Param{Name: "key", Source: "inventory", Role: "reference", RefAttr: "arn"}
	cases := []struct {
		name string
		raw  any
		want string
	}{
		{"a number is neither an address nor a list", 42, "value is not a string or list"},
		{"nil", nil, "value is not a string or list"},
		{"a map", map[string]any{"a": "b"}, "value is not a string or list"},
		{"a list element that is not a string", []any{7}, "list element is not a string"},
		{"a list element that is a nested list", []any{[]any{"a"}}, "list element is not a string"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			toks, code, _, err := valueTokens(t.TempDir(), p, tc.raw)
			if err == nil {
				t.Fatalf("want an error, got toks=%q", tokensString(toks))
			}
			if code != "" {
				t.Fatalf("want a plain resolution error, got refuse code %q", code)
			}
			if !errors.Is(err, errResolution) {
				t.Fatalf("err = %v, want it wrapped in errResolution (exit 3)", err)
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("err = %v, want %q", err, tc.want)
			}
		})
	}
}

// TestCovsetattrRefTokensLocateIOError: a reference whose env directory contains an
// unparseable .tf cannot be resolved at all. Locate reports that as an I/O/parse
// failure (exit 1), which must NOT be laundered into an errResolution (exit 3) —
// the exit code distinguishes "the request is unresolvable" from "the tree is broken".
func TestCovsetattrRefTokensLocateIOError(t *testing.T) {
	dir := covsetattrEnv(t, map[string]string{
		"refs.tf":   "resource \"aws_kms_key\" \"k\" {}\n",
		"broken.tf": "resource \"aws_kms_key\" {{{\n",
	})
	p := manifests.Param{Name: "key", Source: "inventory", Role: "reference", RefAttr: "arn"}

	toks, code, _, err := valueTokens(dir, p, "aws_kms_key.k")
	if err == nil {
		t.Fatalf("want an error for an unparseable env, got toks=%q", tokensString(toks))
	}
	if code != "" {
		t.Fatalf("want a plain error, got refuse code %q", code)
	}
	if errors.Is(err, errResolution) {
		t.Fatalf("a parse failure must stay an internal error (exit 1), got errResolution: %v", err)
	}
	if !strings.Contains(err.Error(), "broken.tf") {
		t.Fatalf("err = %v, want it to name the unparseable file", err)
	}
}

// TestCovsetattrRefTokensUntraversableRefAttr: a refAttr that cannot form a valid
// HCL traversal is a resolution error (exit 3) — never a written expression that
// terraform fmt would reject.
func TestCovsetattrRefTokensUntraversableRefAttr(t *testing.T) {
	dir := covsetattrEnv(t, map[string]string{"refs.tf": "resource \"aws_kms_key\" \"k\" {}\n"})
	p := manifests.Param{Name: "key", Source: "inventory", Role: "reference", RefAttr: "-nope"}

	toks, code, _, err := valueTokens(dir, p, "aws_kms_key.k")
	if err == nil {
		t.Fatalf("want an error for an untraversable refAttr, got toks=%q", tokensString(toks))
	}
	if code != "" {
		t.Fatalf("want a plain resolution error, got refuse code %q", code)
	}
	if !errors.Is(err, errResolution) {
		t.Fatalf("err = %v, want it wrapped in errResolution (exit 3)", err)
	}
	if !strings.Contains(err.Error(), "parse reference") {
		t.Fatalf("err = %v, want \"parse reference\"", err)
	}
}

// TestCovsetattrValueTokensReferenceListSucceeds is the positive shape the failure
// cases above guard: every element resolves through the same pipeline and the result
// is a tuple of traversals, optionally wrapped by wrap:"list".
func TestCovsetattrValueTokensReferenceListSucceeds(t *testing.T) {
	dir := covsetattrEnv(t, map[string]string{
		"refs.tf": "resource \"aws_subnet\" \"a\" {}\nresource \"aws_subnet\" \"b\" {}\n",
	})
	p := manifests.Param{Name: "subnet_ids", Type: "list", Source: "inventory", Role: "reference",
		RefAttr: "id", EnumSource: "inventory://aws_subnet/address"}

	toks, code, reason, err := valueTokens(dir, p, []any{"aws_subnet.a", "aws_subnet.b"})
	if err != nil || code != "" {
		t.Fatalf("code=%q reason=%q err=%v", code, reason, err)
	}
	if got := tokensString(toks); got != "[aws_subnet.a.id,aws_subnet.b.id]" {
		t.Fatalf("tokens = %q, want [aws_subnet.a.id,aws_subnet.b.id]", got)
	}

	p.Wrap = "list"
	toks, code, reason, err = valueTokens(dir, p, "aws_subnet.a")
	if err != nil || code != "" {
		t.Fatalf("wrap:list code=%q reason=%q err=%v", code, reason, err)
	}
	if got := tokensString(toks); got != "[aws_subnet.a.id]" {
		t.Fatalf("wrapped tokens = %q, want [aws_subnet.a.id]", got)
	}
}

// A required:false param carrying a manifest `default` used to blow up:
// manifests.Validate deliberately skips an absent non-required param, so the
// request passed validation and then reached anyToCty(nil), failing with
// "unsupported value type <nil>" — exit 1 for a request the catalogue calls
// valid. This is the ebs-gp2-to-gp3 shape (target_type, required:false,
// default "gp3"), which no golden case covered.
func TestCovsetattrOmittedParamFallsBackToTheManifestDefault(t *testing.T) {
	vp := manifests.Param{
		Name: "target_type", Source: "allowlist", Required: false,
		Default: json.RawMessage(`"gp3"`),
	}
	op := covsetattrOp("set_attribute", "aws_ebs_volume", covsetattrTarget, vp)
	op.Target.Attr = "type"
	src := "resource \"aws_ebs_volume\" \"v\" {\n  type = \"gp2\"\n}\n"

	t.Run("absent param uses the declared default", func(t *testing.T) {
		req := covsetattrReq(map[string]any{"target": "aws_ebs_volume.v"})
		out, code, reason, err := setAttribute(op, req, covsetattrLoc(t, src))
		if err != nil || code != "" {
			t.Fatalf("setAttribute = code %q reason %q err %v, want a clean write", code, reason, err)
		}
		if !strings.Contains(string(out), `type = "gp3"`) {
			t.Fatalf("want type = \"gp3\" from the manifest default, got:\n%s", out)
		}
	})
	t.Run("an explicit request value still wins over the default", func(t *testing.T) {
		req := covsetattrReq(map[string]any{"target": "aws_ebs_volume.v", "target_type": "io2"})
		out, code, _, err := setAttribute(op, req, covsetattrLoc(t, src))
		if err != nil || code != "" {
			t.Fatalf("setAttribute: code %q err %v", code, err)
		}
		if !strings.Contains(string(out), `type = "io2"`) {
			t.Fatalf("the request value must win over the default, got:\n%s", out)
		}
	})
	t.Run("no default and no request value is still an error, not a bogus write", func(t *testing.T) {
		bare := covsetattrOp("set_attribute", "aws_ebs_volume", covsetattrTarget,
			manifests.Param{Name: "target_type", Source: "allowlist"})
		bare.Target.Attr = "type"
		out, _, _, err := setAttribute(bare, covsetattrReq(map[string]any{"target": "aws_ebs_volume.v"}), covsetattrLoc(t, src))
		if err == nil {
			t.Fatalf("want an error with neither a request value nor a default, wrote:\n%s", out)
		}
		if out != nil {
			t.Fatalf("want nil bytes on error, got %q", out)
		}
	})
}
