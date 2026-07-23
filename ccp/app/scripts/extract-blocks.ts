/**
 * Extract every top-level `resource` block's exact source (file + line) from a
 * Terraform root into src/data/blocks/<chunk>.json — the data behind the R5
 * "see the whole block you're changing" view (0005 LEARN-3).
 *
 * Style-independent: uses the SAME tokenizer the app uses (src/lib/hclScan.ts) —
 * one scanner, no mirrored logic, so any coding style extracts identically.
 * Redaction uses the SAME redactor the app uses (src/lib/redact.ts) — every block
 * is masked HERE, before it can enter the repo/bundle.
 *
 * Scalable: --root <dir> (recursively walks *.tf), --out <dir>. Chunk keys are
 * collision-safe across a multi-root/multi-file estate. Deterministic output
 * (no timestamps) → reruns are byte-identical.
 *
 * JSON-syntax Terraform (*.tf.json): the tokenizer above is HCL-native-syntax
 * only, so a `.tf.json` file's resource blocks can't be sliced out of the raw
 * text the way native blocks are. They are extracted anyway — parsed from the
 * JSON body (tolerant of both the object and array JSON-block-body forms) and
 * emitted as a pretty-printed JSON rendering of that one resource, flagged
 * `viewOnly: true` on the chunk entry. Honest both ways: catalogctl refuses
 * .tf.json EDITS by design, so the flag says "look, don't touch" — but the R5
 * "see the whole block" surface no longer has holes (previously these were
 * counted + WARN'd per file yet never extracted, so a foreign/onboarded repo's
 * JSON-declared resources had no block view at all). The per-file WARN stays,
 * now informational (0014 fix#4 established the loud-count convention; the
 * numbers still let an operator cross-check prescan's independent census).
 * Values are masked by the same rule set as native blocks, via redactTfJson
 * (redact.ts) — at generation time, before anything enters the repo/bundle.
 *
 * Module-sourced resources (0014 dim-5): a resource declared inside a called
 * module's directory has the real Terraform address `module.<instance>.<type>.<name>`,
 * never the bare `<type>.<name>` a root resource gets — emitting the bare
 * form would let downstream tooling (e.g. catalogctl plan-check's R1
 * allow-set) target the wrong block entirely. Local module calls
 * (`module "<instance>" { source = "./..." }`, declared in the root's own
 * top-level files) are detected and each call's target directory resolved;
 * a directory called EXACTLY once, with no count/for_each on that call and
 * no module block of its own, is "uniquely resolvable" and every resource
 * under it is emitted with the full `module.<instance>.` address prefix.
 * Anything else touching a called module's directory — that directory
 * instantiated 2+ times, count/for_each on the call, a module block of its
 * own inside the directory (nested modules — the resources inside might
 * really belong to a deeper address this script does not attempt to
 * resolve), or a non-local/non-literal source — is refused rather than
 * guessed: excluded from the index entirely, with a counted per-file WARN
 * naming the directory and every instance name it was called as, mirroring
 * the .tf.json WARN shape above. Root-module files (directly under --root,
 * never reachable through a local module call) are completely unaffected —
 * same bare addresses as before this existed.
 *
 * The module-call scanner below is intentionally self-contained rather than
 * folded into hclScan.ts: it reuses hclScan's exported `lineStartDepths` (the
 * same depth accounting scanTopLevelBlocks itself uses, so comments/strings/
 * heredocs inside a module block never fool it) instead of duplicating the
 * character walker, and needs no byte-span slicing at all — a module block's
 * own source text is never persisted, only its name/source/count/for_each
 * shape feeds address resolution.
 *
 * Run: npx vite-node scripts/extract-blocks.ts [--root <dir>] [--out <dir>]
 */
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  statSync,
  rmSync,
  existsSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanTopLevelBlocks, lineStartDepths } from '@/lib/hclScan';
import { redactHcl, redactTfJson } from '@/lib/redact';

const APP = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = join(APP, '..', '..');

function arg(flag: string, fallback: string): string {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

/** Recursively collect *.tf and *.tf.json files under a root (sorted,
 * deterministic), reported separately: only the former can be extracted by
 * the HCL tokenizer below. */
function walkTf(dir: string): { tf: string[]; tfJson: string[] } {
  const tf: string[] = [];
  const tfJson: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (name === '.terraform' || name === '.git' || name === 'node_modules') continue;
      const sub = walkTf(p);
      tf.push(...sub.tf);
      tfJson.push(...sub.tfJson);
    } else if (name.endsWith('.tf.json')) {
      tfJson.push(p);
    } else if (name.endsWith('.tf')) {
      tf.push(p);
    }
  }
  return { tf, tfJson };
}

/** One top-level resource declaration parsed out of a `.tf.json` file. */
export interface JsonResourceBlock {
  type: string;
  name: string;
  /** The resource's own JSON body, exactly as parsed from the file. */
  body: unknown;
}

/** Every top-level `resource "<type>" "<name>"` equivalent declared in a
 * JSON-syntax Terraform file, in document order. Tolerant of both
 * JSON-syntax block-body forms (a single object, or an array of objects
 * merged at that level — HCL's JSON mapping spec allows either), so a
 * real-world `.tf.json` is read correctly whichever style authored it.
 * Returns [] (not an error) for a file with no top-level `resource` key;
 * returns null if the file is not valid JSON so the caller can report a
 * parse warning distinct from "zero resources". */
export function listJsonResourceBlocks(text: string): JsonResourceBlock[] | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (data === null || typeof data !== 'object') return [];
  const resourceRaw = (data as Record<string, unknown>).resource;
  if (resourceRaw === undefined) return [];
  const typeMaps = Array.isArray(resourceRaw) ? resourceRaw : [resourceRaw];
  const out: JsonResourceBlock[] = [];
  for (const typeMap of typeMaps) {
    if (typeMap === null || typeof typeMap !== 'object') continue;
    for (const [type, nameBody] of Object.entries(typeMap as Record<string, unknown>)) {
      if (nameBody === null || typeof nameBody !== 'object') continue;
      const nameObjs = Array.isArray(nameBody) ? nameBody : [nameBody];
      for (const nameObj of nameObjs) {
        if (nameObj === null || typeof nameObj !== 'object') continue;
        for (const [name, body] of Object.entries(nameObj as Record<string, unknown>)) {
          out.push({ type, name, body });
        }
      }
    }
  }
  return out;
}

/** Count of {@link listJsonResourceBlocks}: -1 for invalid JSON (kept as the
 * long-standing counting seam — tests and the census cross-check use it). */
export function countJsonResourceBlocks(text: string): number {
  const blocks = listJsonResourceBlocks(text);
  return blocks === null ? -1 : blocks.length;
}

/** The view-only source rendering for one `.tf.json` resource: the smallest
 * valid JSON-syntax Terraform document declaring exactly that resource,
 * pretty-printed, with values masked by the shared rule set (redact.ts). */
export function renderJsonBlockSource(block: JsonResourceBlock): string {
  return JSON.stringify(
    { resource: { [block.type]: { [block.name]: redactTfJson(block.body) } } },
    null,
    2,
  );
}

/** A stable, filesystem-safe chunk key from a file's path relative to root.
 * Single flat root → the basename (keeps existing output stable); nested/multi
 * files disambiguate by their relative dir so two `main.tf`s never collide.
 * `.tf.json` strips its full extension too, so `storage.tf.json` chunks as
 * `storage` (colliding names fall through to the existing disambiguators). */
function chunkKey(root: string, file: string, used: Set<string>): string {
  const rel = relative(root, file).replace(/\.tf(\.json)?$/, '');
  const base = rel.split(sep).pop()!;
  let key = base;
  if (used.has(key)) key = rel.split(sep).join('__'); // disambiguate with the path
  let k = key;
  let n = 2;
  while (used.has(k)) k = `${key}__${n++}`; // final guard
  used.add(k);
  return k;
}

// ── module-sourced resource addressing (0014 dim-5) ────────────────────────

interface ModuleCallSite {
  /** the label in `module "<instance>" { ... }` */
  instance: string;
  /** literal string value of a `source = "..."` line, or null when absent or
   * not a plain string literal (e.g. an interpolated or variable source) */
  sourceLiteral: string | null;
  /** true when the call has a top-level `count` or `for_each` attribute */
  hasCountOrForEach: boolean;
}

interface ModuleDirResolution {
  /** every instance name this directory was called as (length 1 = simple case) */
  instances: string[];
  /** same source dir called 2+ times, count/for_each on (any of) the
   * call(s), or a module block of the directory's own inside it */
  ambiguous: boolean;
}

const MODULE_HEADER_RE = /^module[ \t]+"([^"]+)"[ \t]*\{/;
const SOURCE_ATTR_RE = /^source\s*=\s*"([^"]*)"\s*(#.*|\/\/.*)?$/;
const COUNT_OR_FOREACH_RE = /^(count|for_each)\s*=/;

/** Local module source, per this repo's own established convention (mirrors
 * tools/catalogctl/internal/prescan/prescan.go's moduleSourceAllowed): a bare
 * "." or a "./" / "../" -prefixed path. Anything else — a registry address, a
 * git/http(s) source, or (since SOURCE_ATTR_RE only ever captures a plain
 * string literal) an interpolated or variable source — is out of scope: there
 * is no local directory under --root to resolve, so it is simply never
 * mapped to one rather than guessed at. */
function isLocalModuleSource(source: string): boolean {
  return source === '.' || source.startsWith('./') || source.startsWith('../');
}

/**
 * Top-level (depth-0) `module "<name>" { ... }` calls in one file's source,
 * decoy-proof the same way scanTopLevelBlocks is: `lineStartDepths` (hclScan's
 * own exported depth accounting, the same machinery blockDiff.ts uses to find
 * a block's own top-level attribute lines) is computed ONCE for the whole
 * file, so a "module" appearing inside a comment/string/heredoc never
 * matches — it never reaches depth 0 at the start of its line. Line
 * granularity only, no byte span: a module block is never persisted, only
 * routed through, so its exact offsets are never needed — just its name and
 * its own depth-1 lines (source / count / for_each).
 */
function findTopLevelModuleCalls(src: string): ModuleCallSite[] {
  const lines = src.split('\n');
  const depths = lineStartDepths(src);
  const calls: ModuleCallSite[] = [];
  let i = 0;
  while (i < lines.length) {
    const headerDepth = depths[i] ?? 0;
    if (headerDepth === 0) {
      const m = MODULE_HEADER_RE.exec(lines[i]!.trim());
      if (m) {
        const instance = m[1]!;
        let sourceLiteral: string | null = null;
        let hasCountOrForEach = false;
        let j = i + 1;
        while (j < lines.length && (depths[j] ?? 0) >= 1) {
          if ((depths[j] ?? 0) === 1) {
            const attrLine = lines[j]!.trim();
            const sm = SOURCE_ATTR_RE.exec(attrLine);
            if (sm) sourceLiteral = sm[1]!;
            if (COUNT_OR_FOREACH_RE.test(attrLine)) hasCountOrForEach = true;
          }
          j += 1;
        }
        calls.push({ instance, sourceLiteral, hasCountOrForEach });
        // `j` is already the first line NOT consumed by this block (the loop
        // condition failed before its body ran for `j`) — resume scanning
        // exactly there, so a header on the very next line is never skipped.
        i = j;
        continue;
      }
    }
    i += 1;
  }
  return calls;
}

/** Does `dir` declare any top-level module block of its OWN (regardless of
 * that inner call's source)? Presence alone makes the OUTER module
 * ambiguous — resources inside `dir` might really belong to a deeper nested
 * module address this script does not attempt to resolve. Reuses the file
 * list walkTf already produced (and its .terraform/.git/node_modules
 * exclusions) instead of re-reading the directory. */
function dirHasNestedModuleCalls(dir: string, allTfFiles: string[]): boolean {
  for (const file of allTfFiles) {
    if (dirname(file) !== dir) continue;
    if (findTopLevelModuleCalls(readFileSync(file, 'utf8')).length > 0) return true;
  }
  return false;
}

/**
 * Every LOCAL module call declared in the root's own top-level files, resolved
 * to a target directory and classified unique-vs-ambiguous. Directories are
 * absolute, normalized paths (path.resolve), so two differently-spelled
 * sources that resolve to the same directory (e.g. "./modules/vpc" and
 * "./modules/../modules/vpc") are correctly treated as one call site — same
 * as Terraform itself would.
 */
function classifyModuleDirs(
  rootAbs: string,
  rootLevelFiles: string[],
  allTfFiles: string[],
): Map<string, ModuleDirResolution> {
  const dirInstances = new Map<string, string[]>();
  const dirHasOwnCountOrForEach = new Map<string, boolean>();

  for (const file of rootLevelFiles) {
    const calls = findTopLevelModuleCalls(readFileSync(file, 'utf8'));
    for (const call of calls) {
      if (call.sourceLiteral === null || !isLocalModuleSource(call.sourceLiteral)) continue;
      const dir = resolve(rootAbs, call.sourceLiteral);
      const list = dirInstances.get(dir);
      if (list) list.push(call.instance);
      else dirInstances.set(dir, [call.instance]);
      if (call.hasCountOrForEach) dirHasOwnCountOrForEach.set(dir, true);
    }
  }

  const result = new Map<string, ModuleDirResolution>();
  for (const [dir, instances] of dirInstances) {
    const ambiguous =
      instances.length > 1 ||
      dirHasOwnCountOrForEach.get(dir) === true ||
      dirHasNestedModuleCalls(dir, allTfFiles);
    result.set(dir, { instances, ambiguous });
  }
  return result;
}

type FileBucket =
  | { kind: 'root' }
  | { kind: 'module'; instance: string }
  | { kind: 'ambiguous'; dir: string; instances: string[] };

/** Which address shape `file` gets: bare (root, or an orphaned subdirectory no
 * module block references — unchanged, existing behavior), `module.<instance>.`
 * -prefixed (uniquely resolved), or excluded (ambiguous). Matches by exact
 * directory OR any directory NESTED under a resolved module dir, so a
 * module's own subdirectories inherit its resolution uniformly. */
function resolveFileBucket(
  file: string,
  rootAbs: string,
  moduleDirs: Map<string, ModuleDirResolution>,
): FileBucket {
  const fileDir = dirname(file);
  if (fileDir === rootAbs) return { kind: 'root' };
  for (const [dir, resolution] of moduleDirs) {
    if (fileDir === dir || fileDir.startsWith(dir + sep)) {
      if (resolution.ambiguous) return { kind: 'ambiguous', dir, instances: resolution.instances };
      return { kind: 'module', instance: resolution.instances[0]! };
    }
  }
  // Not root, not under any recognized local module call: an orphaned
  // subdirectory no module block references. Out of this fix's scope — left
  // exactly as before (bare address): there is no module context to
  // attribute it to, and it is not what "module-sourced resources" means.
  return { kind: 'root' };
}

export interface ExtractSummary {
  /** Blocks extracted from native-HCL .tf files (the editable kind). */
  totalBlocks: number;
  tfFileCount: number;
  redactedCount: number;
  tfJsonFileCount: number;
  /** Resource blocks extracted from .tf.json files as view-only JSON
   * renderings (`viewOnly: true` on each chunk entry). */
  tfJsonViewOnlyBlocks: number;
  tfJsonUnparsableCount: number;
  /** .tf files excluded because they sit under an ambiguously-instantiated
   * local module directory (see the module-addressing doc comment above). */
  ambiguousModuleFileCount: number;
  ambiguousModuleSkippedBlocks: number;
  /** WARN/log lines, in emission order — asserted on by tests instead of
   * capturing console output. */
  messages: string[];
}

/**
 * Core extraction, parameterized so it is callable in-process from a test
 * with a small fixture root (rather than only via the CLI's argv-derived
 * environments/prod default). Side-effecting (writes OUT/<chunk>.json +
 * OUT/index.json) — that persistence is the whole point — but takes no
 * global state and reads no argv, so it is safe to import and call directly.
 */
export function runExtractBlocks(root: string, out: string): ExtractSummary {
  const { tf: files, tfJson } = walkTf(root);
  const rootAbs = resolve(root);
  const usedKeys = new Set<string>();
  const index: Record<string, string> = {};
  const messages: string[] = [];
  let total = 0;
  let redactedCount = 0;
  let ambiguousModuleFileCount = 0;
  let ambiguousModuleSkippedBlocks = 0;

  const rootLevelFiles = files.filter((f) => dirname(f) === rootAbs);
  const moduleDirs = classifyModuleDirs(rootAbs, rootLevelFiles, files);

  // Fresh output dir so a shrunk estate never leaves stale chunks behind.
  if (existsSync(out)) rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    const blocks = scanTopLevelBlocks(src);
    if (blocks.length === 0) continue;

    const bucket = resolveFileBucket(file, rootAbs, moduleDirs);
    if (bucket.kind === 'ambiguous') {
      const relDir = relative(REPO_ROOT, bucket.dir).split(sep).join('/');
      const calledAs = bucket.instances.map((n) => `"${n}"`).join(', ');
      const msg = `WARN: ${blocks.length} resource(s) in module dir ${relDir} NOT extracted: ambiguous instantiation (called as ${calledAs}).`;
      messages.push(msg);
      console.warn(msg);
      ambiguousModuleFileCount += 1;
      ambiguousModuleSkippedBlocks += blocks.length;
      continue;
    }

    // Integrity gates (the fixtures prove the scanner; these guard each real file).
    let cursor = -1;
    for (const b of blocks) {
      if (b.start <= cursor) throw new Error(`${file}: blocks overlap or out of order`);
      const slice = src.slice(b.start, b.end);
      if (!slice.startsWith('resource '))
        throw new Error(`${file}: block ${b.type}.${b.name} bad start`);
      if (!slice.trimEnd().endsWith('}'))
        throw new Error(`${file}: block ${b.type}.${b.name} bad end`);
      cursor = b.end;
    }

    const relFile = relative(REPO_ROOT, file).split(sep).join('/');
    const key = chunkKey(root, file, usedKeys);
    const map: Record<string, { file: string; line: number; source: string }> = {};

    for (const b of blocks) {
      const bareAddress = `${b.type}.${b.name}`;
      const address =
        bucket.kind === 'module' ? `module.${bucket.instance}.${bareAddress}` : bareAddress;
      const raw = src.slice(b.start, b.end).replace(/\r?\n+$/, ''); // trim trailing blank lines
      const source = redactHcl(raw);
      if (source !== raw) redactedCount += 1;
      map[address] = { file: relFile, line: b.startLine, source };
      if (index[address]) {
        // Same address in two files — keep the first, warn (rare; module dupes).
        const msg = `WARN: duplicate address ${address} (${index[address]} vs ${key}); keeping first`;
        messages.push(msg);
        console.warn(msg);
        continue;
      }
      index[address] = key;
      total += 1;
    }
    writeFileSync(join(out, `${key}.json`), JSON.stringify(map, null, 1) + '\n');
  }

  // .tf.json is JSON-syntax Terraform: scanTopLevelBlocks (the HCL-native-syntax
  // tokenizer) cannot slice its blocks out of the raw text, so each resource is
  // parsed from the JSON body and emitted as a view-only pretty-printed JSON
  // rendering instead (viewOnly: true — catalogctl refuses .tf.json edits by
  // design, so the entry is honest about being look-don't-touch). Processed
  // AFTER the .tf loop so a duplicate address keeps the editable HCL block.
  // The per-file WARN is kept, now informational (originally 0014 fix#4:
  // these files used to be silently invisible to walkTf entirely).
  let tfJsonViewOnlyBlocks = 0;
  let tfJsonUnparsable = 0;
  for (const file of tfJson) {
    const relFile = relative(REPO_ROOT, file).split(sep).join('/');
    const blocks = listJsonResourceBlocks(readFileSync(file, 'utf8'));
    if (blocks === null) {
      tfJsonUnparsable += 1;
      const msg = `WARN: ${relFile} is not valid JSON — skipped, resource count unknown (not extracted).`;
      messages.push(msg);
      console.warn(msg);
      continue;
    }

    // Same module-address resolution as native files: a .tf.json inside a
    // uniquely-called local module dir gets the module.<instance>. prefix; an
    // ambiguously-instantiated one is excluded loudly, never guessed.
    const bucket = resolveFileBucket(file, rootAbs, moduleDirs);
    if (bucket.kind === 'ambiguous' && blocks.length > 0) {
      const relDir = relative(REPO_ROOT, bucket.dir).split(sep).join('/');
      const calledAs = bucket.instances.map((n) => `"${n}"`).join(', ');
      const msg = `WARN: ${blocks.length} resource(s) in module dir ${relDir} NOT extracted: ambiguous instantiation (called as ${calledAs}).`;
      messages.push(msg);
      console.warn(msg);
      ambiguousModuleFileCount += 1;
      ambiguousModuleSkippedBlocks += blocks.length;
      continue;
    }

    tfJsonViewOnlyBlocks += blocks.length;
    const msg = `WARN: ${relFile} is JSON-syntax Terraform (.tf.json) — ${blocks.length} resource block(s) extracted VIEW-ONLY as pretty-printed JSON (catalogctl refuses .tf.json edits by design).`;
    messages.push(msg);
    console.warn(msg);
    if (blocks.length === 0) continue;

    const key = chunkKey(root, file, usedKeys);
    const map: Record<string, { file: string; line: number; source: string; viewOnly: true }> = {};
    for (const b of blocks) {
      const bareAddress = `${b.type}.${b.name}`;
      const address =
        bucket.kind === 'module' ? `module.${bucket.instance}.${bareAddress}` : bareAddress;
      // line 1: the rendering stands for the file's whole declaration of this
      // resource — JSON.parse keeps no positions, and a fabricated line would
      // be a lie the UI then repeats.
      map[address] = { file: relFile, line: 1, source: renderJsonBlockSource(b), viewOnly: true };
      if (index[address]) {
        const msg = `WARN: duplicate address ${address} (${index[address]} vs ${key}); keeping first`;
        messages.push(msg);
        console.warn(msg);
        continue;
      }
      index[address] = key;
    }
    writeFileSync(join(out, `${key}.json`), JSON.stringify(map, null, 1) + '\n');
  }

  writeFileSync(join(out, 'index.json'), JSON.stringify(index, null, 0) + '\n');

  return {
    totalBlocks: total,
    tfFileCount: files.length,
    redactedCount,
    tfJsonFileCount: tfJson.length,
    tfJsonViewOnlyBlocks,
    tfJsonUnparsableCount: tfJsonUnparsable,
    ambiguousModuleFileCount,
    ambiguousModuleSkippedBlocks,
    messages,
  };
}

// CLI entry point. vite-node executes this module directly; Vitest sets
// process.env.VITEST='true' in its worker (see verify-manifest-safety.ts for
// the same convention) so `import { runExtractBlocks }` in a test never
// re-runs the real environments/prod extraction as a side effect of import.
if (!process.env.VITEST) {
  const ROOT = arg('--root', join(APP, '..', '..', 'environments', 'prod'));
  const OUT = arg('--out', join(APP, 'src', 'data', 'blocks'));
  const summary = runExtractBlocks(ROOT, OUT);
  console.log(
    `Extracted ${summary.totalBlocks} resource blocks from ${summary.tfFileCount} .tf files under ${relative(APP, ROOT) || ROOT} → ${relative(APP, OUT)} (${summary.redactedCount} carried masked values).`,
  );
  if (summary.tfJsonFileCount > 0) {
    console.log(
      `Extracted VIEW-ONLY: ${summary.tfJsonViewOnlyBlocks} resource block(s) from ${summary.tfJsonFileCount} .tf.json file(s) as pretty-printed JSON` +
        (summary.tfJsonUnparsableCount > 0
          ? ` (${summary.tfJsonUnparsableCount} of those files failed to parse as JSON and were skipped)`
          : '') +
        ` — see WARN lines above.`,
    );
  }
  if (summary.ambiguousModuleFileCount > 0) {
    console.log(
      `NOT extracted: ${summary.ambiguousModuleSkippedBlocks} resource block(s) in ${summary.ambiguousModuleFileCount} file(s) under ambiguously-instantiated local modules — see WARN lines above.`,
    );
  }
}
