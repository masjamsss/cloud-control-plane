package edit

import (
	"strings"
	"testing"

	"github.com/hashicorp/hcl/v2"
	"github.com/hashicorp/hcl/v2/hclsyntax"
	"github.com/hashicorp/hcl/v2/hclwrite"

	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/hclops"
	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/manifests"
	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/request"
)

// covblocks_cov_test.go covers the block-shaped codemods — foreach.go
// (for_each/count map entries), listentry.go (literal-list add/remove), nested.go
// (path+selector addressing helpers), moved.go (relabel + moved{}) and
// swapblock.go (closed-choice block swap) — concentrating on the fail-closed
// branches: every REFUSE <CODE> those verbs can emit (exit 2 per the README's
// safety model) and every internal/resolution error they return instead of
// authoring wrong HCL at exit 0.
//
// The verbs are driven directly (not through `run`) with a synthetic
// hclops.Located, exactly like the existing swapblock_test.go / nested_test.go, so
// every case is hermetic: no env dir, no schemadump, no network, no clock.

// covblocksLoc wraps whole-file bytes as one located top-level block.
func covblocksLoc(src string) *hclops.Located {
	b := []byte(src)
	return &hclops.Located{File: "x.tf", Bytes: b, Start: 0, End: len(b)}
}

// covblocksReq builds the minimal request the verbs read (params only).
func covblocksReq(params map[string]any) *request.Request {
	return &request.Request{Params: params}
}

// covblocksParseBlock parses src (one top-level block) into its editable form.
func covblocksParseBlock(t *testing.T, src string) *hclwrite.Block {
	t.Helper()
	f, diags := hclwrite.ParseConfig([]byte(src), "cov.tf", hcl.Pos{Line: 1, Column: 1})
	if diags.HasErrors() {
		t.Fatalf("parse %q: %s", src, diags.Error())
	}
	blks := f.Body().Blocks()
	if len(blks) != 1 {
		t.Fatalf("expected exactly one block in %q, got %d", src, len(blks))
	}
	return blks[0]
}

// covblocksExprTokens returns the value tokens of `x = <expr>`, i.e. exactly what
// the verbs hand parseTuple/parseObject at runtime.
func covblocksExprTokens(t *testing.T, expr string) hclwrite.Tokens {
	t.Helper()
	f, diags := hclwrite.ParseConfig([]byte("x = "+expr+"\n"), "expr.tf", hcl.Pos{Line: 1, Column: 1})
	if diags.HasErrors() {
		t.Fatalf("parse expr %q: %s", expr, diags.Error())
	}
	a := f.Body().GetAttribute("x")
	if a == nil {
		t.Fatalf("expr %q did not produce an attribute", expr)
	}
	return a.Expr().BuildTokens(nil)
}

func covblocksWantErr(t *testing.T, err error, sub string) {
	t.Helper()
	if err == nil {
		t.Fatalf("expected an error containing %q, got nil", sub)
	}
	if !strings.Contains(err.Error(), sub) {
		t.Fatalf("error = %q, want it to contain %q", err.Error(), sub)
	}
}

// covblocksWantRefusal pins the whole exit-2 shape a verb returns: the exact
// refusal CODE, a non-empty operator-facing reason, no error, and NO bytes (the
// tree is never touched on a refusal).
func covblocksWantRefusal(t *testing.T, out []byte, code, reason string, err error, wantCode string) {
	t.Helper()
	if err != nil {
		t.Fatalf("unexpected error %v (wanted refusal %s)", err, wantCode)
	}
	if code != wantCode {
		t.Fatalf("code = %q (reason %q), want %q", code, reason, wantCode)
	}
	if reason == "" {
		t.Fatalf("refusal %s carries an empty reason", wantCode)
	}
	if out != nil {
		t.Fatalf("refusal %s must write nothing, got %d bytes", wantCode, len(out))
	}
}

// ─── foreach.go ──────────────────────────────────────────────────────────────

const covblocksTagged = `resource "aws_ebs_volume" "v" {
  size = 10

  tags = {
    Name = "v"
  }
}
`

// covblocksForeachOp is a minimal append/remove_foreach_entry op: an inventory
// target plus positional key/value params, editing the map named by target.block.
func covblocksForeachOp(id, block string) manifests.Op {
	op := manifests.Op{ID: id, CodemodOp: "append_foreach_entry"}
	op.Target.ResourceType = "aws_ebs_volume"
	op.Target.Block = block
	op.Params = []manifests.Param{
		{Name: "volume", Source: "inventory", Required: true},
		{Name: "key", Source: "user_input", Required: true},
		{Name: "value", Source: "user_input", Required: true},
	}
	return op
}

func covblocksForeachParams(extra map[string]any) map[string]any {
	p := map[string]any{"volume": "aws_ebs_volume.v"}
	for k, v := range extra {
		p[k] = v
	}
	return p
}

// A mis-shaped target.block is refused BEFORE any HCL is authored — the whole
// point of guards.go: a path-like/dotted name would emit wrong-located HCL at exit
// 0, and a resource-type name would nest a resource inside another resource.
func TestCovblocksForeachRefusesMalformedBlockTarget(t *testing.T) {
	cases := []struct {
		name     string
		block    string
		wantCode string
		wantSub  string
	}{
		{"path like", "tags/extra", "MALFORMED_BLOCK_TARGET", "not a valid HCL identifier"},
		{"dotted", "spec.tags", "MALFORMED_BLOCK_TARGET", "not a valid HCL identifier"},
		{"alternation", "ingress/egress", "MALFORMED_BLOCK_TARGET", "not a valid HCL identifier"},
		{"aws resource type", "aws_s3_bucket", "RESOURCE_TYPE_AS_BLOCK", "names a resource type"},
		{"azurerm resource type", "azurerm_storage_account", "RESOURCE_TYPE_AS_BLOCK", "names a resource type"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			op := covblocksForeachOp("cov-foreach-guard", tc.block)
			req := covblocksReq(covblocksForeachParams(map[string]any{"key": "Env", "value": "prod"}))

			out, code, reason, err := appendForeachEntry(op, req, covblocksLoc(covblocksTagged))
			covblocksWantRefusal(t, out, code, reason, err, tc.wantCode)
			if !strings.Contains(reason, tc.wantSub) {
				t.Fatalf("append reason = %q, want it to contain %q", reason, tc.wantSub)
			}

			// The remove flavor shares the identical pre-parse guard.
			out, code, reason, err = removeForeachEntry(op, req, covblocksLoc(covblocksTagged))
			covblocksWantRefusal(t, out, code, reason, err, tc.wantCode)
			if !strings.Contains(reason, tc.wantSub) {
				t.Fatalf("remove reason = %q, want it to contain %q", reason, tc.wantSub)
			}
		})
	}
}

// Located bytes that are not exactly one block are an internal error (exit 1),
// never a silent partial edit.
func TestCovblocksForeachUnparseableLocatedBlock(t *testing.T) {
	op := covblocksForeachOp("cov-foreach-parse", "tags")
	req := covblocksReq(covblocksForeachParams(map[string]any{"key": "Env", "value": "prod"}))

	for _, tc := range []struct {
		name string
		src  string
		sub  string
	}{
		{"empty bytes", "", "expected exactly one block, got 0"},
		{"two blocks", "resource \"aws_ebs_volume\" \"a\" {\n}\n\nresource \"aws_ebs_volume\" \"b\" {\n}\n", "expected exactly one block, got 2"},
		{"not hcl", "this is not = = hcl\n", "parse block:"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, _, _, err := appendForeachEntry(op, req, covblocksLoc(tc.src))
			covblocksWantErr(t, err, tc.sub)
			_, _, _, err = removeForeachEntry(op, req, covblocksLoc(tc.src))
			covblocksWantErr(t, err, tc.sub)
		})
	}
}

// The foreach verbs read key/value positionally out of the non-inventory params.
// A manifest that does not supply them is a mis-shaped manifest — CTL-3: a REFUSE
// (FOREACH_ARITY, exit 2 via edit.go), not an internal error, since it's bad data
// about the op, not catalogctl malfunctioning. A request whose key is not a string
// (below) stays an internal error — never a guessed key.
func TestCovblocksForeachParamShapeErrors(t *testing.T) {
	t.Run("append needs key and value", func(t *testing.T) {
		op := covblocksForeachOp("cov-foreach-1param", "tags")
		op.Params = op.Params[:2] // inventory + key only
		req := covblocksReq(covblocksForeachParams(map[string]any{"key": "Env"}))
		_, code, reason, err := appendForeachEntry(op, req, covblocksLoc(covblocksTagged))
		if err != nil {
			t.Fatalf("err = %v, want nil (a refusal, not an internal error)", err)
		}
		if code != "FOREACH_ARITY" {
			t.Fatalf("code = %q, want FOREACH_ARITY", code)
		}
		if !strings.Contains(reason, "append_foreach_entry needs key and value params") {
			t.Fatalf("reason = %q, want it to contain the arity message", reason)
		}
	})

	t.Run("remove needs a key", func(t *testing.T) {
		op := covblocksForeachOp("cov-foreach-0param", "tags")
		op.Params = op.Params[:1] // inventory only
		req := covblocksReq(covblocksForeachParams(nil))
		_, code, reason, err := removeForeachEntry(op, req, covblocksLoc(covblocksTagged))
		if err != nil {
			t.Fatalf("err = %v, want nil (a refusal, not an internal error)", err)
		}
		if code != "FOREACH_ARITY" {
			t.Fatalf("code = %q, want FOREACH_ARITY", code)
		}
		if !strings.Contains(reason, "remove_foreach_entry needs a key param") {
			t.Fatalf("reason = %q, want it to contain the arity message", reason)
		}
	})

	t.Run("append key is not a string", func(t *testing.T) {
		op := covblocksForeachOp("cov-foreach-numkey", "tags")
		req := covblocksReq(covblocksForeachParams(map[string]any{"key": 42, "value": "prod"}))
		_, _, _, err := appendForeachEntry(op, req, covblocksLoc(covblocksTagged))
		covblocksWantErr(t, err, `foreach key "key" is not a string`)
	})

	t.Run("remove key is not a string", func(t *testing.T) {
		op := covblocksForeachOp("cov-foreach-numkey-rm", "tags")
		req := covblocksReq(covblocksForeachParams(map[string]any{"key": true}))
		_, _, _, err := removeForeachEntry(op, req, covblocksLoc(covblocksTagged))
		covblocksWantErr(t, err, `foreach key "key" is not a string`)
	})

	t.Run("append value has no cty representation", func(t *testing.T) {
		op := covblocksForeachOp("cov-foreach-nilval", "tags")
		// The value param is absent from the request → nil, which anyToCty cannot
		// render; the verb errors rather than write a bare/empty value.
		req := covblocksReq(covblocksForeachParams(map[string]any{"key": "Env"}))
		_, _, _, err := appendForeachEntry(op, req, covblocksLoc(covblocksTagged))
		covblocksWantErr(t, err, "unsupported value type <nil>")
	})
}

// A map attribute that is not a `{ … }` literal (a variable, a merge() call) is
// refused NOT_LITERAL: the verb rebuilds the object from parsed entries, so a
// non-literal expression could only be corrupted.
func TestCovblocksForeachRefusesNonLiteralMap(t *testing.T) {
	for _, tc := range []struct {
		name string
		src  string
	}{
		{"variable reference", "resource \"aws_ebs_volume\" \"v\" {\n  tags = var.tags\n}\n"},
		{"merge call", "resource \"aws_ebs_volume\" \"v\" {\n  tags = merge(local.base, { Name = \"v\" })\n}\n"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			op := covblocksForeachOp("cov-foreach-notliteral", "tags")
			req := covblocksReq(covblocksForeachParams(map[string]any{"key": "Env", "value": "prod"}))

			out, code, reason, err := appendForeachEntry(op, req, covblocksLoc(tc.src))
			covblocksWantRefusal(t, out, code, reason, err, "NOT_LITERAL")
			if reason != "tags is not a literal map" {
				t.Fatalf("append reason = %q, want %q", reason, "tags is not a literal map")
			}

			out, code, reason, err = removeForeachEntry(op, req, covblocksLoc(tc.src))
			covblocksWantRefusal(t, out, code, reason, err, "NOT_LITERAL")
			if reason != "tags is not a literal map" {
				t.Fatalf("remove reason = %q, want %q", reason, "tags is not a literal map")
			}
		})
	}
}

// With no target.block the map attribute comes from the target ADDRESS (local.<name>);
// an op that has no inventory param at all cannot name one, which is an error, not a
// guess.
func TestCovblocksForeachMapAttrResolution(t *testing.T) {
	t.Run("local address names the map", func(t *testing.T) {
		op := manifests.Op{ID: "cov-foreach-local", CodemodOp: "append_foreach_entry"}
		op.Params = []manifests.Param{{Name: "target", Source: "inventory"}}
		got, err := foreachMapAttr(op, covblocksReq(map[string]any{"target": "local.schedules"}))
		if err != nil {
			t.Fatalf("err = %v", err)
		}
		if got != "schedules" {
			t.Fatalf("attr = %q, want %q", got, "schedules")
		}
	})

	t.Run("no inventory param propagates the address error", func(t *testing.T) {
		op := covblocksForeachOp("cov-foreach-noinv", "")
		op.Params = op.Params[1:] // drop the inventory param
		req := covblocksReq(map[string]any{"key": "Env", "value": "prod"})

		_, _, _, err := appendForeachEntry(op, req, covblocksLoc(covblocksTagged))
		covblocksWantErr(t, err, `op "cov-foreach-noinv" has no inventory param`)

		_, _, _, err = removeForeachEntry(op, req, covblocksLoc(covblocksTagged))
		covblocksWantErr(t, err, `op "cov-foreach-noinv" has no inventory param`)
	})
}

// A target.path the tree does not carry fails closed (PATH_NOT_FOUND) for the
// remove flavor too — a foreach never auto-creates the containing block.
func TestCovblocksRemoveForeachEntryRefusesUnresolvablePath(t *testing.T) {
	op := covblocksForeachOp("cov-foreach-path", "tags")
	op.CodemodOp = "remove_foreach_entry"
	op.Target.Path = []string{"metadata_options"}
	req := covblocksReq(covblocksForeachParams(map[string]any{"key": "Env"}))

	out, code, reason, err := removeForeachEntry(op, req, covblocksLoc(covblocksTagged))
	covblocksWantRefusal(t, out, code, reason, err, "PATH_NOT_FOUND")
	if !strings.Contains(reason, `no "metadata_options" block found to address`) {
		t.Fatalf("reason = %q", reason)
	}
}

// ─── listentry.go ────────────────────────────────────────────────────────────

const covblocksSubnetGroup = `resource "aws_db_subnet_group" "g" {
  subnet_ids = ["subnet-1", "subnet-2"]
}
`

func covblocksListOp(id, block string) manifests.Op {
	op := manifests.Op{ID: id, CodemodOp: "append_list_entry"}
	op.Target.ResourceType = "aws_db_subnet_group"
	op.Target.Block = block
	op.Params = []manifests.Param{
		{Name: "group", Source: "inventory", Required: true},
		{Name: "subnet_id", Source: "user_input", Required: true},
	}
	return op
}

// With target.block empty the list attribute falls back to attrName — and an
// explicit target.attr is that fallback's single source of truth.
func TestCovblocksListEntryAttrFromTargetAttr(t *testing.T) {
	op := covblocksListOp("cov-list-attr", "")
	op.Target.Attr = "subnet_ids"
	req := covblocksReq(map[string]any{"group": "aws_db_subnet_group.g", "subnet_id": "subnet-3"})

	out, code, reason, err := appendListEntry(op, req, covblocksLoc(covblocksSubnetGroup))
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if code != "" {
		t.Fatalf("unexpected refusal %s: %s", code, reason)
	}
	want := `resource "aws_db_subnet_group" "g" {
  subnet_ids = ["subnet-1", "subnet-2", "subnet-3"]
}
`
	if string(out) != want {
		t.Fatalf("output =\n%s\nwant\n%s", out, want)
	}
}

func TestCovblocksListEntryUnresolvableAttrName(t *testing.T) {
	// No target.block, no target.attr, no prose paren token and no value param →
	// nothing names the list; an internal error, never a guessed attribute.
	op := manifests.Op{ID: "cov-list-noattr", CodemodOp: "append_list_entry"}
	op.Params = []manifests.Param{{Name: "group", Source: "inventory"}}
	req := covblocksReq(map[string]any{"group": "aws_db_subnet_group.g"})

	_, _, _, err := appendListEntry(op, req, covblocksLoc(covblocksSubnetGroup))
	covblocksWantErr(t, err, `op "cov-list-noattr": cannot resolve list attribute name`)
}

// A dotted attribute name is a nested path this verb cannot address: refuse
// UNSUPPORTED_PATH rather than create a top-level attribute literally named "a.b".
func TestCovblocksListEntryRefusesDottedAttr(t *testing.T) {
	for _, verb := range []struct {
		name string
		fn   transformer
	}{
		{"append", appendListEntry},
		{"remove", removeListEntry},
	} {
		t.Run(verb.name, func(t *testing.T) {
			op := covblocksListOp("cov-list-dotted", "lifecycle_rule.transition")
			req := covblocksReq(map[string]any{"group": "aws_db_subnet_group.g", "subnet_id": "subnet-3"})

			out, code, reason, err := verb.fn(op, req, covblocksLoc(covblocksSubnetGroup))
			covblocksWantRefusal(t, out, code, reason, err, "UNSUPPORTED_PATH")
			if !strings.Contains(reason, `nested attribute path "lifecycle_rule.transition" is not yet supported`) {
				t.Fatalf("reason = %q", reason)
			}
		})
	}
}

func TestCovblocksListEntryUnparseableLocatedBlock(t *testing.T) {
	op := covblocksListOp("cov-list-parse", "subnet_ids")
	req := covblocksReq(map[string]any{"group": "aws_db_subnet_group.g", "subnet_id": "subnet-3"})
	_, _, _, err := appendListEntry(op, req, covblocksLoc(""))
	covblocksWantErr(t, err, "expected exactly one block, got 0")
}

func TestCovblocksListEntryNoValueParam(t *testing.T) {
	op := covblocksListOp("cov-list-novalue", "subnet_ids")
	op.Params = op.Params[:1] // inventory only — nothing provides the element
	req := covblocksReq(map[string]any{"group": "aws_db_subnet_group.g"})

	_, _, _, err := appendListEntry(op, req, covblocksLoc(covblocksSubnetGroup))
	covblocksWantErr(t, err, `op "cov-list-novalue" has no value param`)
}

// The element flows through the shared value layer, so a value-layer REFUSAL
// propagates verbatim out of the list verb (exit 2, tree untouched).
func TestCovblocksListEntryPropagatesValueLayerRefusal(t *testing.T) {
	op := covblocksListOp("cov-list-refmismatch", "subnet_ids")
	op.Params[1] = manifests.Param{
		Name: "subnet", Source: "inventory", Role: "reference",
		RefAttr: "id", EnumSource: "inventory://aws_subnet/id",
	}
	req := covblocksReq(map[string]any{
		"group":  "aws_db_subnet_group.g",
		"subnet": "aws_iam_role.app",
	})

	out, code, reason, err := appendListEntry(op, req, covblocksLoc(covblocksSubnetGroup))
	covblocksWantRefusal(t, out, code, reason, err, "REFERENCE_TYPE_MISMATCH")
	if !strings.Contains(reason, "aws_iam_role.app") {
		t.Fatalf("reason = %q, want it to name the offending address", reason)
	}
}

// parseTuple is the literal-list gate: only a clean `[ … ]` literal is editable.
// Anything else (a call, a variable, an embedded comment) returns ok=false, which
// the verb surfaces as NOT_LITERAL.
func TestCovblocksParseTuple(t *testing.T) {
	cases := []struct {
		name    string
		expr    string
		wantOK  bool
		wantN   int
		wantEls []string
	}{
		{"empty list", `[]`, true, 0, nil},
		{"flat scalars", `["a", "b"]`, true, 2, []string{`"a"`, `"b"`}},
		{"trailing comma", `["a", ]`, true, 1, []string{`"a"`}},
		{"multiline", "[\n  \"a\",\n  \"b\",\n]", true, 2, []string{`"a"`, `"b"`}},
		// tokensString concatenates token bytes only, so the rebuilt element carries
		// no source whitespace — hclwrite.Format re-spaces it in the enclosing block.
		{"nested object element", `[{ k = "v" }]`, true, 1, []string{`{k="v"}`}},
		{"nested list element", `[[1, 2], [3]]`, true, 2, []string{`[1,2]`, `[3]`}},
		{"call element keeps parens", `[max(1, 2), 3]`, true, 2, []string{`max(1,2)`, `3`}},
		{"traversal element", `[aws_subnet.a.id]`, true, 1, []string{`aws_subnet.a.id`}},
		{"not a list", `"scalar"`, false, 0, nil},
		{"object not list", `{ a = 1 }`, false, 0, nil},
		{"call not list", `concat(a, b)`, false, 0, nil},
		{"comment before an element", "[\n  # keep\n  \"a\",\n]", false, 0, nil},
		{"comment after a comma", "[\n  \"a\", # keep\n]", false, 0, nil},
		{"comment abutting an element", "[\n  \"a\" # keep\n]", false, 0, nil},
		{"comment nested inside an element", "[\n  {\n    k = \"v\" # keep\n  },\n]", false, 0, nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := parseTuple(covblocksExprTokens(t, tc.expr))
			if ok != tc.wantOK {
				t.Fatalf("ok = %v, want %v (entries %d)", ok, tc.wantOK, len(got))
			}
			if !tc.wantOK {
				if got != nil {
					t.Fatalf("a rejected tuple must yield no entries, got %d", len(got))
				}
				return
			}
			if len(got) != tc.wantN {
				t.Fatalf("entries = %d, want %d", len(got), tc.wantN)
			}
			for i, want := range tc.wantEls {
				if s := strings.TrimSpace(tokensString(got[i].toks)); s != want {
					t.Fatalf("entry %d = %q, want %q", i, s, want)
				}
			}
		})
	}
}

// parseTuple's stream-level edges, which no attribute expression produces on its
// own: leading trivia is skipped, and a stream that ends before its `]` is not a
// literal (never a half-parsed list rebuilt over the file).
func TestCovblocksParseTupleTokenStreamEdges(t *testing.T) {
	newline := &hclwrite.Token{Type: hclsyntax.TokenNewline, Bytes: []byte("\n")}
	comment := &hclwrite.Token{Type: hclsyntax.TokenComment, Bytes: []byte("# lead\n")}
	obrack := &hclwrite.Token{Type: hclsyntax.TokenOBrack, Bytes: []byte("[")}
	cbrack := &hclwrite.Token{Type: hclsyntax.TokenCBrack, Bytes: []byte("]")}
	one := &hclwrite.Token{Type: hclsyntax.TokenNumberLit, Bytes: []byte("1")}

	t.Run("leading trivia is skipped", func(t *testing.T) {
		got, ok := parseTuple(hclwrite.Tokens{newline, comment, obrack, one, cbrack})
		if !ok {
			t.Fatalf("ok = false, want true")
		}
		if len(got) != 1 || tokensString(got[0].toks) != "1" {
			t.Fatalf("entries = %d (%q), want 1 element \"1\"", len(got), tokensString(got[0].toks))
		}
	})

	t.Run("unterminated stream is not a literal", func(t *testing.T) {
		got, ok := parseTuple(hclwrite.Tokens{obrack, one})
		if ok {
			t.Fatalf("ok = true, want false for an unterminated `[`")
		}
		if got != nil {
			t.Fatalf("expected no entries, got %d", len(got))
		}
	})
}

// The NOT_LITERAL refusal reaches the caller from the real verb, for both flavors.
func TestCovblocksListEntryRefusesNonLiteralList(t *testing.T) {
	const src = `resource "aws_db_subnet_group" "g" {
  subnet_ids = [
    "subnet-1", # keep this one
  ]
}
`
	for _, verb := range []struct {
		name string
		fn   transformer
	}{
		{"append", appendListEntry},
		{"remove", removeListEntry},
	} {
		t.Run(verb.name, func(t *testing.T) {
			op := covblocksListOp("cov-list-notliteral", "subnet_ids")
			req := covblocksReq(map[string]any{"group": "aws_db_subnet_group.g", "subnet_id": "subnet-3"})

			out, code, reason, err := verb.fn(op, req, covblocksLoc(src))
			covblocksWantRefusal(t, out, code, reason, err, "NOT_LITERAL")
			if reason != "subnet_ids is not a literal list" {
				t.Fatalf("reason = %q, want %q", reason, "subnet_ids is not a literal list")
			}
		})
	}
}

// ─── nested.go ───────────────────────────────────────────────────────────────

// deepEqualBlock is what makes a re-run of append_block an idempotent no-op, so
// every way two blocks can DIFFER must break equality.
func TestCovblocksDeepEqualBlockInequality(t *testing.T) {
	cases := []struct {
		name string
		a    string
		b    string
	}{
		{"different block type", "alpha \"l\" {\n  a = 1\n}\n", "beta \"l\" {\n  a = 1\n}\n"},
		{"different label count", "blk \"one\" \"two\" {\n}\n", "blk \"one\" {\n}\n"},
		{"different label value", "blk \"one\" \"two\" {\n}\n", "blk \"one\" \"three\" {\n}\n"},
		{"extra attribute", "blk {\n  a = 1\n}\n", "blk {\n  a = 1\n  b = 2\n}\n"},
		{"renamed attribute", "blk {\n  a = 1\n}\n", "blk {\n  b = 1\n}\n"},
		{"different attribute value", "blk {\n  a = 1\n}\n", "blk {\n  a = 2\n}\n"},
		{"extra sub-block", "blk {\n  a = 1\n}\n", "blk {\n  a = 1\n\n  sub {\n  }\n}\n"},
		{"different sub-block content", "blk {\n  sub {\n    c = 1\n  }\n}\n", "blk {\n  sub {\n    c = 2\n  }\n}\n"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			a := covblocksParseBlock(t, tc.a)
			b := covblocksParseBlock(t, tc.b)
			if deepEqualBlock(a, b) {
				t.Fatalf("blocks must not be deep-equal:\n%s\nvs\n%s", tc.a, tc.b)
			}
			if deepEqualBlock(b, a) {
				t.Fatalf("deep-equal must be symmetric:\n%s\nvs\n%s", tc.b, tc.a)
			}
			if !deepEqualBlock(a, covblocksParseBlock(t, tc.a)) {
				t.Fatalf("a block must deep-equal its own reparse:\n%s", tc.a)
			}
		})
	}
}

// nestedAttrName: an explicit target.attr is authoritative; with neither a
// target.attr nor a value param there is no attribute to write, and the caller
// gets the empty name rather than a guess.
func TestCovblocksNestedAttrName(t *testing.T) {
	cases := []struct {
		name string
		op   func() manifests.Op
		want string
	}{
		{
			name: "explicit target attr wins",
			op: func() manifests.Op {
				op := manifests.Op{ID: "cov-nested-attr"}
				op.Target.Attr = "delete_after"
				op.Params = []manifests.Param{{Name: "days", Source: "user_input"}}
				return op
			},
			want: "delete_after",
		},
		{
			name: "falls back to the value param",
			op: func() manifests.Op {
				op := manifests.Op{ID: "cov-nested-fallback"}
				op.Params = []manifests.Param{
					{Name: "plan", Source: "inventory"},
					{Name: "new_delete_after", Source: "user_input"},
				}
				return op
			},
			want: "delete_after",
		},
		{
			name: "no target attr and no value param yields nothing",
			op: func() manifests.Op {
				op := manifests.Op{ID: "cov-nested-none"}
				op.Params = []manifests.Param{{Name: "plan", Source: "inventory"}}
				return op
			},
			want: "",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := nestedAttrName(tc.op()); got != tc.want {
				t.Fatalf("nestedAttrName = %q, want %q", got, tc.want)
			}
		})
	}
}

// ─── moved.go ────────────────────────────────────────────────────────────────

const covblocksMovedSrc = `resource "aws_ebs_volume" "old" {
  size = 10
}
`

func covblocksMovedOp(id string) manifests.Op {
	op := manifests.Op{ID: id, CodemodOp: "moved_block"}
	op.Target.ResourceType = "aws_ebs_volume"
	op.Params = []manifests.Param{
		{Name: "volume", Source: "inventory", Required: true},
		{Name: "new_name", Source: "user_input", Required: true},
	}
	return op
}

func TestCovblocksMovedBlockErrors(t *testing.T) {
	t.Run("no inventory param", func(t *testing.T) {
		op := covblocksMovedOp("cov-moved-noinv")
		op.Params = op.Params[1:]
		req := covblocksReq(map[string]any{"new_name": "fresh"})
		_, _, _, err := movedBlock(op, req, covblocksLoc(covblocksMovedSrc))
		covblocksWantErr(t, err, `op "cov-moved-noinv" has no inventory param`)
	})

	t.Run("missing new name param", func(t *testing.T) {
		op := covblocksMovedOp("cov-moved-noname")
		req := covblocksReq(map[string]any{"volume": "aws_ebs_volume.old"})
		_, _, _, err := movedBlock(op, req, covblocksLoc(covblocksMovedSrc))
		covblocksWantErr(t, err, "moved_block: missing new name param")
	})

	t.Run("unsupported from address", func(t *testing.T) {
		for _, addr := range []string{"aws_ebs_volume", "module.storage.aws_ebs_volume.old"} {
			op := covblocksMovedOp("cov-moved-addr")
			req := covblocksReq(map[string]any{"volume": addr, "new_name": "fresh"})
			_, _, _, err := movedBlock(op, req, covblocksLoc(covblocksMovedSrc))
			covblocksWantErr(t, err, "moved_block: unsupported from address "+`"`+addr+`"`)
		}
	})

	t.Run("identical from and to is a resolution error", func(t *testing.T) {
		op := covblocksMovedOp("cov-moved-same")
		req := covblocksReq(map[string]any{"volume": "aws_ebs_volume.old", "new_name": "old"})
		_, _, _, err := movedBlock(op, req, covblocksLoc(covblocksMovedSrc))
		covblocksWantErr(t, err, "moved from == to")
		if !strings.Contains(err.Error(), errResolution.Error()) {
			t.Fatalf("error %q must wrap errResolution so the pipeline maps it to exit 3", err)
		}
	})

	t.Run("unparseable located block", func(t *testing.T) {
		op := covblocksMovedOp("cov-moved-parse")
		req := covblocksReq(map[string]any{"volume": "aws_ebs_volume.old", "new_name": "fresh"})
		_, _, _, err := movedBlock(op, req, covblocksLoc(""))
		covblocksWantErr(t, err, "expected exactly one block, got 0")
	})
}

// A Located whose End runs past its Bytes cannot be spliced back: the verb returns
// the splice error instead of writing a truncated file. Constructed by hand (the
// real Locate never produces it) by re-slicing beyond len but within cap, so the
// block still parses while the splice range stays out of bounds.
func TestCovblocksMovedBlockSpliceRangeError(t *testing.T) {
	full := []byte(covblocksMovedSrc + "\n\n")
	loc := &hclops.Located{
		File:  "x.tf",
		Bytes: full[:len(covblocksMovedSrc)],
		Start: 0,
		End:   len(full),
	}
	op := covblocksMovedOp("cov-moved-splice")
	req := covblocksReq(map[string]any{"volume": "aws_ebs_volume.old", "new_name": "fresh"})

	out, code, reason, err := movedBlock(op, req, loc)
	covblocksWantErr(t, err, "splice range")
	if code != "" || reason != "" {
		t.Fatalf("a splice failure is an internal error, not a refusal (%s: %s)", code, reason)
	}
	if out != nil {
		t.Fatalf("expected no bytes on a splice failure, got %d", len(out))
	}
}

// traversalForAddress renders the moved{} from/to as UNQUOTED references, which is
// the only form Terraform accepts there.
func TestCovblocksTraversalForAddress(t *testing.T) {
	cases := []struct {
		name string
		addr string
		want string
	}{
		{"two part", "aws_ebs_volume.old", "aws_ebs_volume.old"},
		{"single root", "local", "local"},
		{"three part", "module.storage.volume", "module.storage.volume"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := hclwrite.NewEmptyFile()
			f.Body().SetAttributeTraversal("from", traversalForAddress(tc.addr))
			got := strings.TrimSpace(string(hclwrite.Format(f.Bytes())))
			want := "from = " + tc.want
			if got != want {
				t.Fatalf("rendered %q, want %q", got, want)
			}
		})
	}
}

// ─── swapblock.go ────────────────────────────────────────────────────────────

const covblocksActionRule = `resource "aws_wafv2_web_acl" "x" {
  rule {
    name = "r1"

    action {
      count {}
    }
  }
}
`

func covblocksSwapOp(id string) manifests.Op {
	op := manifests.Op{ID: id, CodemodOp: "swap_child_block"}
	op.Target.ResourceType = "aws_wafv2_web_acl"
	op.Target.Path = []string{"rule", "action"}
	op.Params = []manifests.Param{
		{Name: "web_acl", Source: "inventory", Required: true},
		{Name: "rule_name", Source: "user_input", Required: true, Role: "selector", MatchAttr: "name"},
		{Name: "action", Source: "allowlist", Required: true, Role: "discriminator",
			Bounds:   &manifests.Bounds{Allowlist: []any{"ALLOW", "BLOCK", "COUNT"}},
			Segments: map[string]string{"ALLOW": "allow", "BLOCK": "block", "COUNT": "count"}},
	}
	return op
}

func covblocksSwapParams(action string) map[string]any {
	return map[string]any{"web_acl": "aws_wafv2_web_acl.x", "rule_name": "r1", "action": action}
}

func TestCovblocksSwapChildBlockManifestShapeErrors(t *testing.T) {
	t.Run("no discriminator param", func(t *testing.T) {
		op := covblocksSwapOp("cov-swap-nodisc")
		op.Params = op.Params[:2] // discriminator dropped
		_, _, _, err := swapChildBlock(op, covblocksReq(covblocksSwapParams("BLOCK")), covblocksLoc(covblocksActionRule))
		covblocksWantErr(t, err, `op "cov-swap-nodisc" (swap_child_block) has no role:"discriminator" param`)
	})

	t.Run("empty segments map", func(t *testing.T) {
		op := covblocksSwapOp("cov-swap-nosegs")
		op.Params[2].Segments = map[string]string{}
		_, _, _, err := swapChildBlock(op, covblocksReq(covblocksSwapParams("BLOCK")), covblocksLoc(covblocksActionRule))
		covblocksWantErr(t, err, `op "cov-swap-nosegs" discriminator "action" has an empty segments map`)
	})

	t.Run("unparseable located block", func(t *testing.T) {
		op := covblocksSwapOp("cov-swap-parse")
		_, _, _, err := swapChildBlock(op, covblocksReq(covblocksSwapParams("BLOCK")), covblocksLoc(""))
		covblocksWantErr(t, err, "expected exactly one block, got 0")
	})
}

// A segments entry that is not a valid HCL identifier is refused by the shared
// resolver rather than emitted as a block name.
func TestCovblocksSwapChildBlockRefusesMalformedSegment(t *testing.T) {
	op := covblocksSwapOp("cov-swap-badseg")
	op.Params[2].Segments = map[string]string{"BLOCK": "block/deny"}

	out, code, reason, err := swapChildBlock(op, covblocksReq(covblocksSwapParams("BLOCK")), covblocksLoc(covblocksActionRule))
	covblocksWantRefusal(t, out, code, reason, err, manifests.RefuseMalformedDynamicTarget)
	if !strings.Contains(reason, "block/deny") {
		t.Fatalf("reason = %q, want it to name the malformed segment", reason)
	}
}

// With no target.path the parent is the located block itself — the choice set is
// searched at the resource's top level.
func TestCovblocksSwapChildBlockEmptyPathUsesLocatedBlock(t *testing.T) {
	const src = `resource "aws_wafv2_web_acl" "x" {
  count {}
}
`
	op := covblocksSwapOp("cov-swap-nopath")
	op.Target.Path = nil
	op.Params = op.Params[:1] // drop the now-unused selector
	op.Params = append(op.Params, manifests.Param{
		Name: "action", Source: "allowlist", Required: true, Role: "discriminator",
		Segments: map[string]string{"ALLOW": "allow", "COUNT": "count"},
	})

	out, code, reason, err := swapChildBlock(op, covblocksReq(map[string]any{"web_acl": "aws_wafv2_web_acl.x", "action": "ALLOW"}), covblocksLoc(src))
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if code != "" {
		t.Fatalf("unexpected refusal %s: %s", code, reason)
	}
	want := `resource "aws_wafv2_web_acl" "x" {
  allow {
  }
}
`
	if string(out) != want {
		t.Fatalf("output =\n%s\nwant\n%s", out, want)
	}
}
