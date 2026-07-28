import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../src/store/memoryStore';
import type { Item } from '../src/store/configStore';
import type { ProjectItem } from '../src/store/schema';
import { projectKey } from '../src/store/schema';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * CONC-11 — registry writes that bump `version` without guarding it.
 *
 * The `ProjectItem` row HAS an optimistic-concurrency discipline: the trust decision
 * guards `version`, and so do activate/archive/unarchive. Two handlers bypassed it with
 * unconditional full-row puts built from a stale read — the trust-request upload and the
 * identity confirm.
 *
 * Two costs, and the second is the serious one. A trust-request upload racing an identity
 * confirm loses one of the two writes entirely. And because both handlers **reset**
 * `version` to `stale + 1`, they can REWIND the counter to a value a pending
 * dual-controlled proposal already captured — letting a genuinely stale ack pass its
 * `version` guard against different row content, which is the precise class that guard
 * exists to stop.
 */

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

/** Blank out block and line comments, preserving line numbering so offenders stay locatable. */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/^(\s*)\/\/.*$/gm, '$1');
}

describe('CONC-11 — every ProjectItem writer guards `version`', () => {
  /**
   * A source-level check rather than a route drive, because the property is about the
   * SHAPE of every writer, not the behaviour of the two that happen to be named today.
   * A third handler added next quarter with the same unconditional put is the failure
   * being prevented, and only a rule catches that (L-25).
   */
  it('no writer bumps version without an ifEquals on it', () => {
    // COMMENTS STRIPPED FIRST. Without this the check matched the prose in the very fix
    // it was written to protect — a comment reading "guardAttr:'version' on the trust
    // decision" satisfied the pattern, so deleting the real guard changed nothing and the
    // test stayed green. A negative test is what caught it; the check had been passing for
    // the wrong reason from the moment it was written.
    const text = stripComments(readFileSync(join(SRC, 'routes', 'projects.ts'), 'utf8'));
    const lines = text.split('\n');
    // Bounded by the enclosing ROUTE HANDLER, not by a fixed line window. A window is a
    // guess about how far apart the bump and its guard may sit — the first version used
    // ±14 lines and reported a correctly-guarded handler as an offender, because the
    // `ifEquals` rides on the `transactWithAudit` call further down. A handler is the
    // real unit: whatever bumps the version inside it must be guarded inside it too.
    const handlerStarts = lines.flatMap((l, i) => (/^\s{0,4}p\.(post|put|delete|get)\(/.test(l) ? [i] : []));
    const handlerAt = (i: number): string => {
      const start = [...handlerStarts].reverse().find((h) => h <= i) ?? 0;
      const end = handlerStarts.find((h) => h > i) ?? lines.length;
      return lines.slice(start, end).join('\n');
    };
    const offenders: string[] = [];
    lines.forEach((line, i) => {
      if (!/version:\s*project\.version \+ 1/.test(line)) return;
      const scope = handlerAt(i);
      const guarded =
        /guardAttr:\s*["']version["']/.test(scope) ||
        /ifEquals:\s*\{\s*attr:\s*["']version["']/.test(scope);
      if (!guarded) offenders.push(`routes/projects.ts:${i + 1}: ${line.trim()}`);
    });
    expect(
      offenders,
      'A ProjectItem writer bumps `version` without guarding it. An unconditional write ' +
        'built from a stale read loses the racing update AND rewinds the counter to a ' +
        'value a pending dual-controlled proposal may already have captured — which lets ' +
        'a stale ack pass its version guard against different row content.',
    ).toEqual([]);
  });

  it('finds the writers at all (sanity)', () => {
    // Without this the assertion above passes by matching nothing (L-1).
    const text = readFileSync(join(SRC, 'routes', 'projects.ts'), 'utf8');
    expect(text.match(/version:\s*project\.version \+ 1/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
  });
});

describe('CONC-11 — the guard actually bites', () => {
  /** The store-level property both handlers now rely on. */
  it('a guarded full-row put loses to a concurrent version bump', async () => {
    const store = new MemoryStore();
    const k = projectKey('acme');
    const base = { ...k, id: 'acme', name: 'Acme', status: 'draft', version: 3 } as unknown as Item;
    await store.put(base);

    const readByA = (await store.get(k.PK, k.SK)) as unknown as ProjectItem;

    // B lands first, moving the version.
    await store.put({ ...base, status: 'pending-trust', version: 4 } as Item, {
      ifEquals: { attr: 'version', value: 3 },
    });

    // A's write, built from its now-stale read, must be refused rather than resetting
    // version to 4 over B's different content.
    await expect(
      store.put({ ...(readByA as unknown as Item), identityConfirmed: { by: 'x' }, version: readByA.version + 1 }, {
        ifEquals: { attr: 'version', value: readByA.version },
      }),
    ).rejects.toThrow(/ifEquals failed/);

    const after = (await store.get(k.PK, k.SK)) as unknown as ProjectItem;
    expect(after.status).toBe('pending-trust'); // B's write survived intact
    expect(after.version).toBe(4);
    expect((after as unknown as Record<string, unknown>).identityConfirmed).toBeUndefined();
  });

  it('THE REWIND: without the guard, the loser resets version to a value already spent', async () => {
    // This is the finding's sharp edge, shown rather than described. A pending proposal
    // captured version 4; an unguarded writer working from version 3 writes 4 again, over
    // DIFFERENT content — and the proposal's `guardValue: 4` now matches a row it never saw.
    const store = new MemoryStore();
    const k = projectKey('acme');
    await store.put({ ...k, id: 'acme', status: 'draft', version: 3 } as unknown as Item);
    const stale = (await store.get(k.PK, k.SK)) as unknown as ProjectItem;

    await store.put({ ...k, id: 'acme', status: 'pending-trust', version: 4 } as unknown as Item);
    // The unguarded write the fix removes:
    await store.put({ ...(stale as unknown as Item), status: 'draft', version: stale.version + 1 });

    const after = (await store.get(k.PK, k.SK)) as unknown as ProjectItem;
    expect(after.version, 'the counter is back at 4 over different content').toBe(4);
    expect(after.status, "and the other writer's status is gone").toBe('draft');
  });
});
