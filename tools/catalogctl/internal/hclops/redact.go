package hclops

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"hash/fnv"
	"regexp"
	"strings"
)

// redactionRulesJSON is a Go-embedded copy of the canonical catalog/redaction-rules.json
// (also bundled by the SPA at ccp/app/src/data/redaction-rules.json). go:embed can
// only reach files inside this package directory, so the canonical rules are copied
// here. SYNC OBLIGATION: this copy MUST stay byte-identical to catalog/redaction-rules.json
// — TestEmbeddedRedactionRulesInSyncWithCanonical fails if they drift. See docs
// display and archive must mask identically.
//
//go:embed redaction-rules.json
var redactionRulesJSON []byte

type redactionRules struct {
	SecretAttributeNames   []string `json:"secretAttributeNames"`
	MaskAllValuesInBlocks  []string `json:"maskAllValuesInBlocks"`
	ValueAllowlistPrefixes []string `json:"valueAllowlistPrefixes"`
}

var (
	secretTerms   []string            // lowercased secret attribute-name substrings
	maskBlocks    map[string]struct{} // lowercased block names whose every value is masked
	allowPrefixes []string            // benign value prefixes never treated as secret
)

func init() {
	var r redactionRules
	if err := json.Unmarshal(redactionRulesJSON, &r); err != nil {
		panic("hclops: invalid embedded redaction-rules.json: " + err.Error())
	}
	for _, s := range r.SecretAttributeNames {
		secretTerms = append(secretTerms, strings.ToLower(s))
	}
	maskBlocks = make(map[string]struct{}, len(r.MaskAllValuesInBlocks))
	for _, s := range r.MaskAllValuesInBlocks {
		maskBlocks[strings.ToLower(s)] = struct{}{}
	}
	allowPrefixes = r.ValueAllowlistPrefixes
}

// Regexes ported verbatim from ccp/app/src/lib/redact.ts so the Go archive guard
// and the SPA display guard recognize exactly the same shapes.
var (
	uuidRe = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
	// longTokenRe: a value ENTIRELY >=24 base64/hex/key-alphabet characters. The
	// alphabet drops `-`/`_` (the separators of human-named identifiers) so a
	// dash-joined structured id — a TLS-policy name, a dated snapshot id — is not
	// mistaken for a solid-entropy credential; it stays anchored
	// so a value merely CONTAINING a long run is not over-masked. Ported to match
	// ccp/app/src/lib/redact.ts LONG_TOKEN exactly.
	longTokenRe = regexp.MustCompile(`^[A-Za-z0-9+/=]{24,}$`)
	letterRe    = regexp.MustCompile(`[A-Za-z]`)
	digitRe     = regexp.MustCompile(`[0-9]`)
	// assignRe: optional leading ws, optional diff marker (+/-/~), key, =, rhs.
	assignRe = regexp.MustCompile(`^(\s*[+\-~]?\s*)([A-Za-z0-9_.-]+)(\s*=\s*)(.*)$`)
	// blockOpenRe: a block opener line — name, optional "labels", optional =, then {.
	blockOpenRe  = regexp.MustCompile(`^\s*[+\-~]?\s*([A-Za-z0-9_.-]+)(?:\s+"[^"]*")*\s*(?:=\s*)?\{\s*$`)
	closeBraceRe = regexp.MustCompile(`^\s*\}\s*$`)
	// rhsOpensBlockRe: RHS that opens a nested block on the same line (`key = {`).
	rhsOpensBlockRe = regexp.MustCompile(`\{\s*$`)
	// quotedRe: an HCL double-quoted string literal, escape-aware.
	quotedRe = regexp.MustCompile(`"((?:[^"\\]|\\.)*)"`)
)

// isSecretName reports whether a lowercased attribute name reads as secret-bearing.
// Substring match (so db_secret, master_user_password, api_token all match) —
// over-masking is the safe direction for an evidence guard.
func isSecretName(keyLc string, extra map[string]struct{}) bool {
	if _, ok := extra[keyLc]; ok {
		return true
	}
	for _, term := range secretTerms {
		if strings.Contains(keyLc, term) {
			return true
		}
	}
	return false
}

func isAllowlisted(value string) bool {
	for _, p := range allowPrefixes {
		if strings.HasPrefix(value, p) {
			return true
		}
	}
	return false
}

// looksLikeSecret reports whether a bare string value looks like a credential worth
// masking: a UUID, or a >=24-char base64/hex/key-alphabet token carrying BOTH a
// letter and a digit — unless it is on the benign AWS-id/URL prefix allowlist.
// attrName (empty when not known) lets a bare GUID in an `*_id`/`*_ids` attribute
// pass as an IDENTIFIER (Azure tenant/subscription/object ids) — the name rule for
// secret-bearing attributes (client_secret, …) has already fired in RedactWith
// before this shape check runs, so this cannot unmask a named secret. Mirrors
// ccp/app/src/lib/redact.ts looksLikeSecret exactly (attrName?: string there;
// Go has no optional params, so "" stands in for "not known").
func looksLikeSecret(value string, attrName string) bool {
	if isAllowlisted(value) {
		return false
	}
	if uuidRe.MatchString(value) {
		n := strings.ToLower(attrName)
		return !(strings.HasSuffix(n, "_id") || strings.HasSuffix(n, "_ids"))
	}
	return longTokenRe.MatchString(value) && letterRe.MatchString(value) && digitRe.MatchString(value)
}

// stableTag is FNV-1a/32 over the bytes of s, rendered as 8 hex — a stable,
// non-reversible pointer, NOT cryptographic. Go's hash/fnv matches the SPA's
// Math.imul FNV-1a for ASCII (the only alphabet secrets appear in), so the same
// secret masks to the same tag on both the archive and the display.
func stableTag(s string) string {
	h := fnv.New32a()
	_, _ = h.Write([]byte(s))
	return fmt.Sprintf("%08x", h.Sum32())
}

func masked(inner string) string {
	return "«redacted:" + stableTag(inner) + "»"
}

// maskRhs masks quoted string literals on the RHS of an assignment. Idempotent: an
// already-masked value is left alone, so Redact(Redact(x)) == Redact(x). attrName
// is the attribute this RHS belongs to (empty when not known) — threaded through to
// looksLikeSecret so the `*_id`/`*_ids` GUID-identifier exception can apply.
func maskRhs(rhs string, maskAll bool, attrName string) string {
	return quotedRe.ReplaceAllStringFunc(rhs, func(whole string) string {
		inner := whole[1 : len(whole)-1] // strip the surrounding quotes
		if strings.HasPrefix(inner, "«redacted:") {
			return whole
		}
		if maskAll || looksLikeSecret(inner, attrName) {
			return `"` + masked(inner) + `"`
		}
		return whole
	})
}

// RedactOptions mirrors ccp/app/src/lib/redact.ts RedactOptions.
type RedactOptions struct {
	// SensitiveAttrs adds extra attribute names to treat as secret (e.g. from a
	// provider-schema sensitive:true map or manifest params flagged sensitive).
	SensitiveAttrs []string
	// NeverMaskAttrs are attribute names whose value is a MANIFEST CONSTANT or the
	// resource's own identity (role:"const"/"key" params — `http_tokens = "required"`,
	// an EFS `creation_token`), never request input. The attribute-NAME rule is
	// skipped for these so a machine-checkable guardrail the reviewer must SEE stays
	// visible in the evidence diff; the value-shape rule still applies, and an attr
	// also named in SensitiveAttrs stays masked (sensitive wins). Mirrors redactHcl's
	// neverMaskAttrs.
	NeverMaskAttrs []string
}

// Redact masks secret material in HCL text, line by line and deterministically,
// exactly as the SPA's redactHcl (ccp/app/src/lib/redact.ts). It masks:
//  1. values of attributes whose name reads as a secret (password, token, …),
//  2. every value inside a known secret-bearing block (lambda environment/variables,
//     secret_string, kms),
//  3. any standalone value that looks like a secret (UUID / long high-entropy token)
//     not on the benign AWS-id/URL allowlist.
//
// It is line-count-preserving (never adds/removes lines), so redacting each side of
// a diff before UnifiedDiff yields a diff whose every emitted line — changed OR
// context — is already masked. sensitiveAttrs adds extra attribute names to treat as
// secret (e.g. from a provider-schema sensitive:true map).
func Redact(text []byte, sensitiveAttrs ...string) []byte {
	return RedactWith(text, RedactOptions{SensitiveAttrs: sensitiveAttrs})
}

// RedactWith is Redact with the full option set — the neverMaskAttrs-aware entry
// point mirroring redactHcl(text, opts). Redact stays a thin variadic wrapper so
// existing callers are byte-for-byte unchanged.
func RedactWith(text []byte, opts RedactOptions) []byte {
	extra := make(map[string]struct{}, len(opts.SensitiveAttrs))
	for _, s := range opts.SensitiveAttrs {
		extra[strings.ToLower(s)] = struct{}{}
	}
	neverMask := make(map[string]struct{}, len(opts.NeverMaskAttrs))
	for _, s := range opts.NeverMaskAttrs {
		lc := strings.ToLower(s)
		if _, ok := extra[lc]; !ok { // sensitive wins over never-mask
			neverMask[lc] = struct{}{}
		}
	}
	// Stack of block names by brace depth, so we know when we are inside a
	// secret-bearing block at any nesting level.
	var blockStack []string
	inMaskBlock := func() bool {
		for _, b := range blockStack {
			if _, ok := maskBlocks[b]; ok {
				return true
			}
		}
		return false
	}

	lines := strings.Split(string(text), "\n")
	for i, line := range lines {
		if m := blockOpenRe.FindStringSubmatch(line); m != nil {
			blockStack = append(blockStack, strings.ToLower(m[1]))
			continue
		}
		if closeBraceRe.MatchString(line) {
			if len(blockStack) > 0 {
				blockStack = blockStack[:len(blockStack)-1]
			}
			continue
		}
		m := assignRe.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		prefix, key, eq, rhs := m[1], m[2], m[3], m[4]
		keyLc := strings.ToLower(key)
		_, never := neverMask[keyLc]
		maskAll := (isSecretName(keyLc, extra) && !never) || inMaskBlock()
		// If the RHS opens a nested block on the same line, track it too.
		if rhsOpensBlockRe.MatchString(rhs) {
			blockStack = append(blockStack, keyLc)
		}
		lines[i] = prefix + key + eq + maskRhs(rhs, maskAll, keyLc)
	}
	return []byte(strings.Join(lines, "\n"))
}
