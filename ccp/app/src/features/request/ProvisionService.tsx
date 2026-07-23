import { useEffect, useMemo, useRef, useState } from 'react';
import type { JSX } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type { Inventory, ManifestOperation, ServiceManifest } from '@/types';
import { api } from '@/lib/api';
import { useActiveProjectId, useProject } from '@/lib/ProjectContext';
import { getCurrentUser } from '@/lib/session';
import { buildRequestDraft, validateParams } from '@/lib/interpreter';
import { deriveFormPlan } from '@/lib/catalog';
import {
  buildProvisionOperation,
  loadProviderIndex,
  loadServiceChunk,
  manifestCreateOpsByType,
  provisionResourceType,
  type CatalogIndex,
  type CatalogServiceChunk,
  type CatalogServiceEntry,
  type CatalogTypeSummary,
} from '@/lib/providerCatalog';
import { SchemaForm } from '@/components/SchemaForm/SchemaForm';
import { Breadcrumbs } from '@/components/Breadcrumbs';
import { Button } from '@/components/ui/Button';
import { RiskBadge } from '@/components/ui/RiskBadge';
import { AccessBadge } from '@/components/ui/AccessBadge';
import { MacdTag } from '@/components/ui/MacdTag';
import { ErrorSummary, type ErrorSummaryItem } from './ErrorSummary';
import './request.css';

const MIN_JUSTIFICATION = 10;

/** An empty inventory: generated provision forms have no inventory-sourced
 * params, but SchemaForm's contract wants one. */
const NO_INVENTORY: Inventory = { generatedAt: null, resources: [] };

/**
 * One resource type the picker offers: either the estate's own hand-authored
 * create form (preferred — allow-lists, live pickers, estate bounds) or the
 * schema-generated form. Exported for render-shape tests.
 */
export interface ProvisionChoice {
  summary: CatalogTypeSummary;
  /** Hand-authored create baselines that stand up this type (may be empty). */
  ops: ManifestOperation[];
}

export function deriveProvisionChoices(
  entry: CatalogServiceEntry,
  manifests: ServiceManifest[],
): ProvisionChoice[] {
  const byType = manifestCreateOpsByType(manifests);
  return entry.types.map((summary) => ({ summary, ops: byType.get(summary.t) ?? [] }));
}

/** The resource-type picker — estate forms lead, generated forms cover the rest. */
export function ProvisionTypePicker({
  serviceName,
  choices,
  onPick,
}: {
  serviceName: string;
  choices: ProvisionChoice[];
  onPick: (resourceType: string) => void;
}): JSX.Element {
  return (
    <div className="pv-picker">
      <p className="rq-desc">
        Choose what to provision in {serviceName}. Where this estate already has its own form
        (marked), that richer form opens — it knows the estate’s allowed values. Everything else
        uses a form generated from the Terraform provider itself, with every parameter the
        resource takes.
      </p>
      <ul className="pv-typelist">
        {choices.map(({ summary, ops }) => (
          <li key={summary.t} className="pv-typerow">
            {ops.length > 0 && ops[0] ? (
              <Link className="pv-typecard" to={`/services/${ops[0].service}/${ops[0].id}`}>
                <span className="pv-typecard__main">
                  <span className="pv-typecard__label">
                    {summary.label}
                    {summary.primary === 1 && <span className="pv-chip pv-chip--primary">most common</span>}
                    <span className="pv-chip pv-chip--estate">estate form</span>
                  </span>
                  <span className="pv-typecard__type">{summary.t}</span>
                </span>
                <span className="pv-typecard__meta">{ops[0].title}</span>
              </Link>
            ) : (
              <button type="button" className="pv-typecard" onClick={() => onPick(summary.t)}>
                <span className="pv-typecard__main">
                  <span className="pv-typecard__label">
                    {summary.label}
                    {summary.primary === 1 && <span className="pv-chip pv-chip--primary">most common</span>}
                  </span>
                  <span className="pv-typecard__type">{summary.t}</span>
                </span>
                <span className="pv-typecard__meta">
                  {summary.req} required · {summary.opt} optional settings
                </span>
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The per-service provision page (`/provision/:service`): pick a resource
 * type, then fill the schema-generated form. The synthesized operation flows
 * through the SAME seams as every catalog op — SchemaForm renders it,
 * validateParams checks it, buildRequestDraft + api.submitRequest carry it —
 * and it always routes to an engineer (exposure engineer_only): the portal
 * captures the full parameter sheet; a human authors the Terraform after
 * approval. Nothing about the request/approval pipeline changes.
 */
export function ProvisionService(): JSX.Element {
  const { service } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const chosenType = searchParams.get('type');
  const from = searchParams.get('from');
  const navigate = useNavigate();
  const projectId = useActiveProjectId();
  // The active project's cloud provider scopes which catalog (aws or azure)
  // this page serves — the same `project.provider ?? 'aws'` wire convention the
  // service catalog and beyond-catalog chooser read.
  const provider = useProject().provider ?? 'aws';

  const [index, setIndex] = useState<CatalogIndex | null>(null);
  const [chunk, setChunk] = useState<CatalogServiceChunk | null>(null);
  const [manifests, setManifests] = useState<ServiceManifest[]>([]);
  const [loaded, setLoaded] = useState(false);

  const [values, setValues] = useState<Record<string, unknown>>({});
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [justification, setJustification] = useState('');
  const [revealErrors, setRevealErrors] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [blockedReason, setBlockedReason] = useState<string | null>(null);
  const [prefilledFrom, setPrefilledFrom] = useState<string | null>(null);
  const errorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    setLoaded(false);
    void Promise.all([
      loadProviderIndex(provider),
      service ? loadServiceChunk(provider, service) : Promise.resolve(null),
      api.listManifests(),
    ]).then(([idx, ch, m]) => {
      if (!alive) return;
      setIndex(idx);
      setChunk(ch);
      setManifests(m);
      setLoaded(true);
    });
    return () => {
      alive = false;
    };
  }, [service, projectId, provider]);

  const entry = useMemo(
    () => index?.services.find((s) => s.slug === service) ?? null,
    [index, service],
  );

  const choices = useMemo(
    () => (entry ? deriveProvisionChoices(entry, manifests) : []),
    [entry, manifests],
  );

  // Exactly one choice and it has no estate form → skip the picker entirely.
  const soleGeneratedType =
    choices.length === 1 && choices[0] && choices[0].ops.length === 0 ? choices[0].summary.t : null;
  const activeType = chosenType ?? soleGeneratedType;

  const op = useMemo(() => {
    if (!service || !activeType || !chunk) return null;
    const res = chunk.types[activeType];
    return res ? buildProvisionOperation(service, activeType, res) : null;
  }, [service, activeType, chunk]);

  // Fresh form state whenever the chosen type changes.
  useEffect(() => {
    setValues({});
    setTouched({});
    setJustification('');
    setRevealErrors(false);
    setBlockedReason(null);
    setPrefilledFrom(null);
  }, [activeType]);

  // "Request again": seed values from the earlier request — only params this
  // form still declares, never the justification.
  useEffect(() => {
    if (!from || !op) return;
    let alive = true;
    void api.getRequest(from).then((request) => {
      if (!alive || !request) return;
      if (provisionResourceType(request.operationId) !== op.target.resourceType) return;
      const seed: Record<string, unknown> = {};
      for (const p of op.params) {
        const v = request.params[p.name];
        if (v !== undefined) seed[p.name] = v;
      }
      setValues(seed);
      setPrefilledFrom(request.id);
    });
    return () => {
      alive = false;
    };
    // op is stable per activeType; from is stable per URL.
  }, [from, op, projectId]);

  const validation = useMemo(
    () => (op ? validateParams(op, values, NO_INVENTORY) : { ok: false, errors: {} }),
    [op, values],
  );

  if (!loaded) {
    return (
      <div className="rq">
        <p className="rq-loading">Loading…</p>
      </div>
    );
  }

  if (!entry) {
    return (
      <div className="rq">
        <Breadcrumbs
          items={[
            { label: 'Catalog', to: '/' },
            { label: 'What do you need?', to: '/services/request-new' },
            { label: 'Not found' },
          ]}
        />
        <div className="rq-notfound">
          <h1 className="rq-notfound__title">No such service</h1>
          <p>
            Nothing named <code>{service}</code> is in the provider catalog.
          </p>
          <Link to="/services/request-new" className="rq-cancel">
            Back to the service list
          </Link>
        </div>
      </div>
    );
  }

  const crumbs = [
    { label: 'Catalog', to: '/' },
    { label: 'What do you need?', to: '/services/request-new' },
    { label: entry.name },
  ];

  // ── Picker view ──────────────────────────────────────────────────────────
  if (!op) {
    return (
      <div className="rq">
        <Breadcrumbs items={crumbs} />
        <h1 className="rq-title">Provision a new {entry.name} resource</h1>
        <ProvisionTypePicker
          serviceName={entry.name}
          choices={choices}
          onPick={(t) => setSearchParams({ type: t })}
        />
      </div>
    );
  }

  // ── Generated form view ──────────────────────────────────────────────────
  const plan = deriveFormPlan(op);
  // A resource where every parameter is optional would otherwise render as a
  // single closed section — open it so the parameters are visible at once.
  const hasRequired = op.params.some((p) => p.required);
  const sections = hasRequired
    ? plan.sections
    : plan.sections.map((s) => (s.id === 'options' ? { ...s, collapsed: false } : s));
  const justificationTooShort = justification.trim().length < MIN_JUSTIFICATION;
  const justificationError = justificationTooShort
    ? 'Enter a justification (at least 10 characters).'
    : '';

  const errorItems: ErrorSummaryItem[] = [];
  for (const p of op.params) {
    const msg = validation.errors[p.name];
    if (msg) errorItems.push({ name: p.name, label: p.label, message: msg });
  }
  if (justificationTooShort) {
    errorItems.push({ name: 'justification', label: 'Justification', message: justificationError });
  }

  const onChange = (name: string, value: unknown): void =>
    setValues((v) => ({ ...v, [name]: value }));
  const onBlur = (name: string): void => setTouched((t) => ({ ...t, [name]: true }));

  const onSubmit = (): void => {
    if (!validation.ok || justificationTooShort) {
      setRevealErrors(true);
      const allTouched: Record<string, boolean> = { justification: true };
      for (const p of op.params) allTouched[p.name] = true;
      setTouched(allTouched);
      requestAnimationFrame(() => errorRef.current?.focus());
      return;
    }
    setSubmitting(true);
    const draft = buildRequestDraft(op, '(new)', values, justification, getCurrentUser().id);
    void api.submitRequest(draft).then((result) => {
      if (result.ok) navigate(`/requests/${result.request.id}`);
      else {
        setSubmitting(false);
        setBlockedReason(result.reason);
      }
    });
  };

  const showJustificationError = (revealErrors || touched['justification']) && justificationTooShort;

  return (
    <div className="rq">
      <Breadcrumbs items={crumbs} />

      <h1 className="rq-title">{op.title}</h1>
      <p className="rq-desc">
        Every parameter below comes from the Terraform provider’s own definition of{' '}
        <code>{op.target.resourceType}</code> — required ones first. Fill in what you know; an
        engineer completes and reviews the Terraform before anything is applied.
      </p>

      <div className="rq-strip">
        <MacdTag macd={op.macd} />
        <RiskBadge risk="HIGH" />
        <span className="rq-strip__fact">New resource</span>
        <AccessBadge exposure={op.exposure} />
      </div>

      <p className="rq-note-engineer">
        This is a new kind of resource for this estate, so it routes to an engineer to author and
        review the Terraform. You still write no code — and nothing applies without approval.
      </p>

      {choices.length > 1 && (
        <p className="rq-desc">
          <button type="button" className="bc-back" onClick={() => setSearchParams({})}>
            ← Choose a different {entry.name} resource type
          </button>
        </p>
      )}

      <div className="rq-main">
        {prefilledFrom && (
          <p className="bc-prefill" role="note">
            Values copied from your earlier request — review them before submitting. The
            justification starts fresh.
          </p>
        )}

        {errorItems.length > 0 && revealErrors && <ErrorSummary ref={errorRef} items={errorItems} />}

        {blockedReason && (
          <p className="rq-field__error" role="alert">
            {blockedReason}
          </p>
        )}

        <SchemaForm
          operationId={op.id}
          sections={sections}
          inventory={NO_INVENTORY}
          values={values}
          errors={validation.errors}
          touched={touched}
          onChange={onChange}
          onBlur={onBlur}
        />

        <div className="rq-field">
          <label className="rq-field__label" htmlFor="field-justification">
            Why is this needed? <span className="rq-field__req">*</span>
          </label>
          <textarea
            id="field-justification"
            className="rq-field__textarea"
            rows={3}
            value={justification}
            aria-invalid={showJustificationError}
            aria-describedby={
              showJustificationError ? 'field-justification-error' : 'field-justification-help'
            }
            onChange={(e) => setJustification(e.target.value)}
            onBlur={() => onBlur('justification')}
          />
          <p id="field-justification-help" className="rq-field__help">
            Recorded on the request — at least 10 characters.
          </p>
          {showJustificationError && (
            <p id="field-justification-error" className="rq-field__error" role="alert">
              {justificationError}
            </p>
          )}
        </div>

        <div className="rq-submitbar">
          <Button variant="primary" disabled={submitting} onClick={onSubmit}>
            {submitting ? 'Submitting…' : 'Submit to an engineer'}
          </Button>
          <Link to="/services/request-new" className="rq-cancel">
            Cancel
          </Link>
        </div>
      </div>
    </div>
  );
}

export default ProvisionService;
