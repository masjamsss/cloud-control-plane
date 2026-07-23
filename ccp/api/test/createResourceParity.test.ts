import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { renderHclSkeleton } from '@/lib/hclSkeleton';
import type { ManifestOperation } from '@/types';
import { BASELINE_VALUES, BASELINE_VARIANTS } from '@/test/fixtures/skeletons/baselines/values';
import { getOperation, loadManifests } from '../src/manifests';

/**
 * 0036 T4 — THE MANDATORY GATE: the TS↔Go byte-parity harness (mirror of
 * scheduleWindowCheckParity.test.ts). It shells out to the REAL `catalogctl edit`
 * binary for the `create_resource` verb and asserts, for EVERY wired create idiom,
 * that the bytes the Go verb AUTHORS equal the bytes the TS draft renderer
 * (hclSkeleton.ts#renderHclSkeleton) shows the L1 — MINUS the two-line DRAFT banner
 * (§5.2). The L1 draft the operator saw == the authored HCL the engineer reviews.
 *
 * The binary is BUILT once (`go build`) into a temp dir and invoked directly (not
 * `go run`). Best-effort: SKIP (never fail) when Go is unavailable — the Go golden
 * corpus (internal/edit/idiomrender_test.go + create_test.go) is the
 * toolchain-independent backstop that keeps proving Go-render == golden everywhere.
 *
 * The verb validates references against `--env`, so each op runs against a scratch
 * env stubbed with the referenced addresses and NO pre-existing service file (so the
 * authored file IS the pure skeleton). vpn-add-static-route is excluded — it stays
 * instantiate_module (§0.1), so the create verb never authors it.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '../../..');
const CATALOGCTL_DIR = join(REPO_ROOT, 'tools/catalogctl');
const MANIFESTS_DIR = join(REPO_ROOT, 'ccp/app/src/data/manifests');

function buildCatalogctl(): string | null {
  try {
    const dir = mkdtempSync(join(tmpdir(), 'catalogctl-create-parity-'));
    const bin = join(dir, process.platform === 'win32' ? 'catalogctl.exe' : 'catalogctl');
    const res = spawnSync('go', ['build', '-o', bin, './cmd/catalogctl'], {
      cwd: CATALOGCTL_DIR,
      encoding: 'utf8',
      timeout: 120_000,
    });
    return res.status === 0 ? bin : null;
  } catch {
    return null;
  }
}

function findSchema(): string | null {
  try {
    const dir = join(REPO_ROOT, 'tools/schemadump');
    const f = readdirSync(dir).find((n) => /^aws-.*-schema\.json$/.test(n));
    return f ? join(dir, f) : null;
  } catch {
    return null;
  }
}

const CATALOGCTL_BIN = buildCatalogctl();
const SCHEMA = findSchema();
if (!CATALOGCTL_BIN) {
  // eslint-disable-next-line no-console
  console.warn('createResourceParity.test.ts: could not build catalogctl (go missing?) — skipping the live cross-check (Go golden corpus is the backstop).');
}

const ADDRESS_SHAPE = /^aws_[a-z0-9_]+\.[A-Za-z_][A-Za-z0-9_-]*$/;
const VALID_REQ_ID = 'REQ-00000000000000000000000000';

// Load ops from the filesystem via the api's own loader (zero app coupling — no
// Vite import.meta.glob, no zod) so this test typechecks in the api package.
const CATALOG = loadManifests(MANIFESTS_DIR);
function opById(id: string): ManifestOperation {
  const op = getOperation(id, CATALOG);
  if (!op) throw new Error(`op ${id} not found in catalog`);
  return op;
}

/** Address-shaped values (scalar or list element) that need a stub resource. */
function referencedAddresses(values: Record<string, unknown>): string[] {
  const out = new Set<string>();
  const add = (v: unknown) => {
    if (typeof v === 'string' && ADDRESS_SHAPE.test(v)) out.add(v);
  };
  for (const v of Object.values(values)) {
    if (Array.isArray(v)) v.forEach(add);
    else add(v);
  }
  return [...out].sort();
}

/** A real SPA request omits empty optional fields; the renderer treats absent and
 * empty identically. Strip them so Validate never sees an empty patterned optional. */
function nonEmptyParams(values: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(values)) {
    if (v === '' || v === null || v === undefined || (Array.isArray(v) && v.length === 0)) continue;
    out[k] = v;
  }
  return out;
}

/** Strip hclSkeleton.ts's two-line DRAFT banner (and its trailing blank), leaving the
 * exact bytes the create verb authors. */
function stripDraftBanner(text: string): string {
  const lines = text.replace(/\n$/, '').split('\n');
  if (lines.length >= 2 && lines[0]!.startsWith('# DRAFT') && lines[1]!.includes('NOT applied by any pipeline')) {
    lines.splice(0, 2);
    if (lines[0] === '') lines.shift();
  }
  return lines.join('\n');
}

/** Run the Go verb for op+values against a scratch env; return the authored file. */
function goAuthored(op: ManifestOperation, values: Record<string, unknown>): string {
  const env = mkdtempSync(join(tmpdir(), 'create-parity-env-'));
  try {
    const stubs = referencedAddresses(values)
      .map((a) => {
        const [type, name] = a.split('.');
        return `resource "${type}" "${name}" {}`;
      })
      .join('\n');
    if (stubs) writeFileSync(join(env, '_refs.tf'), stubs + '\n');

    const reqDir = mkdtempSync(join(tmpdir(), 'create-parity-req-'));
    const reqPath = join(reqDir, 'request.json'); // JSON is valid YAML
    writeFileSync(
      reqPath,
      JSON.stringify({ schema: 'ccp.request/v1', id: VALID_REQ_ID, item: op.id, params: nonEmptyParams(values) }),
    );

    const args = ['edit', '--request', reqPath, '--manifests', MANIFESTS_DIR, '--env', env];
    if (SCHEMA) args.push('--schema', SCHEMA);
    const res = spawnSync(CATALOGCTL_BIN!, args, { encoding: 'utf8', timeout: 20_000 });
    if (res.status !== 0) {
      throw new Error(`catalogctl edit exit ${res.status}: ${res.stderr}`);
    }
    const authored = readFileSync(join(env, `${op.service}.tf`), 'utf8');
    rmSync(reqDir, { recursive: true, force: true });
    return authored.replace(/\n$/, '');
  } finally {
    rmSync(env, { recursive: true, force: true });
  }
}

// The wired create baselines (vpn-add-static-route excluded — stays instantiate_module).
const BASELINE_IDS = [
  'ec2-provision-instance', 'ebs-create-volume', 's3-create-bucket', 's3-create-lifecycle-setup',
  's3-start-versioning-setup', 'sg-create-security-group', 'alb-add-target-group', 'efs-create-filesystem',
  'rds-provision-instance', 'backup-create-vault', 'backup-create-plan', 'sns-create-topic', 'lambda-create-function',
];

describe.skipIf(!CATALOGCTL_BIN)('create_resource — TS renderer vs the real catalogctl verb (byte-for-byte)', () => {
  for (const id of BASELINE_IDS) {
    it(`${id} authors the banner-stripped skeleton`, () => {
      const op = opById(id);
      const values = BASELINE_VALUES[id]!;
      const tsSkeleton = stripDraftBanner(renderHclSkeleton(op, values, { requestId: 'REQ-W3' }));
      expect(goAuthored(op, values)).toBe(tsSkeleton);
    });
  }

  for (const [name, values] of Object.entries(BASELINE_VARIANTS)) {
    const id = name.split('--')[0]!;
    it(`variant ${name} authors the banner-stripped skeleton`, () => {
      const op = opById(id);
      const tsSkeleton = stripDraftBanner(renderHclSkeleton(op, values, { requestId: 'REQ-W3' }));
      expect(goAuthored(op, values)).toBe(tsSkeleton);
    });
  }

  // The ${-escaping fixture (§3): a literal ${…} in a tag value must be neutralised
  // to $${…} byte-identically on both sides (renderValue's JSON.stringify + replace).
  it('escapes a literal ${…} in a tag value identically (Go == TS)', () => {
    const op = opById('sns-create-topic');
    const values = {
      ...BASELINE_VALUES['sns-create-topic']!,
      description_tag: 'drops into ${aws:Region} — a literal, not an interpolation',
    };
    const tsSkeleton = stripDraftBanner(renderHclSkeleton(op, values, { requestId: 'REQ-W3' }));
    expect(tsSkeleton).toContain('$${aws:Region}'); // proves the escape is exercised
    expect(goAuthored(op, values)).toBe(tsSkeleton);
  });

  it('sanity: the parity matrix is non-empty', () => {
    expect(BASELINE_IDS.length + Object.keys(BASELINE_VARIANTS).length).toBeGreaterThanOrEqual(15);
  });
});
