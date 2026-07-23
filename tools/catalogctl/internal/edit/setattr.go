package edit

import (
	"fmt"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/hashicorp/hcl/v2"
	"github.com/hashicorp/hcl/v2/hclsyntax"
	"github.com/hashicorp/hcl/v2/hclwrite"
	"github.com/zclconf/go-cty/cty"

	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/hclops"
	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/manifests"
	"github.com/masjamsss/cloud-control-plane/tools/catalogctl/internal/request"
)

// setAttribute implements spec: scalar value-token replacement (preserving a
// trailing comment), map-merge into a literal object, or the grow-only guard.
func setAttribute(op manifests.Op, req *request.Request, loc *hclops.Located) ([]byte, string, string, error) {
	blockBytes := loc.Bytes[loc.Start:loc.End]
	f, diags := hclwrite.ParseConfig(blockBytes, loc.File, hcl.Pos{Line: 1, Column: 1})
	if diags.HasErrors() {
		return nil, "", "", fmt.Errorf("parse block: %s", diags.Error())
	}
	blocks := f.Body().Blocks()
	if len(blocks) != 1 {
		return nil, "", "", fmt.Errorf("expected exactly one block, got %d", len(blocks))
	}
	block := blocks[0]

	// a target.path navigates into a nested block (optionally selecting one
	// keyed sibling) before applying the scalar-set / map-merge below.
	if len(op.Target.Path) > 0 {
		return setAttributeNested(op, req, filepath.Dir(loc.File), f, block)
	}

	vp := valueParam(op)
	if vp == nil {
		return nil, "", "", fmt.Errorf("op %q has no value param", op.ID)
	}

	// Map merge (spec) — target.block names the map-typed attribute (e.g. tags).
	if op.Target.Block != "" {
		// SAFETY (pending): a dotted target.block is a nested path this
		// verb cannot address yet; mergeMap would write a dotted attribute name =
		// invalid HCL. Refuse (route to engineer) rather than corrupt the file.
		if strings.Contains(op.Target.Block, ".") {
			return nil, "UNSUPPORTED_PATH", fmt.Sprintf("nested path %q is not yet supported — routed to an engineer", op.Target.Block), nil
		}
		reqMap, ok := toStringMap(req.Params[vp.Name])
		if !ok {
			return nil, "", "", fmt.Errorf("param %q is not a map", vp.Name)
		}
		code, reason, err := mergeMap(block, op.Target.Block, reqMap, op.Target.EnsureAttr, op.Target.ResourceType)
		if err != nil || code != "" {
			return nil, code, reason, err
		}
		return hclwrite.Format(f.Bytes()), "", "", nil
	}

	// Scalar set.
	name := attrName(op)
	if name == "" {
		return nil, "", "", fmt.Errorf("cannot resolve attribute name for op %q", op.ID)
	}
	// SAFETY (pending): a dotted name is a nested attribute path. SetAttributeRaw
	// would write it as a dotted LHS = INVALID HCL (terraform fmt rejects it). Refuse
	// (route to engineer) until path+selector addressing lands, rather than corrupt the file.
	if strings.Contains(name, ".") {
		return nil, "UNSUPPORTED_PATH", fmt.Sprintf("nested attribute path %q is not yet supported — routed to an engineer", name), nil
	}
	raw := req.Params[vp.Name]

	// Direction guard (spec): grow-only reads the CURRENT value from the file
	// bytes; a strict shrink refuses. new == current is a no-op (idempotence).
	if vp.Bounds != nil && vp.Bounds.GrowOnly {
		newNum, ok := toFloat(raw)
		if !ok {
			return nil, "", "", fmt.Errorf("grow-only param %q is not numeric", vp.Name)
		}
		cur, ok := currentNumber(blockBytes, name)
		if !ok {
			return nil, "", "", fmt.Errorf("cannot read current %q value", name)
		}
		if newNum < cur {
			return nil, "SHRINK", fmt.Sprintf("%s %s is below current %s (grow-only)", vp.Name, num(newNum), num(cur)), nil
		}
	}

	toks, code, reason, err := valueTokens(filepath.Dir(loc.File), *vp, raw)
	if err != nil || code != "" {
		return nil, code, reason, err
	}
	setScalar(block, name, toks)
	return hclwrite.Format(f.Bytes()), "", "", nil
}

// setAttributeNested applies the scalar-set or map-merge to the nested
// block reached by target.path (+ optional selector), rewriting only the top-level
// block f. Refuses PATH_NOT_FOUND / SELECTOR_AMBIGUOUS on an unresolvable address.
func setAttributeNested(op manifests.Op, req *request.Request, envDir string, f *hclwrite.File, top *hclwrite.Block) ([]byte, string, string, error) {
	target, code, reason := descendPath(top, op.Target.Path, selectorFor(op, req), op.Target.EnsurePath, op.Target.MatchPresence)
	if code != "" {
		return nil, code, reason, nil
	}

	vp := valueParam(op)
	if vp == nil {
		return nil, "", "", fmt.Errorf("op %q has no value param", op.ID)
	}

	// Nested map merge — target.block names the map-typed attribute inside the
	// navigated block (e.g. schedule.tags_to_add).
	if op.Target.Block != "" {
		if strings.Contains(op.Target.Block, ".") {
			return nil, "UNSUPPORTED_PATH", fmt.Sprintf("nested path %q is not yet supported — routed to an engineer", op.Target.Block), nil
		}
		reqMap, ok := toStringMap(req.Params[vp.Name])
		if !ok {
			return nil, "", "", fmt.Errorf("param %q is not a map", vp.Name)
		}
		code, reason, err := mergeMap(target, op.Target.Block, reqMap, op.Target.EnsureAttr, op.Target.ResourceType)
		if err != nil || code != "" {
			return nil, code, reason, err
		}
		return hclwrite.Format(f.Bytes()), "", "", nil
	}

	// Nested scalar set.
	name := nestedAttrName(op)
	if name == "" {
		return nil, "", "", fmt.Errorf("cannot resolve attribute name for op %q", op.ID)
	}
	if strings.Contains(name, ".") {
		return nil, "UNSUPPORTED_PATH", fmt.Sprintf("nested attribute path %q is not yet supported — routed to an engineer", name), nil
	}
	raw := req.Params[vp.Name]

	// Direction guard (spec) — grow-only reads the CURRENT value from the
	// nested block's bytes; a strict shrink refuses.
	if vp.Bounds != nil && vp.Bounds.GrowOnly {
		newNum, ok := toFloat(raw)
		if !ok {
			return nil, "", "", fmt.Errorf("grow-only param %q is not numeric", vp.Name)
		}
		cur, ok := currentNumberHW(target, name)
		if !ok {
			return nil, "", "", fmt.Errorf("cannot read current %q value", name)
		}
		if newNum < cur {
			return nil, "SHRINK", fmt.Sprintf("%s %s is below current %s (grow-only)", vp.Name, num(newNum), num(cur)), nil
		}
	}

	toks, code, reason, err := valueTokens(envDir, *vp, raw)
	if err != nil || code != "" {
		return nil, code, reason, err
	}
	setScalar(target, name, toks)
	return hclwrite.Format(f.Bytes()), "", "", nil
}

// valueParam returns the op's single value param: the first value-provider (
// an ordinary user_input value, a role:"const", or a role:"reference" onto
// another resource). A role:"selector" or a plain inventory target is not a value.
func valueParam(op manifests.Op) *manifests.Param {
	for i := range op.Params {
		if isValueProvider(op.Params[i]) {
			return &op.Params[i]
		}
	}
	return nil
}

// hclIdentRe validates a bare map-key identifier (keyTokens). The retired paren-attr
// regex that used to sit beside it now lives once in manifests.ProseAttrToken, shared
// by the executor, the plancheck verifier, and the demotion lint.
var hclIdentRe = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_-]*$`)

// attrName resolves the scalar attribute a flat set_attribute op writes.
//
// AUTHORITATIVE PATH: an explicit op.Target.Attr is
// the single source of truth — returned verbatim, the prose is NEVER consulted.
// This closes the paren-attr hazard: the fallback below parses the write target out
// of the first parenthesized token of the free-text terraformCapability prose ahead
// of the value param's own name, so a malformed/generated manifest (a natural-phrase
// paren, reordered params) could yield an exit-0 write to the WRONG attribute.
// Migrated ops declare target.attr and are immune.
//
// FALLBACK PATH (un-migrated ops — unchanged, so byte-for-byte identical): the bare
// paren token of terraformCapability (manifests.ProseAttrToken), else
// manifests.AttrFor on the value param. valueParam resolves references/
// consts too, so a reference op's target attribute (e.g. kms_key_id) is named
// without a paren hint.
func attrName(op manifests.Op) string {
	if op.Target.Attr != "" {
		return op.Target.Attr
	}
	if tok := manifests.ProseAttrToken(op.TerraformCapability); tok != "" {
		return tok
	}
	if vp := valueParam(op); vp != nil {
		return manifests.AttrFor(op, *vp)
	}
	return ""
}

// setScalar writes toks as attr's value. On an existing attribute it replaces only
// the value tokens, preserving a trailing line comment (hclwrite keeps it as a
// separate attribute token — verified); absent, it appends at the canonical
// position. (takes ready-made tokens so const/reference/list values flow
// through the same seam as scalars.)
func setScalar(block *hclwrite.Block, name string, toks hclwrite.Tokens) {
	block.Body().SetAttributeRaw(name, toks)
}

// currentNumber reads a literal numeric attribute from the block bytes (
// grow-only reads the file, not inventory).
func currentNumber(blockBytes []byte, attr string) (float64, bool) {
	f, diags := hclsyntax.ParseConfig(blockBytes, "block.tf", hcl.Pos{Line: 1, Column: 1})
	if diags.HasErrors() {
		return 0, false
	}
	body, ok := f.Body.(*hclsyntax.Body)
	if !ok || len(body.Blocks) == 0 {
		return 0, false
	}
	a, ok := body.Blocks[0].Body.Attributes[attr]
	if !ok {
		return 0, false
	}
	v, d := a.Expr.Value(nil)
	if d.HasErrors() || v.Type() != cty.Number {
		return 0, false
	}
	f64, _ := v.AsBigFloat().Float64()
	return f64, true
}

type objEntry struct {
	key     string
	keyToks hclwrite.Tokens
	valToks hclwrite.Tokens
	comment hclwrite.Tokens
}

// mergeMap merges reqMap into the literal object attribute (spec): existing
// keys keep position (requested ones get value-token replacement), new keys append
// (sorted for determinism), and hclwrite re-aligns. Non-literal object → NOT_LITERAL.
//
// resourceType is the target's op.Target.ResourceType, threaded in by both
// callers (setAttribute, setAttributeNested) rather than read off block's own
// labels: a nested merge's block is a SUB-block reached via descendPath and
// generally carries no resource-type label at all, so the caller's op is the
// only reliable source at every call site (Lane K, 0039 §4.2).
//
// For an azurerm_* target ONLY (SchemaDumpPrefix(resourceType) == "azurerm"),
// an incoming key that case-folds to an EXISTING key under a DIFFERENT byte
// spelling refuses TAG_KEY_CASE_COLLISION before anything is written — Azure
// tag names are case-insensitive, so "Owner" and "owner" name the same tag,
// and silently keeping both as distinct HCL keys would diverge from what
// Azure actually stores. A byte-EQUAL key is an ordinary overwrite (unchanged
// below). aws_* targets never reach the check — the whole guard is gated on
// the prefix, so AWS's genuinely case-sensitive tag keys are byte-identical.
func mergeMap(block *hclwrite.Block, attr string, reqMap map[string]any, ensure bool, resourceType string) (string, string, error) {
	a := block.Body().GetAttribute(attr)
	var entries []objEntry
	if a == nil {
		// ensureAttr: create the absent object and merge every reqMap key
		// into it (each is a "new key" appended below). Without ensure an absent
		// attribute stays the exit-1 error — behavior preserved.
		if !ensure {
			return "", "", fmt.Errorf("attribute %q not found for map merge", attr)
		}
	} else {
		var ok bool
		entries, ok = parseObject(a.Expr().BuildTokens(nil))
		if !ok {
			return "NOT_LITERAL", fmt.Sprintf("%s is not a literal object", attr), nil
		}
	}
	if SchemaDumpPrefix(resourceType) == "azurerm" {
		if code, reason := azureTagKeyCaseCollision(entries, reqMap); code != "" {
			return code, reason, nil
		}
	}
	used := map[string]bool{}
	for i := range entries {
		if nv, ok := reqMap[entries[i].key]; ok {
			v, err := anyToCty(nv)
			if err != nil {
				return "", "", err
			}
			entries[i].valToks = hclwrite.TokensForValue(v)
			used[entries[i].key] = true
		}
	}
	var newKeys []string
	for k := range reqMap {
		if !used[k] {
			newKeys = append(newKeys, k)
		}
	}
	sort.Strings(newKeys)
	for _, k := range newKeys {
		v, err := anyToCty(reqMap[k])
		if err != nil {
			return "", "", err
		}
		entries = append(entries, objEntry{key: k, keyToks: keyTokens(k), valToks: hclwrite.TokensForValue(v)})
	}
	block.Body().SetAttributeRaw(attr, buildObject(entries))
	return "", "", nil
}

// azureTagKeyCaseCollision reports the first incoming reqMap key that case-folds to
// a DIFFERENT byte spelling already present — an EXISTING entry's key ("owner" vs a
// stored "Owner") OR an EARLIER incoming key in the SAME request ("Owner" and "owner"
// submitted together). Byte-equal keys are never a collision (that is today's ordinary
// overwrite, handled by the caller's normal merge loop). reqMap iteration order is not
// stable in Go, so incoming keys are walked sorted for a deterministic first-collision
// report across runs.
func azureTagKeyCaseCollision(entries []objEntry, reqMap map[string]any) (string, string) {
	// Fold every key — existing AND already-seen incoming — so a collision is caught
	// whether the incoming key case-folds to an EXISTING entry ("owner" vs a stored
	// "Owner") OR to an EARLIER key in the SAME request (both "Owner" and "owner"
	// submitted at once). Without the reqMap-internal case, two case-distinct keys from
	// one request would both append and diverge from the single tag Azure actually stores.
	byFold := make(map[string]string, len(entries)+len(reqMap))
	for _, e := range entries {
		byFold[strings.ToLower(e.key)] = e.key
	}
	incoming := make([]string, 0, len(reqMap))
	for k := range reqMap {
		incoming = append(incoming, k)
	}
	sort.Strings(incoming)
	for _, k := range incoming {
		fold := strings.ToLower(k)
		if seen, ok := byFold[fold]; ok && seen != k {
			return "TAG_KEY_CASE_COLLISION", fmt.Sprintf(
				"Azure tag names are case-insensitive — %q and %q are the same tag; routed to an engineer",
				seen, k,
			)
		}
		byFold[fold] = k
	}
	return "", ""
}

// parseObject splits a literal object token stream into ordered entries. Returns
// ok=false when the expression is not a `{ … }` literal.
func parseObject(toks hclwrite.Tokens) ([]objEntry, bool) {
	i := 0
	for i < len(toks) && (toks[i].Type == hclsyntax.TokenComment || toks[i].Type == hclsyntax.TokenNewline) {
		i++
	}
	if i >= len(toks) || toks[i].Type != hclsyntax.TokenOBrace {
		return nil, false
	}
	i++
	var entries []objEntry
	for i < len(toks) {
		switch toks[i].Type {
		case hclsyntax.TokenNewline, hclsyntax.TokenComma:
			i++
			continue
		case hclsyntax.TokenCBrace:
			return entries, true
		}
		var keyToks hclwrite.Tokens
		for i < len(toks) && toks[i].Type != hclsyntax.TokenEqual {
			if toks[i].Type == hclsyntax.TokenNewline || toks[i].Type == hclsyntax.TokenCBrace {
				return nil, false
			}
			keyToks = append(keyToks, toks[i])
			i++
		}
		if i >= len(toks) || toks[i].Type != hclsyntax.TokenEqual {
			return nil, false
		}
		i++ // skip '='
		var valToks, comment hclwrite.Tokens
		depth := 0
		for i < len(toks) {
			t := toks[i]
			if depth == 0 && (t.Type == hclsyntax.TokenNewline || t.Type == hclsyntax.TokenComma || t.Type == hclsyntax.TokenCBrace) {
				break
			}
			if t.Type == hclsyntax.TokenComment {
				comment = append(comment, t)
				i++
				// A single-line comment token CARRIES its terminating newline
				// ("# note\n" is one token), so at depth 0 it also ends the ENTRY.
				// Without this, the tokens of the NEXT entry are swallowed into
				// this entry's valToks and buildObject glues two entries onto one
				// line at exit 0 — measured corrupting ec2-add-instance-tag on a
				// tags map with a mid-map trailing comment (exit-0 mis-edit
				// class), and defeating the foreach KEY_CONFLICT guard for the
				// swallowed key (a silent duplicate-key add).
				if depth == 0 && strings.HasSuffix(string(t.Bytes), "\n") {
					break
				}
				continue
			}
			switch t.Type {
			case hclsyntax.TokenOBrace, hclsyntax.TokenOBrack, hclsyntax.TokenOParen:
				depth++
			case hclsyntax.TokenCBrace, hclsyntax.TokenCBrack, hclsyntax.TokenCParen:
				depth--
			}
			valToks = append(valToks, t)
			i++
		}
		entries = append(entries, objEntry{key: keyString(keyToks), keyToks: keyToks, valToks: valToks, comment: comment})
	}
	return nil, false
}

func keyString(toks hclwrite.Tokens) string {
	var sb strings.Builder
	for _, t := range toks {
		switch t.Type {
		case hclsyntax.TokenOQuote, hclsyntax.TokenCQuote:
			// drop the quotes; keep the literal
		default:
			sb.Write(t.Bytes)
		}
	}
	return sb.String()
}

func keyTokens(k string) hclwrite.Tokens {
	if hclIdentRe.MatchString(k) {
		return hclwrite.Tokens{{Type: hclsyntax.TokenIdent, Bytes: []byte(k)}}
	}
	// SECURITY: a non-identifier map key must be emitted as a
	// fully-escaped string literal, NOT its raw bytes. Raw bytes let a crafted key
	// containing `"`/newline/`{`/`}` break out of the map — hclwrite.Format then
	// re-lexes the debris into REAL top-level structure at exit 0 (confirmed:
	// s3-update-tags injecting `force_destroy = true`). TokensForValue is the same
	// seam values already use safely; it escapes `"`→\", newline→\n, etc., so the
	// key can only ever render as one literal. Identifier keys stay bare above, so
	// no golden churn.
	return hclwrite.TokensForValue(cty.StringVal(k))
}

func buildObject(entries []objEntry) hclwrite.Tokens {
	toks := hclwrite.Tokens{
		{Type: hclsyntax.TokenOBrace, Bytes: []byte("{")},
		{Type: hclsyntax.TokenNewline, Bytes: []byte("\n")},
	}
	for _, e := range entries {
		toks = append(toks, e.keyToks...)
		toks = append(toks, &hclwrite.Token{Type: hclsyntax.TokenEqual, Bytes: []byte("=")})
		toks = append(toks, e.valToks...)
		toks = append(toks, e.comment...)
		// A trailing line comment already carries the entry's newline (see
		// parseObject) — appending another would leave a blank line mid-map.
		if n := len(e.comment); n > 0 && strings.HasSuffix(string(e.comment[n-1].Bytes), "\n") {
			continue
		}
		toks = append(toks, &hclwrite.Token{Type: hclsyntax.TokenNewline, Bytes: []byte("\n")})
	}
	return append(toks, &hclwrite.Token{Type: hclsyntax.TokenCBrace, Bytes: []byte("}")})
}

func anyToCty(v any) (cty.Value, error) {
	switch n := v.(type) {
	case string:
		return cty.StringVal(n), nil
	case bool:
		return cty.BoolVal(n), nil
	case int:
		return cty.NumberIntVal(int64(n)), nil
	case int64:
		return cty.NumberIntVal(n), nil
	case float64:
		if n == float64(int64(n)) {
			return cty.NumberIntVal(int64(n)), nil
		}
		return cty.NumberFloatVal(n), nil
	case []any:
		// a YAML sequence / JSON array → a tuple literal (heterogeneous
		// element types are allowed; TokensForValue renders `[a, b, …]`).
		if len(n) == 0 {
			return cty.EmptyTupleVal, nil
		}
		vals := make([]cty.Value, len(n))
		for i, e := range n {
			ev, err := anyToCty(e)
			if err != nil {
				return cty.NilVal, err
			}
			vals[i] = ev
		}
		return cty.TupleVal(vals), nil
	case map[string]any:
		// a YAML/JSON object → an object literal (`{ k = v, … }`).
		if len(n) == 0 {
			return cty.EmptyObjectVal, nil
		}
		m := make(map[string]cty.Value, len(n))
		for k, e := range n {
			ev, err := anyToCty(e)
			if err != nil {
				return cty.NilVal, err
			}
			m[k] = ev
		}
		return cty.ObjectVal(m), nil
	}
	return cty.NilVal, fmt.Errorf("unsupported value type %T", v)
}

func toStringMap(v any) (map[string]any, bool) {
	switch m := v.(type) {
	case map[string]any:
		return m, true
	case map[any]any:
		out := make(map[string]any, len(m))
		for k, val := range m {
			ks, ok := k.(string)
			if !ok {
				return nil, false
			}
			out[ks] = val
		}
		return out, true
	}
	return nil, false
}

func toFloat(v any) (float64, bool) {
	switch n := v.(type) {
	case float64:
		return n, true
	case float32:
		return float64(n), true
	case int:
		return float64(n), true
	case int64:
		return float64(n), true
	case string:
		f, err := strconv.ParseFloat(n, 64)
		return f, err == nil
	}
	return 0, false
}

func num(f float64) string {
	if f == float64(int64(f)) {
		return strconv.FormatInt(int64(f), 10)
	}
	return strconv.FormatFloat(f, 'g', -1, 64)
}
