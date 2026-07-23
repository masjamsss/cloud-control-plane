import { useEffect, useState } from 'react';
import type { FormEvent, JSX } from 'react';
import { authClient } from '@/lib/api';
import { adoptInstanceIdentity, useInstanceIdentity } from '@/lib/instanceIdentity';
import { AdvisoryControl } from '@/components/AdvisoryGate';
import './instance-identity-editor.css';

const MAX_NAME = 64;
const MAX_TAGLINE = 140;

/**
 * The shared instance-identity rename card (see the generic-branding decision
 * record) — one component, two mounts: the FirstRunPage identity step (ahead
 * of estate onboarding) and the admin Settings surface ("rename anytime").
 * Renaming is IMMEDIATE + AUDITED, never dual-control (a display string, not
 * a privilege edge) — a single save always either applies or reports a plain
 * reason, no pending-ack branch.
 *
 * `authoritative` gates on the EXISTING `can('settings')` server-info flag
 * (no new ServerFlow capability was added for this) — the same per-flow
 * honesty rule every other admin write control in this app already follows
 * (components/AdvisoryGate.tsx). Mock/standalone mode is always
 * non-authoritative here BY DESIGN (there is no local instance-identity
 * store — the standalone-parity invariant requires mock mode to stay on the
 * baked brand.ts default, never a client-forgeable local rename), so the
 * card renders read-only there with the SAME advisory note every other inert
 * admin control shows.
 */
export function InstanceIdentityEditor({ authoritative }: { authoritative: boolean }): JSX.Element {
  const identity = useInstanceIdentity();
  const [name, setName] = useState(identity.name);
  const [tagline, setTagline] = useState(identity.tagline);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  // The runtime identity can resolve (or change, on a rename from ANOTHER
  // tab/admin) after this card already mounted with an earlier value — keep
  // the draft honest with the live identity whenever the FIELD ITSELF isn't
  // mid-edit-and-unsaved. Simplification: resync whenever nothing is pending
  // (never clobber a save in flight, never clobber right after OUR OWN save
  // — adoptInstanceIdentity below already set the exact value we just typed).
  useEffect(() => {
    if (!busy) {
      setName(identity.name);
      setTagline(identity.tagline);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity.name, identity.tagline]);

  async function save(e: FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    setSaved(null);
    const trimmedName = name.trim();
    if (trimmedName.length === 0) {
      setError('Enter a name.');
      return;
    }
    if (!authClient) {
      setError('Renaming needs a connected server — this build runs standalone.');
      return;
    }
    setBusy(true);
    try {
      const result = await authClient.setInstance({ name: trimmedName, tagline: tagline.trim() });
      adoptInstanceIdentity(result);
      setName(result.name);
      setTagline(result.tagline);
      setSaved('Saved.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the instance name.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <AdvisoryControl authoritative={authoritative}>
      <form className="instance-editor" onSubmit={(e) => void save(e)} noValidate>
        <label className="instance-editor__field">
          <span className="instance-editor__label">Instance name</span>
          <input
            className="instance-editor__input"
            type="text"
            value={name}
            maxLength={MAX_NAME}
            disabled={busy}
            aria-invalid={error !== null}
            onChange={(e) => {
              setName(e.target.value);
              setSaved(null);
            }}
          />
          <span className="instance-editor__hint">
            Shown on the sign-in screen and everywhere in the app.
          </span>
        </label>

        <label className="instance-editor__field">
          <span className="instance-editor__label">Tagline (optional)</span>
          <input
            className="instance-editor__input"
            type="text"
            value={tagline}
            maxLength={MAX_TAGLINE}
            disabled={busy}
            onChange={(e) => {
              setTagline(e.target.value);
              setSaved(null);
            }}
          />
        </label>

        <div className="instance-editor__actions">
          <button
            type="submit"
            className="instance-editor__save"
            disabled={busy || name.trim().length === 0}
          >
            {busy ? 'Saving…' : 'Save name'}
          </button>
          {error && (
            <span className="instance-editor__msg instance-editor__msg--error" role="alert">
              {error}
            </span>
          )}
          {saved && !error && (
            <span className="instance-editor__msg instance-editor__msg--ok" role="status">
              {saved}
            </span>
          )}
        </div>
      </form>
    </AdvisoryControl>
  );
}

export default InstanceIdentityEditor;
