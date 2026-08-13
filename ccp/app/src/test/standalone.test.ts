import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The standalone invariant (ADR-0007 + CONCEPT.md firm rules): the control plane must run
 * fully WITHOUT any LLM/AI and — today — without any network at all. Every form,
 * dropdown, validation, diff, and approval is a deterministic lookup over the
 * bundled manifests + inventory. This test makes the guarantee mechanical: it
 * fails the suite (and CI) if an AI SDK or a network primitive creeps in.
 *
 * Allowed future exception: when the real ccp-api client lands, network
 * calls may appear ONLY behind the ApiClient seam (src/lib/api.ts) and only to
 * ccp-api — never to a model endpoint. Widen NETWORK_ALLOWLIST then.
 */

/**
 * TEST-7 — WHY THIS REPO HAS NO jsdom/RTL, AND WHAT THAT COSTS (a decision, not
 * an oversight — this is the canonical place it is stated, since the exact
 * `devDependencies` this file would need to change live one test below).
 *
 * The testing strategy today is deliberately two-layer: pure logic (interpreter,
 * catalog derivation, quorum, permissions, …) is unit-tested directly; component
 * OUTPUT is pinned via `react-dom/server`'s `renderToStaticMarkup` — real JSX,
 * real props, real conditional rendering, asserted against the actual rendered
 * HTML (see bulkForm.test.ts, advisoryGate.test.ts, uiRobustnessFocus.test.ts,
 * provisionTileCompleteness.test.ts's ServiceCard cases, among many others).
 * That covers everything a component computes from its PROPS. It does not, and
 * structurally cannot, cover two things: `useEffect` (SSR never runs effects —
 * a component that fetches its own data via effect renders its pre-fetch state
 * forever, no matter what is asserted against it) or actual DOM EVENTS (no
 * click fires, no synthetic keyboard/focus behavior exists, because there is no
 * DOM). For the handful of top-level route components that fetch their own
 * data internally (ServiceConsole, ServiceCatalog, RequestForm's data load,
 * …) and the few genuinely event-driven interaction sequences (a step
 * transition's focus move, a typed-confirmation gate's live enable/disable),
 * that gap is real — ~15-20 test files fall back to reading a component's own
 * SOURCE TEXT for exactly those cases (grep this file's own dependency
 * assertion below, or `git grep -l readFileSync -- 'ccp/app/src/test/*.tsx'
 * 'ccp/app/src/test/*.ts'`), which is a materially weaker guarantee: it fails
 * on a harmless rename and passes on a behavioral bug that leaves the string
 * intact (TEST-7's own finding, verified in this session by deliberately
 * breaking ServiceCard's op-less wiring while leaving its source strings
 * untouched — the old-style check would have passed vacuously; the
 * rendered-output replacement failed correctly).
 *
 * THE DECISION: not to introduce jsdom + @testing-library/react in this
 * pass. Three reasons, together, not any one alone:
 *
 *   1. It is a stated, repeated, DELIBERATE choice already recorded in the
 *      code itself — not just here. `azureCatalogFlow.test.ts`, `routeConfig.tsx`'s
 *      own doc comment, and multiple `*.test.tsx` files all independently say
 *      "this repo has no jsdom/RTL" as an established fact this suite's authors
 *      built around, most visibly the exact `dependencies` allowlist this file
 *      pins two tests below — silently reversing a decision stated that many
 *      times, from inside an unrelated audit-fix batch, is not this batch's
 *      call to make.
 *   2. A real jsdom+RTL lane is infrastructure, not a test: a new environment
 *      config (today's single `vitest.config.ts` has none), fetch mocking for
 *      every effect-driven component under test, an `afterEach` cleanup
 *      discipline, and — per `standalone.test.ts`'s own no-network rule above —
 *      a decision about how a mocked `fetch` interacts with that ban. Doing
 *      that well is exactly the "real architectural change" TRIAGE.md's own
 *      note on this finding calls it, and deserves its own reviewed, scoped
 *      change rather than riding in as one line item of an 8-finding batch.
 *   3. The gap it would close is real but narrow, and partially mitigated
 *      instead: `provisionTileCompleteness.test.ts`'s ServiceCard cases (this
 *      session) converted the finding's own cited example from source-text
 *      matching to real rendered-output assertions — the template for
 *      retiring the remaining ~15-20 files one at a time, per the finding's
 *      own recommended fallback ("assert rendered output rather than source
 *      text" where a jsdom lane is not taken). Every remaining source-pinned
 *      test in this suite is required to say, in its own comment, WHY it
 *      cannot be converted without either jsdom or a component-splitting
 *      refactor (see ServiceConsole's case in provisionTileCompleteness.test.ts
 *      for the model) — a source-pinned test with no such comment is a bug in
 *      this decision's own follow-through, not an acceptable default.
 *
 * NOT a claim that the gap doesn't matter: TEST-5's function-coverage floor
 * (fullCoverage's successor) stays low BECAUSE of this gap (see FIXES.md R-51),
 * and raising it for real means doing item 2 above eventually. This is the
 * record of why "eventually" and not "in this batch".
 */

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');
// The ONE documented exception (ADR-0007 + admin-and-multiproject §1.1): network
// may appear ONLY behind the ApiClient seam — `lib/api.ts` (the selector) and
// `lib/httpApi.ts` (the ccp-api HTTP client) — and ONLY to ccp-api, never
// to a model endpoint. Everywhere else the no-network + no-AI bans below still hold.
const NETWORK_ALLOWLIST = new Set<string>(['lib/api.ts', 'lib/httpApi.ts']);

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === 'test' ? [] : walk(p);
    return /\.(ts|tsx)$/.test(name) ? [p] : [];
  });
}

const files = walk(SRC);

// Built dynamically so this file never matches its own patterns.
const NETWORK_PATTERNS = ['fetch' + '(', 'XMLHttp' + 'Request', 'Web' + 'Socket', 'Event' + 'Source', 'send' + 'Beacon', 'axios'];
const AI_PATTERNS = ['anthropic', 'openai', 'concierge', 'chatgpt', 'gemini-api', 'claude-'];

describe('standalone invariant — no LLM, no network', () => {
  it('scans a real source tree (sanity)', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it('no network primitives outside the allowlisted API seam', () => {
    const offenders: string[] = [];
    for (const f of files) {
      const rel = f.slice(SRC.length + 1);
      if (NETWORK_ALLOWLIST.has(rel)) continue;
      const text = readFileSync(f, 'utf8');
      for (const pat of NETWORK_PATTERNS) {
        // Only flag code, not prose in comments mentioning a future client.
        for (const line of text.split('\n')) {
          const code = line.split('//')[0]!;
          if (code.includes(pat)) offenders.push(`${rel}: ${line.trim()}`);
        }
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('the API seam only fetches a baseUrl-rooted ccp-api path (never an absolute/model endpoint)', () => {
    const httpApi = readFileSync(join(SRC, 'lib', 'httpApi.ts'), 'utf8');
    // (1) No absolute URL literal anywhere in the client — reaching a model (or any
    // other) host would require one. The mechanical half of "only ccp-api".
    expect(/https?:\/\//.test(httpApi), 'httpApi.ts must contain no absolute URL').toBe(false);
    // (2) The URL handed to the network primitive is built from the injected baseUrl.
    expect(/doFetch\(\s*`\$\{baseUrl\}/.test(httpApi), 'requests must be built from baseUrl').toBe(true);
    // (3) Never a bare fetch( with a literal target — the only fetch is the injected/
    // global one, bound once and always called through the baseUrl-prefixing helper.
    expect(/[^.\w]fetch\s*\(/.test(httpApi), 'no bare fetch( with a literal URL').toBe(false);
    // (4) api.ts wires the HTTP client in ONLY behind VITE_API_BASE; the mock (no
    // network, no AI) stays the default so the app still runs fully standalone.
    const apiSeam = readFileSync(join(SRC, 'lib', 'api.ts'), 'utf8');
    expect(apiSeam.includes('import.meta.env.VITE_API_BASE')).toBe(true);
    expect(apiSeam.includes('createMockApiClient()')).toBe(true);
  });

  it('no AI/LLM references in source', () => {
    const offenders: string[] = [];
    for (const f of files) {
      const rel = f.slice(SRC.length + 1);
      const text = readFileSync(f, 'utf8').toLowerCase();
      for (const pat of AI_PATTERNS) {
        if (text.includes(pat)) offenders.push(`${rel} contains "${pat}"`);
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('no AI or HTTP-client SDKs in the dependency tree', () => {
    const pkg = JSON.parse(readFileSync(join(SRC, '..', 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    const deps = Object.keys(pkg.dependencies ?? {});
    const banned = /anthropic|openai|langchain|llamaindex|cohere|mistral|groq|gemini|axios|got|node-fetch|undici/i;
    expect(deps.filter((d) => banned.test(d))).toEqual([]);
    // The runtime surface stays small and every entry is justified: cmdk (command
    // menu), @radix-ui/react-dropdown-menu + @radix-ui/react-popover (accessible
    // menus/popovers), @tanstack/react-virtual (list windowing), and qrcode.react
    // (the TOTP enrolment QR — encodes + paints inline SVG entirely client-side,
    // zero runtime deps of its own, no network) are pure client-side UI libs (no
    // network, no AI). Add to this list ONLY UI/utility libs — never an HTTP
    // client or model SDK.
    expect(deps.sort()).toEqual([
      '@radix-ui/react-dropdown-menu',
      '@radix-ui/react-popover',
      '@tanstack/react-virtual',
      'cmdk',
      'js-yaml',
      'qrcode.react',
      'react',
      'react-dom',
      'react-router-dom',
      'zod',
    ]);
  });
});
