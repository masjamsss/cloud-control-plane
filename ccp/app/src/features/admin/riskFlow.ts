import type { RiskFloor } from '@/types';
import type { AdminWriteOutcome, HttpApiClient } from '@/lib/httpApi';
import { clearRiskOverride, listRiskOverrides, setRiskOverride } from '@/lib/riskOverrides';
import { getSettings, setOpDisabled } from '@/lib/settings';

/**
 * Activity risk's ADVISORY → AUTHORITATIVE branch (pattern; see
 * teamsFlow.ts). Covers BOTH controls RiskAdmin renders per operation: the
 * risk override (PUT/DELETE /admin/risk/:opId) and the catalog
 * enable/disable toggle (PUT /admin/catalog/:opId — the server's
 * `catalog.disabled-ops` setting). Reads come from GET /admin/risk (the
 * applied-overrides map) + GET /admin/settings (the disabled-ops list), so
 * the page renders the server's persisted truth, never a disconnected
 * localStorage mirror.
 *
 * `authoritative` is always exactly `can('risk')`; `client` is `lib/api`'s
 * `authClient` (null in mock mode). Server writes are dual-controlled:
 * raising risk / disabling an op applies immediately; lowering risk /
 * re-enabling an op returns 202 for a second admin's ack — surfaced as
 * {@link AdminWriteOutcome}. The non-authoritative branch is the exact
 * pre-existing lib/riskOverrides + lib/settings localStorage behavior.
 */

export interface RiskAdminState {
  /** Applied overrides only, keyed by opId — a pending reduction is not an override yet. */
  overrides: Record<string, RiskFloor>;
  disabledOps: string[];
}

/** The local stores' snapshot — synchronous, so a mock build (and a server
 * render) shows overrides/disabled state on first paint, as it always has. */
export function localRiskState(): RiskAdminState {
  return { overrides: listRiskOverrides(), disabledOps: [...getSettings().disabledOps] };
}

export async function loadRiskStateVia(
  authoritative: boolean,
  client: HttpApiClient | null,
): Promise<RiskAdminState> {
  if (authoritative && client) {
    const [overrides, settings] = await Promise.all([
      client.listAdminRiskOverrides(),
      client.getAdminSettings(),
    ]);
    const disabled = settings['catalog.disabled-ops'];
    return {
      overrides,
      disabledOps: Array.isArray(disabled) ? disabled.map(String) : [],
    };
  }
  return localRiskState();
}

/**
 * Set an operation's effective risk. Choosing the manifest floor itself means
 * "no override" → the override is CLEARED (DELETE), exactly the rule
 * RiskAdmin's segmented control has always applied locally; any other choice
 * sets it (PUT).
 */
export async function setRiskVia(
  authoritative: boolean,
  client: HttpApiClient | null,
  op: { id: string; riskFloor: RiskFloor },
  risk: RiskFloor,
): Promise<AdminWriteOutcome> {
  if (authoritative && client) {
    if (risk === op.riskFloor) return client.clearAdminRiskOverride(op.id);
    return client.setAdminRiskOverride(op.id, risk);
  }
  if (risk === op.riskFloor) clearRiskOverride(op.id);
  else setRiskOverride(op.id, risk);
  return { applied: true };
}

/** Explicit reset back to the manifest floor (RiskAdmin's "Reset" button). */
export async function clearRiskVia(
  authoritative: boolean,
  client: HttpApiClient | null,
  opId: string,
): Promise<AdminWriteOutcome> {
  if (authoritative && client) return client.clearAdminRiskOverride(opId);
  clearRiskOverride(opId);
  return { applied: true };
}

export async function setOpEnabledVia(
  authoritative: boolean,
  client: HttpApiClient | null,
  opId: string,
  enabled: boolean,
): Promise<AdminWriteOutcome> {
  if (authoritative && client) return client.setAdminCatalogEnabled(opId, enabled);
  setOpDisabled(opId, !enabled);
  return { applied: true };
}
