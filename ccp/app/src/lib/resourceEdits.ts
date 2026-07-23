import type { Capability } from '@/lib/resourceDetail';
import {
  currentControlValue,
  displayChoice,
  displayCurrent,
  fieldLabelFor,
} from '@/lib/resourceDetail';

/**
 * The resource detail page's pending-changes cart — a pure, client-side reducer.
 * One edit per capability (keyed by op id); an edit that lands back on the
 * current value removes itself, so the cart only ever holds real deltas. This is
 * the page-local basket the "Review & submit N changes as one request" action
 * reads; it is NOT the admin dual-control store (lib/pendingChanges.ts) — nothing
 * here persists or writes. No DOM, so the cart is unit-testable directly.
 */
export interface PendingEdit {
  /** The operation this edit would run — the cart key (one edit per capability). */
  opId: string;
  service: string;
  /** The resource the change is scoped to. */
  targetAddress: string;
  /** Plain operator label for the changed field ("Type", "Backup retention"). */
  fieldLabel: string;
  /** The op headline, for the cart row's title line. */
  opHeadline: string;
  /** The Terraform attribute changed, when the op names a scalar one. */
  attr?: string;
  /** The value param name — what a request would carry as the new value. */
  paramName: string;
  /** Canonical control string of the new value (what a request submits). */
  nextValue: string;
  /**
   * The FULL submittable params for this edit's op — the value param coerced to its
   * manifest type (number/bool/string) plus the inventory target param bound to
   * `targetAddress`. This is exactly what a single-op request form would send, prebuilt so
   * the change-set submit (Phase B) needs no second interpreter pass. Same shape the server
   * re-validates against the manifest bounds.
   */
  params: Record<string, unknown>;
  /** Display of the current value ("c5.xlarge", "Yes", "—"). */
  currentDisplay: string;
  /** Display of the new value, in the same vocabulary as currentDisplay. */
  nextDisplay: string;
  /** True when applying this rebuilds the resource (new id, brief outage). */
  forcesReplace: boolean;
  /** The op's review exposure — carried so the combined change-set requirement preview can
   * compute the strictest tier without re-loading the manifest. */
  exposure: Capability['exposure'];
}

/** Coerce a control's canonical string to the value param's manifest type — the same
 * number/bool/string shape a single-op form submits, so the server's per-type bounds apply
 * identically. Unknown/text types pass through as the trimmed string. */
function coerceValue(param: Capability['valueParam'], value: string): unknown {
  if (!param) return value;
  if (param.type === 'number') {
    const n = Number(value);
    return Number.isNaN(n) ? value : n;
  }
  if (param.type === 'bool') return value === 'true';
  return value;
}

/**
 * Build the pending edit for a capability given the operator's chosen control
 * value. Returns null when the choice equals the current value or is empty —
 * there is nothing to submit, so nothing enters the cart.
 */
export function editFor(
  cap: Capability,
  targetAddress: string,
  chosen: string,
): PendingEdit | null {
  const next = chosen.trim();
  if (next === '') return null;
  if (next === currentControlValue(cap)) return null;
  if (!cap.valueParam) return null;
  // Prebuild the full submittable params: the value param (coerced to its manifest type) +
  // the inventory target param bound to this resource — exactly what a single-op form sends.
  const targetParam = cap.op.params.find((p) => p.source === 'inventory');
  const params: Record<string, unknown> = { [cap.valueParam.name]: coerceValue(cap.valueParam, next) };
  if (targetParam) params[targetParam.name] = targetAddress;
  return {
    opId: cap.op.id,
    service: cap.op.service,
    targetAddress,
    fieldLabel: fieldLabelFor(cap),
    opHeadline: cap.headline,
    attr: cap.attr,
    paramName: cap.valueParam.name,
    nextValue: next,
    params,
    currentDisplay: displayCurrent(cap),
    nextDisplay: displayChoice(cap, next),
    forcesReplace: cap.forcesReplace,
    exposure: cap.exposure,
  };
}

/**
 * Upsert an edit into the cart, keyed by op id (a second change to the same
 * capability replaces the first — never a duplicate row). Order is stable:
 * a replaced edit keeps its position; a new one appends.
 */
export function upsertEdit(cart: PendingEdit[], edit: PendingEdit): PendingEdit[] {
  const idx = cart.findIndex((e) => e.opId === edit.opId);
  if (idx === -1) return [...cart, edit];
  const next = cart.slice();
  next[idx] = edit;
  return next;
}

/** Remove a capability's edit from the cart (a no-op when it isn't there). */
export function removeEdit(cart: PendingEdit[], opId: string): PendingEdit[] {
  return cart.filter((e) => e.opId !== opId);
}

/**
 * Apply a control change: upsert a real delta, or drop the capability's edit
 * when the value returned to current / was cleared ({@link editFor} → null).
 * The single entry point the control's onChange calls.
 */
export function applyChoice(
  cart: PendingEdit[],
  cap: Capability,
  targetAddress: string,
  chosen: string,
): PendingEdit[] {
  const edit = editFor(cap, targetAddress, chosen);
  if (edit === null) return removeEdit(cart, cap.op.id);
  return upsertEdit(cart, edit);
}

/** Whether any pending edit rebuilds its resource — drives the cart's warning. */
export function cartHasRebuild(cart: PendingEdit[]): boolean {
  return cart.some((e) => e.forcesReplace);
}

/** One-line before→after summary of an edit ("Type: c5.xlarge → t3.large"). */
export function editLine(edit: PendingEdit): string {
  return `${edit.fieldLabel}: ${edit.currentDisplay} → ${edit.nextDisplay}`;
}
