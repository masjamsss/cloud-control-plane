import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { InventoryResource } from '@/types';
import { chipLabelFor, resourceChips } from '@/lib/chipLabel';
import { escapeRegExp, loadEstateDenylist } from '../../scripts/lib/estateDenylist';

/**
 * Copy-quality lint — operator-facing text never leaks internal notation.
 *
 * Born from the 2026-07-14 owner screenshots ("the text quality looks sucks"):
 * service cards opened with "…operations for the Tokyo ERP estate (account
 * 123456789012, ap-…" truncated mid-string, op titles read "Toggle
 * skip_destroy on a log group", and rendered help cited spec sections
 * ("§1.2", "ADR-0009"). Three defect classes, made mechanical here the same
 * way opTaxonomy.test.ts freezes the group taxonomy:
 *
 *   1. Estate identity (account id / region) is DATA — it lives in
 *      project.json and renders once in the project switcher, never in
 *      manifest prose. (generalization.test.ts enforces the same for app
 *      CODE; this file covers the src/data manifest prose it excludes.)
 *   2. Raw identifiers (snake_case attrs, exposure enums) never appear as
 *      display text. Titles and labels must be plain language; descriptions
 *      and help may cite the exact Terraform attribute they change (that is
 *      the technical-detail layer under a plain title) but never a raw
 *      exposure enum like engineer_only — AccessBadge owns the display words.
 *   3. Internal doc notation (§-sections, 00NN proposal numbers, ADR-NN)
 *      never reaches an operator, in manifest prose or in rendered UI
 *      strings/JSX text.
 *
 * Prose fields scanned: manifest.summary, op.title, op.summary, op.description,
 * param.label, param.help — across the bundled catalog AND every vendored
 * project catalog. op.summary is the plain OPERATOR headline (the two-layer
 * description's prominent line): held to the same notation bans as op.title,
 * snake_case included, since it must read as plain language. Param `bounds`/`default`/`pattern` are machine values
 * (never rendered raw — BoundsHint derives its own copy), so they are out of
 * scope on purpose: ARNs there legitimately carry account ids.
 */

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

/* ── Banned patterns ─────────────────────────────────────────────────────── */

// The estate-specific bans (region, identity) are sourced from the resolved
// denylist — empty in the committed public built-in, real only in the untracked
// .estate-denylist.json — so a public checkout scans with never-match regexes while
// the private deployment's CI runs them at full strength. The generic notation/shape
// bans below (SPEC_SECTION, PROPOSAL_REF, ACCOUNT_ID, SNAKE_CASE, EXPOSURE_ENUM) are
// always on. See scripts/lib/estateDenylist.ts.
const dl = loadEstateDenylist();

/** Spec-section notation ("§4.4", "§1.2") — internal document references. */
const SPEC_SECTION = /§/;
/** Proposal numbers ("0013a", "0008") and ADRs ("ADR-0009") by name. */
const PROPOSAL_REF = /\b00\d{2}[a-z]?\b|\bADR-\d+/i;
/** Anything shaped like an AWS account id. Catches every account, not just
 * this estate's — a cross-account grant id in a card summary is still noise. */
const ACCOUNT_ID = /\b\d{12}\b/;
/** This estate's region — sourced from the denylist (empty public built-in → never
 * matches; the real region lives only in the untracked .estate-denylist.json and
 * belongs in project.json, which the switcher renders). */
const REGION = dl.region.length ? new RegExp(dl.region.map(escapeRegExp).join('|')) : /(?!)/;
/** A snake_case token — one underscore between word characters is enough. */
const SNAKE_CASE = /[A-Za-z0-9]_[A-Za-z0-9]/;
/** Raw exposure enums — AccessBadge maps these to their display words
 * ("Self-service" / "Guardrailed" / "Engineer-authored"). */
const EXPOSURE_ENUM = /\b(l1_self_service|l1_with_guardrails|engineer_only)\b/;
/** Known estate-identity tokens (D18 multi-project prose rule): manifests are
 * shared per service across projects, so this estate's org/domain names and
 * named functions never belong in their prose — estate context lives in
 * project data. Sourced from the denylist's estateTerms (case-insensitive, same as
 * the source-genericity gate; empty public built-in → never matches). The real
 * customer name and named functions live only in the untracked .estate-denylist.json,
 * never in committed source. */
const ESTATE_IDENTITY = dl.estateTerms.length
  ? new RegExp(dl.estateTerms.map(escapeRegExp).join('|'), 'i')
  : /(?!)/;

/**
 * The ONLY sanctioned region mentions: params whose VALUE is a region (or a
 * region-bearing DNS name) need a literal example of what to type. Keyed
 * `opId/paramName`; anything else mentioning the region must instead say
 * which zone/link it means in plain words. Widening this list needs the same
 * scrutiny as a generalization.test.ts ALLOWED entry.
 */
const REGION_EXAMPLE_HELP_ALLOWLIST = new Set<string>([
  // Emptied by the region-externalization lane (2026-07-22). Every manifest help example
  // that used to embed the real estate region now carries a neutral stand-in, so in
  // private (denylist) CI no help field matches REGION — there is nothing to exempt. The
  // stale-entries check below (which fires once the denylist supplies a region) keeps this
  // set honest: a future real-region literal in a help string must be scrubbed to the
  // neutral stand-in, never re-allowlisted here.
]);

/* ── Manifest prose collection ───────────────────────────────────────────── */

interface ManifestJson {
  summary?: string;
  operations?: {
    id: string;
    title?: string;
    summary?: string;
    consoleLabel?: string;
    description?: string;
    keywords?: string[];
    decisions?: string[];
    params?: { name: string; label?: string; help?: string }[];
  }[];
}

/** Every bundled manifest file: the main catalog + each vendored project's. */
function manifestFiles(): string[] {
  const files = readdirSync(join(SRC, 'data', 'manifests'))
    .filter((f) => f.endsWith('.json'))
    .map((f) => join(SRC, 'data', 'manifests', f));
  const projectsDir = join(SRC, 'data', 'projects');
  for (const project of readdirSync(projectsDir)) {
    const dir = join(projectsDir, project, 'manifests');
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue; // a project without vendored manifests uses the bundled set
    }
    for (const f of entries) {
      if (f.endsWith('.json')) files.push(join(dir, f));
    }
  }
  return files;
}

interface ProseField {
  /** e.g. "sns.json · sns-add-subscription · title" */
  where: string;
  /** "summary" | "title" | "description" | "label" | "help" */
  field: string;
  /** allowlist key for region examples ("opId/paramName"), '' elsewhere */
  key: string;
  text: string;
}

function collectProse(): { fields: ProseField[]; files: number; ops: number; params: number } {
  const fields: ProseField[] = [];
  let files = 0;
  let ops = 0;
  let params = 0;
  for (const file of manifestFiles()) {
    files += 1;
    const rel = file.slice(SRC.length + 1);
    const manifest = JSON.parse(readFileSync(file, 'utf8')) as ManifestJson;
    fields.push({ where: rel, field: 'summary', key: '', text: manifest.summary ?? '' });
    for (const op of manifest.operations ?? []) {
      ops += 1;
      fields.push({ where: `${rel} · ${op.id}`, field: 'title', key: '', text: op.title ?? '' });
      // op.summary — the plain operator headline (two-layer description). Scanned
      // like a title: it must read as plain language, so snake_case is banned too.
      fields.push({
        where: `${rel} · ${op.id}`,
        field: 'op-summary',
        key: '',
        text: op.summary ?? '',
      });
      // op.consoleLabel — the AWS-console field name the headline now leads with.
      // A plain label like op.title (snake_case banned): it must read as the exact
      // console wording an operator scans for, never a raw identifier.
      fields.push({
        where: `${rel} · ${op.id}`,
        field: 'consoleLabel',
        key: '',
        text: op.consoleLabel ?? '',
      });
      fields.push({
        where: `${rel} · ${op.id}`,
        field: 'description',
        key: '',
        text: op.description ?? '',
      });
      // 0034 D6 — keywords are search data, not rendered prose, but they are
      // still authored text: the same notation/identity bans apply so ticket
      // vocabulary can't rot into internal notation either.
      for (const kw of op.keywords ?? []) {
        fields.push({ where: `${rel} · ${op.id}`, field: 'keyword', key: '', text: kw });
      }
      // 0033 A1 — decisions render as the engineer TODO checklist (skeleton,
      // request detail, PR body): operator-facing prose, same bans.
      for (const d of op.decisions ?? []) {
        fields.push({ where: `${rel} · ${op.id}`, field: 'decision', key: '', text: d });
      }
      for (const param of op.params ?? []) {
        params += 1;
        const where = `${rel} · ${op.id} · ${param.name}`;
        fields.push({ where, field: 'label', key: '', text: param.label ?? '' });
        fields.push({
          where,
          field: 'help',
          key: `${op.id}/${param.name}`,
          text: param.help ?? '',
        });
      }
    }
  }
  return { fields, files, ops, params };
}

const prose = collectProse();

function offendersWhere(
  pattern: RegExp,
  filter: (f: ProseField) => boolean = () => true,
): string[] {
  return prose.fields
    .filter((f) => filter(f) && pattern.test(f.text))
    .map((f) => `${f.where} [${f.field}]: ${f.text.slice(0, 100)}`);
}

describe('copy lint — manifest prose (summary/title/description/label/help)', () => {
  it('scans the real catalogs (sanity)', () => {
    expect(prose.files).toBeGreaterThanOrEqual(30);
    expect(prose.ops).toBeGreaterThanOrEqual(700);
    expect(prose.params).toBeGreaterThanOrEqual(1500);
  });

  it('no spec-section notation (§) anywhere', () => {
    const offenders = offendersWhere(SPEC_SECTION);
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('no internal proposal/ADR references (00NN, ADR-N) anywhere', () => {
    const offenders = offendersWhere(PROPOSAL_REF);
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('no account-id-shaped number anywhere', () => {
    const offenders = offendersWhere(ACCOUNT_ID);
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('no region literal outside the allowlisted value-example help strings', () => {
    const offenders = offendersWhere(
      REGION,
      (f) => !(f.field === 'help' && REGION_EXAMPLE_HELP_ALLOWLIST.has(f.key)),
    );
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('every allowlisted region example still exists (no stale entries)', () => {
    // Allowlist hygiene only means something when REGION actually matches — i.e. the
    // denylist supplied a region (private CI). With the empty public built-in REGION
    // never matches, so there is nothing to verify; this check rides with the pattern.
    if (dl.region.length === 0) return;
    const liveKeys = new Set(
      prose.fields.filter((f) => f.field === 'help' && REGION.test(f.text)).map((f) => f.key),
    );
    const stale = [...REGION_EXAMPLE_HELP_ALLOWLIST].filter((k) => !liveKeys.has(k));
    expect(stale, `stale allowlist entries: ${stale.join(', ')}`).toEqual([]);
  });

  it('titles, plain-headline summaries, console labels, and labels contain no snake_case token', () => {
    const offenders = offendersWhere(
      SNAKE_CASE,
      (f) =>
        f.field === 'title' ||
        f.field === 'label' ||
        f.field === 'op-summary' ||
        f.field === 'consoleLabel',
    );
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('no raw exposure enum in any prose field', () => {
    const offenders = offendersWhere(EXPOSURE_ENUM);
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('no estate-identity token (org/domain/named function) anywhere — D18 multi-project rule', () => {
    const offenders = offendersWhere(ESTATE_IDENTITY);
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  /**
   * D18, the mechanically-checkable core: prose must not reference a COMMITTED
   * inventory resource by its Terraform address (aws_lambda_function.some_name).
   * Type.attribute notation (aws_iam_group.name) stays legal — descriptions may
   * cite the exact attribute they change — so a token only offends when its
   * second segment is a real resource NAME of that type in any bundled
   * inventory. A second registered project must render every service page
   * without inheriting another estate's resource stories.
   */
  it('no inventory resource address in any prose field (estate sagas live in project data)', () => {
    const addressSet = new Set<string>();
    const inventoryFiles = [join(SRC, 'data', 'inventory.json')];
    for (const project of readdirSync(join(SRC, 'data', 'projects'))) {
      const p = join(SRC, 'data', 'projects', project, 'inventory.json');
      try {
        statSync(p);
        inventoryFiles.push(p);
      } catch {
        /* a project without a vendored inventory contributes no addresses */
      }
    }
    for (const f of inventoryFiles) {
      const inv = JSON.parse(readFileSync(f, 'utf8')) as {
        resources?: { address?: string }[];
      };
      for (const r of inv.resources ?? []) {
        if (r.address) addressSet.add(r.address);
      }
    }
    expect(addressSet.size).toBeGreaterThan(50); // sanity: the bundled estates loaded

    const ADDRESS_TOKEN = /\baws_[a-z0-9_]+\.[a-z0-9_]+\b/g;
    const offenders: string[] = [];
    for (const f of prose.fields) {
      for (const m of f.text.matchAll(ADDRESS_TOKEN)) {
        if (addressSet.has(m[0])) {
          offenders.push(`${f.where} [${f.field}]: references ${m[0]}`);
        }
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });
});

/* ── Rendered resource-card chips (0034 Addendum D17) ────────────────────── */

/**
 * The resource cards render inventory attribute keys through the shared
 * chipLabel map (lib/chipLabel.ts) — the owner's Addendum bans raw
 * snake_case tokens and full ARNs from the default card state. Labels and
 * ARN display are RENDERING (this app's to shape), so they are linted here
 * against every attribute key and value in every bundled inventory — the
 * same mechanical style as the manifest-prose rules above. Attribute VALUES
 * that are estate data (a security group's description) stay verbatim by
 * design: display never falsifies what an operator searches for.
 */
describe('copy lint — resource-card chip rendering (every bundled inventory)', () => {
  interface InventoryJson {
    resources?: {
      address: string;
      resourceType: string;
      name?: string;
      service?: string;
      attributes?: Record<string, string | number | boolean>;
    }[];
  }

  /** The main inventory + each vendored project's, when present. */
  function inventoryFiles(): string[] {
    const files = [join(SRC, 'data', 'inventory.json')];
    const projectsDir = join(SRC, 'data', 'projects');
    for (const project of readdirSync(projectsDir)) {
      const file = join(projectsDir, project, 'inventory.json');
      try {
        statSync(file);
        files.push(file);
      } catch {
        // a project without a vendored inventory uses the bundled one
      }
    }
    return files;
  }

  const resources: InventoryResource[] = inventoryFiles().flatMap((file) => {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as InventoryJson;
    return (parsed.resources ?? []).map((r) => ({ ...r, attributes: r.attributes ?? {} }));
  });

  it('scans the bundled inventories (sanity)', () => {
    expect(resources.length).toBeGreaterThan(50);
  });

  it('every inventory attribute key renders a chip label with no snake_case token', () => {
    const keys = new Set(resources.flatMap((r) => Object.keys(r.attributes)));
    const offenders = [...keys]
      .filter((k) => SNAKE_CASE.test(chipLabelFor(k)))
      .map((k) => `${k} → ${chipLabelFor(k)}`);
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('no chip renders a full ARN as its visible value (tails only; the full value is the hover layer)', () => {
    const offenders: string[] = [];
    for (const r of resources) {
      for (const chip of resourceChips(r)) {
        if (chip.value.startsWith('arn:')) offenders.push(`${r.address} · ${chip.attr}`);
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });
});

/* ── Rendered UI strings ─────────────────────────────────────────────────── */

/**
 * Blank out // and /* comments while preserving string literals, template
 * literals, and JSX text (all of which can reach an operator's screen).
 * Comments legitimately cite §-sections and proposal numbers everywhere in
 * this codebase — only NON-comment text is held to the copy rules. Line
 * numbers are preserved so offender reports point at the real line.
 * (Known limit: a regex literal containing `//` can blank the rest of its
 * line — that can only hide an offender on that rare line, never invent one.)
 */
export function blankComments(source: string): string {
  let out = '';
  type State = 'code' | 'sq' | 'dq' | 'tpl' | 'line' | 'block';
  let state: State = 'code';
  for (let i = 0; i < source.length; i += 1) {
    const c = source[i]!;
    const next = source[i + 1];
    if (state === 'code') {
      if (c === '/' && next === '/') {
        state = 'line';
        out += '  ';
        i += 1;
      } else if (c === '/' && next === '*') {
        state = 'block';
        out += '  ';
        i += 1;
      } else {
        if (c === "'") state = 'sq';
        else if (c === '"') state = 'dq';
        else if (c === '`') state = 'tpl';
        out += c;
      }
    } else if (state === 'sq' || state === 'dq' || state === 'tpl') {
      out += c;
      if (c === '\\' && next !== undefined) {
        out += next;
        i += 1;
      } else if (
        (state === 'sq' && (c === "'" || c === '\n')) ||
        (state === 'dq' && (c === '"' || c === '\n')) ||
        (state === 'tpl' && c === '`')
      ) {
        state = 'code';
      }
    } else if (state === 'line') {
      if (c === '\n') {
        state = 'code';
        out += c;
      } else {
        out += ' ';
      }
    } else {
      // block comment
      if (c === '*' && next === '/') {
        state = 'code';
        out += '  ';
        i += 1;
      } else {
        out += c === '\n' ? c : ' ';
      }
    }
  }
  return out;
}

/** Same walk as generalization.test.ts: all app sources except src/data
 * (project data, linted field-by-field above) and src/test (test prose
 * legitimately cites the specs it proves). */
function walkSources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === 'data' || name === 'test') return [];
      return walkSources(p);
    }
    return /\.(ts|tsx)$/.test(name) ? [p] : [];
  });
}

describe('copy lint — rendered UI strings (string literals + JSX text)', () => {
  const files = walkSources(SRC);

  it('scans a real source tree (sanity)', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  // Account/region literals in app code are already banned wholesale by
  // generalization.test.ts (comments included); this covers the notation
  // classes that ARE fine in comments but never in operator-visible text.
  it('no §-notation or proposal/ADR reference outside comments', () => {
    const offenders: string[] = [];
    for (const f of files) {
      const rel = f.slice(SRC.length + 1);
      const blanked = blankComments(readFileSync(f, 'utf8'));
      blanked.split('\n').forEach((line, idx) => {
        if (SPEC_SECTION.test(line) || PROPOSAL_REF.test(line)) {
          offenders.push(`${rel}:${idx + 1}: ${line.trim().slice(0, 110)}`);
        }
      });
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });
});
