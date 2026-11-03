import { useState } from 'react';
import { useTheme } from 'twenty-ui/theme-constants';

import type { ReactionProjection } from '../../domain/feed/projection';
import type { Translate } from '../common/copy';
import { Glyph, type IconName } from '../common/icons';

/**
 * What a rep can do to one message (spec §"Message action model").
 *
 * There was no answer to this before: a bubble offered "Ver detalhes" and,
 * after a failure, "Repetir". Reply and react — the two things a person does
 * with a message dozens of times a day — had no entry point at all, on any
 * surface.
 *
 * Four constraints shape every decision below, and three of them are the
 * sandbox's:
 *
 * - **No portals.** `createPortal(document.body)` renders nothing here, so the
 *   emoji picker is an absolutely-positioned panel inside the row, and the row
 *   is the containing block.
 * - **No `.focus()`.** Focus cannot be moved into the picker when it opens, so
 *   the picker's buttons are in DOM order right after the trigger and reachable
 *   with Tab alone.
 * - **Hover is never the only path.** The toolbar is revealed by hover *and*
 *   `focus-within` *and* selection, so a keyboard user and a touch user each
 *   have a way in. That is why the reveal lives in `MessageList`'s stylesheet
 *   rather than in a `useState` hover flag: `:hover` and `:focus-within` are
 *   the two selectors, and React has no event for the second.
 * - **32 px targets.** The spec's floor for a primary message action. The
 *   reaction chips are the one 24 px exception it allows, and they sit apart
 *   from everything else.
 */

/** The row every picker opens with, before "more". */
export const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'] as const;

/**
 * The full picker. Not an emoji *library*: a curated set that covers what a
 * support conversation actually uses, in one inline panel with no external
 * font, no data file and no portal. A 1 800-emoji picker in a bubble would be
 * a scrolling surface inside a scrolling surface inside a widget.
 */
export const MORE_REACTIONS = [
  '👍', '👎', '❤️', '🔥', '🎉', '👏', '🙏', '💪',
  '😂', '😅', '😊', '😍', '🤔', '😮', '😢', '😡',
  '✅', '❌', '⚠️', '⏰', '📍', '📄', '💰', '🚀',
] as const;

export type MessageAction = {
  key: string;
  icon: IconName;
  label: string;
  onClick?: () => void;
  href?: string;
};

/**
 * A single 32 px action. `title` as well as `aria-label` because the toolbar is
 * icon-only — an icon with no accessible name is a control a screen reader
 * announces as "button".
 */
const ActionButton = ({ action }: { action: MessageAction }) => {
  const theme = useTheme();

  const style: React.CSSProperties = {
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
    padding: 0,
  };

  if (action.href !== undefined) {
    return (
      <a
        href={action.href}
        target="_blank"
        rel="noreferrer"
        aria-label={action.label}
        title={action.label}
        style={style}
      >
        <Glyph name={action.icon} size="md" />
      </a>
    );
  }

  return (
    <button
      type="button"
      onClick={action.onClick}
      aria-label={action.label}
      title={action.label}
      style={style}
    >
      <Glyph name={action.icon} size="md" />
    </button>
  );
};

export type MessageActionsProps = {
  actions: MessageAction[];
  t: Translate;
  /** Absent when the message has no `wamid` yet, or policy forbids reacting. */
  onReact?: (emoji: string) => void;
  /** The viewer's current reaction, so tapping it again removes it. */
  mine?: string | null;
  /** Keeps the toolbar visible while a panel is open — see the stylesheet. */
  onOpenChange?: (open: boolean) => void;
};

export const MessageActions = ({
  actions,
  t,
  onReact,
  mine = null,
  onOpenChange,
}: MessageActionsProps) => {
  const theme = useTheme();
  const [picker, setPicker] = useState<'closed' | 'quick' | 'full'>('closed');

  const setPickerState = (next: 'closed' | 'quick' | 'full') => {
    setPicker(next);
    onOpenChange?.(next !== 'closed');
  };

  /**
   * Selecting the active reaction removes it, by sending an empty emoji — the
   * same call, because that is how Meta models a removal. Selecting another
   * replaces it, which the server's one-reaction-per-actor rule enforces
   * without the browser having to send a removal first.
   */
  const react = (emoji: string) => {
    onReact?.(emoji === mine ? '' : emoji);
    setPickerState('closed');
  };

  const emojiButton = (emoji: string) => {
    const active = emoji === mine;

    return (
      <button
        key={emoji}
        type="button"
        onClick={() => react(emoji)}
        aria-label={
          active ? t('chat.action.removeReaction') : t('chat.action.reactWith', { emoji })
        }
        aria-pressed={active}
        title={active ? t('chat.action.removeReaction') : emoji}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          minWidth: '32px',
          minHeight: '32px',
          border: active ? `1px solid ${theme.color.blue}` : '1px solid transparent',
          borderRadius: theme.border.radius.sm,
          background: active ? theme.background.transparent.blue : 'transparent',
          cursor: 'pointer',
          fontSize: theme.font.size.md,
          lineHeight: 1,
          padding: 0,
        }}
      >
        {emoji}
      </button>
    );
  };

  const toolbar: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: theme.spacing[0.5],
    border: `1px solid ${theme.border.color.light}`,
    borderRadius: theme.border.radius.pill,
    background: theme.background.primary,
    padding: `0 ${theme.spacing[0.5]}`,
  };

  return (
    <div
      className="wa-thread-actions"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && picker !== 'closed') {
          event.preventDefault();
          event.stopPropagation();
          setPickerState('closed');
        }
      }}
      role="group"
      aria-label={t('chat.action.forMessage')}
      // The containing block for the picker below. Without it the absolutely
      // positioned panel would resolve against the scrolling transcript and
      // travel up the screen as the reader scrolls.
      style={{ position: 'relative', display: 'inline-flex' }}
    >
      <div style={toolbar}>
        {onReact === undefined ? null : (
          <ActionButton
            action={{
              key: 'react',
              icon: 'react',
              label: t('chat.action.react'),
              onClick: () => setPickerState(picker === 'closed' ? 'quick' : 'closed'),
            }}
          />
        )}
        {actions.map((action) => (
          <ActionButton key={action.key} action={action} />
        ))}
      </div>

      {picker === 'closed' || onReact === undefined ? null : (
        <div
          className="wa-thread-picker"
          style={{
            position: 'absolute',
            bottom: '100%',
            right: 0,
            marginBottom: theme.spacing[1],
            display: 'grid',
            gridTemplateColumns:
              picker === 'full' ? 'repeat(8, minmax(0, 1fr))' : 'repeat(7, minmax(0, 1fr))',
            gap: theme.spacing[0.5],
            border: `1px solid ${theme.border.color.medium}`,
            borderRadius: theme.border.radius.md,
            background: theme.background.primary,
            boxShadow: theme.boxShadow.strong,
            padding: theme.spacing[1],
            zIndex: 2,
          }}
        >
          {(picker === 'full' ? MORE_REACTIONS : QUICK_REACTIONS).map(emojiButton)}

          {picker === 'quick' ? (
            <ActionButton
              action={{
                key: 'more',
                icon: 'more',
                label: t('chat.action.moreEmoji'),
                onClick: () => setPickerState('full'),
              }}
            />
          ) : null}
        </div>
      )}
    </div>
  );
};

/**
 * The aggregated chips under a bubble.
 *
 * Grouped by emoji with a count, rather than one chip per person: five 👍 is
 * one fact, and five identical chips is a wall. The participants are in the
 * accessible label, so the information is available without a hover the
 * keyboard cannot reach.
 *
 * The viewer's own reaction is outlined, which is what makes "tap it again to
 * remove it" discoverable at all.
 */
export const ReactionChips = ({
  reactions,
  onToggle,
}: {
  reactions: ReactionProjection[];
  onToggle?: (emoji: string) => void;
}) => {
  const theme = useTheme();

  if (reactions.length === 0) return null;

  const grouped = new Map<string, ReactionProjection[]>();

  for (const reaction of reactions) {
    grouped.set(reaction.emoji, [...(grouped.get(reaction.emoji) ?? []), reaction]);
  }

  return (
    <div
      className="wa-thread-reactions"
      style={{ display: 'flex', flexWrap: 'wrap', gap: theme.spacing[0.5] }}
    >
      {[...grouped.entries()].map(([emoji, group]) => {
        const isMine = group.some((reaction) => reaction.isMine);
        const who = group
          .map((reaction) => reaction.actorLabel)
          .filter((label): label is string => label !== null);

        const label = `${emoji} ${group.length}${who.length === 0 ? '' : ` — ${who.join(', ')}`}`;

        const chip: React.CSSProperties = {
          display: 'inline-flex',
          alignItems: 'center',
          gap: theme.spacing[0.5],
          // 24px is the spec's one permitted exception, and these sit apart
          // from every other target in the row.
          minHeight: '24px',
          border: `1px solid ${isMine ? theme.color.blue : theme.border.color.light}`,
          borderRadius: theme.border.radius.pill,
          background: isMine
            ? theme.background.transparent.blue
            : theme.background.transparent.light,
          color: theme.font.color.secondary,
          fontFamily: theme.font.family,
          fontSize: theme.font.size.xs,
          padding: `0 ${theme.spacing[1]}`,
        };

        if (onToggle === undefined) {
          return (
            <span key={emoji} style={chip} aria-label={label} title={label}>
              {emoji}
              {group.length > 1 ? group.length : null}
            </span>
          );
        }

        return (
          <button
            key={emoji}
            type="button"
            onClick={() => onToggle(isMine ? '' : emoji)}
            aria-label={label}
            aria-pressed={isMine}
            title={label}
            style={{ ...chip, cursor: 'pointer' }}
          >
            {emoji}
            {group.length > 1 ? group.length : null}
          </button>
        );
      })}
    </div>
  );
};
