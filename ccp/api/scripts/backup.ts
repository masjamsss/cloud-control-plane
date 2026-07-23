import { existsSync, readFileSync } from 'node:fs';
import { resolveDataFile } from '../src/deploy';
import { parseSnapshotItems, summarizeSnapshot, writeFileAtomic, type SnapshotSummary } from '../src/store/snapshot';

/**
 * Back up the FileStore data file — the operational answer to "what if the disk/host
 * dies". The data file IS a full state snapshot (accounts, sessions, per-project audit
 * chain, policy), so a backup is an atomic, verified copy of those exact bytes. We
 * validate + re-verify the audit chain and REPORT the verdict, but back up regardless
 * (a damaged store is still worth capturing forensically) — restore is where the
 * verify gate blocks installing a bad snapshot over live data.
 *
 * Run:  npm run backup -- --out <file>   [--data <src>]
 */

export type Io = { log: (s: string) => void; error: (s: string) => void };
const consoleIo: Io = { log: (s) => console.log(s), error: (s) => console.error(s) };

export type BackupResult =
  | { ok: true; out: string; summary: SnapshotSummary }
  | { ok: false; reason: string };

function defaultOut(dataFile: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `${dataFile}.backup-${stamp}.json`;
}

/** Copy `dataFile` → `out` atomically after parsing + verifying its chain. */
export async function runBackup(opts: { dataFile: string; out: string; io?: Io }): Promise<BackupResult> {
  const io = opts.io ?? consoleIo;
  if (!existsSync(opts.dataFile)) {
    return { ok: false, reason: `data file ${opts.dataFile} does not exist — nothing to back up.` };
  }
  const raw = readFileSync(opts.dataFile, 'utf8');
  let summary: SnapshotSummary;
  try {
    summary = summarizeSnapshot(parseSnapshotItems(raw));
  } catch (e) {
    return { ok: false, reason: `data file ${opts.dataFile} is not a valid snapshot: ${(e as Error).message}` };
  }

  await writeFileAtomic(opts.out, raw); // byte-for-byte copy, crash-safe
  io.log(`ccp-api backup: ${opts.dataFile} -> ${opts.out}`);
  io.log(`  items=${summary.itemCount} accounts=${summary.accountCount}`);
  for (const c of summary.chains) {
    io.log(`  audit[${c.projectId}]: count=${c.count} verified=${c.verified} (${c.verification.message})`);
  }
  if (!summary.allVerified) {
    io.error('  WARNING: an audit chain did NOT verify — the SOURCE store may be damaged. Backup written anyway for forensics; investigate before relying on it.');
  }
  return { ok: true, out: opts.out, summary };
}

function parseArgs(argv: string[]): { data?: string; out?: string } {
  const out: { data?: string; out?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--data') out.data = argv[++i];
    else if (argv[i] === '--out') out.out = argv[++i];
  }
  return out;
}

export async function main(argv: string[], io: Io = consoleIo): Promise<number> {
  const args = parseArgs(argv);
  const dataFile = args.data ?? resolveDataFile();
  if (dataFile === null) {
    io.error('backup: CCP_STORE=memory has no data file to back up. Set a durable store (unset CCP_STORE) or pass --data.');
    return 2;
  }
  const outFile = args.out ?? defaultOut(dataFile);
  const res = await runBackup({ dataFile, out: outFile, io });
  if (!res.ok) {
    io.error(`backup failed: ${res.reason}`);
    return 1;
  }
  return 0;
}

// Run when invoked directly (tsx scripts/backup.ts ...).
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
