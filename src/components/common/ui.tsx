import 'twenty-ui/style.css';
import { Children, cloneElement, isValidElement, useId, useRef, type ReactElement } from 'react';
import { Tag } from 'twenty-ui/data-display';
import { Button } from 'twenty-ui/input';
import { useTheme } from 'twenty-ui/theme-constants';

import type { Translate } from './copy';
import { ICON, type IconName } from './icons';

/**
 * The handful of primitives the campaigns and settings surfaces both need.
 *
 * Not a design system — `twenty-ui` is that, and wherever it has the component
 * (`Button`, `Tag`) these are thin wrappers over it, so buttons and statuses
 * are the real Twenty ones at the real Twenty scale. What stays hand-rolled is
 * only what the sandbox forces: no portals, so no popovers; no observers, so no
 * auto-sizing; no `.focus()`, so no focus-trapped modals. What is left is
 * honest inline layout, and it may as well be written once.
 */

export const Card = ({
  title,
  children,
  actions,
}: {
  title?: string;
  children: React.ReactNode;
  actions?: React.ReactNode;
}) => {
  const theme = useTheme();

  return (
    <section
      className="wa-card"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: theme.spacing[2],
        border: `1px solid ${theme.border.color.light}`,
        borderRadius: theme.border.radius.md,
        background: theme.background.secondary,
        padding: theme.spacing[3],
      }}
    >
      {title === undefined && actions === undefined ? null : (
        <header style={{ display: 'flex', alignItems: 'center', gap: theme.spacing[2] }}>
          {title === undefined ? null : (
            <h3
              style={{
                margin: 0,
                fontSize: theme.font.size.md,
                fontWeight: theme.font.weight.semiBold,
                color: theme.font.color.primary,
              }}
            >
              {title}
            </h3>
          )}
          <span style={{ flex: '1 1 auto' }} />
          {actions}
        </header>
      )}
      {children}
    </section>
  );
};

export const Field = ({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  /**
   * Shown in place of the hint, in the danger colour, and announced. A field
   * that can be wrong needs somewhere to say so next to itself — the campaign
   * builder's header-file box was the first, and putting its refusal in the
   * form-level banner would have separated the sentence from the box (D-59).
   */
  error?: string;
  children: React.ReactNode;
}) => {
  const theme = useTheme();
  const generatedId = useId();
  type ControlProps = { id?: string; 'aria-describedby'?: string; 'aria-invalid'?: boolean };
  let foundControl: ReactElement<ControlProps> | undefined;
  Children.forEach(children, (child) => {
    // Remote DOM wraps intrinsic controls in components. Their element type
    // is not the string "input" even when the source uses a native input.
    if (!foundControl && isValidElement(child)) {
      foundControl = child as ReactElement<ControlProps>;
    }
  });
  const control = foundControl;
  const id = control?.props.id ?? `wa-field-${generatedId}`;
  const descriptionId = `${id}-description`;
  const description = error ?? hint;

  /**
   * `sm` label over an `md` control, matching the label-over-input rhythm of
   * Twenty's own settings forms. `xxs` was measured at ~8px in the rendered
   * page — legible to nobody — so nothing interactive or required wears it.
   */
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: theme.spacing[1], minWidth: 0 }}>
      <label
        htmlFor={control ? id : undefined}
        style={{
          fontSize: theme.font.size.sm,
          fontWeight: theme.font.weight.medium,
          color: theme.font.color.secondary,
        }}
      >
        {label}
      </label>
      {control ? Children.map(children, (child) => child === control ? cloneElement(control, {
        id,
        'aria-invalid': error ? true : control.props['aria-invalid'],
        'aria-describedby': [control.props['aria-describedby'], description ? descriptionId : null].filter(Boolean).join(' ') || undefined,
      }) : child) : children}
      {error !== undefined ? (
        <span
          id={descriptionId}
          role="alert"
          style={{ fontSize: theme.font.size.xs, color: theme.font.color.danger }}
        >
          {error}
        </span>
      ) : hint === undefined ? null : (
        <span id={descriptionId} style={{ fontSize: theme.font.size.xs, color: theme.font.color.secondary }}>
          {hint}
        </span>
      )}
    </div>
  );
};

export const useInputStyle = (): React.CSSProperties => {
  const theme = useTheme();

  /**
   * 32px min-height and `md` text: the same box Twenty draws for its own App
   * URL input on the settings page these forms sit under. `minHeight` rather
   * than `height` so a `<textarea rows={4}>` sharing the style keeps its rows.
   */
  return {
    border: `1px solid ${theme.border.color.medium}`,
    borderRadius: theme.border.radius.sm,
    background: theme.background.primary,
    color: theme.font.color.primary,
    fontFamily: theme.font.family,
    fontSize: theme.font.size.md,
    padding: `${theme.spacing[1]} ${theme.spacing[2]}`,
    minHeight: '32px',
    boxSizing: 'border-box',
    width: '100%',
  };
};

export type ActionButtonProps = {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  tone?: 'primary' | 'default' | 'danger';
  busy?: boolean;
  /** Drawn before the label, at Twenty's own button icon scale. */
  icon?: IconName;
};

/**
 * Twenty's own `Button`, with this app's three tones mapped onto its
 * variant/accent axes. Wrapping rather than importing it at every call site
 * keeps the old `tone`/`busy` API the surfaces already speak.
 */
export const ActionButton = ({
  label,
  onClick,
  disabled = false,
  tone = 'default',
  busy = false,
  icon,
}: ActionButtonProps) => (
  <Button
    title={label}
    ariaLabel={label}
    Icon={icon === undefined ? undefined : ICON[icon]}
    onClick={onClick}
    disabled={disabled || busy}
    isLoading={busy}
    variant={tone === 'primary' ? 'primary' : 'secondary'}
    accent={tone === 'primary' ? 'blue' : tone === 'danger' ? 'danger' : 'default'}
    size="medium"
  />
);

export type StatusTone = {
  /** A `twenty-ui` tag colour, never a hex. */
  color: 'green' | 'red' | 'orange' | 'blue' | 'gray';
  icon: IconName;
  /** The copy key for the word, or null when the status is not one we know. */
  key: string | null;
};

/**
 * What a campaign status looks like, in one table (review §"campaign status").
 *
 * Pure and exported because it is the whole mapping and the only part worth a
 * test: the previous inline expression made `CANCELLED` red, which put a
 * campaign somebody deliberately stopped in the same colour as one that broke.
 * Red is reserved for the states that need someone to act.
 *
 * A status this table does not know keeps its machine code on screen rather
 * than becoming a blank or a lie — the same choice `translateWith` makes for a
 * missing key, and for the same reason.
 */
export const campaignStatusTone = (status: string | null): StatusTone => {
  switch (status) {
    case 'DRAFT':
      return { color: 'gray', icon: 'draft', key: 'campaign.status.DRAFT' };
    case 'SNAPSHOTTING':
      return { color: 'blue', icon: 'pending', key: 'campaign.status.SNAPSHOTTING' };
    case 'READY':
      return { color: 'blue', icon: 'completed', key: 'campaign.status.READY' };
    case 'SCHEDULED':
      return { color: 'blue', icon: 'scheduled', key: 'campaign.status.SCHEDULED' };
    case 'RUNNING':
      return { color: 'green', icon: 'running', key: 'campaign.status.RUNNING' };
    case 'PAUSED':
      return { color: 'orange', icon: 'paused', key: 'campaign.status.PAUSED' };
    case 'TIER_WAITING':
      return { color: 'orange', icon: 'pending', key: 'campaign.status.TIER_WAITING' };
    case 'COMPLETED':
      return { color: 'green', icon: 'completed', key: 'campaign.status.COMPLETED' };
    case 'CANCELLED':
      return { color: 'gray', icon: 'dismiss', key: 'campaign.status.CANCELLED' };
    case 'FAILED':
      return { color: 'red', icon: 'failed', key: 'campaign.status.FAILED' };
    default:
      return { color: 'gray', icon: 'consentUnknown', key: null };
  }
};

/**
 * Twenty's `Tag`, so statuses read at the scale and shape of every other
 * status in the workspace. Never colour alone, and now never icon alone
 * either: the tag carries colour, mark *and* word, so a reader who cannot tell
 * amber from green still reads "Em pausa".
 */
export const StatusPill = ({ status, t }: { status: string | null; t?: Translate }) => {
  const tone = campaignStatusTone(status);

  return (
    <Tag
      color={tone.color}
      Icon={ICON[tone.icon]}
      text={
        tone.key === null || t === undefined ? (status ?? '—') : t(tone.key)
      }
      weight="medium"
    />
  );
};

/**
 * The state a surface is in when it has nothing to list.
 *
 * An empty state is a screen with a job: say what belongs here, and offer the
 * one thing that would put something here. "Nenhuma conversa neste filtro." on
 * its own does the first half and leaves the reader to guess the second, which
 * is why every caller of this now passes an action.
 */
export const EmptyState = ({
  icon,
  title,
  body,
  actions,
}: {
  icon: IconName;
  title: string;
  body?: string;
  actions?: React.ReactNode;
}) => {
  const theme = useTheme();
  const Icon = ICON[icon];

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: theme.spacing[2],
        padding: theme.spacing[6],
        textAlign: 'center',
        margin: 'auto',
        maxWidth: '420px',
      }}
    >
      <span
        aria-hidden="true"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: '40px',
          height: '40px',
          borderRadius: theme.border.radius.rounded,
          background: theme.background.transparent.light,
          color: theme.font.color.secondary,
        }}
      >
        <Icon size={theme.icon.size.lg} stroke={theme.icon.stroke.sm} color="currentColor" />
      </span>

      <span
        style={{
          fontSize: theme.font.size.md,
          fontWeight: theme.font.weight.medium,
          color: theme.font.color.primary,
        }}
      >
        {title}
      </span>

      {body === undefined ? null : (
        <span style={{ fontSize: theme.font.size.sm, color: theme.font.color.secondary }}>
          {body}
        </span>
      )}

      {actions === undefined ? null : (
        <div
          style={{
            display: 'flex',
            gap: theme.spacing[2],
            flexWrap: 'wrap',
            justifyContent: 'center',
          }}
        >
          {actions}
        </div>
      )}
    </div>
  );
};

export const Banner = ({
  tone = 'info',
  children,
}: {
  tone?: 'info' | 'danger' | 'success';
  children: React.ReactNode;
}) => {
  const theme = useTheme();

  return (
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      aria-atomic="true"
      style={{
        padding: theme.spacing[2],
        borderRadius: theme.border.radius.sm,
        fontSize: theme.font.size.md,
        background:
          tone === 'danger'
            ? theme.background.transparent.danger
            : tone === 'success'
              ? theme.background.transparent.success
              : theme.background.transparent.light,
        color: tone === 'danger' ? theme.font.color.danger : theme.font.color.secondary,
      }}
    >
      {children}
    </div>
  );
};

/** The id a `<TabPanel>` must carry so its tab can point at it. */
export const tabPanelId = (group: string, key: string): string => `wa-tab-${group}-${key}`;

const tabId = (group: string, key: string): string => `wa-tabbtn-${group}-${key}`;

/**
 * Which tab an arrow key moves to.
 *
 * Exported because it is the whole of the keyboard model and the only part
 * worth testing: wrapping at both ends is what stops Home/End being the only
 * way out of the last tab.
 */
export const nextTabKey = (
  keys: string[],
  active: string,
  press: string,
): string | null => {
  if (keys.length === 0) return null;

  const at = keys.indexOf(active);
  const from = at === -1 ? 0 : at;

  switch (press) {
    case 'ArrowRight':
    case 'ArrowDown':
      return keys[(from + 1) % keys.length] ?? null;
    case 'ArrowLeft':
    case 'ArrowUp':
      return keys[(from - 1 + keys.length) % keys.length] ?? null;
    case 'Home':
      return keys[0] ?? null;
    case 'End':
      return keys[keys.length - 1] ?? null;
    default:
      return null;
  }
};

/**
 * A WAI-ARIA tab list.
 *
 * It carried `role="tab"` and `aria-selected` without the behaviour those roles
 * promise, which is worse than plain buttons: a screen reader announces "tab,
 * 2 of 4" and then the arrow keys do nothing. What was missing is here —
 * roving `tabIndex` so the list is one stop rather than four, arrow/Home/End
 * navigation, and `aria-controls` pointing at a real `tabpanel`.
 *
 * `group` namespaces the generated ids: two tab lists on one page (the app
 * settings screen has Twenty's own above ours) must not both claim
 * `wa-tab-health`.
 */
export const Tabs = ({
  tabs,
  active,
  onSelect,
  group = 'wa',
  label,
}: {
  tabs: { key: string; label: string }[];
  active: string;
  onSelect: (key: string) => void;
  group?: string;
  label?: string;
}) => {
  const theme = useTheme();
  const buttons = useRef(new Map<string, HTMLButtonElement>());

  return (
    <div
      role="tablist"
      aria-label={label}
      onKeyDown={(event) => {
        const next = nextTabKey(
          tabs.map((tab) => tab.key),
          active,
          event.key,
        );

        if (next === null) return;

        // Arrow keys inside a tab list must not also scroll the page.
        event.preventDefault();
        onSelect(next);

        /**
         * Focus should follow selection under automatic activation, or a screen
         * reader keeps announcing the tab the user just left.
         *
         * **It does not move here, and that is measured, not assumed.** The
         * call is made and does not throw; `document.activeElement` simply
         * stays where it was, so the sandbox accepts `.focus()` and ignores it
         * (D-53). The call stays because it costs nothing and will start
         * working the day the platform implements it, and because the
         * alternative — pretending the strip is manually activated — would need
         * the same missing capability.
         */
        try {
          buttons.current.get(next)?.focus();
        } catch {
          // Keyboard selection still works; only the announcement lags.
        }
      }}
      style={{
        display: 'flex',
        gap: theme.spacing[1],
        overflowX: 'auto',
        borderBottom: `1px solid ${theme.border.color.light}`,
        padding: theme.spacing[1],
      }}
    >
      {tabs.map((tab) => (
        <button
          key={tab.key}
          type="button"
          role="tab"
          ref={(node) => {
            if (node === null) buttons.current.delete(tab.key);
            else buttons.current.set(tab.key, node);
          }}
          id={tabId(group, tab.key)}
          aria-selected={active === tab.key}
          aria-controls={tabPanelId(group, tab.key)}
          /**
           * Roving: only the selected tab is tabbable, so Tab enters the list
           * once and leaves once. Focus follows selection, which is the
           * automatic-activation pattern — correct here because every panel is
           * already loaded or loads on demand from the same state.
           */
          tabIndex={active === tab.key ? 0 : -1}
          onClick={() => onSelect(tab.key)}
          /**
           * Styled to `twenty-ui`'s `TabButton` scale (`md` text, 2px active
           * underline) rather than replaced by it: `TabButton` accepts no
           * `role`, `aria-*`, or ref, and swapping it in would silently drop
           * the roving-tabindex tab list built above.
           */
          style={{
            border: 'none',
            borderBottom: `2px solid ${
              active === tab.key ? theme.border.color.strong : 'transparent'
            }`,
            background: 'transparent',
            color: active === tab.key ? theme.font.color.primary : theme.font.color.secondary,
            cursor: 'pointer',
            fontFamily: theme.font.family,
            fontSize: theme.font.size.md,
            fontWeight: theme.font.weight.medium,
            padding: `${theme.spacing[2]} ${theme.spacing[2]}`,
            whiteSpace: 'nowrap',
          }}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
};

/**
 * The other half of the pair. A `role="tab"` whose `aria-controls` points at
 * nothing is a promise the markup does not keep.
 */
export const TabPanel = ({
  group = 'wa',
  tabKey,
  children,
}: {
  group?: string;
  tabKey: string;
  children: React.ReactNode;
}) => (
  <div
    role="tabpanel"
    id={tabPanelId(group, tabKey)}
    aria-labelledby={`wa-tabbtn-${group}-${tabKey}`}
    tabIndex={0}
    style={{ display: 'flex', flexDirection: 'column', gap: 'inherit' }}
  >
    {children}
  </div>
);
