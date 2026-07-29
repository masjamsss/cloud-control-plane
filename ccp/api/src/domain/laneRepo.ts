import { buildCloneUrl, type CloneUrlRefusal } from './scanner';
import { repoRefOf, type RepoRef } from '../store/schema';

type Env = Record<string, string | undefined>;

/**
 * ARCH-2 — which estate's repository an armed lane acts on.
 *
 * The bundle (`domain/bundle.ts`) and the drift-proposal generator
 * (`domain/driftProposals.ts`) both resolved their checkout from ONE
 * deployment-global `CCP_GIT_REMOTE` — "one credential, two lanes" — with no
 * reference to the acting project, in a product whose headline claim is that one
 * control plane serves many accounts. The moment a second estate is onboarded, an
 * armed deployment clones estate A's repository for estate B's requests and drift
 * reports. It is fail-closed in practice (the gate refuses inside the wrong
 * checkout) so nothing corrupts, but ADR-0015's binding rule 6 named this exact
 * retrofit "the single most expensive avoidable mistake": *the request→PR
 * bridge/executor, whenever built, reads provider/scope from project config from
 * day one.* The bridge, as built, did not — while the registry has stored the
 * repo all along (`ProjectItem.repo` / the legacy `github` mirror) and the newer
 * ADR-0033 scanner lane already resolves per project through {@link buildCloneUrl}.
 *
 * Resolution order, fail-closed at every step:
 *
 *  1. **`CCP_GIT_PROJECT` names the estate the global remote belongs to.** That
 *     project keeps using `CCP_GIT_REMOTE` verbatim — credential embedded, local
 *     path, whatever the operator configured — even if it also registers a repo.
 *     This arm exists because a registered `RepoRef` is a *scanner* reference
 *     (ADR-0033, read-only, and `buildCloneUrl` refuses embedded credentials by
 *     construction), while these lanes must PUSH. Without it, upgrading would
 *     silently swap a working credentialed remote for a credential-free URL and
 *     break the one deployment shape that was never broken.
 *  2. **Otherwise the acting project's registered repo wins.** Resolved through
 *     the same `buildCloneUrl` the scanner uses, so the lanes inherit its host
 *     allowlist, its https-only rule, and its refusal of embedded credentials and
 *     explicit ports. This is the arm that closes the finding.
 *  3. **A registered repo that refuses is a refusal, not a fallback.** Dropping
 *     back to the global remote because a project's own repo pointed at an
 *     off-allowlist host would restore precisely the bug this closes — and would
 *     do it on the one input an operator got wrong, which is the worst possible
 *     moment to start guessing.
 *  4. **A pin set to some OTHER project refuses.** Once an operator has said
 *     which estate the global remote is, every other estate must bring its own.
 *  5. **No pin, no registered repo → `CCP_GIT_REMOTE`, the single-estate
 *     fallback.** A deployment serving one estate keeps working byte-identically.
 *     This is the arm that is still unsafe in a multi-estate deployment, which is
 *     why the pin exists and why this is documented rather than assumed away.
 *
 * The resolved `source` travels with the config so the audit evidence records
 * WHICH estate's remote a run actually used. The whole reason this defect could
 * exist is that the answer was never written down anywhere.
 */

/** The part of a `ProjectItem` this resolution reads. */
export interface LaneProject {
  id: string;
  repo?: RepoRef;
  github?: { owner: string; repo: string };
}

/** Where a lane's remote came from — recorded in the run's audit evidence. */
export type LaneRemoteSource = 'project-repo' | 'env-global';

export type LaneRemoteRefusal =
  /** Neither a registered repo nor `CCP_GIT_REMOTE` — the lane is unconfigured. */
  | 'no-remote'
  /** `CCP_GIT_PROJECT` names a different estate than the one acting. */
  | 'global-remote-pinned-to-other-project'
  /** The project's own registered repo failed `buildCloneUrl` (see the cause). */
  | `project-repo-${CloneUrlRefusal}`;

export type LaneRemote =
  | { ok: true; remote: string; source: LaneRemoteSource; detail: string }
  | { ok: false; refusal: LaneRemoteRefusal; detail: string };

/**
 * The clone URL an armed lane should use for `project`, or a refusal naming why.
 *
 * `project` is optional only so the legacy single-estate call shape still type-checks;
 * passing `undefined` means "no project context", which can satisfy the unpinned
 * environment fallback and nothing else. Every production call site passes one.
 */
export function resolveLaneRemote(
  project: LaneProject | undefined,
  env: Env = process.env,
  extraHosts: readonly string[] = [],
): LaneRemote {
  const pinned = env.CCP_GIT_PROJECT;
  const global = env.CCP_GIT_REMOTE;

  // Arm 1 — the operator has named which estate `CCP_GIT_REMOTE` is. That estate uses
  // it verbatim, registered repo or not: the env value may carry a push credential the
  // credential-free `buildCloneUrl` form cannot.
  if (pinned && project && pinned === project.id) {
    if (!global) {
      return {
        ok: false,
        refusal: 'no-remote',
        detail: `CCP_GIT_PROJECT names '${pinned}' but CCP_GIT_REMOTE is unset`,
      };
    }
    return {
      ok: true,
      remote: global,
      source: 'env-global',
      detail: `CCP_GIT_REMOTE (pinned to project ${pinned} by CCP_GIT_PROJECT)`,
    };
  }

  const repo = project ? repoRefOf(project) : undefined;

  if (repo) {
    const built = buildCloneUrl(repo, env, extraHosts);
    if (!built.ok) {
      return {
        ok: false,
        refusal: `project-repo-${built.refusal}`,
        detail:
          `project ${project!.id} registers ${repo.host}:${repo.owner}/${repo.name}, ` +
          `which this deployment refuses to clone (${built.refusal}). The deployment-global ` +
          'remote is deliberately NOT used as a fallback — that would clone another estate.',
      };
    }
    return {
      ok: true,
      remote: built.url,
      source: 'project-repo',
      detail: `${repo.host}:${repo.owner}/${repo.name} (project ${project!.id})`,
    };
  }

  if (!global) {
    return {
      ok: false,
      refusal: 'no-remote',
      detail: project
        ? `project ${project.id} registers no repository and CCP_GIT_REMOTE is unset`
        : 'CCP_GIT_REMOTE is unset',
    };
  }

  if (pinned) {
    return {
      ok: false,
      refusal: 'global-remote-pinned-to-other-project',
      detail:
        `CCP_GIT_REMOTE is pinned to project '${pinned}' (CCP_GIT_PROJECT), and ` +
        `${project ? `project '${project.id}'` : 'this call'} registers no repository of its own. ` +
        'Register the estate\'s repository so the lane clones its own code.',
    };
  }

  return {
    ok: true,
    remote: global,
    source: 'env-global',
    detail: project
      ? `CCP_GIT_REMOTE (project ${project.id} registers no repository)`
      : 'CCP_GIT_REMOTE',
  };
}
