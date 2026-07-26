package edit

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/hclops"
	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/manifests"
	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/request"
)

// covrender_cov_test.go covers three slices of the edit package:
//
//   - idiomrender.go — the byte-for-byte port of the TS create renderer. Every
//     assertion here is on RENDERED TEXT (or the hclValue that renders it), never
//     on an intermediate struct shape, because the rendered bytes are the product:
//     the authored file must equal the L1 draft the operator approved.
//   - schemablocks.go — the provider-schema block guard. Its contract is
//     asymmetric: only a POSITIVE "type T declares no nested block N here" refuses
//     (UNKNOWN_BLOCK_TYPE, exit 2); every "the schema cannot answer" shape must
//     fail OPEN so a legitimate op is never blocked on a gap in the dump.
//   - removeblock.go — the destructive path: PREVENT_DESTROY / DANGLING_REF
//     refusals, the nested (target.path) removal, and the delete-consumes-target
//     semantics that make a second run unresolvable rather than idempotent.
//
// Everything is hermetic: synthetic schemadumps and t.TempDir() env dirs only —
// the committed 18 MB provider dump and the repo's own git state are never read.

/* ── shared fixtures ─────────────────────────────────────────────────────────── */

// covrenderSchemaDump is a minimal tools/schemadump projection: one reflected type
// declaring a nested block `good` that itself declares `inner`, plus a scalar
// attribute; one framework-unreflected type the guard must fail open on.
const covrenderSchemaDump = `{"resources":{` +
	`"aws_covrender_thing":{"attributes":{` +
	`"good":{"nesting_mode":"list","block":{"attributes":{` +
	`"inner":{"nesting_mode":"list","block":{"attributes":{}}},` +
	`"depth":{}}}},` +
	`"size":{}}},` +
	`"aws_covrender_framework":{"framework":true}` +
	`}}`

func covrenderWrite(t *testing.T, dir, name, body string) string {
	t.Helper()
	p := filepath.Join(dir, name)
	if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

// covrenderIndex parses covrenderSchemaDump through the REAL loader, so these
// tests query the same structure production builds from the committed dump.
func covrenderIndex(t *testing.T) *nestedBlockIndex {
	t.Helper()
	p := covrenderWrite(t, t.TempDir(), "cov-v1-schema.json", covrenderSchemaDump)
	idx, err := loadNestedBlockIndex(p)
	if err != nil {
		t.Fatalf("loadNestedBlockIndex: %v", err)
	}
	return idx
}

// covrenderBlock builds a nested `bodyNode` block of the given name.
func covrenderBlock(name string, body ...bodyNode) bodyNode {
	return bodyNode{kind: "block", name: name, body: body}
}

// covrenderLoc wraps whole-file bytes as a Located covering exactly one block —
// the shape hclops.Locate hands the verbs.
func covrenderLoc(file string, src string) *hclops.Located {
	b := []byte(src)
	return &hclops.Located{File: file, Bytes: b, Start: 0, End: len(b)}
}

/* ── idiomrender.go: value coercion ──────────────────────────────────────────── */

// TestCovrenderLiteralValue pins hclSkeleton.ts#literal: booleans and FINITE
// numbers keep their type (so they render bare), every other Go shape — including
// a non-finite float that has no HCL number form — degrades to a quoted string
// literal. Assertions are on the RENDERED text, which is the product.
func TestCovrenderLiteralValue(t *testing.T) {
	tests := []struct {
		name string
		in   any
		want string
	}{
		{name: "bool true renders bare", in: true, want: "true"},
		{name: "bool false renders bare", in: false, want: "false"},
		{name: "finite float64 renders as a number", in: float64(3.5), want: "3.5"},
		{name: "integral float64 loses its decimal point", in: float64(200), want: "200"},
		{name: "int widens to a number", in: 100, want: "100"},
		{name: "int64 widens to a number", in: int64(365), want: "365"},
		{name: "+Inf has no HCL number form so it quotes", in: math.Inf(1), want: `"+Inf"`},
		{name: "-Inf has no HCL number form so it quotes", in: math.Inf(-1), want: `"-Inf"`},
		{name: "NaN has no HCL number form so it quotes", in: math.NaN(), want: `"NaN"`},
		{name: "string stays a quoted literal", in: "gp3", want: `"gp3"`},
		{name: "nil renders as the quoted zero form", in: nil, want: `"<nil>"`},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := renderValue(literalValue(tt.in)); got != tt.want {
				t.Fatalf("renderValue(literalValue(%#v)) = %s, want %s", tt.in, got, tt.want)
			}
		})
	}
}

// TestCovrenderScalarValue pins hclSkeleton.ts#scalarValue: the declared param TYPE
// drives coercion. A "number" param renders bare when the value coerces and falls
// back to a quoted literal when it does not; a "bool" param accepts both the real
// boolean and the "true"/"false" string form a YAML request may carry, and quotes
// anything else rather than emitting a bare non-boolean token.
func TestCovrenderScalarValue(t *testing.T) {
	tests := []struct {
		name      string
		paramType string
		in        any
		want      string
	}{
		{name: "number param coerces an int", paramType: "number", in: 500, want: "500"},
		{name: "number param coerces a numeric string", paramType: "number", in: "3000", want: "3000"},
		{name: "number param quotes a non-numeric value", paramType: "number", in: "gp3", want: `"gp3"`},
		{name: "bool param passes a real bool through", paramType: "bool", in: true, want: "true"},
		{name: "bool param accepts the string \"true\"", paramType: "bool", in: "true", want: "true"},
		{name: "bool param accepts the string \"false\"", paramType: "bool", in: "false", want: "false"},
		{name: "bool param quotes any other string", paramType: "bool", in: "yes", want: `"yes"`},
		// A number under a bool param matches neither bool arm, so it falls through
		// to literalValue and renders as a BARE number (not a quoted string). Neither
		// spelling is valid Terraform for a bool attribute — the manifest's own type
		// bound is what has to reject this shape, not the renderer.
		{name: "bool param falls through to the literal renderer for a number", paramType: "bool", in: 1, want: "1"},
		{name: "string param quotes a bool-looking string", paramType: "string", in: "true", want: `"true"`},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := renderValue(scalarValue(tt.paramType, tt.in)); got != tt.want {
				t.Fatalf("scalarValue(%q, %#v) rendered %s, want %s", tt.paramType, tt.in, got, tt.want)
			}
		})
	}
}

// TestCovrenderReferenceValue pins the fail-closed reference sanitizer: a value
// becomes a bare HCL EXPRESSION only when it is address-shaped AND the refAttr is a
// bare identifier. Every other input renders as a QUOTED literal, so a submitted
// request byte can never be promoted into executable syntax.
func TestCovrenderReferenceValue(t *testing.T) {
	tests := []struct {
		name    string
		value   any
		refAttr string
		want    string
	}{
		{name: "address plus ident becomes an expression", value: "aws_kms_key.shared_cmk", refAttr: "arn", want: "aws_kms_key.shared_cmk.arn"},
		{name: "azurerm address is equally an expression", value: "azurerm_key_vault.kv", refAttr: "id", want: "azurerm_key_vault.kv.id"},
		{name: "non-address value quotes", value: "not an address", refAttr: "arn", want: `"not an address"`},
		{name: "bare resource type without a name quotes", value: "aws_kms_key", refAttr: "arn", want: `"aws_kms_key"`},
		{name: "non-provider prefix quotes", value: "gcp_kms_key.k", refAttr: "arn", want: `"gcp_kms_key.k"`},
		{name: "empty refAttr quotes the address itself", value: "aws_kms_key.k", refAttr: "", want: `"aws_kms_key.k"`},
		{name: "non-ident refAttr quotes", value: "aws_kms_key.k", refAttr: "arn.sub", want: `"aws_kms_key.k"`},
		{name: "injection payload quotes, never interpolates", value: "aws_kms_key.k\" \nforce_destroy = true\n x = \"", refAttr: "arn",
			want: `"aws_kms_key.k\" \nforce_destroy = true\n x = \""`},
		{name: "nil renders as the empty literal", value: nil, refAttr: "arn", want: `""`},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := renderValue(referenceValue(tt.value, tt.refAttr)); got != tt.want {
				t.Fatalf("referenceValue(%#v, %q) rendered %s, want %s", tt.value, tt.refAttr, got, tt.want)
			}
		})
	}
}

/* ── idiomrender.go: rendering ───────────────────────────────────────────────── */

// TestCovrenderRenderValue pins renderValue for every kind, including the map
// shape's exact 4-space entry indent / 2-space closing brace (a map only ever
// renders at a block's top level, so the indent is hard-coded and load-bearing for
// byte parity) and the non-bare-key quoting rule.
func TestCovrenderRenderValue(t *testing.T) {
	tests := []struct {
		name string
		in   hclValue
		want string
	}{
		{name: "expr renders bare", in: exprValue("aws_instance.b.id"), want: "aws_instance.b.id"},
		{name: "empty tuple", in: hclValue{kind: "tuple"}, want: "[]"},
		{
			name: "tuple joins with a comma and a space",
			in:   hclValue{kind: "tuple", items: []hclValue{exprValue("a.b"), strLiteral("c")}},
			want: `[a.b, "c"]`,
		},
		{name: "an empty map collapses to {}", in: hclValue{kind: "map"}, want: "{}"},
		{
			name: "map entries indent 4 and close at 2",
			in: hclValue{kind: "map", entries: []mapEntry{
				{key: "Name", val: strLiteral("APP-02")},
				{key: "PIC", val: strLiteral("Ops team")},
			}},
			want: "{\n    Name = \"APP-02\"\n    PIC = \"Ops team\"\n  }",
		},
		{
			name: "a non-bare map key is quoted",
			in: hclValue{kind: "map", entries: []mapEntry{
				{key: "Cost Center", val: strLiteral("42")},
			}},
			want: "{\n    \"Cost Center\" = \"42\"\n  }",
		},
		{
			name: "a hyphenated key stays bare (HCL allows it)",
			in: hclValue{kind: "map", entries: []mapEntry{
				{key: "cost-center", val: strLiteral("42")},
			}},
			want: "{\n    cost-center = \"42\"\n  }",
		},
		{
			name: "a map key that would open an interpolation is neutralised",
			in: hclValue{kind: "map", entries: []mapEntry{
				{key: "${var.evil}", val: strLiteral("x")},
			}},
			want: "{\n    \"$${var.evil}\" = \"x\"\n  }",
		},
		// Defensive arms: neither shape is producible by literalValue/scalarValue
		// (which normalise every number to float64), but renderValue must still
		// print something rather than panic or emit an empty assignment.
		{name: "an unnormalised literal payload prints via Sprint", in: hclValue{kind: "literal", lit: 7}, want: "7"},
		{name: "an unknown kind renders as nothing", in: hclValue{kind: "todo-not-a-value"}, want: ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := renderValue(tt.in); got != tt.want {
				t.Fatalf("renderValue = %q, want %q", got, tt.want)
			}
		})
	}
}

// TestCovrenderJsNumber pins the JS String(n) shape the goldens depend on: an
// integral value prints with NO decimal point, a fractional one via the shortest
// round-trippable form.
func TestCovrenderJsNumber(t *testing.T) {
	tests := []struct {
		name string
		in   float64
		want string
	}{
		{name: "integral loses the decimal point", in: 365, want: "365"},
		{name: "negative integral", in: -1, want: "-1"},
		{name: "zero", in: 0, want: "0"},
		{name: "fractional round-trips", in: 1.5, want: "1.5"},
		{name: "negative fractional round-trips", in: -2.25, want: "-2.25"},
		{name: "sub-unit fractional keeps its leading zero", in: 0.5, want: "0.5"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := jsNumber(tt.in); got != tt.want {
				t.Fatalf("jsNumber(%v) = %q, want %q", tt.in, got, tt.want)
			}
		})
	}
}

/* ── idiomrender.go: buildParam ──────────────────────────────────────────────── */

// covrenderRendered renders a built param the way bodyFrom+renderBody would: an
// "<attr> = <value>" line, a "# TODO: …" line, or "" when it contributes nothing.
func covrenderRendered(t *testing.T, p manifests.Param, values map[string]any) string {
	t.Helper()
	b, ok := buildParam(p, values)
	if !ok {
		return ""
	}
	lines := renderBody(bodyFrom([]builtParam{b}), 0)
	return strings.Join(lines, "\n")
}

// TestCovrenderBuildParamOmits pins every shape that contributes NOTHING to the
// authored body — the omit-if-absent behaviour the create verb's reference
// validation is aligned with. A selector/discriminator picks structure and is never
// itself written; an inactive param is invisible; a role:"key" param names the block
// (and only writes when it also declares an explicit attr); an empty value is "not
// given", never an empty assignment.
func TestCovrenderBuildParamOmits(t *testing.T) {
	tests := []struct {
		name   string
		param  manifests.Param
		values map[string]any
	}{
		{
			name:   "a selector picks structure, never a value",
			param:  manifests.Param{Name: "which", Role: "selector", MatchAttr: "name", Type: "string"},
			values: map[string]any{"which": "r1"},
		},
		{
			name:   "a discriminator picks structure, never a value",
			param:  manifests.Param{Name: "direction", Role: "discriminator", Segments: map[string]string{"in": "ingress"}, Type: "string"},
			values: map[string]any{"direction": "in"},
		},
		{
			name:   "a dependsOn-inactive param is invisible",
			param:  manifests.Param{Name: "subnets", Type: "string", DependsOn: json.RawMessage(`{"param":"inside_vpc","equals":true}`)},
			values: map[string]any{"inside_vpc": false, "subnets": "aws_subnet.a"},
		},
		{
			name:   "a bare key param names the block only",
			param:  manifests.Param{Name: "bucket_name", Role: "key", Type: "string"},
			values: map[string]any{"bucket_name": "finance-interface"},
		},
		{
			name:   "an absent value is not given",
			param:  manifests.Param{Name: "kms_key", Type: "string"},
			values: map[string]any{},
		},
		{
			name:   "an empty string is not given",
			param:  manifests.Param{Name: "kms_key", Type: "string"},
			values: map[string]any{"kms_key": ""},
		},
		{
			name:   "an empty list is not given",
			param:  manifests.Param{Name: "security_groups", Type: "string"},
			values: map[string]any{"security_groups": []any{}},
		},
		{
			name:   "an explicit null is not given",
			param:  manifests.Param{Name: "kms_key", Type: "string"},
			values: map[string]any{"kms_key": nil},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if b, ok := buildParam(tt.param, tt.values); ok {
				t.Fatalf("buildParam contributed %#v, want it omitted", b)
			}
			if got := covrenderRendered(t, tt.param, tt.values); got != "" {
				t.Fatalf("rendered %q, want nothing", got)
			}
		})
	}
}

// TestCovrenderBuildParamWrites pins what each param shape renders: the explicit
// attr override, a dotted attr accumulating into a map, list wrapping, the
// reference forms, and the engineer-decides sentinel becoming a review TODO rather
// than a bogus assignment.
func TestCovrenderBuildParamWrites(t *testing.T) {
	tests := []struct {
		name   string
		param  manifests.Param
		values map[string]any
		want   string
	}{
		{
			name:   "a plain scalar writes its param name",
			param:  manifests.Param{Name: "size_gib", Type: "number", Attr: "size"},
			values: map[string]any{"size_gib": 500},
			want:   "size = 500",
		},
		{
			name:   "a key param with an explicit attr does write",
			param:  manifests.Param{Name: "bucket_name", Role: "key", Type: "string", Attr: "bucket"},
			values: map[string]any{"bucket_name": "finance-interface"},
			want:   `bucket = "finance-interface"`,
		},
		{
			name:   "a const param writes its fixed value with no request input",
			param:  manifests.Param{Name: "block_public_acls", Role: "const", Const: true, Type: "bool"},
			values: map[string]any{},
			want:   "block_public_acls = true",
		},
		{
			name:   "an omitted param falls back to the manifest default",
			param:  manifests.Param{Name: "volume_type", Type: "string", Default: json.RawMessage(`"gp3"`)},
			values: map[string]any{},
			want:   `volume_type = "gp3"`,
		},
		{
			name:   "a dotted attr accumulates into a map",
			param:  manifests.Param{Name: "resource_name", Type: "string", Attr: "tags.Name"},
			values: map[string]any{"resource_name": "APP-02"},
			want:   "tags = {\n    Name = \"APP-02\"\n  }",
		},
		{
			name:   "wrap:list wraps a scalar in a 1-element tuple",
			param:  manifests.Param{Name: "subnet_id", Type: "string", Wrap: "list", Attr: "subnet_ids"},
			values: map[string]any{"subnet_id": "subnet-abc"},
			want:   `subnet_ids = ["subnet-abc"]`,
		},
		{
			name:   "a plain list renders as a tuple of string literals",
			param:  manifests.Param{Name: "azs", Type: "string"},
			values: map[string]any{"azs": []any{"ap-northeast-1a", "ap-northeast-1c"}},
			want:   `azs = ["ap-northeast-1a", "ap-northeast-1c"]`,
		},
		{
			// List elements are coerced as type "string" regardless of the param's
			// declared type, so a numeric element keeps its NUMBER form (literalValue
			// types numbers) while a textual one quotes — the TS renderer's behaviour.
			name:   "a plain list coerces each element independently",
			param:  manifests.Param{Name: "ports", Type: "number"},
			values: map[string]any{"ports": []any{80, "all"}},
			want:   `ports = [80, "all"]`,
		},
		{
			name:   "a scalar reference becomes an expression",
			param:  manifests.Param{Name: "kms_key", Role: "reference", RefAttr: "arn", Attr: "kms_key_id"},
			values: map[string]any{"kms_key": "aws_kms_key.shared_cmk"},
			want:   "kms_key_id = aws_kms_key.shared_cmk.arn",
		},
		{
			name:   "wrap:list wraps a single reference",
			param:  manifests.Param{Name: "subnet", Role: "reference", RefAttr: "id", Wrap: "list", Attr: "subnet_ids"},
			values: map[string]any{"subnet": "aws_subnet.backup"},
			want:   "subnet_ids = [aws_subnet.backup.id]",
		},
		{
			name:   "a list reference renders element by element",
			param:  manifests.Param{Name: "security_groups", Role: "reference", RefAttr: "id", Attr: "vpc_security_group_ids"},
			values: map[string]any{"security_groups": []any{"aws_security_group.a", "aws_security_group.b"}},
			want:   "vpc_security_group_ids = [aws_security_group.a.id, aws_security_group.b.id]",
		},
		{
			name:   "a non-address reference element quotes instead of interpolating",
			param:  manifests.Param{Name: "security_groups", Role: "reference", RefAttr: "id", Attr: "vpc_security_group_ids"},
			values: map[string]any{"security_groups": []any{"aws_security_group.a", "sg-literal"}},
			want:   `vpc_security_group_ids = [aws_security_group.a.id, "sg-literal"]`,
		},
		{
			name:   "engineer-decides becomes a TODO keyed on the attr",
			param:  manifests.Param{Name: "ami", Type: "string"},
			values: map[string]any{"ami": engineerDecides},
			want:   "# TODO: ami — engineer decides",
		},
		{
			name:   "engineer-decides on a dotted attr keys on the map key",
			param:  manifests.Param{Name: "resource_name", Type: "string", Attr: "tags.Name"},
			values: map[string]any{"resource_name": engineerDecides},
			want:   "# TODO: Name — engineer decides",
		},
		{
			name:   "engineer-decides with no usable leaf falls back to the param name",
			param:  manifests.Param{Name: "ami", Type: "string", Attr: "tags."},
			values: map[string]any{"ami": engineerDecides},
			want:   "# TODO: ami — engineer decides",
		},
		{
			name:   "engineer-decides wins over a reference role",
			param:  manifests.Param{Name: "kms_key", Role: "reference", RefAttr: "arn", Attr: "kms_key_id"},
			values: map[string]any{"kms_key": engineerDecides},
			want:   "# TODO: kms_key_id — engineer decides",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := covrenderRendered(t, tt.param, tt.values)
			if got != tt.want {
				t.Fatalf("rendered\n%s\nwant\n%s", got, tt.want)
			}
		})
	}
}

/* ── idiomrender.go: bodyFrom + the small idiom seams ────────────────────────── */

// TestCovrenderBodyFromSkipsValuelessParams: a built param carrying neither a TODO
// nor a value contributes NO line — never a bare `= …` or an empty assignment.
func TestCovrenderBodyFromSkipsValuelessParams(t *testing.T) {
	kept := strLiteral("gp3")
	nodes := bodyFrom([]builtParam{
		{param: manifests.Param{Name: "valueless"}, attr: "valueless"},
		{param: manifests.Param{Name: "volume_type"}, attr: "volume_type", value: &kept, hasVal: true},
	})
	got := strings.Join(renderBody(nodes, 0), "\n")
	if got != `volume_type = "gp3"` {
		t.Fatalf("rendered %q, want only the valued param", got)
	}
}

// TestCovrenderFindBuilt: the idiom composers look params up by NAME; a name that
// was never built must report absent so the idiom omits its co-emitted block
// rather than emitting one keyed on a zero value.
func TestCovrenderFindBuilt(t *testing.T) {
	v := boolLiteral(true)
	built := []builtParam{{param: manifests.Param{Name: "versioning"}, attr: "versioning", value: &v, hasVal: true}}

	t.Run("a built name is found", func(t *testing.T) {
		b, ok := findBuilt(built, "versioning")
		if !ok || !b.hasVal || !isLiteralBool(*b.value, true) {
			t.Fatalf("findBuilt = (%#v, %v), want the versioning param", b, ok)
		}
	})
	t.Run("an unbuilt name is absent", func(t *testing.T) {
		if b, ok := findBuilt(built, "lifecycle_cleanup_days"); ok {
			t.Fatalf("findBuilt = %#v, want absent", b)
		}
	})
	t.Run("an empty built set is absent", func(t *testing.T) {
		if _, ok := findBuilt(nil, "versioning"); ok {
			t.Fatal("findBuilt on an empty set must report absent")
		}
	})
}

// TestCovrenderIsLiteralPredicates: the idiom gates (versioning on, backups off,
// lifecycle_to_ia == "never") must only fire on a PROVABLE literal. An expression
// — which is what a reference param renders to — is never one, so a reference can
// never trip an idiom's conditional block.
func TestCovrenderIsLiteralPredicates(t *testing.T) {
	t.Run("bool", func(t *testing.T) {
		tests := []struct {
			name string
			v    hclValue
			want bool
		}{
			{name: "matching literal", v: boolLiteral(true), want: true},
			{name: "opposite literal", v: boolLiteral(false), want: false},
			{name: "an expression is never a literal", v: exprValue("var.enabled"), want: false},
			{name: "a tuple is never a literal", v: hclValue{kind: "tuple"}, want: false},
			{name: "a string literal is not a bool", v: strLiteral("true"), want: false},
		}
		for _, tt := range tests {
			t.Run(tt.name, func(t *testing.T) {
				if got := isLiteralBool(tt.v, true); got != tt.want {
					t.Fatalf("isLiteralBool(%#v, true) = %v, want %v", tt.v, got, tt.want)
				}
			})
		}
	})

	t.Run("string", func(t *testing.T) {
		tests := []struct {
			name string
			v    hclValue
			want bool
		}{
			{name: "matching literal", v: strLiteral("never"), want: true},
			{name: "different literal", v: strLiteral("AFTER_30_DAYS"), want: false},
			{name: "an expression is never a literal", v: exprValue("var.age"), want: false},
			{name: "a map is never a literal", v: hclValue{kind: "map"}, want: false},
			{name: "a bool literal is not a string", v: boolLiteral(true), want: false},
		}
		for _, tt := range tests {
			t.Run(tt.name, func(t *testing.T) {
				if got := isLiteralString(tt.v, "never"); got != tt.want {
					t.Fatalf("isLiteralString(%#v, \"never\") = %v, want %v", tt.v, got, tt.want)
				}
			})
		}
	})
}

// TestCovrenderSecurityGroupIdiomProtocolSource: the starter ingress rule renders
// only when a protocol was actually CHOSEN. The chosen value may come from the
// request OR — when the request omits it — from the manifest default, and the
// sentinel "none" means "no rule", so no partial ingress block ever renders.
func TestCovrenderSecurityGroupIdiomProtocolSource(t *testing.T) {
	op := func(def string) manifests.Op {
		p := manifests.Param{Name: "first_rule_protocol", Type: "string"}
		if def != "" {
			p.Default = json.RawMessage(def)
		}
		var o manifests.Op
		o.ID = "sg-create-security-group"
		o.Target.ResourceType = "aws_security_group"
		o.Params = []manifests.Param{p, {Name: "first_rule_from_port", Type: "number", Path: []string{"ingress"}}}
		return o
	}
	port := literalValue(8443)
	built := []builtParam{
		{param: manifests.Param{Name: "first_rule_from_port", Path: []string{"ingress"}}, attr: "from_port", value: &port, hasVal: true},
	}

	tests := []struct {
		name       string
		op         manifests.Op
		values     map[string]any
		wantIngres bool
	}{
		{name: "a submitted protocol renders the rule", op: op(""), values: map[string]any{"first_rule_protocol": "tcp"}, wantIngres: true},
		{name: "an omitted protocol falls back to the manifest default", op: op(`"tcp"`), values: map[string]any{}, wantIngres: true},
		{name: "an explicit nil falls back to the manifest default", op: op(`"tcp"`), values: map[string]any{"first_rule_protocol": nil}, wantIngres: true},
		{name: "a \"none\" default renders no rule", op: op(`"none"`), values: map[string]any{}, wantIngres: false},
		{name: "a submitted \"none\" renders no rule", op: op(`"tcp"`), values: map[string]any{"first_rule_protocol": "none"}, wantIngres: false},
		{name: "no protocol param and no default renders no rule", op: op(""), values: map[string]any{}, wantIngres: false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			blocks := securityGroupIdiom(tt.op, tt.values, "cache_tier", built)
			if len(blocks) != 1 || blocks[0].blockType != "aws_security_group" {
				t.Fatalf("blocks = %#v, want exactly one aws_security_group", blocks)
			}
			got := renderBlock(blocks[0])
			hasIngress := strings.Contains(got, "ingress {")
			if hasIngress != tt.wantIngres {
				t.Fatalf("rendered\n%s\nwant ingress present = %v", got, tt.wantIngres)
			}
			if hasIngress && !strings.Contains(got, "from_port = 8443") {
				t.Fatalf("rendered\n%s\nwant the ingress attribute inside the rule", got)
			}
		})
	}
}

/* ── schemablocks.go: the create-wide block guard ────────────────────────────── */

// TestCovrenderGuardCreateBlocks: a create authors a whole block SET, so every
// emitted block at every depth is checked. Only a POSITIVE "type T declares no
// nested block N here" refuses UNKNOWN_BLOCK_TYPE; Terraform CORE meta-blocks are
// exempt at the resource top level (and ONLY there); and every "the schema cannot
// answer" shape fails open so a legitimate idiom is never blocked on a gap in the
// reflected dump.
func TestCovrenderGuardCreateBlocks(t *testing.T) {
	idx := covrenderIndex(t)

	tests := []struct {
		name       string
		blocks     []hclBlock
		nilIndex   bool
		wantCode   string
		wantReason string
	}{
		{
			name:   "a flat block set with no nested blocks passes",
			blocks: []hclBlock{{blockType: "aws_covrender_thing", name: "x", body: []bodyNode{attrNode("size", literalValue(1))}}},
		},
		{
			name:   "a declared nested block passes",
			blocks: []hclBlock{{blockType: "aws_covrender_thing", name: "x", body: []bodyNode{covrenderBlock("good")}}},
		},
		{
			name: "a declared nested block at depth passes",
			blocks: []hclBlock{{blockType: "aws_covrender_thing", name: "x",
				body: []bodyNode{covrenderBlock("good", covrenderBlock("inner"))}}},
		},
		{
			name:       "an undeclared top-level nested block refuses",
			blocks:     []hclBlock{{blockType: "aws_covrender_thing", name: "x", body: []bodyNode{covrenderBlock("bogus")}}},
			wantCode:   RefuseUnknownBlockType,
			wantReason: `declares no nested block "bogus"`,
		},
		{
			name: "an undeclared block at depth refuses and names the path",
			blocks: []hclBlock{{blockType: "aws_covrender_thing", name: "x",
				body: []bodyNode{covrenderBlock("good", covrenderBlock("bogus"))}}},
			wantCode:   RefuseUnknownBlockType,
			wantReason: `"bogus" (under good/bogus)`,
		},
		{
			name: "a later block in the set is still checked",
			blocks: []hclBlock{
				{blockType: "aws_covrender_thing", name: "x", body: []bodyNode{covrenderBlock("good")}},
				{blockType: "aws_covrender_thing", name: "y", body: []bodyNode{covrenderBlock("bogus")}},
			},
			wantCode: RefuseUnknownBlockType,
		},
		{
			name: "lifecycle is a core meta-block at the resource top level",
			blocks: []hclBlock{{blockType: "aws_covrender_thing", name: "x",
				body: []bodyNode{attrNode("size", literalValue(1)), preventDestroy()}}},
		},
		{
			name: "connection and provisioner are core meta-blocks too",
			blocks: []hclBlock{{blockType: "aws_covrender_thing", name: "x",
				body: []bodyNode{covrenderBlock("connection"), covrenderBlock("provisioner")}}},
		},
		{
			name: "the meta-block exemption is top-level only",
			blocks: []hclBlock{{blockType: "aws_covrender_thing", name: "x",
				body: []bodyNode{covrenderBlock("good", covrenderBlock("lifecycle"))}}},
			wantCode:   RefuseUnknownBlockType,
			wantReason: `"lifecycle" (under good/lifecycle)`,
		},
		{
			name:   "a resource type absent from the dump fails open",
			blocks: []hclBlock{{blockType: "aws_volume_attachment", name: "x", body: []bodyNode{covrenderBlock("anything")}}},
		},
		{
			name:   "a framework-unreflected type fails open",
			blocks: []hclBlock{{blockType: "aws_covrender_framework", name: "x", body: []bodyNode{covrenderBlock("rule")}}},
		},
		{
			name:     "a nil index fails open for the whole create",
			blocks:   []hclBlock{{blockType: "aws_covrender_thing", name: "x", body: []bodyNode{covrenderBlock("bogus")}}},
			nilIndex: true,
		},
		{
			name:   "no blocks at all is vacuously fine",
			blocks: nil,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			use := idx
			if tt.nilIndex {
				use = nil
			}
			code, reason := guardCreateBlocks(tt.blocks, use)
			if code != tt.wantCode {
				t.Fatalf("code = %q (reason %q), want %q", code, reason, tt.wantCode)
			}
			if tt.wantCode != "" {
				if reason == "" {
					t.Fatal("a refusal must carry a reason")
				}
				if tt.wantReason != "" && !strings.Contains(reason, tt.wantReason) {
					t.Fatalf("reason = %q, want it to contain %q", reason, tt.wantReason)
				}
			}
		})
	}
}

/* ── schemablocks.go: the loader and discovery ───────────────────────────────── */

// covrenderGzip returns body gzipped.
func covrenderGzip(t *testing.T, body string) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	if _, err := zw.Write([]byte(body)); err != nil {
		t.Fatal(err)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// TestCovrenderLoadNestedBlockIndex: a committed dump may be raw JSON or gzipped,
// and the loader must inflate the ".gz" form — a silently failing gunzip is a
// security guard failing OPEN. Every unreadable/corrupt shape is an ERROR naming
// the path, never a nil index that would quietly disarm the guard.
func TestCovrenderLoadNestedBlockIndex(t *testing.T) {
	t.Run("raw json loads and answers", func(t *testing.T) {
		idx := covrenderIndex(t)
		names, ok := idx.nestedBlocksAt("aws_covrender_thing", nil)
		if !ok || !names["good"] || names["size"] {
			t.Fatalf("nestedBlocksAt = (%v, %v), want good declared and size (a scalar) not", names, ok)
		}
	})

	t.Run("gzipped json inflates to the same index", func(t *testing.T) {
		dir := t.TempDir()
		p := filepath.Join(dir, "cov-v1-schema.json.gz")
		if err := os.WriteFile(p, covrenderGzip(t, covrenderSchemaDump), 0o644); err != nil {
			t.Fatal(err)
		}
		idx, err := loadNestedBlockIndex(p)
		if err != nil {
			t.Fatalf("loadNestedBlockIndex(.gz): %v", err)
		}
		names, ok := idx.nestedBlocksAt("aws_covrender_thing", []string{"good"})
		if !ok || !names["inner"] {
			t.Fatalf("gz-loaded descent = (%v, %v), want `inner` under `good`", names, ok)
		}
		// And the guard actively refuses through the gz-loaded index.
		code, _ := guardCreateBlocks(
			[]hclBlock{{blockType: "aws_covrender_thing", name: "x", body: []bodyNode{covrenderBlock("bogus")}}}, idx)
		if code != RefuseUnknownBlockType {
			t.Fatalf("gz-loaded guard code = %q, want %q", code, RefuseUnknownBlockType)
		}
	})

	bad := []struct {
		name    string
		file    string
		body    []byte
		wantSub string
	}{
		{name: "a .gz that is not gzip", file: "cov-v1-schema.json.gz", body: []byte("{}"), wantSub: "open gzip schemadump"},
		{name: "a truncated gzip stream", file: "cov-v1-schema.json.gz", body: covrenderGzip(t, covrenderSchemaDump)[:20], wantSub: "gunzip schemadump"},
		{name: "raw json that is not json", file: "cov-v1-schema.json", body: []byte("not json at all"), wantSub: "parse schemadump"},
		{name: "gzipped bytes that are not json", file: "cov-v1-schema.json.gz", body: covrenderGzip(t, "not json at all"), wantSub: "parse schemadump"},
	}
	for _, tt := range bad {
		t.Run(tt.name, func(t *testing.T) {
			p := filepath.Join(t.TempDir(), tt.file)
			if err := os.WriteFile(p, tt.body, 0o644); err != nil {
				t.Fatal(err)
			}
			idx, err := loadNestedBlockIndex(p)
			if err == nil {
				t.Fatalf("want an error, got idx = %#v", idx)
			}
			if idx != nil {
				t.Fatalf("want a nil index alongside the error, got %#v", idx)
			}
			if !strings.Contains(err.Error(), tt.wantSub) {
				t.Fatalf("err = %v, want it to contain %q", err, tt.wantSub)
			}
			if !strings.Contains(err.Error(), tt.file) {
				t.Fatalf("err = %v, want it to name the path", err)
			}
		})
	}

	t.Run("a path that does not exist is an error", func(t *testing.T) {
		_, err := loadNestedBlockIndex(filepath.Join(t.TempDir(), "absent-schema.json"))
		if err == nil {
			t.Fatal("want an error for a missing dump")
		}
	})
}

// TestCovrenderDiscoverSchemaPath: discovery walks UP from each start dir looking
// for tools/schemadump/<provider>-*-schema.json, preferring the raw JSON and
// falling back to the committed .gz, and returns "" when nothing is found (the
// caller then fails open). An empty start dir is skipped, not treated as ".".
func TestCovrenderDiscoverSchemaPath(t *testing.T) {
	mk := func(t *testing.T, names ...string) string {
		t.Helper()
		root := t.TempDir()
		dump := filepath.Join(root, "tools", "schemadump")
		if err := os.MkdirAll(dump, 0o755); err != nil {
			t.Fatal(err)
		}
		for _, n := range names {
			covrenderWrite(t, dump, n, "{}")
		}
		return root
	}

	t.Run("finds the dump in the start dir itself", func(t *testing.T) {
		root := mk(t, "aws-v6.53.0-schema.json")
		got := discoverSchemaPath("aws_instance", root)
		if got != filepath.Join(root, "tools", "schemadump", "aws-v6.53.0-schema.json") {
			t.Fatalf("discoverSchemaPath = %q", got)
		}
	})

	t.Run("walks up from a nested start dir", func(t *testing.T) {
		root := mk(t, "aws-v6.53.0-schema.json")
		deep := filepath.Join(root, "environments", "prod")
		if err := os.MkdirAll(deep, 0o755); err != nil {
			t.Fatal(err)
		}
		if got := discoverSchemaPath("aws_instance", deep); !strings.HasSuffix(got, "aws-v6.53.0-schema.json") {
			t.Fatalf("discoverSchemaPath = %q, want the ancestor dump", got)
		}
	})

	t.Run("falls back to the committed .gz", func(t *testing.T) {
		root := mk(t, "aws-v6.53.0-schema.json.gz")
		if got := discoverSchemaPath("aws_instance", root); !strings.HasSuffix(got, ".json.gz") {
			t.Fatalf("discoverSchemaPath = %q, want the .gz fallback", got)
		}
	})

	t.Run("prefers the raw json over the .gz", func(t *testing.T) {
		root := mk(t, "aws-v6.53.0-schema.json", "aws-v6.53.0-schema.json.gz")
		if got := discoverSchemaPath("aws_instance", root); !strings.HasSuffix(got, ".json") {
			t.Fatalf("discoverSchemaPath = %q, want the raw json preferred", got)
		}
	})

	t.Run("the provider prefix selects the dump family", func(t *testing.T) {
		root := mk(t, "aws-v6.53.0-schema.json", "azurerm-v4.81.0-schema.json")
		if got := discoverSchemaPath("azurerm_key_vault", root); !strings.HasSuffix(got, "azurerm-v4.81.0-schema.json") {
			t.Fatalf("discoverSchemaPath = %q, want the azurerm family", got)
		}
	})

	t.Run("an empty start dir is skipped", func(t *testing.T) {
		root := mk(t, "aws-v6.53.0-schema.json")
		if got := discoverSchemaPath("aws_instance", "", root); !strings.HasSuffix(got, "aws-v6.53.0-schema.json") {
			t.Fatalf("discoverSchemaPath = %q, want the empty start dir skipped", got)
		}
	})

	t.Run("nothing found returns the empty string", func(t *testing.T) {
		// A bare temp tree with no tools/schemadump anywhere up to the filesystem root.
		if got := discoverSchemaPath("aws_instance", t.TempDir()); got != "" {
			t.Fatalf("discoverSchemaPath = %q, want \"\" so the caller fails open", got)
		}
	})

	t.Run("only empty start dirs returns the empty string", func(t *testing.T) {
		if got := discoverSchemaPath("aws_instance", "", ""); got != "" {
			t.Fatalf("discoverSchemaPath = %q, want \"\"", got)
		}
	})
}

// TestCovrenderResolveSchemaIndex pins the two-sided posture: an EXPLICIT --schema
// that cannot be read is a HARD error (the caller turns it into exit 3, fail-closed),
// while auto-discovery never errors — a discovered dump that fails to parse yields a
// nil index and no error, so the guard degrades to fail-open instead of blocking an
// operator's edit on a corrupt committed dump.
func TestCovrenderResolveSchemaIndex(t *testing.T) {
	t.Run("an explicit readable --schema loads", func(t *testing.T) {
		p := covrenderWrite(t, t.TempDir(), "cov-v1-schema.json", covrenderSchemaDump)
		idx, err := resolveSchemaIndex(p, "", "aws_covrender_thing")
		if err != nil {
			t.Fatalf("resolveSchemaIndex: %v", err)
		}
		if names, ok := idx.nestedBlocksAt("aws_covrender_thing", nil); !ok || !names["good"] {
			t.Fatalf("index did not answer: (%v, %v)", names, ok)
		}
	})

	t.Run("an explicit unreadable --schema is a hard error", func(t *testing.T) {
		idx, err := resolveSchemaIndex(filepath.Join(t.TempDir(), "absent.json"), "", "aws_covrender_thing")
		if err == nil {
			t.Fatalf("want a hard error, got idx = %#v", idx)
		}
		if idx != nil {
			t.Fatalf("want a nil index alongside the error, got %#v", idx)
		}
	})

	t.Run("a discovered dump is used", func(t *testing.T) {
		root := t.TempDir()
		dump := filepath.Join(root, "tools", "schemadump")
		if err := os.MkdirAll(dump, 0o755); err != nil {
			t.Fatal(err)
		}
		covrenderWrite(t, dump, "aws-v9.9.9-schema.json", covrenderSchemaDump)
		idx, err := resolveSchemaIndex("", root, "aws_covrender_thing")
		if err != nil {
			t.Fatalf("resolveSchemaIndex: %v", err)
		}
		if idx == nil {
			t.Fatal("want the discovered dump to be loaded")
		}
		if names, ok := idx.nestedBlocksAt("aws_covrender_thing", nil); !ok || !names["good"] {
			t.Fatalf("discovered index did not answer: (%v, %v)", names, ok)
		}
	})

	t.Run("a discovered but corrupt dump fails open with no error", func(t *testing.T) {
		root := t.TempDir()
		dump := filepath.Join(root, "tools", "schemadump")
		if err := os.MkdirAll(dump, 0o755); err != nil {
			t.Fatal(err)
		}
		covrenderWrite(t, dump, "aws-v9.9.9-schema.json", "not json at all")
		idx, err := resolveSchemaIndex("", root, "aws_covrender_thing")
		if err != nil {
			t.Fatalf("auto-discovery must never error, got %v", err)
		}
		if idx != nil {
			t.Fatalf("want a nil index (fail open), got %#v", idx)
		}
		// A nil index refuses nothing — the executor keeps only its structural guards.
		if code, _ := guardCreateBlocks(
			[]hclBlock{{blockType: "aws_covrender_thing", name: "x", body: []bodyNode{covrenderBlock("bogus")}}}, idx); code != "" {
			t.Fatalf("nil index must fail open, got %q", code)
		}
	})
}

/* ── removeblock.go: the destructive path ────────────────────────────────────── */

const covrenderVolume = `resource "aws_ebs_volume" "v" {
  size = 100
}
`

// covrenderRemoveOp builds a remove_block op over aws_ebs_volume.
func covrenderRemoveOp(path ...string) manifests.Op {
	op := manifests.Op{ID: "cov-remove", Service: "cov", CodemodOp: "remove_block",
		Params: []manifests.Param{{Name: "target", Source: "inventory"}}}
	op.Target.ResourceType = "aws_ebs_volume"
	op.Target.Path = path
	return op
}

// TestCovrenderRemoveBlockAddressErrors: a remove that cannot even name its target
// is an ERROR (exit 1/3 upstream), never a deletion of some other block.
func TestCovrenderRemoveBlockAddressErrors(t *testing.T) {
	tests := []struct {
		name    string
		params  []manifests.Param
		values  map[string]any
		wantSub string
	}{
		{
			name:    "no inventory param",
			params:  []manifests.Param{{Name: "why", Source: "user_input"}},
			values:  map[string]any{"why": "cleanup"},
			wantSub: `op "cov-remove" has no inventory param`,
		},
		{
			name:    "the inventory value is missing",
			params:  []manifests.Param{{Name: "target", Source: "inventory"}},
			values:  map[string]any{},
			wantSub: `missing inventory param "target"`,
		},
		{
			name:    "the inventory value is not a string",
			params:  []manifests.Param{{Name: "target", Source: "inventory"}},
			values:  map[string]any{"target": 42},
			wantSub: `inventory param "target" is not a string`,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			op := covrenderRemoveOp()
			op.Params = tt.params
			out, code, reason, err := removeBlock(op, &request.Request{Params: tt.values},
				covrenderLoc(filepath.Join(t.TempDir(), "main.tf"), covrenderVolume))
			if err == nil {
				t.Fatalf("want an error, got out=%d bytes code=%q", len(out), code)
			}
			if !strings.Contains(err.Error(), tt.wantSub) {
				t.Fatalf("err = %v, want it to contain %q", err, tt.wantSub)
			}
			if out != nil || code != "" || reason != "" {
				t.Fatalf("want no write and no refusal alongside the error, got %d bytes / %q / %q", len(out), code, reason)
			}
		})
	}
}

// TestCovrenderRemoveBlockTopLevel drives the whole top-level removal contract:
// the block AND its single preceding blank line disappear, the rest of the file is
// byte-identical, and both destructive vetoes (PREVENT_DESTROY, DANGLING_REF) refuse
// with NO write.
func TestCovrenderRemoveBlockTopLevel(t *testing.T) {
	const keep = "resource \"aws_ebs_volume\" \"keep\" {\n  size = 10\n}\n"
	protected := "resource \"aws_ebs_volume\" \"v\" {\n  size = 100\n\n  lifecycle {\n    prevent_destroy = true\n  }\n}\n"

	tests := []struct {
		name     string
		files    map[string]string
		address  string
		wantCode string
		wantMain string // expected main.tf content after an accepted removal
	}{
		{
			name:     "removes a lone block leaving an empty file",
			files:    map[string]string{"main.tf": covrenderVolume},
			address:  "aws_ebs_volume.v",
			wantMain: "",
		},
		{
			name:     "removes the trailing block and its one preceding blank line",
			files:    map[string]string{"main.tf": keep + "\n" + covrenderVolume},
			address:  "aws_ebs_volume.v",
			wantMain: keep,
		},
		{
			name:     "removes a leading block leaving the survivor at the top",
			files:    map[string]string{"main.tf": covrenderVolume + "\n" + keep},
			address:  "aws_ebs_volume.v",
			wantMain: "\n" + keep,
		},
		{
			name:     "prevent_destroy refuses",
			files:    map[string]string{"main.tf": protected},
			address:  "aws_ebs_volume.v",
			wantCode: "PREVENT_DESTROY",
		},
		{
			name: "a reference from another file refuses DANGLING_REF",
			files: map[string]string{
				"main.tf": covrenderVolume,
				"attach.tf": "resource \"aws_volume_attachment\" \"a\" {\n" +
					"  volume_id = aws_ebs_volume.v.id\n}\n",
			},
			address:  "aws_ebs_volume.v",
			wantCode: "DANGLING_REF",
		},
		{
			name: "a reference from the SAME file refuses DANGLING_REF",
			files: map[string]string{"main.tf": covrenderVolume + "\n" +
				"resource \"aws_volume_attachment\" \"a\" {\n  volume_id = aws_ebs_volume.v.id\n}\n"},
			address:  "aws_ebs_volume.v",
			wantCode: "DANGLING_REF",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			dir := t.TempDir()
			for n, b := range tt.files {
				covrenderWrite(t, dir, n, b)
			}
			loc, err, _ := hclops.Locate(dir, tt.address)
			if err != nil {
				t.Fatalf("Locate: %v", err)
			}
			op := covrenderRemoveOp()
			out, code, reason, err := removeBlock(op, &request.Request{Params: map[string]any{"target": tt.address}}, loc)
			if err != nil {
				t.Fatalf("unexpected err = %v", err)
			}
			if code != tt.wantCode {
				t.Fatalf("code = %q (reason %q), want %q", code, reason, tt.wantCode)
			}
			if tt.wantCode != "" {
				if out != nil {
					t.Fatalf("a refusal must write nothing, got %d bytes", len(out))
				}
				if reason == "" || !strings.Contains(reason, tt.address) {
					t.Fatalf("reason = %q, want it to name %q", reason, tt.address)
				}
				return
			}
			if string(out) != tt.wantMain {
				t.Fatalf("removed file =\n%q\nwant\n%q", out, tt.wantMain)
			}
		})
	}
}

// TestCovrenderRemoveBlockConsumesItsTarget pins the DELIBERATELY non-idempotent
// semantics of the destructive path: the first run deletes the block, and a second
// run over the resulting bytes can no longer RESOLVE the address at all — a
// resolution failure (exit 3), not a silent success. A remove verb must never be
// retried blind.
func TestCovrenderRemoveBlockConsumesItsTarget(t *testing.T) {
	dir := t.TempDir()
	const keep = "resource \"aws_ebs_volume\" \"keep\" {\n  size = 10\n}\n"
	covrenderWrite(t, dir, "main.tf", keep+"\n"+covrenderVolume)

	loc, err, _ := hclops.Locate(dir, "aws_ebs_volume.v")
	if err != nil {
		t.Fatalf("Locate: %v", err)
	}
	op := covrenderRemoveOp()
	req := &request.Request{Params: map[string]any{"target": "aws_ebs_volume.v"}}
	out, code, reason, err := removeBlock(op, req, loc)
	if err != nil || code != "" {
		t.Fatalf("first run: err=%v code=%q reason=%q", err, code, reason)
	}
	if string(out) != keep {
		t.Fatalf("after removal =\n%q\nwant\n%q", out, keep)
	}
	if err := os.WriteFile(filepath.Join(dir, "main.tf"), out, 0o644); err != nil {
		t.Fatal(err)
	}

	// Second run: the address is gone, so the verb is never even reached.
	_, err, exit := hclops.Locate(dir, "aws_ebs_volume.v")
	if err == nil {
		t.Fatal("the second run must fail to resolve the consumed address")
	}
	if exit != 3 {
		t.Fatalf("exit suggestion = %d, want 3 (resolution failure)", exit)
	}
	if !strings.Contains(err.Error(), "aws_ebs_volume.v") {
		t.Fatalf("err = %v, want it to name the consumed address", err)
	}
	// The survivor is untouched — a removal is surgical, never a file rewrite.
	b, _ := os.ReadFile(filepath.Join(dir, "main.tf"))
	if string(b) != keep {
		t.Fatalf("survivor = %q, want %q", b, keep)
	}
}

/* ── removeblock.go: the nested (target.path) removal ────────────────────────── */

const covrenderACL = `resource "aws_wafv2_web_acl" "x" {
  name = "acl"

  rule {
    name = "r1"

    action {
      allow = true
    }

    statement {
      kind = "s1"
    }
  }

  rule {
    name = "r2"
  }
}
`

// covrenderACLOp builds a keyed nested remove over covrenderACL: a role:"selector"
// on rule.name picks WHICH sibling rule the path descends into.
func covrenderACLOp(selectorValue string, path ...string) (manifests.Op, *request.Request) {
	op := manifests.Op{ID: "waf-delete-rule", Service: "waf", CodemodOp: "remove_block",
		Params: []manifests.Param{
			{Name: "web_acl", Source: "inventory"},
			{Name: "rule_name", Source: "user_input", Role: "selector", MatchAttr: "name"},
		}}
	op.Target.ResourceType = "aws_wafv2_web_acl"
	op.Target.Path = path
	req := &request.Request{Params: map[string]any{
		"web_acl": "aws_wafv2_web_acl.x", "rule_name": selectorValue,
	}}
	return op, req
}

// TestCovrenderRemoveNestedBlock: a target.path removal deletes exactly ONE keyed
// nested block — the parent resource and every sibling survive — and it descends
// intermediate path segments, so a block that is only reachable at depth is
// removable at that depth.
func TestCovrenderRemoveNestedBlock(t *testing.T) {
	t.Run("removes one keyed sibling rule, leaving the other", func(t *testing.T) {
		op, req := covrenderACLOp("r1", "rule")
		out, code, reason, err := removeBlock(op, req, covrenderLoc("x.tf", covrenderACL))
		if err != nil || code != "" {
			t.Fatalf("err=%v code=%q reason=%q", err, code, reason)
		}
		got := string(out)
		if strings.Contains(got, `name = "r1"`) {
			t.Fatalf("rule r1 survived:\n%s", got)
		}
		for _, must := range []string{`resource "aws_wafv2_web_acl" "x"`, `name = "acl"`, `name = "r2"`} {
			if !strings.Contains(got, must) {
				t.Fatalf("output lost %q:\n%s", must, got)
			}
		}
		// The whole r1 subtree goes with it.
		if strings.Contains(got, "statement {") || strings.Contains(got, "action {") {
			t.Fatalf("r1's children survived:\n%s", got)
		}
		// No double blank line survives the removal.
		if strings.Contains(got, "\n\n\n") {
			t.Fatalf("a double blank line survived:\n%q", got)
		}
	})

	t.Run("descends an intermediate segment to remove a grandchild", func(t *testing.T) {
		op, req := covrenderACLOp("r1", "rule", "statement")
		out, code, reason, err := removeBlock(op, req, covrenderLoc("x.tf", covrenderACL))
		if err != nil || code != "" {
			t.Fatalf("err=%v code=%q reason=%q", err, code, reason)
		}
		got := string(out)
		if strings.Contains(got, "statement {") || strings.Contains(got, `kind = "s1"`) {
			t.Fatalf("the statement block survived:\n%s", got)
		}
		// Only the grandchild went: the selected rule, its sibling action block and
		// the sibling rule are all intact.
		for _, must := range []string{`name = "r1"`, "action {", `allow = true`, `name = "r2"`} {
			if !strings.Contains(got, must) {
				t.Fatalf("output lost %q:\n%s", must, got)
			}
		}
	})

	t.Run("prevent_destroy on the enclosing resource still refuses", func(t *testing.T) {
		src := "resource \"aws_wafv2_web_acl\" \"x\" {\n  name = \"acl\"\n\n  rule {\n    name = \"r1\"\n  }\n\n  lifecycle {\n    prevent_destroy = true\n  }\n}\n"
		op, req := covrenderACLOp("r1", "rule")
		out, code, reason, err := removeBlock(op, req, covrenderLoc("x.tf", src))
		if err != nil {
			t.Fatalf("err = %v", err)
		}
		if code != "PREVENT_DESTROY" {
			t.Fatalf("code = %q (reason %q), want PREVENT_DESTROY", code, reason)
		}
		if out != nil {
			t.Fatalf("a refusal must write nothing, got %d bytes", len(out))
		}
		if !strings.Contains(reason, "aws_wafv2_web_acl.x") {
			t.Fatalf("reason = %q, want it to name the protected address", reason)
		}
	})

	refusals := []struct {
		name     string
		selector string
		path     []string
		wantCode string
	}{
		{
			name:     "an absent intermediate segment is PATH_NOT_FOUND",
			selector: "r1", path: []string{"no_such_parent", "statement"}, wantCode: "PATH_NOT_FOUND",
		},
		{
			name:     "a selector matching no sibling at an intermediate segment is SELECTOR_AMBIGUOUS",
			selector: "r-nope", path: []string{"rule", "statement"}, wantCode: "SELECTOR_AMBIGUOUS",
		},
		{
			name:     "a selector matching no sibling at the LAST segment is SELECTOR_AMBIGUOUS",
			selector: "r-nope", path: []string{"rule"}, wantCode: "SELECTOR_AMBIGUOUS",
		},
		{
			name:     "an absent final segment is PATH_NOT_FOUND",
			selector: "r2", path: []string{"rule", "statement"}, wantCode: "PATH_NOT_FOUND",
		},
	}
	for _, tt := range refusals {
		t.Run(tt.name, func(t *testing.T) {
			op, req := covrenderACLOp(tt.selector, tt.path...)
			out, code, reason, err := removeBlock(op, req, covrenderLoc("x.tf", covrenderACL))
			if err != nil {
				t.Fatalf("err = %v", err)
			}
			if code != tt.wantCode {
				t.Fatalf("code = %q (reason %q), want %q", code, reason, tt.wantCode)
			}
			if out != nil {
				t.Fatalf("a refusal must write nothing, got %d bytes", len(out))
			}
			if reason == "" {
				t.Fatal("a refusal must carry a reason")
			}
		})
	}

	// Defense in depth: the located bytes must reparse to EXACTLY one block. If they
	// ever do not, the nested remove is an internal error — never a guess at which
	// tree to edit.
	t.Run("located bytes holding two blocks are an internal error", func(t *testing.T) {
		op, req := covrenderACLOp("r1", "rule")
		out, code, reason, err := removeBlock(op, req, covrenderLoc("x.tf", covrenderACL+"\n"+covrenderVolume))
		if err == nil {
			t.Fatalf("want an internal error, got out=%d bytes code=%q", len(out), code)
		}
		if !strings.Contains(err.Error(), "expected exactly one block, got 2") {
			t.Fatalf("err = %v, want the one-block invariant error", err)
		}
		if out != nil || code != "" || reason != "" {
			t.Fatalf("want no write and no refusal, got %d bytes / %q / %q", len(out), code, reason)
		}
	})
}

// TestCovrenderRemoveBlockRefusesNestedWithoutPath: the target.block-without-path
// encoding cannot carry a selector, so it stays refused — deleting the whole
// enclosing resource in its place would be data loss.
func TestCovrenderRemoveBlockRefusesNestedWithoutPath(t *testing.T) {
	op := covrenderRemoveOp()
	op.Target.ResourceType = "aws_wafv2_web_acl"
	op.Target.Block = "rule"
	req := &request.Request{Params: map[string]any{"target": "aws_wafv2_web_acl.x"}}
	out, code, reason, err := removeBlock(op, req, covrenderLoc("x.tf", covrenderACL))
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if code != "UNSUPPORTED_NESTED_REMOVE" {
		t.Fatalf("code = %q, want UNSUPPORTED_NESTED_REMOVE", code)
	}
	if out != nil {
		t.Fatalf("a refusal must write nothing, got %d bytes", len(out))
	}
	if !strings.Contains(reason, "aws_wafv2_web_acl.x") {
		t.Fatalf("reason = %q, want it to name the resource that would be lost", reason)
	}
}

/* ── removeblock.go: the prevent_destroy veto ────────────────────────────────── */

// TestCovrenderHasPreventDestroy pins the FAIL-CLOSED veto: a prevent_destroy
// attribute protects the block unless it can be STATICALLY PROVEN false. A literal
// false and the string "false" are provable; a value needing a real eval context, a
// null, a number, or any other string are NOT, so they protect.
func TestCovrenderHasPreventDestroy(t *testing.T) {
	block := func(lifecycle string) string {
		return "resource \"aws_ebs_volume\" \"v\" {\n  size = 100\n" + lifecycle + "}\n"
	}
	lc := func(expr string) string {
		return "  lifecycle {\n    prevent_destroy = " + expr + "\n  }\n"
	}

	tests := []struct {
		name string
		src  string
		want bool
	}{
		{name: "no lifecycle block at all", src: block(""), want: false},
		{name: "a lifecycle block with no prevent_destroy", src: block("  lifecycle {\n    ignore_changes = [tags]\n  }\n"), want: false},
		{name: "a non-lifecycle nested block is ignored", src: block("  root_block_device {\n    prevent_destroy = true\n  }\n"), want: false},
		{name: "literal true protects", src: block(lc("true")), want: true},
		{name: "literal false does not protect", src: block(lc("false")), want: false},
		{name: "the string \"false\" does not protect", src: block(lc(`"false"`)), want: false},
		{name: "the string \"true\" protects", src: block(lc(`"true"`)), want: true},
		{name: "any other string protects (not provably false)", src: block(lc(`"no"`)), want: true},
		{name: "a variable reference protects (cannot be evaluated)", src: block(lc("var.protect")), want: true},
		{name: "a function call protects (cannot be evaluated)", src: block(lc("tobool(var.p)")), want: true},
		{name: "null protects", src: block(lc("null")), want: true},
		{name: "a number is not provably false so it protects", src: block(lc("0")), want: true},
		{name: "a list is not provably false so it protects", src: block(lc("[]")), want: true},
		{
			name: "a second lifecycle block carrying the guard still protects",
			src:  block("  lifecycle {\n    ignore_changes = [tags]\n  }\n" + lc("true")),
			want: true,
		},
		{
			name: "an explicitly disabled guard alongside an unrelated lifecycle stays unprotected",
			src:  block("  lifecycle {\n    ignore_changes = [tags]\n  }\n" + lc("false")),
			want: false,
		},
		// Defensive arms: nothing that is not a single parsed block can protect,
		// because there is no block to protect.
		{name: "unparseable bytes", src: "resource \"aws_ebs_volume\" \"v\" { = = }\n", want: false},
		{name: "no block at all", src: "size = 100\n", want: false},
		{name: "empty bytes", src: "", want: false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := hasPreventDestroy([]byte(tt.src)); got != tt.want {
				t.Fatalf("hasPreventDestroy = %v, want %v for:\n%s", got, tt.want, tt.src)
			}
		})
	}
}

/* ── removeblock.go: the dangling-reference scan ─────────────────────────────── */

// TestCovrenderDanglingRef pins the naive cross-file substring scan: the block
// BEING REMOVED is excluded from its own file (so a self-mention never blocks the
// removal), every other *.tf counts, and an unreadable entry or an unglobbable dir
// is skipped rather than treated as a reference.
func TestCovrenderDanglingRef(t *testing.T) {
	const address = "aws_ebs_volume.v"

	t.Run("no other file mentions the address", func(t *testing.T) {
		dir := t.TempDir()
		p := covrenderWrite(t, dir, "main.tf", covrenderVolume)
		covrenderWrite(t, dir, "other.tf", "resource \"aws_ebs_volume\" \"w\" {\n  size = 1\n}\n")
		loc := &hclops.Located{File: p, Bytes: []byte(covrenderVolume), Start: 0, End: len(covrenderVolume)}
		if danglingRef(dir, address, loc) {
			t.Fatal("danglingRef = true, want false")
		}
	})

	t.Run("another file referencing the address", func(t *testing.T) {
		dir := t.TempDir()
		p := covrenderWrite(t, dir, "main.tf", covrenderVolume)
		covrenderWrite(t, dir, "attach.tf", "resource \"aws_volume_attachment\" \"a\" {\n  volume_id = aws_ebs_volume.v.id\n}\n")
		loc := &hclops.Located{File: p, Bytes: []byte(covrenderVolume), Start: 0, End: len(covrenderVolume)}
		if !danglingRef(dir, address, loc) {
			t.Fatal("danglingRef = false, want true")
		}
	})

	t.Run("the removed block's own bytes are excluded", func(t *testing.T) {
		// The block mentions its OWN address in a comment; excluding [Start,End)
		// must leave nothing behind, so the removal is allowed.
		src := "resource \"aws_ebs_volume\" \"v\" {\n  # aws_ebs_volume.v is this block\n  size = 100\n}\n"
		dir := t.TempDir()
		p := covrenderWrite(t, dir, "main.tf", src)
		loc := &hclops.Located{File: p, Bytes: []byte(src), Start: 0, End: len(src)}
		if danglingRef(dir, address, loc) {
			t.Fatal("danglingRef = true, want the block's own bytes excluded")
		}
	})

	t.Run("a mention outside the block in the same file counts", func(t *testing.T) {
		tail := "\nresource \"aws_volume_attachment\" \"a\" {\n  volume_id = aws_ebs_volume.v.id\n}\n"
		src := covrenderVolume + tail
		dir := t.TempDir()
		p := covrenderWrite(t, dir, "main.tf", src)
		loc := &hclops.Located{File: p, Bytes: []byte(src), Start: 0, End: len(covrenderVolume)}
		if !danglingRef(dir, address, loc) {
			t.Fatal("danglingRef = false, want true for a same-file reference outside the block")
		}
	})

	t.Run("an unreadable *.tf entry is skipped", func(t *testing.T) {
		dir := t.TempDir()
		p := covrenderWrite(t, dir, "main.tf", covrenderVolume)
		// A DIRECTORY named *.tf: Glob matches it, ReadFile fails, the scan continues.
		if err := os.Mkdir(filepath.Join(dir, "weird.tf"), 0o755); err != nil {
			t.Fatal(err)
		}
		loc := &hclops.Located{File: p, Bytes: []byte(covrenderVolume), Start: 0, End: len(covrenderVolume)}
		if danglingRef(dir, address, loc) {
			t.Fatal("danglingRef = true, want the unreadable entry skipped")
		}
		// A real reference alongside it is still found.
		covrenderWrite(t, dir, "attach.tf", "x = aws_ebs_volume.v.id\n")
		if !danglingRef(dir, address, loc) {
			t.Fatal("danglingRef = false, want the readable reference still found")
		}
	})

	t.Run("an unglobbable env dir yields no reference", func(t *testing.T) {
		// filepath.Glob reports ErrBadPattern for an unterminated character class;
		// the scan must report "no reference" rather than crash.
		if danglingRef(filepath.Join(t.TempDir(), "bad[dir"), address,
			&hclops.Located{File: "main.tf", Bytes: []byte(covrenderVolume), Start: 0, End: len(covrenderVolume)}) {
			t.Fatal("danglingRef = true, want false for an unglobbable dir")
		}
	})
}
