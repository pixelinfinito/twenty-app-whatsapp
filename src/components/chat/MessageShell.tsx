import { useState } from 'react';
import { useTheme } from 'twenty-ui/theme-constants';

import type { MessageProjection } from '../../domain/feed/projection';
import { errorCopy, type Lang, type Translate } from '../common/copy';
import { clockTime } from '../common/format';
import { DeliveryTicks, Glyph } from '../common/icons';
import { isCopyKey, messageDetails } from './details';
import type { Grouping } from './grouping';
import { MessageActions, ReactionChips, type MessageAction } from './MessageActions';
import { QuoteStrip } from './QuoteStrip';
import {
  MessageContent,
  actionsFor,
  copyableText,
  isChromeless,
  type RendererCallbacks,
} from './renderers';

/**
 * One row in the transcript (spec §"Rich message renderer registry").
 *
 * The shell owns everything *about* a message: which side it sits on, whether
 * it opens or closes a group, the quote above it, the actions beside it, the
 * reactions under it, the delivery state and the time. A renderer owns only
 * what the message *says*. That line is the whole point — `MessageBubble` mixed
 * the two, so every new WhatsApp type meant editing the layout, and the types
 * that arrived last got the least layout.
 *
 * Three rules held over from the bubble it replaces, because they were right:
 *
 * - **Nothing here decides anything.** `isRetryable`, the delivery status, the
 *   content kind — all decided on the server and carried on the projection. A
 *   component that re-derived "is this retryable" would eventually disagree
 *   with the route that handles the retry.
 * - **Status is never colour alone.** Every tick carries an `aria-label`, and a
 *   failure carries an icon *and* a sentence.
 * - **Nothing is `xxs`.** That size measured ~8 px in the rendered page. The
 *   metadata line is `xs`, the content is `sm`, and every target here clears
 *   32 px except the reaction chips, which the spec permits at 24 px.
 */

export type MessageShellProps = {
  message: MessageProjection;
  lang: Lang;
  t: Translate;
  grouping: Grouping;
  /** The customer's display name, shown once above an inbound group. */
  contactLabel: string | null;
  onRetry?: (message: MessageProjection) => void;
  onReply?: (message: MessageProjection) => void;
  onReact?: (message: MessageProjection, emoji: string) => void;
  callbacks: RendererCallbacks;
};

const isBlue = (status: string | null): boolean =>
  status === 'READ' || status === 'PLAYED';

export const MessageShell = ({
  message,
  lang,
  t,
  grouping,
  contactLabel,
  onRetry,
  onReply,
  onReact,
  callbacks,
}: MessageShellProps) => {
  const theme = useTheme();
  const [showDetails, setShowDetails] = useState(false);
  const [copied, setCopied] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);

  const outbound = message.direction === 'OUTBOUND';
  const failed = message.status === 'FAILED';
  const chromeless = isChromeless(message.content);
  /**
   * A system event is a fact about the conversation, not a turn in it. Putting
   * it on one side of the lane implies somebody said it; centring it is what
   * makes "the number changed" read as an annotation rather than as a message.
   */
  const centred = message.content.kind === 'system';
  const available = actionsFor(message.content);
  const details = messageDetails(message, (iso) => clockTime(iso, lang));

  /**
   * Reply and react both need a `wamid`: Meta addresses both by the target
   * message's id, and an optimistic bubble does not have one yet. Offering the
   * action anyway would produce a button that fails for the first few seconds
   * of every message's life, which is exactly when a rep is looking at it.
   */
  const addressable = message.wamid !== null;

  /**
   * The clipboard, without assuming it exists.
   *
   * `navigator.clipboard` is absent in some sandboxed contexts and rejects in
   * others, so the result is reported either way — a Copy button that silently
   * did nothing would be indistinguishable from one that worked.
   */
  const copy = (value: string) => {
    const clipboard = globalThis.navigator?.clipboard;

    if (clipboard === undefined) {
      setCopied(false);

      return;
    }

    void clipboard
      .writeText(value)
      .then(() => setCopied(true))
      .catch(() => setCopied(false));
  };

  const copyable = copyableText(message.content);
  const mediaUrl = message.media?.url ?? null;

  const actions: MessageAction[] = [
    ...(onReply === undefined || !addressable
      ? []
      : [
          {
            key: 'reply',
            icon: 'reply' as const,
            label: t('chat.action.reply'),
            onClick: () => onReply(message),
          },
        ]),
    ...(available.canCopy && copyable !== null
      ? [
          {
            key: 'copy',
            icon: 'copy' as const,
            label: t('chat.action.copy'),
            onClick: () => copy(copyable),
          },
        ]
      : []),
    ...(available.canDownload && mediaUrl !== null
      ? [
          {
            key: 'download',
            icon: 'download' as const,
            label: t('chat.action.download'),
            href: mediaUrl,
          },
        ]
      : []),
    ...(details.length === 0
      ? []
      : [
          {
            key: 'details',
            icon: 'details' as const,
            label: t(showDetails ? 'chat.detailsHide' : 'chat.details'),
            onClick: () => setShowDetails((current) => !current),
          },
        ]),
  ];

  const mine = message.reactions.find((reaction) => reaction.isMine)?.emoji ?? null;

  const bubble: React.CSSProperties = chromeless
    ? { display: 'flex', flexDirection: 'column', gap: theme.spacing[1], minWidth: 0 }
    : {
        display: 'flex',
        flexDirection: 'column',
        gap: theme.spacing[1],
        minWidth: 0,
        padding: `${theme.spacing[1]} ${theme.spacing[2]}`,
        /**
         * A group reads as one shape: the corner where consecutive bubbles meet
         * is tightened, so six replies look like one turn rather than six
         * stacked cards.
         */
        borderRadius: theme.border.radius.md,
        borderTopRightRadius:
          outbound && !grouping.startsGroup ? theme.border.radius.xs : theme.border.radius.md,
        borderBottomRightRadius:
          outbound && !grouping.endsGroup ? theme.border.radius.xs : theme.border.radius.md,
        borderTopLeftRadius:
          !outbound && !grouping.startsGroup ? theme.border.radius.xs : theme.border.radius.md,
        borderBottomLeftRadius:
          !outbound && !grouping.endsGroup ? theme.border.radius.xs : theme.border.radius.md,
        background: outbound
          ? theme.background.transparent.blue
          : theme.background.secondary,
        border: failed
          ? `1px solid ${theme.border.color.danger}`
          : `1px solid ${outbound ? 'transparent' : theme.border.color.light}`,
        fontSize: theme.font.size.sm,
        color: theme.font.color.primary,
        wordBreak: 'break-word',
      };

  return (
    <div
      className="wa-thread-row"
      data-outbound={outbound ? 'true' : 'false'}
      data-picker={pickerOpen ? 'open' : 'closed'}
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: centred ? 'center' : outbound ? 'flex-end' : 'flex-start',
        gap: theme.spacing[0.5],
        // The bubble may not exceed the lane, but it must be free to be
        // narrower — a two-word reply in a 640px box looks like a mistake.
        maxWidth: '100%',
      }}
    >
      {/*
        The sender, once per group. Outbound messages do not get one: the side
        of the lane already says who sent them, and "You" above every reply is
        an extra line of noise per turn.
      */}
      {grouping.startsGroup && !outbound && contactLabel !== null ? (
        <span
          style={{
            fontSize: theme.font.size.xs,
            fontWeight: theme.font.weight.medium,
            color: theme.font.color.secondary,
            padding: `0 ${theme.spacing[1]}`,
          }}
        >
          {contactLabel}
        </span>
      ) : null}

      <div
        className="wa-thread-row-body"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: theme.spacing[1],
          flexDirection: outbound ? 'row-reverse' : 'row',
          maxWidth: '100%',
          minWidth: 0,
        }}
      >
        <div className="wa-thread-bubble" style={bubble}>
          {message.lane === 'CAMPAIGN' ? (
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                alignSelf: 'flex-start',
                gap: theme.spacing[1],
                fontSize: theme.font.size.xs,
                color: theme.font.color.secondary,
              }}
            >
              <Glyph name="campaign_replies" />
              {t('chat.campaign')}
            </span>
          ) : null}

          {message.sourceKind === 'AI_AGENT' ? (
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                alignSelf: 'flex-start',
                gap: theme.spacing[1],
                fontSize: theme.font.size.xs,
                color: theme.font.color.secondary,
              }}
            >
              <Glyph name="campaign_replies" />
              {t('chat.aiAgent')}
            </span>
          ) : null}

          {message.quote === null ? null : <QuoteStrip quote={message.quote} t={t} />}

          <MessageContent message={message} t={t} callbacks={callbacks} />

          {failed ? (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: theme.spacing[1],
                fontSize: theme.font.size.xs,
                color: theme.font.color.danger,
              }}
            >
              <span
                style={{ display: 'flex', alignItems: 'flex-start', gap: theme.spacing[1] }}
              >
                <Glyph name="warning" />
                {errorCopy(t, message.errorCode, message.errorDetail)}
              </span>
              {message.isRetryable && onRetry !== undefined ? (
                <button
                  type="button"
                  onClick={() => onRetry(message)}
                  aria-label={t('chat.retry')}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    alignSelf: 'flex-start',
                    gap: theme.spacing[1],
                    minHeight: '32px',
                    border: `1px solid ${theme.border.color.danger}`,
                    borderRadius: theme.border.radius.sm,
                    background: 'transparent',
                    color: theme.font.color.danger,
                    cursor: 'pointer',
                    fontFamily: theme.font.family,
                    fontSize: theme.font.size.xs,
                    padding: `0 ${theme.spacing[2]}`,
                  }}
                >
                  <Glyph name="retry" />
                  {t('chat.retry')}
                </button>
              ) : null}
            </div>
          ) : null}

          {showDetails && details.length > 0 ? (
            <dl
              style={{
                display: 'grid',
                gridTemplateColumns: 'auto 1fr',
                gap: `${theme.spacing[0.5]} ${theme.spacing[2]}`,
                margin: 0,
                marginTop: theme.spacing[1],
                paddingTop: theme.spacing[1],
                borderTop: `1px solid ${theme.border.color.light}`,
                fontSize: theme.font.size.xs,
              }}
            >
              {details.map((detail, index) => (
                <DetailRow
                  key={`${detail.key}-${index}`}
                  label={t(detail.key)}
                  value={isCopyKey(detail.value) ? t(detail.value) : detail.value}
                />
              ))}
            </dl>
          ) : null}
        </div>

        {/*
          Beside the bubble, revealed by hover, focus-within or an open picker.
          The reveal is in `MessageList`'s stylesheet because `:focus-within`
          has no React event — and hover alone would put every message action
          out of a keyboard user's reach.
        */}
        {actions.length === 0 && onReact === undefined ? null : (
          <MessageActions
            actions={actions}
            t={t}
            mine={mine}
            onOpenChange={setPickerOpen}
            {...(onReact === undefined || !addressable
              ? {}
              : { onReact: (emoji: string) => onReact(message, emoji) })}
          />
        )}
      </div>

      <ReactionChips
        reactions={message.reactions}
        {...(onReact === undefined || !addressable
          ? {}
          : { onToggle: (emoji: string) => onReact(message, emoji) })}
      />

      {/*
        Time and delivery state, once per group, on its last (newest) message.
        A timestamp under every bubble in a burst is five repetitions of the
        same minute.
      */}
      {grouping.endsGroup ? (
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: theme.spacing[1],
            fontSize: theme.font.size.xs,
            color: theme.font.color.secondary,
            padding: `0 ${theme.spacing[1]}`,
          }}
        >
          {copied ? (
            <span style={{ color: theme.font.color.secondary }}>
              {t('chat.action.copied')}
            </span>
          ) : null}
          {/*
            Who sent it, once per group, beside the time.

            Two reps working the same conversation saw an identical column of
            blue bubbles with nothing to tell them apart — "did I send that, or
            did Ana?" is a question the transcript should never make anyone ask.
            It rides on the metadata line rather than taking one of its own,
            because a name is the same *kind* of fact as the time and the ticks:
            about the message, not part of it.

            Only outbound, and only for a message a person sent by hand. A
            campaign has no author worth naming, and the lane tag above the
            bubble already says what it was.
          */}
          {outbound && message.sentByLabel !== null ? (
            <>
              <span>{message.sentByLabel}</span>
              <span aria-hidden="true">·</span>
            </>
          ) : null}
          <span>{clockTime(message.waTimestamp ?? message.createdAt, lang)}</span>
          {outbound ? (
            <span
              role="img"
              aria-label={t(`status.${message.status ?? 'QUEUED'}`)}
              title={t(`status.${message.status ?? 'QUEUED'}`)}
              style={{ display: 'inline-flex', alignItems: 'center' }}
            >
              <DeliveryTicks
                status={message.status}
                color={
                  isBlue(message.status)
                    ? theme.color.blue
                    : failed
                      ? theme.font.color.danger
                      : theme.font.color.secondary
                }
              />
            </span>
          ) : null}
        </span>
      ) : null}
    </div>
  );
};

/**
 * One `dt`/`dd` pair. A fragment rather than a wrapper element, so the grid
 * above lays the label and the value into its own two columns instead of
 * receiving one opaque child per row.
 */
const DetailRow = ({ label, value }: { label: string; value: string }) => {
  const theme = useTheme();

  return (
    <>
      <dt style={{ color: theme.font.color.secondary }}>{label}</dt>
      <dd style={{ margin: 0, color: theme.font.color.secondary, wordBreak: 'break-word' }}>
        {value}
      </dd>
    </>
  );
};
