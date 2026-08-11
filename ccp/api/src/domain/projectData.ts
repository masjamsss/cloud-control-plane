import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile, open as fsOpen } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { z } from 'zod';
import { redactHcl, redactTfJson } from '@app-lib/redact';
import { canonicalJson } from './audit';

/**
 * Per-project SERVED DATA (the app-rebuild killer). Each account's
 * inventory / block sources / manifests are uploaded by that account's CI
 * (token-authed `PUT /projects/:id/data`), staged as an immutable VERSION on
 * disk under `<dataRoot>/<projectId>/v<N>/`, and served at runtime ONLY once a
 * 2-admin activation points `ProjectItem.dataActive` at that version. The
 * store keeps metadata + digests; the FILES deliberately live outside the
 * FileStore JSON (they are estate-sized, and the governance DB stays small).
 *
 * FAIL-CLOSED postures, in order of the upload pipeline:
 *  1. SIZE CAP before anything is parsed (Content-Length first, then the read
 *     byte length) — an oversized body is refused unread.
 *  2. STRICT zod on the whole bundle (unknown keys refuse), with explicit
 *     per-part item caps.
 *  3. DIGEST BINDING recomputed server-side: sha256 over the CANONICAL JSON of
 *     each part must equal what the uploader claimed, or nothing is stored.
 *  4. REDACTION RE-RUN server-side (the same shared rule set the app and
 *     extract-blocks use) over EVERY served part — block sources, inventory
 *     attributes, AND manifests: the server stores ITS OWN redaction output —
 *     an upload that missed a secret is masked here and flagged in `warnings`,
 *     never served verbatim.
 *  5. The stored version is STAGED only — serving needs the separate
 *     dual-controlled activate step.
 */

/* ── size + shape caps (explicit, all refusals are 4xx not truncation) ─────── */

export const MAX_UPLOAD_BYTES = 16 * 1024 * 1024; // 16 MiB per bundle
const MAX_RESOURCES = 50_000;
const MAX_INDEX_ENTRIES = 100_000;
const MAX_CHUNKS = 2_000;
const MAX_ADDRESSES_PER_CHUNK = 5_000;
const MAX_BLOCK_SOURCE = 256 * 1024; // one block's text
const MAX_MANIFESTS = 200;

/** A block chunk's file base — used as an on-disk file name, so the shape is
 * strict: no separators, no leading dot, and 'index' is reserved for the map. */
export const CHUNK_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/;

const Scalar = z.union([z.string().max(4_000), z.number(), z.boolean()]);

const UploadResource = z
  .object({
    address: z.string().min(1).max(300),
    resourceType: z.string().min(1).max(200),
    name: z.string().max(200).optional(),
    service: z.string().max(100).optional(),
    attributes: z.record(Scalar),
  })
  .strict();

const UploadInventory = z
  .object({
    generatedAt: z.string().max(64).nullable(),
    sourceCommit: z.string().max(64).nullable().optional(),
    source: z.string().max(500).optional(),
    resources: z.array(UploadResource).max(MAX_RESOURCES),
  })
  .strict();

const UploadBlockSource = z
  .object({
    file: z.string().min(1).max(500),
    line: z.number().int().nonnegative(),
    source: z.string().max(MAX_BLOCK_SOURCE),
    viewOnly: z.literal(true).optional(),
  })
  .strict();

const UploadBlocks = z
  .object({
    /** address → chunk file base (the app's blocks/index.json shape). */
    index: z.record(z.string().max(120)),
    /** chunk file base → { address → block source } (one JSON chunk per file). */
    chunks: z.record(z.record(UploadBlockSource)),
  })
  .strict();

const UploadDigests = z
  .object({
    inventorySha256: z.string().regex(/^[a-f0-9]{64}$/),
    blocksSha256: z.string().regex(/^[a-f0-9]{64}$/),
    manifestsSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict();

/**
 * The manifest ENVELOPE the api checks (service/scope/operations with ids —
 * enough to refuse junk while staying `passthrough` on the op internals). The
 * app remains the deep-schema authority: it re-parses every served manifest
 * with its full `parseManifests` zod at read time and fails loudly there.
 * Deliberately NOT the app's schema imported here — the api's CI installs only
 * api deps, so cross-package imports must stay dependency-free (lib/redact is;
 * the app's manifestSchema pulls the app's zod install and is not).
 */
const UploadManifest = z
  .object({
    service: z.string().min(1).max(100),
    scope: z.enum(['estate', 'greenfield', 'expansion']),
    resourceTypes: z.array(z.string().max(200)).max(200),
    summary: z.string().max(2_000),
    operations: z
      .array(z.object({ id: z.string().min(1).max(200) }).passthrough())
      .max(500),
  })
  .passthrough();

export const UploadBundle = z
  .object({
    digests: UploadDigests,
    inventory: UploadInventory,
    blocks: UploadBlocks,
    /** Raw manifest JSONs (envelope-validated here; deep-validated by the app on read). */
    manifests: z.array(UploadManifest).max(MAX_MANIFESTS).optional(),
    summary: z
      .object({ providerPins: z.record(z.string().max(100)).optional() })
      .strict()
      .optional(),
  })
  .strict();
export type UploadBundle = z.infer<typeof UploadBundle>;

export type StoredDigests = { inventorySha256: string; blocksSha256: string; manifestsSha256?: string };

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/* ── cooperative ingest primitives (PERF-12) ───────────────────────────────────
 *
 * Ingest is the only path in this API that does estate-sized CPU work in one
 * go: a 16 MiB bundle is up to 50k inventory resources and 100k block
 * addresses, and every byte of it gets canonicalized, hashed and redacted. It
 * runs on the same single thread that serves every interactive user, so the
 * cost is not "the upload is slow" — it is "nobody gets an answer until the
 * upload finishes". One CI push froze the server for ~1.1 s at 20k resources
 * (measured: 313 ms + 398 ms + 372 ms across three full canonical passes).
 *
 * Two properties fix that, and they are separate: doing LESS work (one canonical
 * pass instead of four), and not holding the loop while doing it.
 */

/** Hand the event loop back so a long CPU pass cannot monopolize it. `setImmediate`
 *  (not `setTimeout(0)`) runs pending I/O callbacks first, which is exactly the
 *  "let the other requests through" behaviour wanted here. */
const yieldToEventLoop = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve));

/** How many canonical fragments / redacted items between yields. Big enough that
 *  the yield overhead stays in the noise, small enough that the loop is never
 *  held for a perceptible slice. */
const YIELD_EVERY = 500;

/**
 * sha256 of a value's CANONICAL JSON, computed WITHOUT ever materializing that
 * JSON as one string, and yielding to the event loop as it goes.
 *
 * Byte-identical to `sha256(canonicalJson(value))` by construction — the
 * fragments emitted here are the same fragments `canonicalJson` concatenates,
 * in the same order — and `test/projectDataIngest.test.ts` pins that
 * equivalence over a deliberately awkward corpus rather than trusting the
 * claim. That test is the contract: the digest is a wire-visible value every
 * uploader recomputes, so a divergence here would refuse every upload.
 *
 * Iterative, with an explicit stack: the recursive `canonicalJson` builds one
 * string per nesting level and the whole 11 MiB result at the top, which is the
 * allocation half of the cost the finding measured.
 */
export async function hashCanonical(value: unknown): Promise<string> {
  const h = createHash('sha256');
  // Work items are processed LIFO: either a literal fragment to emit, or a value
  // still to be serialized.
  type Work = { lit: string } | { val: unknown };
  const stack: Work[] = [{ val: value }];
  let sinceYield = 0;
  while (stack.length > 0) {
    const w = stack.pop()!;
    if ('lit' in w) {
      h.update(w.lit, 'utf8');
    } else {
      const v = w.val;
      if (v === null || typeof v !== 'object') {
        // Matches canonicalJson exactly, INCLUDING its `?? 'null'`: `undefined`
        // and functions stringify to undefined and are written as `null`.
        h.update(JSON.stringify(v) ?? 'null', 'utf8');
      } else if (Array.isArray(v)) {
        h.update('[', 'utf8');
        stack.push({ lit: ']' });
        for (let i = v.length - 1; i >= 0; i--) {
          stack.push({ val: v[i] });
          if (i > 0) stack.push({ lit: ',' });
        }
      } else {
        const obj = v as Record<string, unknown>;
        const keys = Object.keys(obj).sort();
        h.update('{', 'utf8');
        stack.push({ lit: '}' });
        for (let i = keys.length - 1; i >= 0; i--) {
          const k = keys[i]!;
          stack.push({ val: obj[k] });
          stack.push({ lit: `${JSON.stringify(k)}:` });
          if (i > 0) stack.push({ lit: ',' });
        }
      }
    }
    if (++sinceYield >= YIELD_EVERY) {
      sinceYield = 0;
      await yieldToEventLoop();
    }
  }
  return h.digest('hex');
}

/** The documented digest rule: sha256 over the CANONICAL JSON (recursive
 * key-sorted, no whitespace — `domain/audit.ts#canonicalJson`) of the part. */
export async function partDigest(value: unknown): Promise<string> {
  return hashCanonical(value);
}

export async function digestsOf(bundle: {
  inventory: unknown;
  blocks: unknown;
  manifests?: unknown;
}): Promise<StoredDigests> {
  return {
    inventorySha256: await partDigest(bundle.inventory),
    blocksSha256: await partDigest(bundle.blocks),
    ...(bundle.manifests !== undefined ? { manifestsSha256: await partDigest(bundle.manifests) } : {}),
  };
}

/**
 * Structural equality for JSON values — the question `rerunRedaction` actually
 * asks ("did the redactor change anything?").
 *
 * It used to ask it as `canonicalJson(a) !== canonicalJson(b)`: two full
 * recursive key-sorting serializations, PER RESOURCE and PER viewOnly block,
 * building two throwaway strings to compare them and discard both. At the 50k
 * cap that is 100k serializations to answer 50k boolean questions. This walks
 * the pair once, allocates nothing, and stops at the first difference — and the
 * redactor returns the SAME string instance for every value it leaves alone, so
 * the common (already-clean) bundle compares by identity nearly all the way
 * down.
 *
 * Key-set equality is checked both ways round, so a key present on only one
 * side is a difference regardless of which side carries it.
 */
export function sameJsonValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    // NaN is not a JSON value; every other primitive is settled by `===` above.
    return false;
  }
  const aIsArr = Array.isArray(a);
  if (aIsArr !== Array.isArray(b)) return false;
  if (aIsArr) {
    const x = a as unknown[];
    const y = b as unknown[];
    if (x.length !== y.length) return false;
    for (let i = 0; i < x.length; i++) if (!sameJsonValue(x[i], y[i])) return false;
    return true;
  }
  const x = a as Record<string, unknown>;
  const y = b as Record<string, unknown>;
  const xk = Object.keys(x);
  if (xk.length !== Object.keys(y).length) return false;
  for (const k of xk) {
    if (!Object.prototype.hasOwnProperty.call(y, k)) return false;
    if (!sameJsonValue(x[k], y[k])) return false;
  }
  return true;
}

export type BundleProblem = { field: string; problem: string };

/**
 * Structural cross-checks zod can't express: chunk-name shape (they become file
 * names), the index ⟷ chunks agreement (the index is derived data — a mismatch
 * means a different producer or a tampered bundle), and the manifest schema.
 * Returns the FIRST problem (fail closed, no partial acceptance).
 */
export function bundleProblem(bundle: UploadBundle): BundleProblem | null {
  const chunkNames = Object.keys(bundle.blocks.chunks);
  if (chunkNames.length > MAX_CHUNKS) {
    return { field: 'blocks.chunks', problem: `more than ${MAX_CHUNKS} chunk files` };
  }
  for (const name of chunkNames) {
    if (!CHUNK_NAME.test(name)) return { field: 'blocks.chunks', problem: `chunk name "${name}" is not a safe file base` };
    if (name === 'index') return { field: 'blocks.chunks', problem: 'chunk name "index" is reserved for the address map — rename the source file' };
    const addresses = Object.keys(bundle.blocks.chunks[name]!);
    if (addresses.length > MAX_ADDRESSES_PER_CHUNK) {
      return { field: 'blocks.chunks', problem: `chunk "${name}" holds more than ${MAX_ADDRESSES_PER_CHUNK} addresses` };
    }
  }
  const indexEntries = Object.entries(bundle.blocks.index);
  if (indexEntries.length > MAX_INDEX_ENTRIES) {
    return { field: 'blocks.index', problem: `more than ${MAX_INDEX_ENTRIES} index entries` };
  }
  const chunkSet = new Set(chunkNames);
  for (const [address, chunk] of indexEntries) {
    if (!chunkSet.has(chunk)) return { field: 'blocks.index', problem: `index entry "${address}" names a chunk "${chunk}" the bundle does not carry` };
  }
  // Every chunk address must be reachable through the index (the index is the
  // complete address map — an unindexed block would be dead weight or smuggling).
  for (const name of chunkNames) {
    for (const address of Object.keys(bundle.blocks.chunks[name]!)) {
      if (bundle.blocks.index[address] !== name) {
        return { field: 'blocks.chunks', problem: `block "${address}" in chunk "${name}" is not indexed to that chunk` };
      }
    }
  }
  return null;
}

/* ── server-side redaction re-run ──────────────────────────────────────────── */

export type RedactionResult = {
  bundle: UploadBundle;
  /** Plain-language warnings — non-empty when the server masked anything the
   * upload had not. The STORED (post-redaction) content is what gets served. */
  warnings: string[];
  problem: BundleProblem | null;
  /**
   * Did the re-run actually mask anything? FALSE means the stored bundle is
   * structurally identical to the uploaded one, which is what lets the caller
   * reuse the digests it has already computed instead of paying a second full
   * canonical pass over the whole estate (PERF-12). It is deliberately NOT
   * `warnings.length > 0`: the warnings are per-part prose that a future part
   * could forget to add, whereas this is set by the comparison itself, at the
   * one place that knows.
   */
  changed: boolean;
};

/**
 * Re-run the shared redaction rules over everything that gets served: every
 * block source (HCL via `redactHcl`; a `viewOnly` JSON rendering via
 * `redactTfJson`), every inventory attribute value, and every MANIFEST
 * (security review: manifests are `.passthrough()` envelopes whose op
 * internals ride along unvalidated, and they are served verbatim to the
 * tenant's members — so their string values get the same JSON value-redactor,
 * or a secret in an uploaded manifest would be the one lane through). All the
 * redactors are idempotent, so an already-clean CI upload passes through
 * byte-identical.
 */
export async function rerunRedaction(bundle: UploadBundle): Promise<RedactionResult> {
  let maskedBlocks = 0;
  let maskedResources = 0;
  let maskedManifests = 0;
  // Yield budget shared across all three passes: the loop must be handed back
  // every YIELD_EVERY items of ingest work, not every YIELD_EVERY items of
  // whichever pass happens to be running.
  let sinceYield = 0;
  const tick = async (): Promise<void> => {
    if (++sinceYield >= YIELD_EVERY) {
      sinceYield = 0;
      await yieldToEventLoop();
    }
  };

  const chunks: UploadBundle['blocks']['chunks'] = {};
  for (const [name, chunk] of Object.entries(bundle.blocks.chunks)) {
    const out: Record<string, z.infer<typeof UploadBlockSource>> = {};
    for (const [address, block] of Object.entries(chunk)) {
      if (block.viewOnly) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(block.source);
        } catch {
          return {
            bundle,
            warnings: [],
            problem: { field: 'blocks.chunks', problem: `viewOnly block "${address}" claims a JSON rendering but is not valid JSON` },
            changed: false,
          };
        }
        const redacted = redactTfJson(parsed);
        if (!sameJsonValue(redacted, parsed)) {
          maskedBlocks += 1;
          out[address] = { ...block, source: JSON.stringify(redacted, null, 2) };
        } else {
          out[address] = block;
        }
      } else {
        const source = redactHcl(block.source);
        if (source !== block.source) maskedBlocks += 1;
        out[address] = source === block.source ? block : { ...block, source };
      }
      await tick();
    }
    chunks[name] = out;
  }

  const resources: UploadBundle['inventory']['resources'] = [];
  for (const r of bundle.inventory.resources) {
    const redacted = redactTfJson(r.attributes) as Record<string, string | number | boolean>;
    if (!sameJsonValue(redacted, r.attributes)) {
      maskedResources += 1;
      resources.push({ ...r, attributes: redacted });
    } else {
      resources.push(r);
    }
    await tick();
  }

  // Manifests: the whole (parsed) JSON of each one through the value-redactor —
  // structure is preserved (only string VALUES are ever masked), so the app's
  // deep re-parse at read time still sees the envelope it expects.
  let manifests: UploadBundle['manifests'];
  if (bundle.manifests !== undefined) {
    manifests = [];
    for (const m of bundle.manifests) {
      const redacted = redactTfJson(m) as typeof m;
      if (!sameJsonValue(redacted, m)) {
        maskedManifests += 1;
        manifests.push(redacted);
      } else {
        manifests.push(m);
      }
      await tick();
    }
  }

  const warnings: string[] = [];
  if (maskedBlocks > 0) {
    warnings.push(`The server masked values in ${maskedBlocks} block(s) the upload had not masked. The masked copy is what will be served — check the account's CI redaction step.`);
  }
  if (maskedResources > 0) {
    warnings.push(`The server masked attribute values on ${maskedResources} inventory resource(s) the upload had not masked. The masked copy is what will be served.`);
  }
  if (maskedManifests > 0) {
    warnings.push(`The server masked values in ${maskedManifests} manifest(s) the upload had not masked. The masked copy is what will be served — check the account's CI redaction step.`);
  }

  return {
    bundle: {
      ...bundle,
      inventory: { ...bundle.inventory, resources },
      blocks: { index: bundle.blocks.index, chunks },
      ...(manifests !== undefined ? { manifests } : {}),
    },
    warnings,
    problem: null,
    // Every masking site above increments exactly one of these counters, so
    // "nothing was masked" IS "the stored bundle equals the uploaded one".
    changed: maskedBlocks > 0 || maskedResources > 0 || maskedManifests > 0,
  };
}

/* ── the on-disk version store ─────────────────────────────────────────────── */

/** The default data root: `<CCP_DATA_DIR>/projects` (beside the FileStore's
 * ccp.json, never inside it). Tests inject their own root via createApp. */
export function resolveProjectDataRoot(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.CCP_DATA_DIR || '.ccp-data', 'projects');
}

const versionDir = (root: string, projectId: string, version: number): string =>
  join(root, projectId, `v${version}`);

/**
 * Write one staged version's files. Content is written into a temp dir first and
 * atomically renamed into place, so a crash never leaves a half-written version
 * where the serve path could find it. The caller allocates the version NUMBER by
 * winning the metadata-row `ifNotExists` put FIRST — so if a same-numbered dir
 * already exists here it is, by construction, an orphan from a crashed earlier
 * attempt (a dir whose row was never written) and is safely replaced.
 */
export async function writeProjectDataVersion(
  root: string,
  projectId: string,
  version: number,
  bundle: UploadBundle,
): Promise<void> {
  const finalDir = versionDir(root, projectId, version);
  if (existsSync(finalDir)) rmSync(finalDir, { recursive: true, force: true });
  const tmp = `${finalDir}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  await mkdir(join(tmp, 'blocks'), { recursive: true });
  const json = (v: unknown): string => `${JSON.stringify(v, null, 2)}\n`;
  await writeFile(join(tmp, 'inventory.json'), json(bundle.inventory), 'utf8');
  if (bundle.manifests !== undefined) {
    await writeFile(join(tmp, 'manifests.json'), json(bundle.manifests), 'utf8');
  }
  await writeFile(join(tmp, 'blocks', 'index.json'), json(bundle.blocks.index), 'utf8');
  for (const [name, chunk] of Object.entries(bundle.blocks.chunks)) {
    await writeFile(join(tmp, 'blocks', `${name}.json`), json(chunk), 'utf8');
  }
  try {
    await rename(tmp, finalDir);
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
  // DATA-6 — the rename above is atomic against a process kill regardless, but the
  // directory ENTRY it creates is not durable against power loss until the
  // containing directory's own metadata is flushed — the same "cheap hardening"
  // FileStore.writeAtomic/ERR-10 applies. Best-effort: some filesystems refuse a
  // directory open-for-sync, and failing an already-landed write over that would
  // be worse than the narrow window this closes.
  await syncDir(dirname(finalDir));
}

async function syncDir(dir: string): Promise<void> {
  let dh;
  try {
    dh = await fsOpen(dir, 'r');
    await dh.sync();
  } catch {
    // see above — deliberately swallowed
  } finally {
    await dh?.close().catch(() => undefined);
  }
}

/** Best-effort removal of one staged version's files (upload row-write failed). */
export function removeProjectDataVersion(root: string, projectId: string, version: number): void {
  rmSync(versionDir(root, projectId, version), { recursive: true, force: true });
}

/** Best-effort removal of EVERYTHING stored for a project (deregister-ack). */
export function removeProjectData(root: string, projectId: string): void {
  rmSync(join(root, projectId), { recursive: true, force: true });
}

export type ServedFile =
  | { kind: 'inventory' }
  | { kind: 'manifests' }
  | { kind: 'blocks-index' }
  | { kind: 'blocks-chunk'; chunk: string };

/**
 * Read one served file's raw JSON text, or null when absent (fail closed — a
 * vanished file serves 404, never a partial). `chunk` MUST already be validated
 * against the version row's stored chunk list; the shape guard here is defense
 * in depth, not the authorization.
 *
 * PERF-6 — async `fs.promises.readFile`, not sync: the serve endpoints are on
 * the app's hot read path (every route mount, pre-fix), and a served file can
 * be most of the 16 MiB upload cap — a sync read blocks the WHOLE event loop
 * (every other in-flight request, on any project) for the duration of that one
 * disk read.
 */
export async function readProjectDataFile(
  root: string,
  projectId: string,
  version: number,
  file: ServedFile,
): Promise<string | null> {
  let rel: string;
  switch (file.kind) {
    case 'inventory':
      rel = 'inventory.json';
      break;
    case 'manifests':
      rel = 'manifests.json';
      break;
    case 'blocks-index':
      rel = join('blocks', 'index.json');
      break;
    case 'blocks-chunk': {
      if (!CHUNK_NAME.test(file.chunk) || file.chunk === 'index') return null;
      rel = join('blocks', `${file.chunk}.json`);
      break;
    }
  }
  const path = join(versionDir(root, projectId, version), rel);
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

/** Ensure the data root exists (server boot; harmless if present). */
export function ensureProjectDataRoot(root: string): void {
  mkdirSync(root, { recursive: true });
}
