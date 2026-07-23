import type {
  ChangeRequest,
  Exposure,
  Inventory,
  ManifestOperation,
  ManifestParam,
  RequestEvent,
  ServiceManifest,
} from '@/types';
import { checkBounds } from './validation';
import { isParamActive, stripInactiveParams } from './dependsOn';
import { pastedSecretError } from '@/lib/secrets';
import { resolveRisk } from '@/lib/riskOverrides';
import { narrowAllowlist } from '@/lib/settings';
import { readRepeatedInstances, repeatedBlockValid } from '@/lib/catalog';
import { SYSTEM_OPERATIONS } from '@/lib/systemOps';

/**
 * The deterministic interpreter. Pure functions over the module manifests
 * and the inventory — NO model, NO network. This is what lets the frontend
 * "stand as interpreter" with an LLM fully disconnected: every available
 * operation, every dropdown, and every validation is a lookup, not an inference.
 */

function resourceTypeOf(resourceTypeOrAddress: string, inventory: Inventory): string {
  if (resourceTypeOrAddress.includes('.')) {
    const res = inventory.resources.find((r) => r.address === resourceTypeOrAddress);
    if (res) return res.resourceType;
  }
  return resourceTypeOrAddress;
}

/** Every operation available for a given resource type (or a concrete address). */
export function availableOperations(
  resourceTypeOrAddress: string,
  manifests: ServiceManifest[],
  inventory: Inventory,
): ManifestOperation[] {
  const rt = resourceTypeOf(resourceTypeOrAddress, inventory);
  return manifests
    .flatMap((m) => m.operations)
    .filter((op) => op.target.resourceType === rt);
}

export function getOperation(
  operationId: string,
  manifests: ServiceManifest[],
): ManifestOperation | undefined {
  for (const m of manifests) {
    const found = m.operations.find((op) => op.id === operationId);
    if (found) return found;
  }
  // The drift system ops are estate-generic and NOT part of any manifest
  // file — resolvable regardless of which manifest set was passed/injected,
  // exactly like the api's own getOperation (ccp/api/src/manifests.ts).
  // They are never listed by availableOperations() above (no resource
  // console ever offers them as a pickable action) — only resolvable by id,
  // for a request that already names one.
  return SYSTEM_OPERATIONS.find((op) => op.id === operationId);
}

/**
 * Parse an `inventory://<resourceType>/<field>` enum source into its parts —
 * the ONE place the URI convention is decoded (InventoryPicker's
 * data layer used to re-parse it independently; both now call this). Returns
 * null for a non-inventory source. `field` defaults to `address`.
 */
export function parseInventoryEnum(
  enumSource: string | undefined,
): { type: string; field: string } | null {
  if (!enumSource || !enumSource.startsWith('inventory://')) return null;
  const spec = enumSource.slice('inventory://'.length);
  const slash = spec.indexOf('/');
  return {
    type: slash >= 0 ? spec.slice(0, slash) : spec,
    field: slash >= 0 ? spec.slice(slash + 1) : 'address',
  };
}

/**
 * Resolve the allowed values for a parameter — inventory-driven dropdowns
 * (enumSource `inventory://<resourceType>/<field>`) or a static allowlist.
 *
 * Attribute-mode sources (`field` other than `address`) are DEDUPLICATED in
 * first-occurrence order: `inventory://aws_instance/
 * iam_instance_profile` yields one row per distinct profile in use, not one
 * per instance. Address mode is untouched — addresses are unique by
 * construction and existing pickers keep their exact option order.
 *
 * When `operationId` is supplied, a static allowlist is narrowed by any admin
 * override for that op+param: L1 only ever sees the currently-permitted
 * subset. Omitting it returns the raw manifest allowlist.
 */
export function resolveEnum(
  param: ManifestParam,
  inventory: Inventory,
  operationId?: string,
): string[] {
  const src = parseInventoryEnum(param.enumSource);
  if (src) {
    const values = inventory.resources
      .filter((r) => r.resourceType === src.type)
      .map((r) => (src.field === 'address' ? r.address : String(r.attributes[src.field] ?? '')))
      .filter((v) => v !== '');
    return src.field === 'address' ? values : [...new Set(values)];
  }
  if (param.bounds?.allowlist) {
    const base = param.bounds.allowlist.map((a) => String(a));
    return operationId ? narrowAllowlist(operationId, param.name, base) : base;
  }
  return [];
}

export interface ValidationResult {
  ok: boolean;
  errors: Record<string, string>;
}

/** Validate a full parameter set against an operation's bounds. Deterministic. */
export function validateParams(
  op: ManifestOperation,
  params: Record<string, unknown>,
  inventory: Inventory,
): ValidationResult {
  const errors: Record<string, string> = {};
  const targetParam = op.params.find((p) => p.source === 'inventory');
  const targetAddress = targetParam ? String(params[targetParam.name] ?? '') : '';
  const targetResource = inventory.resources.find((r) => r.address === targetAddress);

  for (const p of op.params) {
    // An inactive dependsOn param neither requires nor validates:
    // the same isParamActive gate SchemaForm renders by and ccp-api's
    // validateParams enforces (one predicate, lib/dependsOn.ts).
    if (!isParamActive(p, params)) continue;
    const v = params[p.name];
    const empty =
      v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
    if (p.required && empty) {
      errors[p.name] = `${p.label} is required`;
      continue;
    }
    if (empty) continue;

    // A REPEATED nested block validates by instance COUNT (bounds.minItems/
    // maxItems, reused) then per-instance sub-field bounds — NOT the generic
    // scalar/list checkBounds below, which would misread the array-of-records as
    // a list of maps. One aggregated error lands on the param key; the field
    // surfaces the specific sub-field errors inline (repeatedInstanceErrors is
    // the one shared law both sides run).
    if (p.repeated) {
      const rows = readRepeatedInstances(v);
      const b = p.bounds;
      if (b?.minItems !== undefined && rows.length < b.minItems) {
        errors[p.name] =
          `${p.label} needs at least ${b.minItems} ${b.minItems === 1 ? 'entry' : 'entries'}`;
      } else if (b?.maxItems !== undefined && rows.length > b.maxItems) {
        errors[p.name] =
          `${p.label} allows at most ${b.maxItems} ${b.maxItems === 1 ? 'entry' : 'entries'}`;
      } else if (!repeatedBlockValid(p.repeated, rows)) {
        errors[p.name] = `${p.label}: one or more entries need attention`;
      }
      continue;
    }

    let current: number | undefined;
    if (p.bounds?.growOnly && targetResource) {
      const attrKey = p.name.replace(/^new_/, '');
      const cur = targetResource.attributes[attrKey];
      if (typeof cur === 'number') current = cur;
    }
    const err = checkBounds(p, v, current);
    if (err) {
      errors[p.name] = err;
      continue;
    }
    // Enforce any admin narrowing of a static allowlist here too — not just
    // in the picker. A value can be manifest-valid yet currently restricted by a
    // leader; the form hides it, but the authoritative check must also reject it.
    if (p.bounds?.allowlist) {
      const base = p.bounds.allowlist.map((a) => String(a));
      const permitted = narrowAllowlist(op.id, p.name, base);
      if (permitted.length < base.length && !permitted.includes(String(v))) {
        errors[p.name] =
          `${p.label} is currently restricted by an admin to: ${permitted.join(', ') || '(none)'}`;
        continue;
      }
    }
    // Never let a credential be pasted into a non-sensitive field.
    const secretErr = pastedSecretError(p, v);
    if (secretErr) errors[p.name] = secretErr;
  }

  return { ok: Object.keys(errors).length === 0, errors };
}

/** How the change is reviewed (approval COUNT is risk-based and shown separately). */
export function exposureLabel(e: Exposure): string {
  switch (e) {
    case 'l1_self_service':
      return 'Self-service change — bounded and low blast radius';
    case 'l1_with_guardrails':
      return 'Guardrailed change — extra care (security / stateful / downtime)';
    case 'engineer_only':
      return 'An engineer authors the Terraform and reviews it';
    default:
      return e;
  }
}

/** Assemble a DRAFT ChangeRequest from a validated operation + params. */
export function buildRequestDraft(
  op: ManifestOperation,
  targetAddress: string,
  params: Record<string, unknown>,
  justification: string,
  requester: string,
): ChangeRequest {
  const now = new Date().toISOString();
  const events: RequestEvent[] = [
    { at: now, type: 'created', label: 'Request drafted in the portal', actor: requester },
  ];
  return {
    id: crypto.randomUUID(),
    requester,
    service: op.service,
    operationId: op.id,
    macd: op.macd,
    targetAddress,
    // Hidden-field hygiene: values whose param is inactive (stale
    // defaults, leftovers from a controller change) never reach the stored
    // request or the pinned artifact.
    params: stripInactiveParams(op.params, params),
    justification,
    exposure: op.exposure,
    risk: resolveRisk(op),
    status: 'DRAFT',
    createdAt: now,
    updatedAt: now,
    events,
  };
}
