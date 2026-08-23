import type { CSSProperties, ReactNode } from 'react';

type GlassRadioValue = string | number;

export type GlassRadioOption<T extends GlassRadioValue> = {
  value: T;
  label: ReactNode;
};

interface GlassRadioGroupProps<T extends GlassRadioValue> {
  ariaLabel: string;
  className?: string;
  disabled?: boolean;
  idPrefix: string;
  name: string;
  onChange: (value: T) => void;
  options: readonly GlassRadioOption<T>[];
  value: T;
}

/**
 * Adapted from the Uiverse glass-radio-group markup so every setting retains
 * the source component's sliding-glider interaction while remaining a native,
 * keyboard-accessible radio group.
 */
export function GlassRadioGroup<T extends GlassRadioValue>({
  ariaLabel,
  className = '',
  disabled = false,
  idPrefix,
  name,
  onChange,
  options,
  value,
}: GlassRadioGroupProps<T>) {
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === value));
  const style = {
    '--glass-option-count': options.length,
    '--glass-selected-index': selectedIndex,
  } as CSSProperties;

  return (
    <div className={`glass-radio-group ${className}`.trim()} role="radiogroup" aria-label={ariaLabel} style={style}>
      {options.map((option, index) => {
        const inputId = `${idPrefix}-${index}`;
        return (
          <span className="glass-radio-option" key={String(option.value)}>
            <input
              checked={option.value === value}
              disabled={disabled}
              id={inputId}
              name={name}
              onChange={() => onChange(option.value)}
              type="radio"
              value={String(option.value)}
            />
            <label htmlFor={inputId}>{option.label}</label>
          </span>
        );
      })}
      <span className="glass-glider" aria-hidden="true" />
    </div>
  );
}
