import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/index';
import { MemoryStore } from '../src/store/memoryStore';
import type { ConfigStore } from '../src/store/configStore';
import { accountKey, type AccountItem, type AuditItem } from '../src/store/schema';
import {
  __setKnownProjects,
  ALL_PROJECTS,
  isBoundToProject,
  isSeniorAnywhere,
  projectsOf,
  roleFor,
  rolesOf,
  teamFor,
} from '../src/projects';
import { needsTotp } from '../src/auth/totp';
import { canSignStep, isEligibleApprover } from '../src/domain/eligibility';
import { seed, seedAccount, sessionCookieFor } from './helpers/seed';

/**
 * PER-ACCOUNT (per-project) AUTHORIZATION — the SERVER half (0014 dim-5, security-critical).
 * Closes the audited gap where any approver/lead was a super-admin across EVERY project:
 * a role is now PER project (`roles: {projectId | '*': {role, teamId?}}`), enforced at every
 * point through `roleFor`. This suite is the adversarial checklist as regression tests. The
 * back-compat proof is the WHOLE existing suite staying green on legacy-shaped seed rows;
 * this file proves the NEW semantics that legacy shapes cannot express.
 */

/* Fixture builders reading a partial account (the helpers accept a partial). */
const acct = (over: Partial<AccountItem>): AccountItem =>
  ({
    ...accountKey(over.id ?? 'x'),
    id: over.id ?? 'x',
    username: over.id ?? 'x',
    displayName: over.id ?? 'x',
    status: 'active',
    createdAt: '2026-07-11T00:00:00.000Z',
    createdBy: 'system',
    mustChangePassword: false,
    isAdmin: false,
    credential: { algo: 'argon2id', hash: 'x' },
    failedAttempts: 0,
    sessionVersion: 1,
    totp: { secretEnc: 'enc', enrolledAt: '2026-07-11T00:00:00.000Z' },
    ...over,
  }) as AccountItem;

describe('the canonical shim — rolesOf/roleFor/teamFor across all three legacy shapes + the new map', () => {
  it('shape 1 (new): a roles map is returned verbatim, and roleFor/teamFor read it per project', () => {
    const a = acct({ roles: { sample: { role: 'lead', teamId: 'platform' }, acme: { role: 'requester', teamId: 'app-platform' } } });
    expect(rolesOf(a)).toEqual({ sample: { role: 'lead', teamId: 'platform' }, acme: { role: 'requester', teamId: 'app-platform' } });
    expect(roleFor(a, 'sample')).toBe('lead');
    expect(roleFor(a, 'acme')).toBe('requester');
    expect(roleFor(a, 'nope')).toBeUndefined(); // not a member → undefined (fail closed)
    expect(teamFor(a, 'sample')).toBe('platform');
    expect(teamFor(a, 'acme')).toBe('app-platform');
    expect(projectsOf(a).sort()).toEqual(['acme', 'sample']);
  });

  it('shape 2 (legacy membership list): `projects:[a,b] role:approver` → BOTH approver, team on each (never narrowed/widened)', () => {
    const a = acct({ role: 'approver', teamId: 'app-platform', projects: ['sample', 'acme'], roles: undefined });
    expect(rolesOf(a)).toEqual({ sample: { role: 'approver', teamId: 'app-platform' }, acme: { role: 'approver', teamId: 'app-platform' } });
    expect(roleFor(a, 'sample')).toBe('approver');
    expect(roleFor(a, 'acme')).toBe('approver');
    expect(isBoundToProject(a, 'sample')).toBe(true);
    expect(isBoundToProject(a, 'other')).toBe(false);
  });

  it('shape 2 (wildcard): `projects:[*] role:lead` → lead on EVERY project (all-projects scope)', () => {
    const a = acct({ role: 'lead', teamId: 'platform', projects: [ALL_PROJECTS] });
    expect(rolesOf(a)).toEqual({ '*': { role: 'lead', teamId: 'platform' } });
    expect(roleFor(a, 'sample')).toBe('lead');
    expect(roleFor(a, 'anything-at-all')).toBe('lead');
    expect(isBoundToProject(a, 'whatever')).toBe(true);
    expect(projectsOf(a)).toEqual(['*']);
  });

  it('shape 3 (bare legacy row, no projects): member of NOTHING (arm 3 retired, data-birth spec §5 — no baked estate left to fail closed onto; a real legacy store never reaches this arm at runtime, domain/settlement.ts materializes it first)', () => {
    const a = acct({ role: 'approver', teamId: 'app-platform' });
    expect(rolesOf(a)).toEqual({});
    expect(roleFor(a, 'sample')).toBeUndefined();
    expect(roleFor(a, 'other')).toBeUndefined();
    expect(isBoundToProject(a, 'sample')).toBe(false);
    expect(isBoundToProject(a, 'other')).toBe(false);
  });

  it('roleFor prefers the explicit project entry, then falls back to the `*` wildcard entry', () => {
    const a = acct({ roles: { '*': { role: 'requester' }, sample: { role: 'lead', teamId: 'platform' } } });
    expect(roleFor(a, 'sample')).toBe('lead'); // explicit wins over '*'
    expect(roleFor(a, 'elsewhere')).toBe('requester'); // '*' fallback
  });

  it('an EMPTY roles map means member of NOTHING — it never resurrects the legacy scalar/default (fail closed)', () => {
    // The exact shape a revoke of the account's LAST binding leaves behind. Before this
    // rule, `{roles:{}}` fell through the shim to the legacy default and the account
    // silently came back as a requester on sample — the remove appeared not to work.
    const a = acct({ roles: {}, role: 'lead', teamId: 'platform' });
    expect(rolesOf(a)).toEqual({});
    expect(roleFor(a, 'sample')).toBeUndefined();
    expect(isBoundToProject(a, 'sample')).toBe(false);
    expect(isSeniorAnywhere(a)).toBe(false);
    expect(projectsOf(a)).toEqual([]);
  });
});

describe('needsTotp is IDENTICAL pre/post-shim (the 2FA floor never regresses)', () => {
  // Legacy-shaped probes (the exact truth table the pre-migration code asserted),
  // now on the MATERIALIZED shape (an explicit `roles` map) — the shape every
  // account actually has by the time `needsTotp` reads it in the live request path
  // (see the next test's note: a truly bare row never reaches this function).
  it('materialized legacy-scalar shape reproduces the pre-migration truth table', () => {
    expect(needsTotp({ roles: { sample: { role: 'requester' } }, isAdmin: false })).toBe(false);
    expect(needsTotp({ roles: { sample: { role: 'approver' } }, isAdmin: false })).toBe(true);
    expect(needsTotp({ roles: { sample: { role: 'lead' } }, isAdmin: false })).toBe(true);
    expect(needsTotp({ roles: { sample: { role: 'requester' } }, isAdmin: true })).toBe(true);
    expect(needsTotp({ roles: { sample: { role: 'requester' } }, isAdmin: false, totpRequired: true })).toBe(true);
    expect(needsTotp({ roles: { sample: { role: 'approver' } }, isAdmin: false, totpRequired: false })).toBe(false);
  });

  // data-birth §5: `rolesOf`'s arm 3 (a BARE row — no `roles`, no `projects`) is
  // retired from `{sample: {role,teamId}}` to `{}` — so `isSeniorAnywhere`/`needsTotp`
  // on a raw bare object can no longer see the role at all. This is a REAL
  // behavior change to the pure function, called out explicitly rather than
  // silently accepted: it is safe in the live system ONLY because
  // `withSettlement` (middleware/session.ts) now runs before `withSession` in the
  // global chain, so by the time routes/auth.ts's login handler re-fetches the
  // account and calls `needsTotp`, a real store's bare row has ALREADY been
  // materialized into the explicit shape the test above covers — `needsTotp`'s
  // ONE call site (routes/auth.ts:119) never actually observes an unmaterialized
  // row. This test pins that a bare object is fail-closed (false, not a crash) —
  // NOT that it still implies 2FA the old way — so a future caller of `needsTotp`
  // that bypasses settlement (e.g. a new call site fed a raw store row) fails
  // LOUD (false when a human expects true is instantly visible in review), not
  // silently open-by-omission.
  it('a BARE object (no roles, no projects) is fail-closed false, not a crash — real rows never reach here unmaterialized (domain/settlement.ts runs before every request)', () => {
    expect(needsTotp({ role: 'approver', isAdmin: false })).toBe(false);
    expect(needsTotp({ role: 'lead', isAdmin: false })).toBe(false);
    // isAdmin and an explicit totpRequired pin are independent of role resolution
    // and still work correctly on a bare object.
    expect(needsTotp({ role: 'requester', isAdmin: true })).toBe(true);
    expect(needsTotp({ role: 'requester', isAdmin: false, totpRequired: true })).toBe(true);
  });

  it('SENIOR-ANYWHERE: an approver on ONE project cannot skip 2FA when logging into ANOTHER', () => {
    // The exact hole the per-project shim must NOT open: a role map that is requester on the
    // acting project but approver elsewhere still requires a second factor.
    const dual = { isAdmin: false, roles: { acme: { role: 'approver' as const }, sample: { role: 'requester' as const } } };
    expect(isSeniorAnywhere(dual)).toBe(true);
    expect(needsTotp(dual)).toBe(true);
    // a pure requester everywhere does not.
    expect(needsTotp({ isAdmin: false, roles: { sample: { role: 'requester' }, acme: { role: 'requester' } } })).toBe(false);
  });
});

/* ── integration: two registered projects, cross-project isolation ─────────────────── */

const DRAFT = {
  operationId: 'ebs-grow', // l1_with_guardrails → ladder [L2, L3]
  targetAddress: 'aws_ebs_volume.dwh01',
  params: { volume: 'aws_ebs_volume.dwh01', new_size_gib: 250 },
  justification: 'grow the volume to 250 GiB for month-end load',
  schedule: { kind: 'now' as const },
};

function hdrs(cookie: string, project?: string, json = false): Record<string, string> {
  const h: Record<string, string> = { 'x-ccp-client': 'ccp-spa', cookie };
  if (project) h['x-ccp-project'] = project;
  if (json) h['content-type'] = 'application/json';
  return h;
}

/** Two ready projects (sample + acme), each with teams + policy; sample also gets the standard estate. */
async function twoProjectEstate(): Promise<{ store: ConfigStore; app: ReturnType<typeof createApp> }> {
  __setKnownProjects(['sample', 'acme']);
  const store = new MemoryStore();
  await seed(store, 'sample'); // sample estate (teams + policy + the 4 legacy accounts, all sample-only)
  await seed(store, 'acme'); // acme teams + policy (re-puts the 4 legacy accounts — still sample-only)
  return { store, app: createApp(store) };
}

afterEach(() => __setKnownProjects(['sample']));

describe('cross-project escalation is impossible — a senior on A is NOT a signer on B', () => {
  it('isEligibleApprover / canSignStep read the per-project role: approver-on-sample is a requester (ineligible) on acme', () => {
    const dwi = acct({ id: 'dwi', roles: { sample: { role: 'approver', teamId: 'app-platform' }, acme: { role: 'requester', teamId: 'app-platform' } } });
    // eligible to sign on sample…
    expect(isEligibleApprover(dwi, 'sample', 'rai')).toBe(true);
    expect(canSignStep('L2', roleFor(dwi, 'sample'))).toBe(true);
    // …but a plain requester (hence ineligible) on acme.
    expect(isEligibleApprover(dwi, 'acme', 'rai')).toBe(false);
    expect(canSignStep('L2', roleFor(dwi, 'acme'))).toBe(false);
    expect(canSignStep('L3', roleFor(dwi, 'acme'))).toBe(false);
  });

  it('the LIVE approve path refuses a cross-project senior: approver-on-sample → 403 FORBIDDEN_ROLE approving on acme', async () => {
    const { store, app } = await twoProjectEstate();
    // rai: a requester ON acme (submits there). dwi: approver on sample, only a requester on acme.
    // ratu: a real lead ON acme, so the request is genuinely approvable by the RIGHT person.
    await seedAccount(store, { id: 'rai', role: 'requester', teamId: 'erp-basis', isAdmin: false, roles: { acme: { role: 'requester', teamId: 'erp-basis' } } });
    await seedAccount(store, { id: 'dwi', role: 'approver', teamId: 'app-platform', isAdmin: false, roles: { sample: { role: 'approver', teamId: 'app-platform' }, acme: { role: 'requester', teamId: 'app-platform' } } });
    await seedAccount(store, { id: 'ratu', role: 'lead', teamId: 'platform', isAdmin: false, roles: { acme: { role: 'lead', teamId: 'platform' } } });

    const created = await (
      await app.request('/requests', { method: 'POST', headers: hdrs(await sessionCookieFor(store, 'rai'), 'acme', true), body: JSON.stringify(DRAFT) })
    ).json();
    expect(created.projectId).toBe('acme'); // request tagging (below) — the submit stamped it

    // dwi is a MEMBER of acme (so passes requireProjectMembership) but only a REQUESTER there:
    // the per-project role gate refuses the approval outright.
    const dwiCookie = await sessionCookieFor(store, 'dwi');
    const approve = await app.request(`/requests/${created.id}/approve`, { method: 'POST', headers: hdrs(dwiCookie, 'acme') });
    expect(approve.status).toBe(403);
    expect((await approve.json()).code).toBe('FORBIDDEN_ROLE');

    // and the pending-list gate refuses dwi too (a requester cannot see acme's approvals queue)
    const pending = await app.request('/requests?scope=pending', { headers: hdrs(dwiCookie, 'acme') });
    expect(pending.status).toBe(403);

    // feasibility counted only acme's real signer (ratu), NOT the cross-project dwi.
    expect(created.eligibleApprovers).toBe(1);
  });

  it("the header-swap attack: roles:{sample:lead} calling acme is 403 PROJECT_SCOPE — a real ROLE boundary for requests, but on /admin only a membership formality (isAdmin is GLOBAL by design)", async () => {
    const { store, app } = await twoProjectEstate();
    // a NEW-shape lead+admin bound ONLY to sample — the modern equivalent of the legacy PoC.
    await seedAccount(store, { id: 'samplelead', role: 'lead', teamId: 'platform', isAdmin: true, roles: { sample: { role: 'lead', teamId: 'platform' } } });
    const cookie = await sessionCookieFor(store, 'samplelead');

    // UNBOUND → both surfaces refuse the bare header swap.
    const list = await app.request('/requests?scope=all', { headers: hdrs(cookie, 'acme') });
    expect(list.status).toBe(403);
    expect((await list.json()).code).toBe('PROJECT_SCOPE');

    const admin = await app.request('/admin/policy', { headers: hdrs(cookie, 'acme') });
    expect(admin.status).toBe(403);
    expect((await admin.json()).code).toBe('PROJECT_SCOPE');

    // …and full access on the project they ARE bound to.
    expect((await app.request('/requests?scope=all', { headers: hdrs(cookie, 'sample') })).status).toBe(200);
    expect((await app.request('/admin/policy', { headers: hdrs(cookie, 'sample') })).status).toBe(200);

    // HONESTY CLAUSE — do NOT read the admin 403 above as per-project ADMIN isolation.
    // isAdmin is a GLOBAL capability by design (one account directory, one admin plane):
    // an admin can grant THEMSELVES a requester binding on any registered project (a
    // lateral, non-raising grant classifies tightening → applies immediately, no second
    // admin) and then reach that project's admin surface. So the PROJECT_SCOPE 403 on
    // /admin is a membership formality an admin lifts single-handedly — real isolation
    // for admins would need isAdmin to become per-project, which is out of scope here.
    const selfGrant = await app.request('/admin/accounts/samplelead', {
      method: 'PATCH',
      headers: hdrs(cookie, 'sample', true),
      body: JSON.stringify({ setRole: { projectId: 'acme', role: 'requester', teamId: 'app-platform' } }),
    });
    expect(selfGrant.status).toBe(200); // tightening → immediate, single-admin
    expect((await app.request('/admin/policy', { headers: hdrs(cookie, 'acme') })).status).toBe(200); // admin reach is global

    // The NON-admin gates did NOT weaken: on acme this account is a plain requester, so
    // the senior-scoped request queues still refuse it — by ROLE, the gate with real teeth.
    const listAfter = await app.request('/requests?scope=all', { headers: hdrs(cookie, 'acme') });
    expect(listAfter.status).toBe(403);
    expect((await listAfter.json()).code).toBe('FORBIDDEN_ROLE');
  });
});

describe('request tagging — projectId is stored on submit and injected for legacy rows', () => {
  it('a fresh submit stores projectId; a read of a legacy (untagged) row reports the acting project', async () => {
    const { store, app } = await twoProjectEstate();
    await seedAccount(store, { id: 'rai', role: 'requester', teamId: 'erp-basis', isAdmin: false, roles: { acme: { role: 'requester', teamId: 'erp-basis' } } });

    const created = await (
      await app.request('/requests', { method: 'POST', headers: hdrs(await sessionCookieFor(store, 'rai'), 'acme', true), body: JSON.stringify(DRAFT) })
    ).json();
    expect(created.projectId).toBe('acme');
    // durably stored on the row, not just the projection
    const stored = (await store.get(`P#acme#REQ#${created.id}`, 'META')) as { projectId?: string };
    expect(stored.projectId).toBe('acme');

    // a legacy row written WITHOUT projectId still reports its project on read (from the key scope)
    await store.put({
      ...stored,
      projectId: undefined,
    } as never);
    const reread = await (await app.request(`/requests/${created.id}`, { headers: hdrs(await sessionCookieFor(store, 'rai'), 'acme') })).json();
    expect(reread.projectId).toBe('acme'); // injected by the projection
  });
});

describe('per-project last-active-lead guard', () => {
  it('revoking the LAST active lead of a project is refused even when OTHER projects have leads', async () => {
    __setKnownProjects(['sample', 'acme']);
    const store = new MemoryStore();
    await seed(store); // putra (lead+admin) & lina (lead) on sample
    // boss: the acting admin — lead on sample, isAdmin, but NOT a lead on acme.
    await seedAccount(store, { id: 'boss', role: 'lead', teamId: 'platform', isAdmin: true, roles: { sample: { role: 'lead', teamId: 'platform' } } });
    // duo: the ONLY lead on acme (a requester on sample).
    await seedAccount(store, { id: 'duo', role: 'lead', teamId: 'platform', isAdmin: false, roles: { sample: { role: 'requester', teamId: 'app-platform' }, acme: { role: 'lead', teamId: 'platform' } } });
    const app = createApp(store);
    const boss = await sessionCookieFor(store, 'boss');

    // revoking duo's acme lead → refused (acme would have zero active leads), though sample has leads.
    const revoke = await app.request('/admin/accounts/duo', {
      method: 'PATCH', headers: hdrs(boss, 'sample', true), body: JSON.stringify({ revoke: { projectId: 'acme' } }),
    });
    expect(revoke.status).toBe(422);
    expect((await revoke.json()).code).toBe('LAST_LEAD_GUARD');

    // downgrading duo on acme (lead → approver) is the SAME loss → also refused.
    const downgrade = await app.request('/admin/accounts/duo', {
      method: 'PATCH', headers: hdrs(boss, 'sample', true), body: JSON.stringify({ setRole: { projectId: 'acme', role: 'approver' } }),
    });
    expect(downgrade.status).toBe(422);
    expect((await downgrade.json()).code).toBe('LAST_LEAD_GUARD');

    // add a SECOND acme lead → now the revoke is allowed (acme still has a lead afterwards).
    await seedAccount(store, { id: 'duo2', role: 'lead', teamId: 'platform', isAdmin: false, roles: { acme: { role: 'lead', teamId: 'platform' } } });
    const ok = await app.request('/admin/accounts/duo', {
      method: 'PATCH', headers: hdrs(boss, 'sample', true), body: JSON.stringify({ revoke: { projectId: 'acme' } }),
    });
    expect(ok.status).toBe(200);
    const duoAcc = (await store.get(accountKey('duo').PK, 'META')) as AccountItem;
    expect(roleFor(duoAcc, 'acme')).toBeUndefined(); // membership on acme is gone
    expect(roleFor(duoAcc, 'sample')).toBe('requester'); // sample binding untouched
  });

  it('revoking the account’s LAST binding leaves it a member of NOTHING — not a default requester on sample', async () => {
    __setKnownProjects(['sample', 'acme']);
    const store = new MemoryStore();
    await seed(store);
    // solo: requester on acme ONLY (new-shape row) — no lead anywhere, so no guard applies.
    await seedAccount(store, { id: 'solo', role: 'requester', teamId: 'app-platform', isAdmin: false, roles: { acme: { role: 'requester', teamId: 'app-platform' } } });
    const app = createApp(store);
    const boss = await sessionCookieFor(store, 'putra');

    const res = await app.request('/admin/accounts/solo', {
      method: 'PATCH', headers: hdrs(boss, 'sample', true), body: JSON.stringify({ revoke: { projectId: 'acme' } }),
    });
    expect(res.status).toBe(200);
    const acc = (await store.get(accountKey('solo').PK, 'META')) as AccountItem;
    expect(rolesOf(acc)).toEqual({}); // the stored map is empty…
    expect(roleFor(acc, 'sample')).toBeUndefined(); // …and does NOT fall back to requester-on-sample
    expect(roleFor(acc, 'acme')).toBeUndefined();
  });
});

describe('PATCH mass-assignment discipline (per-project verbs only)', () => {
  it('the requester id at submit is ALWAYS the session user, never the body — even with a spoofed field', async () => {
    const { store, app } = await twoProjectEstate();
    await seedAccount(store, { id: 'rai', role: 'requester', teamId: 'erp-basis', isAdmin: false, roles: { acme: { role: 'requester', teamId: 'erp-basis' } } });
    const created = await (
      await app.request('/requests', {
        method: 'POST',
        headers: hdrs(await sessionCookieFor(store, 'rai'), 'acme', true),
        body: JSON.stringify({ ...DRAFT, requester: 'putra', teamId: 'platform' }), // spoof attempt
      })
    ).json();
    expect(created.requester).toBe('rai'); // session identity wins
  });

  it('a whole-map `roles` body, a `*` verb target, and an unregistered projectId are all refused (422)', async () => {
    const { store, app } = await twoProjectEstate();
    await seedAccount(store, { id: 'boss', role: 'lead', teamId: 'platform', isAdmin: true, roles: { sample: { role: 'lead', teamId: 'platform' } } });
    const boss = await sessionCookieFor(store, 'boss');
    for (const body of [
      { roles: { acme: { role: 'lead' } } }, // whole-map replacement — stripped → refine fails
      { setRole: { projectId: '*', role: 'lead' } }, // wildcard verb target
      { setRole: { projectId: 'ghost', role: 'lead' } }, // unregistered project
      { setRole: { projectId: 'acme', role: 'lead', evil: true } }, // smuggled key inside the verb (strict)
    ]) {
      const res = await app.request('/admin/accounts/lina', { method: 'PATCH', headers: hdrs(boss, 'sample', true), body: JSON.stringify(body) });
      expect(res.status, JSON.stringify(body)).toBe(422);
    }
  });
});

describe('dual-control replay safety — a pending account proposal cannot clobber a concurrent account change (the accountVersion drift guard)', () => {
  /** Two-project estate + gita, the SECOND distinct active admin that acking requires. */
  async function estateWithSecondAdmin() {
    const { store, app } = await twoProjectEstate();
    await seedAccount(store, { id: 'gita', role: 'lead', teamId: 'platform', isAdmin: true });
    return { store, app, admin1: await sessionCookieFor(store, 'putra'), admin2: await sessionCookieFor(store, 'gita') };
  }
  const patchAcc = (app: Awaited<ReturnType<typeof twoProjectEstate>>['app'], cookie: string, id: string, body: unknown) =>
    app.request(`/admin/accounts/${id}`, { method: 'PATCH', headers: hdrs(cookie, 'sample', true), body: JSON.stringify(body) });

  it('REGRESSION: acking a stale grant to an ALREADY-SENIOR account must not silently revert a concurrent revoke — 409 STALE_PROPOSAL and the revoke sticks', async () => {
    const { store, app, admin1, admin2 } = await estateWithSecondAdmin();
    // multi is already senior (lead on sample), so the acme grant does NOT newly grant senior
    // capacity → no sessionVersion bump. Before the accountVersion guard, exactly this
    // apply replayed its whole propose-time roles snapshot UNGUARDED at ack.
    await seedAccount(store, { id: 'multi', role: 'lead', teamId: 'platform', isAdmin: false, roles: { sample: { role: 'lead', teamId: 'platform' } } });

    // admin1 proposes the loosening grant (new lead membership on acme) → PENDING.
    const propose = await patchAcc(app, admin1, 'multi', { setRole: { projectId: 'acme', role: 'lead', teamId: 'platform' } });
    expect(propose.status).toBe(202);
    const pending = await propose.json();
    expect(pending.status).toBe('PENDING');

    // Concurrently, admin2 revokes multi's OTHER (sample) binding — tightening, applies
    // immediately (putra + lina still lead sample, so the last-lead guard does not fire).
    expect((await patchAcc(app, admin2, 'multi', { revoke: { projectId: 'sample' } })).status).toBe(200);
    const afterRevoke = (await store.get(accountKey('multi').PK, 'META')) as AccountItem;
    expect(rolesOf(afterRevoke)).toEqual({}); // member of NOTHING now

    // The ack would replay the propose-time snapshot {sample:lead, acme:lead}. It MUST fail
    // stale — never silently resurrect the revoked sample binding (the F1 exploit).
    const ack = await app.request(`/admin/config-changes/${pending.id}/ack`, { method: 'POST', headers: hdrs(admin2, 'sample', true) });
    expect(ack.status).toBe(409);
    expect((await ack.json()).code).toBe('STALE_PROPOSAL');

    const acc = (await store.get(accountKey('multi').PK, 'META')) as AccountItem;
    expect(roleFor(acc, 'sample')).toBeUndefined(); // the revoke STUCK
    expect(roleFor(acc, 'acme')).toBeUndefined(); // and the stale grant did not half-apply
  });

  it('no false positives: the same already-senior grant with NO interleaved change still acks 200 and applies — and sessionVersion does NOT bump (narrow TOTP-gate semantics preserved)', async () => {
    const { store, app, admin1, admin2 } = await estateWithSecondAdmin();
    await seedAccount(store, { id: 'multi', role: 'lead', teamId: 'platform', isAdmin: false, roles: { sample: { role: 'lead', teamId: 'platform' } } });
    const before = (await store.get(accountKey('multi').PK, 'META')) as AccountItem;

    const pending = await (await patchAcc(app, admin1, 'multi', { setRole: { projectId: 'acme', role: 'lead', teamId: 'platform' } })).json();
    expect(pending.status).toBe('PENDING');
    const ack = await app.request(`/admin/config-changes/${pending.id}/ack`, { method: 'POST', headers: hdrs(admin2, 'sample', true) });
    expect(ack.status).toBe(200);

    const acc = (await store.get(accountKey('multi').PK, 'META')) as AccountItem;
    expect(roleFor(acc, 'sample')).toBe('lead'); // untouched
    expect(roleFor(acc, 'acme')).toBe('lead'); // the grant landed
    expect(acc.sessionVersion).toBe(before.sessionVersion); // already-senior → no TOTP gap → no bump
  });
});
