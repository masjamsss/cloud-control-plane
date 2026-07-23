import { describe, expect, it } from 'vitest';
import { createApp } from '../src/index';
import { MemoryStore } from '../src/store/memoryStore';
import { bootstrap } from '../scripts/bootstrap';
import { accountsGsi, type AccountItem } from '../src/store/schema';
import { roleFor } from '../src/projects';

function capture() {
  const lines: string[] = [];
  return { io: { print: (s: string) => lines.push(s) }, lines };
}
function extractPassword(lines: string[]): string {
  const line = lines.find((l) => l.includes('one-time password:'));
  return line ? line.split('one-time password:')[1]!.trim() : '';
}

describe('§9 first-boot bootstrap', () => {
  it('(a) seeds exactly one must-change admin Lead whose printed password logs in', async () => {
    const store = new MemoryStore();
    const { io, lines } = capture();
    const res = await bootstrap(store, io);
    expect(res.ok).toBe(true);

    const accounts = (await store.queryGSI1(accountsGsi())) as AccountItem[];
    expect(accounts).toHaveLength(1);
    expect(accounts[0]!.mustChangePassword).toBe(true);
    expect(accounts[0]!.isAdmin).toBe(true);
    // the all-projects root of trust: lead via the '*' wildcard binding (new roles
    // shape) — no teamId (data-birth spec §5: 'platform' was a dangling id, no
    // TeamItem is ever seeded, and a team is inert for a lead anyway).
    expect(accounts[0]!.roles).toEqual({ '*': { role: 'lead' } });
    expect(roleFor(accounts[0]!, 'sample')).toBe('lead'); // resolves to lead on any project

    const pw = extractPassword(lines);
    expect(pw.length).toBeGreaterThan(0);

    // the printed one-time password authenticates (1FA succeeds; lead needs a 2nd factor)
    const app = createApp(store);
    const login = await app.request('/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'putra', password: pw }),
    });
    expect(login.status).toBe(200);
    const body = await login.json();
    expect(body.mustChangePassword).toBe(true);
    expect(body.totpRequired).toBe(true); // privileged → TOTP enrollment offered
  });

  it('(b) a second bootstrap refuses and leaves the store unchanged', async () => {
    const store = new MemoryStore();
    expect((await bootstrap(store, { print: () => {} })).ok).toBe(true);
    const before = await store.queryGSI1(accountsGsi());

    const second = await bootstrap(store, { print: () => {} });
    expect(second.ok).toBe(false);

    const after = await store.queryGSI1(accountsGsi());
    expect(after).toHaveLength(1);
    expect(after).toEqual(before);
  });

  it('a wrong password against the bootstrap account is rejected generically', async () => {
    const store = new MemoryStore();
    await bootstrap(store, { print: () => {} });
    const app = createApp(store);
    const res = await app.request('/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'putra', password: 'definitely-wrong' }),
    });
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe('BAD_CREDENTIALS');
  });
});
