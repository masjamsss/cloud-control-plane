import { FileStore } from '../src/store/fileStore';
import type { ConfigStore } from '../src/store/configStore';
import { resolveDataFile } from '../src/deploy';
import { CONTROL_SCOPE, isKnownProject } from '../src/projects';
import { accountKey, type AccountItem } from '../src/store/schema';
import { loadAccounts } from '../src/domain/config';
import { transactWithAudit } from '../src/domain/audit';
import { killAllSessions } from '../src/auth/sessions';

/**
 * Offline "second admin" bootstrap (proposal 0021 §3.3, gap G6; your deployment's
 * second-approver runbook, Phase 3, Path A). Day-0
 * `scripts/bootstrap.ts` seeds exactly ONE admin (`putra`); minting a SECOND admin
 * in-app is itself a `loosening` isAdmin grant (`domain/dualControl.ts`'s 'admin'
 * classification) that needs a second DISTINCT active admin to ack — with exactly
 * one admin that ack is PERMANENTLY infeasible (`SELF_ACK`, fail-closed by design,
 * ADR-0011 Consequences). This script is the sanctioned escape hatch: run from a
 * branch-protection-reviewed PR (never ad hoc), it goes through the SAME store +
 * audit code paths the API itself uses (`domain/audit.ts#transactWithAudit` — no
 * hand-rolled JSON writes), so the mutation is atomic with its own hash-chained
 * audit entry, indistinguishable evidentially from an in-app one.
 *
 * Refuses:
 *   - 2+ active admins already exist — beyond the single-admin bootstrap problem
 *     this script exists to solve, the SAFER in-app dual-control path
 *     (`PATCH /admin/accounts/:id {isAdmin:true}` → a distinct admin acks) is
 *     available and should be preferred; this script stays deliberately narrow to
 *     the 1-admin liveness gap (a disabled admin does not count — it cannot ack).
 *   - the target account does not exist.
 *   - the target account is already admin.
 *   - the target account is disabled (status !== 'active').
 *   - the target account has not completed onboarding yet — still on its one-time
 *     password (`mustChangePassword:true`, the runbook's Phase 2). A real human
 *     must have taken ownership of their own credential before this script hands
 *     them admin.
 *
 * Also bumps `sessionVersion` (and eagerly kills live sessions), mirroring the G3
 * in-app fix (`routes/admin.ts`'s PATCH handler): per the runbook, the target
 * account is typically STILL `role:requester` with an already-live, TOTP-less
 * session at the point this script runs (requesters never carry a second factor,
 * `auth/totp.ts:56-58`, so their first login mints a full session immediately).
 * Without the bump, that live session would gain admin capability on its very
 * next request without ever having proved a second factor — the exact
 * vulnerability class F3/G3 closes in-app; this script closes it here too,
 * independently, since it is a separate write path.
 *
 * Run:  npx tsx scripts/grant-admin.ts --username <id> --pr <ref> [--data <file>] [--project <id>]
 *   --pr   identifies the reviewed PR (and/or operator) this run is attributed to,
 *          e.g. "pr#42" or "pr#42-alice" — REQUIRED (PR-review-only doctrine).
 */

export type Io = { log: (s: string) => void; error: (s: string) => void };
const consoleIo: Io = { log: (s) => console.log(s), error: (s) => console.error(s) };

export type GrantAdminResult =
  | { ok: true; username: string; auditId: string; sessionsRevoked: number }
  | { ok: false; reason: string };

export async function runGrantAdmin(opts: {
  store: ConfigStore;
  username: string;
  pr: string;
  projectId?: string;
  io?: Io;
}): Promise<GrantAdminResult> {
  const io = opts.io ?? consoleIo;
  const { store } = opts;
  // Granting isAdmin is a GLOBAL, control-plane action (data-birth spec §5) — it no
  // longer defaults to auditing onto a baked estate; the reserved
  // `@control` scope is the control plane's own chain, exactly like the in-app
  // dual-control PATCH would use when acting header-less.
  const projectId = opts.projectId ?? CONTROL_SCOPE;
  const username = opts.username.trim().toLowerCase();

  // Narrow to the single-admin bootstrap gap this script exists for (proposal 0021
  // §3.3) — beyond that, prefer the in-app dual-control PATCH. A disabled admin
  // cannot ack anything, so it does not count.
  const accounts = await loadAccounts(store);
  const activeAdmins = accounts.filter((a) => a.isAdmin && a.status === 'active');
  if (activeAdmins.length >= 2) {
    return {
      ok: false,
      reason:
        `refusing — ${activeAdmins.length} active admins already exist (${activeAdmins.map((a) => a.id).join(', ')}); ` +
        'this script is only for the single-admin bootstrap gap. Use the in-app dual-control PATCH instead.',
    };
  }

  const k = accountKey(username);
  const acc = (await store.get(k.PK, k.SK)) as AccountItem | null;
  if (!acc) return { ok: false, reason: `no such account: ${username}` };
  if (acc.isAdmin === true) return { ok: false, reason: `${username} is already admin` };
  if (acc.status !== 'active') return { ok: false, reason: `${username} is not active (status: ${acc.status}) — activate it before granting admin` };
  if (acc.mustChangePassword) {
    return {
      ok: false,
      reason: `${username} has not completed onboarding yet (still on its one-time password) — have them log in and change it first (runbook Phase 2)`,
    };
  }

  const actor = `maintenance:${opts.pr}`;
  const newSessionVersion = acc.sessionVersion + 1;
  const { id: auditId } = await transactWithAudit(
    store,
    projectId,
    [{ kind: 'update', pk: k.PK, sk: k.SK, set: { isAdmin: true, sessionVersion: newSessionVersion }, ifEquals: { attr: 'isAdmin', value: false } }],
    {
      action: 'account-update',
      actor,
      targetType: 'account',
      targetId: acc.id,
      before: { isAdmin: false },
      after: { isAdmin: true },
      // ADR-0009 item 4 (F4/G4): this SCRIPT IS the single-admin bootstrap escape
      // hatch — by construction it only ever runs while dual-control for isAdmin
      // grants is infeasible in-app, i.e. always under interim conditions.
      interimProfile: true,
    },
  );
  const sessionsRevoked = await killAllSessions(store, acc.id);

  io.log(`ccp-api grant-admin: granted isAdmin to ${username}`);
  io.log(`  actor: ${actor}`);
  io.log(`  audit id: ${auditId} (project ${projectId})`);
  io.log(`  sessionVersion: ${acc.sessionVersion} -> ${newSessionVersion} (${sessionsRevoked} live session(s) revoked)`);
  io.log(`  ${username} must re-authenticate; isAdmin now requires TOTP (auth/totp.ts:56-58) — their next login will demand enrolment.`);
  return { ok: true, username, auditId, sessionsRevoked };
}

function parseArgs(argv: string[]): { username?: string; pr?: string; data?: string; project?: string } {
  const out: { username?: string; pr?: string; data?: string; project?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--username') out.username = argv[++i];
    else if (argv[i] === '--pr') out.pr = argv[++i];
    else if (argv[i] === '--data') out.data = argv[++i];
    else if (argv[i] === '--project') out.project = argv[++i];
  }
  return out;
}

export async function main(argv: string[], io: Io = consoleIo): Promise<number> {
  const args = parseArgs(argv);
  if (!args.username || !args.pr) {
    io.error('usage: grant-admin --username <id> --pr <ref> [--data <file>] [--project <id>]');
    io.error(
      '  --pr identifies the reviewed PR (and/or operator) this run is attributed to, e.g. "pr#42" or ' +
        '"pr#42-alice" — required (PR-review-only doctrine, proposal 0021 §3.3).',
    );
    return 2;
  }
  if (args.project && !isKnownProject(args.project)) {
    io.error(`grant-admin: unknown project ${args.project}`);
    return 2;
  }

  const dataFile = args.data ?? resolveDataFile();
  if (dataFile === null) {
    io.error('grant-admin: CCP_STORE=memory has no data file to grant admin into. Set a durable store (unset CCP_STORE) or pass --data.');
    return 2;
  }
  const store = await FileStore.open(dataFile);

  const res = await runGrantAdmin({ store, username: args.username, pr: args.pr, projectId: args.project, io });
  if (!res.ok) {
    io.error(`grant-admin failed: ${res.reason}`);
    return 1;
  }
  return 0;
}

// Run when invoked directly (tsx scripts/grant-admin.ts ...).
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
