import type { ManifestParam } from '@/types';

/**
 * Deterministic bounds checking — no model, no I/O. Given one manifest
 * parameter and a value (and, for grow-only params, the current value),
 * return a human-readable error message, or null if the value is in bounds.
 *
 * This is the client+server-shared "law": the same function runs in the
 * browser for live feedback and (conceptually) in ccp-api on submit.
 */
const RFC1918: { base: [number, number, number, number]; bits: number }[] = [
  { base: [10, 0, 0, 0], bits: 8 },
  { base: [172, 16, 0, 0], bits: 12 },
  { base: [192, 168, 0, 0], bits: 16 },
];

function ipToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    n = n * 256 + octet;
  }
  return n >>> 0;
}

/** True only for a CIDR wholly inside an RFC1918 private block (and never 0.0.0.0/0). */
export function isInternalCidr(cidr: string): boolean {
  const trimmed = cidr.trim();
  if (trimmed === '0.0.0.0/0' || trimmed === '::/0') return false;
  const slash = trimmed.indexOf('/');
  if (slash < 0) return false;
  const ip = trimmed.slice(0, slash);
  const mask = Number(trimmed.slice(slash + 1));
  if (!Number.isInteger(mask) || mask < 0 || mask > 32) return false;
  const ipInt = ipToInt(ip);
  if (ipInt === null) return false;
  return RFC1918.some(({ base, bits }) => {
    if (mask < bits) return false; // a block broader than the private range escapes it
    const baseInt = ((base[0] << 24) | (base[1] << 16) | (base[2] << 8) | base[3]) >>> 0;
    const shift = 32 - bits;
    return ipInt >>> shift === baseInt >>> shift;
  });
}

export function checkBounds(
  param: ManifestParam,
  value: unknown,
  currentValue?: number,
): string | null {
  const b = param.bounds;
  if (!b) return null;

  // List values (the multi-select picker submits real arrays):
  // item-count bounds on the array, then every scalar bound applied per item —
  // the same shape ccp-api's paramOutOfBounds enforces, so the form never
  // accepts a list the server would refuse.
  if (Array.isArray(value)) {
    if (b.minItems !== undefined && value.length < b.minItems) {
      return `${param.label} needs at least ${b.minItems} ${b.minItems === 1 ? 'entry' : 'entries'}`;
    }
    if (b.maxItems !== undefined && value.length > b.maxItems) {
      return `${param.label} allows at most ${b.maxItems} ${b.maxItems === 1 ? 'entry' : 'entries'}`;
    }
    for (const item of value) {
      const itemErr = checkBounds(
        { ...param, type: param.type === 'list' ? 'string' : param.type },
        item,
        currentValue,
      );
      if (itemErr) return itemErr;
    }
    return null;
  }

  // Map values (a tag map / parameter map): the picker submits a real object.
  // Apply the scalar bounds to every KEY and VALUE independently — never to
  // String(object), which is "[object Object]" and fails any real pattern,
  // rejecting all input. The array branch already returned, so any object here
  // is a map. Server twin: paramOutOfBounds in ccp-api.
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (b.minItems !== undefined && entries.length < b.minItems) {
      return `${param.label} needs at least ${b.minItems} ${b.minItems === 1 ? 'entry' : 'entries'}`;
    }
    if (b.maxItems !== undefined && entries.length > b.maxItems) {
      return `${param.label} allows at most ${b.maxItems} ${b.maxItems === 1 ? 'entry' : 'entries'}`;
    }
    const scalar = { ...param, type: 'string' as const };
    for (const [k, v] of entries) {
      if (checkBounds(scalar, k, currentValue))
        return `${param.label}: key “${k}” has an invalid format`;
      if (checkBounds(scalar, v, currentValue))
        return `${param.label}: value for “${k}” has an invalid format`;
    }
    // Azure tag names are case-insensitive: two keys that case-fold to the same name
    // (e.g. "Owner" and "owner") collide in Azure and would silently become one tag.
    // The catalogctl executor refuses this (TAG_KEY_CASE_COLLISION); catch it at the
    // form/server too so the user sees it before submit, not at apply.
    if (b.semantic === 'azure_tag_map') {
      const foldToKey = new Map<string, string>();
      for (const [k] of entries) {
        const fold = k.toLowerCase();
        const prior = foldToKey.get(fold);
        if (prior !== undefined && prior !== k)
          return `${param.label}: “${prior}” and “${k}” are the same Azure tag (names are case-insensitive)`;
        foldToKey.set(fold, k);
      }
    }
    return null;
  }

  if (b.allowlist) {
    const ok = b.allowlist.some((a) => String(a) === String(value));
    if (!ok) return `${param.label} must be one of: ${b.allowlist.join(', ')}`;
  }

  if (param.type === 'number') {
    const num = Number(value);
    if (Number.isNaN(num)) return `${param.label} must be a number`;
    if (b.min !== undefined && num < b.min) return `${param.label} must be ≥ ${b.min}`;
    if (b.max !== undefined && num > b.max) return `${param.label} must be ≤ ${b.max}`;
    if (b.growOnly && currentValue !== undefined && num <= currentValue) {
      return `${param.label} must be greater than the current value (${currentValue}) — this change is grow-only`;
    }
  }

  if (b.pattern) {
    let re: RegExp;
    try {
      re = new RegExp(b.pattern);
    } catch {
      return null; // a bad pattern in the manifest is a manifest bug, not a user error
    }
    if (!re.test(String(value))) return `${param.label} has an invalid format`;
  }

  if (b.semantic && /cidr/i.test(b.semantic)) {
    if (!isInternalCidr(String(value))) {
      return `${param.label} must be an internal RFC1918 CIDR (no public range, no 0.0.0.0/0)`;
    }
  }

  return null;
}
