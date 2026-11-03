import { Tag } from 'twenty-ui/data-display';
import { useTheme } from 'twenty-ui/theme-constants';

import type { AccountProjection, ThreadProjection } from '../../domain/feed/projection';
import type { Translate } from '../common/copy';
import { countdown, displayPhone } from '../common/format';
import { Glyph, ICON, type IconName } from '../common/icons';

/**
 * Who this conversation is with, and what state it is in (specs/08 §3, FR-UI-6).
 *
 * The window chip is the one element a rep is expected to read before typing,
 * so it says the same thing three ways — colour, icon and words — and the
 * countdown is truncated rather than rounded (`format.countdown`), because a
 * window with fifty seconds left must not read "1m".
 *
 * Every chip below is now Twenty's own `Tag`, carrying the icon through its
 * `Icon` prop. They were hand-rolled 8px spans before, which made the header's
 * most important information the smallest thing on it.
 */

export type ThreadHeaderProps = {
  thread: ThreadProjection;
  busy?: boolean;
  account: AccountProjection | null;
  t: Translate;
  now: Date;
  onToggleBlock?: () => void;
  onClose?: () => void;
  /** Absent when the caller may not act, or when the server never named them. */
  onAssign?: () => void;
  /** The caller's own workspace member id, as the server resolved it (D-53). */
  viewerId?: string | null;
};

export const WindowChip = ({
  thread,
  t,
  now,
}: {
  thread: ThreadProjection;
  t: Translate;
  now: Date;
}) => {
  const remaining = countdown(thread.serviceWindowExpiresAt, now);
  const open = remaining !== null;

  return (
    <span className="wa-window-chip" role="status">
      <Tag
        color={open ? 'green' : 'gray'}
        Icon={open ? ICON.windowOpen : ICON.windowClosed}
        text={
          open
            ? `${t('chat.windowOpen')} — ${t('chat.closesIn', { time: remaining })}`
            : t('chat.windowClosed')
        }
        weight="medium"
        preventShrink
      />
    </span>
  );
};

/** Which mark and colour a consent state wears (review §"chat status"). */
const consentTag = (consent: string): { icon: IconName; color: 'green' | 'red' | 'gray' } => {
  if (consent === 'OPTED_IN') return { icon: 'optedIn', color: 'green' };
  if (consent === 'OPTED_OUT') return { icon: 'optedOut', color: 'red' };

  return { icon: 'consentUnknown', color: 'gray' };
};

export const ThreadHeader = ({
  thread,
  busy = false,
  account,
  t,
  now,
  onToggleBlock,
  onClose,
  onAssign,
  viewerId = null,
}: ThreadHeaderProps) => {
  const theme = useTheme();

  const name =
    thread.person === null
      ? (thread.profileName ?? displayPhone(thread.dialablePhone))
      : [thread.person.firstName, thread.person.lastName].filter(Boolean).join(' ') ||
        (thread.profileName ?? '');

  const consent = thread.person?.whatsappOptInStatus ?? 'UNKNOWN';
  const consentStyle = consentTag(consent);

  const mine = viewerId !== null && thread.assigneeId === viewerId;
  const assigned = thread.assigneeId !== null;

  /**
   * A header button. 28px and a real border, rather than the 8px-type,
   * zero-padding text the review measured — these are the controls that block
   * a customer and close a conversation.
   */
  const button: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: theme.spacing[1],
    minHeight: '28px',
    border: `1px solid ${theme.border.color.medium}`,
    borderRadius: theme.border.radius.sm,
    background: 'transparent',
    color: theme.font.color.secondary,
    cursor: 'pointer',
    fontFamily: theme.font.family,
    fontSize: theme.font.size.xs,
    padding: `0 ${theme.spacing[2]}`,
    whiteSpace: 'nowrap',
  };

  return (
    <div
      className="wa-thread-header"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: theme.spacing[1],
        padding: theme.spacing[2],
        borderBottom: `1px solid ${theme.border.color.light}`,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: theme.spacing[2],
          flexWrap: 'wrap',
        }}
      >
        <span
          style={{
            fontWeight: theme.font.weight.semiBold,
            fontSize: theme.font.size.md,
            color: theme.font.color.primary,
          }}
        >
          {name === '' ? displayPhone(thread.waId) : name}
        </span>
        <span style={{ fontSize: theme.font.size.sm, color: theme.font.color.secondary }}>
          {displayPhone(thread.dialablePhone ?? thread.waId)}
        </span>

        {thread.status === 'NEEDS_REVIEW' ? (
          <Tag color="orange" Icon={ICON.needsReview} text={t('chat.needsReview')} weight="medium" />
        ) : null}
        {thread.isBlocked ? (
          <Tag color="red" Icon={ICON.blocked} text={t('chat.blocked')} weight="medium" />
        ) : null}
        <Tag
          color={consentStyle.color}
          Icon={ICON[consentStyle.icon]}
          text={t(`consent.${consent}`)}
          weight="medium"
        />
        {account?.isTestAccount === true ? (
          <Tag color="purple" Icon={ICON.testAccount} text={t('chat.testAccount')} weight="medium" />
        ) : null}
        {account?.qualityRating === 'YELLOW' ? (
          <Tag color="orange" Icon={ICON.warning} text={t('chat.qualityYellow')} weight="medium" />
        ) : null}
        {account?.qualityRating === 'RED' ? (
          <Tag color="red" Icon={ICON.warning} text={t('chat.qualityRed')} weight="medium" />
        ) : null}

        {/*
          Who is handling this. Shown even when the viewer cannot change it —
          "somebody already has this" is the thing a second rep needs to know
          before they answer the same customer twice (FR-THR-3).
        */}
        <Tag
          color={mine ? 'blue' : assigned ? 'gray' : 'sky'}
          Icon={mine ? ICON.mine : assigned ? ICON.mine : ICON.unassigned}
          text={t(
            mine ? 'chat.assignedToYou' : assigned ? 'chat.assignedToOther' : 'chat.unassigned',
          )}
          weight="medium"
        />

        <span style={{ flex: '1 1 auto' }} />

        {/*
          Assign is the action a rep takes most often and the one that had no
          UI at all: `assigneeId` was on the projection, the route accepted the
          action, and nothing on screen could reach it.
        */}
        {onAssign === undefined ? null : (
          <button
            type="button"
              disabled={busy}
            onClick={onAssign}
            aria-label={t(mine ? 'chat.unassign' : 'chat.assignToMe')}
            style={button}
          >
            <Glyph name={mine ? 'unassigned' : 'mine'} />
            {t(mine ? 'chat.unassign' : 'chat.assignToMe')}
          </button>
        )}

        {onToggleBlock === undefined ? null : (
          <button
            type="button"
              disabled={busy}
            onClick={onToggleBlock}
            aria-label={t(thread.isBlocked ? 'chat.unblock' : 'chat.block')}
            style={
              thread.isBlocked
                ? button
                : { ...button, borderColor: theme.border.color.danger, color: theme.font.color.danger }
            }
          >
            <Glyph name="blocked" />
            {t(thread.isBlocked ? 'chat.unblock' : 'chat.block')}
          </button>
        )}

        {onClose === undefined ? null : (
          <button
            type="button"
              disabled={busy}
            onClick={onClose}
            aria-label={t(thread.status === 'CLOSED' ? 'chat.reopen' : 'chat.close')}
            style={button}
          >
            <Glyph name={thread.status === 'CLOSED' ? 'windowOpen' : 'closed'} />
            {t(thread.status === 'CLOSED' ? 'chat.reopen' : 'chat.close')}
          </button>
        )}
      </div>

      <WindowChip thread={thread} t={t} now={now} />

      {account !== null && account.status !== 'CONNECTED' ? (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: theme.spacing[1],
            fontSize: theme.font.size.sm,
            color: theme.font.color.danger,
          }}
        >
          <Glyph name="warning" />
          {t('chat.accountError')}
        </div>
      ) : null}
    </div>
  );
};
