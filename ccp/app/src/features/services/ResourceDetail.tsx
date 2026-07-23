import { useEffect, useMemo, useRef, useState } from 'react';
import type { JSX, KeyboardEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type {
  Inventory,
  InventoryResource,
  ManifestOperation,
  Schedule,
  ServiceManifest,
} from '@/types';
import { api } from '@/lib/api';
import { useActiveProjectId } from '@/lib/ProjectContext';
import { isChangeFrozen, isOpDisabled, useSettings } from '@/lib/settings';
import { getServiceMeta } from '@/lib/serviceMeta';
import { resolveRisk } from '@/lib/riskOverrides';
import { actionHref, isResourceScopedAdd, isScopedAction } from '@/lib/actionPicker';
import { allBlockSources, getBlockSource, type BlockSource } from '@/lib/blockSource';
import { buildResourceFamilies, groupChildren, type ChildGroup } from '@/lib/resourceFamily';
import { displayResourceLabel, resourceChips } from '@/lib/chipLabel';
import { cartRequirement, cartToChangeSet, requirementSummary } from '@/lib/changeSet';
import {
  buildResourceSections,
  currentControlValue,
  displayCurrent,
  type Capability,
  type DetailTab,
} from '@/lib/resourceDetail';
import {
  applyChoice,
  cartHasRebuild,
  editLine,
  removeEdit,
  type PendingEdit,
} from '@/lib/resourceEdits';
import { ReplaceConfirmGate, replaceConfirmMet } from '@/features/request/ReplaceConfirmGate';
import { SchedulePicker } from '@/features/request/SchedulePicker';
import { Breadcrumbs } from '@/components/Breadcrumbs';
import { Badge } from '@/components/ui/Badge';
import { RiskBadge } from '@/components/ui/RiskBadge';
import { MacdTag } from '@/components/ui/MacdTag';
import { AccessBadge } from '@/components/ui/AccessBadge';
import { Button } from '@/components/ui/Button';
import './resource-detail.css';

const MIN_JUSTIFICATION = 10;

/**
 * The resource detail page — every Terraform-managed capability of ONE inventory
 * resource, GENERATED from the catalog (lib/resourceDetail.ts groups the ops
 * targeting the resource's type into console-style tabs) and FILLED with the
 * resource's CURRENT values from the inventory. Read-only inventory facts show
 * as "context"; editable scalar ops show inline controls pre-filled with the
 * current value; forcesReplace ops are flagged "rebuilds". Inline edits across
 * any tab collect into one client-side pending-changes cart.
 *
 * Split in two, the same way ResourceRow (presentational) sits under the console
 * (data): ResourceDetail loads the manifest + inventory and resolves the
 * resource; ResourceDetailView is the pure-props render (so it is SSR-testable
 * without mocking the api — see resourceDetail.test.ts).
 */

/** Href to a capability's dedicated request form — pre-targeted to this resource
 * for the ops that operate ON it (Change/Delete/Move + resource-scoped Adds); a
 * provision create that merely shares the type is linked un-targeted. */
function opHref(serviceSlug: string, op: ManifestOperation, resource: InventoryResource): string {
  if (isScopedAction(op) || isResourceScopedAdd(op)) return actionHref(serviceSlug, op, resource);
  return `/services/${serviceSlug}/${op.id}`;
}

interface InlineControlProps {
  cap: Capability;
  value: string;
  onChange: (value: string) => void;
}

/** The inline editor for one editable capability, rendered from its ControlSpec:
 * a select (bounded allowlist), a Yes/No toggle-select (boolean), a stepped
 * number, or a text input. Pre-filled by the caller with the current value. */
function InlineControl({ cap, value, onChange }: InlineControlProps): JSX.Element {
  const control = cap.control!;
  const fieldId = `cap-${cap.op.id}`;
  const label = cap.valueParam?.label ?? 'New value';
  if (control.kind === 'select' || control.kind === 'toggle') {
    const options = control.options ?? [];
    const current = currentControlValue(cap);
    return (
      <select
        id={fieldId}
        className="rd-control rd-control--select"
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {/* When the current value isn't one of the bounded choices (or isn't in
            the snapshot), an unselectable placeholder keeps the control honest
            rather than silently defaulting to the first option. */}
        {(value === '' || !options.includes(current)) && (
          <option value="" disabled>
            Choose…
          </option>
        )}
        {options.map((opt) => (
          <option key={opt} value={opt}>
            {control.kind === 'toggle'
              ? opt === 'true'
                ? 'Yes'
                : opt === 'false'
                  ? 'No'
                  : opt
              : opt}
          </option>
        ))}
      </select>
    );
  }
  if (control.kind === 'number') {
    return (
      <input
        id={fieldId}
        type="number"
        className="rd-control rd-control--number"
        aria-label={label}
        value={value}
        min={control.min}
        max={control.max}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }
  return (
    <input
      id={fieldId}
      type="text"
      className="rd-control rd-control--text"
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

interface CapabilityCardProps {
  cap: Capability;
  serviceSlug: string;
  resource: InventoryResource;
  value: string;
  inCart: boolean;
  onChange: (value: string) => void;
}

/** One capability: its headline + badges (MACD, risk, exposure, "rebuilds"), the
 * technical detail beneath, and either an inline control (editable) pre-filled
 * with the current value, or an "Open request" link (actions). */
function CapabilityCard({
  cap,
  serviceSlug,
  resource,
  value,
  inCart,
  onChange,
}: CapabilityCardProps): JSX.Element {
  return (
    <div className={inCart ? 'rd-cap rd-cap--pending' : 'rd-cap'}>
      <div className="rd-cap__head">
        <MacdTag macd={cap.macd} />
        <span className="rd-cap__headline">{cap.headline}</span>
        <span className="rd-cap__badges">
          {cap.forcesReplace && (
            <Badge
              color="crit"
              title="Applying this destroys and recreates the resource — new id and a brief outage."
            >
              Rebuilds
            </Badge>
          )}
          <RiskBadge risk={resolveRisk(cap.op)} />
          <AccessBadge exposure={cap.exposure} />
          {inCart && <Badge color="brass">In changes</Badge>}
        </span>
      </div>

      {(cap.summary !== undefined || cap.technicalDetail !== undefined) && (
        <details className="rd-cap__tech">
          <summary className="rd-cap__tech-label">What this does</summary>
          {cap.summary !== undefined && <span className="rd-cap__tech-body">{cap.summary}</span>}
          {cap.technicalDetail !== undefined && (
            <span className="rd-cap__tech-detail">{cap.technicalDetail}</span>
          )}
        </details>
      )}

      {cap.editable ? (
        <div className="rd-cap__edit">
          <div className="rd-cap__current">
            <span className="rd-cap__current-label">Current</span>
            <span className="rd-cap__current-value">{displayCurrent(cap)}</span>
          </div>
          <span className="rd-cap__arrow" aria-hidden="true">
            →
          </span>
          <InlineControl cap={cap} value={value} onChange={onChange} />
        </div>
      ) : (
        <div className="rd-cap__action">
          <Link className="rd-cap__open" to={opHref(serviceSlug, cap.op, resource)}>
            Open request →
          </Link>
        </div>
      )}
    </div>
  );
}

export interface ResourceDetailViewProps {
  serviceSlug: string;
  resource: InventoryResource;
  /** Every op targeting this resource's type, already admin-filtered. */
  ops: ManifestOperation[];
  /**
   * The config entries Terraform manages as separate resources but that belong
   * to THIS one (bucket policy, encryption, versioning…), grouped per type —
   * rendered as sections below the capability tabs. Optional: pages without
   * rollups render exactly as before.
   */
  attachedConfig?: ChildGroup[];
  /** When THIS resource is itself a config entry of another one: the resource
   * it belongs to, for the "Part of …" line in the summary strip. */
  parentResource?: InventoryResource;
}

/**
 * The pure-props render of the page: builds the sections from (resource, ops),
 * holds the tab + inline-edit + cart state, and renders the summary strip, the
 * tabbed capabilities, and the pending-changes cart. No api, so it renders fully
 * under renderToStaticMarkup for tests.
 */
export function ResourceDetailView({
  serviceSlug,
  resource,
  ops,
  attachedConfig,
  parentResource,
}: ResourceDetailViewProps): JSX.Element {
  const meta = getServiceMeta(serviceSlug);
  const sections = useMemo(() => buildResourceSections(resource, ops), [resource, ops]);

  const editableCaps = useMemo(
    () => sections.tabs.flatMap((t) => t.capabilities).filter((c) => c.editable),
    [sections],
  );

  const [activeTab, setActiveTab] = useState<string>('details');
  const [values, setValues] = useState<Record<string, string>>({});
  const [cart, setCart] = useState<PendingEdit[]>([]);
  const [reviewing, setReviewing] = useState(false);

  // The forces-replace op currently in the cart (if any) — its manifest op drives the shared
  // destroy+recreate confirmation gate. Every cart edit targets THIS one resource, so a
  // single gate (bound to resource.address) covers whichever rebuild edits are present.
  const cartReplaceOp = useMemo(
    () => editableCaps.find((c) => c.forcesReplace && cart.some((e) => e.opId === c.op.id))?.op,
    [editableCaps, cart],
  );

  // Seed the controls with each editable capability's current value, and reset
  // the cart, whenever the resource changes (a navigation to another resource
  // reuses this component instance).
  useEffect(() => {
    const seed: Record<string, string> = {};
    for (const cap of editableCaps) seed[cap.op.id] = currentControlValue(cap);
    setValues(seed);
    setCart([]);
    setReviewing(false);
    setActiveTab('details');
  }, [resource.address, editableCaps]);

  const onControlChange = (cap: Capability, next: string): void => {
    setValues((v) => ({ ...v, [cap.op.id]: next }));
    setCart((c) => applyChoice(c, cap, resource.address, next));
  };

  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const onTabKeyDown = (e: KeyboardEvent<HTMLButtonElement>): void => {
    const ids = sections.tabs.map((t) => t.id);
    const i = ids.indexOf(activeTab);
    let j = i;
    if (e.key === 'ArrowRight') j = (i + 1) % ids.length;
    else if (e.key === 'ArrowLeft') j = (i - 1 + ids.length) % ids.length;
    else if (e.key === 'Home') j = 0;
    else if (e.key === 'End') j = ids.length - 1;
    else return;
    e.preventDefault();
    const id = ids[j]!;
    setActiveTab(id);
    tabRefs.current[id]?.focus();
  };

  const crumbs = [
    { label: 'Catalog', to: '/' },
    { label: meta.displayName, to: '/services/' + serviceSlug },
    { label: sections.summary.displayName },
  ];

  const s = sections.summary;

  return (
    <div className="rd">
      <Breadcrumbs items={crumbs} />

      {/* Summary strip — id, type, and the resource's most identifying facts. */}
      <header className="rd-summary">
        <div className="rd-summary__head">
          <h1 className="rd-summary__name">{s.displayName}</h1>
          <span className="rd-summary__type" title={s.rawType}>
            {s.resourceType}
          </span>
        </div>
        <code className="rd-summary__addr">{s.address}</code>
        {parentResource && (
          <p className="rd-summary__parent">
            Part of{' '}
            <Link
              className="rd-summary__parent-link"
              to={`/services/${serviceSlug}/resources/${encodeURIComponent(parentResource.address)}`}
            >
              {displayResourceLabel(parentResource)}
            </Link>{' '}
            — this entry configures it.
          </p>
        )}
        {s.facts.length > 0 && (
          <dl className="rd-summary__facts">
            {s.facts.map((f) => (
              <div className="rd-summary__fact" key={f.attr}>
                <dt className="rd-summary__fact-k">{f.label}</dt>
                <dd className="rd-summary__fact-v" title={f.full}>
                  {f.value}
                </dd>
              </div>
            ))}
          </dl>
        )}
        <p className="rd-summary__count">
          {sections.capabilityCount.toLocaleString()} managed{' '}
          {sections.capabilityCount === 1 ? 'capability' : 'capabilities'} ·{' '}
          {sections.editableCount.toLocaleString()} editable here
        </p>
      </header>

      <div className="rd-body">
        <div className="rd-main">
          {/* Console-style tabs — a read-only Details tab, then one per catalog
              group present for this resource type. */}
          <div className="rd-tabs" role="tablist" aria-label="Resource sections">
            {sections.tabs.map((tab) => {
              const selected = tab.id === activeTab;
              const count =
                tab.kind === 'capabilities' ? tab.capabilities.length : tab.contextRows.length;
              return (
                <button
                  key={tab.id}
                  ref={(el) => {
                    tabRefs.current[tab.id] = el;
                  }}
                  type="button"
                  role="tab"
                  id={`rd-tab-${tab.id}`}
                  aria-selected={selected}
                  aria-controls={`rd-panel-${tab.id}`}
                  tabIndex={selected ? 0 : -1}
                  className={selected ? 'rd-tab rd-tab--active' : 'rd-tab'}
                  onClick={() => setActiveTab(tab.id)}
                  onKeyDown={onTabKeyDown}
                >
                  {tab.label}
                  <span className="rd-tab__count">{count}</span>
                </button>
              );
            })}
          </div>

          {sections.tabs.map((tab) => (
            <section
              key={tab.id}
              role="tabpanel"
              id={`rd-panel-${tab.id}`}
              aria-labelledby={`rd-tab-${tab.id}`}
              hidden={tab.id !== activeTab}
              className="rd-panel"
            >
              {tab.kind === 'context' ? (
                <ContextPanel tab={tab} resource={resource} />
              ) : tab.capabilities.length === 0 ? (
                <p className="rd-empty">Nothing here for this resource.</p>
              ) : (
                tab.capabilities.map((cap) => (
                  <CapabilityCard
                    key={cap.op.id}
                    cap={cap}
                    serviceSlug={serviceSlug}
                    resource={resource}
                    value={values[cap.op.id] ?? currentControlValue(cap)}
                    inCart={cart.some((e) => e.opId === cap.op.id)}
                    onChange={(next) => onControlChange(cap, next)}
                  />
                ))
              )}
            </section>
          ))}

          {attachedConfig !== undefined && attachedConfig.length > 0 && (
            <AttachedConfigSection serviceSlug={serviceSlug} groups={attachedConfig} />
          )}
        </div>

        {/* Pending-changes cart — spans every tab. */}
        <aside className="rd-cart" aria-label="Pending changes">
          <h2 className="rd-cart__title">
            Pending changes
            <span className="rd-cart__count" aria-live="polite">
              {cart.length}
            </span>
          </h2>

          {cart.length === 0 ? (
            <p className="rd-cart__empty">
              Change any control above and it collects here — review them as one request.
            </p>
          ) : (
            <>
              <ul className="rd-cart__list">
                {cart.map((edit) => (
                  <li className="rd-cart__item" key={edit.opId}>
                    <div className="rd-cart__item-head">
                      <span className="rd-cart__item-title">{edit.opHeadline}</span>
                      {edit.forcesReplace && (
                        <Badge color="crit" title="Rebuilds the resource on apply.">
                          Rebuilds
                        </Badge>
                      )}
                    </div>
                    <div className="rd-cart__item-line">{editLine(edit)}</div>
                    <button
                      type="button"
                      className="rd-cart__remove"
                      onClick={() => setCart((c) => removeEdit(c, edit.opId))}
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>

              {cartHasRebuild(cart) && (
                <p className="rd-cart__warn" role="note">
                  Some changes rebuild the resource — a new id and a brief outage on apply.
                </p>
              )}

              <Button variant="primary" onClick={() => setReviewing((r) => !r)}>
                Review &amp; submit {cart.length} {cart.length === 1 ? 'change' : 'changes'} as one
                request
              </Button>

              {reviewing && (
                <ReviewPanel cart={cart} resource={resource} replaceOp={cartReplaceOp} />
              )}
            </>
          )}
        </aside>
      </div>
    </div>
  );
}

/**
 * The config entries that belong to this resource but that Terraform manages
 * as separate resources — one section per type (Versioning, Policy, Server
 * side encryption configuration…), one card per entry, exactly the shreds the
 * service list rolls up into this page. Each card opens the entry's own page,
 * where its current values and any actions live.
 */
function AttachedConfigSection({
  serviceSlug,
  groups,
}: {
  serviceSlug: string;
  groups: ChildGroup[];
}): JSX.Element {
  return (
    <section className="rd-attached" aria-labelledby="rd-attached-title">
      <h2 className="rd-attached__title" id="rd-attached-title">
        Configuration attached to this resource
      </h2>
      <p className="rd-attached__note">
        Terraform tracks each of these as its own entry; on this console they belong here.
      </p>
      {groups.map((group) => (
        <div className="rd-attached__group" key={group.resourceType}>
          <h3 className="rd-attached__group-title">
            {group.label}
            {group.children.length > 1 && (
              <span className="rd-attached__group-count">{group.children.length}</span>
            )}
          </h3>
          {group.children.map((child) => {
            const chips = resourceChips(child);
            return (
              <Link
                key={child.address}
                className="rd-attached__card"
                to={`/services/${serviceSlug}/resources/${encodeURIComponent(child.address)}`}
              >
                <span className="rd-attached__card-body">
                  <span className="rd-attached__card-name">{displayResourceLabel(child)}</span>
                  <code className="rd-attached__card-addr">{child.address}</code>
                  {chips.length > 0 && (
                    <span className="rd-attached__card-chips">
                      {chips.map((chip) => (
                        <span className="rd-attached__chip" key={chip.attr} title={chip.full}>
                          <span className="rd-attached__chip-k">{chip.label}</span>{' '}
                          <span className="rd-attached__chip-v">{chip.value}</span>
                        </span>
                      ))}
                    </span>
                  )}
                </span>
                <span className="rd-attached__card-open" aria-hidden="true">
                  Open →
                </span>
              </Link>
            );
          })}
        </div>
      ))}
    </section>
  );
}

/** The read-only Details tab: every context fact plus the resource's full,
 * already-redacted Terraform source (loaded on demand from the block chunks). */
function ContextPanel({
  tab,
  resource,
}: {
  tab: DetailTab;
  resource: InventoryResource;
}): JSX.Element {
  const [source, setSource] = useState<BlockSource | null>(null);
  const [loading, setLoading] = useState(false);
  const [tried, setTried] = useState(false);
  const loadSource = (): void => {
    setLoading(true);
    void getBlockSource(resource.address).then((b) => {
      setSource(b);
      setLoading(false);
      setTried(true);
    });
  };
  return (
    <>
      {tab.contextRows.length === 0 ? (
        <p className="rd-empty">No captured attributes for this resource in the baseline.</p>
      ) : (
        <dl className="rd-facts">
          {tab.contextRows.map((row) => (
            <div className="rd-fact" key={row.attr}>
              <dt className="rd-fact__k">{row.label}</dt>
              <dd className="rd-fact__v" title={row.full}>
                {row.value}
              </dd>
            </div>
          ))}
        </dl>
      )}

      <details
        className="rd-source"
        onToggle={(e) => e.currentTarget.open && !tried && loadSource()}
      >
        <summary className="rd-source__summary">Terraform source (current)</summary>
        {loading && <p className="rd-source__note">Loading…</p>}
        {tried && source === null && (
          <p className="rd-source__note">
            No committed block for this address — it may be newer than the last baseline.
          </p>
        )}
        {source !== null && (
          <>
            <p className="rd-source__meta">
              {source.file}:{source.line}
            </p>
            <pre className="rd-source__code">{source.source}</pre>
          </>
        )}
      </details>
    </>
  );
}

/**
 * Phase-B review of the pending cart: submit ALL edits on this resource as ONE change set —
 * one reviewed change (one PR, one approval, applied together), NOT N separate single-op
 * requests. It carries one shared justification + schedule, shows the STRICTEST-combined
 * review requirement across the edits, and — when any edit rebuilds the resource — gates on
 * the SAME typed destroy+recreate confirmation the single-op form uses (bound to this
 * resource's address; the server re-checks it per item). The api re-validates every edit
 * atomically and rejects the whole set if any fails, so nothing here can weaken a gate.
 */
function ReviewPanel({
  cart,
  resource,
  replaceOp,
}: {
  cart: PendingEdit[];
  resource: InventoryResource;
  replaceOp?: ManifestOperation;
}): JSX.Element {
  const navigate = useNavigate();
  const [justification, setJustification] = useState('');
  const [schedule, setSchedule] = useState<Schedule>({ kind: 'now' });
  const [replaceConfirmation, setReplaceConfirmation] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [blocked, setBlocked] = useState<string | null>(null);

  const requirement = cartRequirement(cart);
  const justificationOk = justification.trim().length >= MIN_JUSTIFICATION;
  // A cart edit that rebuilds needs the typed confirmation — bound to THIS resource's
  // address, the same value the server + executor compare per item.
  const replaceOk = replaceOp
    ? replaceConfirmMet(replaceOp, resource.address, replaceConfirmation)
    : true;
  const canSubmit = cart.length > 0 && justificationOk && replaceOk && !submitting;

  const onSubmit = (): void => {
    // Live admin gates re-checked at submit; the server re-enforces both, atomically.
    if (isChangeFrozen()) {
      setBlocked(
        'Change requests are frozen by an administrator right now. Try again once the freeze is lifted.',
      );
      return;
    }
    if (cart.some((e) => isOpDisabled(e.opId))) {
      setBlocked('One of these changes uses an operation an administrator has disabled.');
      return;
    }
    setSubmitting(true);
    const draft = cartToChangeSet(
      cart,
      justification.trim(),
      schedule,
      replaceOp ? replaceConfirmation.trim() : undefined,
    );
    void api.submitChangeSet(draft).then((result) => {
      if (result.ok) navigate('/requests/' + result.request.id);
      else {
        setSubmitting(false);
        setBlocked(result.reason);
      }
    });
  };

  return (
    <div className="rd-review">
      <p className="rd-review__lead">
        These {cart.length} {cart.length === 1 ? 'change' : 'changes'} submit as ONE request — one
        PR, one approval, applied together.
      </p>
      <ul className="rd-review__list">
        {cart.map((edit) => (
          <li className="rd-review__item" key={edit.opId}>
            <span className="rd-review__op">{edit.opHeadline}</span>
            <span className="rd-review__line">{editLine(edit)}</span>
            {edit.forcesReplace && (
              <Badge color="crit" title="Rebuilds the resource on apply.">
                Rebuilds
              </Badge>
            )}
          </li>
        ))}
      </ul>

      <p className="rd-review__req" role="note">
        {requirementSummary(requirement)} · applies to <code>{resource.address}</code>
      </p>

      {replaceOp && (
        <ReplaceConfirmGate
          op={replaceOp}
          targetAddress={resource.address}
          value={replaceConfirmation}
          onChange={setReplaceConfirmation}
        />
      )}

      <div className="rd-review__field">
        <label className="rd-review__label" htmlFor="rd-justification">
          Why is this change needed? <span className="rd-review__req-mark">*</span>
        </label>
        <textarea
          id="rd-justification"
          className="rd-review__textarea"
          rows={3}
          value={justification}
          onChange={(e) => setJustification(e.target.value)}
        />
        <p className="rd-review__help">
          Recorded on the request and in the PR — at least 10 characters.
        </p>
      </div>

      <SchedulePicker value={schedule} onChange={setSchedule} />

      {blocked && (
        <p className="rd-review__error" role="alert">
          {blocked}
        </p>
      )}

      <div className="rd-review__actions">
        <Button variant="primary" disabled={!canSubmit} onClick={onSubmit}>
          {submitting
            ? 'Submitting…'
            : `Submit ${cart.length} ${cart.length === 1 ? 'change' : 'changes'} as one request`}
        </Button>
      </div>
    </div>
  );
}

interface RouteState {
  status: 'loading' | 'no-service' | 'no-resource' | 'ready';
  serviceSlug: string;
  resource?: InventoryResource;
  ops: ManifestOperation[];
  /** This resource's rolled-up config entries, grouped per type. */
  attachedConfig?: ChildGroup[];
  /** The resource this one configures, when it is itself a config entry. */
  parentResource?: InventoryResource;
}

/**
 * Route element for `/services/:service/resources/:resourceId`: loads the
 * manifest + inventory, resolves the resource by its (url-encoded) address, and
 * gathers every op targeting its type (admin-disabled ops filtered out, live via
 * settings). Then hands pure props to ResourceDetailView.
 */
export function ResourceDetail(): JSX.Element {
  const { service, resourceId } = useParams<{ service: string; resourceId: string }>();
  const serviceSlug = service ?? '';
  const address = resourceId ? decodeURIComponent(resourceId) : '';

  const [manifests, setManifests] = useState<ServiceManifest[] | null>(null);
  const [inventory, setInventory] = useState<Inventory | null>(null);
  // The committed HCL corpus, for the parent/child rollup (same join evidence
  // the service list uses). A load failure degrades to "no rollup shown" —
  // the page's own capabilities never depend on it.
  const [blocks, setBlocks] = useState<Record<string, BlockSource> | null>(null);
  const settings = useSettings();
  const projectId = useActiveProjectId();

  useEffect(() => {
    let alive = true;
    void Promise.all([
      api.listManifests(),
      api.getInventory(),
      allBlockSources().catch((): Record<string, BlockSource> => ({})),
    ]).then(([m, inv, b]) => {
      if (!alive) return;
      setManifests(m);
      setInventory(inv);
      setBlocks(b);
    });
    return () => {
      alive = false;
    };
  }, [projectId]);

  const state = useMemo<RouteState>(() => {
    if (!manifests || !inventory || !blocks) return { status: 'loading', serviceSlug, ops: [] };
    const manifest = manifests.find((m) => m.service === serviceSlug);
    if (!manifest) return { status: 'no-service', serviceSlug, ops: [] };
    const resource = inventory.resources.find((r) => r.address === address);
    if (!resource) return { status: 'no-resource', serviceSlug, ops: [] };
    const ops = manifest.operations.filter(
      (op) => op.target.resourceType === resource.resourceType && !isOpDisabled(op.id),
    );
    const families = buildResourceFamilies(manifest.resourceTypes, inventory.resources, blocks);
    const attachedConfig = groupChildren(
      families.childrenOf.get(resource.address) ?? [],
      resource.resourceType,
    );
    const parentResource = families.parentOf.get(resource.address);
    return { status: 'ready', serviceSlug, resource, ops, attachedConfig, parentResource };
    // `settings` is a memo dep (not read directly — isOpDisabled reads the same
    // cache) so an admin disable/enable elsewhere re-derives `ops` live, the same
    // pattern as the console's actionsFor memo.
  }, [manifests, inventory, blocks, serviceSlug, address, settings]);

  const meta = getServiceMeta(serviceSlug);

  if (state.status === 'loading') {
    return (
      <div className="rd">
        <Breadcrumbs items={[{ label: 'Catalog', to: '/' }, { label: meta.displayName }]} />
        <div className="rd-loading">Loading resource…</div>
      </div>
    );
  }

  if (state.status === 'no-service') {
    return (
      <div className="rd">
        <Breadcrumbs items={[{ label: 'Catalog', to: '/' }, { label: serviceSlug }]} />
        <div className="rd-empty">No service named “{serviceSlug}”.</div>
      </div>
    );
  }

  if (state.status === 'no-resource') {
    return (
      <div className="rd">
        <Breadcrumbs
          items={[
            { label: 'Catalog', to: '/' },
            { label: meta.displayName, to: '/services/' + serviceSlug },
            { label: 'Not found' },
          ]}
        />
        <div className="rd-notfound">
          <h1 className="rd-notfound__title">No such resource</h1>
          <p>
            Nothing in the baseline has the address <code>{address}</code>.
          </p>
          <Link to={'/services/' + serviceSlug} className="rd-back">
            Back to {meta.displayName}
          </Link>
        </div>
      </div>
    );
  }

  return (
    <ResourceDetailView
      serviceSlug={serviceSlug}
      resource={state.resource!}
      ops={state.ops}
      attachedConfig={state.attachedConfig}
      parentResource={state.parentResource}
    />
  );
}

export default ResourceDetail;
