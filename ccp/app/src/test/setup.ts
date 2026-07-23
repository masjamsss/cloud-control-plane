// Vitest setup — global test hooks/mocks go here.
//
// Ensure a genuinely working `localStorage` global. Node's built-in
// localStorage (unflagged since Node ~22) only works when the process was
// started with a valid --localstorage-file; without one, `typeof localStorage`
// still reads 'object' but every method throws "X is not a function". Every
// store in this app already treats localStorage as fallible (try/catch → an
// in-memory Map fallback), so this never surfaced in existing tests — until a
// test needs REAL persistence semantics (e.g. the legacy-key → project-scoped
// migration in projectScope.test.ts). Detect a non-functional localStorage and
// swap in a tiny in-memory polyfill so such tests are deterministic across Node
// versions, in CI and locally alike.

class MemoryStorage {
  #data = new Map<string, string>();

  getItem(key: string): string | null {
    return this.#data.has(key) ? this.#data.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.#data.set(key, String(value));
  }
  removeItem(key: string): void {
    this.#data.delete(key);
  }
  clear(): void {
    this.#data.clear();
  }
  key(index: number): string | null {
    return [...this.#data.keys()][index] ?? null;
  }
  get length(): number {
    return this.#data.size;
  }
}

function isFunctional(storage: unknown): boolean {
  try {
    const s = storage as Storage;
    const probeKey = '__ccp_localstorage_probe__';
    s.setItem(probeKey, '1');
    const ok = s.getItem(probeKey) === '1';
    s.removeItem(probeKey);
    return ok;
  } catch {
    return false;
  }
}

if (!isFunctional((globalThis as { localStorage?: unknown }).localStorage)) {
  Object.defineProperty(globalThis, 'localStorage', {
    value: new MemoryStorage(),
    writable: true,
    configurable: true,
  });
}

export {};
