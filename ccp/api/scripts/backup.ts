import { existsSync, readFileSync } from 'node:fs';
import { resolveDataFile } from '../src/deploy';
import { resolveProjectDataRoot } from '../src/domain/projectData';
import { copyTreeAtomic, parseSnapshotItems, summarizeSnapshot, writeFileAtomic, type SnapshotSummary } from '../src/store/snapshot';

/**
 * Back up the durable state — the operational answer to "what if the disk/host dies".
 * That state spans TWO stores (DATA-10): the FileStore snapshot (accounts, sessions,
 * per-project audit chain, policy) and the on-disk project-data/drift root the snapshot's
 * rows point into (`ProjectItem.dataActive`, `DriftPointerItem` — served inventory,
 * manifests, block chunks, drift reports, drift proposal bodies). A backup of the
 * snapshot alone reconstructs rows that reference files a later restore may not have —
 * this backs up both, from the SAME moment, so a restore installs a consistent pair.
 *
 * We validate + re-verify the audit chain and REPORT the verdict, but back up regardless
 * (a damaged store is still worth capturing forensically) — restore is where the
 * verify gate blocks installing a bad snapshot over live data.
 *
 * Run:  npm run backup -- --out <file>   [--data <src>] [--project-data <src>]
 *       [--skip-project-data]
 */

export type Io = { log: (s: string) => void; error: (s: string) => void };
const consoleIo: Io = { log: (s) => console.log(s), error: (s) => console.error(s) };

export type BackupResult =
  | { ok: true; out: string; projectDataOut: string | null; summary: SnapshotSummary }
  | { ok: false; reason: string };

function defaultOut(dataFile: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `${dataFile}.backup-${stamp}.json`;
}

/** The companion project-data copy's path, derived from the snapshot's own `out` path
 * so `restore.ts` can find it by convention with no separate bookkeeping — the two
 * always travel together under the same stem. */
export function projectDataOutFor(out: string): string {
  return `${out.replace(/\.json$/, '')}.projects`;
}

/** Copy `dataFile` → `out` atomically after parsing + verifying its chain, and (unless
 * skipped) the project-data root → its companion path alongside it. */
export async function runBackup(opts: {
  dataFile: string;
  out: string;
  projectDataRoot?: string;
  skipProjectData?: boolean;
  io?: Io;
}): Promise<BackupResult> {
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

  let projectDataOut: string | null = null;
  if (!opts.skipProjectData) {
    const root = opts.projectDataRoot ?? resolveProjectDataRoot();
    if (existsSync(root)) {
      projectDataOut = projectDataOutFor(opts.out);
      const fileCount = await copyTreeAtomic(root, projectDataOut);
      io.log(`  project-data: ${root} -> ${projectDataOut} (${fileCount} entries)`);
    } else {
      // A fresh install with no projects yet (or CCP_DATA_DIR misconfigured — either
      // way there is nothing wrong with the snapshot backup above) — nothing to copy,
      // not an error.
      io.log(`  project-data: ${root} does not exist — nothing to copy (no projects onboarded yet?).`);
    }
  } else {
    io.log('  project-data: --skip-project-data — the store snapshot above does NOT include it; restore will only cover the store.');
  }

  return { ok: true, out: opts.out, projectDataOut, summary };
}

function parseArgs(argv: string[]): { data?: string; out?: string; projectData?: string; skipProjectData: boolean } {
  const out: { data?: string; out?: string; projectData?: string; skipProjectData: boolean } = { skipProjectData: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--data') out.data = argv[++i];
    else if (argv[i] === '--out') out.out = argv[++i];
    else if (argv[i] === '--project-data') out.projectData = argv[++i];
    else if (argv[i] === '--skip-project-data') out.skipProjectData = true;
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
  const res = await runBackup({
    dataFile,
    out: outFile,
    projectDataRoot: args.projectData,
    skipProjectData: args.skipProjectData,
    io,
  });
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
