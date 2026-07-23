import { useEffect, useState } from 'react';
import type { JSX } from 'react';
import { useNavigate } from 'react-router-dom';
import { useCurrentUser } from '@/lib/session';
import { signOut } from '@/lib/auth';
import { authClient } from '@/lib/api';
import { setProjectScope, SAMPLE_ESTATE_ID } from '@/lib/projectScope';
import { useServerInfo } from '@/components/AdvisoryGate';
import { loadServerProjectsVia } from '@/features/admin/projectsFlow';
import ProjectsAdmin from '@/features/admin/ProjectsAdmin';
import { InstanceIdentityEditor } from '@/features/admin/InstanceIdentityEditor';
import { useInstanceIdentity } from '@/lib/instanceIdentity';
import './first-run.css';

/**
 * The first-run surface (data-birth spec, lane B item 3): where an
 * authenticated visit lands when it has no active estate scope and the
 * signed-in account holds no concrete role on one either (lib/legacyRoute.ts
 * `unscopedLandingPath` routes here instead of falling through to a bundled
 * shell nobody earned). Estate-generic — every word here is either static
 * product copy or data read from the registry/session, never a baked estate
 * name (the source-genericity guard scans this file like any other).
 *
 * The registry read below is ONLY for an honest headline (never claim "no
 * accounts" when some exist and this account simply isn't bound to one — a
 * `'*'`-bound founding admin reaches this same screen with zero CONCRETE
 * scopes even in steady state). The actual onboarding mechanism is not
 * reimplemented here: for an admin, the existing Admin -> Projects wizard
 * (ProjectsAdmin — register -> trust -> connect CI -> activate, already
 * live) is embedded directly, so this screen is its front door, not a
 * second implementation of the ladder.
 */
export function FirstRunPage(): JSX.Element {
  const user = useCurrentUser();
  const navigate = useNavigate();
  const identity = useInstanceIdentity();
  const { can } = useServerInfo();
  // The BOOLEAN, not `can` itself: `useServerInfo()` hands back a fresh
  // closure every render (same doctrine as ProjectsAdmin.tsx's own
  // `authoritative`), so depending on `can` would refire this effect on
  // every render — including the one this effect's own setReadyCount below
  // causes — an infinite loop. The boolean is stable once resolved.
  const authoritative = can('projects');
  // The instance-identity card gates on the SAME existing `settings` flow
  // flag the admin Settings editor uses (no new ServerFlow capability was
  // added for this), not on `projects` above.
  const identityAuthoritative = can('settings');
  // null = still loading, or the read failed — render the neutral headline
  // rather than assert either "zero" or "some" without having confirmed it.
  const [readyCount, setReadyCount] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    void loadServerProjectsVia(authoritative, authClient)
      .then((list) => {
        if (alive) setReadyCount(list.filter((p) => p.status === 'ready' && !p.archived).length);
      })
      .catch(() => {
        /* leave readyCount null — the neutral headline still renders */
      });
    return () => {
      alive = false;
    };
  }, [authoritative]);

  function handleSignOut(): void {
    void authClient?.logout();
    signOut();
    navigate('/login', { replace: true });
  }

  function loadSample(): void {
    setProjectScope(SAMPLE_ESTATE_ID);
    navigate(`/p/${SAMPLE_ESTATE_ID}/`, { replace: true });
  }

  const headline =
    readyCount === null
      ? 'Get your account online'
      : readyCount === 0
        ? 'No accounts onboarded yet'
        : 'Choose or onboard an account';

  return (
    <div className="first-run">
      <header className="first-run__bar">
        <span className="first-run__brand">
          <span className="first-run__mark" aria-hidden="true">
            ◆
          </span>
          {identity.name}
        </span>
        <button type="button" className="first-run__signout" onClick={handleSignOut}>
          Sign out
        </button>
      </header>

      <main className="first-run__main">
        <section className="first-run__identity" aria-labelledby="first-run-identity-title">
          <h2 className="first-run__sample-title" id="first-run-identity-title">
            Name this instance
          </h2>
          {user.isAdmin ? (
            <>
              <p className="first-run__lead">
                Installer-seeded or generic — correct it now, or leave it and rename anytime later
                under Admin → Settings. This step is skippable: the generic default is a valid
                identity.
              </p>
              <InstanceIdentityEditor authoritative={identityAuthoritative} />
            </>
          ) : (
            <p className="first-run__lead">
              This instance is named <strong>{identity.name}</strong>. An administrator can change
              it under Admin → Settings.
            </p>
          )}
        </section>

        <h1 className="first-run__title">{headline}</h1>

        {user.isAdmin ? (
          <>
            <p className="first-run__lead">
              {readyCount !== null && readyCount > 0
                ? 'You do not hold a role on a ready account yet. Onboard another one below, or ask a fellow administrator to grant you a role on one that already exists.'
                : 'Bring your first account online through the same register, trust, connect, and activate steps every account uses — no rebuild, no redeploy.'}
            </p>
            <ProjectsAdmin />
          </>
        ) : (
          <p className="first-run__lead">
            You do not hold a role on any account yet. Ask an administrator to onboard your
            organization&rsquo;s first account, or to grant you a role on one that already exists.
          </p>
        )}

        <section className="first-run__sample" aria-labelledby="first-run-sample-title">
          <h2 className="first-run__sample-title" id="first-run-sample-title">
            Just exploring?
          </h2>
          <p className="first-run__lead">
            Load the sample estate — captured demo data, not your infrastructure — to see how the
            product works before connecting a real account.
          </p>
          <button type="button" className="first-run__sample-btn" onClick={loadSample}>
            Load sample data
          </button>
        </section>
      </main>
    </div>
  );
}

export default FirstRunPage;
