import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/index';
import { MemoryStore } from '../src/store/memoryStore';
import { seed, sessionCookieFor } from './helpers/seed';

const SPA = 'https://ccp.example.com';
const OTHER = 'https://evil.example.com';

let prev: string | undefined;
beforeEach(() => {
  prev = process.env.CCP_CORS_ORIGIN;
  process.env.CCP_CORS_ORIGIN = `${SPA},http://localhost:5173`;
});
afterEach(() => {
  if (prev === undefined) delete process.env.CCP_CORS_ORIGIN;
  else process.env.CCP_CORS_ORIGIN = prev;
});

describe('CORS lets the SPA origin authenticate with credentials', () => {
  it('preflight OPTIONS from the SPA origin is allowed with credentials', async () => {
    const app = createApp(new MemoryStore());
    const res = await app.request('/auth/login', {
      method: 'OPTIONS',
      headers: {
        origin: SPA,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type,x-ccp-client',
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe(SPA);
    expect(res.headers.get('access-control-allow-credentials')).toBe('true');
    expect(res.headers.get('access-control-allow-methods')).toContain('POST');
    expect(res.headers.get('access-control-allow-headers')?.toLowerCase()).toContain('x-ccp-client');
  });

  it('a credentialed authenticated request from the SPA origin gets echoed ACAO + ACAC', async () => {
    const store = new MemoryStore();
    await seed(store);
    const app = createApp(store);
    const res = await app.request('/auth/me', {
      headers: { origin: SPA, cookie: await sessionCookieFor(store, 'sari') },
    });
    expect(res.status).toBe(200); // the browser session resolves cross-origin
    expect(res.headers.get('access-control-allow-origin')).toBe(SPA); // exact origin, never '*'
    expect(res.headers.get('access-control-allow-credentials')).toBe('true');
  });

  it('an origin NOT on the allow-list gets no ACAO header (browser blocks it)', async () => {
    const app = createApp(new MemoryStore());
    const res = await app.request('/healthz', { headers: { origin: OTHER } });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('a same-origin / server request (no Origin) is unaffected and carries no CORS headers', async () => {
    const app = createApp(new MemoryStore());
    const res = await app.request('/healthz');
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });
});
