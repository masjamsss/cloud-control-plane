import { existsSync, readFileSync } from 'node:fs';
import { resolveDataFile } from '../src/deploy';
import { parseSnapshotItems, summarizeSnapshot, writeFileAtomic, type SnapshotSummary } from '../src/store/snapshot';

/**
 * Restore the FileStore data file from a backup — the recovery half of the disk/host
 * death story. It reads the backup, FAIL-CLOSED parses it, and re-verifies every
 * per-project audit chain. If any chain does not verify it REFUSES (a corrupt evidence
 * store must not silently replace live data) unless `--force` is passed for a
 * deliberate disaster restore. The write itself is atomic (temp + fsync + rename), so
 * an interrupted restore leaves the OLD data file intact.
 *
 * Run:  npm run restore -- --from <backup>   [--data <dest>] [--force]
 */

export type Io = { log: (s: string) => void; error: (s: string) => void };
const consoleIo: Io = { log: (s) => console.log(s), error: (s) => console.error(s) };

export type RestoreResult =
  | { ok: true; dataFile: string; summary: SnapshotSummary }
  | { ok: false; reason: string; summary?: SnapshotSummary };

/** Install `backup` → `dataFile` atomically, gated on the backup's chain verifying (unless `force`). */
export async function runRestore(opts: {
  backup: string;
  dataFile: string;
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

  await writeFileAtomic(opts.dataFile, raw);
  io.log(`  restored ${summary.itemCount} items (atomic write complete).`);
  return { ok: true, dataFile: opts.dataFile, summary };
}

function parseArgs(argv: string[]): { from?: string; data?: string; force: boolean } {
  const out: { from?: string; data?: string; force: boolean } = { force: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--from') out.from = argv[++i];
    else if (argv[i] === '--data') out.data = argv[++i];
    else if (argv[i] === '--force') out.force = true;
  }
  return out;
}

export async function main(argv: string[], io: Io = consoleIo): Promise<number> {
  const args = parseArgs(argv);
  if (!args.from) {
    io.error('usage: restore --from <backup.json> [--data <dest>] [--force]');
    return 2;
  }
  const dataFile = args.data ?? resolveDataFile();
  if (dataFile === null) {
    io.error('restore: CCP_STORE=memory has no data file to restore into. Set a durable store (unset CCP_STORE) or pass --data.');
    return 2;
  }
  const res = await runRestore({ backup: args.from, dataFile, force: args.force, io });
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
