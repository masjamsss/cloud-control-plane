import { dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { serve } from '@hono/node-server';
import { createApp } from './index';
import type { ConfigStore } from './store/configStore';
import { MemoryStore } from './store/memoryStore';
import { FileStore, ensureDataDir } from './store/fileStore';
import { assertDeployable, DeployConfigError, deployWarnings, isProduction, resolveDataFile } from './deploy';
import { ensureProjectDataRoot, resolveProjectDataRoot } from './domain/projectData';
import { bootstrap, seedInstanceIdentity } from '../scripts/bootstrap';
import { executorKind, maybeStartSchedulerLoop, schedulerEnabled } from './domain/apply/loop';
import { runSettlement, SettlementConfigError } from './domain/settlement';
import { runVersionStamp } from './domain/versionStamp';
import { installProcessErrorLogging, logServerError, markProcessServing } from './log';
import { createShutdown } from './shutdown';

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
  // FIRST thing in the process, before anything that can throw (OPS-2). There was no
  // unhandledRejection/uncaughtException handler anywhere in the api, so a stray rejection
  // during boot — a bad data dir, a store that will not load — printed Node's own warning
  // at best and nothing at all at worst. Installed here rather than in createApp: the app
  // factory runs once per test, and attaching process listeners there leaks them.
  installProcessErrorLogging();

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

  // ARCH-11 — advisory, never fatal (unlike the preflight above): a sub-flag
  // armed for a lane whose own gate is off, so nothing anywhere will ever
  // consult it. Printed in every env, not just production — the same typo
  // is just as silent in local dev.
  for (const w of deployWarnings(process.env)) console.warn(`ccp-api: config warning — ${w}`);

  // A durable store needs its data directory. Create it eagerly in production so a bad
  // CCP_DATA_DIR fails at boot rather than on the first mutation. The per-project
  // served-data root (projects/) lives beside the store file under the same parent.
  const dataFile = resolveDataFile();
  if (isProduction(process.env) && dataFile !== null) {
    ensureDataDir(dirname(dataFile));
    ensureProjectDataRoot(resolveProjectDataRoot());
  }

  if (process.env.CCP_BOOTSTRAP === '1') {
    // Refuse bootstrap when a data file is PRESENT on disk regardless of contents
    // (adversarial finding): a present-but-accountless file (valid `[]`, zeroed,
    // half-restored) must not reseed a fresh admin over a vanished chain.
    // bootstrap()'s own account-presence check can't see this — an emptied file
    // loads 0 accounts. Only a truly ABSENT file is a fresh deploy.
    //
    // This check MUST run before the store opens: FileStore.open and the boot-time
    // settlement pass both materialize/touch the store file, so checking after them
    // would refuse EVERY fresh first boot against the file this very process just
    // created (the exact failure the install smoke caught on its first CI run).
    if (dataFile !== null && existsSync(dataFile)) {
      console.error(
        `ccp-api: bootstrap refused — data file ${dataFile} already exists on disk; refusing to re-provision (remove it to start fresh).`,
      );
      process.exit(1);
    }
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

  // REM-1 — stamp the optimistic-concurrency attributes onto rows that predate them.
  // Runs AFTER settlement (which may materialize account rows this then stamps) and
  // BEFORE serving, so no request can read a row mid-stamp. Idempotent via its own
  // marker; a no-op on an already-stamped store and on a blank one.
  //
  // Until this has run, every ifEquals guard in the routes is inert against existing
  // data: the attribute is `undefined` on both sides of a concurrent pair, so both
  // writes pass. The guards protect new rows; this is what extends them to old ones.
  const stamped = await runVersionStamp(store);
  if (stamped && (stamped.requests || stamped.accounts || stamped.teams)) {
    console.log(
      `ccp-api: version-stamp — requests: ${stamped.requests}, accounts: ${stamped.accounts}, teams: ${stamped.teams}`,
    );
  }

  if (process.env.CCP_BOOTSTRAP === '1') {
    // Disk-presence refusal ran BEFORE the store opened (see above). What remains here
    // is the store-level account-presence refusal for non-file backends.
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
  const scheduler = maybeStartSchedulerLoop(store);
  const armed = scheduler !== null;
  if (schedulerEnabled()) {
    console.log(
      armed
        ? `ccp-api: auto-apply scheduler ENABLED (CCP_SCHEDULER=1) — executor: ${executorKind()}${executorKind() === 'terraform' ? ` on root ${process.env.CCP_TF_ROOT}` : ' (no terraform/AWS is executed)'}`
        : 'ccp-api: auto-apply scheduler NOT ARMED — executor misconfigured (see the error above); held requests stay AWAITING',
    );
  }

  const port = Number(process.env.PORT) || 8801;

  const server = serve({ fetch: app.fetch, port }, (i) => console.log(`ccp-api dev on :${i.port}`));

  // The port is bound: from here a process-level fault is survivable rather than fatal
  // (log.ts explains the two policies, and why R-16's "never exit" is right for exactly
  // one of them). Marked AFTER serve() returns, so anything that throws on the way here
  // still exits non-zero.
  markProcessServing();

  // ERR-8 / OPS-8 — graceful shutdown. This REPLACES CONC-7's pair of handlers, which
  // called `process.exit(0)` synchronously: correct about the writer lock, but it cut
  // every in-flight request and left the scheduler's current tick mid-flight. The lock
  // handback is preserved exactly (it is now the LAST step of the drain, since in-flight
  // requests are still writing through it) and the drain is added around it.
  //
  // Registered for EVERY store kind, not just FileStore. The old block was inside an
  // `instanceof FileStore` guard, so a memory-store deployment had no signal handling of
  // any kind — the drain is about in-flight HTTP requests, which exist either way.
  //
  // A `kill -9` still bypasses all of this; that path is covered by the same-host dead-pid
  // takeover in `dataLock.ts`, the one case where the holder can be PROVEN gone.
  const shutdown = createShutdown({
    server,
    scheduler,
    releaseStore: store instanceof FileStore ? (): void => store.close() : undefined,
    exit: (code) => process.exit(code),
    log: (line) => console.log(line),
  });
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  if (store instanceof FileStore) {
    // Last resort for the paths that never reach the drain (an explicit process.exit
    // elsewhere, a fatal error after boot). Idempotent on the store side.
    process.once('exit', () => store.close());
  }
}

/**
 * ERR-8 — `void start()` used to be the whole of this, and a boot failure that was neither
 * a DeployConfigError nor a SettlementConfigError therefore had no catch anywhere. Since
 * OPS-2 that rejection reached a deliberately non-exiting handler, so the measured result
 * of booting against a corrupt store was a logged stack and **exit code 0** — a failed
 * start reported as a successful one (log.ts has the transcript and the reasoning).
 *
 * A boot failure exits non-zero here, with an operator-grade line above the stack. The
 * process handlers cover the same ground for a fault that arrives outside this promise;
 * this catch is what covers `start()` itself, which is where the store, the settlement
 * pass and the version stamp all live.
 */
start().catch((e: unknown) => {
  logServerError(e, { method: 'boot' });
  console.error('ccp-api: refusing to start — the failure above happened during boot; the process never bound its port. Fix the cause and restart (see ccp/api/README.md "Deploy").');
  process.exit(1);
});
