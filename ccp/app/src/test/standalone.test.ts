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
