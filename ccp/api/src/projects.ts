import type { AccountItem, ProjectItem, RoleBinding, RoleName } from './store/schema';
import { projectCollectionGsi } from './store/schema';
import type { ConfigStore } from './store/configStore';

/**
 * Known projects — STORE-BACKED (the registry is durable), STORE-ONLY (data-birth
 * spec §5/§12 lane A). The synchronous read surface (`isKnownProject`/`knownProjects`)
 * stays sync — it is consulted from middleware and binding validation on every
 * request — over an in-process CACHE of `{CONTROL_SCOPE} ∪ {store projects with
 * status 'ready'}`. There is no baked estate id: a blank install's cache is exactly
 * `{CONTROL_SCOPE}` until an account is registered, trusted, and activated through
 * the real onboarding ladder (or a legacy store is settled — domain/settlement.ts).
 *
 * Fail-closed status rule: only a `ready` project (registered → artifact-uploaded
 * → dual-control-trusted → first data activation acked, or digests recorded) is
 * routable via `x-ccp-project` or valid as an account binding. A
 * draft/pending-trust/trusted project EXISTS in the registry (GET /projects
 * lists it) but grants nothing yet.
 *
 * Hydration: lazy on the first request (`withProject` middleware, which also
 * ensures the one-time legacy settlement has run first — domain/settlement.ts),
 * then explicitly refreshed by every registry write that can change the ready set
 * (routes/projects.ts `complete`, routes/projectData.ts `archive`, and the
 * dual-control ack paths in domain/projectsLifecycle.ts — first-activation
 * go-live, deregister, unarchive). `__setKnownProjects` remains the test hook and
 * marks the cache hydrated so a test-pinned set is never clobbered mid-file.
 */
let KNOWN = new Set<string>(['@control']);
let hydrated = false;

/**
 * The reserved control-plane scope (data-birth spec §5) — deliberately OUTSIDE the
 * project-id grammar ({@link PROJECT_ID_RE} below),
 * the same trick as the `'*'` wildcard below, so collision with a registrable id is
 * impossible by construction and no reserved-name list is needed. It is ALWAYS
 * routable (never requires a store row — no `ProjectItem` for it ever exists), is
 * the acting scope of every header-less request (replaces the old baked-estate
 * `DEFAULT_PROJECT` default), is never listed by GET /projects, and is never a valid account
 * binding (`isValidProjectBinding` below) — membership on it holds ONLY via the
 * `'*'` all-projects wildcard (the founding admins). Estate-only surfaces (request
 * submission/approval, catalog reads) refuse with 403 CONTROL_SCOPE when the acting
 * scope is this id.
 */
export const CONTROL_SCOPE = '@control';

/** Project id slug grammar — also structurally excludes the `'*'` wildcard binding
 * and the reserved `'@control'` scope (both start with a non-`[a-z]` character).
 * The single home for project-id syntax: the registry route (routes/projects.ts)
 * validates register bodies against it, and the legacy-id resolver (deploy.ts)
 * validates `CCP_LEGACY_PROJECT_ID` against it. */
export const PROJECT_ID_RE = /^[a-z][a-z0-9-]{1,31}$/;

export function isKnownProject(id: string): boolean {
  return KNOWN.has(id);
}

/** The registered project ids (used by the readiness probe to verify every chain) —
 * always includes {@link CONTROL_SCOPE}, the control plane's own chain. */
export function knownProjects(): string[] {
  return [...KNOWN];
}

/** Test/registry hook: replace the known-project set (marks the cache hydrated).
 * Always re-adds {@link CONTROL_SCOPE} — the invariant `KNOWN ⊇ {CONTROL_SCOPE}`
 * holds even for a test-pinned set, so callers pass only the ready estate ids. */
export function __setKnownProjects(ids: string[]): void {
  KNOWN = new Set([CONTROL_SCOPE, ...ids]);
  hydrated = true;
}

/** Test hook: return to the cold-boot state (control-scope-only set, next request
 * re-hydrates — the blank-install state: zero estates). */
export function __resetKnownProjectsForTests(): void {
  KNOWN = new Set([CONTROL_SCOPE]);
  hydrated = false;
}

/** True until the first store hydration (or a test pin) has landed. */
export function needsProjectHydration(): boolean {
  return !hydrated;
}

/** Load the ready-project set from the store into the cache (idempotent).
 * An ARCHIVED project is excluded even at status 'ready' — archiving removes
 * routability immediately (fail closed); unarchive (2-admin) restores it. A
 * blank store (no ready projects) yields exactly `{CONTROL_SCOPE}`. */
export async function hydrateKnownProjects(store: ConfigStore): Promise<void> {
  const items = (await store.queryGSI1(projectCollectionGsi())) as ProjectItem[];
  KNOWN = new Set([CONTROL_SCOPE, ...items.filter((p) => p.status === 'ready' && !p.archived).map((p) => p.id)]);
  hydrated = true;
}

/** Force a re-read after a registry write (complete / deregister-ack). */
export async function refreshKnownProjects(store: ConfigStore): Promise<void> {
  hydrated = false;
  await hydrateKnownProjects(store);
}

/* ── account↔project authorization binding ──────────────
 * Identity stays GLOBAL (one account directory), but what a session may ACT on is
 * bound per account. `withProject` keeps checking only that a project id EXISTS;
 * `requireProjectMembership` (middleware/authz.ts) is the enforcement that the
 * CALLING ACCOUNT is bound to it. */

/** The wildcard binding: this account may act on every registered project. */
export const ALL_PROJECTS = '*';

/** The subset of an account these authorization helpers read — accept a partial so the
 * pure functions can be unit-tested and reused for TOTP-shaped `{role,isAdmin}` probes. */
export type AccountAuthz = Pick<AccountItem, 'roles' | 'projects' | 'role' | 'teamId'>;

/**
 * THE CANONICAL READ PATH (the single migration shim). Resolves the stored account
 * shape to one per-project role map `{ [projectId | '*']: {role, teamId?} }`:
 *
 *   1. `roles` present            → it (the new canonical shape, returned as-is).
 *   2. else `projects` present    → `{ [p]: {role, teamId} }` for each listed project
 *                                    (incl. `'*'`) — the legacy MEMBERSHIP list gains the
 *                                    row's single global role/team on every project.
 *   3. else (bare legacy row)     → `{}` — member of NOTHING (data-birth spec §5: arm 3's
 *                                    old baked-estate fallback is RETIRED; there is no baked
 *                                    estate left to fail closed onto). A real legacy store
 *                                    never actually reaches this arm at runtime — the
 *                                    one-time boot settlement (domain/settlement.ts)
 *                                    materializes every bare row into an explicit `roles`
 *                                    map (arm 1) before any request is served; this arm is
 *                                    the fail-closed floor for the (should-never-happen)
 *                                    unsettled case, not a routing default.
 *
 * Pure + total. A row with neither `roles` nor `role` (should never exist — `role` was
 * required pre-migration) floors to `requester` (least privilege) wherever `role` is read
 * below, but arm 3 no longer manufactures a project binding out of it. Every other authz
 * helper (`roleFor`/`teamFor`/`projectsOf`/`isBoundToProject`) is defined on top of THIS,
 * so there is exactly one place the legacy shapes are interpreted.
 */
export function rolesOf(account: AccountAuthz): Record<string, RoleBinding> {
  // A PRESENT map is authoritative even when EMPTY: revoking the last binding
  // must leave the account a member of NOTHING, not resurrect the legacy
  // scalar/default below (fail-closed — the shim is only for rows that predate
  // the `roles` shape entirely).
  if (account.roles) return account.roles;
  if (account.projects && account.projects.length > 0) {
    const role: RoleName = account.role ?? 'requester';
    const binding: RoleBinding = { role, ...(account.teamId !== undefined ? { teamId: account.teamId } : {}) };
    const out: Record<string, RoleBinding> = {};
    for (const p of account.projects) out[p] = binding;
    return out;
  }
  return {};
}

/**
 * The account's effective role ON `projectId`: its explicit entry, else the `'*'`
 * all-projects entry, else `undefined` (NOT a member — fail closed). A defined return
 * value IS proof of membership, so callers no longer pair this with `isBoundToProject`.
 */
export function roleFor(account: AccountAuthz, projectId: string): RoleName | undefined {
  const roles = rolesOf(account);
  return (roles[projectId] ?? roles[ALL_PROJECTS])?.role;
}

/** The account's team ON `projectId` (per-project now), resolved the same way as `roleFor`. */
export function teamFor(account: AccountAuthz, projectId: string): string | undefined {
  const roles = rolesOf(account);
  return (roles[projectId] ?? roles[ALL_PROJECTS])?.teamId;
}

/** True if ANY project binds this account to a senior (approver/lead) role — the TOTP
 * floor (an approver on ONE project must still carry a second factor). */
export function isSeniorAnywhere(account: AccountAuthz): boolean {
  return Object.values(rolesOf(account)).some((b) => b.role !== 'requester');
}

/**
 * The projects an account is bound to (the key set of `rolesOf`). A bare legacy row
 * (arm 3) → `[]` (member of nothing); a `['*']` row → `['*']`.
 */
export function projectsOf(account: AccountAuthz): string[] {
  return Object.keys(rolesOf(account));
}

/** May this account act on `projectId`? Membership = an explicit entry or the `'*'` wildcard. */
export function isBoundToProject(account: AccountAuthz, projectId: string): boolean {
  const roles = rolesOf(account);
  return ALL_PROJECTS in roles || projectId in roles;
}

/** A valid binding entry is the wildcard or a registered (non-control-scope) project
 * id. {@link CONTROL_SCOPE} is always "known" (routable) but is NOT a project — no
 * account can ever be bound to it directly; membership on it holds only via `'*'`
 * (data-birth spec §5 "Not bindable"). */
export function isValidProjectBinding(entry: string): boolean {
  return entry === ALL_PROJECTS || (entry !== CONTROL_SCOPE && isKnownProject(entry));
}
