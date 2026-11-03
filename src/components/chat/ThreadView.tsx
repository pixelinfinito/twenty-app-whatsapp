import { SurfaceStyles } from '../common/SurfaceStyles';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { openCommandConfirmationModal } from 'twenty-sdk/front-component';
import { useTheme } from 'twenty-ui/theme-constants';

import type { ContactCardProjection } from '../../domain/feed/content';
import type { MessageProjection } from '../../domain/feed/projection';
import { contactKey } from '../../domain/feed/contact-match';
import { isWorkspaceFileAddress } from '../../domain/workspace-file';
import type { RecentAttachment } from './builders/SendPanels';
import { projectQuote } from '../../domain/feed/quote';
import type { QuoteProjection } from '../../domain/feed/quote';
import type { FieldError } from '../../domain/interactive/validate';
import type { ResolvedParameters } from '../../domain/template-render';
import { newClientToken, useActions, type SendOutcome, type ThreadActionName } from '../common/actions';
import { refusalCopy, useCopy } from '../common/copy';
import { Glyph } from '../common/icons';
import { SURFACE_MAX_HEIGHT, SURFACE_MIN_HEIGHT } from '../common/surface';
import { ActionButton, Banner, EmptyState } from '../common/ui';
import { useFeed } from '../common/use-feed';
import { Composer } from './Composer';
import { MessageList } from './MessageList';
import {
  optimisticContacts,
  optimisticInteractive,
  optimisticLocation,
  optimisticMedia,
  optimisticTemplate,
  optimisticText,
} from './optimistic';
import { projectInteractive } from '../../domain/feed/content';
import { StartConversation } from './StartConversation';
import { ThreadHeader } from './ThreadHeader';

/**
 * The conversation, whole (specs/08 §3).
 *
 * The same component renders in the Person tab, the side panel and the inbox's
 * detail pane; only the chrome around it differs. That is not tidiness — it is
 * what makes specs/08 §10's fallback tiers a *routing* change rather than a
 * rewrite. If the probe says a rich widget is unusable, this component moves to
 * the side panel and nothing inside it changes.
 *
 * It owns exactly three pieces of state the server does not: the optimistic
 * bubble, the message a rep is replying to, and the reactions they have just
 * pressed. All three exist for the same reason — the server's answer arrives on
 * the next poll, and three seconds of a screen that has not reacted to a click
 * is three seconds of a rep clicking again.
 *
 * Every send goes through one shape: mint a token, add an optimistic bubble,
 * call the route, settle. The kinds differ only in what they put in the bubble
 * and which action they call — see `optimistic.ts`.
 */

export type ThreadViewProps = {
  /** One of the two; `personId` resolves to that contact's newest conversation. */
  threadId?: string | null;
  personId?: string | null;
  /** Chrome only. The conversation is identical in all three. */
  variant?: 'tab' | 'panel' | 'inbox';
  /**
   * Something about the conversation *as a row* changed — it was assigned,
   * closed, blocked, or linked to a contact (D-64).
   *
   * The transcript refreshes itself, but the list beside it and the totals
   * above it are separate polls on separate clocks: eight seconds and thirty.
   * So taking a conversation from inside the pane left the row still reading
   * "unassigned" and the "Mine" badge still a number short, for long enough
   * that the honest reading of the screen was that the action had not worked.
   */
  onThreadChanged?: () => void;
};

export const ThreadView = ({
  threadId = null,
  personId = null,
  variant = 'tab',
  onThreadChanged,
}: ThreadViewProps) => {
  const theme = useTheme();
  const { t, lang } = useCopy();
  const actions = useActions();

  const [isSending, setIsSending] = useState(false);
  const sending = useRef(false);
  const threadActing = useRef(false);
  const [threadBusy, setThreadBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  /**
   * A failure from an action that is not an ordinary send, so it has no bubble
   * to settle onto — assigning, or opening a conversation that does not exist
   * yet. It renders as a banner rather than disappearing into a log.
   */
  const [actionError, setActionError] = useState<string | null>(null);
  /**
   * Field-addressed rejections from the route's interactive validator, handed
   * straight to the open builder so each lands under the box that caused it.
   */
  const [fieldErrors, setFieldErrors] = useState<FieldError[]>([]);
  const [replyTarget, setReplyTarget] = useState<QuoteProjection | null>(null);
  /**
   * Reactions pressed but not yet confirmed by a poll, keyed by target wamid.
   *
   * A reaction is not a transcript row — the feed drops those — so there is no
   * optimistic *message* to add. What the rep needs to see is the chip on the
   * bubble they pressed, immediately. An empty string means "removed", which is
   * the same thing an empty emoji means on the wire.
   */
  const [pendingReactions, setPendingReactions] = useState<Record<string, string>>({});
  /**
   * Contact cards whose **Create person** is in flight, keyed by `contactKey`.
   *
   * The one write on this surface with no optimistic representation of its own:
   * the card learns it succeeded from the server's match, one poll later.
   */
  const [creatingContacts, setCreatingContacts] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  const feed = useFeed({
    scope: 'thread',
    id: threadId ?? personId,
    by: threadId === null ? 'person' : 'thread',
    enabled: threadId !== null || personId !== null,
  });

  const thread = feed.data?.thread ?? null;
  const account = feed.data?.account ?? null;
  const templates = feed.data?.templates ?? [];
  const canSend = feed.data?.permissions.canSend === true;
  const viewerId = feed.data?.permissions.workspaceMemberId ?? null;
  const capabilities = feed.data?.capabilities;

  const person = thread?.person ?? feed.data?.person ?? null;

  const contactLabel = useMemo(() => {
    const name = [person?.firstName, person?.lastName]
      .filter((part): part is string => typeof part === 'string' && part.length > 0)
      .join(' ');

    return name.length > 0 ? name : (thread?.profileName ?? null);
  }, [person, thread]);

  /**
   * The server's reactions, with the ones this rep has just pressed folded in.
   *
   * Folded rather than replaced: a rep reacting must not make the customer's
   * reaction disappear for the three seconds until the next poll. The pending
   * entry replaces only the viewer's own, and vanishes on its own once the
   * server's version carries the same emoji — see the reconciliation below.
   */
  const messages = useMemo(() => {
    if (Object.keys(pendingReactions).length === 0) return feed.messages;

    return feed.messages.map((message) => {
      const pending =
        message.wamid === null ? undefined : pendingReactions[message.wamid];

      if (pending === undefined) return message;

      const confirmed =
        message.reactions.find((reaction) => reaction.isMine)?.emoji ?? '';

      /**
       * The server has caught up: its answer and the pending one agree, so the
       * override is dropped. Without this the local entry would outlive the
       * poll and pin the chip in place — including through a *later* change
       * made from another tab, which is exactly the state a rep cannot explain.
       */
      if (confirmed === pending) return message;

      const others = message.reactions.filter((reaction) => !reaction.isMine);

      return {
        ...message,
        reactions:
          pending.length === 0
            ? others
            : [
                ...others,
                {
                  actorId: viewerId ?? 'me',
                  actorLabel: null,
                  actorKind: 'WORKSPACE_MEMBER' as const,
                  emoji: pending,
                  isMine: true,
                },
              ],
      };
    });
  }, [feed.messages, pendingReactions, viewerId]);

  /**
   * Confirmed overrides are dropped from the map, not merely ignored above.
   *
   * Left to accumulate, the map would grow for every reaction a rep pressed
   * over a long shift, and each stale entry is a bubble whose chip can never
   * again be changed from another tab. The `useMemo` reads the map; this is
   * what empties it.
   */
  useEffect(() => {
    setPendingReactions((current) => {
      const entries = Object.entries(current);

      if (entries.length === 0) return current;

      const settled = entries.filter(([wamid, emoji]) => {
        const message = feed.messages.find((candidate) => candidate.wamid === wamid);

        if (message === undefined) return false;

        return (message.reactions.find((reaction) => reaction.isMine)?.emoji ?? '') === emoji;
      });

      if (settled.length === 0) return current;

      const remaining = Object.fromEntries(
        entries.filter(([wamid]) => !settled.some(([done]) => done === wamid)),
      );

      return remaining;
    });
  }, [feed.messages]);

  /**
   * The files already in this conversation, newest first, for the attachment
   * panel's reuse list. Only addresses in Twenty's own store qualify — a Meta
   * CDN URL out of a deferred download would be accepted by the picker and
   * refused by the send route (D-58). Voice notes and stickers are turns in a
   * conversation, not files anyone re-sends.
   */
  const recentFiles = useMemo<RecentAttachment[]>(() => {
    const rows: RecentAttachment[] = [];
    const seen = new Set<string>();

    for (const message of feed.messages) {
      const media = message.media;

      if (media === null || media.url === null || !isWorkspaceFileAddress(media.url)) continue;
      if (media.isVoice) continue;

      const kind = media.kind?.toLowerCase();

      if (kind !== 'image' && kind !== 'video' && kind !== 'audio' && kind !== 'document') {
        continue;
      }
      const key = media.fileId ?? media.url.split('?')[0]!;
      if (seen.has(key)) continue;

      seen.add(key);
      rows.push({
        url: media.url,
        fileId: media.fileId ?? undefined,
        filename: media.fileName,
        mediaKind: kind,
        sizeBytes: media.sizeBytes,
      });

      if (rows.length >= 8) break;
    }

    return rows;
  }, [feed.messages]);

  /**
   * Recomputed on every render rather than ticked on a timer: the countdown
   * only has to be right when something else caused a paint, and a second
   * interval per open conversation is a cost D-6 spends deliberately elsewhere.
   */
  const now = useMemo(() => new Date(feed.data?.serverTime ?? Date.now()), [feed.data]);

  /**
   * Every send ends here, and every send must end the optimistic bubble.
   *
   * A refused send creates no server row, so nothing a later poll returns will
   * ever replace the bubble — leaving a message that reads "queued" forever and
   * a conversation that shows something which was never sent. The bubble is
   * therefore settled explicitly on every failure path, with the reason on it.
   */
  const handleOutcome = useCallback(
    (outcome: SendOutcome, clientToken: string) => {
      if (outcome.ok) {
        setRefusal(null);
        setFieldErrors([]);
        // Ask immediately rather than waiting for the next tick, so the bubble
        // stops saying "queued" as soon as the server has something better.
        feed.refresh();

        return;
      }

      if (outcome.kind === 'denied') {
        setRefusal(outcome.code);
        feed.settleOptimistic(clientToken, { error: t(`policy.${outcome.code}`) });

        return;
      }

      /**
       * A builder's own rejection. The bubble is settled like any other
       * failure, *and* the fields go back to the panel — which is still open,
       * because a builder that closed on send would have nowhere to show them.
       */
      if (outcome.kind === 'invalid') {
        setRefusal(null);
        setFieldErrors(outcome.fields);
        feed.settleOptimistic(clientToken, { error: t('builder.invalid') });

        return;
      }

      setRefusal(null);
      feed.settleOptimistic(clientToken, {
        error: refusalCopy(t, outcome.message, outcome.detail),
      });
    },
    [feed, t],
  );

  /**
   * The shape every send shares: a token, a bubble, a call, a settlement.
   *
   * Written once because the seven kinds differ only in their middle two lines,
   * and because the `finally` is the part that must never be forgotten — an
   * `isSending` left true disables the composer for the rest of the session.
   */
  const perform = useCallback(
    async (
      optimistic: (clientToken: string) => MessageProjection,
      call: (clientToken: string) => Promise<SendOutcome>,
    ): Promise<boolean> => {
      if (thread === null || sending.current) return false;
      sending.current = true;

      const clientToken = newClientToken();

      setIsSending(true);
      feed.addOptimistic(optimistic(clientToken));

      try {
        const outcome = await call(clientToken);

        handleOutcome(outcome, clientToken);

        return outcome.ok;
      } catch (error) {
        // A network failure is not an outcome the route reported; the bubble
        // still has to stop claiming it is on its way.
        feed.settleOptimistic(clientToken, {
          error: error instanceof Error ? error.message : t('error.unknown'),
        });

        return false;
      } finally {
        sending.current = false;
        setIsSending(false);
      }
    },
    [feed, handleOutcome, t, thread],
  );

  const sendText = useCallback(
    (body: string) => {
      const id = thread?.id;

      if (id === undefined) return Promise.resolve(false);

      const quote = replyTarget;

      return perform(
        (clientToken) =>
          optimisticText({ threadId: id, clientToken, quote }, body),
        (clientToken) =>
          actions.sendText({ threadId: id, body, clientToken, contextWamid: quote?.wamid ?? null }),
      ).then((accepted) => {
        if (accepted) setReplyTarget((current) => current === quote ? null : current);
        return accepted;
      });
    },
    [actions, perform, replyTarget, thread],
  );

  const sendTemplate = useCallback(
    (templateId: string, parameters: ResolvedParameters) => {
      const id = thread?.id;

      if (id === undefined) return Promise.resolve(false);

      const template = templates.find((entry) => entry.id === templateId) ?? null;
      const quote = replyTarget;

      return perform(
        (clientToken) =>
          optimisticTemplate(
            { threadId: id, clientToken, body: null, quote },
            {
              name: template?.name ?? null,
              language: template?.language ?? null,
              category: template?.category ?? null,
            },
          ),
        (clientToken) =>
          actions.sendTemplate({
            threadId: id,
            templateId,
            parameters,
            clientToken,
            contextWamid: quote?.wamid ?? null,
          }),
      ).then((accepted) => {
        if (accepted) setReplyTarget((current) => current === quote ? null : current);
        return accepted;
      });
    },
    [actions, perform, replyTarget, templates, thread],
  );

  const sendMedia = useCallback(
    (input: {
      mediaKind: 'image' | 'video' | 'audio' | 'document';
      fileId?: string;
      fileUrl?: string;
      filePath?: string;
      filename: string | null;
      caption: string | null;
      voice?: boolean;
    }) => {
      const id = thread?.id;

      if (id === undefined) return Promise.resolve(false);

      const quote = replyTarget;

      return perform(
        (clientToken) =>
          optimisticMedia(
            { threadId: id, clientToken, quote },
            {
              mediaKind: input.mediaKind,
              /**
               * The stored file's own URL, so the preview and the delivered
               * bubble render the same bytes and the image does not visibly
               * reload when the server row arrives.
               */
              url: input.fileUrl ?? null,
              fileName: input.filename,
              mimeType: null,
              sizeBytes: null,
              caption: input.caption,
              ...(input.voice === undefined ? {} : { isVoice: input.voice }),
              spec: {
                kind: 'media',
                mediaKind: input.mediaKind,
                fileId: input.fileId,
                ...(input.fileUrl === undefined ? {} : { fileUrl: input.fileUrl }),
                ...(input.filePath === undefined ? {} : { filePath: input.filePath }),
                filename: input.filename,
                caption: input.caption,
                ...(input.voice === undefined ? {} : { voice: input.voice }),
              },
            },
          ),
        (clientToken) =>
          actions.sendMedia({
            threadId: id,
            clientToken,
            mediaKind: input.mediaKind,
            fileId: input.fileId,
            ...(input.fileUrl === undefined ? {} : { fileUrl: input.fileUrl }),
            ...(input.filePath === undefined ? {} : { filePath: input.filePath }),
            filename: input.filename,
            caption: input.caption,
            ...(input.voice === undefined ? {} : { voice: input.voice }),
            contextWamid: quote?.wamid ?? null,
          }),
      ).then((accepted) => {
        if (accepted) setReplyTarget((current) => current === quote ? null : current);
        return accepted;
      });
    },
    [actions, perform, replyTarget, thread],
  );

  const sendLocation = useCallback(
    (location: {
      latitude: number;
      longitude: number;
      name: string | null;
      address: string | null;
    }) => {
      const id = thread?.id;

      if (id === undefined) return Promise.resolve(false);

      const quote = replyTarget;

      return perform(
        (clientToken) => optimisticLocation({ threadId: id, clientToken, quote }, location),
        (clientToken) =>
          actions.sendLocation({
            threadId: id,
            clientToken,
            ...location,
            contextWamid: quote?.wamid ?? null,
          }),
      ).then((accepted) => {
        if (accepted) setReplyTarget((current) => current === quote ? null : current);
        return accepted;
      });
    },
    [actions, perform, replyTarget, thread],
  );

  const sendContact = useCallback(
    (contact: ContactCardProjection) => {
      const id = thread?.id;

      if (id === undefined) return Promise.resolve(false);

      const quote = replyTarget;

      return perform(
        (clientToken) => optimisticContacts({ threadId: id, clientToken, quote }, [contact]),
        (clientToken) =>
          actions.sendContacts({
            threadId: id,
            clientToken,
            /**
             * Meta's own contact shape, assembled here rather than in the panel
             * so the panel stays a form over a product model and the wire
             * format has exactly one author.
             */
            contacts: [
              {
                name: {
                  formatted_name: contact.formattedName ?? contact.firstName ?? '',
                  first_name: contact.firstName ?? contact.formattedName ?? '',
                },
                ...(contact.organization === null
                  ? {}
                  : { org: { company: contact.organization } }),
                ...(contact.phones.length === 0
                  ? {}
                  : {
                      phones: contact.phones.map((phone) => ({
                        phone: phone.phone,
                        type: phone.type ?? 'CELL',
                      })),
                    }),
              },
            ],
            contextWamid: quote?.wamid ?? null,
          }),
      ).then((accepted) => {
        if (accepted) setReplyTarget((current) => current === quote ? null : current);
        return accepted;
      });
    },
    [actions, perform, replyTarget, thread],
  );

  /**
   * Interactive sends also return field-addressed validation errors.
   *
   * A builder must not close on a refusal: the route's field-addressed errors
   * have nowhere to go once the form is gone, and the rep would be left with a
   * failed bubble and no way to see which box caused it. So this resolves to
   * whether the send was accepted, and the composer closes the panel only then.
   */
  const sendInteractive = useCallback(
    async (interactive: Record<string, unknown>): Promise<boolean> => {
      const id = thread?.id;

      if (id === undefined) return false;

      const quote = replyTarget;

      const accepted = await perform(
        (clientToken) =>
          optimisticInteractive(
            { threadId: id, clientToken, quote },
            projectInteractive(interactive),
          ),
        (clientToken) =>
          actions.sendInteractive({
            threadId: id,
            clientToken,
            interactive,
            contextWamid: quote?.wamid ?? null,
          }),
      );

      if (accepted) setReplyTarget((current) => current === quote ? null : current);

      return accepted;
    },
    [actions, perform, replyTarget, thread],
  );

  /**
   * A reaction, which is not a message.
   *
   * It gets no optimistic bubble — the feed drops reaction rows, so nothing
   * would ever settle it — and no `isSending`, because a rep must be able to
   * keep typing while a 👍 is in flight. What it gets is the chip, immediately,
   * rolled back if the route refuses.
   */
  const react = useCallback(
    async (message: MessageProjection, emoji: string) => {
      const id = thread?.id;
      const target = message.wamid;

      if (id === undefined || target === null) return;

      const previous = message.reactions.find((reaction) => reaction.isMine)?.emoji ?? '';

      setPendingReactions((current) => ({ ...current, [target]: emoji }));

      try {
        const outcome = await actions.sendReaction({
          threadId: id,
          clientToken: newClientToken(),
          targetWamid: target,
          emoji,
        });

        if (outcome.ok) {
          feed.refresh();

          return;
        }

        setPendingReactions((current) => ({ ...current, [target]: previous }));

        if (outcome.kind === 'denied') setRefusal(outcome.code);
        else setActionError(outcome.kind === 'error' ? outcome.message : t('builder.invalid'));
      } catch (error) {
        setPendingReactions((current) => ({ ...current, [target]: previous }));
        setActionError(error instanceof Error ? error.message : t('error.unknown'));
      }
    },
    [actions, feed, t, thread],
  );

  /**
   * Choosing a message to reply to.
   *
   * The quote is built here, from the message already on screen, rather than
   * asked of the server: the strip must appear on the press, and the projection
   * that builds it is the same pure function the feed route uses — so the strip
   * above the composer and the strip inside the delivered bubble cannot
   * describe the message differently.
   */
  const reply = useCallback(
    (message: MessageProjection) => {
      setReplyTarget(
        projectQuote(
          {
            wamid: message.wamid,
            direction: message.direction,
            type: message.type,
            content: message.content,
            media: message.media,
          },
          contactLabel,
        ),
      );
    },
    [contactLabel],
  );

  /**
   * Everything a thread action has to wake up: this pane, and whatever is
   * showing the conversation *as a row* beside it (D-64).
   *
   * The list and the filter totals are separate polls on separate clocks —
   * eight seconds and thirty — so an action taken here used to leave the row
   * reading "unassigned" and the "Mine" badge a number short for long enough
   * that the honest reading of the screen was that nothing had happened.
   */
  const refreshAll = useCallback(() => {
    feed.refresh();
    onThreadChanged?.();
  }, [feed, onThreadChanged]);

  /**
   * Opening the conversation is what reads it, so opening it clears the badge.
   *
   * The route zeroes `unreadCount` unconditionally and treats the WhatsApp read
   * receipt as optional on top (`WA_SEND_READ_RECEIPTS`) — but nothing called
   * it, so the badge survived the very act that made it wrong. Guarded per
   * conversation id rather than per count: an inbound message arriving *while
   * the rep is looking at the thread* bumps the count again, and that second
   * rise is also read the moment it renders.
   */
  const markedRead = useRef<string | null>(null);

  useEffect(() => {
    if (thread === null || !canSend) return;
    if ((thread.unreadCount ?? 0) === 0) {
      // The server confirmed zero, so the guard has done its job; clearing it
      // lets a message that arrives while the thread is open be marked too.
      markedRead.current = null;

      return;
    }
    if (markedRead.current === thread.id) return;

    markedRead.current = thread.id;

    void actions.threadAction('markRead', { threadId: thread.id }).then((outcome) => {
      // The list beside this pane shows the badge; it has to hear the zero.
      if (outcome.ok) refreshAll();
      else markedRead.current = null;
    });
  }, [actions, canSend, refreshAll, thread]);

  /**
   * A Person created from a contact card the customer shared.
   *
   * The name and number sent are the *card's*, which is what the rep has just
   * read on screen beside the warning that these are a third party's details —
   * so the review the spec asks for is the card itself, and the button is the
   * confirmation. The route re-checks the number and refuses one it cannot
   * normalise rather than storing a fragment.
   *
   * A refresh follows because the match is resolved server-side: the very next
   * poll turns **Create person** into **Open person**, which is the feedback
   * that the record now exists.
   */
  const createPerson = useCallback(
    async (contact: ContactCardProjection) => {
      if (thread === null) return;

      const key = contactKey(contact);

      /**
       * Guarded, because this button has no optimistic state: it stops being
       * offered only when the *server's* next poll reports a match, up to three
       * seconds later. A rep who presses twice in that window creates the same
       * person twice — which is not a hypothetical, it is what happened the
       * first time this was exercised.
       */
      if (creatingContacts.has(key)) return;

      setCreatingContacts((current) => new Set(current).add(key));

      const full = contact.formattedName ?? contact.firstName ?? '';
      const parts = full.trim().split(/\s+/);

      try {
        const outcome = await actions.threadAction('createPerson', {
          threadId: thread.id,
          firstName: contact.firstName ?? parts[0] ?? '',
          lastName: contact.lastName ?? parts.slice(1).join(' '),
          phone: contact.phones[0]?.waId ?? contact.phones[0]?.phone ?? '',
        });

        if (!outcome.ok) setActionError(outcome.error ?? t('error.unknown'));
        else setActionError(null);

        // The row's contact name changes too, so the list has to hear about it.
        refreshAll();
      } finally {
        /**
         * Released on both paths. A key left in the set would leave the button
         * permanently disabled after one failure — the create is retryable, and
         * a failed one leaves nothing behind to collide with.
         */
        setCreatingContacts((current) => {
          const next = new Set(current);

          next.delete(key);

          return next;
        });
      }
    },
    [actions, creatingContacts, refreshAll, t, thread],
  );

  /**
   * "Repetir" sends the same text again as a *new* message, with a new token.
   *
   * There is no re-queue route, and inventing one would mean reviving a record
   * the sender already decided about. A failed message never reached Meta —
   * that is what `FAILED` means after D-25 — so a fresh send is both safe and
   * the honest description of what is happening.
   */
  const retry = useCallback(
    (message: MessageProjection) => {
      /**
       * An attachment is retried from the *spec the send was built from*, not
       * from its text — a media bubble's `body` is only its caption, and a
       * caption-less photo therefore had nothing to press again with. The spec
       * is on the row already (the `payload` column is what the sender rebuilds
       * the wire form from), so the retry sends the same file rather than
       * asking the rep to find it a second time (D-58).
       */
      const spec = message.payload;

      if (spec?.kind === 'media') {
        const kind = spec.mediaKind;

        if (kind === 'image' || kind === 'video' || kind === 'audio' || kind === 'document') {
          sendMedia({
            mediaKind: kind,
            ...(message.media?.url ? { fileUrl: message.media.url } : {
              ...(typeof spec.fileUrl === 'string' ? { fileUrl: spec.fileUrl } : {}),
              ...(typeof spec.filePath === 'string' ? { filePath: spec.filePath } : {}),
            }),
            filename: typeof spec.filename === 'string' ? spec.filename : null,
            caption: typeof spec.caption === 'string' ? spec.caption : null,
            ...(spec.voice === true ? { voice: true } : {}),
          });

          return;
        }
      }

      if (message.body !== null) sendText(message.body);
    },
    [sendMedia, sendText],
  );

  /**
   * Blocking asks first; unblocking does not.
   *
   * Block is the strongest thing a rep can do to a conversation — every send
   * is refused and campaigns exclude it from the moment it lands — and the
   * button sits beside Assign and Close, where a misclick is ordinary. The
   * host's modal, not `window.confirm`: a browser dialog blocks the worker's
   * whole message channel. Unblock stays one click, because it *is* the undo.
   */
  const runThreadAction = useCallback(async (
    action: ThreadActionName,
    input: Record<string, unknown> = {},
    confirmBlock = false,
  ) => {
    if (thread === null || threadActing.current) return;
    threadActing.current = true;
    setThreadBusy(true);
    setActionError(null);
    try {
      if (confirmBlock) {
        const answer = await openCommandConfirmationModal({
          title: t('chat.blockConfirmTitle'), subtitle: t('chat.blockConfirmSubtitle'),
          confirmButtonText: t('chat.block'), confirmButtonAccent: 'danger',
        });
        if (answer !== 'confirm') return;
      }
      const outcome = await actions.threadAction(action, { threadId: thread.id, ...input });
      if (!outcome.ok) setActionError(outcome.error ?? t('chat.actionFailed'));
      else refreshAll();
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : t('chat.actionFailed'));
    } finally {
      threadActing.current = false;
      setThreadBusy(false);
    }
  }, [actions, refreshAll, t, thread]);

  const toggleBlock = useCallback(() => {
    if (thread) void runThreadAction(thread.isBlocked ? 'unblock' : 'block', {}, !thread.isBlocked);
  }, [runThreadAction, thread]);

  const toggleClose = useCallback(() => {
    if (thread) void runThreadAction(thread.status === 'CLOSED' ? 'reopen' : 'close');
  }, [runThreadAction, thread]);

  const toggleAssign = useCallback(() => {
    if (thread && viewerId) void runThreadAction('assign', {
      assigneeId: thread.assigneeId === viewerId ? null : viewerId,
    });
  }, [runThreadAction, thread, viewerId]);

  /**
   * Opening a conversation with a contact who has none.
   *
   * There is no thread to name, so the send route is addressed by account and
   * `waId` instead — both resolved by the server, because a `waId` assembled in
   * the browser from a display string is how a template reaches the wrong
   * person (see the feed route's person branch).
   */
  const startWithTemplate = useCallback(
    async (templateId: string, parameters: ResolvedParameters) => {
      const start = feed.data?.start;

      if (start?.waId === null || start?.waId === undefined || sending.current) return false;
      sending.current = true;
      setActionError(null);

      const clientToken = newClientToken();

      setIsSending(true);

      try {
        const outcome = await actions.sendTemplate({
          ...(start.accountId === null ? {} : { accountId: start.accountId }),
          waId: start.waId,
          templateId,
          parameters,
          clientToken,
        });

        if (outcome.ok) {
          setRefusal(null);
          // The conversation now exists; the next read is what makes it appear.
          feed.refresh();
        } else if (outcome.kind === 'denied') {
          setRefusal(outcome.code);
        } else {
          setRefusal(null);
          setActionError(outcome.kind === 'invalid' ? t('builder.invalid') : refusalCopy(t, outcome.message, outcome.detail));
        }
        return outcome.ok;
      } catch (error) {
        setActionError(error instanceof Error ? error.message : t('error.unknown'));
        return false;
      } finally {
        sending.current = false;
        setIsSending(false);
      }
    },
    [actions, feed, t],
  );

  const shell: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    /**
     * The widget owns its own height and never grows the page. `height: 100%`
     * alone did not achieve that — the pane sizes itself to us, not the other
     * way round — so the cap is what actually holds. See `SURFACE_MAX_HEIGHT`.
     */
    /**
     * Only the record *tab* needs the cap.
     *
     * There the parent is a page-layout grid row sized from our content, so a
     * percentage means nothing and the cap is the only thing holding. In the
     * inbox and the side panel the parent is already a bounded flex child, and
     * applying the cap there does the opposite of its job: it clamps the
     * conversation to 72vh inside a pane that is taller, leaving dead space
     * under the composer.
     */
    ...(variant === 'tab' ? { maxHeight: SURFACE_MAX_HEIGHT } : {}),
    minHeight: variant === 'tab' ? SURFACE_MIN_HEIGHT : 0,
    background: theme.background.primary,
    color: theme.font.color.primary,
    fontFamily: theme.font.family,
    overflow: 'hidden',
  };

  /**
   * Nothing loaded, and a reason. Rendering the ordinary shell here would show
   * "no messages in this conversation yet" over a conversation the app simply
   * could not read — which is what a 403 looked like before D-53.
   */
  if (feed.isUnavailable) {
    return (
      <div className="wa-surface wa-thread-view" style={{ ...shell, justifyContent: 'center' }}>
        <SurfaceStyles />
        <EmptyState
          icon="warning"
          title={t('common.unavailable')}
          body={feed.error ?? undefined}
          actions={
            <ActionButton label={t('common.retry')} icon="retry" onClick={feed.refresh} />
          }
        />
      </div>
    );
  }

  if (feed.data === null) {
    return (
      <div className="wa-surface wa-thread-view" style={{ ...shell, justifyContent: 'center' }} {...feed.rootProps}>
        <SurfaceStyles />
        <Banner>{t('common.loading')}</Banner>
      </div>
    );
  }

  if (thread === null) {
    return (
      <div className="wa-surface wa-thread-view" style={{ ...shell, justifyContent: 'center' }}>
        <SurfaceStyles />
        {actionError === null ? null : <Banner tone="danger">{actionError}</Banner>}
        {refusal === null ? null : <Banner tone="danger">{t(`policy.${refusal}`)}</Banner>}
        <StartConversation
          fieldMetadataId={feed.data?.uploadTargets?.messageMediaFieldMetadataId}
          policy={feed.data.policy}
          templates={templates}
          start={feed.data.start}
          canSend={canSend}
          isSending={isSending}
          t={t}
          onSendTemplate={startWithTemplate}
        />
      </div>
    );
  }

  return (
    <div className="wa-surface wa-thread-view" style={shell} {...feed.rootProps}>
      <SurfaceStyles />
      {feed.isSuspended ? (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: theme.spacing[2],
            padding: `${theme.spacing[1]} ${theme.spacing[2]}`,
            fontSize: theme.font.size.xs,
            background: theme.background.transparent.light,
            color: theme.font.color.secondary,
          }}
        >
          <span>{t('chat.suspended')}</span>
          <button
            type="button"
            onClick={feed.resume}
            aria-label={t('chat.reconnect')}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: theme.spacing[1],
              minHeight: '32px',
              border: `1px solid ${theme.border.color.medium}`,
              borderRadius: theme.border.radius.sm,
              background: 'transparent',
              color: theme.font.color.secondary,
              cursor: 'pointer',
              fontFamily: theme.font.family,
              fontSize: theme.font.size.xs,
              padding: `0 ${theme.spacing[2]}`,
            }}
          >
            <Glyph name="retry" />
            {t('chat.reconnect')}
          </button>
        </div>
      ) : null}

      {feed.isStale ? (
        <div
          role="status"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: theme.spacing[1],
            padding: `${theme.spacing[1]} ${theme.spacing[2]}`,
            fontSize: theme.font.size.xs,
            background: theme.background.transparent.danger,
            color: theme.font.color.danger,
          }}
        >
          <Glyph name="warning" />
          {t('chat.offline')}
        </div>
      ) : null}

      {actionError === null ? null : <Banner tone="danger">{actionError}</Banner>}

      {thread === null ? null : (
        <ThreadHeader
          thread={thread}
          busy={threadBusy}
          account={account}
          t={t}
          now={now}
          viewerId={viewerId}
          onToggleBlock={canSend ? toggleBlock : undefined}
          onClose={canSend ? toggleClose : undefined}
          onAssign={canSend && viewerId !== null ? toggleAssign : undefined}
        />
      )}

      <MessageList
        messages={messages}
        lang={lang}
        t={t}
        now={now}
        hasOlder={feed.hasOlder}
        isLoading={feed.isLoading}
        contactLabel={contactLabel}
        callbacks={
          canSend
            ? {
                onCreatePerson: (contact) => void createPerson(contact),
                creatingContacts,
              }
            : {}
        }
        onLoadOlder={feed.loadOlder}
        {...(canSend ? { onRetry: retry } : {})}
        {...(canSend ? { onReply: reply } : {})}
        {...(capabilities?.reaction.allowed === true
          ? { onReact: (message, emoji) => void react(message, emoji) }
          : {})}
      />

      <Composer
        policy={feed.data?.policy}
        capabilities={capabilities}
        templates={templates}
        canSend={canSend}
        t={t}
        isSending={isSending}
        refusal={refusal}
        fieldErrors={fieldErrors}
        replyTarget={replyTarget}
        person={person}
        recentFiles={recentFiles}
        fieldMetadataId={feed.data?.uploadTargets?.messageMediaFieldMetadataId}
        onSendText={sendText}
        onSendTemplate={sendTemplate}
        onSendMedia={sendMedia}
        onSendLocation={sendLocation}
        onSendContact={sendContact}
        onSendInteractive={sendInteractive}
        onCancelReply={() => setReplyTarget(null)}
        onDismissRefusal={() => setRefusal(null)}
      />
    </div>
  );
};
