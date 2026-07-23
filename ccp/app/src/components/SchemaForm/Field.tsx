import type { JSX } from 'react';
import type { Inventory, ManifestParam } from '@/types';
import { resolveEnum } from '@/lib/interpreter';
import { isInventoryListParam } from '@/lib/inventoryPicker';
import { isSensitiveParam } from '@/lib/secrets';
import { BoundsHint, boundsHintText } from './BoundsHint';
import { InventoryPicker } from './InventoryPicker';

export interface FieldProps {
  param: ManifestParam;
  value: unknown;
  error?: string;
  touched?: boolean;
  /** Pre-resolved options for allowlist/inventory sources (falls back to resolveEnum). */
  options?: string[];
  inventory: Inventory;
  onChange: (name: string, value: unknown) => void;
  onBlur: (name: string) => void;
}

function asText(value: unknown): string {
  return value === undefined || value === null ? '' : String(value);
}

/** Segmented threshold: allowlists this size or smaller show every option at once. */
const RADIO_MAX = 7;

/**
 * Renders one manifest parameter as a bounded control, chosen deterministically
 * by the parameter's source, type and bounds. Errors surface only once the field
 * is both touched and invalid; help and format hints are always persistent.
 */
export function Field({
  param,
  value,
  error,
  touched,
  options,
  inventory,
  onChange,
  onBlur,
}: FieldProps): JSX.Element {
  const id = `field-${param.name}`;
  const labelId = `${id}-label`;
  const helpId = `${id}-help`;
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;

  const showError = Boolean(touched && error);
  const hasHint = boundsHintText(param) !== null;
  const isRadioGroup =
    param.source === 'allowlist' && (options ?? resolveEnum(param, inventory)).length <= RADIO_MAX;

  const describedBy =
    [hasHint ? hintId : null, param.help ? helpId : null, showError ? errorId : null]
      .filter(Boolean)
      .join(' ') || undefined;

  const aria = {
    'aria-invalid': showError,
    'aria-describedby': describedBy,
    'aria-required': param.required || undefined,
  };

  const list = options ?? (param.source === 'allowlist' ? resolveEnum(param, inventory) : []);

  let control: JSX.Element;
  if (isInventoryListParam(param)) {
    // A LIST param whose options come from the inventory renders
    // the multi-select picker (bounded by minItems/maxItems), regardless of
    // whether the manifest says source:"inventory" or a legacy user_input
    // that already declared an inventory enum. Before this branch existed,
    // these params fell through to a single text input.
    control = (
      <InventoryPicker
        param={param}
        value={value}
        inventory={inventory}
        id={id}
        labelId={labelId}
        invalid={showError}
        describedBy={describedBy}
        multiple
        onChange={onChange}
        onBlur={onBlur}
      />
    );
  } else if (param.source === 'inventory') {
    control = (
      <InventoryPicker
        param={param}
        value={value}
        inventory={inventory}
        id={id}
        labelId={labelId}
        invalid={showError}
        describedBy={describedBy}
        onChange={onChange}
        onBlur={onBlur}
      />
    );
  } else if (param.source === 'allowlist' && isRadioGroup) {
    control = (
      <div
        className="sf-segmented"
        role="radiogroup"
        aria-labelledby={labelId}
        aria-describedby={describedBy}
        aria-invalid={showError}
      >
        {list.map((o) => {
          const checked = asText(value) === o;
          return (
            <label key={o} className={'sf-segment' + (checked ? ' is-checked' : '')}>
              <input
                type="radio"
                name={id}
                value={o}
                checked={checked}
                aria-required={param.required || undefined}
                onChange={() => onChange(param.name, o)}
                onBlur={() => onBlur(param.name)}
              />
              <span>{o}</span>
            </label>
          );
        })}
      </div>
    );
  } else if (param.source === 'allowlist') {
    control = (
      <select
        {...aria}
        id={id}
        className="sf-input"
        value={asText(value)}
        onChange={(e) => onChange(param.name, e.target.value)}
        onBlur={() => onBlur(param.name)}
      >
        <option value="">— select —</option>
        {list.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    );
  } else if (param.type === 'number') {
    control = (
      <input
        {...aria}
        id={id}
        className="sf-input"
        type="number"
        inputMode="numeric"
        value={asText(value)}
        min={param.bounds?.min}
        max={param.bounds?.max}
        onChange={(e) => onChange(param.name, e.target.value === '' ? '' : Number(e.target.value))}
        onBlur={() => onBlur(param.name)}
      />
    );
  } else if (param.type === 'bool') {
    control = (
      <label className={'sf-toggle' + (value ? ' is-on' : '')}>
        <input
          id={id}
          type="checkbox"
          role="switch"
          className="sf-toggle__input"
          checked={Boolean(value)}
          aria-describedby={describedBy}
          aria-invalid={showError}
          onChange={(e) => onChange(param.name, e.target.checked)}
          onBlur={() => onBlur(param.name)}
        />
        <span className="sf-toggle__track" aria-hidden="true">
          <span className="sf-toggle__thumb" />
        </span>
        <span className="sf-toggle__state">{value ? 'On' : 'Off'}</span>
      </label>
    );
  } else if (param.uiWidget === 'textarea' && !isSensitiveParam(param)) {
    // Multi-line entry — list/map/JSON params from the generated provisioning
    // forms (one value per line, key = value lines, or a JSON structure).
    control = (
      <textarea
        {...aria}
        id={id}
        className="sf-input sf-input--textarea"
        rows={3}
        spellCheck={false}
        value={asText(value)}
        onChange={(e) => onChange(param.name, e.target.value)}
        onBlur={() => onBlur(param.name)}
      />
    );
  } else {
    // Secret-bearing fields are masked on entry and never autofilled.
    const sensitive = isSensitiveParam(param);
    control = (
      <input
        {...aria}
        id={id}
        className="sf-input"
        type={sensitive ? 'password' : 'text'}
        autoComplete={sensitive ? 'new-password' : undefined}
        spellCheck={sensitive ? false : undefined}
        value={asText(value)}
        onChange={(e) => onChange(param.name, e.target.value)}
        onBlur={() => onBlur(param.name)}
      />
    );
  }

  const grouped = param.source === 'inventory' || isInventoryListParam(param) || isRadioGroup;

  return (
    <div className="sf-field">
      <label id={labelId} htmlFor={grouped ? undefined : id} className="sf-label">
        {param.label}
        {param.required ? (
          <span className="sf-req" aria-hidden="true">
            {' '}
            *
          </span>
        ) : (
          <span className="sf-optional"> (optional)</span>
        )}
      </label>
      {control}
      <BoundsHint param={param} id={hintId} />
      {param.help && (
        <p id={helpId} className="sf-help">
          {param.help}
        </p>
      )}
      {showError && (
        <p id={errorId} className="sf-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
