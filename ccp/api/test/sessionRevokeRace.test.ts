import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../src/store/memoryStore';
import type { ConfigStore, Item, TransactWrite } from '../src/store/configStore';
import { mintSession, resolveSession, killOtherSessions, sha256hex } from '../src/auth/sessions';
import { __setNow } from '../src/clock';
import { accountKey, sessionKey } from '../src/store/schema';
import type { AccountItem } from '../src/store/schema';
import { seed } from './helpers/seed';

/**
 * API-10 / CONC-4 — one defect, filed twice: a revoked session resurrected by the
 * concurrent idle-window slide.
 *
 * `resolveSession` slid the idle window with an unconditional whole-item
 * `store.put(slid)` after two awaited reads. The self-service revocation paths —
 * `DELETE /auth/sessions/:id` and `POST /auth/sessions/revoke-others` — delete session
 * rows WITHOUT bumping `sessionVersion`, deliberately, so that "sign out my other
 * devices" does not sign out the device asking. So an in-flight request on the session
 * being revoked would read the row, watch the delete land, and then recreate it. The
 * revocation was undone, and the resurrected session slid its own window on every
 * subsequent request until absolute expiry.
 *
 * The `sessionVersion`-bumping paths (password reset, admin revoke) were immune, because
 * a resurrected row fails the version check. That is why this was invisible: the two
 * families of revocation sat next to each other and only one of them worked.
 */

const IDLE_SLIDE_PAST = 6 * 60_000; // > SLIDE_GRANULARITY_MS, so the slide actually writes

/** A store that runs `onGet` after every `get` — the interleaving the race needs. */
function racingStore(inner: ConfigStore, onGet: (pk: string, sk: string) => Promise<void>): ConfigStore {
  return {
    async get(pk: string, sk: string): Promise<Item | null> {
      const v = await inner.get(pk, sk);
      await onGet(pk, sk);
      return v;
    },
    put: (item, opts) => inner.put(item, opts),
    query: (pk, prefix, opts) => inner.query(pk, prefix, opts),
    queryGSI1: (gsi1pk, opts) => inner.queryGSI1(gsi1pk, opts),
    transact: (writes: TransactWrite[]) => inner.transact(writes),
    delete: (pk, sk) => inner.delete(pk, sk),
  };
}

/** The seeded account's real `sessionVersion` — minting with a guessed 0 resolves as
 * `version` and every assertion below would then pass for the wrong reason. */
async function sessionVersionOf(store: MemoryStore, userId: string): Promise<number> {
  const k = accountKey(userId);
  return ((await store.get(k.PK, k.SK)) as unknown as AccountItem).sessionVersion;
}

async function setup(): Promise<{ store: MemoryStore; token: string; sha: string }> {
  __setNow(() => 0);
  const store = new MemoryStore();
  await seed(store);
  const token = await mintSession(store, 'lina', await sessionVersionOf(store, 'lina'));
  return { store, token, sha: sha256hex(token) };
}

describe('API-10 / CONC-4 — a revoked session is not resurrected by the slide', () => {
  it('THE RACE: a delete landing between the read and the slide does NOT bring the session back', async () => {
    const { store, token, sha } = await setup();
    const k = sessionKey(sha);

    // Revoke exactly once, after the session row has been read — the in-flight window.
    let revoked = false;
    const racing = racingStore(store, async (pk, sk) => {
      if (!revoked && pk === k.PK && sk === k.SK) {
        revoked = true;
        await store.delete(k.PK, k.SK);
      }
    });

    const res = await resolveSession(racing, token, IDLE_SLIDE_PAST);
    expect(revoked, 'the interleave must actually have fired, or this test proves nothing').toBe(true);
    expect(res.ok, 'a revoked session must not resolve').toBe(false);
    expect(await store.get(k.PK, k.SK), 'the slide must not have recreated the row').toBeNull();
  });

  it('…and the session stays dead on the NEXT request too', async () => {
    // The resurrection was worse than one extra request: the recreated row slid its own
    // idle window from then on, so the session lived to absolute expiry.
    const { store, token, sha } = await setup();
    const k = sessionKey(sha);
    await store.delete(k.PK, k.SK);
    expect((await resolveSession(store, token, IDLE_SLIDE_PAST)).ok).toBe(false);
    expect(await store.get(k.PK, k.SK)).toBeNull();
  });

  it('killOtherSessions revokes for real, even with a request in flight on a victim row', async () => {
    // The row-by-row delete holds the window open across every row, which is what made
    // this likely rather than theoretical.
    __setNow(() => 0);
    const store = new MemoryStore();
    await seed(store);
    const sv = await sessionVersionOf(store, 'lina');
    const keeper = await mintSession(store, 'lina', sv);
    const victim = await mintSession(store, 'lina', sv);
    const keeperSha = sha256hex(keeper);
    const victimKey = sessionKey(sha256hex(victim));

    // Revoke everything except the keeper, mid-flight on the victim.
    let fired = false;
    const racing = racingStore(store, async (pk, sk) => {
      if (!fired && pk === victimKey.PK && sk === victimKey.SK) {
        fired = true;
        await killOtherSessions(store, 'lina', keeperSha);
      }
    });

    const after = await resolveSession(racing, victim, IDLE_SLIDE_PAST);
    expect(fired).toBe(true);
    expect(after.ok, 'the revoked device must be signed out').toBe(false);
    // …and the device that asked is still signed in. That is the whole point of the
    // self-service paths not bumping sessionVersion.
    expect((await resolveSession(store, keeper, 0)).ok).toBe(true);
  });

  it('CONTROL: an unrevoked session still slides — the guard is not just refusing everything', async () => {
    const { store, token, sha } = await setup();
    expect((await resolveSession(store, token, 0)).ok).toBe(true);
    expect((await resolveSession(store, token, IDLE_SLIDE_PAST)).ok).toBe(true);
    const k = sessionKey(sha);
    const row = (await store.get(k.PK, k.SK)) as unknown as { lastSeenAt: string };
    expect(Date.parse(row.lastSeenAt)).toBe(IDLE_SLIDE_PAST); // the write really landed
  });

  it('A LOST RACE BETWEEN TWO LIVE REQUESTS IS NOT A LOGOUT', async () => {
    // The tempting fix — treat any lost condition as "session gone" — trades this bug for
    // a worse one. Slide coalescing makes two of a user's own tabs racing the same write
    // routine, and signing them out over it would be a self-inflicted denial of service.
    const { store, token, sha } = await setup();
    const k = sessionKey(sha);

    // Another request slides the row first, so our ifEquals loses — but the row is alive.
    let raced = false;
    const racing = racingStore(store, async (pk, sk) => {
      if (!raced && pk === k.PK && sk === k.SK) {
        raced = true;
        await store.transact([
          { kind: 'update', pk: k.PK, sk: k.SK, set: { lastSeenAt: new Date(IDLE_SLIDE_PAST - 1).toISOString() } },
        ]);
      }
    });

    const res = await resolveSession(racing, token, IDLE_SLIDE_PAST);
    expect(raced).toBe(true);
    expect(res.ok, 'losing a slide race to your own other tab must not sign you out').toBe(true);
  });
});
