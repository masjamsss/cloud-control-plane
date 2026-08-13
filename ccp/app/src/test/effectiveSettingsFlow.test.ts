import { describe, expect, it } from 'vitest';
import {
  NOTHING_BLOCKED,
  deriveEffectiveSettings,
  useEffectiveSettings,
  type EffectiveSettings,
} from '@/features/request/effectiveSettingsFlow';
import type { SettingsView } from '@/features/admin/settingsFlow';

/**
 * FE-6 — a submit gate's effective settings must come from the SERVER in api
 * mode, never the advisory local store there. No jsdom in this repo (see
 * `standalone.test.ts`'s exact dependency allowlist), so — the same split
 * `useServerInfo`/`serverInfoToState` already use (advisoryGate.test.ts) —
 * the actual decision is pulled out into a pure function and tested
 * directly; `useEffectiveSettings` itself is only pinned as a real exported
 * hook (its effect wiring is the same one-shot-fetch shape
 * `SettingsAdmin.tsx`'s `refresh` already uses and is not jsdom-testable
 * here either).
 */

const LOCAL_CLEAN: EffectiveSettings = { changeFreeze: false, disabledOps: [] };
const LOCAL_STALE_FROZEN: EffectiveSettings = { changeFreeze: true, disabledOps: ['ec2-resize'] };

function serverView(over: Partial<SettingsView> = {}): SettingsView {
  return {
    changeFreeze: false,
    disabledOps: [],
    allowlistOverrides: {},
    rateLimits: { submissionsPerHour: 20, maxOpenPerUser: 5 },
    ...over,
  };
}

describe('deriveEffectiveSettings — the FE-6 source-of-truth decision', () => {
  it('not authoritative (mock mode): returns the local snapshot verbatim, server ignored', () => {
    const server = serverView({ changeFreeze: true, disabledOps: ['ec2-resize'] });
    expect(deriveEffectiveSettings(false, LOCAL_CLEAN, server)).toEqual(LOCAL_CLEAN);
    expect(deriveEffectiveSettings(false, LOCAL_CLEAN, null)).toEqual(LOCAL_CLEAN);
  });

  it('authoritative + not yet resolved: "nothing blocked", never the local store — the dead-preview bug\'s under-warn direction never regresses, but a loading moment also never fabricates a block', () => {
    expect(deriveEffectiveSettings(true, LOCAL_STALE_FROZEN, null)).toEqual(NOTHING_BLOCKED);
  });

  it('authoritative + server resolved clean: a STALE local freeze/disabled-op is completely ignored — the over-block direction of the bug', () => {
    const server = serverView(); // clean
    expect(deriveEffectiveSettings(true, LOCAL_STALE_FROZEN, server)).toEqual({
      changeFreeze: false,
      disabledOps: [],
    });
  });

  it('authoritative + server resolved frozen: the server\'s freeze wins even though the local store is clean — the under-warn (dead preview) direction of the bug', () => {
    const server = serverView({ changeFreeze: true, disabledOps: ['ec2-resize'] });
    expect(deriveEffectiveSettings(true, LOCAL_CLEAN, server)).toEqual({
      changeFreeze: true,
      disabledOps: ['ec2-resize'],
    });
  });

  it('never leaks the server view\'s other fields — only changeFreeze/disabledOps flow through', () => {
    const server = serverView({
      changeFreeze: true,
      disabledOps: ['x'],
      allowlistOverrides: { 'op::param': ['v'] },
      rateLimits: { submissionsPerHour: 1, maxOpenPerUser: 1 },
    });
    expect(Object.keys(deriveEffectiveSettings(true, LOCAL_CLEAN, server)).sort()).toEqual([
      'changeFreeze',
      'disabledOps',
    ]);
  });
});

describe('useEffectiveSettings — exported as a real hook', () => {
  it('is a function the module exports (its effect wiring is exercised end-to-end, not here — no jsdom)', () => {
    expect(typeof useEffectiveSettings).toBe('function');
  });
});
