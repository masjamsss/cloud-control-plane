import { useEffect, useState } from 'react';
import { authClient } from '@/lib/api';
import { useServerInfo } from '@/components/AdvisoryGate';
import { useSettings } from '@/lib/settings';
import { loadSettingsVia, type SettingsView } from '@/features/admin/settingsFlow';

/**
 * FE-6 — the settings a submit gate (and its live "frozen"/"disabled"
 * preview) should actually trust.
 *
 * `RequestForm`/`BulkRequestForm`/`ResourceDetail`'s submit gates read
 * `lib/settings.ts`'s advisory, project-scoped localStorage store — the exact
 * thing it is: a local mirror, never written to by the server, and in api
 * mode never written to by anything at all outside `SettingsAdmin`'s own
 * ADVISORY branch (which only runs while `!authoritative`, settingsFlow.ts).
 * In api mode the actual freeze/disabled-ops truth lives server-side
 * (`freeze.global` / `catalog.disabled-ops`, read+written authoritatively
 * only through `SettingsAdmin` via `settingsFlow.ts`), and is never mirrored
 * back into the local store. Reading the local store in that mode is wrong in
 * both directions: the server can be frozen while the local store stays
 * clean (the "live" preview never fires, and the requester only learns at
 * submit via the server's own FROZEN rejection), or the local store can carry
 * a stale `changeFreeze`/disabled-op flag (left over from mock use on the
 * same origin, or any other write to the project's settings key) that
 * silently blocks a submit the server would have allowed, without ever
 * asking the server.
 *
 * This hook is `settingsFlow.ts`'s existing authoritative/advisory split
 * (already proven in `SettingsAdmin.tsx`) applied to the READ side of a
 * submit gate: `can('settings')` decides which source is trusted, exactly
 * the same per-flow honesty test `useServerInfo`/`AdvisoryControl` already
 * apply to every other server-backed admin control (components/AdvisoryGate.tsx).
 *
 *  - Authoritative (api mode, this deployment serves `settings`): the local
 *    store is never consulted. Server settings are fetched once per mount
 *    (the same one-shot-per-mount shape `SettingsAdmin`'s own `refresh`
 *    uses) and default to "nothing blocked" (`changeFreeze:false,
 *    disabledOps:[]`) while that fetch is in flight or if it fails — the
 *    honest default every other advisory-until-proven gate in this app
 *    starts from (`INITIAL_SERVER_INFO_STATE`), and correct either way: this
 *    is a UX pre-check only, never the actual authority. The real submit
 *    still goes to the server, which enforces the freeze/disabled-op rule
 *    regardless of what this hook returns, and a submit that slips through a
 *    stale "not blocked" moment is caught there.
 *  - Advisory (mock mode, or an authoritative deployment that has not yet
 *    resolved `serverInfo()`... though in api mode `settings` is always
 *    served once resolved, so this branch is effectively mock-only in
 *    practice): the exact pre-existing behavior — the live, subscribed local
 *    store.
 */
export interface EffectiveSettings {
  changeFreeze: boolean;
  disabledOps: string[];
}

/** The honest default while an authoritative fetch is in flight or unresolved
 * — see the "Authoritative" bullet above for why "nothing blocked" is the
 * correct default rather than fail-closed-to-frozen. */
export const NOTHING_BLOCKED: EffectiveSettings = { changeFreeze: false, disabledOps: [] };

/**
 * Pure: which of the two sources a gate should trust, given the resolved
 * inputs. Split out from {@link useEffectiveSettings} so the actual
 * decision — server wins outright when authoritative, local otherwise — is
 * unit-testable without mounting a component (this repo has no jsdom; see
 * `useServerInfo`/`serverInfoToState`'s identical split in
 * components/AdvisoryGate.tsx).
 */
export function deriveEffectiveSettings(
  authoritative: boolean,
  local: EffectiveSettings,
  server: SettingsView | null,
): EffectiveSettings {
  if (!authoritative) return local;
  if (!server) return NOTHING_BLOCKED;
  return { changeFreeze: server.changeFreeze, disabledOps: server.disabledOps };
}

export function useEffectiveSettings(): EffectiveSettings {
  const { can } = useServerInfo();
  const authoritative = can('settings');
  const local = useSettings();
  const [server, setServer] = useState<SettingsView | null>(null);

  useEffect(() => {
    if (!authoritative) {
      setServer(null);
      return;
    }
    let alive = true;
    void loadSettingsVia(true, authClient).then((view) => {
      if (alive) setServer(view);
    });
    return () => {
      alive = false;
    };
  }, [authoritative]);

  return deriveEffectiveSettings(authoritative, local, server);
}
