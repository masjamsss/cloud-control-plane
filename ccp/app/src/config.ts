import type { Role, Team } from '@/types';
import type { ProjectSeedLead } from '@/types/project';
import { getProject } from '@/lib/project';
import rawProject from '@/data/project.json';

/**
 * Back-compat config surface. The project-specific values now live in the
 * resolved project config (src/lib/project.ts ← src/data/project.json or a
 * runtime override) so the same build serves any imported repo. These
 * exports keep their original names/shapes so existing importers are unchanged.
 */
export interface CcpConfig {
  github: { owner: string; repo: string; mode: 'personal' | 'org' };
  region: string;
}

const project = getProject();

export const config: CcpConfig = {
  github: project.github,
  region: project.region,
};

/**
 * The one bootstrap Lead seeded on first run (see lib/accounts.ensureSeeded).
 * Every other account is created by a Lead in the Users area. The default
 * password is documented, not shown in the UI — reset it after first login.
 */
export const SEED_LEAD: ProjectSeedLead = project.seedLead;

/** Seed teams — first-run defaults for the (now editable) team store; see lib/teams. */
export const DEFAULT_TEAMS: Team[] = project.teams;

/** One entry of the MOCK-mode engineer-roster seed — everyone
 * ensureSeeded() creates alongside the one bootstrap Lead above. */
export interface SeedAccountData {
  username: string;
  displayName: string;
  role: Role;
  teamId: string;
  /** Per-account first login password (MOCK-mode demo convenience — set to the
   * person's own name so the local roster is easy to sign in as). Falls back to
   * SEED_ACCOUNT_DEFAULT_PASSWORD if omitted. NOT a real credential: api-mode
   * deployment enrols each person with a strong password + TOTP (unchanged). */
  password?: string;
  /** Governance capability — omitted (falsy) for every entry
   * except the bootstrap Lead, so exactly one admin exists after a fresh seed. */
  isAdmin?: boolean;
}

/**
 * The rest of the engineer-roster seed, alongside `SEED_LEAD` above:
 * 3 requesters (L1), 1 approver (L2), 1 more lead (L3) — see project.json's
 * `seedAccounts` for the roster and team assignments (2 people per team,
 * one senior — Lead or Approver — plus one requester in each seeded team),
 * and lib/accounts.ensureSeeded for how these become
 * accounts.
 *
 * Read directly off the bundled project.json rather than through
 * `getProject()`'s validated/runtime-overridable path (contrast SEED_LEAD
 * above): `seedAccounts` is not yet part of the ProjectConfig Zod schema
 * (types/projectSchema.ts), and that schema strips unrecognized keys by
 * default, so routing this through getProject() would silently resolve to
 * an empty roster. Practical effect: a host-injected
 * `window.__CCP_PROJECT__` override (the reuse seam) can still swap
 * the one seedLead for a different imported repo, but not this extra
 * roster — it always reflects the bundled default. Closing that gap means
 * teaching the schema/type about `seedAccounts` too, which is a small,
 * separate follow-up (outside this change's file fence).
 */
export const SEED_ACCOUNTS: SeedAccountData[] =
  (rawProject as unknown as { seedAccounts?: SeedAccountData[] }).seedAccounts ?? [];

/**
 * The shared first-login password for every seeded account BELOW the
 * bootstrap Lead (which keeps its own per-account `defaultPassword` in
 * project.json, unlocked above as SEED_LEAD.defaultPassword). Documented
 * here, never shown in the UI. `mustChangePassword` (set by ensureSeeded)
 * forces each person to replace it with their own on first sign-in, so
 * this value never lingers as anyone's real credential.
 */
export const SEED_ACCOUNT_DEFAULT_PASSWORD = 'ccp-team';
