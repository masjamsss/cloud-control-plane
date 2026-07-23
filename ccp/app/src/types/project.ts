import type { Team } from './user';
import type { CloudProvider } from '@/lib/providerDisplay';

/**
 * The per-project configuration that makes the control plane reusable: the one
 * place that says *which* estate this instance serves. Everything project-specific
 * — the GitHub repo the PRs land in, the AWS region, the bootstrap Lead, and the
 * first-run teams — lives here rather than being compiled into the bundle, so the
 * same build serves any imported Terraform repo. The catalogctl onboarding tool
 * (Track B) generates one of these when it imports a repo; the SPA consumes it.
 */
export interface ProjectSeedLead {
  username: string;
  displayName: string;
  teamId: string;
  /** Documented first-run password; the seeded Lead must change it on first sign-in. */
  defaultPassword: string;
}

export interface ProjectConfig {
  /** Stable slug for the project (e.g. "sample"). */
  id: string;
  /** Human label shown in the shell (e.g. "Acme Production"). */
  name: string;
  github: { owner: string; repo: string; mode: 'personal' | 'org' };
  /**
   * For an aws project (the default), the AWS region. For a provider:'azure'
   * vendored project (0039 S1), this field instead carries the Azure location
   * (allowlisted api-side, e.g. "southeastasia") — there is no separate
   * location field on this vendored-fixture shape. Tenant and subscription
   * ids are NOT here: they are registration-flow data (routes/projects.ts /
   * lib/projectOnboarding.ts), not vendored-fixture data.
   */
  region: string;
  seedLead: ProjectSeedLead;
  /** First-run defaults for the (editable) team store. */
  teams: Team[];
  /**
   * Which cloud this project's estate lives on (0039 S1 — the azure seam).
   * Optional, and DELIBERATELY never default-filled here: absence means
   * 'aws', matching the exact wire convention the api already uses for
   * registered projects (routes/projects.ts — an aws row omits `provider`
   * entirely) and lib/projectOnboarding.ts's local mirror of it. Every
   * project.json before this field existed is an aws project and stays
   * byte-identical; callers read `project.provider ?? 'aws'` at the point of
   * use (see lib/beyondCatalog.ts / features/request/BeyondCatalogForm.tsx)
   * rather than this type ever synthesizing a value. NOT the same axis as
   * {@link providerTag}/{@link providerAllowlist} below, which describe the
   * `hashicorp/aws` TERRAFORM provider (version pin / source allowlist) —
   * this field says which CLOUD provider, aws or azure.
   */
  provider?: CloudProvider;
  /**
   * The `hashicorp/aws` provider version this project's ForceNew map was built
   * against (e.g. "v6.53.0") — ForceNew validity is per provider version, so an
   * onboarded project's Day-2 ops are only trustworthy while its pin matches the
   * map's tag (checked in tests; the onboarding pipeline documents the rule).
   * Optional: older/hand-authored project.json files predate this field.
   */
  providerTag?: string;
  /**
   * Terraform provider source addresses this project's onboarding pre-scan
   * allowed (e.g. "registry.terraform.io/hashicorp/aws"). Optional — absent
   * means the frozen default `["registry.terraform.io/hashicorp/*"]` applied;
   * existing project.json files predating this field stay valid.
   */
  providerAllowlist?: string[];
  /**
   * The estate's IANA timezone (e.g. "Europe/Paris") that approval and audit
   * timestamps render in (a project's local timezone is its own
   * DATA, not app code). Optional: an older/foreign project.json predating
   * this field stays valid; lib/datetime.ts falls back to a neutral default
   * (UTC) when absent, never to another project's zone.
   */
  timezone?: string;
  /** The suffix shown after a formatted time (e.g. "CET"), paired with
   * {@link timezone}. Purely a display label — not derived from the IANA zone,
   * so it is exactly what the project wants shown regardless of DST state. */
  timezoneLabel?: string;
}
