import type { ManifestParam } from '@/types';

/**
 * The ONE conditional-visibility predicate.
 *
 * A param with `dependsOn` is ACTIVE only while its controlling param's
 * current value satisfies the condition; while inactive it is not rendered,
 * never required, its bounds are not applied, and its value is stripped from
 * the submitted request. This module is imported by BOTH the SPA
 * (SchemaForm render + interpreter.validateParams + buildRequestDraft) and
 * ccp-api (`@app-lib/dependsOn` in src/manifests.ts validateParams), so
 * the client can never show a rule the server does not enforce, and the
 * server never demands a field the form deliberately hid — one predicate,
 * zero drift. Pure and deterministic: string-canonical comparison
 * over the submitted values, no I/O.
 *
 * Semantics (documented on types/manifest.ts ParamCondition):
 *   - `equals`:    active ⇔ String(controller) === String(equals)
 *   - `notEquals`: active ⇔ controller is NON-EMPTY and differs — an unset
 *     controller deactivates the dependent under both operators (fail-closed
 *     to hidden; a blank protocol never reveals port fields).
 *   - no dependsOn ⇒ always active (pre-existing behavior exactly).
 */

function isEmpty(v: unknown): boolean {
  return v === undefined || v === null || v === '';
}

/** True while `param` should render and validate, given the current values. */
export function isParamActive(
  param: Pick<ManifestParam, 'dependsOn'>,
  values: Record<string, unknown>,
): boolean {
  const cond = param.dependsOn;
  if (!cond) return true;
  const controller = values[cond.param];
  if (isEmpty(controller)) return false;
  if (cond.equals !== undefined) return String(controller) === String(cond.equals);
  if (cond.notEquals !== undefined) return String(controller) !== String(cond.notEquals);
  // A condition with neither operator cannot validate (zod refuses it at
  // load); treat it as never-active so a malformed manifest fails closed.
  return false;
}

/**
 * The submit-side twin of the render gate: drop every value whose param is
 * currently inactive, so hidden-field values (stale defaults, values left
 * behind by a controller change) never reach the stored request or the pinned
 * artifact. Keys that do not correspond to a declared param pass through
 * unchanged (pre-existing behavior for the target address and shell fields).
 */
export function stripInactiveParams(
  params: Pick<ManifestParam, 'name' | 'dependsOn'>[],
  values: Record<string, unknown>,
): Record<string, unknown> {
  const inactive = new Set(
    params.filter((p) => !isParamActive(p, values)).map((p) => p.name),
  );
  if (inactive.size === 0) return values;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(values)) {
    if (!inactive.has(k)) out[k] = v;
  }
  return out;
}
