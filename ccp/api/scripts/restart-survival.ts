/**
 * RESTART-SURVIVAL PROOF (0015 §B2 Stage-1 exit criterion).
 *
 * Drives a REAL ccp-api process over HTTP through the full authoritative flow,
 * `kill -9`s it, restarts a fresh process against the SAME data file, and asserts
 * that accounts, the enrolled TOTP factor, the request + its approval, settings
 * (incl. global freeze), the approval policy, and the hash-chained audit log all
 * survive byte-for-byte — and that the chain still verifies. It also proves the
 * server REFUSES `CCP_BOOTSTRAP=1` once data exists (no fresh admin password,
 * no policy reset).
 *
 * Run:  npx tsx scripts/restart-survival.ts
 * Exit: 0 = PASS · 1 = FAIL. Prints before/after snapshots for the record.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { connect } from 'node:net';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pbkdf2Sync, randomBytes } from 'node:crypto';
import { authenticator } from 'otplib';
import { verifyChain, type ChainEntry } from './verify-audit-chain';
import { chainHead } from '../src/store/schema';
import { CONTROL_SCOPE } from '../src/projects';

const API_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const TSX_BIN = join(API_DIR, 'node_modules', '.bin', 'tsx');
const DATA_FILE = join(mkdtempSync(join(tmpdir(), 'ccp-rs-')), 'ccp.json');
const PORT = 8700 + Math.floor(Math.random() * 300);
const BASE = `http://127.0.0.1:${PORT}`;
const TOTP_KEY = 'restart-survival-fixed-key'; // MUST be identical across restarts to decrypt the enrolled secret
const CLIENT = { 'x-ccp-client': 'ccp-spa' };

const baseEnv = { ...process.env, CCP_DATA_FILE: DATA_FILE, CCP_TOTP_KEY: TOTP_KEY, PORT: String(PORT), NODE_ENV: 'development' };

let child: ChildProcess | null = null;

/** Spawn tsx directly in its OWN process group (detached) so a group-kill takes the whole tree. */
function spawnServer(env: NodeJS.ProcessEnv): { proc: ChildProcess; lines: string[] } {
  const proc = spawn(TSX_BIN, ['src/server.ts'], { cwd: API_DIR, env, detached: true });
  const lines: string[] = [];
  proc.stdout?.on('data', (b: Buffer) => { for (const l of b.toString().split('\n')) if (l.trim()) lines.push(l.trim()); });
  proc.stderr?.on('data', (b: Buffer) => { for (const l of b.toString().split('\n')) if (l.trim()) lines.push(`[stderr] ${l.trim()}`); });
  return { proc, lines };
}

/** SIGKILL the entire process group of a detached child (kills tsx + its node grandchild). */
function hardKill(proc: ChildProcess | null): void {
  if (!proc || proc.exitCode !== null || proc.pid === undefined) return;
  try { process.kill(-proc.pid, 'SIGKILL'); } catch { /* group gone */ }
  try { proc.kill('SIGKILL'); } catch { /* already gone */ }
}

function startServer(opts: { bootstrap: boolean }): Promise<{ stdout: string[] }> {
  const env = { ...baseEnv, ...(opts.bootstrap ? { CCP_BOOTSTRAP: '1' } : {}) };
  const { proc, lines } = spawnServer(env);
  child = proc;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`server not ready in 25s; output:\n${lines.join('\n')}`)), 25_000);
    proc.stdout?.on('data', (b: Buffer) => {
      if (b.toString().includes('ccp-api dev on :')) { clearTimeout(t); resolve({ stdout: lines }); }
    });
    proc.on('exit', (code) => { clearTimeout(t); if (code !== 0) reject(new Error(`server exited early code=${code}; output:\n${lines.join('\n')}`)); });
  });
}

/** Spawn a bootstrap process that is EXPECTED to refuse (data already exists). */
function runBootstrapRefusal(): Promise<{ code: number | null; lines: string[] }> {
  const { proc, lines } = spawnServer({ ...baseEnv, CCP_BOOTSTRAP: '1', PORT: String(PORT + 1) });
  return new Promise((resolve) => {
    proc.on('exit', (code) => { hardKill(proc); resolve({ code, lines }); });
    setTimeout(() => { hardKill(proc); resolve({ code: proc.exitCode, lines }); }, 20_000);
  });
}

function killServer(): Promise<void> {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null) { resolve(); return; }
    child.on('exit', () => resolve());
    hardKill(child); // hard crash — no graceful flush
    setTimeout(resolve, 3000);
  });
}

/** Poll until nothing is listening on PORT (SIGKILL frees the socket async). */
async function waitPortFree(): Promise<void> {
  for (let i = 0; i < 60; i++) {
    const held = await new Promise<boolean>((res) => {
      const s = connect(PORT, '127.0.0.1');
      s.on('connect', () => { s.destroy(); res(true); });
      s.on('error', () => res(false));
    });
    if (!held) return;
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Minimal cookie-jar HTTP client (one per user). */
function mkClient() {
  let cookie = '';
  return {
    getCookie: () => cookie,
    setCookie: (v: string) => { cookie = v; },
    async req(method: string, path: string, body?: unknown, extra: Record<string, string> = {}) {
      const headers: Record<string, string> = { ...extra };
      if (cookie) headers.cookie = cookie;
      if (body !== undefined) headers['content-type'] = 'application/json';
      const res = await fetch(`${BASE}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
      const set = (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
      for (const sc of set) {
        const m = /ccp_session=([^;]*)/.exec(sc);
        if (m) cookie = m[1] ? `ccp_session=${m[1]}` : '';
      }
      const text = await res.text();
      let json: unknown = undefined;
      try { json = text ? JSON.parse(text) : undefined; } catch { /* non-JSON */ }
      return { status: res.status, json: json as any, text };
    },
  };
}

async function waitReachable(): Promise<void> {
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(`${BASE}/healthz`); if (r.ok) return; } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('healthz never came up');
}

/** Read audit entries + chain head straight off the durable file (the strongest durability probe). */
function auditFromFile(): { entries: ChainEntry[]; head: string; count: number } {
  const items = JSON.parse(readFileSync(DATA_FILE, 'utf8')) as Array<Record<string, any>>;
  const entries = items
    .filter((it) => typeof it.PK === 'string' && /AUDIT#\d{6}$/.test(it.PK))
    .sort((a, b) => (a.SK < b.SK ? -1 : a.SK > b.SK ? 1 : 0)) as unknown as ChainEntry[];
  // The chain this proof actually writes is the CONTROL-PLANE chain (@control):
  // bootstrap, migrate and the freeze setting all audit onto it, while the requester's
  // header-less POST /requests is refused as an estate-scope action (data-birth §5), so
  // no per-project chain is ever written. This probe previously looked up the old baked
  // default estate's 'P#<estate>#AUDIT' head — a partition a blank-born store never
  // creates post-data-birth, which made the head assertion vacuous ('' === '' across the
  // restart). Point it at the chain the flow really writes (O2 stop-and-report finding).
  const controlHead = chainHead(CONTROL_SCOPE);
  const headItem = items.find((it) => it.PK === controlHead.PK && it.SK === controlHead.SK);
  return { entries, head: (headItem?.hash as string) ?? '', count: entries.length };
}

function pbkdf2Cred(password: string): { passwordHash: string; salt: string; iterations: number } {
  const iterations = 200_000;
  const salt = randomBytes(16);
  const hash = pbkdf2Sync(Buffer.from(password, 'utf8'), salt, iterations, 32, 'sha256');
  return { passwordHash: hash.toString('base64'), salt: salt.toString('base64'), iterations };
}

const results: Array<{ name: string; ok: boolean; detail?: string }> = [];
function check(name: string, ok: boolean, detail?: string) {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? `  — ${detail}` : ''}`);
}

async function main(): Promise<void> {
  console.log(`\n=== RESTART-SURVIVAL PROOF ===\ndata file: ${DATA_FILE}\nport: ${PORT}\n`);

  // ── PHASE 1: boot (bootstrap) + full authoritative flow ───────────────────────
  console.log('[1] boot process A with CCP_BOOTSTRAP=1');
  const a = await startServer({ bootstrap: true });
  await waitReachable();
  const pwLine = a.stdout.find((l) => l.includes('one-time password:'));
  const bootPw = pwLine ? pwLine.split('one-time password:')[1]!.trim() : '';
  check('bootstrap printed a one-time admin password', bootPw.length > 0);

  const putra = mkClient();
  // enroll TOTP for the bootstrap admin
  const login1 = await putra.req('POST', '/auth/login', { username: 'putra', password: bootPw });
  const secret = login1.json?.totpEnrollment?.secret as string;
  check('login returns TOTP enrollment for the privileged admin', login1.status === 200 && !!secret, `status=${login1.status}`);
  const enroll = await putra.req('POST', '/auth/totp/enroll', { code: authenticator.generate(secret) }, CLIENT);
  check('TOTP enrollment completes', enroll.status === 200, `status=${enroll.status} ${enroll.text}`);
  const newPw = 'putra-strong-pw-9';
  const chpw = await putra.req('POST', '/auth/change-password', { currentPassword: bootPw, newPassword: newPw }, CLIENT);
  check('admin clears mustChangePassword', chpw.status === 200, `status=${chpw.status} ${chpw.text}`);

  // seed a team + a requester via the existing migrate endpoint (backend still holds only putra)
  const sariPw = 'sari-strong-pw-9';
  const migrate = await putra.req('POST', '/admin/migrate/v1', {
    'ccp.accounts.v1': [{
      id: 'sari', username: 'sari', displayName: 'Sari', role: 'requester', teamId: 'app-platform',
      ...pbkdf2Cred(sariPw), status: 'active', createdAt: '2026-07-12T00:00:00.000Z', createdBy: 'system', mustChangePassword: false, isAdmin: false,
    }],
    'ccp.teams.v1': [{ id: 'app-platform', name: 'App Platform', serviceSlugs: ['acm'] }],
    'ccp.policy.v1': { low: 1, medium: 1, high: 2, deleteMin: 2 },
    'ccp.risk-overrides.v1': {},
    'ccp.audit.v1': [],
  }, CLIENT);
  check('migrate seeds team + requester + policy', migrate.status === 200, `status=${migrate.status} ${migrate.text}`);

  // requester submits a LOW-risk change
  const sari = mkClient();
  const sLogin = await sari.req('POST', '/auth/login', { username: 'sari', password: sariPw });
  check('requester logs in to a full session (no TOTP)', sLogin.status === 200 && !sLogin.json?.totpRequired, `status=${sLogin.status}`);
  const submit = await sari.req('POST', '/requests', {
    operationId: 'acm-add-tag', targetAddress: 'aws_acm_certificate.prod',
    params: { certificate: 'arn:aws:acm:ap-southeast-5:123456789012:certificate/abc', tag_key: 'env', tag_value: 'prod' },
    justification: 'tag the production certificate for cost tracking', schedule: { kind: 'now' },
  }, CLIENT);
  const reqId = submit.json?.id as string;
  check('requester submits a change (201)', submit.status === 201 && !!reqId, `status=${submit.status} ${submit.text}`);

  // admin (a lead → eligible approver) approves; single approval completes it
  const approve = await putra.req('POST', `/requests/${reqId}/approve`, {}, CLIENT);
  check('admin approves → APPLIED', approve.status === 200 && approve.json?.status === 'APPLIED', `status=${approve.status} ${JSON.stringify(approve.json?.status)}`);

  // set a tightening setting (global freeze on) — applies immediately
  const freeze = await putra.req('PUT', '/admin/settings/freeze.global', { value: true }, CLIENT);
  check('admin freezes globally (setting persists)', freeze.status === 200, `status=${freeze.status} ${freeze.text}`);

  // ── capture BEFORE snapshot ────────────────────────────────────────────────────
  const before = {
    me: (await putra.req('GET', '/auth/me')).json,
    accounts: (await putra.req('GET', '/admin/accounts')).json,
    requests: (await putra.req('GET', '/requests?scope=all')).json,
    settings: (await putra.req('GET', '/admin/settings')).json,
    policy: (await putra.req('GET', '/admin/policy')).json,
  };
  const auditBefore = auditFromFile();
  const putraCookieBefore = putra.getCookie();
  const verifyBefore = verifyChain(auditBefore.entries, { head: auditBefore.head });
  check('audit chain verifies BEFORE restart', verifyBefore.code === 0, verifyBefore.message);

  console.log('\n--- BEFORE (pre-kill) ---');
  console.log('accounts:', JSON.stringify((before.accounts as any[]).map((x) => ({ id: x.id, role: x.role, isAdmin: x.isAdmin, totpEnrolled: x.totpEnrolled }))));
  console.log('request :', JSON.stringify((before.requests?.items as any[]).map((x) => ({ id: x.id, status: x.status, approvals: x.approvals }))));
  console.log('settings:', JSON.stringify(before.settings));
  console.log('policy  :', JSON.stringify(before.policy));
  console.log('audit   :', `count=${auditBefore.count} head=${auditBefore.head.slice(0, 16)}…`);

  // ── PHASE 2: kill -9, restart a FRESH process on the same file ─────────────────
  console.log('\n[2] kill -9 process A');
  await killServer();
  await waitPortFree();
  console.log('[3] boot process B (NO bootstrap) on the same data file');
  const b = await startServer({ bootstrap: false });
  await waitReachable();
  check('restart did NOT reprint an admin password', !b.stdout.some((l) => l.includes('one-time password:')));

  // survived-session probe: reuse putra's OLD cookie; else clean relogin
  putra.setCookie(putraCookieBefore);
  let me2 = await putra.req('GET', '/auth/me');
  let sessionSurvived = me2.status === 200;
  if (!sessionSurvived) {
    const relog = await putra.req('POST', '/auth/login', { username: 'putra', password: newPw });
    if (relog.json?.totpRequired) await putra.req('POST', '/auth/totp', { code: authenticator.generate(secret) }, CLIENT);
    me2 = await putra.req('GET', '/auth/me');
  }
  check('session survived OR clean re-login works', me2.status === 200, `status=${me2.status}`);
  console.log(`     (session ${sessionSurvived ? 'SURVIVED the crash' : 'expired → clean re-login succeeded'})`);

  const after = {
    me: me2.json,
    accounts: (await putra.req('GET', '/admin/accounts')).json,
    requests: (await putra.req('GET', '/requests?scope=all')).json,
    settings: (await putra.req('GET', '/admin/settings')).json,
    policy: (await putra.req('GET', '/admin/policy')).json,
  };
  const auditAfter = auditFromFile();
  const verifyAfter = verifyChain(auditAfter.entries, { head: auditAfter.head });

  // The NEW admin surface (Task 3) must serve the same verifiable chain post-restart.
  const auditList = await putra.req('GET', '/admin/audit?limit=5');
  check('GET /admin/audit serves newest-first entries after restart', auditList.status === 200 && (auditList.json?.items?.length ?? 0) > 0, `status=${auditList.status}`);
  const auditExport = await putra.req('GET', '/admin/audit/export');
  check('GET /admin/audit/export returns a self-verifying chain (verified:true)', auditExport.status === 200 && auditExport.json?.verified === true && auditExport.json?.count === auditAfter.count, `status=${auditExport.status} verified=${auditExport.json?.verified} count=${auditExport.json?.count} vs file=${auditAfter.count}`);

  console.log('\n--- AFTER (post-restart) ---');
  console.log('accounts:', JSON.stringify((after.accounts as any[]).map((x) => ({ id: x.id, role: x.role, isAdmin: x.isAdmin, totpEnrolled: x.totpEnrolled }))));
  console.log('request :', JSON.stringify((after.requests?.items as any[]).map((x) => ({ id: x.id, status: x.status, approvals: x.approvals }))));
  console.log('settings:', JSON.stringify(after.settings));
  console.log('policy  :', JSON.stringify(after.policy));
  console.log('audit   :', `count=${auditAfter.count} head=${auditAfter.head.slice(0, 16)}…`);

  // ── assertions: everything is byte-for-byte equal ──────────────────────────────
  const eq = (x: unknown, y: unknown) => JSON.stringify(x) === JSON.stringify(y);
  check('accounts survived (2, unchanged)', (after.accounts as any[]).length === 2 && eq(before.accounts, after.accounts));
  check('enrolled TOTP factor survived', (after.accounts as any[]).find((x: any) => x.id === 'putra')?.totpEnrolled === true);
  check('request + approval survived (APPLIED)', eq(before.requests, after.requests) && (after.requests?.items as any[])[0]?.status === 'APPLIED');
  check('settings survived (freeze still ON)', (after.settings as any)['freeze.global'] === true && eq(before.settings, after.settings));
  check('policy UNCHANGED (not reset to weaker defaults)', eq(before.policy, after.policy));
  check('audit chain verifies AFTER restart', verifyAfter.code === 0, verifyAfter.message);
  check('audit chain head + length identical across restart', auditAfter.head === auditBefore.head && auditAfter.count === auditBefore.count);

  // ── PHASE 3: re-bootstrap MUST be refused ──────────────────────────────────────
  console.log('\n[4] attempt CCP_BOOTSTRAP=1 against the populated backend');
  await killServer();
  const refusal = await runBootstrapRefusal();
  check('re-bootstrap exits NON-ZERO (refused)', refusal.code !== 0 && refusal.code !== null, `exit=${refusal.code}`);
  check('re-bootstrap printed NO fresh admin password', !refusal.lines.some((l) => l.includes('one-time password:')));
  console.log('     refusal output:', JSON.stringify(refusal.lines.filter((l) => l.toLowerCase().includes('refus') || l.includes('BACKEND_NOT_EMPTY'))));

  // ── verdict ────────────────────────────────────────────────────────────────────
  const failed = results.filter((r) => !r.ok);
  console.log(`\n=== ${failed.length === 0 ? 'ALL PASS' : `${failed.length} FAILED`} (${results.length} checks) ===\n`);
  if (failed.length) { console.log('FAILURES:', JSON.stringify(failed, null, 2)); process.exitCode = 1; }
}

main()
  .catch((e) => { console.error('PROOF ERRORED:', e); process.exitCode = 1; })
  .finally(async () => {
    await killServer().catch(() => undefined);
    try { rmSync(dirname(DATA_FILE), { recursive: true, force: true }); } catch { /* noop */ }
  });
