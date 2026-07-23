import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { APP_NAME } from '@/brand';
import { ADVISORY_NOTE } from '@/components/AdvisoryGate';
import { InstanceIdentityEditor } from '@/features/admin/InstanceIdentityEditor';
import { resetInstanceIdentityForTests } from '@/lib/instanceIdentity';

/**
 * ADR-0023 — the shared rename card (features/admin/InstanceIdentityEditor.tsx).
 * Static-shape coverage only: this repo has no jsdom/RTL, so a submit/save
 * interaction is not drivable here — same "interactive state this repo's
 * static-render tests can't drive" limit LoginPage's TotpEnrollFields split
 * documents. What IS provable statically: initial field values reflect the
 * resolved identity, and the authoritative/advisory gating renders correctly.
 */

function render(el: React.ReactElement): string {
  return renderToStaticMarkup(el);
}

afterEach(() => {
  resetInstanceIdentityForTests();
});

describe('InstanceIdentityEditor — static render shape', () => {
  it('authoritative=true: the form renders bare (no advisory fieldset), initial value = the resolved name', () => {
    const html = render(React.createElement(InstanceIdentityEditor, { authoritative: true }));
    expect(html).toContain(`value="${APP_NAME}"`);
    expect(html).not.toContain(ADVISORY_NOTE);
    expect(html).toContain('Save name');
  });

  it('authoritative=false (mock mode / server not yet serving settings): wrapped in the advisory fieldset with the standard note', () => {
    const html = render(React.createElement(InstanceIdentityEditor, { authoritative: false }));
    expect(html).toContain('disabled=""');
    expect(html).toContain(ADVISORY_NOTE);
  });

  it('the tagline field is present and optional (empty by default)', () => {
    const html = render(React.createElement(InstanceIdentityEditor, { authoritative: true }));
    expect(html).toContain('Tagline (optional)');
  });
});
