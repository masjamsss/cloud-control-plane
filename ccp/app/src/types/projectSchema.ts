import { z } from 'zod';
import type { ProjectConfig } from './project';

/**
 * Runtime validation for a project config — the same guard the manifests get
 * (see manifestSchema.ts). A hand-written or tool-generated project.json is
 * parsed against this at load, so a malformed one fails loudly instead of
 * silently mis-configuring the estate. Keep in step with types/project.ts.
 */
const teamSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  serviceSlugs: z.array(z.string().min(1)),
});

export const projectSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  github: z.object({
    owner: z.string().min(1),
    repo: z.string().min(1),
    mode: z.enum(['personal', 'org']),
  }),
  region: z.string().min(1),
  seedLead: z.object({
    username: z.string().min(1),
    displayName: z.string().min(1),
    teamId: z.string().min(1),
    defaultPassword: z.string().min(1),
  }),
  teams: z.array(teamSchema).min(1),
  // Optional, never defaulted: absence means 'aws' (0039 S1 — the api's own
  // wire rule, routes/projects.ts). A different axis from providerTag/
  // providerAllowlist below (those pin the hashicorp/aws TERRAFORM provider;
  // this says which CLOUD provider) — see types/project.ts's doc comment.
  provider: z.enum(['aws', 'azure']).optional(),
  // Both optional: existing project.json files predating these fields stay valid.
  providerTag: z.string().min(1).optional(),
  providerAllowlist: z.array(z.string().min(1)).optional(),
  // Optional: absent means lib/datetime.ts falls back to a neutral
  // default, never a hardcoded estate timezone — see types/project.ts.
  timezone: z.string().min(1).optional(),
  timezoneLabel: z.string().min(1).optional(),
});

/** Parse+validate one project config, throwing a clear error on mismatch. */
export function parseProject(raw: unknown): ProjectConfig {
  return projectSchema.parse(raw) as ProjectConfig;
}

/** Non-throwing variant — returns null on invalid input (for the runtime override). */
export function tryParseProject(raw: unknown): ProjectConfig | null {
  const result = projectSchema.safeParse(raw);
  return result.success ? (result.data as ProjectConfig) : null;
}
