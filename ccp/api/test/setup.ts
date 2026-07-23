import { beforeEach } from 'vitest';
import { __resetKnownProjectsForTests } from '../src/projects';
import { SAMPLE_PROJECT_ID } from './helpers/seed';

// The whole suite runs as if the deployment's legacy estate id is the sample id — the
// same id seed() labels teams/policy with. Settlement (domain/settlement.ts) reads it
// from CCP_LEGACY_PROJECT_ID and binds the bare seed accounts onto it, so seed and
// settlement never desync. Hard assignment (not ??=) so the suite is deterministic
// regardless of the developer's shell. Servers spawned by tests (deployConfig,
// restart-survival flows) inherit it harmlessly — they boot blank stores.
process.env.CCP_LEGACY_PROJECT_ID = SAMPLE_PROJECT_ID;

/**
 * Global test setup (vitest.config.ts `test.setupFiles`). Resets the in-process
 * KNOWN-projects cache (projects.ts) to the cold-boot state before EVERY test, so
 * each test's own fresh store gets its own fresh hydration pass on its first
 * request, instead of silently inheriting whatever a PREVIOUS test (in the same
 * file, hence the same module instance) last hydrated or pinned via
 * `__setKnownProjects`.
 *
 * This was always a latent risk (`projects.ts`'s `hydrated` flag is module-global,
 * not per-store) but was invisible pre-data-birth: the old baked default project was
 * unconditionally in KNOWN regardless of hydration freshness, and virtually every
 * test store was that estate's store, so a stale cache was always "coincidentally"
 * correct. Post-data-birth, KNOWN is store-derived with no baked id, so a stale
 * cache can genuinely miss a project the CURRENT test's store just registered
 * (e.g. a legacy store's settlement-retro-registered `sample`) — this is that missing
 * per-test isolation, applied once, globally, rather than copied into every file.
 *
 * A test that wants a SPECIFIC known-project set still calls `__setKnownProjects`
 * itself, same as before — this hook only establishes the clean starting point.
 */
beforeEach(() => {
  __resetKnownProjectsForTests();
});
