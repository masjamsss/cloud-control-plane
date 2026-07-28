import { openSync, closeSync, mkdirSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
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
 * ## Staleness, which is where locks usually go wrong
 *
 * A lock that survives its holder wedges the service — the ERR-2 shape, where `running`
 * was permanent and a crash left a request un-appliable forever. A lock that clears
 * itself on a guess defeats its own purpose. So the rule is: **take over only where the
 * holder can be PROVEN gone, refuse where it would be a guess.**
 *
 *  - Same host, pid not alive → the holder is definitely dead. Take over, loudly.
 *  - Same host, pid alive → refuse. This is the case the lock exists for.
 *  - Different host → refuse. A shared volume mounted into a second machine is exactly
 *    the scenario, and this process cannot check a pid it cannot see. `CCP_DATA_LOCK_TAKEOVER=1`
 *    is the operator saying "I have checked"; it is a deliberate act, not a default.
 *  - Unreadable/corrupt lock → treated as a foreign lock: refuse, same escape hatch. A
 *    lock file we cannot parse is one whose holder we cannot rule out.
 */

const TAKEOVER_ENV = 'CCP_DATA_LOCK_TAKEOVER';

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
  private constructor(
    readonly path: string,
    private readonly holder: LockHolder,
  ) {}

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
        return new DataLock(path, holder);
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

        if (current !== null && current.host === holder.host && !pidAlive(current.pid)) {
          // Provably dead, same host. Clear it and retry — this is the crash-restart path,
          // and leaving it wedged would trade a data-loss bug for an availability one.
          // eslint-disable-next-line no-console
          console.warn(
            `[ccp:store] clearing a stale lock on ${dataFile}: pid ${current.pid} on this host (${current.host}, held since ${current.since}) is gone.`,
          );
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
    const current = readHolder(this.path);
    if (current !== null && (current.pid !== this.holder.pid || current.host !== this.holder.host)) return;
    try {
      unlinkSync(this.path);
    } catch {
      // Best effort: an already-removed lock is the state we wanted.
    }
  }
}
