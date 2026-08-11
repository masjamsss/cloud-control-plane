import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../src/domain/audit';
import {
  digestsOf,
  hashCanonical,
  partDigest,
  rerunRedaction,
  sameJsonValue,
  type UploadBundle,
} from '../src/domain/projectData';

/**
 * PERF-12 — upload ingest used to make four full canonical-JSON passes over a
 * 16 MiB bundle, back to back, synchronously on the event loop: `digestsOf` over
 * every part, then `rerunRedaction` serializing each resource TWICE just to ask
 * "did the redactor change anything", then `digestsOf` again over the result.
 * Measured at 20k resources: 313 ms + 398 ms + 372 ms, and the single-threaded
 * server answered nothing for the whole ~1.1 s.
 *
 * Three separate properties are pinned here, because the fix has three halves and
 * two of them are only safe if the third holds:
 *
 *  1. The streaming canonical hash is BYTE-IDENTICAL to `sha256(canonicalJson(v))`.
 *     This is not an internal detail — the digest is a wire value every uploader
 *     recomputes and the server refuses the upload on a mismatch, so a divergence
 *     here breaks every CI push. It is checked against the ORIGINAL implementation
 *     over a corpus built to hit the awkward cases, not over happy-path objects.
 *  2. Skipping the second `digestsOf` when redaction masked nothing is sound —
 *     i.e. `changed === false` really does imply identical digests, and
 *     `changed === true` is reported whenever anything was masked.
 *  3. Ingest no longer holds the event loop for the duration of the work.
 */

const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
/** The pre-existing implementation, kept verbatim as the oracle. */
const referenceDigest = (v: unknown): string => sha256(canonicalJson(v));

/* ── 1. the streaming hash must not change the wire contract ────────────────── */

/**
 * Deliberately awkward: key ORDER that differs from sorted order (canonical JSON
 * sorts, so these must collide), nesting, empty containers, unicode and quote
 * escaping, numeric edge values, and the two shapes whose handling is a choice
 * rather than an obligation — an explicit `undefined` property (canonicalJson
 * writes `null`, JSON.stringify omits the key) and a non-finite number.
 */
const CORPUS: Array<{ name: string; value: unknown }> = [
  { name: 'null', value: null },
  { name: 'bare string', value: 'hello' },
  { name: 'string needing escapes', value: 'quote " backslash \\ newline \n tab \t' },
  { name: 'unicode string', value: 'halo dunia — ünïcodé — 日本語 — 🌏' },
  { name: 'number', value: 42 },
  { name: 'negative float', value: -1.5e-7 },
  { name: 'zero', value: 0 },
  { name: 'true', value: true },
  { name: 'false', value: false },
  { name: 'empty object', value: {} },
  { name: 'empty array', value: [] },
  { name: 'array of scalars', value: [1, 'two', false, null] },
  { name: 'nested arrays', value: [[[1], [2, [3]]], []] },
  { name: 'unsorted keys', value: { zebra: 1, alpha: 2, Mike: 3, '10': 4, '2': 5 } },
  { name: 'keys needing escapes', value: { 'a"b': 1, 'c\\d': 2, 'e\nf': 3 } },
  { name: 'unicode keys', value: { ünï: 1, 日本: 2, '🌏': 3 } },
  { name: 'deep nesting', value: { a: { b: { c: { d: { e: [{ f: 'g' }] } } } } } },
  { name: 'explicit undefined property', value: { present: 1, missing: undefined } },
  { name: 'array holding undefined', value: [1, undefined, 3] },
  { name: 'non-finite number', value: { nan: Number.NaN, inf: Number.POSITIVE_INFINITY } },
  {
    name: 'bundle-shaped object',
    value: {
      inventory: {
        generatedAt: '2026-08-01T00:00:00.000Z',
        resources: [
          { address: 'aws_instance.a', resourceType: 'aws_instance', attributes: { z: 1, a: 'x' } },
          { address: 'aws_instance.b', resourceType: 'aws_instance', attributes: {} },
        ],
      },
      blocks: { index: { 'aws_instance.a': 'c1' }, chunks: { c1: { 'aws_instance.a': { file: 'f', line: 1, source: 's' } } } },
    },
  },
];

describe('PERF-12 — the streaming canonical hash is the same hash', () => {
  it('agrees with sha256(canonicalJson(v)) on every corpus value', async () => {
    // L-1: prove the corpus actually exercised distinct shapes rather than
    // silently collapsing to one — otherwise a broken hash agreeing on `null`
    // 21 times would look like 21 passing cases.
    const digests = new Set<string>();
    for (const { name, value } of CORPUS) {
      const streamed = await hashCanonical(value);
      expect(streamed, `hashCanonical disagrees with the reference for: ${name}`).toBe(referenceDigest(value));
      digests.add(streamed);
    }
    expect(CORPUS.length).toBeGreaterThanOrEqual(20);
    // Distinct inputs must hash distinctly; a collision here means the walk is
    // dropping structure (e.g. emitting no separators), which would still have
    // "agreed" above if the reference were also wrong.
    expect(digests.size).toBe(CORPUS.length);
  });

  it('distinguishes values that differ ONLY in structure, not in their scalars', async () => {
    // The classic canonicalization bug: separators or delimiters dropped, so
    // {a:1,b:2} and {ab:12} (or [1,2] and [12]) hash alike.
    const pairs: Array<[unknown, unknown]> = [
      [{ a: 1, b: 2 }, { ab: 12 }],
      [[1, 2], [12]],
      [{ a: [1] }, { a: 1 }],
      [{ a: '1' }, { a: 1 }],
      [[[]], []],
    ];
    for (const [x, y] of pairs) {
      expect(await hashCanonical(x)).not.toBe(await hashCanonical(y));
      // and the reference agrees that they are different, so this is a real
      // property of canonical JSON and not an artifact of the new walk
      expect(referenceDigest(x)).not.toBe(referenceDigest(y));
    }
  });

  it('partDigest is still the documented rule (sha256 over canonical JSON)', async () => {
    const v = { b: [3, 2, 1], a: { z: null, y: 'x' } };
    expect(await partDigest(v)).toBe(referenceDigest(v));
  });
});

/* ── 2. reusing the first pass's digests is sound ───────────────────────────── */

function bundleWith(attributes: Record<string, string | number | boolean>, source: string): UploadBundle {
  return {
    digests: { inventorySha256: '', blocksSha256: '' },
    inventory: {
      generatedAt: '2026-08-01T00:00:00.000Z',
      resources: [{ address: 'aws_instance.a', resourceType: 'aws_instance', attributes }],
    },
    blocks: {
      index: { 'aws_instance.a': 'c1' },
      chunks: { c1: { 'aws_instance.a': { file: 'main.tf', line: 1, source } } },
    },
  } as unknown as UploadBundle;
}

const CLEAN_SOURCE = 'resource "aws_instance" "a" {\n  instance_type = "m5.large"\n}\n';
// An attribute NAME the shared redactor treats as secret — the value is masked
// regardless of what it looks like.
const SECRET_ATTRS = { instance_type: 'm5.large', secret_key: 'AKIAIOSFODNN7EXAMPLE' };

describe('PERF-12 — the skipped second digest pass is only skipped when it is redundant', () => {
  it('a clean bundle reports changed:false, and its stored digests equal the uploaded ones', async () => {
    const bundle = bundleWith({ instance_type: 'm5.large', tags_Name: 'web-01' }, CLEAN_SOURCE);
    const computed = await digestsOf(bundle);
    const redaction = await rerunRedaction(bundle);

    // L-1: assert the setup fired. If redaction HAD masked something, the
    // equivalence below would be vacuous — it would be comparing the change-path
    // against itself and would pass no matter what the route does.
    expect(redaction.problem).toBeNull();
    expect(redaction.changed).toBe(false);
    expect(redaction.warnings).toEqual([]);

    // The property the route's `redaction.changed ? … : computed` leans on.
    expect(await digestsOf(redaction.bundle)).toEqual(computed);
  });

  it('a bundle the server has to mask reports changed:true, and its stored digests DIFFER', async () => {
    const bundle = bundleWith(SECRET_ATTRS, CLEAN_SOURCE);
    const computed = await digestsOf(bundle);
    const redaction = await rerunRedaction(bundle);

    expect(redaction.problem).toBeNull();
    // L-1 again, from the other side: prove the fixture really does trip the
    // redactor, or "changed:true" would be untested.
    expect(redaction.changed).toBe(true);
    expect(redaction.warnings.length).toBeGreaterThan(0);

    const storedDigests = await digestsOf(redaction.bundle);
    expect(storedDigests.inventorySha256).not.toBe(computed.inventorySha256);
  });

  it('changed is set by the comparison, not derived from the warnings prose', async () => {
    // The two must agree in both directions for every part the re-run covers.
    for (const bundle of [bundleWith({ a: 'plain' }, CLEAN_SOURCE), bundleWith(SECRET_ATTRS, CLEAN_SOURCE)]) {
      const r = await rerunRedaction(bundle);
      expect(r.changed).toBe(r.warnings.length > 0);
    }
  });
});

describe('PERF-12 — sameJsonValue answers the question canonicalJson was being used for', () => {
  it('matches "canonical forms are equal" across the corpus, pairwise', () => {
    for (const a of CORPUS) {
      for (const b of CORPUS) {
        const viaCanonical = canonicalJson(a.value) === canonicalJson(b.value);
        expect(sameJsonValue(a.value, b.value), `${a.name} vs ${b.name}`).toBe(viaCanonical);
      }
    }
  });

  it('key order does not make two equal objects look different', () => {
    expect(sameJsonValue({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
  });

  it('a key present on only one side is a difference, whichever side carries it', () => {
    expect(sameJsonValue({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(sameJsonValue({ a: 1, b: undefined }, { a: 1 })).toBe(false);
  });
});

/* ── 3. ingest stops holding the event loop ─────────────────────────────────── */

function bigBundle(n: number): UploadBundle {
  const resources = [];
  const chunks: Record<string, Record<string, { file: string; line: number; source: string }>> = {};
  const index: Record<string, string> = {};
  const perChunk = Math.max(1, Math.ceil(n / 20));
  for (let i = 0; i < n; i++) {
    const address = `aws_instance.host${i}`;
    resources.push({
      address,
      resourceType: 'aws_instance',
      attributes: {
        id: `i-${i.toString(16).padStart(17, '0')}`,
        instance_type: 'm5.large',
        availability_zone: 'ap-southeast-3a',
        subnet_id: `subnet-${i}`,
        tags_Name: `host-${i}`,
        private_ip: `10.0.${(i >> 8) & 255}.${i & 255}`,
      },
    });
    const chunkName = `chunk${Math.floor(i / perChunk)}`;
    chunks[chunkName] ??= {};
    chunks[chunkName]![address] = { file: `hosts${i}.tf`, line: 1, source: `resource "aws_instance" "host${i}" {\n  instance_type = "m5.large"\n}\n` };
    index[address] = chunkName;
  }
  return {
    digests: { inventorySha256: '', blocksSha256: '' },
    inventory: { generatedAt: '2026-08-01T00:00:00.000Z', resources },
    blocks: { index, chunks },
  } as unknown as UploadBundle;
}

/** Longest gap between successive 1 ms timer fires = the longest the loop was held. */
function loopWatch(): () => number {
  let max = 0;
  let last = performance.now();
  const t = setInterval(() => {
    const now = performance.now();
    max = Math.max(max, now - last);
    last = now;
  }, 1);
  return () => {
    clearInterval(t);
    return max;
  };
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 40));

describe('PERF-12 — ingest does not hold the event loop for the length of the work', () => {
  /**
   * Deliberately a RATIO, not a millisecond ceiling (L-25 — the rule, not the
   * number). The property is "the work is spread across many turns of the loop",
   * which is machine-independent; an absolute threshold would be a bet on how
   * fast the CI box is, and would go red on a slow one for the right reason
   * reported as the wrong one. Before the fix the whole ingest ran in ONE
   * uninterrupted span, so the ratio was ~1.0.
   */
  it('the longest single block is a small fraction of the total ingest time', async () => {
    const bundle = bigBundle(8_000);

    const stop = loopWatch();
    await settle();
    const t0 = performance.now();
    const computed = await digestsOf(bundle);
    const redaction = await rerunRedaction(bundle);
    const storedDigests = redaction.changed ? await digestsOf(redaction.bundle) : computed;
    const total = performance.now() - t0;
    await settle();
    const longestBlock = stop();

    // L-1: the measurement is only meaningful if real work happened. Pin both
    // that the ingest produced digests over the whole fixture and that it took
    // long enough for a blocking implementation to be visible as one span.
    expect(redaction.bundle.inventory.resources).toHaveLength(8_000);
    expect(storedDigests.inventorySha256).toMatch(/^[a-f0-9]{64}$/);
    expect(total).toBeGreaterThan(40);

    expect(
      longestBlock,
      `ingest held the event loop for ${longestBlock.toFixed(0)}ms of ${total.toFixed(0)}ms total`,
    ).toBeLessThan(total * 0.5);
  }, 120_000);
});
