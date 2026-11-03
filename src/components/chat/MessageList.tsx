import { useCallback, useMemo, useRef } from 'react';
import { useTheme } from 'twenty-ui/theme-constants';

import type { MessageProjection } from '../../domain/feed/projection';
import type { Lang, Translate } from '../common/copy';
import { dayKey, daySeparator } from '../common/format';
import { EmptyState } from '../common/ui';
import { groupMessages } from './grouping';
import { MessageShell } from './MessageShell';
import type { RendererCallbacks } from './renderers';

/**
 * The transcript (specs/08 §3.1, D-7, NFR-P4, spec §"Layout rules").
 *
 * There is no scripted scrolling in this file, and there cannot be: the sandbox
 * throws on `.scrollIntoView()` and ignores writes to `scrollTop`. The whole
 * design rests on `flex-direction: column-reverse`, where the browser's own
 * anchoring keeps the visual bottom pinned as rows are added to the *start* of
 * the array, and preserves the reader's position when older rows are added to
 * the *end*. The messages are therefore held newest-first — not sorted for
 * display, but stored that way, so the DOM order and the array order agree.
 *
 * Two things are new, and both are layout the review measured as broken:
 *
 * **The conversation lane.** At 919 px, inbound messages hugged the far left
 * and outbound the far right, leaving a dead zone down the middle and no sense
 * that the two sides were talking to each other. The rows are now centred in a
 * 640–720 px lane, which is the width at which a conversation reads as one.
 *
 * **`@container`, never `@media`.** The pane's width is what matters, not the
 * browser window's — this component renders in an inbox detail pane, a record
 * side panel and a full-width tab, and a window breakpoint would give the
 * narrow panel a desktop layout whenever the desktop was wide.
 *
 * Day separators are computed during render rather than stored, because the day
 * a message belongs to depends on the reader's time zone rule (Africa/Luanda)
 * and not on anything the server can bake in.
 */

export type MessageListProps = {
  messages: MessageProjection[];
  lang: Lang;
  t: Translate;
  now: Date;
  hasOlder: boolean;
  isLoading: boolean;
  contactLabel: string | null;
  onLoadOlder: () => void;
  onRetry?: (message: MessageProjection) => void;
  onReply?: (message: MessageProjection) => void;
  onReact?: (message: MessageProjection, emoji: string) => void;
  callbacks?: RendererCallbacks;
};

/** How close to the far end counts as "asking for more" (in pixels). */
const NEAR_END_PX = 240;

/** The lane the spec asks for: wide enough to read, narrow enough to converse. */
export const LANE_MAX_WIDTH = 720;
export const LANE_MIN_PANE = 640;

/**
 * The layout, as a stylesheet.
 *
 * Injected rather than inlined for two reasons the style attribute cannot
 * serve: `@container` has no inline form, and `:hover`/`:focus-within` are the
 * only way to reveal the action toolbar without hover being the *sole* path in.
 * Every class is namespaced `wa-thread-*` because component CSS is injected
 * globally in this sandbox and an unprefixed `.actions` would reach into the
 * rest of the workspace.
 */
const transcriptCss = (): string => `
.wa-thread-transcript { container-type: inline-size; container-name: wa-thread; }
/*
  The lane is a width on each row, not a wrapper around them.

  A wrapper would have to be the column-reverse flex container, and then the
  *scroller* would not be — which is the one thing this list cannot give up.
  The browser's own anchoring for a reversed column is the entire reason the
  transcript stays pinned to the newest message without a single scroll call,
  and it only applies to the element that actually scrolls.
*/
.wa-thread-lane { width: 100%; min-width: 0; }
.wa-thread-bubble { max-width: 100%; }

/*
  Hidden by opacity, not by display: a toolbar removed from the layout would
  reflow the row on hover, and a row that moves under the pointer is a row you
  cannot click. It stays in the tab order for the same reason — the keyboard
  path must not depend on a pointer having been somewhere.
*/
.wa-thread-actions { opacity: 0; transition: opacity 120ms ease-in-out; }
.wa-thread-row:hover .wa-thread-actions,
.wa-thread-row:focus-within .wa-thread-actions,
.wa-thread-row[data-picker="open"] .wa-thread-actions { opacity: 1; }

/*
  Touch and narrow panes: there is no hover, so the toolbar is simply always
  visible. Anything else would leave reply and react unreachable on a phone.
*/
@media (hover: none) {
  .wa-thread-actions { opacity: 1; }
}

@container wa-thread (min-width: ${LANE_MIN_PANE}px) {
  .wa-thread-lane { max-width: ${LANE_MAX_WIDTH}px; }
}

/*
  Below the lane width the toolbar cannot sit beside the bubble without
  squeezing it, so it drops under the bubble on the message's own side.
*/
@container wa-thread (max-width: ${LANE_MIN_PANE - 1}px) {
  .wa-thread-row-body { flex-wrap: wrap; }
  .wa-thread-row[data-outbound="true"] .wa-thread-row-body { justify-content: flex-end; }
}
`;

export const MessageList = ({
  messages,
  lang,
  t,
  now,
  hasOlder,
  isLoading,
  contactLabel,
  onLoadOlder,
  onRetry,
  onReply,
  onReact,
  callbacks = {},
}: MessageListProps) => {
  const theme = useTheme();
  const asking = useRef(false);

  /**
   * Reading `scrollTop` is allowed; writing it is not. In a column-reverse
   * container the offset grows *away* from the bottom, so nearing the far end
   * means nearing the oldest message — which is exactly when the next page is
   * wanted.
   */
  const onScroll = useCallback(
    (event: React.UIEvent<HTMLDivElement>) => {
      if (!hasOlder || isLoading) return;

      const node = event.currentTarget;
      const distanceFromOldest =
        node.scrollHeight - node.clientHeight - Math.abs(node.scrollTop);

      if (distanceFromOldest > NEAR_END_PX) {
        asking.current = false;

        return;
      }

      // Once per approach, not once per scroll event.
      if (asking.current) return;

      asking.current = true;
      onLoadOlder();
    },
    [hasOlder, isLoading, onLoadOlder],
  );

  /**
   * A separator belongs *above* the last message of a day. In a newest-first
   * array rendered into a column-reverse container, "above" is the row after
   * it — so the marker attaches to the message whose successor is on an earlier
   * day, and the oldest message always carries one.
   */
  const separators = useMemo(() => {
    const marks = new Map<string, string>();

    messages.forEach((message, index) => {
      const stamp = message.waTimestamp ?? message.createdAt;
      const next = messages[index + 1];
      const nextStamp = next === undefined ? null : (next.waTimestamp ?? next.createdAt);

      if (next === undefined || dayKey(stamp) !== dayKey(nextStamp)) {
        marks.set(message.id, daySeparator(stamp, now, lang, t));
      }
    });

    return marks;
  }, [messages, now, lang, t]);

  /**
   * Grouping is computed from the separator set, not beside it: a message on
   * the far side of a day boundary is never the same turn, however few minutes
   * separate the two timestamps.
   */
  const grouping = useMemo(
    () => groupMessages(messages, new Set(separators.keys())),
    [messages, separators],
  );

  return (
    <div
      className="wa-thread-transcript"
      role="region"
      aria-label={t('chat.conversation')}
      aria-busy={isLoading}
      tabIndex={0}
      onScroll={onScroll}
      style={{
        display: 'flex',
        flexDirection: 'column-reverse',
        // Centres the lane without a wrapper element, so the scroller stays the
        // column-reverse container the anchoring depends on.
        alignItems: 'center',
        overflowY: 'auto',
        overflowX: 'hidden',
        flex: '1 1 auto',
        minHeight: 0,
        /**
         * A distinct ground for the transcript, so the header and the composer
         * read as chrome around a conversation rather than as three stacked
         * panels of the same colour.
         */
        background: theme.background.transparent.lighter,
        padding: theme.spacing[2],
      }}
    >
      <style>{transcriptCss()}</style>

      {/*
        `isLoading` guards the claim. "No messages in this conversation yet" is
        a statement about the data, and a list that has not finished its first
        read is not entitled to make it.
      */}
      {messages.length === 0 && isLoading ? (
        <span role="status" style={{ margin: 'auto', color: theme.font.color.secondary }}>{t('common.loading')}</span>
      ) : null}
      {messages.length === 0 && !isLoading ? (
        <div className="wa-thread-lane">
          <EmptyState icon="inbox" title={t('chat.empty')} body={t('chat.emptyBody')} />
        </div>
      ) : null}

      {messages.map((message) => {
        const separator = separators.get(message.id);
        const flags = grouping.get(message.id) ?? { startsGroup: true, endsGroup: true };

        return (
          <div
            key={message.id}
            className="wa-thread-lane"
            style={{
              display: 'flex',
              flexDirection: 'column',
              /**
               * Intra-group spacing is a quarter of the gap between turns. That
               * contrast is what makes a group legible as one thing — an even
               * gap everywhere reads as a list, not a conversation.
               */
              marginTop: flags.startsGroup ? theme.spacing[2] : theme.spacing[0.5],
            }}
          >
            <MessageShell
              message={message}
              lang={lang}
              t={t}
              grouping={flags}
              contactLabel={contactLabel}
              callbacks={callbacks}
              {...(onRetry === undefined ? {} : { onRetry })}
              {...(onReply === undefined ? {} : { onReply })}
              {...(onReact === undefined ? {} : { onReact })}
            />
            {separator === undefined ? null : (
              <div
                style={{
                  alignSelf: 'center',
                  fontSize: theme.font.size.xs,
                  color: theme.font.color.secondary,
                  background: theme.background.transparent.light,
                  borderRadius: theme.border.radius.pill,
                  padding: `0 ${theme.spacing[2]}`,
                  margin: `${theme.spacing[2]} 0`,
                  order: -1,
                }}
              >
                {separator}
              </div>
            )}
          </div>
        );
      })}

      {/*
        Last in the array, so it renders at the visual *top* — where a reader
        looking for older messages is already looking. The scroll handler above
        presses it for them; this is for anyone whose pointer does not scroll.
      */}
      {hasOlder ? (
        <button
          type="button"
          onClick={onLoadOlder}
          disabled={isLoading}
          aria-label={t('chat.loadOlder')}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            minHeight: '32px',
            border: `1px solid ${theme.border.color.medium}`,
            background: theme.background.primary,
            borderRadius: theme.border.radius.pill,
            color: theme.font.color.secondary,
            cursor: isLoading ? 'default' : 'pointer',
            fontFamily: theme.font.family,
            fontSize: theme.font.size.sm,
            padding: `0 ${theme.spacing[3]}`,
            marginBottom: theme.spacing[2],
          }}
        >
          {t('chat.loadOlder')}
        </button>
      ) : null}
    </div>
  );
};
