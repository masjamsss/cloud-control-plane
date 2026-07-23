import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { combineSubscriptions, createEmitter, subscribeWithStorage } from '@/lib/useStore';

/**
 * 0025 RX-4 — the shared external-store plumbing every store (settings,
 * session, teams) is built on. No jsdom/RTL in this repo (standalone.test.ts):
 * every piece here is a plain function, so "subscribe fires on a write, stops
 * after unsubscribe" is provable by calling functions directly, exactly like
 * the rest of this test suite.
 */

describe('createEmitter — the same-tab pub/sub', () => {
  it('a subscriber is notified on emit()', () => {
    const emitter = createEmitter();
    let calls = 0;
    emitter.subscribe(() => {
      calls += 1;
    });
    emitter.emit();
    expect(calls).toBe(1);
  });

  it('multiple subscribers all fire, independently', () => {
    const emitter = createEmitter();
    let a = 0;
    let b = 0;
    emitter.subscribe(() => (a += 1));
    emitter.subscribe(() => (b += 1));
    emitter.emit();
    expect(a).toBe(1);
    expect(b).toBe(1);
  });

  it('unsubscribing stops further notifications (and does not affect others)', () => {
    const emitter = createEmitter();
    let a = 0;
    let b = 0;
    const unsubA = emitter.subscribe(() => (a += 1));
    emitter.subscribe(() => (b += 1));
    emitter.emit();
    unsubA();
    emitter.emit();
    expect(a).toBe(1); // only the first emit
    expect(b).toBe(2); // both emits
  });

  it('emit() with no subscribers is a harmless no-op', () => {
    const emitter = createEmitter();
    expect(() => emitter.emit()).not.toThrow();
  });
});

describe('subscribeWithStorage — local emit + native `storage` event, composed', () => {
  it('fires on the local emitter, with no `window` global at all (this repo’s plain-Node tests)', () => {
    expect(typeof (globalThis as { window?: unknown }).window).toBe('undefined');
    const emitter = createEmitter();
    const subscribe = subscribeWithStorage(emitter, () => 'ccp.sample.settings.v1');
    let calls = 0;
    const unsubscribe = subscribe(() => (calls += 1));
    emitter.emit();
    expect(calls).toBe(1);
    unsubscribe();
    emitter.emit();
    expect(calls).toBe(1); // unsubscribed — no further notification
  });

  describe('with a window (a same-tab-vs-cross-tab fake, standing in for the browser)', () => {
    class FakeStorageEvent extends Event {
      key: string | null;
      constructor(key: string | null) {
        super('storage');
        this.key = key;
      }
    }

    let fakeWindow: EventTarget;

    beforeEach(() => {
      fakeWindow = new EventTarget();
      vi.stubGlobal('window', fakeWindow);
    });
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('a `storage` event for the watched key notifies the subscriber', () => {
      const emitter = createEmitter();
      const subscribe = subscribeWithStorage(emitter, () => 'ccp.sample.settings.v1');
      let calls = 0;
      subscribe(() => (calls += 1));
      fakeWindow.dispatchEvent(new FakeStorageEvent('ccp.sample.settings.v1'));
      expect(calls).toBe(1);
    });

    it('a `storage` event for a DIFFERENT key is ignored', () => {
      const emitter = createEmitter();
      const subscribe = subscribeWithStorage(emitter, () => 'ccp.sample.settings.v1');
      let calls = 0;
      subscribe(() => (calls += 1));
      fakeWindow.dispatchEvent(new FakeStorageEvent('ccp.sample.teams.v1'));
      expect(calls).toBe(0);
    });

    it('a `storage` event with key:null (a clear()) always notifies — we can no longer tell what it held', () => {
      const emitter = createEmitter();
      const subscribe = subscribeWithStorage(emitter, () => 'ccp.sample.settings.v1');
      let calls = 0;
      subscribe(() => (calls += 1));
      fakeWindow.dispatchEvent(new FakeStorageEvent(null));
      expect(calls).toBe(1);
    });

    it('the watched key is re-resolved on every event — a project switch mid-session is honored', () => {
      let project = 'sample';
      const emitter = createEmitter();
      const subscribe = subscribeWithStorage(emitter, () => `ccp.${project}.settings.v1`);
      let calls = 0;
      subscribe(() => (calls += 1));
      fakeWindow.dispatchEvent(new FakeStorageEvent('ccp.other.settings.v1'));
      expect(calls).toBe(0); // wrong project yet
      project = 'other';
      fakeWindow.dispatchEvent(new FakeStorageEvent('ccp.other.settings.v1'));
      expect(calls).toBe(1); // now it matches
    });

    it('unsubscribing removes the `storage` listener too — no notification after', () => {
      const emitter = createEmitter();
      const subscribe = subscribeWithStorage(emitter, () => 'ccp.sample.settings.v1');
      let calls = 0;
      const unsubscribe = subscribe(() => (calls += 1));
      unsubscribe();
      fakeWindow.dispatchEvent(new FakeStorageEvent('ccp.sample.settings.v1'));
      expect(calls).toBe(0);
    });
  });
});

describe('combineSubscriptions — merges several stores’ subscribe functions into one', () => {
  it('notifies when ANY of the composed sources fires', () => {
    const a = createEmitter();
    const b = createEmitter();
    const subscribe = combineSubscriptions(
      (cb) => a.subscribe(cb),
      (cb) => b.subscribe(cb),
    );
    let calls = 0;
    subscribe(() => (calls += 1));
    a.emit();
    b.emit();
    expect(calls).toBe(2);
  });

  it('unsubscribing tears down every composed source', () => {
    const a = createEmitter();
    const b = createEmitter();
    const subscribe = combineSubscriptions(
      (cb) => a.subscribe(cb),
      (cb) => b.subscribe(cb),
    );
    let calls = 0;
    const unsubscribe = subscribe(() => (calls += 1));
    unsubscribe();
    a.emit();
    b.emit();
    expect(calls).toBe(0);
  });
});
