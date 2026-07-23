import { readFileSync } from 'node:fs';
import { verifyChain, type ChainEntry } from '../src/domain/audit';

/**
 * Offline audit-chain verifier CLI (spec §7). The verification logic is the
 * canonical `verifyChain` in `src/domain/audit.ts` — re-exported here so existing
 * importers keep working and the CLI, tests, and the admin export endpoint all
 * share ONE implementation. Exit 0 intact · 1 broken (prints first bad ulid) · 2
 * head mismatch.
 */
export { verifyChain, type ChainEntry, type VerifyResult } from '../src/domain/audit';

function parseArgs(argv: string[]): { file?: string; head?: string } {
  const out: { file?: string; head?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--from-export') out.file = argv[++i];
    else if (argv[i] === '--head') out.head = argv[++i];
  }
  return out;
}

export function main(argv: string[]): number {
  const { file, head } = parseArgs(argv);
  if (!file) {
    console.error('usage: verify-audit-chain --from-export <file.json> [--head <hash>]');
    return 2;
  }
  const entries = JSON.parse(readFileSync(file, 'utf8')) as ChainEntry[];
  const res = verifyChain(entries, head !== undefined ? { head } : undefined);
  console[res.code === 0 ? 'log' : 'error'](res.message);
  return res.code;
}

// Run when invoked directly (tsx scripts/verify-audit-chain.ts ...).
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
