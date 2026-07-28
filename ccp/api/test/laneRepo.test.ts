import { describe, expect, it } from 'vitest';
import { resolveLaneRemote, type LaneProject } from '../src/domain/laneRepo';
import { bundleConfig, bundleArmed } from '../src/domain/bundle';
import { driftGenConfig, driftGenArmed } from '../src/domain/driftProposals';

/**
 * ARCH-2 — the armed lanes act on the ACTING estate's repository.
 *
 * Both the apply bundle and the drift-proposal generator resolved their checkout from
 * one deployment-global `CCP_GIT_REMOTE`, with no reference to which project the work
 * belonged to. In a product whose headline claim is "one control plane serves many
 * accounts", the second onboarded estate got the first estate's Terraform. Nothing
 * corrupted — the gate refuses inside the wrong checkout — but ADR-0015's binding rule 6
 * named this exact retrofit "the single most expensive avoidable mistake".
 *
 * These tests are the shape of the defect: two estates, one deployment.
 */

const ESTATE_A: LaneProject = { id: 'alpha', repo: { host: 'github', owner: 'acme', name: 'estate-a' } };
const ESTATE_B: LaneProject = { id: 'beta', repo: { host: 'gitlab', owner: 'acme/infra', name: 'estate-b' } };
const NO_REPO: LaneProject = { id: 'gamma' };

const ARMED_BUNDLE = { CCP_BUNDLE: '1', CCP_BUNDLE_GATE_CMD: 'g', CCP_BUNDLE_TRIGGER_CMD: 't' };
const ARMED_DRIFT = { CCP_DRIFT_PROPOSALS: '1', CCP_DRIFT_GEN_CMD: 'g' };

describe('ARCH-2 — per-estate remote resolution', () => {
  it('THE DEFECT: two estates on one deployment no longer share a checkout', () => {
    const env = { CCP_GIT_REMOTE: 'https://github.com/acme/estate-a.git' };
    const a = resolveLaneRemote(ESTATE_A, env);
    const b = resolveLaneRemote(ESTATE_B, env);
    expect(a.ok && b.ok).toBe(true);
    expect(a.ok && a.remote).toBe('https://github.com/acme/estate-a.git');
    expect(b.ok && b.remote).toBe('https://gitlab.com/acme/infra/estate-b.git');
    // The whole finding in one assertion: before this, both were the env value.
    expect(a.ok ? a.remote : null).not.toBe(b.ok ? b.remote : null);
    expect(a.ok && a.source).toBe('project-repo');
  });

  it('a registered repo beats the environment, and the environment is not consulted', () => {
    const r = resolveLaneRemote(ESTATE_A, { CCP_GIT_REMOTE: 'https://github.com/other/wrong.git' });
    expect(r.ok && r.remote).toBe('https://github.com/acme/estate-a.git');
    expect(r.ok && r.source).toBe('project-repo');
  });

  it('the LEGACY `github` field resolves too — old rows predate RepoRef', () => {
    const legacy: LaneProject = { id: 'legacy', github: { owner: 'acme', repo: 'old-estate' } };
    const r = resolveLaneRemote(legacy, { CCP_GIT_REMOTE: 'https://github.com/other/wrong.git' });
    expect(r.ok && r.remote).toBe('https://github.com/acme/old-estate.git');
    expect(r.ok && r.source).toBe('project-repo');
  });

  it('a registered repo that is REFUSED does not fall back to the global remote', () => {
    // An off-allowlist self-hosted forge. Falling back here would clone another estate
    // on the one input the operator got wrong — the worst possible moment to guess.
    const selfHosted: LaneProject = {
      id: 'delta',
      repo: { host: 'gitlab', baseUrl: 'https://git.internal.example', owner: 'infra', name: 'estate-d' },
    };
    const r = resolveLaneRemote(selfHosted, { CCP_GIT_REMOTE: 'https://github.com/acme/estate-a.git' });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.refusal).toBe('project-repo-host-not-allowed');
    expect(!r.ok && r.detail).toContain('deliberately NOT used as a fallback');
  });

  it('…and is allowed once the deployment allowlists that forge host', () => {
    const selfHosted: LaneProject = {
      id: 'delta',
      repo: { host: 'gitlab', baseUrl: 'https://git.internal.example', owner: 'infra', name: 'estate-d' },
    };
    const r = resolveLaneRemote(selfHosted, { CCP_FORGE_HOSTS: 'git.internal.example' });
    expect(r.ok && r.remote).toBe('https://git.internal.example/infra/estate-d.git');
  });

  it('SINGLE-ESTATE UNCHANGED: no registered repo + CCP_GIT_REMOTE ⇒ the env value', () => {
    const r = resolveLaneRemote(NO_REPO, { CCP_GIT_REMOTE: 'https://github.com/acme/only.git' });
    expect(r.ok && r.remote).toBe('https://github.com/acme/only.git');
    expect(r.ok && r.source).toBe('env-global');
  });

  it('nothing registered and nothing configured ⇒ no-remote', () => {
    const r = resolveLaneRemote(NO_REPO, {});
    expect(!r.ok && r.refusal).toBe('no-remote');
  });

  it('CCP_GIT_PROJECT pins the global remote to one estate; others are refused', () => {
    const env = { CCP_GIT_REMOTE: 'https://github.com/acme/only.git', CCP_GIT_PROJECT: 'gamma' };
    expect(resolveLaneRemote(NO_REPO, env).ok).toBe(true);
    const other = resolveLaneRemote({ id: 'epsilon' }, env);
    expect(other.ok).toBe(false);
    expect(!other.ok && other.refusal).toBe('global-remote-pinned-to-other-project');
    // Another estate WITH its own repo is unaffected — it never reaches the pin.
    const a = resolveLaneRemote(ESTATE_A, env);
    expect(a.ok && a.remote).toBe('https://github.com/acme/estate-a.git');
  });

  it('THE UPGRADE PATH: the pinned estate keeps its credentialed remote even with a repo registered', () => {
    // A registered RepoRef is a SCANNER reference (ADR-0033, read-only) and
    // `buildCloneUrl` refuses embedded credentials by construction — but these lanes
    // push. Without this arm, upgrading a working single-estate deployment would swap a
    // credentialed remote for a credential-free URL and break the one shape that was
    // never broken. Naming the estate is how an operator says "that remote is mine".
    // RFC 2606 `.example` host: the point of the literal is the embedded-credential
    // SHAPE, which `buildCloneUrl` refuses by construction — not the forge it names.
    const credentialed = 'https://bot:tok@forge.example/acme/estate-a.git';
    const env = { CCP_GIT_REMOTE: credentialed, CCP_GIT_PROJECT: 'alpha' };
    const r = resolveLaneRemote(ESTATE_A, env);
    expect(r.ok && r.remote).toBe(credentialed);
    expect(r.ok && r.source).toBe('env-global');
    expect(r.ok && r.detail).toContain('pinned to project alpha');
    // …and the pin does NOT leak to the other estate, which still gets its own.
    const b = resolveLaneRemote(ESTATE_B, env);
    expect(b.ok && b.remote).toBe('https://gitlab.com/acme/infra/estate-b.git');
  });

  it('a pin naming this estate with no CCP_GIT_REMOTE set refuses rather than silently using the repo', () => {
    const r = resolveLaneRemote(ESTATE_A, { CCP_GIT_PROJECT: 'alpha' });
    expect(!r.ok && r.refusal).toBe('no-remote');
  });

  it('a pinned global remote refuses a call with no project context at all', () => {
    const env = { CCP_GIT_REMOTE: 'https://github.com/acme/only.git', CCP_GIT_PROJECT: 'gamma' };
    expect(resolveLaneRemote(undefined, env).ok).toBe(false);
  });
});

describe('ARCH-2 — the lane configs carry the resolution', () => {
  it('bundleConfig resolves per estate and records the source', () => {
    const env = { ...ARMED_BUNDLE, CCP_GIT_REMOTE: 'https://github.com/acme/estate-a.git' };
    expect(bundleConfig(env, ESTATE_B)?.remote).toBe('https://gitlab.com/acme/infra/estate-b.git');
    expect(bundleConfig(env, ESTATE_B)?.remoteSource).toBe('project-repo');
    expect(bundleConfig(env, NO_REPO)?.remoteSource).toBe('env-global');
  });

  it('driftGenConfig resolves per estate too — the same defect, the same fix', () => {
    const env = { ...ARMED_DRIFT, CCP_GIT_REMOTE: 'https://github.com/acme/estate-a.git' };
    expect(driftGenConfig(env, ESTATE_B)?.remote).toBe('https://gitlab.com/acme/infra/estate-b.git');
    expect(driftGenConfig(env, ESTATE_B)?.remoteSource).toBe('project-repo');
  });

  it('an unresolvable remote disarms the config rather than borrowing another estate', () => {
    const selfHosted: LaneProject = {
      id: 'delta',
      repo: { host: 'gitlab', baseUrl: 'https://git.internal.example', owner: 'infra', name: 'estate-d' },
    };
    const env = { ...ARMED_BUNDLE, CCP_GIT_REMOTE: 'https://github.com/acme/estate-a.git' };
    expect(bundleConfig(env, selfHosted)).toBeNull();
    expect(driftGenConfig({ ...ARMED_DRIFT, CCP_GIT_REMOTE: 'x' }, selfHosted)).toBeNull();
  });

  it('ARMED is separable from RESOLVED — the two refusals are different problems', () => {
    // The route needs this split: a deployment that never armed the lane must answer
    // without reading the registry, and an operator whose flags ARE set must not be
    // sent to look at flags. Collapsing them is how the cross-estate clone stayed
    // invisible for as long as it did.
    expect(bundleArmed({})).toBe(false);
    expect(bundleArmed(ARMED_BUNDLE)).toBe(true);
    expect(bundleArmed({ CCP_BUNDLE: '1', CCP_BUNDLE_GATE_CMD: 'g' })).toBe(false);
    expect(driftGenArmed({})).toBe(false);
    expect(driftGenArmed(ARMED_DRIFT)).toBe(true);
    expect(driftGenArmed({ CCP_DRIFT_PROPOSALS: '1' })).toBe(false);

    // Armed, and still no config — because THIS estate's repo does not resolve.
    const unresolvable: LaneProject = {
      id: 'delta',
      repo: { host: 'gitlab', baseUrl: 'https://git.internal.example', owner: 'infra', name: 'estate-d' },
    };
    expect(bundleArmed(ARMED_BUNDLE)).toBe(true);
    expect(bundleConfig(ARMED_BUNDLE, unresolvable)).toBeNull();
  });

  it('OFF BY DEFAULT still holds — the flag alone arms nothing', () => {
    expect(bundleConfig({ CCP_GIT_REMOTE: 'r' })).toBeNull();
    expect(bundleConfig({ CCP_BUNDLE: '1' })).toBeNull();
    expect(driftGenConfig({ CCP_GIT_REMOTE: 'r' })).toBeNull();
    expect(driftGenConfig({ CCP_DRIFT_PROPOSALS: '1' })).toBeNull();
  });
});
