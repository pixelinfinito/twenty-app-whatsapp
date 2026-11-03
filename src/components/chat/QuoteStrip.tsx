import { useTheme } from 'twenty-ui/theme-constants';

import type { QuoteProjection } from '../../domain/feed/quote';
import type { Translate } from '../common/copy';
import { Glyph } from '../common/icons';
import { typeIconFor, typeLabelFor } from './renderers';

/**
 * The message a reply is about (spec §"Reply UX").
 *
 * One component, two homes: above the composer while a reply is being written,
 * and inside the bubble once it has been sent. That is not economy — it is what
 * makes the promise in step 4 of the spec's flow true, that "the optimistic
 * bubble includes the same quote preview immediately". Two implementations
 * would drift, and the drift would show up as the quote *changing* the moment
 * the send lands.
 *
 * It never scrolls to its target. `.scrollIntoView()` throws in this sandbox
 * and writing `scrollTop` is a no-op, so a strip that promised navigation would
 * be a control that does nothing. `onOpen` expands the quote in place instead.
 */

export type QuoteStripProps = {
  quote: QuoteProjection;
  t: Translate;
  /** Composer variant: a dismiss button and a stronger background. */
  onDismiss?: () => void;
  onOpen?: () => void;
};

export const QuoteStrip = ({ quote, t, onDismiss, onOpen }: QuoteStripProps) => {
  const theme = useTheme();

  const sender =
    quote.direction === 'OUTBOUND'
      ? t('chat.you')
      : (quote.senderLabel ?? t('chat.type.TEXT'));

  /**
   * Falling back to the type label rather than to silence. A quoted sticker or
   * captionless photo has no words of its own — that is why the projection
   * sends an empty preview — and "Photo" is the line that tells a reader what
   * they replied to.
   */
  const preview =
    quote.preview.length > 0 ? quote.preview : typeLabelFor(quote.type, t);

  const body = (
    <>
      {quote.thumbnailUrl === null ? null : (
        <img
          src={quote.thumbnailUrl}
          alt=""
          loading="lazy"
          style={{
            width: '36px',
            height: '36px',
            objectFit: 'cover',
            borderRadius: theme.border.radius.sm,
            flex: '0 0 auto',
          }}
        />
      )}

      <span
        style={{
          display: 'flex',
          flexDirection: 'column',
          minWidth: 0,
          textAlign: 'left',
          flex: '1 1 auto',
        }}
      >
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: theme.spacing[1],
            fontSize: theme.font.size.xs,
            fontWeight: theme.font.weight.medium,
            color: theme.color.blue,
          }}
        >
          <Glyph name={typeIconFor(quote.type)} />
          {onDismiss === undefined ? sender : t('chat.replyingTo', { sender })}
        </span>
        <span
          style={{
            fontSize: theme.font.size.xs,
            color: theme.font.color.secondary,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {preview}
        </span>
      </span>
    </>
  );

  const frame: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: theme.spacing[1],
    borderLeft: `2px solid ${theme.color.blue}`,
    borderRadius: theme.border.radius.sm,
    background: theme.background.transparent.light,
    padding: theme.spacing[1],
    minWidth: 0,
    maxWidth: '100%',
  };

  return (
    <div className="wa-thread-quote" style={frame}>
      {onOpen === undefined ? (
        <span style={{ display: 'flex', alignItems: 'center', gap: theme.spacing[1], minWidth: 0, flex: '1 1 auto' }}>
          {body}
        </span>
      ) : (
        <button
          type="button"
          onClick={onOpen}
          aria-label={preview}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: theme.spacing[1],
            flex: '1 1 auto',
            minWidth: 0,
            minHeight: '32px',
            border: 'none',
            background: 'transparent',
            padding: 0,
            cursor: 'pointer',
            fontFamily: theme.font.family,
          }}
        >
          {body}
        </button>
      )}

      {onDismiss === undefined ? null : (
        <button
          type="button"
          onClick={onDismiss}
          aria-label={t('chat.cancelReply')}
          title={t('chat.cancelReply')}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            flex: '0 0 auto',
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
      )}
    </div>
  );
};
