import { useTheme } from 'twenty-ui/theme-constants';

import { Glyph, type IconName } from '../../common/icons';

/**
 * The three shapes every rich renderer is built from.
 *
 * Before the registry, each content type invented its own layout inline, which
 * is how a location ended up as raw text while a document got a bordered row:
 * nothing held them to a common rhythm. These do — an icon, a strong first
 * line, a quiet second, and at most one primary action — so a shared contact
 * and a shared location look like siblings rather than like two features built
 * a month apart.
 *
 * All three are deliberately dumb. They take strings, not projections: the
 * renderer decides *what* to say, this decides how it sits.
 */

/**
 * The card a non-text message sits in.
 *
 * `role="group"` rather than an article or a region: the message row above
 * already carries the semantics, and a second landmark per bubble makes a
 * screen reader's landmark list useless in a long conversation.
 */
export const ContentCard = ({
  icon,
  title,
  subtitle,
  meta,
  media,
  action,
  children,
  tone = 'neutral',
}: {
  icon: IconName;
  title: string;
  subtitle?: string | null;
  /** The quiet third line: size, duration, a count. */
  meta?: string | null;
  /** A thumbnail, map preview or player, above the text. */
  media?: React.ReactNode;
  action?: React.ReactNode;
  children?: React.ReactNode;
  tone?: 'neutral' | 'quiet';
}) => {
  const theme = useTheme();

  return (
    <div
      className="wa-thread-card"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: theme.spacing[1],
        border: `1px solid ${theme.border.color.light}`,
        borderRadius: theme.border.radius.sm,
        background:
          tone === 'quiet' ? 'transparent' : theme.background.transparent.lighter,
        padding: theme.spacing[1],
        minWidth: 0,
      }}
    >
      {media}

      <div style={{ display: 'flex', gap: theme.spacing[1], minWidth: 0 }}>
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            flex: '0 0 auto',
            width: '28px',
            height: '28px',
            borderRadius: theme.border.radius.sm,
            background: theme.background.transparent.light,
            color: theme.font.color.secondary,
          }}
        >
          <Glyph name={icon} size="md" />
        </span>

        <span
          style={{
            display: 'flex',
            flexDirection: 'column',
            minWidth: 0,
            justifyContent: 'center',
          }}
        >
          <span
            style={{
              fontSize: theme.font.size.sm,
              fontWeight: theme.font.weight.medium,
              color: theme.font.color.primary,
              wordBreak: 'break-word',
            }}
          >
            {title}
          </span>
          {subtitle === null || subtitle === undefined ? null : (
            <span
              style={{
                fontSize: theme.font.size.xs,
                color: theme.font.color.secondary,
                wordBreak: 'break-word',
              }}
            >
              {subtitle}
            </span>
          )}
          {meta === null || meta === undefined ? null : (
            <span style={{ fontSize: theme.font.size.xs, color: theme.font.color.secondary }}>
              {meta}
            </span>
          )}
        </span>
      </div>

      {children}

      {action === undefined ? null : (
        <div style={{ display: 'flex', gap: theme.spacing[1], flexWrap: 'wrap' }}>{action}</div>
      )}
    </div>
  );
};

/**
 * The one action a card offers, as a link or a button.
 *
 * A link when the result is a navigation the browser owns — opening a map,
 * downloading a file — because `<a download>` and `target="_blank"` work in the
 * sandbox and a scripted `window.open` does not reliably. A button when the
 * result is a state change inside the component.
 */
export const CardAction = ({
  icon,
  label,
  href,
  onClick,
  disabled = false,
  tone = 'quiet',
}: {
  icon: IconName;
  label: string;
  href?: string;
  onClick?: () => void;
  /** Only meaningful for the button form; a link has nothing in flight. */
  disabled?: boolean;
  tone?: 'quiet' | 'loud';
}) => {
  const theme = useTheme();

  const style: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.spacing[1],
    minHeight: '28px',
    border: `1px solid ${tone === 'loud' ? 'transparent' : theme.border.color.medium}`,
    borderRadius: theme.border.radius.sm,
    background: tone === 'loud' ? theme.color.blue : 'transparent',
    color: disabled
      ? theme.font.color.secondary
      : tone === 'loud'
        ? theme.font.color.inverted
        : theme.font.color.secondary,
    cursor: disabled ? 'default' : 'pointer',
    fontFamily: theme.font.family,
    fontSize: theme.font.size.xs,
    padding: `0 ${theme.spacing[2]}`,
    textDecoration: 'none',
    whiteSpace: 'nowrap',
  };

  if (href !== undefined) {
    return (
      <a href={href} target="_blank" rel="noreferrer" style={style}>
        <Glyph name={icon} />
        {label}
      </a>
    );
  }

  return (
    <button type="button" onClick={onClick} disabled={disabled} style={style}>
      <Glyph name={icon} />
      {label}
    </button>
  );
};

/**
 * The small tag above a bubble's content: Template, Campaign, "Selected from
 * the list". Never the whole message — it names the *kind* of thing below it.
 */
export const ContentTag = ({ icon, label }: { icon: IconName; label: string }) => {
  const theme = useTheme();

  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: theme.spacing[1],
        alignSelf: 'flex-start',
        fontSize: theme.font.size.xs,
        color: theme.font.color.secondary,
        background: theme.background.transparent.light,
        borderRadius: theme.border.radius.sm,
        padding: `${theme.spacing[0.5]} ${theme.spacing[1]}`,
        maxWidth: '100%',
      }}
    >
      <Glyph name={icon} />
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {label}
      </span>
    </span>
  );
};
