import { useEffect, useMemo, useState } from 'react';
import type { JSX } from 'react';
import type { ServiceManifest } from '@/types';
import { api, authClient } from '@/lib/api';
import { useActiveProjectId } from '@/lib/ProjectContext';
import { getCurrentUser } from '@/lib/session';
import { recordAudit } from '@/lib/audit';
import { getServiceMeta } from '@/lib/serviceMeta';
import { describeConfigWrite } from './policyFlow';
import { isParamRestricted, permittedValues, setAllowlistOverrideVia } from './settingsFlow';

/**
 * Admin allowlist restrictions. For every operation parameter
 * backed by a static allowlist, a leader can narrow which values L1 may pick —
 * at runtime, without touching a manifest. Narrowing only: the interpreter
 * intersects the chosen subset with the manifest list, so an admin can tighten
 * the estate but never introduce a value the Terraform doesn't support.
 *
 * Server-backed since ccp-api serves the settings flow (settingsFlow.ts,
 * `allowlist.restrictions`): when `authoritative`, reads render the server's
 * persisted truth (passed down from SettingsAdmin's one fetched view) and
 * writes are dual-controlled — narrowing applies immediately,
 * re-allowing a value waits for a second admin's ack. Otherwise reads/writes
 * are the exact pre-existing lib/settings localStorage behavior.
 */
interface AllowlistParam {
  service: string;
  operationId: string;
  operationTitle: string;
  paramName: string;
  paramLabel: string;
  base: string[];
}

function collectAllowlistParams(manifests: ServiceManifest[]): AllowlistParam[] {
  const out: AllowlistParam[] = [];
  for (const m of manifests) {
    for (const op of m.operations) {
      for (const p of op.params) {
        // Only multi-value static allowlists are restrictable — a single-value
        // list can't be narrowed without soft-locking the parameter.
        if (p.source === 'allowlist' && p.bounds?.allowlist && p.bounds.allowlist.length > 1) {
          out.push({
            service: m.service,
            operationId: op.id,
            operationTitle: op.title,
            paramName: p.name,
            paramLabel: p.label,
            base: p.bounds.allowlist.map(String),
          });
        }
      }
    }
  }
  return out;
}

export function AllowlistAdmin({
  authoritative,
  overrides,
  onChanged,
}: {
  /** Exactly `can('settings')` — arms the server write path. */
  authoritative: boolean;
  /** Permitted-subset overrides keyed `opId::param` — the one view SettingsAdmin
   * loaded (server-decoded when authoritative, else the local store's). */
  overrides: Record<string, string[]>;
  /** Re-load the view after a write so every section shares one truth. */
  onChanged: () => void;
}): JSX.Element {
  const [manifests, setManifests] = useState<ServiceManifest[]>([]);
  const [query, setQuery] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const projectId = useActiveProjectId();

  useEffect(() => {
    void api.listManifests().then(setManifests);
  }, [projectId]);

  const params = useMemo(() => collectAllowlistParams(manifests), [manifests]);

  const permitted = (p: AllowlistParam): Set<string> =>
    new Set(permittedValues(overrides, p.operationId, p.paramName, p.base));
  const restricted = (p: AllowlistParam): boolean =>
    isParamRestricted(overrides, p.operationId, p.paramName, p.base);

  const q = query.trim().toLowerCase();
  const matches = (p: AllowlistParam): boolean => {
    if (!q) return true;
    return (
      getServiceMeta(p.service).displayName.toLowerCase().includes(q) ||
      p.operationTitle.toLowerCase().includes(q) ||
      p.paramLabel.toLowerCase().includes(q) ||
      p.base.some((v) => v.toLowerCase().includes(q))
    );
  };

  const byService = useMemo(() => {
    const groups = new Map<string, AllowlistParam[]>();
    for (const p of params) {
      if (!matches(p)) continue;
      const list = groups.get(p.service) ?? [];
      list.push(p);
      groups.set(p.service, list);
    }
    return [...groups.entries()].sort((a, b) =>
      getServiceMeta(a[0]).displayName.localeCompare(getServiceMeta(b[0]).displayName),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params, q]);

  const restrictedCount = params.filter(restricted).length;

  async function write(
    p: AllowlistParam,
    values: string[] | null,
    appliedLabel: string,
    audit: { action: string; summary: string },
  ): Promise<void> {
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const outcome = await setAllowlistOverrideVia(
        authoritative,
        authClient,
        overrides,
        p.operationId,
        p.paramName,
        values,
        p.base,
      );
      // The server audits its own setting-change; a local entry only for a local write.
      if (!authoritative) recordAudit(getCurrentUser().id, audit.action, audit.summary);
      setNotice(describeConfigWrite(outcome, appliedLabel));
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not apply the change.');
    } finally {
      setBusy(false);
    }
  }

  function toggleValue(p: AllowlistParam, value: string): void {
    const current = permitted(p);
    if (current.has(value)) {
      if (current.size <= 1) return; // never remove the last permitted value
      current.delete(value);
    } else {
      current.add(value);
    }
    const next = p.base.filter((v) => current.has(v)); // preserve manifest order
    void write(p, next, `${p.paramLabel} — ${next.length} of ${p.base.length} values permitted`, {
      action: 'Adjusted allowlist',
      summary: `${p.operationTitle} · ${p.paramLabel}: ${next.length} of ${p.base.length} values permitted`,
    });
  }

  function reset(p: AllowlistParam): void {
    void write(p, null, `${p.paramLabel} — all ${p.base.length} values permitted again`, {
      action: 'Cleared allowlist restriction',
      summary: `${p.operationTitle} · ${p.paramLabel}: all ${p.base.length} values permitted again`,
    });
  }

  if (params.length === 0) {
    return (
      <p className="settings__summary">
        {manifests.length === 0
          ? 'Loading activities…'
          : 'No activities expose a restrictable allowlist.'}
      </p>
    );
  }

  return (
    <div className="allow">
      <p className="settings__summary">
        {params.length} restrictable {params.length === 1 ? 'setting' : 'settings'} across the
        catalog.{' '}
        {restrictedCount === 0
          ? 'None are currently restricted — every value the Terraform allows is available to L1.'
          : `${restrictedCount} ${restrictedCount === 1 ? 'is' : 'are'} currently narrowed.`}
      </p>

      {error && (
        <p className="settings__msg settings__msg--error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="settings__msg settings__msg--ok" role="status">
          {notice}
        </p>
      )}

      <div className="allow__filter">
        <span className="allow__filter-icon" aria-hidden="true">
          ⌕
        </span>
        <input
          type="search"
          className="allow__filter-input"
          placeholder="Filter by service, activity, setting, or value"
          aria-label="Filter allowlist settings"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {byService.length === 0 ? (
        <p className="settings__summary">No settings match “{query.trim()}”.</p>
      ) : (
        byService.map(([service, list]) => {
          const meta = getServiceMeta(service);
          const narrowed = list.filter(restricted).length;
          return (
            <details key={service} className="allow__service">
              <summary className="allow__service-summary">
                <span className="allow__service-name">{meta.displayName}</span>
                <span className="allow__service-count">
                  {list.length} {list.length === 1 ? 'setting' : 'settings'}
                  {narrowed > 0 ? ` · ${narrowed} narrowed` : ''}
                </span>
              </summary>
              <div className="allow__service-body">
                {list.map((p) => {
                  const permittedHere = permitted(p);
                  const restrictedHere = restricted(p);
                  return (
                    <div className="allow__param" key={`${p.operationId}::${p.paramName}`}>
                      <div className="allow__param-head">
                        <div className="allow__param-labels">
                          <span className="allow__param-label">{p.paramLabel}</span>
                          <span className="allow__param-op">{p.operationTitle}</span>
                        </div>
                        {restrictedHere ? (
                          <button
                            type="button"
                            className="allow__reset"
                            disabled={busy}
                            onClick={() => reset(p)}
                          >
                            Reset · allow all {p.base.length}
                          </button>
                        ) : (
                          <span className="allow__param-open">All allowed</span>
                        )}
                      </div>
                      <div className="allow__chips" role="group" aria-label={`${p.paramLabel} values`}>
                        {p.base.map((value) => {
                          const on = permittedHere.has(value);
                          const isLastOn = on && permittedHere.size <= 1;
                          return (
                            <button
                              key={value}
                              type="button"
                              className={on ? 'allow__chip allow__chip--on' : 'allow__chip'}
                              aria-pressed={on}
                              disabled={busy || isLastOn}
                              title={
                                isLastOn
                                  ? 'At least one value must stay allowed'
                                  : on
                                    ? 'Allowed — click to restrict'
                                    : 'Restricted — click to allow'
                              }
                              onClick={() => toggleValue(p, value)}
                            >
                              {value}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            </details>
          );
        })
      )}
    </div>
  );
}

export default AllowlistAdmin;
