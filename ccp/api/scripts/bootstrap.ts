import { randomBytes } from 'node:crypto';
import type { ConfigStore } from '../src/store/configStore';
import type { AccountItem, InstanceItem } from '../src/store/schema';
import { accountKey, accountsGsi, instanceKey } from '../src/store/schema';
import { hashPassword } from '../src/auth/credentials';
import { nowIso } from '../src/clock';
import { InstanceBody } from '../src/routes/instance';

/**
 * First-boot provisioning (spec §9). Seeds exactly ONE Lead (`putra`) that is an
 * admin and MUST change its password on first sign-in. The password is random and
 * emitted to stdout ONLY — the documented `ccp-lead` default never reaches the
 * server (ADMIN-8/ACCT-4). Idempotent like ensureSeeded: refuses if ANY account
 * already exists.
 */

export type BootstrapIo = { print: (line: string) => void };

export type BootstrapResult = { ok: true; username: string } | { ok: false; reason: string };

export async function bootstrap(store: ConfigStore, io: BootstrapIo = { print: (s) => console.log(s) }): Promise<BootstrapResult> {
  const existing = await store.queryGSI1(accountsGsi());
  if (existing.length > 0) {
    io.print('ccp-api bootstrap: refused — an account already exists.');
    return { ok: false, reason: 'BACKEND_NOT_EMPTY' };
  }

  const username = 'putra';
  const password = randomBytes(9).toString('base64url');
  const account: AccountItem = {
    ...accountKey(username),
    id: username,
    username,
    displayName: 'Putra',
    // The root-of-trust admin is all-projects, in the new canonical shape: a single
    // `'*'` binding = lead on every registered project. Later per-project grants are
    // dual-controlled. (Replaces the legacy `role:'lead' + projects:['*']` pair.)
    // No `teamId` (data-birth spec §5): `platform` was a dangling id — first boot
    // never seeds a `TeamItem`, and a team is inert for a lead anyway
    // (app-lib/permissions.ts `canRequest` bypasses team scoping for approvers/leads)
    // — so first boot no longer bakes ANY team id into the founding admin.
    roles: { '*': { role: 'lead' } },
    status: 'active',
    createdAt: nowIso(),
    createdBy: 'system',
    mustChangePassword: true, // the one-time password must be replaced on first sign-in
    isAdmin: true, // bootstrap admin (ADR-0011)
    credential: { algo: 'argon2id', hash: await hashPassword(password) },
    failedAttempts: 0,
    sessionVersion: 1,
    GSI1PK: accountsGsi(),
    GSI1SK: username,
  };
  await store.put(account, { ifNotExists: true });

  io.print(`ccp-api bootstrap: Lead created.`);
  io.print(`  username: ${username}`);
  io.print(`  one-time password: ${password}`);
  io.print(`  (change it on first sign-in — this password is shown ONCE)`);
  return { ok: true, username };
}

/**
 * Instance-identity first-boot seed (ADR-0023 §4.2) — the SAME first-boot-
 * declaration pattern as the Lead account above: runs only during the one
 * ephemeral `CCP_BOOTSTRAP=1` boot, and only if the installer's `.env`
 * carries `CCP_INSTANCE_NAME`. `ifNotExists: true` makes it a true seed,
 * never a reset — a later `install.sh` re-run (or a stale env value left over
 * after a Settings rename) can never clobber a live identity. Not gated on
 * `bootstrap()`'s own account-emptiness check: an operator may run this
 * first-boot pass without ever wanting the seeded Lead re-provisioned, but
 * the identity seed is independent of accounts existing — it only cares
 * whether an INSTANCE row exists yet.
 */
export async function seedInstanceIdentity(
  store: ConfigStore,
  env: NodeJS.ProcessEnv = process.env,
  io: BootstrapIo = { print: (s) => console.log(s) },
): Promise<void> {
  const name = env.CCP_INSTANCE_NAME?.trim();
  if (!name) return; // nothing declared — the baked-generic default stands
  const k = instanceKey();
  if (await store.get(k.PK, k.SK)) return; // never overwrite a live identity

  const parsed = InstanceBody.safeParse({ name, tagline: env.CCP_INSTANCE_TAGLINE ?? '' });
  if (!parsed.success) {
    io.print(`ccp-api bootstrap: CCP_INSTANCE_NAME/CCP_INSTANCE_TAGLINE failed validation — skipping the instance-identity seed (the baked-generic default stands). ${parsed.error.issues.map((i) => i.message).join('; ')}`);
    return;
  }
  const item: InstanceItem = {
    ...k,
    name: parsed.data.name,
    tagline: parsed.data.tagline,
    version: 1,
    updatedBy: 'system',
    updatedAt: nowIso(),
  };
  await store.put(item, { ifNotExists: true });
  io.print(`ccp-api bootstrap: instance identity seeded — "${item.name}"${item.tagline ? ` (${item.tagline})` : ''}`);
}
