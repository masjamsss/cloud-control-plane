import { dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { serve } from '@hono/node-server';
import { createApp } from './index';
import type { ConfigStore } from './store/configStore';
import { MemoryStore } from './store/memoryStore';
import { FileStore, ensureDataDir } from './store/fileStore';
import { assertDeployable, DeployConfigError, isProduction, resolveDataFile } from './deploy';
import { ensureProjectDataRoot, resolveProjectDataRoot } from './domain/projectData';
import { bootstrap, seedInstanceIdentity } from '../scripts/bootstrap';
import { executorKind, maybeStartSchedulerLoop, schedulerEnabled } from './domain/apply/loop';
import { runSettlement, SettlementConfigError } from './domain/settlement';

export { resolveDataFile };

/**
 * Deploy/dev entrypoint (`npm run start` in production, `npm run dev` locally). The
 * store is DURABLE by default (FileStore under a configurable data dir) so a
 * crash/redeploy preserves accounts, sessions, the per-project audit chain, and
 * policy. `CCP_STORE=memory` selects the process-bound MemoryStore (tests,
 * throwaway dev) — REFUSED in production by the preflight below.
 *
 * PRODUCTION PREFLIGHT (deploy.ts): before opening the store or binding a port,
 * `assertDeployable` fails closed on an insecure/incomplete config (memory store,
 * Secure cookies off, no CORS origin, missing TOTP key). No-op outside production.
 *
 * `CCP_BOOTSTRAP=1` runs first-boot provisioning IN this process. It is
 * REFUSED once data exists: re-bootstrapping a live backend would otherwise print
 * a fresh admin password and (against a wiped store) silently reset policy to
 * weaker defaults. On refusal we exit NON-ZERO so an operator sees it, rather than
 * booting on with an ambiguous identity state.
 */
export function selectStore(): Promise<ConfigStore> | ConfigStore {
  const file = resolveDataFile();
  if (file === null) return new MemoryStore();
  return FileStore.open(file);
}

async function start(): Promise<void> {
  // Fail closed on an insecure/incomplete production config BEFORE opening the store
  // or binding a port. Outside NODE_ENV=production this is a no-op (dev/tests + B2's
  // restart-survival proof, which boots with NODE_ENV=development, are unaffected).
  try {
    assertDeployable(process.env);
  } catch (e) {
    if (e instanceof DeployConfigError) {
      console.error(`ccp-api: refusing to start — ${e.message}`);
      console.error('Fix the env (see ccp/api/README.md "Deploy"), or run locally without NODE_ENV=production.');
      process.exit(1);
    }
    throw e;
  }

  // A durable store needs its data directory. Create it eagerly in production so a bad
  // CCP_DATA_DIR fails at boot rather than on the first mutation. The per-project
  // served-data root (projects/) lives beside the store file under the same parent.
  const dataFile = resolveDataFile();
  if (isProduction(process.env) && dataFile !== null) {
    ensureDataDir(dirname(dataFile));
    ensureProjectDataRoot(resolveProjectDataRoot());
  }

  const store = await selectStore();
  const app = createApp(store);

  // Data-birth spec §9 — the one-time legacy settlement. Idempotent (guarded by a
  // SETTLEMENT marker row) and safe on every store, including a truly blank one (a
  // no-op: nothing to retro-register, nothing to materialize). Runs explicitly here
  // at boot, ahead of serving any traffic — `withSettlement` (middleware/session.ts,
  // mounted first in index.ts's createApp) also calls the same idempotent function
  // lazily on the first request, so this is belt-and-braces observability (the
  // console line below), not the only trigger.
  let settlementResult: { retroRegistered: boolean; accountsMaterialized: number };
  try {
    settlementResult = await runSettlement(store);
  } catch (e) {
    // A pre-multi-project store with truly-bare account rows and CCP_LEGACY_PROJECT_ID
    // unset (or malformed) cannot be interpreted — refuse to serve and name the fix, the
    // same fail-closed posture as the DeployConfigError preflight above. The store is
    // untouched (no marker written), so the next boot with the variable set settles it.
    if (e instanceof SettlementConfigError) {
      console.error(`ccp-api: refusing to start — ${e.message}`);
      console.error('Set CCP_LEGACY_PROJECT_ID (see ccp/api/README.md "Deploy"), then restart.');
      process.exit(1);
    }
    throw e;
  }
  if (settlementResult.retroRegistered || settlementResult.accountsMaterialized > 0) {
    console.log(
      `ccp-api: settlement — retro-registered legacy project: ${settlementResult.retroRegistered}, accounts materialized: ${settlementResult.accountsMaterialized}`,
    );
  }

  if (process.env.CCP_BOOTSTRAP === '1') {
    // Refuse bootstrap when a data file is PRESENT on disk regardless of contents
    // (adversarial finding): a present-but-accountless file (valid `[]`,
    // zeroed, half-restored) must not reseed a fresh admin over a vanished chain.
    // bootstrap()'s own account-presence check can't see this — an emptied file
    // loads 0 accounts. Only a truly ABSENT file is a fresh deploy.
    const file = resolveDataFile();
    if (file !== null && existsSync(file)) {
      console.error(
        `ccp-api: bootstrap refused — data file ${file} already exists on disk; refusing to re-provision (remove it to start fresh).`,
      );
      process.exit(1);
    }
    const res = await bootstrap(store);
    if (!res.ok) {
      console.error(`ccp-api: bootstrap refused (${res.reason}) — the backend already holds data; refusing to re-provision.`);
      process.exit(1);
    }
    // ADR-0023 — the installer's one .env knob seeds the runtime identity
    // layer during this SAME first boot; a no-op if CCP_INSTANCE_NAME is
    // unset (the baked-generic default stands) or an INSTANCE row already
    // exists (never overwrites a live identity).
    await seedInstanceIdentity(store);
  }

  // 0038 — scheduled auto-apply. OFF BY DEFAULT: `maybeStartSchedulerLoop` arms NO
  // timer and returns null unless `CCP_SCHEDULER=1` is explicitly set, so this
  // line changes ZERO production behavior until an operator turns it on. The executor
  // is DRY-RUN (no terraform, no AWS) unless `CCP_EXECUTOR=terraform` is ALSO
  // explicitly set with an explicit CCP_TF_ROOT (proof milestone — real estate
  // roots refused by construction; a misconfig refuses to arm the loop).
  const armed = maybeStartSchedulerLoop(store) !== null;
  if (schedulerEnabled()) {
    console.log(
      armed
        ? `ccp-api: auto-apply scheduler ENABLED (CCP_SCHEDULER=1) — executor: ${executorKind()}${executorKind() === 'terraform' ? ` on root ${process.env.CCP_TF_ROOT}` : ' (no terraform/AWS is executed)'}`
        : 'ccp-api: auto-apply scheduler NOT ARMED — executor misconfigured (see the error above); held requests stay AWAITING',
    );
  }

  const port = Number(process.env.PORT) || 8801;
  serve({ fetch: app.fetch, port }, (i) => console.log(`ccp-api dev on :${i.port}`));
}

void start();
