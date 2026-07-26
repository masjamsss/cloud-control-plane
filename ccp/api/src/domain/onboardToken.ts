import { randomBytes } from "node:crypto";
import { ulid } from "ulid";
import type { ConfigStore } from "../store/configStore";
import type { ProjectItem, ProjectOnboardTokenItem } from "../store/schema";
import { onboardTokenKey } from "../store/schema";
import { hashPassword } from "../auth/credentials";
import { transactWithAudit } from "../domain/audit";
import { nowIso, nowMs } from "../clock";

/**
 * Minting a PRE-TRUST onboarding token — the one place in the codebase that
 * creates this credential.
 *
 * There are two callers and there must never be a second implementation:
 *  - `POST /projects/:id/onboard-tokens` (routes/projects.ts), where an admin
 *    mints one to paste into their own CI, and
 *  - the scanner worker's claim (routes/scanJobs.ts), where the control plane
 *    mints one for its own worker to upload the scan it just ran.
 *
 * It is deliberately a shared function rather than duplicated inline: every
 * security property of this credential — 32 random bytes, argon2id at rest,
 * the clear value existing exactly once in the response, and an audit row on
 * the TARGET project's chain — has to hold for both callers, and a copy is how
 * one of them quietly stops holding it.
 *
 * NOT folded into the mint on purpose: the STATUS GATE. Whether this project
 * may be onboarded at all is {@link isOnboardable}, which every caller checks
 * ITSELF before minting. The predicate is shared so the two lanes can never
 * disagree about the window; the enforcement stays visible at each call site
 * rather than hidden inside the mint, where it would look enforced in places
 * it is not.
 */

/**
 * Statuses whose onboarding is still legitimate: the repo has NOT yet passed
 * human trust review. The EXACT INVERSE of routes/projectData.ts's `UPLOADABLE`
 * — an onboarding token and a CI upload token can never be the right credential
 * for the same project at the same time; their lifetimes never overlap.
 */
export const ONBOARDABLE_STATUSES = new Set<ProjectItem["status"]>([
  "draft",
  "pending-trust",
]);

/**
 * Fail-closed: may this project be onboarded right now? Both halves matter —
 * an archived project mints nothing regardless of the rung it was archived on.
 */
export function isOnboardable(project: ProjectItem): boolean {
  return ONBOARDABLE_STATUSES.has(project.status) && !project.archived;
}
export type MintedOnboardToken = {
  tokenId: string;
  /** The clear `<tokenId>.<secret>` — returned ONCE; only its hash is stored. */
  token: string;
  expiresAt: string;
};

export async function mintOnboardToken(
  store: ConfigStore,
  projectId: string,
  actor: string,
  ttlMinutes: number,
): Promise<MintedOnboardToken> {
  const tokenId = ulid();
  const secret = randomBytes(32).toString("base64url");
  const secretHash = await hashPassword(secret); // argon2id, same posture as passwords/upload tokens
  const expiresAt = new Date(nowMs() + ttlMinutes * 60_000).toISOString();
  const item: ProjectOnboardTokenItem = {
    ...onboardTokenKey(projectId, tokenId),
    tokenId,
    projectId,
    secretHash,
    createdBy: actor,
    createdAt: nowIso(),
    expiresAt,
  };
  // AUDIT TO THE TARGET (mirrors upload-token-mint, projectData.ts): a
  // credential minted against `projectId` lands on `projectId`'s own chain,
  // whichever lane minted it.
  await transactWithAudit(
    store,
    projectId,
    [{ kind: "put", item: item as never, ifNotExists: true }],
    {
      action: "onboard-token-mint",
      actor,
      targetType: "project",
      targetId: projectId,
      after: { tokenId, expiresAt },
    },
  );
  return { tokenId, token: `${tokenId}.${secret}`, expiresAt };
}
