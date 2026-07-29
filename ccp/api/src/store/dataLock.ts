import { closeSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { hostname } from 'node:os';

/**
 * CONC-7 / DATA-9 — one writer per data file, enforced at open.
 *
 * `FileStore` loads the whole snapshot into a private in-memory `Map` and, on every
 * mutation, rewrites the ENTIRE file from that map. Nothing stopped a second process
 * opening the same file. Two of them never see each other's writes and alternately
 * overwrite the whole store: total, silent, mutual lost updates across accounts,
 * sessions, requests and both audit chains — behind green health checks.
 *
 * That is not a theoretical second process. A rolling deploy starts the new container
 * before stopping the old one; an operator scales the service to 2 replicas; a stray
 * `npm run dev` points at the production data dir. And `scripts/restore.ts` is a second
 * writer by design: it installs a backup atomically, and then the running server's next
 * persist — a session slide from any authenticated request will do — rewrites the file
 * from memory and silently discards the restore.
 *
 * Every careful in-process guarantee is void across processes, which is what makes this
 * worse than it looks: the chain-head CAS, the `ifEquals` claims, the whole optimistic
 * concurrency story are evaluated against each process's private map.
 *
 * ## Why a pid file rather than `flock`
 *
 * An OS advisory lock would be strictly better — the kernel releases it when the process
 * dies, so `kill -9`, a container OOM and a host reboot all clean up by themselves. Node
 * exposes no `flock`, and taking a native dependency for it would cost more than it buys
 * in a codebase whose whole posture is "no dependency you cannot read". So: `O_EXCL`
 * create, holder identity inside, and an explicit answer for every way it can go stale.
 *
 * ## Staleness: a HEARTBEAT, not an identity check
 *
 * A lock that survives its holder wedges the service — the ERR-2 shape, where `running`
 * was permanent and a crash left a request un-appliable forever. A lock that clears itself
 * on a guess defeats its own purpose.
 *
 * The obvious discriminator — "is the recorded pid alive on the recorded host?" — is wrong
 * in exactly the deployment this product documents as its default. Under
 * `docker compose`, the container's hostname IS its id, so a crash-restart arrives with a
 * NEW hostname and can never verify the old one: every OOM kill would wedge the next boot.
 * Worse in the other direction: containers have their own pid namespace, and pid 1 always
 * exists, so a stale lock recorded by a dead container's pid 1 looks *alive* to the
 * replacement container's check. The identity test fails open and closed at once.
 *
 * So the holder **heartbeats**: it rewrites the lock's `since` every
 * {@link HEARTBEAT_MS}, and a lock whose `since` is older than {@link STALE_MS} is stale
 * no matter which host, container, or pid namespace wrote it. That is a property of the
 * file, checkable by anyone, and it bounds the post-crash wedge to about two minutes
 * instead of forever.
 *
 * The pid check survives only as a FAST PATH, and only in the direction that is safe: a
 * dead pid on the same host lets a bare-metal restart recover in milliseconds rather than
 * waiting out the stale window. It can only ever ADD a takeover, never block one — so
 * container pid-1 ambiguity cannot keep a genuinely stale lock alive.
 *
 *  - Heartbeat older than STALE_MS → take over, loudly. The holder is gone or wedged.
 *  - Same host, pid not alive → take over, loudly (the fast path).
 *  - Otherwise → refuse. Something is writing this file right now.
 *  - Unreadable/corrupt lock → refuse until it goes stale by time; a holder we cannot read
 *    is one we cannot rule out, but it still cannot hold the file forever.
 *
 * `CCP_DATA_LOCK_TAKEOVER=1` remains the operator's override for the impatient case.
 */

const TAKEOVER_ENV = 'CCP_DATA_LOCK_TAKEOVER';

/** How often the holder refreshes its claim. */
export const HEARTBEAT_MS = 30_000;
/**
 * How long a claim may go unrefreshed before anyone may take it. Four missed beats: long
 * enough that a paused container, a long GC or a slow disk never loses a lock it still
 * holds, short enough that a crashed process does not block the next boot for long.
 */
export const STALE_MS = 4 * HEARTBEAT_MS;

export interface LockHolder {
  pid: number;
  host: string;
  since: string;
}

export class DataLockError extends Error {
  constructor(
    message: string,
    /** The holder we found, when the lock file was parseable. */
    readonly holder?: LockHolder,
  ) {
    super(message);
    this.name = 'DataLockError';
  }
}

/** The lock path for a data file — beside it, so one volume carries both. */
export function lockPathFor(dataFile: string): string {
  return `${dataFile}.lock`;
}

/** Is a pid alive in THIS process's namespace? Signal 0 checks without delivering. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means it exists and belongs to another user — alive, and emphatically not
    // ours to take over. Only ESRCH proves absence.
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Why this lock may be taken, or `null` to leave it alone. Pure, so the whole
 * refuse/take-over matrix is a table test with no timers and no second process.
 */
export function staleReason(current: LockHolder | null, ourHost: string, now: number): string | null {
  if (current === null) return null; // unparseable: refuse; it will age out via the file's mtime path below
  const age = now - Date.parse(current.since);
  if (Number.isFinite(age) && age > STALE_MS) {
    return `its claim has not been refreshed for ${Math.round(age / 1000)}s (pid ${current.pid} on ${current.host}, held since ${current.since})`;
  }
  if (!Number.isFinite(age)) {
    return `its claim carries an unreadable timestamp (${current.since}), so it can never be shown to be live`;
  }
  // FAST PATH ONLY, and only where it is unambiguous: a dead pid on OUR host means a
  // bare-metal restart recovers immediately instead of waiting out the stale window. It
  // can add a takeover, never block one — so container pid-1 ambiguity (where a dead
  // container's pid 1 looks alive here) cannot keep a genuinely stale lock alive.
  if (current.host === ourHost && !pidAlive(current.pid)) {
    return `pid ${current.pid} on this host (${current.host}, held since ${current.since}) is gone`;
  }
  return null;
}

function readHolder(path: string): LockHolder | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<LockHolder>;
    if (typeof parsed.pid !== 'number' || typeof parsed.host !== 'string') return null;
    return { pid: parsed.pid, host: parsed.host, since: parsed.since ?? 'unknown' };
  } catch {
    return null;
  }
}

/** A held lock. `release()` is idempotent and safe to call from an exit handler. */
export class DataLock {
  private released = false;
  private beat: ReturnType<typeof setInterval> | null = null;
  private constructor(
    readonly path: string,
    private readonly holder: LockHolder,
  ) {}

  /**
   * Start refreshing the claim. `unref()` so a held lock never keeps the process alive —
   * a store lock must not be the reason a CLI hangs after its work is done.
   */
  private startHeartbeat(): this {
    this.beat = setInterval(() => {
      if (this.released) return;
      try {
        // Written whole, through a temp + rename, so a reader never sees a half-file and
        // mistakes a live holder for an unparseable one.
        const tmp = `${this.path}.beat-${process.pid}`;
        writeFileSync(tmp, JSON.stringify({ ...this.holder, since: new Date().toISOString() }));
        renameSync(tmp, this.path);
      } catch {
        // A failed beat is not fatal on its own: the claim simply ages, and if the
        // condition persists another process is entitled to take over. Throwing from a
        // timer would be worse than losing a lock we can no longer defend.
      }
    }, HEARTBEAT_MS);
    this.beat.unref();
    return this;
  }

  /**
   * Claim exclusive write access to `dataFile`, or throw {@link DataLockError} naming who
   * holds it and what to do. `env` is injectable so the refusal/takeover matrix is
   * testable without touching `process.env`.
   */
  static acquire(dataFile: string, env: NodeJS.ProcessEnv = process.env): DataLock {
    const path = lockPathFor(dataFile);
    // The data directory may not exist yet on a first boot — `FileStore` creates it lazily
    // inside its first atomic write, which is long after this. Claiming the lock has to
    // create it, or a fresh deploy fails on the lock rather than on anything real.
    mkdirSync(dirname(path), { recursive: true });
    const holder: LockHolder = { pid: process.pid, host: hostname(), since: new Date().toISOString() };

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        // 'wx' is O_CREAT|O_EXCL — the create either wins or reports EEXIST, with no
        // window between checking and creating. A read-then-write would have exactly the
        // race this whole module is about.
        const fd = openSync(path, 'wx');
        try {
          writeSync(fd, JSON.stringify(holder));
        } finally {
          closeSync(fd);
        }
        return new DataLock(path, holder).startHeartbeat();
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        if (attempt === 1) {
          // Someone took the lock between our unlink and our retry. That is another live
          // writer by definition — exactly what we refuse.
          throw new DataLockError(
            `ccp data file ${dataFile} is locked by another process that claimed it during startup. ` +
              'Two writers on one file silently destroy each other\'s writes; refusing to start.',
          );
        }

        const current = readHolder(path);
        const takeover = env[TAKEOVER_ENV] === '1';
        const why = staleReason(current, holder.host, Date.now());

        if (why !== null) {
          // eslint-disable-next-line no-console
          console.warn(`[ccp:store] clearing a stale lock on ${dataFile}: ${why}.`);
          unlinkSync(path);
          continue;
        }

        if (takeover) {
          // eslint-disable-next-line no-console
          console.warn(
            `[ccp:store] ${TAKEOVER_ENV}=1 — taking over the lock on ${dataFile} held by ` +
              `${current ? `pid ${current.pid} on ${current.host} since ${current.since}` : 'an unreadable lock file'}. ` +
              'If that writer is in fact alive, both processes will now destroy each other\'s writes.',
          );
          unlinkSync(path);
          continue;
        }

        throw new DataLockError(
          current === null
            ? `ccp data file ${dataFile} has a lock file (${path}) this process cannot parse, so the ` +
              'holder cannot be ruled out. Two writers on one file silently destroy each other\'s ' +
              `writes. Remove it if you are certain no other process is writing, or set ${TAKEOVER_ENV}=1.`
            : `ccp data file ${dataFile} is already open for writing by pid ${current.pid} on ` +
              `${current.host} (since ${current.since}). Two writers on one file silently destroy ` +
              "each other's writes, and every in-process concurrency guard is void across " +
              `processes. Stop that writer, or set ${TAKEOVER_ENV}=1 if you have confirmed it is gone.`,
          current ?? undefined,
        );
      }
    }
    /* c8 ignore next */
    throw new DataLockError(`ccp data file ${dataFile}: could not acquire the write lock.`);
  }

  /**
   * Release the lock — but ONLY if we still hold it. A takeover by another process
   * rewrote the file with its own identity, and deleting it then would hand a third
   * process a lock the real writer thinks it owns.
   */
  release(): void {
    if (this.released) return;
    this.released = true;
    if (this.beat !== null) clearInterval(this.beat);
    this.beat = null;
    const current = readHolder(this.path);
    if (current !== null && (current.pid !== this.holder.pid || current.host !== this.holder.host)) return;
    try {
      unlinkSync(this.path);
    } catch {
      // Best effort: an already-removed lock is the state we wanted.
    }
  }
}
