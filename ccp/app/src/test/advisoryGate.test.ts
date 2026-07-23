import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';
import { api, noCapabilities, SERVER_FLOWS } from '@/lib/api';
import { createHttpApiClient } from '@/lib/httpApi';
import {
  ADVISORY_NOTE,
  AdvisoryControl,
  GateFieldset,
  INITIAL_SERVER_INFO_STATE,
  SERVER_MODE,
  advisoryNote,
  canServe,
  serverInfoToState,
  useServerInfo,
} from '@/components/AdvisoryGate';
import {
  MAINTENANCE_OFF_REASON,
  NOTIFICATIONS_OFF_REASON,
  SettingsAdmin,
} from '@/features/admin/SettingsAdmin';
import { PendingChanges } from '@/features/admin/PendingChanges';
import { ADMIN_CAPABILITY_NOTE, ADMIN_TOGGLE_CAPTION, AccountRow, SELF_DELETE_NOTE, UsersAdmin } from '@/features/admin/UsersAdmin';
import { TeamsAdmin } from '@/features/admin/TeamsAdmin';
import { ApprovalPolicyAdmin } from '@/features/admin/ApprovalPolicyAdmin';
import { RiskAdmin } from '@/features/admin/RiskAdmin';
import { AuditHistory } from '@/features/admin/AuditHistory';
import { ProjectsAdmin } from '@/features/admin/ProjectsAdmin';
import { resetSettingsForTests } from '@/lib/settings';
import { resetAuditForTests } from '@/lib/audit';
import { proposePendingChange, resetPendingChangesForTests } from '@/lib/pendingChanges';
import type { Account } from '@/lib/accounts';
import type { Team } from '@/types';
import { APP_NAME } from '@/brand';

/**
 * The §0 arming wrapper (admin-and-multiproject §0/§1.1). `serverInfo()` itself
 * already exists and is tested end-to-end in serverContract.test.ts; this file
 * covers the NEW seam this plan adds on top of it — the exact advisory string,
 * the hook's resolution logic, and the <AdvisoryControl> render shape.
 *
 * No jsdom/testing-library in this repo (see standalone.test.ts's exact
 * dependency allowlist — no new deps). Static-shape assertions use
 * react-dom/server's renderToStaticMarkup, which needs no DOM. useEffect never
 * runs during a server render, so useServerInfo's own resolution logic is
 * exercised directly via serverInfoToState — the pure mapping its effect
 * applies to whatever api.serverInfo() resolves — rather than by mounting a
 * live component tree.
 */

describe('advisoryNote() — the exact §0 string (frozen so it cannot drift)', () => {
  it('returns the exact plain-language string — no demo/connect-the-backend nag', () => {
    expect(advisoryNote()).toBe('This control is inactive until the server enforces it');
    // The banned banner fingerprints must never be in this shipped string.
    expect(advisoryNote()).not.toContain('Requires ccp-api');
    expect(advisoryNote()).not.toContain('Demo mode');
  });

  it('matches the exported constant the component renders', () => {
    expect(advisoryNote()).toBe(ADVISORY_NOTE);
  });
});

describe('useServerInfo — resolves per-flow against serverInfo() (§1.1 / 0015 §B3)', () => {
  it('starts with no flow served and loading:true — safe/disabled before the answer lands', () => {
    expect(INITIAL_SERVER_INFO_STATE).toEqual({ capabilities: noCapabilities(), loading: true });
  });

  it('the exact call the hook makes (api.serverInfo()) serves no admin flow against the mock', async () => {
    const info = await api.serverInfo();
    expect(info).toEqual({ mode: 'mock', capabilities: noCapabilities() });
  });

  it('maps a resolved ServerInfo onto {capabilities, loading:false} — the hook’s effect body', async () => {
    const info = await api.serverInfo();
    expect(serverInfoToState(info)).toEqual({ capabilities: noCapabilities(), loading: false });
  });

  it('canServe reads the PER-FLOW flag — true only for a flow the backend actually serves', () => {
    const none = serverInfoToState({ mode: 'api', capabilities: noCapabilities() });
    for (const flow of SERVER_FLOWS) expect(canServe(none, flow)).toBe(false);
    // A hypothetical future where only `users` is served: exactly that flow arms.
    const usersServed = serverInfoToState({
      mode: 'api',
      capabilities: { ...noCapabilities(), users: true },
    });
    expect(canServe(usersServed, 'users')).toBe(true);
    expect(canServe(usersServed, 'teams')).toBe(false);
  });

  it('while loading, canServe is false for every flow (never arms before the answer lands)', () => {
    for (const flow of SERVER_FLOWS) expect(canServe(INITIAL_SERVER_INFO_STATE, flow)).toBe(false);
  });

  it('is a hook function the component module exports', () => {
    expect(typeof useServerInfo).toBe('function');
  });

  it('resolves the REAL http client’s capabilities: every gated flow is now authoritative', async () => {
    // Ties this hook's pure resolution logic to the ACTUAL httpApi client (not just
    // the hypothetical above), so a regression in lib/httpApi.ts's serverInfo() is
    // caught here too, not only in serverContract.test.ts. audit/teams/users came
    // with 0014 P1 #4 + B1; policy/risk/settings/pendingChanges with the five
    // estate-governance flows; projects with W5/N2's /projects registry + trust
    // surface.
    const SERVED: Array<(typeof SERVER_FLOWS)[number]> = [
      'audit',
      'teams',
      'users',
      'policy',
      'risk',
      'settings',
      'pendingChanges',
      'projects',
    ];
    const info = await createHttpApiClient('').serverInfo();
    expect(info.mode).toBe('api');
    const state = serverInfoToState(info);
    expect(state.loading).toBe(false);
    for (const flow of SERVER_FLOWS) {
      expect(canServe(state, flow), `${flow}: served-in-api-mode iff its call is wired`).toBe(
        SERVED.includes(flow),
      );
    }
  });
});

describe('mode honesty — SERVER_MODE (the static mock-vs-api fact)', () => {
  it('a test build is a mock build — SERVER_MODE mirrors the static VITE_API_BASE fact', () => {
    // The same constant lib/api picks its client by, so the two can never disagree.
    expect(SERVER_MODE).toBe('mock');
  });
});

describe('<GateFieldset> — silent disabled wrapper (no banner, no note)', () => {
  it('disabled: dims children inside a <fieldset disabled> with NO advisory note', () => {
    const gated = renderToStaticMarkup(
      React.createElement(GateFieldset, {
        disabled: true,
        children: React.createElement('button', { type: 'button' }, 'Save'),
      }),
    );
    expect(gated.match(/<fieldset[^>]*>/)?.[0]).toContain('disabled');
    expect(gated).toContain('Save');
    expect(gated).not.toContain(ADVISORY_NOTE); // silent — dimming is the only signal
  });

  it('not disabled: renders children bare — no fieldset', () => {
    const open = renderToStaticMarkup(
      React.createElement(GateFieldset, {
        disabled: false,
        children: React.createElement('button', { type: 'button' }, 'Save'),
      }),
    );
    expect(open).not.toContain('<fieldset');
  });
});

describe('<AdvisoryControl> — the §0 arming wrapper', () => {
  it('authoritative=false renders children inside a disabled fieldset with the exact note', () => {
    const html = renderToStaticMarkup(
      React.createElement(AdvisoryControl, {
        authoritative: false,
        children: React.createElement('button', { type: 'button' }, 'Save'),
      }),
    );
    const fieldset = html.match(/<fieldset[^>]*>/)?.[0];
    expect(fieldset, html).toBeTruthy();
    expect(fieldset).toContain('disabled');
    expect(html).toContain(ADVISORY_NOTE);
    expect(html).toContain('Save');
  });

  it('authoritative=true renders children bare — no fieldset, no note', () => {
    const html = renderToStaticMarkup(
      React.createElement(AdvisoryControl, {
        authoritative: true,
        children: React.createElement('button', { type: 'button' }, 'Save'),
      }),
    );
    expect(html).not.toContain('<fieldset');
    expect(html).not.toContain(ADVISORY_NOTE);
    expect(html).toContain('Save');
  });
});

/**
 * Regression coverage for the mock build's admin posture. `SERVER_MODE` is a
 * static constant ('mock' under test — no VITE_API_BASE), and useServerInfo's
 * initial/only state during an SSR pass is {authoritative:false, loading:true}
 * (useEffect never runs server-side) — the same state the mock resolves to
 * anyway — so a static render of the real page components is an exact,
 * deterministic stand-in for what an admin sees without a backend.
 *
 * The demo posture (operator decision, 2026-07-16): NOTHING greyed. Every
 * admin write control works in a mock build against this browser's local
 * stores — settings, the dual-control queue's decisions, policy, risk, the
 * whole Users row, the projects wizard — so these lock the ABSENCE of any
 * disabled fieldset, alongside the still-standing absence of any demo-mode
 * banner phrase. Api builds keep the arming rule; that half is covered by the
 * explicit-prop AccountRow cases below and the <AdvisoryControl>/<GateFieldset>
 * cases above.
 *
 * ONE DELIBERATE EXCEPTION (ADR-0023, added once the generic-branding sweep
 * landed): the Instance Identity card has NO local mock store — a mock-mode
 * local rename would violate the standalone/mock-parity invariant, which
 * requires mock builds to stay byte-for-byte on the baked-generic brand
 * (zero network, zero drift). It is therefore advisory-disabled in EVERY
 * mode until a real server serves the `settings` flow, same as
 * cancelRequest/rewindowRequest having no mock equivalent at all elsewhere in
 * this app. The blanket "no fieldset" assertion below is narrowed to the five
 * sections it always meant (freeze/allowlist/notifications/windows/limits);
 * the Instance Identity card's advisory fieldset is asserted FOR, not against.
 */
describe('mock-build posture — every admin section LIVE, no banner, nothing dimmed', () => {
  beforeEach(() => {
    resetSettingsForTests();
    resetAuditForTests();
    resetPendingChangesForTests();
  });

  it('SettingsAdmin: no page banner, and NO disabled fieldset on the five ORIGINAL sections — freeze/allowlist/notifications/windows/limits all live', () => {
    const html = renderToStaticMarkup(
      React.createElement(MemoryRouter, null, React.createElement(SettingsAdmin)),
    );
    // No demo-mode banner anywhere.
    expect((html.match(/mode-banner/g) ?? []).length).toBe(0);
    expect(html).not.toContain('Demo mode');
    // The freeze toggle is armed…
    expect(openingTag(html, '<button', '>Freeze changes<')).not.toContain('disabled');
    // …and so are the purely-local editors that used to sit hardcoded-dark.
    expect(openingTag(html, '<button', '>Add channel<')).not.toContain('disabled');
    expect(openingTag(html, '<button', '>Add window<')).not.toContain('disabled');
    expect(openingTag(html, '<button', '>Save limits<')).not.toContain('disabled');
    // No per-section advisory note for THOSE five — and the api-build-only
    // reasons for the two local-only sections stay out of the live mock
    // posture too.
    expect(html).not.toContain(NOTIFICATIONS_OFF_REASON);
    expect(html).not.toContain(MAINTENANCE_OFF_REASON);
  });

  it('SettingsAdmin: the ONE deliberate exception — Instance Identity has no local mock store, so it stays advisory-disabled even in the live mock posture (ADR-0023, standalone/mock parity)', () => {
    const html = renderToStaticMarkup(
      React.createElement(MemoryRouter, null, React.createElement(SettingsAdmin)),
    );
    expect(html).toContain('Instance identity');
    // Exactly one fieldset on the whole page — the identity card's — proving
    // the other five sections really do stay live (the prior test's removed
    // blanket assertion, made precise instead of merely absent).
    expect((html.match(/<fieldset/g) ?? []).length).toBe(1);
    expect(html).toContain(ADVISORY_NOTE);
    // The card still renders the baked-generic name/tagline read-only —
    // never a blank/broken field just because it is disabled.
    expect(html).toContain('value="Cloud Control Plane"');
  });

  it('the local-only sections’ connected-build reasons are SPECIFIC plain words, not the generic advisory line', () => {
    // A control that can never arm must say exactly why in the operator's words
    // (the "cannot enable" complaint) — never the one-size advisory sentence.
    for (const reason of [NOTIFICATIONS_OFF_REASON, MAINTENANCE_OFF_REASON]) {
      expect(reason).not.toBe(ADVISORY_NOTE);
      expect(reason).toContain("can't be turned on yet");
      expect(reason).toContain('the server');
    }
    expect(NOTIFICATIONS_OFF_REASON).toContain('bell'); // what still works
    expect(MAINTENANCE_OFF_REASON).toContain('scheduled'); // the working alternative
  });

  it('PendingChanges: a pending item’s Acknowledge/Reject are LIVE (local decisions work) — no banner', () => {
    proposePendingChange({
      proposedBy: 'putra',
      kind: 'limits',
      before: 50,
      after: 80,
      targetKey: 'limits.submissionsPerHour',
    });
    const html = renderToStaticMarkup(
      React.createElement(MemoryRouter, null, React.createElement(PendingChanges)),
    );
    expect(html).not.toContain('<fieldset');
    expect((html.match(/mode-banner/g) ?? []).length).toBe(0);
    expect(html).not.toContain('Demo mode');
    expect(html).not.toContain(ADVISORY_NOTE);
    expect(openingTag(html, '<button', '>Acknowledge<')).not.toContain('disabled');
    expect(openingTag(html, '<button', '>Reject<')).not.toContain('disabled');
  });

  it('PendingChanges: no pending items → nothing to decide, and still no banner', () => {
    const html = renderToStaticMarkup(
      React.createElement(MemoryRouter, null, React.createElement(PendingChanges)),
    );
    expect(html).not.toContain('<fieldset');
    expect((html.match(/mode-banner/g) ?? []).length).toBe(0);
    expect(html).not.toContain('Demo mode');
    expect(html).toContain('No pending changes right now.');
  });
});

/**
 * The admin surfaces' mock-build posture (the 2026-07-16 operator decision):
 * EVERY surface renders LIVE against its local store — Users, Teams, Approval
 * policy, Activity risk, the projects wizard, the audit export (Settings and
 * Pending changes are covered above). None carries a demo-mode banner — the
 * operator ships live and wants no such nag — so every case below also
 * asserts the banner count is 0. Nothing anywhere renders
 * armed-as-authoritative: an API build still requires a server-served flow
 * (the §0 rule, unchanged — see the AdvisoryControl coverage above and the
 * explicit-prop AccountRow cases below).
 */
describe('mock-build posture — every admin surface live, NO banner anywhere', () => {
  function render(el: React.ReactElement): string {
    return renderToStaticMarkup(React.createElement(MemoryRouter, null, el));
  }

  // The phrase proves the LIVE control set rendered (not a dimmed placeholder);
  // it must be real page copy, never the old banner text that has been removed.
  const demoLocalSurfaces: [string, React.ReactElement, string][] = [
    ['Teams', React.createElement(TeamsAdmin), 'Create a team'],
    ['Approval policy', React.createElement(ApprovalPolicyAdmin), 'Approvals by risk'],
    ['Activity risk', React.createElement(RiskAdmin), 'Activity risk'],
  ];

  it.each(demoLocalSurfaces)(
    '%s renders LIVE (no disabled fieldset) with its real controls — and NO banner',
    (_label, el, phrase) => {
      const html = render(el);
      expect(html).not.toContain('<fieldset');
      expect((html.match(/mode-banner/g) ?? []).length).toBe(0);
      expect(html).toContain(phrase);
      expect(html).not.toContain('Demo mode');
      expect(html).not.toContain(ADVISORY_NOTE);
    },
  );

  it('Approval policy: the save/reset controls are armed against the local policy store', () => {
    const html = render(React.createElement(ApprovalPolicyAdmin));
    expect(openingTag(html, '<button', '>Reset to defaults<')).not.toContain('disabled');
  });

  it('Users: the enrol form is live without a backend and says it creates a demo account', () => {
    const html = render(React.createElement(UsersAdmin));
    expect(html).toContain('Enrol a user');
    expect(html).toContain('Creates a demo account in this browser');
    expect(openingTag(html, '<button', '>Enrol user<')).not.toContain('disabled');
    // No page banner renders here.
    expect((html.match(/mode-banner/g) ?? []).length).toBe(0);
    expect(html).not.toContain('Demo mode');
  });

  it('Teams: the create-team control is live in demo mode', () => {
    const html = render(React.createElement(TeamsAdmin));
    expect(openingTag(html, '<button', '>Create team<')).not.toContain('disabled');
  });

  it('Projects: the onboarding wizard mounts with the 5-step path visible and every write LIVE against the demo registry', () => {
    const html = render(React.createElement(ProjectsAdmin));
    // The path is discoverable up front — the owner's complaint was a hunt.
    expect(html).toContain(`How a project joins ${APP_NAME}`);
    expect(html).toContain('Add a project');
    expect(html).toContain('Scan the repo');
    expect(html).toContain('catalogctl onboard');
    // Every wizard write acts on the demo registry (lib/projectOnboarding) —
    // nothing dims, and no page banner renders.
    expect((html.match(/mode-banner/g) ?? []).length).toBe(0);
    expect(html).not.toContain('<fieldset');
    expect(openingTag(html, '<button', '>Register draft project<')).not.toContain('disabled');
    // The fail-closed trust rule holds in every mode: with no recorded clean
    // report there is no trust control at all — not even a disabled one.
    expect(html).not.toContain('Trust this commit');
  });

  it('Audit history (read-only) shows the local/advisory honesty note', () => {
    const html = render(React.createElement(AuditHistory));
    expect(html).toContain('Recorded locally and advisory');
  });

  it('Audit history: the export is live in a demo build, honestly labelled as the history (not a chain)', () => {
    const html = render(React.createElement(AuditHistory));
    expect(html).toContain('Export history');
    expect(openingTag(html, '<button', '>Export history<')).not.toContain('disabled');
  });
});

/**
 * The 0014 P1 #4 / B1 wiring fix, at the component-render level. teamsFlow.test.ts,
 * usersFlow.test.ts, and httpApiAdmin.test.ts already prove the WRITE/READ
 * routing (which backend a call reaches); this proves the other half — that a
 * control's `disabled` attribute actually tracks `authoritative`, using the
 * same "static render with an explicit prop" technique <AdvisoryControl>
 * itself is tested with above (AccountRow takes `authoritative` as a prop
 * rather than resolving useServerInfo() itself, specifically so this is
 * possible without a DOM).
 *
 * B1 closed the gap 0014 P1 #4 left open: role/team/status/reset-password now
 * reach ccp-api too (admin.ts's accounts routes), so `authoritative` arms
 * them exactly like it already armed Reset TOTP/Revoke sessions. The ONE
 * control that still never arms is the isAdmin grant/revoke toggle — B1
 * deliberately did not wire it (see UsersAdmin.tsx's `authoritative` doc
 * comment) — so it stays the one hardcoded-`disabled`-regardless case here.
 */
describe('AccountRow — per-action gate (0014 P1 #4 / B1): every write control except isAdmin arms on authoritative', () => {
  const account: Account = {
    id: 'dewi',
    username: 'dewi',
    displayName: 'Dewi',
    role: 'requester',
    teamId: 'platform',
    passwordHash: '',
    salt: '',
    iterations: 0,
    status: 'active',
    createdAt: '2026-01-01T00:00:00Z',
    createdBy: 'system',
  };
  const teams: Team[] = [{ id: 'platform', name: 'Platform', serviceSlugs: [] }];

  function renderRow(authoritative: boolean, isMe = false, demo = false): string {
    return renderToStaticMarkup(
      React.createElement(
        'table',
        null,
        React.createElement(
          'tbody',
          null,
          React.createElement(AccountRow, {
            account,
            isMe,
            teams,
            authoritative,
            demo,
            onChange: () => {},
          }),
        ),
      ),
    );
  }

  it('authoritative=false: Reset 2FA and Revoke sessions are ALSO disabled (the safe pre-load default)', () => {
    const html = renderRow(false);
    expect(openingTag(html, '<button', '>Reset 2FA<')).toContain('disabled');
    expect(openingTag(html, '<button', '>Revoke sessions<')).toContain('disabled');
  });

  it('authoritative=true: Reset 2FA and Revoke sessions render WITHOUT disabled — armed', () => {
    const html = renderRow(true);
    expect(openingTag(html, '<button', '>Reset 2FA<')).not.toContain('disabled');
    expect(openingTag(html, '<button', '>Revoke sessions<')).not.toContain('disabled');
  });

  it('authoritative=false: manage-roles/status/reset-password are ALSO disabled (B1 — same per-flow gate as TOTP/sessions)', () => {
    // The single Role/Team dropdowns are replaced by the multi-account role +
    // scope assignment panel, opened from a gated "Manage roles" control.
    const html = renderRow(false);
    expect(openingTag(html, '<button', '>Manage roles<')).toContain('disabled');
    expect(openingTag(html, '<button', '>Reset password<')).toContain('disabled');
    expect(openingTag(html, '<button', '>Disable<')).toContain('disabled');
  });

  it('authoritative=true: manage-roles/status/reset-password render WITHOUT disabled — armed (B1)', () => {
    const html = renderRow(true);
    expect(openingTag(html, '<button', '>Manage roles<')).not.toContain('disabled');
    expect(openingTag(html, '<button', '>Reset password<')).not.toContain('disabled');
    expect(openingTag(html, '<button', '>Disable<')).not.toContain('disabled');
  });

  it.each([false, true])(
    'authoritative=%s: the isAdmin toggle stays hardcoded disabled — B1 deliberately does not wire it',
    (authoritative) => {
      const html = renderRow(authoritative);
      expect(tagFor(html, 'aria-label="Admin capability for Dewi"')).toContain('disabled');
    },
  );

  it('a self-row keeps manage-roles disabled even when authoritative — "another Lead must change your roles"', () => {
    const html = renderRow(true, true);
    const tag = openingTag(html, '<button', '>Manage roles<');
    expect(tag).toContain('disabled');
    expect(tag).toContain('Another Lead must change your roles');
  });

  it('authoritative=false: Rename and Delete are ALSO disabled (same per-flow gate)', () => {
    const html = renderRow(false);
    expect(openingTag(html, '<button', '>Rename<')).toContain('disabled');
    expect(openingTag(html, '<button', '>Delete<')).toContain('disabled');
  });

  it('authoritative=true: Rename and Delete render WITHOUT disabled — armed', () => {
    const html = renderRow(true);
    expect(openingTag(html, '<button', '>Rename<')).not.toContain('disabled');
    const del = openingTag(html, '<button', '>Delete<');
    expect(del).not.toContain('disabled');
    // The permanent/temporary split is stated up front on both controls.
    expect(del).toContain('Permanent');
    expect(openingTag(html, '<button', '>Disable<')).toContain('Temporary');
  });

  it('a self-row keeps Delete disabled even when authoritative — with the ask-another-admin reason', () => {
    const html = renderRow(true, true);
    const tag = openingTag(html, '<button', '>Delete<');
    expect(tag).toContain('disabled');
    expect(tag).toContain('You cannot delete your own account');
    expect(SELF_DELETE_NOTE).toContain('another admin');
  });

  it('demo=true: Rename and Delete are LIVE — the demo accounts store genuinely supports both', () => {
    const html = renderRow(false, false, true);
    expect(openingTag(html, '<button', '>Rename<')).not.toContain('disabled');
    expect(openingTag(html, '<button', '>Delete<')).not.toContain('disabled');
  });

  it('the Admin switch carries a VISIBLE caption (not just a tooltip) saying who can change it', () => {
    for (const html of [renderRow(true), renderRow(false), renderRow(false, false, true)]) {
      expect(html).toContain(ADMIN_TOGGLE_CAPTION);
    }
    // Plain words, on screen: the two-admin rule in a glance.
    expect(ADMIN_TOGGLE_CAPTION).toBe('Granted by two admins, not here');
  });

  it('the isAdmin toggle carries the plain-language ADR-0011 label — display-only, no jargon', () => {
    const html = renderRow(true);
    // The `title` sits on the wrapping <label>, not the <input> itself
    // (rendering a native toggle needs the label to carry the tooltip).
    const label = openingTag(html, '<label', 'aria-label="Admin capability for Dewi"');
    expect(label).toContain('Granting or revoking it is a dual-controlled change');
    expect(label).not.toContain(ADVISORY_NOTE);
    // Plain rendered copy (copyLint bans ADR refs in UI); the ADR-0011 rationale lives in the source comment.
    expect(ADMIN_CAPABILITY_NOTE).toContain('made outside this screen');
    expect(ADMIN_CAPABILITY_NOTE).not.toContain('ADR-');
  });

  /* Mode honesty (demo=true — a mock build): the accounts store works
   * locally — including the demo security state behind the 2FA toggle,
   * Reset TOTP, and Revoke sessions — so EVERY row control is LIVE against
   * the demo data. The one deliberate exception is the isAdmin toggle,
   * display-only in every mode. */

  it('demo=true: role/team/status/reset-password are LIVE — demo accounts genuinely work locally', () => {
    const html = renderRow(false, false, true);
    expect(tagFor(html, 'aria-label="Role for Dewi"')).not.toContain('disabled');
    expect(tagFor(html, 'aria-label="Team for Dewi"')).not.toContain('disabled');
    expect(openingTag(html, '<button', '>Reset password<')).not.toContain('disabled');
    expect(openingTag(html, '<button', '>Disable<')).not.toContain('disabled');
  });

  it('demo=true: Reset 2FA / Revoke sessions / the 2FA toggle are LIVE too — the demo security state backs them', () => {
    const html = renderRow(false, false, true);
    const totp = openingTag(html, '<button', '>Reset 2FA<');
    const sessions = openingTag(html, '<button', '>Revoke sessions<');
    expect(totp).not.toContain('disabled');
    expect(sessions).not.toContain('disabled');
    expect(totp).not.toContain('title=');
    expect(sessions).not.toContain('title=');
    expect(tagFor(html, 'aria-label="Two-factor authentication for Dewi"')).not.toContain('disabled');
    expect(html).not.toContain(ADVISORY_NOTE);
  });

  it('demo=true: the isAdmin toggle is still display-only (the one exception, in every mode)', () => {
    const html = renderRow(false, false, true);
    expect(tagFor(html, 'aria-label="Admin capability for Dewi"')).toContain('disabled');
  });
});

/** Locate the opening tag (up to its own `>`) of the FIRST `tagName` element
 * whose content is immediately followed by `marker` (e.g. `'>Save<'` to find
 * a button by its text) — static-HTML-string equivalent of a11y "get by
 * role+name", for asserting a specific control's attributes (no jsdom here). */
function openingTag(html: string, tagName: string, marker: string): string {
  const markerIdx = html.indexOf(marker);
  expect(markerIdx, `marker ${marker} not found in:\n${html}`).toBeGreaterThan(-1);
  const tagStart = html.lastIndexOf(tagName, markerIdx);
  expect(tagStart, `no ${tagName} before ${marker} in:\n${html}`).toBeGreaterThan(-1);
  const tagEnd = html.indexOf('>', tagStart);
  return html.slice(tagStart, tagEnd + 1);
}

/** Locate the opening tag containing a unique attribute `marker` (e.g.
 * `'aria-label="Role for Dewi"'`) — for elements identified by an attribute
 * rather than trailing text content (selects, checkboxes). */
function tagFor(html: string, marker: string): string {
  const markerIdx = html.indexOf(marker);
  expect(markerIdx, `marker ${marker} not found in:\n${html}`).toBeGreaterThan(-1);
  const tagStart = html.lastIndexOf('<', markerIdx);
  const tagEnd = html.indexOf('>', markerIdx);
  return html.slice(tagStart, tagEnd + 1);
}
