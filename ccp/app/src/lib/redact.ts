// Bundled copy of the canonical rules at catalog/redaction-rules.json (the file
// catalogctl also reads). Keep the two in sync — the canonical copy is authoritative.
import rules from '@/data/redaction-rules.json';

/**
 * Display-side secret redaction. Runs over any HCL text BEFORE it is shown to a
 * requester/approver or written to an evidence record — the guard that must exist
 * before the control plane ever renders a real Terraform block.
 *
 * It is deterministic and synchronous (safe to call in render). It masks:
 *   1. values of attributes whose name is a known secret (e.g. `password`, `token`),
 *   2. every value inside a known secret-bearing block (e.g. lambda `environment`),
 *   3. any standalone value that looks like a secret (UUID / long high-entropy
 *      token) and is not on the allowlist of benign AWS id/URL shapes.
 *
 * Masked values become `«redacted:<8hex>»` — a stable, non-reversible pointer so
 * the same secret reads the same tag without revealing it. The rule set is shared
 * with the future `catalogctl` codemod via catalog/redaction-rules.json so display
 * and archive mask identically.
 *
 * Limitation: heredoc / multi-line string values are not parsed line-by-line; the
 * attribute-name rule still catches `token = <<EOF` openers, but callers rendering
 * full blocks with heredoc secrets should prefer the provider-schema sensitive map.
 */

const SECRET_TERMS = rules.secretAttributeNames.map((s) => s.toLowerCase());
const MASK_BLOCKS = new Set(rules.maskAllValuesInBlocks.map((s) => s.toLowerCase()));
const ALLOW_PREFIXES = rules.valueAllowlistPrefixes;

/** A secret-bearing attribute name — matched as a substring so `db_secret`,
 * `master_user_password`, and `api_token` are all caught (over-masking is the
 * safe direction for a display guard). */
function isSecretName(keyLc: string, extra: Set<string>): boolean {
  if (extra.has(keyLc)) return true;
  return SECRET_TERMS.some((term) => keyLc.includes(term));
}

/** True when an attribute/param name reads as secret-bearing (password/token/…). */
export function isSecretAttrName(name: string): boolean {
  return isSecretName(name.toLowerCase(), new Set<string>());
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A long token: a value that is ENTIRELY >=24 base64/hex/key-alphabet characters,
// containing BOTH a letter and a digit (so ordinary long words and dotted paths
// are not flagged). The alphabet is `[A-Za-z0-9+/=]` — the `-` and `_` of the
// prior class are DROPPED: those separate human-named identifiers, and the anchors
// mean a value carrying one is no longer a single solid token. So a solid AWS
// key / hex digest / base64 secret (`AKIA1234567890ABCDEFghij`) still trips it,
// while a dash-joined structured id — a TLS-policy name
// (`ELBSecurityPolicy-TLS13-1-2-2021-06`), a dated snapshot id
// (`pre-release-app-db01-20260715`) — no longer does, which is what made the
// S42/S24 ticket classes unsubmittable. It stays ANCHORED so a
// value that merely CONTAINS a long run (an ssh public key, a long ARN) is not
// newly over-masked.
const LONG_TOKEN = /^[A-Za-z0-9+/=]{24,}$/;

/** FNV-1a 32-bit → 8 hex. A stable, non-reversible pointer, NOT cryptographic. */
function stableTag(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function masked(inner: string): string {
  return `«redacted:${stableTag(inner)}»`;
}

function isAllowlisted(value: string): boolean {
  return ALLOW_PREFIXES.some((p) => value.startsWith(p));
}

/** True when a bare string value looks like a credential worth masking.
 * attrName (when known) lets a bare GUID in an `*_id`/`*_ids` attribute pass as
 * an IDENTIFIER (Azure tenant/subscription/object ids) — the name rule for
 * secret-bearing attributes (client_secret, …) has already fired before this
 * shape check, so this cannot unmask a named secret. */
export function looksLikeSecret(value: string, attrName?: string): boolean {
  if (isAllowlisted(value)) return false;
  if (UUID.test(value)) {
    const n = attrName?.toLowerCase() ?? '';
    return !(n.endsWith('_id') || n.endsWith('_ids'));
  }
  return LONG_TOKEN.test(value) && /[A-Za-z]/.test(value) && /[0-9]/.test(value);
}

/** Mask quoted string literals on the RHS of an assignment. Idempotent: an
 * already-masked value is left alone, so redactHcl(redactHcl(x)) === redactHcl(x).
 * attrName is the attribute this RHS belongs to (when known) — threaded through to
 * looksLikeSecret so the `*_id`/`*_ids` GUID-identifier exception can apply. */
function maskRhs(rhs: string, maskAll: boolean, attrName?: string): string {
  return rhs.replace(/"((?:[^"\\]|\\.)*)"/g, (whole, inner: string) => {
    if (inner.startsWith('«redacted:')) return whole;
    if (maskAll || looksLikeSecret(inner, attrName)) return `"${masked(inner)}"`;
    return whole;
  });
}

/**
 * JSON-syntax counterpart of {@link redactHcl}, for `.tf.json` resource bodies
 * (extract-blocks.ts renders those as view-only pretty-printed JSON — the
 * line-based HCL rules above never match JSON's `"key": "value"` shape). Walks
 * a PARSED JSON value and masks string values by the same three rules: a
 * secret-named attribute's value, every value inside a secret-bearing block
 * (e.g. lambda `environment`), and any bare string that looks like a
 * credential. Same mask (`«redacted:<8hex>»`), same idempotency guarantee —
 * an already-masked value is left alone, so running it twice changes nothing.
 */
export function redactTfJson(value: unknown, maskAll = false): unknown {
  if (typeof value === 'string') {
    if (value.startsWith('«redacted:')) return value;
    return maskAll || looksLikeSecret(value) ? masked(value) : value;
  }
  if (Array.isArray(value)) {
    return value.map((v) => redactTfJson(v, maskAll));
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = redactTfJson(v, maskAll || isSecretAttrName(k) || MASK_BLOCKS.has(k.toLowerCase()));
    }
    return out;
  }
  return value;
}

const ASSIGN = /^(\s*[+\-~]?\s*)([A-Za-z0-9_.-]+)(\s*=\s*)(.*)$/;
const BLOCK_OPEN = /^\s*[+\-~]?\s*([A-Za-z0-9_.-]+)(?:\s+"[^"]*")*\s*(?:=\s*)?\{\s*$/;

export interface RedactOptions {
  /** Extra attribute names to treat as secret (e.g. from a provider-schema
   * `sensitive:true` map or manifest params flagged sensitive). */
  sensitiveAttrs?: string[];
  /** Attribute names whose value is a MANIFEST CONSTANT, not request input
   * (role:"const" params — e.g. `http_tokens = "required"`, the IMDSv2
   * guardrail). The attribute-NAME rule is skipped for these so a
   * machine-checkable guardrail stays visible in the review artifact; the
   * value-shape rule (looksLikeSecret) still applies, and an attr also named
   * in sensitiveAttrs stays masked — sensitive wins. */
  neverMaskAttrs?: string[];
}

/** Redact secrets from a block of HCL text. Line-based and deterministic. */
export function redactHcl(text: string, opts: RedactOptions = {}): string {
  const extra = new Set((opts.sensitiveAttrs ?? []).map((s) => s.toLowerCase()));
  const neverMask = new Set(
    (opts.neverMaskAttrs ?? []).map((s) => s.toLowerCase()).filter((s) => !extra.has(s)),
  );
  // Stack of block names by brace depth, so we know when we are inside a
  // secret-bearing block at any nesting level.
  const blockStack: string[] = [];
  const inMaskBlock = (): boolean => blockStack.some((b) => MASK_BLOCKS.has(b));

  const out = text.split('\n').map((line) => {
    const open = BLOCK_OPEN.exec(line);
    if (open) {
      blockStack.push(open[1]!.toLowerCase());
      return line;
    }
    // A line that closes a block (only when it is purely a closing brace).
    if (/^\s*\}\s*$/.test(line)) {
      blockStack.pop();
      return line;
    }

    const m = ASSIGN.exec(line);
    if (!m) return line;
    const [, prefix, key, eq, rhs] = m;
    const keyLc = key!.toLowerCase();
    const maskAll = (isSecretName(keyLc, extra) && !neverMask.has(keyLc)) || inMaskBlock();
    // If the RHS opens a nested block on the same line, track it too.
    if (/\{\s*$/.test(rhs!)) blockStack.push(keyLc);
    return `${prefix}${key}${eq}${maskRhs(rhs!, maskAll, keyLc)}`;
  });

  return out.join('\n');
}
