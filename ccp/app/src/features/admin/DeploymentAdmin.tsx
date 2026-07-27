import { useEffect, useState } from 'react';
import type { JSX } from 'react';
import type { DeploymentSetting } from '@/lib/httpApi';
import { authClient } from '@/lib/api';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { GateFieldset, useServerInfo } from '@/components/AdvisoryGate';
import { refusalCopy } from './projectsFlow';
import './deployment-admin.css';

/**
 * EVERYTHING THIS SYSTEM IS CONFIGURED WITH, ON ONE SCREEN.
 *
 * The goal is an operator who does not open a config file to run the system.
 * Two design rules follow from that, and they are the reason this screen shows
 * more than it can change:
 *
 *  1. NOTHING IS HIDDEN. Settings the portal cannot edit are listed anyway,
 *     with their current state and a plain sentence saying why they live
 *     outside and what to do instead. A screen with silent gaps is what sends
 *     someone back to grepping config files — which is the thing being removed.
 *  2. A SECRET IS NEVER SHOWN, only whether one is set. Reading a secret back
 *     out of a web page is how secrets end up in screenshots and bug reports.
 *
 * Changes that WIDEN what the deployment may do — arming the scanner, adding a
 * repository host it may read from, lifting the apply freeze — come back as a
 * proposal for a second admin rather than taking effect. Tightening applies at
 * once: a safety brake must never wait for a colleague.
 */

const GROUP_ORDER = [
  'scanner',
  'drift',
  'apply',
  'git',
  'identity',
  'session',
  'storage',
  'process',
] as const;

const GROUP_TITLE: Record<string, string> = {
  scanner: 'Reading your repositories',
  drift: 'Drift',
  apply: 'Applying changes',
  git: 'Where the code lives',
  identity: 'Identity and sign-in',
  session: 'How browsers reach this system',
  storage: 'Storage',
  process: 'The machine it runs on',
};

const SOURCE_LABEL: Record<DeploymentSetting['source'], string> = {
  portal: 'set here',
  environment: "from the deployment's config",
  default: 'default',
};

function valueText(s: DeploymentSetting): string {
  if (s.secret) return s.configured ? 'Set' : 'Not set';
  if (s.kind === 'toggle') return s.value === true ? 'On' : 'Off';
  if (s.kind === 'list') {
    const list = Array.isArray(s.value) ? (s.value as string[]) : [];
    return list.length > 0 ? list.join(', ') : 'None';
  }
  const v = s.value;
  return v === undefined || v === '' ? 'Not set' : String(v);
}

export function DeploymentAdmin(): JSX.Element {
  const { can } = useServerInfo();
  const authoritative = can('settings');
  const [rows, setRows] = useState<DeploymentSetting[] | null>(null);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'warn' | 'error'; text: string } | null>(
    null,
  );
  // Per-row draft text for the ones you type into, so a half-typed value never
  // fights the refreshed server view.
  const [draft, setDraft] = useState<Record<string, string>>({});

  const refresh = (): void => {
    if (!authoritative) {
      setRows([]);
      return;
    }
    void authClient
      ?.loadDeploymentSettings()
      .then(setRows)
      .catch((e: unknown) => setNotice({ kind: 'error', text: refusalCopy(e) }));
  };
  useEffect(refresh, [authoritative]);

  function save(s: DeploymentSetting, value: unknown): void {
    setNotice(null);
    void authClient
      ?.setDeploymentSetting(s.id, value)
      .then((outcome) => {
        setDraft((d) => {
          const { [s.id]: _dropped, ...rest } = d;
          return rest;
        });
        refresh();
        setNotice(
          outcome.applied
            ? {
                kind: 'ok',
                text: `Saved — ${s.label.toLowerCase()} is now ${valueTextOf(s, value)}.`,
              }
            : {
                kind: 'warn',
                text: `This one widens what the system may do, so it needs a second admin. Sent for their approval — nothing has changed yet.`,
              },
        );
      })
      .catch((e: unknown) => setNotice({ kind: 'error', text: refusalCopy(e) }));
  }

  function valueTextOf(s: DeploymentSetting, value: unknown): string {
    return valueText({ ...s, value, configured: undefined });
  }

  const grouped = GROUP_ORDER.map((g) => ({
    group: g,
    items: (rows ?? []).filter((r) => r.group === g),
  })).filter((g) => g.items.length > 0);

  const editableCount = (rows ?? []).filter((r) => r.editable).length;

  return (
    <div className="deploy">
      <header className="deploy__head">
        <h2 className="deploy__title">Deployment</h2>
        <p className="deploy__lead">
          Everything this system is configured with. {editableCount} of {rows?.length ?? 0} can be
          changed right here; the rest are listed with their current state and what to do instead,
          so there is nothing you have to go hunting for in a file.
        </p>
        <p className="deploy__lead deploy__lead--muted">
          Anything that <strong>widens</strong> what this system may do — letting it read your
          repositories, adding a repository host, lifting a freeze — is sent to a second admin
          rather than taking effect on one person&apos;s click.
        </p>
      </header>

      {notice && (
        <p className={`deploy__notice deploy__notice--${notice.kind}`} role="status">
          {notice.text}
        </p>
      )}

      {rows === null && <p className="deploy__lead">Loading…</p>}
      {rows !== null && rows.length === 0 && (
        <p className="deploy__lead">
          This build has no live connection to a server, so there is nothing to configure here.
        </p>
      )}

      {grouped.map(({ group, items }) => (
        <section key={group} className="deploy__group" aria-labelledby={`deploy-${group}`}>
          <h3 className="deploy__group-title" id={`deploy-${group}`}>
            {GROUP_TITLE[group] ?? group}
          </h3>
          <div className="deploy__rows">
            {items.map((s) => (
              <Card key={s.id} className="deploy__row">
                <div className="deploy__row-head">
                  <div>
                    <p className="deploy__row-label">{s.label}</p>
                    <p className="deploy__row-help">{s.help}</p>
                  </div>
                  <div className="deploy__row-state">
                    <Badge color="muted">{valueText(s)}</Badge>
                    <span className="deploy__row-source">{SOURCE_LABEL[s.source]}</span>
                  </div>
                </div>

                {s.editable ? (
                  <GateFieldset disabled={!authoritative}>
                    <div className="deploy__row-edit">
                      {s.kind === 'toggle' ? (
                        <Button
                          variant={s.value === true ? 'danger' : 'primary'}
                          onClick={() => save(s, s.value !== true)}
                        >
                          {s.value === true ? 'Turn off' : 'Turn on'}
                        </Button>
                      ) : (
                        <>
                          <input
                            className="deploy__input"
                            aria-label={s.label}
                            value={draft[s.id] ?? textOf(s)}
                            onChange={(e) => setDraft({ ...draft, [s.id]: e.target.value })}
                            placeholder={s.kind === 'list' ? 'one, per, line' : ''}
                            spellCheck={false}
                            inputMode={s.kind === 'number' ? 'numeric' : undefined}
                          />
                          <Button
                            variant="primary"
                            onClick={() => save(s, parseFor(s, draft[s.id] ?? textOf(s)))}
                          >
                            Save
                          </Button>
                        </>
                      )}
                    </div>
                  </GateFieldset>
                ) : (
                  <div className="deploy__row-locked">
                    {/* Not "you can't change this" — why, and what to do. */}
                    <p className="deploy__row-reason">{s.notEditable?.reason}</p>
                    <p className="deploy__row-instead">{s.notEditable?.instead}</p>
                    <p className="deploy__row-env">
                      In the deployment&apos;s config this is <code>{s.env}</code>.
                    </p>
                  </div>
                )}
              </Card>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function textOf(s: DeploymentSetting): string {
  if (s.kind === 'list') {
    return Array.isArray(s.value) ? (s.value as string[]).join(', ') : '';
  }
  return s.value === undefined || s.value === null ? '' : String(s.value);
}

/** Turn what was typed into the shape the server's registry expects. The server
 * re-checks it — this only saves a round trip on the obvious cases. */
function parseFor(s: DeploymentSetting, text: string): unknown {
  if (s.kind === 'number') {
    const n = Number(text.trim());
    return Number.isFinite(n) ? n : text.trim();
  }
  if (s.kind === 'list') {
    return text
      .split(',')
      .map((x) => x.trim())
      .filter((x) => x.length > 0);
  }
  return text.trim();
}

export default DeploymentAdmin;
