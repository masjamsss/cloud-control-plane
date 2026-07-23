import { useSyncExternalStore } from 'react';
import type { Team } from '@/types';
import { DEFAULT_TEAMS } from '@/config';
import { listAccounts } from '@/lib/accounts';
import { currentProjectId, scopedKey, SAMPLE_ESTATE_ID } from '@/lib/projectScope';
import { createEmitter, subscribeWithStorage } from '@/lib/useStore';

/**
 * The editable team store. A team owns a set of services (single-ownership — a
 * service belongs to exactly one team), which is what scopes what its requesters
 * may request. Persisted locally; the exact shape a real `ccp-api` keeps.
 * One-directional dependency: teams → accounts (never the reverse).
 *
 * Project-scoped: the storage key is computed at call time from the
 * active project, so switching projects never needs a reload.
 */

// legacy key from the Gerbang era — reads old data, never written
const LEGACY_KEY = 'gerbang.teams.v1';
const storeKey = (): string => scopedKey('teams');
const memory = new Map<string, string>();
/** Same-tab write notifications — see lib/useStore.ts's module doc. */
const emitter = createEmitter();

function readRaw(): string | null {
  // One-time legacy migration: an un-namespaced v1 key surfaces under the
  // sample estate exactly once.
  try {
    if (
      currentProjectId() === SAMPLE_ESTATE_ID &&
      localStorage.getItem(LEGACY_KEY) !== null &&
      localStorage.getItem(storeKey()) === null
    ) {
      localStorage.setItem(storeKey(), localStorage.getItem(LEGACY_KEY)!);
      localStorage.removeItem(LEGACY_KEY);
    }
  } catch {
    /* storage unavailable — memory fallback path needs no migration */
  }
  try {
    return localStorage.getItem(storeKey());
  } catch {
    return memory.get(storeKey()) ?? null;
  }
}
function writeRaw(value: string): void {
  try {
    localStorage.setItem(storeKey(), value);
  } catch {
    memory.set(storeKey(), value);
  }
  // Notify same-tab subscribers — the native `storage` event never fires in
  // the document that made the write.
  emitter.emit();
}

function load(): Team[] {
  const raw = readRaw();
  if (!raw) {
    writeRaw(JSON.stringify(DEFAULT_TEAMS));
    return DEFAULT_TEAMS.map((t) => ({ ...t, serviceSlugs: [...t.serviceSlugs] }));
  }
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Team[]) : [];
  } catch {
    return [];
  }
}
function save(teams: Team[]): void {
  writeRaw(JSON.stringify(teams));
}

export class TeamError extends Error {}

function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/* ── Reads ──────────────────────────────────────────────────────────────────── */

// ── Cached snapshot ───────────────────────────────────────────
// getTeams() is the render-facing "list everything, sorted" accessor — the one
// components read every render — so, like settings.ts, it is cached and only
// rebuilt when the raw stored string (or the project-scoped key) actually
// changed, returning the exact same array reference otherwise. Every other
// accessor here (getTeam, ownerOf, memberCount, the writers…) keeps calling
// the unchanged, always-fresh `load()` directly — they're one-shot reads
// inside handlers, not a useSyncExternalStore snapshot, so they have no
// referential-stability requirement and every reason to just stay simple.
let cachedKey: string | undefined;
let cachedRaw: string | null | undefined;
let cachedTeams: Team[] | undefined;

function computeTeamsSnapshot(): Team[] {
  const key = storeKey();
  const rawBefore = readRaw();
  if (cachedTeams !== undefined && key === cachedKey && rawBefore === cachedRaw) {
    return cachedTeams;
  }
  const loaded = load(); // may itself seed-write DEFAULT_TEAMS (unchanged side effect)
  cachedKey = key;
  cachedRaw = readRaw(); // re-read: reflects load()'s seed write, if any
  cachedTeams = loaded.sort((a, b) => a.name.localeCompare(b.name));
  return cachedTeams;
}

export function getTeams(): Team[] {
  return computeTeamsSnapshot();
}

/** Subscribe to this store changing — exported for direct testing (no
 * jsdom/RTL in this repo) and reused by useTeams() below. */
export const subscribeTeamsChanged = subscribeWithStorage(emitter, storeKey);

/** React binding for the teams store — see settings.ts's
 * useSettings() for the getServerSnapshot/no-jsdom rationale, identical here. */
export function useTeams(): Team[] {
  return useSyncExternalStore(subscribeTeamsChanged, computeTeamsSnapshot, computeTeamsSnapshot);
}
export function getTeam(id: string): Team | undefined {
  return load().find((t) => t.id === id);
}
export function teamName(id: string): string {
  return getTeam(id)?.name ?? '—';
}
/** Which team currently owns a service, if any. */
export function ownerOf(serviceSlug: string): Team | undefined {
  return load().find((t) => t.serviceSlugs.includes(serviceSlug));
}
export function memberCount(teamId: string): number {
  return listAccounts().filter((a) => a.teamId === teamId).length;
}

/* ── Writes ─────────────────────────────────────────────────────────────────── */

export function createTeam(name: string, serviceSlugs: string[] = []): Team {
  const trimmed = name.trim();
  if (trimmed.length < 2) throw new TeamError('Team name must be at least 2 characters.');
  const teams = load();
  if (teams.some((t) => t.name.toLowerCase() === trimmed.toLowerCase())) {
    throw new TeamError(`A team named “${trimmed}” already exists.`);
  }
  let id = slugify(trimmed) || 'team';
  let n = 2;
  while (teams.some((t) => t.id === id)) id = `${slugify(trimmed)}-${n++}`;
  const team: Team = { id, name: trimmed, serviceSlugs: [] };
  teams.push(team);
  save(teams);
  if (serviceSlugs.length) setTeamServices(id, serviceSlugs);
  return getTeam(id)!;
}

export function renameTeam(id: string, name: string): void {
  const trimmed = name.trim();
  if (trimmed.length < 2) throw new TeamError('Team name must be at least 2 characters.');
  const teams = load();
  if (teams.some((t) => t.id !== id && t.name.toLowerCase() === trimmed.toLowerCase())) {
    throw new TeamError(`A team named “${trimmed}” already exists.`);
  }
  const team = teams.find((t) => t.id === id);
  if (!team) throw new TeamError('No such team.');
  team.name = trimmed;
  save(teams);
}

/** Replace a team's owned services, enforcing single-ownership (remove them from any other team). */
export function setTeamServices(id: string, serviceSlugs: string[]): void {
  const teams = load();
  const team = teams.find((t) => t.id === id);
  if (!team) throw new TeamError('No such team.');
  const owned = new Set(serviceSlugs);
  for (const t of teams) {
    if (t.id === id) t.serviceSlugs = [...owned];
    else t.serviceSlugs = t.serviceSlugs.filter((s) => !owned.has(s));
  }
  save(teams);
}

/** Toggle a single service on/off for a team (moves it away from any current owner). */
export function toggleService(teamId: string, serviceSlug: string): void {
  const team = getTeam(teamId);
  if (!team) throw new TeamError('No such team.');
  const has = team.serviceSlugs.includes(serviceSlug);
  const next = has
    ? team.serviceSlugs.filter((s) => s !== serviceSlug)
    : [...team.serviceSlugs, serviceSlug];
  setTeamServices(teamId, next);
}

export function deleteTeam(id: string): void {
  const team = getTeam(id);
  if (!team) throw new TeamError('No such team.');
  if (memberCount(id) > 0) {
    throw new TeamError('Move this team’s members to another team before deleting it.');
  }
  if (team.serviceSlugs.length > 0) {
    throw new TeamError('Unassign this team’s services before deleting it.');
  }
  save(load().filter((t) => t.id !== id));
}

/** Test-only: reset the store to first-run (reseeds DEFAULT_TEAMS on next read). */
export function resetTeamsForTests(): void {
  writeRaw(JSON.stringify(DEFAULT_TEAMS));
}
