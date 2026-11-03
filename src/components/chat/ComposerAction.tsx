import { useId, useState } from 'react';

import { Glyph, type IconName } from '../common/icons';

/** Inline tooltips work in the host sandbox without a portal or focus trap. */
export const ComposerAction = ({
  icon,
  label,
  onClick,
  disabled = false,
  primary = false,
  expanded,
  busy = false,
  align = 'start',
}: {
  icon: IconName;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  primary?: boolean;
  expanded?: boolean;
  busy?: boolean;
  align?: 'start' | 'end';
}) => {
  const tooltipId = useId();
  const [dismissed, setDismissed] = useState(false);
  return (
    <span
      className="wa-composer-action"
      data-tooltip-dismissed={dismissed}
      onMouseEnter={() => setDismissed(false)}
      onFocus={() => setDismissed(false)}
      onKeyDown={(event) => {
        if (event.key === 'Escape') setDismissed(true);
      }}
    >
      <button
        className="wa-composer-icon"
        data-primary={primary}
        type="button"
        aria-label={label}
        aria-describedby={tooltipId}
        aria-expanded={expanded}
        aria-busy={busy || undefined}
        disabled={disabled}
        onClick={onClick}
      >
        <Glyph name={busy ? 'pending' : icon} size="md" />
      </button>
      <span id={tooltipId} role="tooltip" className="wa-composer-tooltip" data-align={align}>
        {label}
      </span>
    </span>
  );
};
