import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { AppEnv } from '../src/appEnv';
import { registerErrorHandler } from '../src/errors';
import { withRequestLog } from '../src/middleware/requestLog';
import { createApp } from '../src/index';
import { MemoryStore } from '../src/store/memoryStore';
import { seed, SAMPLE_PROJECT_ID } from './helpers/seed';

/**
 * OPS-7 — the api emitted NO access log at all: no method/path/status/latency, no
 * per-request correlation id. These tests pin the three properties the fix is actually
 * for: an id exists and is unique per request, an access log line exists and does NOT
 * leak the query string, and a fault's log line carries the SAME id as the access line
 * for the request that caused it (the correlation the finding's whole point is about).
 */

const logged: string[] = [];
const errored: string[] = [];
const realLog = console.log;
const realError = console.error;

beforeEach(() => {
  logged.length = 0;
  errored.length = 0;
  // eslint-disable-next-line no-console
  console.log = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
  // eslint-disable-next-line no-console
  console.error = (...args: unknown[]) => { errored.push(args.map(String).join(' ')); };
});

afterEach(() => {
  // eslint-disable-next-line no-console
  console.log = realLog;
  // eslint-disable-next-line no-console
  console.error = realError;
});

describe('withRequestLog — every response carries a usable, unique correlation id', () => {
  it('X-Request-Id is present and UUID-shaped', async () => {
    const store = new MemoryStore();
    await seed(store);
    const app = createApp(store);
    const res = await app.request('/healthz');
    const id = res.headers.get('X-Request-Id');
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  it('two requests get two DIFFERENT ids — not a boot-time constant', async () => {
    const store = new MemoryStore();
    await seed(store);
    const app = createApp(store);
    const a = (await app.request('/healthz')).headers.get('X-Request-Id');
    const b = (await app.request('/healthz')).headers.get('X-Request-Id');
    expect(a).not.toBe(b);
  });

  it('a client-supplied X-Request-Id is IGNORED — the server always mints its own', async () => {
    // Trusting a client-chosen id would let an unauthenticated caller poison an
    // operator's log search or spoof correlation with an unrelated request.
    const store = new MemoryStore();
    await seed(store);
    const app = createApp(store);
    const res = await app.request('/healthz', { headers: { 'X-Request-Id': 'attacker-chosen-id' } });
    expect(res.headers.get('X-Request-Id')).not.toBe('attacker-chosen-id');
  });

  it('logs method, path, status and latency — and does NOT leak the query string', async () => {
    const store = new MemoryStore();
    await seed(store);
    const app = createApp(store);
    await app.request('/healthz?token=super-secret-value-should-never-appear');

    const line = logged.find((l) => l.includes('GET /healthz'));
    expect(line, `no access-log line found among: ${JSON.stringify(logged)}`).toBeDefined();
    expect(line).toMatch(/^ccp-api GET \/healthz 200 \d+ms id=[0-9a-f-]+$/i);
    // L-1's shape applied to a redaction claim: assert the SECRET is actually absent
    // from every line logged this test, not just that the one expected line matches.
    expect(logged.join('\n')).not.toContain('super-secret-value-should-never-appear');
    expect(logged.join('\n')).not.toContain('token=');
  });

  it('a non-2xx response is logged with its real status, not swallowed', async () => {
    const store = new MemoryStore();
    await seed(store);
    const app = createApp(store);
    await app.request('/requests', { headers: { 'x-ccp-client': 'ccp-spa', 'x-ccp-project': SAMPLE_PROJECT_ID } });
    const line = logged.find((l) => l.includes('GET /requests'));
    expect(line, `no access-log line found among: ${JSON.stringify(logged)}`).toBeDefined();
    // No session cookie: an auth failure, not a 2xx. Whichever 4xx it is, it must be
    // recorded — this finding is explicitly about 4xx refusals leaving no trace.
    expect(line).toMatch(/ 4\d\d /);
  });

  it('a fault (500) logs the SAME id in the access line and the error line', async () => {
    // A minimal app, not the real createApp: isolates the id-threading property from
    // needing a genuine uncaught store exception somewhere in the real route graph.
    const app = new Hono<AppEnv>();
    registerErrorHandler(app);
    app.use('*', withRequestLog);
    app.get('/boom', () => { throw new Error('synthetic fault for OPS-7 correlation test'); });

    const res = await app.request('/boom');
    expect(res.status).toBe(500);
    const id = res.headers.get('X-Request-Id');
    expect(id).toBeTruthy();

    const accessLine = logged.find((l) => l.includes('GET /boom'));
    const errorLine = errored.find((l) => l.includes('synthetic fault'));
    expect(accessLine, `no access-log line among: ${JSON.stringify(logged)}`).toBeDefined();
    expect(errorLine, `no error-log line among: ${JSON.stringify(errored)}`).toBeDefined();
    expect(accessLine).toContain(`id=${id}`);
    expect(errorLine).toContain(`id=${id}`);
  });
});
