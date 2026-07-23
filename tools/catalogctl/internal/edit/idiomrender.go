package edit

// idiomrender.go is the Go port of ccp/app/src/lib/hclSkeleton.ts's RENDERING
// half. It is a FAITHFUL byte-for-byte transcription of the TS draft
// renderer — NOT the hclwrite/materializeBlock path. The prior lane proved
// hclwrite cannot reproduce the TS renderer: hclwrite aligns `=` and sorts object
// keys, whereas the TS renderer is unaligned (single-space `= `), preserves param
// INSERTION order, and accumulates dotted attrs (`tags.Name`) into a nested map.
// The create verb's authored HCL must be byte-identical to the L1 DRAFT the
// operator saw (minus the display banner), so the review artifact and the
// authored file are the same bytes. The byte-parity harness
// (createResourceParity.test.ts) is the hard gate that keeps this port and
// the TS source in lock-step.
//
// The output is NOT run through hclwrite.Format:
// the engineer `terraform fmt`s their PR (CI already does). Do not "tidy" the
// output here — every space is load-bearing for parity.

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"

	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/idioms"
	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/manifests"
)

// engineerDecides is the allowlist sentinel meaning "an engineer fills this in
// after approval" (hclSkeleton.ts ENGINEER_DECIDES). It renders a `# TODO:` line
// inside the block instead of a bogus assignment.
const engineerDecides = "engineer-decides"

// Sanitizer shapes, mirrored from hclSkeleton.ts. idioms.AddressShapeRe/identShape
// gate a reference into an EXPRESSION; anything else renders as a quoted literal
// (fail-closed — a request byte can never become an expression). The address shape
// itself lives in internal/idioms (idioms.AddressShapeRe) — shared with the create
// verb's idiom table and the plancheck create-guard so all three can never drift
// apart (no import cycle: idioms is dependency-free and never imports edit).
var (
	identShape   = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)
	bareKeyShape = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_-]*$`)
)

/* ── HCL document model (hclSkeleton.ts HclValue / BodyNode / HclBlock) ──────── */

// hclValue is a rendered value: a literal (string/number/bool), a bare expression
// (a reference traversal), a tuple, or a map. kind selects which fields are live.
type hclValue struct {
	kind    string // "literal" | "expr" | "tuple" | "map"
	lit     any    // literal payload: string | float64 | bool
	expr    string // expr payload
	items   []hclValue
	entries []mapEntry
}

type mapEntry struct {
	key string
	val hclValue
}

// bodyNode is one line/child of a block body: an attribute, a nested block, or a
// TODO comment.
type bodyNode struct {
	kind  string // "attr" | "block" | "todo"
	name  string // attr or block name
	value hclValue
	body  []bodyNode
	text  string
}

// hclBlock is a top-level `resource "<type>" "<name>" { … }`.
type hclBlock struct {
	blockType string
	name      string
	body      []bodyNode
}

func exprValue(e string) hclValue  { return hclValue{kind: "expr", expr: e} }
func strLiteral(s string) hclValue { return hclValue{kind: "literal", lit: s} }
func boolLiteral(b bool) hclValue  { return hclValue{kind: "literal", lit: b} }
func attrNode(n string, v hclValue) bodyNode {
	return bodyNode{kind: "attr", name: n, value: v}
}

// preventDestroy is the `lifecycle { prevent_destroy = true }` idiom node the
// estate carries on stateful creates from birth (hclSkeleton.ts PREVENT_DESTROY).
func preventDestroy() bodyNode {
	return bodyNode{kind: "block", name: "lifecycle", body: []bodyNode{
		attrNode("prevent_destroy", boolLiteral(true)),
	}}
}

// preventDestroyTypes / pabAttrs mirror the TS sets exactly.
var preventDestroyTypes = map[string]bool{
	"aws_instance": true, "aws_ebs_volume": true, "aws_db_instance": true,
}

var pabAttrs = map[string]bool{
	"block_public_acls": true, "block_public_policy": true,
	"ignore_public_acls": true, "restrict_public_buckets": true,
}

/* ── Value coercion (hclSkeleton.ts literal / scalarValue / referenceValue) ──── */

// literalValue mirrors hclSkeleton.ts#literal: booleans and finite numbers stay
// typed; everything else becomes a string literal.
func literalValue(value any) hclValue {
	switch v := value.(type) {
	case bool:
		return hclValue{kind: "literal", lit: v}
	case float64:
		if !math.IsInf(v, 0) && !math.IsNaN(v) {
			return hclValue{kind: "literal", lit: v}
		}
	case int:
		return hclValue{kind: "literal", lit: float64(v)}
	case int64:
		return hclValue{kind: "literal", lit: float64(v)}
	}
	return hclValue{kind: "literal", lit: fmt.Sprint(value)}
}

// scalarValue coerces a submitted scalar to its HCL form: numbers for number
// params, booleans as-is (accepting the "true"/"false" string form a YAML request
// may carry), everything else a string literal (hclSkeleton.ts#scalarValue).
func scalarValue(paramType string, value any) hclValue {
	if paramType == "number" {
		if n, ok := toNumber(value); ok {
			return hclValue{kind: "literal", lit: n}
		}
	}
	if paramType == "bool" {
		switch v := value.(type) {
		case bool:
			return hclValue{kind: "literal", lit: v}
		case string:
			if v == "true" || v == "false" {
				return hclValue{kind: "literal", lit: v == "true"}
			}
		}
	}
	return literalValue(value)
}

// referenceValue renders a reference: an expression off a picked address, or a
// quoted literal when the value is not address-shaped (hclSkeleton.ts#referenceValue).
// Fail-closed: never an expression from a non-address byte.
func referenceValue(value any, refAttr string) hclValue {
	address := ""
	if value != nil {
		address = fmt.Sprint(value)
	}
	if idioms.AddressShapeRe.MatchString(address) && refAttr != "" && identShape.MatchString(refAttr) {
		return exprValue(address + "." + refAttr)
	}
	return literalValue(address)
}

/* ── Rendering (hclSkeleton.ts renderValue / renderBody / renderBlock) ───────── */

// renderValue renders one hclValue. The string literal path JSON-escapes and then
// neutralises `${`→`$${` so a pasted value can never open an interpolation
// (hclSkeleton.ts:145). The map path hard-codes the 4-space entry indent and
// 2-space closing brace — correct because a map (tags) only ever renders at a
// block's top level (depth 1).
func renderValue(v hclValue) string {
	switch v.kind {
	case "literal":
		switch x := v.lit.(type) {
		case string:
			return escapeStringLiteral(x)
		case bool:
			return strconv.FormatBool(x)
		case float64:
			return jsNumber(x)
		default:
			return fmt.Sprint(x)
		}
	case "expr":
		return v.expr
	case "tuple":
		parts := make([]string, len(v.items))
		for i, it := range v.items {
			parts[i] = renderValue(it)
		}
		return "[" + strings.Join(parts, ", ") + "]"
	case "map":
		if len(v.entries) == 0 {
			return "{}"
		}
		lines := make([]string, len(v.entries))
		for i, e := range v.entries {
			key := e.key
			if !bareKeyShape.MatchString(key) {
				key = escapeStringLiteral(key)
			}
			lines[i] = "    " + key + " = " + renderValue(e.val)
		}
		return "{\n" + strings.Join(lines, "\n") + "\n  }"
	}
	return ""
}

// escapeStringLiteral is the Go twin of JSON.stringify(s).replace(/\$\{/g,'$${').
// SetEscapeHTML(false) matches JS JSON.stringify (which does NOT escape <>&).
func escapeStringLiteral(s string) string {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(s) // cannot fail for a string; appends a trailing '\n'
	quoted := strings.TrimRight(buf.String(), "\n")
	return strings.ReplaceAll(quoted, "${", "$${")
}

// jsNumber renders a float64 the way JavaScript String(n) does for the value
// domain the baselines use (integers and simple decimals): an integer prints with
// no decimal point, everything else via the shortest round-trippable form.
func jsNumber(f float64) string {
	if f == math.Trunc(f) && math.Abs(f) < 1e15 {
		return strconv.FormatInt(int64(f), 10)
	}
	return strconv.FormatFloat(f, 'g', -1, 64)
}

// renderBody renders block-body nodes at the given depth (2 spaces per level).
func renderBody(nodes []bodyNode, depth int) []string {
	pad := strings.Repeat("  ", depth)
	var lines []string
	for _, n := range nodes {
		switch n.kind {
		case "attr":
			lines = append(lines, pad+n.name+" = "+renderValue(n.value))
		case "todo":
			lines = append(lines, pad+"# TODO: "+n.text)
		default: // block
			lines = append(lines, pad+n.name+" {")
			lines = append(lines, renderBody(n.body, depth+1)...)
			lines = append(lines, pad+"}")
		}
	}
	return lines
}

// renderBlock renders a whole top-level resource block.
func renderBlock(b hclBlock) string {
	lines := []string{fmt.Sprintf("resource %q %q {", b.blockType, b.name)}
	lines = append(lines, renderBody(b.body, 1)...)
	lines = append(lines, "}")
	return strings.Join(lines, "\n")
}

/* ── param→body build (hclSkeleton.ts buildParam / bodyFrom) ─────────────────── */

// builtParam is one param resolved to its placement + value (hclSkeleton.ts BuiltParam).
type builtParam struct {
	param   manifests.Param
	attr    string // "" once a dotted attr is split into mapAttr/mapKey
	mapAttr string
	mapKey  string
	value   *hclValue
	todo    string
	hasVal  bool
}

// effectiveValue mirrors hclSkeleton.ts#effectiveValue: const→p.Const; else the
// submitted value, falling back to the manifest default when absent.
func effectiveValue(p manifests.Param, values map[string]any) any {
	if p.Role == "const" {
		return p.Const
	}
	if v, ok := values[p.Name]; ok {
		return v
	}
	return paramDefault(p)
}

// isEmptyValue mirrors hclSkeleton.ts#isEmptyValue: undefined/null/""/[] are "not given".
func isEmptyValue(v any) bool {
	switch x := v.(type) {
	case nil:
		return true
	case string:
		return x == ""
	case []any:
		return len(x) == 0
	}
	return false
}

// buildParam is the Go port of hclSkeleton.ts#buildParam. Returns (built, true) or
// (_, false) when the param contributes nothing (selector/discriminator, inactive
// via dependsOn, a key param with no explicit attr, or an empty value).
func buildParam(p manifests.Param, values map[string]any) (builtParam, bool) {
	if p.Role == "selector" || p.Role == "discriminator" {
		return builtParam{}, false
	}
	if !isParamActive(p, values) {
		return builtParam{}, false
	}
	attrName := p.Attr
	if attrName == "" {
		attrName = p.Name
	}
	isKey := p.Role == "key"
	if isKey && p.Attr == "" {
		return builtParam{}, false // a key names the block; it writes a value only via an explicit attr
	}
	raw := effectiveValue(p, values)
	if isEmptyValue(raw) {
		return builtParam{}, false
	}

	b := builtParam{param: p, attr: attrName}
	if dot := strings.IndexByte(attrName, '.'); dot > 0 {
		b.mapAttr = attrName[:dot]
		b.mapKey = attrName[dot+1:]
		b.attr = ""
	}

	if s, ok := raw.(string); ok && s == engineerDecides {
		leaf := b.attr
		if leaf == "" {
			leaf = b.mapKey
		}
		if leaf == "" {
			leaf = p.Name
		}
		b.todo = leaf + " — engineer decides"
		return b, true
	}

	setVal := func(v hclValue) { b.value = &v; b.hasVal = true }

	if p.Role == "reference" {
		if arr, ok := raw.([]any); ok {
			items := make([]hclValue, len(arr))
			for i, it := range arr {
				items[i] = referenceValue(it, p.RefAttr)
			}
			setVal(hclValue{kind: "tuple", items: items})
		} else {
			ref := referenceValue(raw, p.RefAttr)
			if p.Wrap == "list" {
				setVal(hclValue{kind: "tuple", items: []hclValue{ref}})
			} else {
				setVal(ref)
			}
		}
		return b, true
	}

	if arr, ok := raw.([]any); ok {
		items := make([]hclValue, len(arr))
		for i, it := range arr {
			items[i] = scalarValue("string", it)
		}
		setVal(hclValue{kind: "tuple", items: items})
		return b, true
	}

	scalar := scalarValue(p.Type, raw)
	if p.Wrap == "list" {
		setVal(hclValue{kind: "tuple", items: []hclValue{scalar}})
	} else {
		setVal(scalar)
	}
	return b, true
}

// nestedLevel is one level of the nested-path tree (hclSkeleton.ts NestedLevel):
// attributes contributed at this depth, then child blocks in first-contribution order.
type nestedLevel struct {
	attrs    []bodyNode
	children map[string]*nestedLevel
	order    []string
}

func newNestedLevel() *nestedLevel {
	return &nestedLevel{children: map[string]*nestedLevel{}}
}

// bodyFrom folds built params into a block body: TODO lines first, then plain
// attrs in param order, then map attrs (tags) in first-contribution order, then
// nested-path blocks — the fixed order hclSkeleton.ts#bodyFrom documents so
// goldens are byte-stable. Nested paths merge as a TREE (params at ["rule"] and
// ["rule","lifecycle"] land in ONE `rule { … lifecycle { … } }`).
func bodyFrom(built []builtParam) []bodyNode {
	var attrs []bodyNode
	var todos []bodyNode
	mapOrder := []string{}
	maps := map[string][]mapEntry{}
	root := newNestedLevel()

	descend := func(path []string) *nestedLevel {
		node := root
		for _, seg := range path {
			child, ok := node.children[seg]
			if !ok {
				child = newNestedLevel()
				node.children[seg] = child
				node.order = append(node.order, seg)
			}
			node = child
		}
		return node
	}

	for _, b := range built {
		if b.todo != "" {
			todos = append(todos, bodyNode{kind: "todo", text: b.todo})
			continue
		}
		if !b.hasVal {
			continue
		}
		if b.mapAttr != "" && b.mapKey != "" {
			if _, seen := maps[b.mapAttr]; !seen {
				mapOrder = append(mapOrder, b.mapAttr)
			}
			maps[b.mapAttr] = append(maps[b.mapAttr], mapEntry{key: b.mapKey, val: *b.value})
			continue
		}
		if len(b.param.Path) > 0 {
			n := descend(b.param.Path)
			n.attrs = append(n.attrs, attrNode(b.attr, *b.value))
			continue
		}
		attrs = append(attrs, attrNode(b.attr, *b.value))
	}

	var renderLevel func(level *nestedLevel) []bodyNode
	renderLevel = func(level *nestedLevel) []bodyNode {
		out := append([]bodyNode{}, level.attrs...)
		for _, seg := range level.order {
			out = append(out, bodyNode{kind: "block", name: seg, body: renderLevel(level.children[seg])})
		}
		return out
	}

	out := append([]bodyNode{}, todos...)
	out = append(out, attrs...)
	for _, mapAttr := range mapOrder {
		out = append(out, attrNode(mapAttr, hclValue{kind: "map", entries: maps[mapAttr]}))
	}
	out = append(out, renderLevel(root)...)
	return out
}

/* ── Estate idioms (hclSkeleton.ts composeBlocks + the named idioms) ─────────── */

// composeBlocks composes the block list for one target resource type (
// the CLOSED idiom table). An unknown type renders mechanically (the default idiom).
func composeBlocks(op manifests.Op, values map[string]any, localName string, built []builtParam) []hclBlock {
	switch op.Target.ResourceType {
	case "aws_ebs_volume":
		return ebsVolumeIdiom(op, values, localName, built)
	case "aws_s3_bucket":
		return s3BucketIdiom(localName, built)
	case "aws_efs_file_system":
		return efsFileSystemIdiom(localName, built)
	case "aws_security_group":
		return securityGroupIdiom(op, values, localName, built)
	case "aws_lambda_function":
		// `inside_vpc` is a FORM-ONLY controller (it gates the vpc_config pickers via
		// dependsOn); it is never a provider attribute and never renders.
		filtered := filterBuilt(built, func(b builtParam) bool { return b.param.Name != "inside_vpc" })
		return []hclBlock{{blockType: op.Target.ResourceType, name: localName, body: bodyFrom(filtered)}}
	default:
		body := bodyFrom(built)
		if preventDestroyTypes[op.Target.ResourceType] {
			body = append(body, preventDestroy())
		}
		return []hclBlock{{blockType: op.Target.ResourceType, name: localName, body: body}}
	}
}

func filterBuilt(built []builtParam, keep func(builtParam) bool) []builtParam {
	var out []builtParam
	for _, b := range built {
		if keep(b) {
			out = append(out, b)
		}
	}
	return out
}

func findBuilt(built []builtParam, name string) (builtParam, bool) {
	for _, b := range built {
		if b.param.Name == name {
			return b, true
		}
	}
	return builtParam{}, false
}

// ebsVolumeIdiom: the volume block plus its aws_volume_attachment — the exact
// two-block shape the committed ebs.tf uses for all 352 volumes (hclSkeleton.ts).
func ebsVolumeIdiom(op manifests.Op, values map[string]any, localName string, built []builtParam) []hclBlock {
	attachAddress := ""
	hasAttach := false
	for _, p := range op.Params {
		if p.Name == "attach_to" {
			hasAttach = true
			if v, ok := values[p.Name]; ok && v != nil {
				attachAddress = fmt.Sprint(v)
			}
			break
		}
	}
	attached := hasAttach && idioms.AddressShapeRe.MatchString(attachAddress)

	volumeBuilt := filterBuilt(built, func(b builtParam) bool {
		n := b.param.Name
		return n != "attach_to" && n != "device_name" && n != "availability_zone"
	})
	volumeBody := bodyFrom(volumeBuilt)
	if attached {
		az := attrNode("availability_zone", exprValue(attachAddress+".availability_zone"))
		volumeBody = append([]bodyNode{az}, volumeBody...) // unshift
	}
	volumeBody = append(volumeBody, preventDestroy())
	blocks := []hclBlock{{blockType: "aws_ebs_volume", name: localName, body: volumeBody}}

	if attached {
		var attachmentBody []bodyNode
		if device, ok := findBuilt(built, "device_name"); ok && device.hasVal {
			attachmentBody = append(attachmentBody, attrNode("device_name", *device.value))
		}
		attachmentBody = append(attachmentBody,
			attrNode("volume_id", exprValue("aws_ebs_volume."+localName+".id")),
			attrNode("instance_id", exprValue(attachAddress+".id")),
		)
		blocks = append(blocks, hclBlock{blockType: "aws_volume_attachment", name: localName, body: attachmentBody})
	}
	return blocks
}

// s3BucketIdiom: bucket + public-access block (const 4×true) + server-side
// encryption config + versioning-when-chosen + a one-rule expiry lifecycle when a
// cleanup age is given (hclSkeleton.ts#s3BucketIdiom). Every bucket carries
// lifecycle { prevent_destroy = true } (freeze-confirm, 20/20 in s3.tf).
func s3BucketIdiom(localName string, built []builtParam) []hclBlock {
	bucketRef := exprValue("aws_s3_bucket." + localName + ".id")

	pabBuilt := filterBuilt(built, func(b builtParam) bool { return b.attr != "" && pabAttrs[b.attr] })
	sseBuilt := filterBuilt(built, func(b builtParam) bool {
		return b.param.Name == "encryption" || b.param.Name == "kms_key"
	})
	versioningParam, hasVersioning := findBuilt(built, "versioning")
	cleanupParam, hasCleanup := findBuilt(built, "lifecycle_cleanup_days")

	consumed := map[string]bool{}
	for _, b := range pabBuilt {
		consumed[b.param.Name] = true
	}
	for _, b := range sseBuilt {
		consumed[b.param.Name] = true
	}
	if hasVersioning {
		consumed["versioning"] = true
	}
	if hasCleanup {
		consumed["lifecycle_cleanup_days"] = true
	}
	bucketBuilt := filterBuilt(built, func(b builtParam) bool { return !consumed[b.param.Name] })

	bucketBody := bodyFrom(bucketBuilt)
	bucketBody = append(bucketBody, preventDestroy())
	blocks := []hclBlock{{blockType: "aws_s3_bucket", name: localName, body: bucketBody}}

	if len(pabBuilt) > 0 {
		body := append([]bodyNode{attrNode("bucket", bucketRef)}, bodyFrom(pabBuilt)...)
		blocks = append(blocks, hclBlock{blockType: "aws_s3_bucket_public_access_block", name: localName, body: body})
	}

	if algorithm, ok := findBuiltIn(sseBuilt, "encryption"); ok && algorithm.hasVal {
		defaults := []bodyNode{attrNode("sse_algorithm", *algorithm.value)}
		if kms, ok := findBuiltIn(sseBuilt, "kms_key"); ok && kms.hasVal {
			defaults = append(defaults, attrNode("kms_master_key_id", *kms.value))
		}
		blocks = append(blocks, hclBlock{
			blockType: "aws_s3_bucket_server_side_encryption_configuration",
			name:      localName,
			body: []bodyNode{
				attrNode("bucket", bucketRef),
				{kind: "block", name: "rule", body: []bodyNode{
					{kind: "block", name: "apply_server_side_encryption_by_default", body: defaults},
				}},
			},
		})
	}

	if hasVersioning && versioningParam.hasVal && isLiteralBool(*versioningParam.value, true) {
		blocks = append(blocks, hclBlock{
			blockType: "aws_s3_bucket_versioning",
			name:      localName,
			body: []bodyNode{
				attrNode("bucket", bucketRef),
				{kind: "block", name: "versioning_configuration", body: []bodyNode{
					attrNode("status", strLiteral("Enabled")),
				}},
			},
		})
	}

	if hasCleanup && cleanupParam.hasVal {
		blocks = append(blocks, hclBlock{
			blockType: "aws_s3_bucket_lifecycle_configuration",
			name:      localName,
			body: []bodyNode{
				attrNode("bucket", bucketRef),
				{kind: "block", name: "rule", body: []bodyNode{
					attrNode("id", strLiteral("expire-objects")),
					attrNode("status", strLiteral("Enabled")),
					{kind: "block", name: "expiration", body: []bodyNode{
						attrNode("days", *cleanupParam.value),
					}},
				}},
			},
		})
	}
	return blocks
}

func findBuiltIn(built []builtParam, name string) (builtParam, bool) {
	return findBuilt(built, name)
}

// efsFileSystemIdiom (SINGLE-BLOCK, reconciled): ONE aws_efs_file_system
// block, lifecycle_policy only when a real age is chosen ("never" is a form answer,
// not an HCL value). enable_backups is NEVER a co-emitted aws_efs_backup_policy —
// it drives a review TODO in both the on and off cases (hclSkeleton.ts#efsFileSystemIdiom).
func efsFileSystemIdiom(localName string, built []builtParam) []hclBlock {
	backups, _ := findBuilt(built, "enable_backups")
	fsBuilt := filterBuilt(built, func(b builtParam) bool {
		if b.param.Name == "enable_backups" {
			return false
		}
		if b.param.Name == "lifecycle_to_ia" && b.hasVal && isLiteralString(*b.value, "never") {
			return false
		}
		return true
	})
	body := bodyFrom(fsBuilt)
	if backups.hasVal && isLiteralBool(*backups.value, false) {
		body = append([]bodyNode{{kind: "todo", text: "automatic backups are off for this share — the justification must say why"}}, body...)
	} else if backups.hasVal && isLiteralBool(*backups.value, true) {
		body = append([]bodyNode{{kind: "todo", text: "automatic backups are on for this share — author the aws_efs_backup_policy separately after it exists"}}, body...)
	}
	return []hclBlock{{blockType: "aws_efs_file_system", name: localName, body: body}}
}

// securityGroupIdiom: the group block, with the optional single starter ingress
// rule only when a protocol was actually chosen — "none"/empty means no rule, so no
// partial ingress block ever renders (hclSkeleton.ts#securityGroupIdiom).
func securityGroupIdiom(op manifests.Op, values map[string]any, localName string, built []builtParam) []hclBlock {
	protocol := ""
	for _, p := range op.Params {
		if p.Name == "first_rule_protocol" {
			if v, ok := values[p.Name]; ok && v != nil {
				protocol = fmt.Sprint(v)
			} else if d := paramDefault(p); d != nil {
				protocol = fmt.Sprint(d)
			}
			break
		}
	}
	withRule := protocol != "" && protocol != "none"
	groupBuilt := built
	if !withRule {
		groupBuilt = filterBuilt(built, func(b builtParam) bool {
			return len(b.param.Path) == 0 || b.param.Path[0] != "ingress"
		})
	}
	return []hclBlock{{blockType: "aws_security_group", name: localName, body: bodyFrom(groupBuilt)}}
}

func isLiteralBool(v hclValue, want bool) bool {
	if v.kind != "literal" {
		return false
	}
	b, ok := v.lit.(bool)
	return ok && b == want
}

func isLiteralString(v hclValue, want string) bool {
	if v.kind != "literal" {
		return false
	}
	s, ok := v.lit.(string)
	return ok && s == want
}

/* ── Public seam: render the banner-stripped create skeleton ─────────────────── */

// renderCreateSkeleton builds the authored HCL for a create op from its submitted
// params — byte-identical to hclSkeleton.ts#renderHclSkeleton MINUS the two-line
// DRAFT banner. Decisions and engineer-decides TODOs are KEPT (real
// unresolved work). It also returns the composed blocks so the verb's guards can
// walk the emitted topology. Pure: no I/O.
func renderCreateSkeleton(op manifests.Op, values map[string]any) (skeleton string, blocks []hclBlock, localName string) {
	localName = idioms.TfLocalName(keyParamValue(op, values))

	var built []builtParam
	for _, p := range op.Params {
		if b, ok := buildParam(p, values); ok {
			built = append(built, b)
		}
	}

	blocks = composeBlocks(op, values, localName, built)

	var parts []string
	if len(op.Decisions) > 0 {
		todo := make([]string, len(op.Decisions))
		for i, d := range op.Decisions {
			todo[i] = "# TODO: " + d
		}
		parts = append(parts, strings.Join(todo, "\n"))
	}
	for _, b := range blocks {
		parts = append(parts, renderBlock(b))
	}
	return strings.Join(parts, "\n\n"), blocks, localName
}

// keyParamValue returns the submitted value of the op's single role:"key" param.
func keyParamValue(op manifests.Op, values map[string]any) any {
	for _, p := range op.Params {
		if p.Role == "key" {
			return values[p.Name]
		}
	}
	return nil
}
