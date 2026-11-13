'use client';

import type { ReactNode } from 'react';

interface FieldFrame {
  /** Also the element id; the error and the help get `${id}-error` and `${id}-help`. */
  id: string;
  label: string;
  help?: string;
  error?: string;
}

/** Ids a control must point at with aria-describedby, and aria-invalid, for a field with help and/or an error. */
function describe({ id, help, error }: Pick<FieldFrame, 'id' | 'help' | 'error'>) {
  const ids = [help ? `${id}-help` : null, error ? `${id}-error` : null].filter(Boolean).join(' ');
  return { 'aria-describedby': ids || undefined, 'aria-invalid': error ? true : undefined };
}

function Frame({ id, label, help, error, children }: FieldFrame & { children: ReactNode }) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children}
      {help && (
        <p id={`${id}-help`} className="help">
          {help}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} className="field-error">
          {error}
        </p>
      )}
    </div>
  );
}

interface TextProps extends FieldFrame {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  inputMode?: 'text' | 'numeric' | 'decimal' | 'email' | 'tel';
  maxLength?: number;
  placeholder?: string;
  autoComplete?: string;
  /** Marked for assistive technology; the form checks it itself (the browser's own check would hide our errors). */
  required?: boolean;
}

/** A labelled text input whose error and help are tied to it. */
export function TextField({ value, onChange, disabled, inputMode, maxLength, placeholder, autoComplete, required, ...frame }: TextProps) {
  return (
    <Frame {...frame}>
      <input
        id={frame.id}
        name={frame.id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        inputMode={inputMode}
        maxLength={maxLength}
        placeholder={placeholder}
        autoComplete={autoComplete ?? 'off'}
        aria-required={required ? true : undefined}
        {...describe(frame)}
      />
    </Frame>
  );
}

interface SelectProps extends FieldFrame {
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
  disabled?: boolean;
}

/** A labelled select whose error and help are tied to it. */
export function SelectField({ value, onChange, options, disabled, ...frame }: SelectProps) {
  return (
    <Frame {...frame}>
      <select id={frame.id} name={frame.id} value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} {...describe(frame)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </Frame>
  );
}
