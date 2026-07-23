import { useEffect, useState } from 'react';
import type { JSX } from 'react';
import { listAudit } from '@/lib/audit';
import { resolveName } from '@/lib/accounts';
import { currentProjectId } from '@/lib/projectScope';
import { useDebouncedValue } from '@/lib/useDebouncedValue';
import { authClient } from '@/lib/api';
import { exportAuditVia, loadAuditRows, localAuditExport, type AuditRow } from './auditFlow';
import { SearchBar } from '@/components/SearchBar';
import { ADVISORY_NOTE, SERVER_MODE, useServerInfo } from '@/components/AdvisoryGate';
import './audit.css';

function when(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** The governance audit trail — every admin mutation, newest first. */
export function AuditHistory(): JSX.Element {
  const { can } = useServerInfo();
  const authoritative = can('audit');
  // Mode honesty: a mock build's timeline IS the local log, so exporting it
  // works there too (as a plainly-labelled local document — auditFlow's
  // localAuditExport). An api build keeps the arming rule for the chain export.
  const demo = SERVER_MODE === 'mock';
  const [entries, setEntries] = useState<AuditRow[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void loadAuditRows(authoritative, authClient, listAudit())
      .then((rows) => {
        if (!alive) return;
        setLoadError(null);
        setEntries(rows);
      })
      .catch((err: unknown) => {
        if (!alive) return;
        setLoadError(err instanceof Error ? err.message : 'Could not load the audit history.');
      });
    return () => {
      alive = false;
    };
  }, [authoritative]);

  const [query, setQuery] = useState('');
  const q = useDebouncedValue(query.trim().toLowerCase(), 200);
  const shown = q
    ? entries.filter(
        (e) =>
          resolveName(e.actor).toLowerCase().includes(q) ||
          e.action.toLowerCase().includes(q) ||
          e.summary.toLowerCase().includes(q),
      )
    : entries;

  async function onExport(): Promise<void> {
    setExportError(null);
    setExporting(true);
    try {
      // Server-served: the hash-chained evidence document. Otherwise: this
      // browser's own log, as a document that says so (never a fake chain).
      const doc =
        authoritative && authClient
          ? await exportAuditVia(authClient)
          : localAuditExport(currentProjectId(), listAudit());
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' }),
      );
      const a = document.createElement('a');
      a.href = url;
      a.download = `ccp-audit-${doc.projectId}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setExportError(err instanceof Error ? err.message : 'Could not export the audit history.');
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="audit">
      <div className="audit__head">
        <div className="audit__head-id">
          <h2 className="audit__title">History</h2>
          <span className="audit__note">
            {entries.length} events · governance actions, newest first
          </span>
        </div>
        <div className="audit__head-actions">
          <button
            type="button"
            className="audit__export"
            onClick={() => void onExport()}
            disabled={(!authoritative && !demo) || exporting}
            title={authoritative || demo ? undefined : ADVISORY_NOTE}
          >
            {exporting ? 'Exporting…' : demo ? 'Export history' : 'Export chain'}
          </button>
          {entries.length > 6 && (
            <SearchBar
              value={query}
              onChange={setQuery}
              placeholder="Search actor, action, detail"
              ariaLabel="Search audit history"
              count={q ? `${shown.length} of ${entries.length}` : undefined}
            />
          )}
        </div>
      </div>

      {!authoritative && (
        <p className="audit__advisory" role="note">
          Recorded locally and advisory — ccp-api keeps the authoritative audit chain once it
          serves this view. What you see here is this browser’s record of admin actions, not the
          server’s.
        </p>
      )}

      {loadError && (
        <p className="audit__advisory" role="alert">
          {loadError}
        </p>
      )}
      {exportError && (
        <p className="audit__advisory" role="alert">
          {exportError}
        </p>
      )}

      {entries.length === 0 ? (
        <div className="audit__empty">
          No governance actions recorded yet. Enrolments, role &amp; team changes, team edits, and
          approval-policy changes will appear here with who did what, and when.
        </div>
      ) : shown.length === 0 ? (
        <div className="audit__empty">No events match “{q}”.</div>
      ) : (
        <ol className="audit__list">
          {shown.map((e) => (
            <li key={e.id} className="audit__item">
              <span className="audit__dot" aria-hidden="true" />
              <div className="audit__body">
                <div className="audit__line">
                  <span className="audit__action">{e.action}</span>
                  <span className="audit__summary">{e.summary}</span>
                </div>
                <div className="audit__meta">
                  {resolveName(e.actor)} · {when(e.at)}
                </div>
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

export default AuditHistory;
