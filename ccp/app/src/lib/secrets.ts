import type { ManifestParam } from '@/types';
import { isSecretAttrName, looksLikeSecret } from '@/lib/redact';

export { looksLikeSecret } from '@/lib/redact';

/** The real HCL attribute a param maps to (strip the new_/target_ prefix). */
function attrOf(name: string): string {
  return name.replace(/^new_/, '').replace(/^target_/, '');
}

/**
 * A parameter that carries a secret value: either explicitly
 * flagged `sensitive` in the manifest, or whose name reads as secret-bearing
 * (token / password / psk / api_key …). Sensitive params render as masked
 * inputs and their values are redacted in every rendered surface; non-sensitive
 * free-text params are blocked from accepting secret-shaped values at submit.
 */
export function isSensitiveParam(param: ManifestParam): boolean {
  return param.sensitive === true || isSecretAttrName(attrOf(param.name)) || isSecretAttrName(param.name);
}

/**
 * Reason a value must be rejected on a NON-sensitive free-text field, or null.
 * Guides the L1 to the safe pattern (store in Secrets Manager, reference it)
 * instead of pasting a credential into the change request.
 */
export function pastedSecretError(param: ManifestParam, value: unknown): string | null {
  if (isSensitiveParam(param)) return null; // sensitive fields legitimately hold secrets
  if (param.type !== 'string' || param.source === 'inventory') return null;
  if (typeof value !== 'string' || value === '') return null;
  // A value the manifest itself constrains cannot be a pasted credential:
  //   (a) an allowlist member is a manifest constant the operator merely picked
  //       (S42's `ELBSecurityPolicy-TLS13-1-2-2021-06`), and
  //   (b) a value matching the param's declared `pattern` is exactly the shape the
  //       field asks for (S24's dated snapshot id `pre-release-app-db01-20260715`) —
  //       a real high-entropy token is never declared as a field's expected input.
  // These recover the two drill ticket classes without weakening
  // detection on free-text fields, where neither guard applies and the (tightened)
  // looksLikeSecret still rejects an actual token / the lambda API_TOKEN class.
  if (param.bounds?.allowlist?.some((a) => String(a) === value)) return null;
  if (param.bounds?.pattern && matchesPattern(param.bounds.pattern, value)) return null;
  if (!looksLikeSecret(value)) return null;
  return (
    'This looks like a credential. Don’t paste secrets into a change request — store it in ' +
    'AWS Secrets Manager or SSM Parameter Store and reference it by name instead.'
  );
}

/** Test a manifest-authored (already-anchored) pattern against a value, treating an
 * un-compilable pattern as "no match" (fail-closed to the secret heuristic). */
function matchesPattern(pattern: string, value: string): boolean {
  try {
    return new RegExp(pattern).test(value);
  } catch {
    return false;
  }
}
