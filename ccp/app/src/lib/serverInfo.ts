/**
 * The server-info contract, split into its own dependency-free module so both
 * clients (lib/api's mock, lib/httpApi's HTTP client) can import it without a cycle.
 *
 * Which governed WRITE flows the answering backend actually SERVES — persists and
 * enforces as its own record. This replaces the single `authoritative` boolean.
 * That flag armed every gated admin control at once the moment a real
 * API answered `authoritative:true` — including admin writes the app still parks in
 * localStorage the server never reads. An inverted honesty gate: a control that
 * LOOKS enforced but isn't is worse than no gate. A per-flow flag lets a control go
 * live the instant ITS endpoint lands, and not a moment sooner.
 */

export type ServerFlow =
  'users' | 'teams' | 'policy' | 'risk' | 'projects' | 'audit' | 'settings' | 'pendingChanges';

/** Every gate-able admin write flow, in one place so a completeness test can pin it. */
export const SERVER_FLOWS: readonly ServerFlow[] = [
  'users',
  'teams',
  'policy',
  'risk',
  'projects',
  'audit',
  'settings',
  'pendingChanges',
];

export type ServerCapabilities = Record<ServerFlow, boolean>;

/**
 * No flow served — the honest default, the mock's permanent answer (its stores are
 * client-forgeable, never a source of truth), and the safe pre-load state every
 * consumer starts from (see components/AdvisoryGate's INITIAL_SERVER_INFO_STATE).
 * The HTTP client (lib/httpApi) spreads this and flips a flag to true ONLY for a
 * flow it actually carries a working method for AND ccp-api serves
 * (audit/teams/users) — every flow still parked in localStorage the server never
 * reads (policy/risk/projects/settings/pendingChanges) stays false. That flip lives
 * IN the client's own `serverInfo()` (lib/httpApi.ts) — the single place the app's
 * honesty about admin authority is declared.
 */
export function noCapabilities(): ServerCapabilities {
  return {
    users: false,
    teams: false,
    policy: false,
    risk: false,
    projects: false,
    audit: false,
    settings: false,
    pendingChanges: false,
  };
}

/**
 * Which backend is answering, and — per governed write flow — whether it is the
 * source of truth. The app gates every
 * admin write control on the flag for ITS flow: a control may render live only when
 * its write actually reaches the server.
 */
export interface ServerInfo {
  mode: 'mock' | 'api';
  capabilities: ServerCapabilities;
}
