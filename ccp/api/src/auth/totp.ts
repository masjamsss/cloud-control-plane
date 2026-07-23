import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { authenticator } from 'otplib';
import type { AccountItem, InstanceItem, TotpDevice } from '../store/schema';
import { instanceKey } from '../store/schema';
import { isSeniorAnywhere } from '../projects';
import type { ConfigStore } from '../store/configStore';

/**
 * TOTP for approver/lead + any admin. The point of this module is the
 * SecretCipher SEAM: the TOTP secret is stored encrypted (`totp.secretEnc`). The
 * DevAesCipher is AES-256-GCM keyed off env; a KMS implementation lands in a later
 * AWS-gated plan behind this same interface — zero call-site change.
 */

// Tolerate a ±1 step (30s) clock skew between client and server.
authenticator.options = { window: 1 };

export interface SecretCipher {
  enc(plain: string): string;
  dec(blob: string): string;
}

/** AES-256-GCM, key = sha256(CCP_TOTP_KEY). Throws in production if the key is unset. */
export class DevAesCipher implements SecretCipher {
  private readonly key: Buffer;
  constructor(rawKey?: string) {
    const envKey = rawKey ?? process.env.CCP_TOTP_KEY;
    if (!envKey && process.env.NODE_ENV === 'production') {
      throw new Error('CCP_TOTP_KEY must be set in production');
    }
    this.key = createHash('sha256').update(envKey ?? 'dev-only').digest();
  }
  enc(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join('.');
  }
  dec(blob: string): string {
    const [ivB, tagB, ctB] = blob.split('.');
    if (!ivB || !tagB || ctB === undefined) throw new Error('malformed cipher blob');
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(ivB, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(ctB, 'base64')), decipher.final()]).toString('utf8');
  }
}

let _cipher: SecretCipher | null = null;
export function getCipher(): SecretCipher {
  return (_cipher ??= new DevAesCipher());
}
/** Test seam: inject a cipher (or reset with null). */
export function __setCipher(c: SecretCipher | null): void {
  _cipher = c;
}

/**
 * The EFFECTIVE second-factor requirement. An admin-set
 * `totpRequired` wins outright (true forces 2FA for anyone, false exempts anyone
 * — no role floor); when it is `undefined` we fall back to the role default —
 * SENIOR ANYWHERE (approver/lead on ANY project) OR any admin. Reading "senior
 * anywhere" (not just the acting project) closes the gap where an approver-on-one-
 * project could log into another and skip 2FA. For a legacy row `isSeniorAnywhere`
 * reduces to `role !== 'requester'` (single-project shim), so needsTotp is identical
 * pre/post-migration. Every caller — the login step machine, the enrol/verify gates —
 * reads this one helper, so the toggle takes effect everywhere at once.
 */
export function needsTotp(
  account: Pick<AccountItem, 'role' | 'isAdmin' | 'totpRequired' | 'roles' | 'projects' | 'teamId'>,
): boolean {
  return account.totpRequired ?? (isSeniorAnywhere(account) || account.isAdmin === true);
}

/** Baked-generic fallback (ADR-0023) — used until an operator sets an
 * instance name, and if the INSTANCE item is ever absent/unreadable. Mirrors
 * app/src/brand.ts's own generic default so an unconfigured install shows the
 * SAME name in the authenticator app as it does in the browser. */
const DEFAULT_TOTP_ISSUER = 'Cloud Control Plane';

export function generateTotpSecret(): string {
  return authenticator.generateSecret();
}

/**
 * The authenticator-app issuer label, resolved from the INSTANCE item at
 * ENROLLMENT time (ADR-0023 §4.2) — falling back to the baked-generic default
 * when no instance identity has been set yet. Known cosmetic limit (documented,
 * not chased): an authenticator entry created before a later rename keeps its
 * old label until re-enrollment — TOTP issuers are not retroactively editable
 * in any authenticator app.
 */
export async function resolveTotpIssuer(store: ConfigStore): Promise<string> {
  const k = instanceKey();
  const item = (await store.get(k.PK, k.SK)) as InstanceItem | null;
  return item?.name || DEFAULT_TOTP_ISSUER;
}

export function otpauthUri(username: string, secret: string, issuer: string = DEFAULT_TOTP_ISSUER): string {
  return authenticator.keyuri(username, issuer, secret);
}
export function verifyTotpCode(secret: string, code: string): boolean {
  try {
    return authenticator.verify({ token: code, secret });
  } catch {
    return false;
  }
}

/* ── multi-device 2FA (ADR-0024) ─────────────────────────────────────────── */

/** Device cap — self-service add refuses at this count (`DEVICE_LIMIT`). */
export const MAX_TOTP_DEVICES = 5;

/** The synthetic id the shim gives a legacy single-secret row's one device.
 * Never written to the store — a real device write always mints a fresh ulid. */
export const LEGACY_DEVICE_ID = 'legacy';

/** Default name a first device gets, whether via first-login forced
 * enrollment or the legacy-shim projection — kept as one named constant so
 * both paths can never drift apart. */
export const DEFAULT_DEVICE_NAME = 'Authenticator';

/**
 * THE CANONICAL READ PATH for 2FA devices (`rolesOf`-style shim, ADR-0024
 * clause 2). Resolves the stored account shape to one device list:
 *
 *   1. `totpDevices` present   → it, AS-IS (authoritative even when empty —
 *                                 same "present-but-empty wins" rule as
 *                                 `rolesOf`; a fully de-enrolled account must
 *                                 never resurrect a stale legacy secret).
 *   2. else legacy `totp` set  → one synthetic device `{id:'legacy',
 *                                 name:'Authenticator', secretEnc, enrolledAt}`.
 *   3. else                    → `[]`.
 *
 * Every reader of 2FA device state — the login challenge, `publicAccount`,
 * the founding build's founding-complete predicate, admin surfaces, this
 * module's own verify/materialize helpers — MUST go through this, never
 * `account.totp`/`account.totpDevices` directly (contract-pinned,
 * `test/totpDeviceShim.test.ts`, the genericity-guard's grep style).
 */
export function totpDevicesOf(account: Pick<AccountItem, 'totpDevices' | 'totp'>): TotpDevice[] {
  if (account.totpDevices) return account.totpDevices;
  if (account.totp) {
    return [{ id: LEGACY_DEVICE_ID, name: DEFAULT_DEVICE_NAME, secretEnc: account.totp.secretEnc, enrolledAt: account.totp.enrolledAt }];
  }
  return [];
}

/**
 * Verify `code` against EACH enrolled device (≤{@link MAX_TOTP_DEVICES},
 * bounded) — ADR-0024 clause 3, "any device satisfies a challenge." Returns
 * the first matching device, or `null`. A device whose secret fails to
 * decrypt (corrupt blob) is skipped, never thrown — one bad device must
 * never break every other device's login.
 */
export function verifyAnyTotpDevice(devices: TotpDevice[], code: string): TotpDevice | null {
  for (const device of devices) {
    let secret: string;
    try {
      secret = getCipher().dec(device.secretEnc);
    } catch {
      continue;
    }
    if (verifyTotpCode(secret, code)) return device;
  }
  return null;
}

/**
 * The WRITE-BACK shape after a successful challenge against `deviceId`
 * (login verify, or a future re-auth-by-TOTP check that wants to stamp
 * use) — materializes `totpDevices` (idempotent lazy migration, ADR-0024
 * clause 2) and stamps that one device's `lastUsedAt`. Pure; the caller
 * performs the `store.put`. Generic over `T` so a caller holding a richer
 * `AccountItem`-shaped object keeps its other fields untouched.
 */
export function withDeviceUseStamped<T extends Pick<AccountItem, 'totpDevices' | 'totp'>>(
  account: T,
  deviceId: string,
  at: string,
): T {
  const devices = totpDevicesOf(account).map((d) => (d.id === deviceId ? { ...d, lastUsedAt: at } : d));
  const updated: T = { ...account, totpDevices: devices };
  delete (updated as { totp?: unknown }).totp;
  return updated;
}

/**
 * The WRITE-BACK shape after a device LIST mutation (add/remove) —
 * materializes `totpDevices` to exactly `nextDevices` and deletes the legacy
 * `totp` field (idempotent lazy migration, ADR-0024 clause 2). Pure; the
 * caller performs the `store.put` (and any `accountVersion` bump).
 */
export function withDevices<T extends Pick<AccountItem, 'totpDevices' | 'totp'>>(account: T, nextDevices: TotpDevice[]): T {
  const updated: T = { ...account, totpDevices: nextDevices };
  delete (updated as { totp?: unknown }).totp;
  return updated;
}
