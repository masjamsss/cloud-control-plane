import type { Team } from '@/types';
import type { HttpApiClient } from '@/lib/httpApi';
import {
  TeamError,
  createTeam,
  deleteTeam,
  renameTeam,
  setTeamServices,
  toggleService,
  getTeams,
} from '@/lib/teams';

/**
 * Teams admin's ADVISORY → AUTHORITATIVE branch. `can('teams')` flipped true
 * the instant ccp-api serves the teams CRUD
 * routes, but TeamsAdmin.tsx kept writing every create/rename/set-services/
 * delete straight to lib/teams's localStorage store regardless — a control that
 * LOOKED enforced (armed, no advisory note) but wasn't (the write never left
 * the browser). This module is the fix: the one place that decides which
 * backend a team write reaches, pulled out of the component so it's
 * unit-testable without mounting one (this repo has no jsdom — see
 * test/standalone.test.ts's exact dependency allowlist). Mirrors
 * features/auth/authFlow.ts's shape exactly.
 *
 * `authoritative` is always exactly `can('teams')` (components/AdvisoryGate);
 * `client` is `lib/api`'s `authClient` (null in mock mode). When both are
 * truthy every read/write goes straight to ccp-api's teams CRUD
 * (lib/httpApi's admin methods); otherwise this is the exact pre-existing
 * lib/teams localStorage behavior, unchanged.
 */

export async function loadTeams(
  authoritative: boolean,
  client: HttpApiClient | null,
): Promise<Team[]> {
  if (authoritative && client) {
    const teams = await client.listAdminTeams();
    return teams
      .map((t) => ({ id: t.id, name: t.name, serviceSlugs: [...t.serviceSlugs] }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  return getTeams();
}

/** Creates the team and returns its canonical (server- or locally-assigned)
 * record — the caller never has to re-derive the id ccp-api/slugify chose. */
export async function createTeamVia(
  authoritative: boolean,
  client: HttpApiClient | null,
  name: string,
): Promise<Team> {
  if (authoritative && client) {
    const trimmed = name.trim();
    if (trimmed.length < 2) throw new TeamError('Team name must be at least 2 characters.');
    const created = await client.createAdminTeam(trimmed);
    return { id: created.id, name: created.name, serviceSlugs: [...created.serviceSlugs] };
  }
  return createTeam(name);
}

export async function renameTeamVia(
  authoritative: boolean,
  client: HttpApiClient | null,
  id: string,
  name: string,
): Promise<void> {
  if (authoritative && client) {
    const trimmed = name.trim();
    if (trimmed.length < 2) throw new TeamError('Team name must be at least 2 characters.');
    await client.renameAdminTeam(id, trimmed);
    return;
  }
  renameTeam(id, name);
}

export async function setTeamServicesVia(
  authoritative: boolean,
  client: HttpApiClient | null,
  id: string,
  serviceSlugs: string[],
): Promise<void> {
  if (authoritative && client) {
    await client.setAdminTeamServices(id, serviceSlugs);
    return;
  }
  setTeamServices(id, serviceSlugs);
}

/** Toggle one service on/off for a team — computes the next owned set from the
 * team's CURRENT (already-loaded) serviceSlugs, same as lib/teams's own
 * toggleService, then routes that bulk set through {@link setTeamServicesVia}. */
export async function toggleServiceVia(
  authoritative: boolean,
  client: HttpApiClient | null,
  team: Team,
  serviceSlug: string,
): Promise<void> {
  if (authoritative && client) {
    const has = team.serviceSlugs.includes(serviceSlug);
    const next = has
      ? team.serviceSlugs.filter((s) => s !== serviceSlug)
      : [...team.serviceSlugs, serviceSlug];
    await setTeamServicesVia(authoritative, client, team.id, next);
    return;
  }
  toggleService(team.id, serviceSlug);
}

export async function deleteTeamVia(
  authoritative: boolean,
  client: HttpApiClient | null,
  id: string,
): Promise<void> {
  if (authoritative && client) {
    await client.deleteAdminTeam(id);
    return;
  }
  deleteTeam(id);
}
