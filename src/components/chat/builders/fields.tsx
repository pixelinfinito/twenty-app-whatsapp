import { useTheme } from 'twenty-ui/theme-constants';

import type { FieldError } from '../../../domain/interactive/validate';
import type { Translate } from '../../common/copy';
import { Glyph, type IconName } from '../../common/icons';

/**
 * The form parts every composer panel shares.
 *
 * They exist because of one requirement the spec is specific about: a rejection
 * must land *under the box that caused it*. That means every input needs to
 * know its own field path, look its error up by that path, and describe itself
 * to a screen reader with `aria-invalid` and `aria-describedby` — five things
 * that would otherwise be retyped for each of about twenty inputs across the
 * builders, and forgotten on at least one of them.
 */

/** Finds the error for a path, if the route sent one. */
export const errorFor = (
  errors: FieldError[],
  field: string,
): FieldError | undefined => errors.find((error) => error.field === field);

export const fieldMessage = (error: FieldError | undefined, t: Translate): string | null =>
  error === undefined
    ? null
    : t(`builder.error.${error.code}`, { limit: error.limit ?? 0 });

export const PanelHeader = ({
  icon,
  title,
  hint,
  onCancel,
  t,
}: {
  icon: IconName;
  title: string;
  hint?: string;
  onCancel: () => void;
  t: Translate;
}) => {
  const theme = useTheme();

  return (
    <header style={{ display: 'flex', flexDirection: 'column', gap: theme.spacing[1] }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: theme.spacing[1] }}>
        <Glyph name={icon} size="md" />
        <h3
          style={{
            margin: 0,
            flex: '1 1 auto',
            fontSize: theme.font.size.md,
            fontWeight: theme.font.weight.semiBold,
            color: theme.font.color.primary,
          }}
        >
          {title}
        </h3>
        <button
          type="button"
          onClick={onCancel}
          aria-label={t('common.cancel')}
          title={t('common.cancel')}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            minWidth: '32px',
            minHeight: '32px',
            border: 'none',
            borderRadius: theme.border.radius.sm,
            background: 'transparent',
            color: theme.font.color.secondary,
            cursor: 'pointer',
          }}
        >
          <Glyph name="dismiss" />
        </button>
      </div>
      {hint === undefined ? null : (
        <p style={{ margin: 0, fontSize: theme.font.size.xs, color: theme.font.color.secondary }}>
          {hint}
        </p>
      )}
    </header>
  );
};

export type TextFieldProps = {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  t: Translate;
  error?: FieldError | undefined;
  maxLength?: number;
  rows?: number;
  placeholder?: string;
  /** Shown quietly on the right of the label — a character or row count. */
  counter?: string;
  inputMode?: 'text' | 'decimal' | 'tel' | 'url';
  disabled?: boolean;
};

export const TextField = ({
  id,
  label,
  value,
  onChange,
  t,
  error,
  maxLength,
  rows,
  placeholder,
  counter,
  inputMode = 'text',
  disabled = false,
}: TextFieldProps) => {
  const theme = useTheme();
  const message = fieldMessage(error, t);
  const describedBy = message === null ? undefined : `${id}-error`;

  const control: React.CSSProperties = {
    width: '100%',
    boxSizing: 'border-box',
    minHeight: '32px',
    resize: rows === undefined ? undefined : 'none',
    border: `1px solid ${
      message === null ? theme.border.color.medium : theme.border.color.danger
    }`,
    borderRadius: theme.border.radius.sm,
    background: theme.background.secondary,
    color: theme.font.color.primary,
    fontFamily: theme.font.family,
    fontSize: theme.font.size.sm,
    padding: `${theme.spacing[1]} ${theme.spacing[1]}`,
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: theme.spacing[0.5] }}>
      <label
        htmlFor={id}
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: theme.spacing[1],
          fontSize: theme.font.size.xs,
          color: theme.font.color.secondary,
        }}
      >
        <span style={{ flex: '1 1 auto' }}>{label}</span>
        {counter === undefined ? null : (
          <span style={{ color: theme.font.color.secondary }}>{counter}</span>
        )}
      </label>

      {rows === undefined ? (
        <input
          id={id}
          disabled={disabled}
          type="text"
          inputMode={inputMode}
          value={value}
          maxLength={maxLength}
          placeholder={placeholder}
          aria-invalid={message === null ? undefined : true}
          aria-describedby={describedBy}
          onChange={(event) => onChange(event.target.value)}
          style={control}
        />
      ) : (
        <textarea
          id={id}
          disabled={disabled}
          rows={rows}
          value={value}
          maxLength={maxLength}
          placeholder={placeholder}
          aria-invalid={message === null ? undefined : true}
          aria-describedby={describedBy}
          onChange={(event) => onChange(event.target.value)}
          style={control}
        />
      )}

      {message === null ? null : (
        <span
          id={describedBy}
          role="alert"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: theme.spacing[1],
            fontSize: theme.font.size.xs,
            color: theme.font.color.danger,
          }}
        >
          <Glyph name="warning" />
          {message}
        </span>
      )}
    </div>
  );
};

/** The Cancel / primary pair every panel ends with, at one size and one order. */
export const PanelFooter = ({
  submitLabel,
  submitIcon = 'send',
  busy = false,
  onCancel,
  onSubmit,
  disabled,
  t,
}: {
  submitLabel: string;
  submitIcon?: IconName;
  busy?: boolean;
  onCancel: () => void;
  onSubmit: () => void;
  disabled: boolean;
  t: Translate;
}) => {
  const theme = useTheme();

  const base: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: theme.spacing[1],
    minHeight: '32px',
    borderRadius: theme.border.radius.sm,
    cursor: 'pointer',
    fontFamily: theme.font.family,
    fontSize: theme.font.size.sm,
    padding: `0 ${theme.spacing[2]}`,
  };

  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'flex-end',
        gap: theme.spacing[2],
        flexWrap: 'wrap',
      }}
    >
      <button
        type="button"
        onClick={onCancel}
        disabled={busy}
        style={{
          ...base,
          border: `1px solid ${theme.border.color.medium}`,
          background: 'transparent',
          color: theme.font.color.secondary,
        }}
      >
        {t('common.cancel')}
      </button>
      <button
        type="button"
        onClick={onSubmit}
        disabled={disabled}
        style={{
          ...base,
          border: '1px solid transparent',
          background: disabled ? theme.background.transparent.light : theme.color.blue,
          color: disabled ? theme.font.color.secondary : theme.font.color.inverted,
          cursor: disabled ? 'default' : 'pointer',
        }}
      >
        <Glyph name={submitIcon} size="md" />
        {busy ? t('chat.sending') : submitLabel}
      </button>
    </div>
  );
};

/**
 * A small square control — add, remove, move up, move down.
 *
 * 32 px like everything else a rep presses. Reordering is these buttons and not
 * a drag handle because Twenty's sandbox drops drag `dataTransfer` payloads, so
 * a drag-only list is one that cannot be reordered at all and fails silently.
 */
export const IconButton = ({
  icon,
  label,
  onClick,
  disabled = false,
  tone = 'quiet',
}: {
  icon: IconName;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  tone?: 'quiet' | 'danger';
}) => {
  const theme = useTheme();

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flex: '0 0 auto',
        minWidth: '32px',
        minHeight: '32px',
        border: `1px solid ${theme.border.color.light}`,
        borderRadius: theme.border.radius.sm,
        background: 'transparent',
        color: disabled
          ? theme.font.color.secondary
          : tone === 'danger'
            ? theme.font.color.danger
            : theme.font.color.secondary,
        cursor: disabled ? 'default' : 'pointer',
        padding: 0,
      }}
    >
      <Glyph name={icon} />
    </button>
  );
};
