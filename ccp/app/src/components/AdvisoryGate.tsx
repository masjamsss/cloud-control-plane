import { useEffect, useState, type ReactNode } from 'react';
import type { JSX } from 'react';
import { api } from '@/lib/api';
import { isApiMode } from '@/lib/apiSession';
import {
  noCapabilities,
  type ServerCapabilities,
  type ServerFlow,
  type ServerInfo,
} from '@/lib/serverInfo';
import './AdvisoryGate.css';

/**
 * The arming rule: every admin write control renders DARK — visibly present
 * but disabled — until
 * the answering backend actually SERVES its flow. `serverInfo()` reports that
 * per-flow (lib/serverInfo); this module is the reusable wrapper that reads it and
 * enforces the rule mechanically, so an admin sees the full control set without
 * ever forging authority the backend doesn't yet enforce. A single blanket
 * `authoritative` bit used to arm every gated control at once — including writes
 * that only ever reached localStorage — which is worse than no gate; the per-flow
 * flag fixes exactly that.
 */

/** Exact advisory string — exported as a constant so every render uses the same
 * literal, and as a pure function so a test can assert it can't drift. Plain
 * one-line copy: it explains why a control is inert without any demo-/connect-the-backend
 * nag (the operator ships live and wants no such prompt anywhere). */
export const ADVISORY_NOTE = 'This control is inactive until the server enforces it';

export function advisoryNote(): string {
  return ADVISORY_NOTE;
}

/**
 * Which backend this build is wired to — the SAME static fact `lib/api` picks
 * its client by (`VITE_API_BASE` set → the HTTP client), so it can never
 * disagree with `api.serverInfo().mode`. A CONSTANT rather than part of the
 * async hook state on purpose: mock-vs-api is knowable synchronously, so a
 * mode-dependent branch never flashes the wrong posture while `serverInfo()`
 * resolves (and a server-string render — this repo's whole component-testing
 * story — sees the real branch, not a loading stand-in).
 */
export const SERVER_MODE: 'mock' | 'api' = isApiMode ? 'api' : 'mock';

export interface ServerInfoState {
  capabilities: ServerCapabilities;
  loading: boolean;
}

/** The safe default: no flow served until proven otherwise, so a control gated on
 * this never flashes armed before the real answer lands. */
export const INITIAL_SERVER_INFO_STATE: ServerInfoState = {
  capabilities: noCapabilities(),
  loading: true,
};

/**
 * Pure: how a resolved {@link ServerInfo} maps onto hook state. Split out from
 * {@link useServerInfo} so the resolution logic is unit-testable without
 * mounting a component — this repo's vitest runs in plain Node (no jsdom/
 * testing-library; see test/standalone.test.ts's exact dependency allowlist)
 * and React does not run `useEffect` during a server render either way.
 */
export function serverInfoToState(info: ServerInfo): ServerInfoState {
  return { capabilities: info.capabilities, loading: false };
}

/**
 * May THIS flow's write reach the authoritative backend? False while loading and
 * for any flow the answering backend does not serve — the honest safe default that
 * keeps a localStorage-only control advisory until its own endpoint lands.
 */
export function canServe(state: ServerInfoState, flow: ServerFlow): boolean {
  return state.capabilities[flow] === true;
}

export interface UseServerInfoResult extends ServerInfoState {
  /** Per-flow gate — true only when the answering backend serves this flow. */
  can: (flow: ServerFlow) => boolean;
}

/** Resolves `api.serverInfo()` once and exposes it as render state plus a
 * per-flow {@link canServe} helper bound to it. */
export function useServerInfo(): UseServerInfoResult {
  const [state, setState] = useState<ServerInfoState>(INITIAL_SERVER_INFO_STATE);
  useEffect(() => {
    let alive = true;
    void api.serverInfo().then((info) => {
      if (alive) setState(serverInfoToState(info));
    });
    return () => {
      alive = false;
    };
  }, []);
  return { ...state, can: (flow) => canServe(state, flow) };
}

export interface AdvisoryControlProps {
  authoritative: boolean;
  children: ReactNode;
}

/**
 * The arming wrapper. When `authoritative` is false, children render inside
 * a disabled `<fieldset>` with the exact advisory note directly above them, so
 * the reason the control can't be used is never a mystery. When true, children
 * render bare — the control is fully live.
 */
export function AdvisoryControl({ authoritative, children }: AdvisoryControlProps): JSX.Element {
  if (authoritative) return <>{children}</>;
  return (
    <fieldset disabled className="advisory-gate">
      <p className="advisory-gate__note" role="note">
        {ADVISORY_NOTE}
      </p>
      {children}
    </fieldset>
  );
}

/**
 * A silent disabled wrapper for controls whose disabled reason is already clear
 * from context: same `<fieldset disabled>` dimming as {@link AdvisoryControl},
 * no per-region note repeated. Renders children bare when not disabled.
 */
export function GateFieldset({
  disabled,
  children,
}: {
  disabled: boolean;
  children: ReactNode;
}): JSX.Element {
  if (!disabled) return <>{children}</>;
  return (
    <fieldset disabled className="advisory-gate">
      {children}
    </fieldset>
  );
}

export default AdvisoryControl;
