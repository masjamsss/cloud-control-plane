import { existsSync, readFileSync } from 'node:fs';
import { resolveDataFile } from '../src/deploy';
import { resolveProjectDataRoot } from '../src/domain/projectData';
import { copyTreeAtomic, parseSnapshotItems, summarizeSnapshot, writeFileAtomic, type SnapshotSummary } from '../src/store/snapshot';
import { DataLock, DataLockError } from '../src/store/dataLock';
import { projectDataOutFor } from './backup';

/**
 * Restore the durable state from a backup — the recovery half of the disk/host death
 * story. It reads the store snapshot, FAIL-CLOSED parses it, and re-verifies every
 * per-project audit chain. If any chain does not verify it REFUSES (a corrupt evidence
 * store must not silently replace live data) unless `--force` is passed for a
 * deliberate disaster restore. The write itself is atomic (temp + fsync + rename), so
 * an interrupted restore leaves the OLD data file intact.
 *
 * DATA-10: it ALSO restores the on-disk project-data/drift root the snapshot's rows
 * point into (`ProjectItem.dataActive`, `DriftPointerItem`), by convention — the
 * companion `<backup>.projects` directory `backup.ts` wrote alongside the snapshot.
 * That directory REPLACES the destination root wholesale (never merged): the point
 * of restoring both together is that the result is exactly what one backup captured,
 * not that plus whatever the live root happened to hold since. A backup made before
 * this feature (or with `--skip-project-data`) has no companion directory — restore
 * proceeds with the store alone and WARNS loudly, rather than either refusing outright
 * (the store restore is still valid on its own) or silently leaving served files that
 * may now mismatch the restored rows (see /readyz's DATA-10 cross-check, which is
 * exactly the safety net for that gap).
 *
 * DATA-9: it also CLAIMS the data file's single-writer lock for the duration, held
 * across BOTH restores. A restore under a running server was silently pointless — the
 * atomic write installs the backup, and the server's very next persist (a session slide
 * from any authenticated request will do) rewrites the whole file from its own
 * in-memory map and discards it, with no error anywhere. The operator sees "restored N
 * items" and has restored nothing. The same running server would also be actively
 * reading/writing the project-data root, so the one lock guards both restores'
 * consistency, not just the store's.
 *
 * Run:  npm run restore -- --from <backup>   [--data <dest>] [--project-data <dest>]
 *       [--skip-project-data] [--force]
 */

export type Io = { log: (s: string) => void; error: (s: string) => void };
const consoleIo: Io = { log: (s) => console.log(s), error: (s) => console.error(s) };

export type RestoreResult =
  | { ok: true; dataFile: string; projectDataRoot: string | null; summary: SnapshotSummary }
  | { ok: false; reason: string; summary?: SnapshotSummary };

/** Install `backup` → `dataFile` atomically, gated on the backup's chain verifying
 * (unless `force`), and (unless skipped) the companion project-data backup → the live
 * project-data root. */
export async function runRestore(opts: {
  backup: string;
  dataFile: string;
  projectDataRoot?: string;
  projectDataBackup?: string;
  skipProjectData?: boolean;
  force?: boolean;
  io?: Io;
}): Promise<RestoreResult> {
  const io = opts.io ?? consoleIo;
  if (!existsSync(opts.backup)) {
    return { ok: false, reason: `backup file ${opts.backup} does not exist.` };
  }
  const raw = readFileSync(opts.backup, 'utf8');
  let summary: SnapshotSummary;
  try {
    summary = summarizeSnapshot(parseSnapshotItems(raw));
  } catch (e) {
    return { ok: false, reason: `backup ${opts.backup} is not a valid snapshot: ${(e as Error).message}` };
  }

  io.log(`ccp-api restore: ${opts.backup} -> ${opts.dataFile}`);
  io.log(`  items=${summary.itemCount} accounts=${summary.accountCount}`);
  for (const c of summary.chains) {
    io.log(`  audit[${c.projectId}]: count=${c.count} verified=${c.verified} (${c.verification.message})`);
  }

  if (!summary.allVerified && !opts.force) {
    return {
      ok: false,
      summary,
      reason: "the backup's audit chain does not verify — refusing to install a corrupt evidence store over live data. Pass --force for a deliberate disaster restore.",
    };
  }
  if (!summary.allVerified && opts.force) {
    io.error('  WARNING: restoring a backup whose audit chain does NOT verify (--force). The restored store is not tamper-evident-clean.');
  }

  // DATA-9 — take the writer lock BEFORE either write and hold it across both. A running
  // server holds this lock, so this is the check: if we cannot claim it, a process that
  // rewrites the file from memory (and actively serves the project-data root) is live,
  // and installing a backup underneath it would be discarded/raced without either side
  // noticing.
  let lock: DataLock;
  try {
    lock = DataLock.acquire(opts.dataFile);
  } catch (e) {
    if (!(e instanceof DataLockError)) throw e;
    return {
      ok: false,
      summary,
      reason: `${e.message} A restore installed under a running server is silently undone by its next write — stop the server first.`,
    };
  }
  let projectDataRoot: string | null = null;
  try {
    await writeFileAtomic(opts.dataFile, raw);
    io.log(`  restored ${summary.itemCount} items (atomic write complete).`);

    if (!opts.skipProjectData) {
      const dest = opts.projectDataRoot ?? resolveProjectDataRoot();
      const src = opts.projectDataBackup ?? projectDataOutFor(opts.backup);
      if (existsSync(src)) {
        const fileCount = await copyTreeAtomic(src, dest);
        io.log(`  project-data: ${src} -> ${dest} (${fileCount} entries, replaced wholesale)`);
        projectDataRoot = dest;
      } else {
        io.error(
          `  WARNING: no companion project-data backup found at ${src} — this backup does not cover served project data (an older backup, or one made with --skip-project-data). The CURRENT project-data root at ${dest} was left UNTOUCHED and may now be inconsistent with the just-restored store rows (dataActive / drift pointers) — /readyz's DATA-10 cross-check will flag any project whose active files are actually missing, but a mismatched-generation file will NOT be caught by that check alone.`,
        );
      }
    } else {
      io.log('  project-data: --skip-project-data — the CURRENT project-data root was left untouched.');
    }
  } finally {
    lock.release();
  }
  return { ok: true, dataFile: opts.dataFile, projectDataRoot, summary };
}

function parseArgs(argv: string[]): {
  from?: string;
  data?: string;
  projectData?: string;
  skipProjectData: boolean;
  force: boolean;
} {
  const out: { from?: string; data?: string; projectData?: string; skipProjectData: boolean; force: boolean } = {
    skipProjectData: false,
    force: false,
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--from') out.from = argv[++i];
    else if (argv[i] === '--data') out.data = argv[++i];
    else if (argv[i] === '--project-data') out.projectData = argv[++i];
    else if (argv[i] === '--skip-project-data') out.skipProjectData = true;
    else if (argv[i] === '--force') out.force = true;
  }
  return out;
}

export async function main(argv: string[], io: Io = consoleIo): Promise<number> {
  const args = parseArgs(argv);
  if (!args.from) {
    io.error('usage: restore --from <backup.json> [--data <dest>] [--project-data <dest>] [--skip-project-data] [--force]');
    return 2;
  }
  const dataFile = args.data ?? resolveDataFile();
  if (dataFile === null) {
    io.error('restore: CCP_STORE=memory has no data file to restore into. Set a durable store (unset CCP_STORE) or pass --data.');
    return 2;
  }
  const res = await runRestore({
    backup: args.from,
    dataFile,
    projectDataRoot: args.projectData,
    skipProjectData: args.skipProjectData,
    force: args.force,
    io,
  });
  if (!res.ok) {
    io.error(`restore failed: ${res.reason}`);
    return 1;
  }
  return 0;
}

// Run when invoked directly (tsx scripts/restore.ts ...).
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
