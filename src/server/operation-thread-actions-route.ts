import { Response, type LogicFunctionExecutionContext, type RoutePayload } from 'twenty-sdk/logic-function';

import { THREAD_STATUS, type ThreadStatus } from '../domain/constants';
import { splitE164, toE164 } from '../domain/phone/normalise';
import { getProvider } from '../providers/whatsapp';
import { AUDIT_ACTION, audit } from '../server/audit';
import { authErrorResponse, requireCaller, requireRole } from '../server/auth';
import { config, forAccount } from '../server/config';
import { describeError, logger } from '../server/logger';
import { TIMELINE_EVENT, THREAD_OBJECT_UID, writeTimelineActivity } from '../server/timeline';
import { findAccountById } from '../server/repositories/accounts';
import { findNewestInboundWamid } from '../server/repositories/messages';
import {
  createPersonFromWhatsApp,
  findPersonById,
} from '../server/repositories/people';
import {
  findThreadById,
  patchThread,
  type ThreadPatch,
  type WhatsappThreadRecord,
} from '../server/repositories/threads';

/**
 * Everything a rep can do to a conversation that is not sending a message
 * (FR-THR-3, FR-CID-4, FR-CID-5, FR-OUT-8).
 *
 * These live behind one route rather than six because they share the whole
 * preamble — authorise, load the thread, audit the actor — and because the
 * set is small and closed. Each action is a switch arm, not a handler.
 */

export type ThreadAction =
  | 'assign'
  | 'close'
  | 'reopen'
  | 'block'
  | 'unblock'
  | 'link'
  | 'relink'
  | 'markRead'
  | 'snooze'
  | 'createPerson';

export type ThreadActionBody = {
  action?: ThreadAction;
  threadId?: string;
  /** `assign`: null unassigns. */
  assigneeId?: string | null;
  /** `link` / `relink`: null detaches the conversation from any Person. */
  personId?: string | null;
  /** `snooze`: ISO timestamp; null clears. */
  snoozedUntil?: string | null;
  /**
   * `createPerson`: the values a rep **reviewed**, not the raw vCard.
   *
   * The card is third-party data and may carry five numbers; which one becomes
   * the Person's primary is a decision, and this route receives the decision
   * rather than making one (spec §"Shared contacts").
   */
  firstName?: string;
  lastName?: string;
  phone?: string;
};

/**
 * `link` and `relink` are the same operation with different provenance, and
 * that difference is worth keeping: `link` resolves an ambiguous match a human
 * was asked about (FR-CID-5), `relink` overrides one the system already made
 * (FR-CID-4). The audit trail reads very differently for the two.
 */
export const isLinkAction = (action: ThreadAction): boolean =>
  action === 'link' || action === 'relink';

/**
 * Resolving an ambiguous match clears the review state; a re-link on a healthy
 * thread must not change its status at all — a rep fixing an attribution has
 * not reopened a conversation they had closed.
 */
export const statusAfterLink = (
  current: string | null | undefined,
  personId: string | null,
): ThreadStatus | null => {
  if (current !== THREAD_STATUS.NEEDS_REVIEW) return null;

  return personId === null ? null : THREAD_STATUS.OPEN;
};

/**
 * Whether a link request would change anything at all (D-67).
 *
 * Re-linking a conversation to the contact it is already linked to is not an
 * event, and it happens — a rep confirming an attribution, a double-click, a
 * panel re-sending the same body. Each one used to write two timeline
 * activities, one on each end of a move that did not happen, on top of Twenty's
 * own relation entry: a Person's timeline filled with repeated "linked a
 * whatsapp conversation" lines carrying no information.
 *
 * A thread awaiting review is never a no-op even when the person is the same:
 * resolving the review *is* the change, and it clears the disambiguation
 * banner.
 */
export const isRedundantLink = (
  thread: { personId?: string | null; status?: string | null },
  personId: string | null,
): boolean =>
  (thread.personId ?? null) === personId && thread.status !== THREAD_STATUS.NEEDS_REVIEW;

const linkPatch = (
  thread: WhatsappThreadRecord,
  personId: string | null,
): ThreadPatch => {
  const status = statusAfterLink(thread.status, personId);

  return {
    personId,
    /**
     * The candidate list is cleared once a human has decided. Leaving it would
     * keep the disambiguation banner on screen after the question was
     * answered.
     */
    ...(thread.status === THREAD_STATUS.NEEDS_REVIEW ? { linkCandidates: null } : {}),
    ...(status === null ? {} : { status }),
  };
};

/**
 * Marks the conversation read on WhatsApp itself (FR-OUT-8).
 *
 * Deliberately **not** routed through the lane scheduler: a read receipt is not
 * a message, is not billed, and must not consume send capacity that a customer
 * reply is waiting on. It is also entirely optional — a failure here leaves the
 * local unread count correctly zeroed, and the customer simply does not see
 * blue ticks.
 */
const sendReadReceipt = async (thread: WhatsappThreadRecord): Promise<boolean> => {
  if (!config.sendReadReceipts()) return false;

  const account =
    typeof thread.accountId === 'string' ? await findAccountById(thread.accountId) : null;

  if (account === null || typeof account.phoneNumberId !== 'string') return false;

  const wamid = await findNewestInboundWamid(thread.id);
  if (wamid === null) return false;

  try {
    await getProvider().markAsRead({ phoneNumberId: account.phoneNumberId, wamid });

    return true;
  } catch (error) {
    logger.warn('wa.thread.read_receipt_failed', {
      correlationId: thread.id,
      ...describeError(error),
    });

    return false;
  }
};

export const handler = async (
  event: RoutePayload<ThreadActionBody>,
  executionContext?: LogicFunctionExecutionContext,
): Promise<Response> => {
  const log = logger.child({ fn: 'wa-thread-actions-route' });

  try {
    const caller = await requireCaller(event, executionContext);
    requireRole(caller, 'agent');

    const body = event.body ?? {};
    const action = body.action;

    if (action === undefined) {
      return new Response({ error: 'action is required' }, { status: 400 });
    }

    if (typeof body.threadId !== 'string' || body.threadId.length === 0) {
      return new Response({ error: 'threadId is required' }, { status: 400 });
    }

    const thread = await findThreadById(body.threadId);

    if (thread === null) return new Response({ error: 'Unknown thread' }, { status: 404 });

    switch (action) {
      case 'assign': {
        const assigneeId = body.assigneeId ?? null;

        await patchThread(thread.id, { assigneeId });

        audit({
          action: AUDIT_ACTION.THREAD_ASSIGN,
          actorId: caller.workspaceMemberId,
          subject: { threadId: thread.id, personId: thread.personId ?? null },
          details: { from: thread.assigneeId ?? null, to: assigneeId },
        });

        await writeTimelineActivity({
          name: TIMELINE_EVENT.THREAD_ASSIGNED,
          happensAt: new Date(),
          properties: { assigneeId, previousAssigneeId: thread.assigneeId ?? null },
          targetPersonId: thread.personId ?? null,
          linkedRecordId: thread.id,
          linkedObjectUniversalIdentifier: THREAD_OBJECT_UID,
        });

        return new Response({ threadId: thread.id, assigneeId }, { status: 200 });
      }

      case 'close':
      case 'reopen': {
        /**
         * `CLOSED` is a CRM label and nothing more — it does not touch Meta,
         * the service window, or the ability to send. It exists so an inbox
         * filter can hide handled conversations, and any inbound message
         * reopens it regardless (FR-THR-2).
         */
        const status = action === 'close' ? THREAD_STATUS.CLOSED : THREAD_STATUS.OPEN;

        await patchThread(thread.id, { status });

        return new Response({ threadId: thread.id, status }, { status: 200 });
      }

      case 'block':
      case 'unblock': {
        const isBlocked = action === 'block';

        await patchThread(thread.id, { isBlocked });

        /**
         * Audited like assign and relink. Blocking is the strongest thing a rep
         * can do to a conversation — the policy gate refuses every send to a
         * blocked thread and the snapshot excludes it from campaigns — so
         * "who stopped us messaging this customer, and when?" must have an
         * answer that is not a log line (D-38).
         */
        audit({
          action: AUDIT_ACTION.THREAD_BLOCK,
          actorId: caller.workspaceMemberId,
          subject: { threadId: thread.id, personId: thread.personId ?? null },
          details: { from: thread.isBlocked === true, to: isBlocked },
        });

        log.info('wa.thread.block_changed', { correlationId: thread.id, isBlocked });

        return new Response({ threadId: thread.id, isBlocked }, { status: 200 });
      }

      case 'link':
      case 'relink': {
        const personId = body.personId ?? null;

        if (personId !== null && (await findPersonById(personId)) === null) {
          return new Response({ error: 'Unknown person' }, { status: 404 });
        }

        const previousPersonId = thread.personId ?? null;

        if (isRedundantLink(thread, personId)) {
          log.debug('wa.thread.link_unchanged', { correlationId: thread.id });

          return new Response({ threadId: thread.id, personId, changed: false }, { status: 200 });
        }

        await patchThread(thread.id, linkPatch(thread, personId));

        audit({
          action: AUDIT_ACTION.THREAD_RELINK,
          actorId: caller.workspaceMemberId,
          subject: { threadId: thread.id, personId },
          details: { from: previousPersonId, to: personId, resolvedReview: thread.status === THREAD_STATUS.NEEDS_REVIEW },
        });

        /**
         * Written on **both** records. Someone looking at the Person a
         * conversation was moved away from needs to see where it went as much
         * as the new one needs to see where it came from.
         */
        for (const targetPersonId of [previousPersonId, personId]) {
          if (targetPersonId === null) continue;

          await writeTimelineActivity({
            name: TIMELINE_EVENT.THREAD_RELINKED,
            happensAt: new Date(),
            properties: { from: previousPersonId, to: personId, waId: thread.waId ?? null },
            targetPersonId,
            linkedRecordId: thread.id,
            linkedObjectUniversalIdentifier: THREAD_OBJECT_UID,
            /**
             * Named, so the row is not a link to "Untitled" (D-67). The label
             * identifier makes the record readable from now on, but a cached
             * name written here is what the *existing* rows show, and the
             * number is the thing the reader recognises.
             */
            linkedRecordCachedName:
              thread.profileName ?? thread.dialablePhone ?? thread.waId ?? null,
          });
        }

        /**
         * Campaign recipient rows are deliberately **not** rewritten: they
         * record who was targeted at snapshot time, and an audit that changed
         * retroactively would not be one (specs/05 §2.4).
         */
        return new Response({ threadId: thread.id, personId, changed: true }, { status: 200 });
      }

      case 'markRead': {
        await patchThread(thread.id, { unreadCount: 0 });

        const receipt = await sendReadReceipt(thread);

        return new Response({ threadId: thread.id, receiptSent: receipt }, { status: 200 });
      }

      case 'snooze': {
        const snoozedUntil = body.snoozedUntil ?? null;

        await patchThread(thread.id, { snoozedUntil });

        return new Response({ threadId: thread.id, snoozedUntil }, { status: 200 });
      }

      /**
       * A Person created from a shared contact card (spec §"Shared contacts").
       *
       * The card is a *third party's* details, sent by the customer without
       * that person's involvement — so nothing here happens automatically. The
       * rep reviews the name and number in a form first, and the values this
       * route receives are the ones they confirmed, never the raw vCard: a
       * card carrying five numbers must not silently decide which is primary.
       *
       * `createPersonFromWhatsApp` sets consent to `UNKNOWN`, which is exactly
       * right and not incidental — being mentioned in somebody else's message
       * is about as far from marketing consent as a contact can get (R-11).
       */
      case 'createPerson': {
        const firstName = (body.firstName ?? '').trim();
        const lastName = (body.lastName ?? '').trim();
        const phone = (body.phone ?? '').trim();

        if (firstName.length === 0 && lastName.length === 0) {
          return new Response({ error: 'a name is required' }, { status: 400 });
        }

        const account =
          typeof thread.accountId === 'string'
            ? await findAccountById(thread.accountId)
            : null;

        const e164 =
          phone.length === 0
            ? null
            : toE164(
                phone,
                forAccount(
                  account?.defaultCountryCallingCode,
                  config.defaultCountryCallingCode,
                ),
              );

        if (phone.length > 0 && e164 === null) {
          return new Response({ error: 'INVALID_PHONE' }, { status: 400 });
        }

        const parts = e164 === null ? null : splitE164(e164);

        const person = await createPersonFromWhatsApp({
          firstName,
          lastName,
          nationalNumber: parts?.nationalNumber ?? '',
          callingCode: parts?.callingCode ?? '',
          countryCode: null,
        });

        audit({
          action: AUDIT_ACTION.PERSON_CREATED_FROM_CARD,
          actorId: caller.workspaceMemberId,
          subject: { threadId: thread.id, personId: person.id },
          details: { source: 'shared_contact_card' },
        });

        return new Response({ threadId: thread.id, personId: person.id }, { status: 201 });
      }

      default:
        return new Response({ error: `Unknown action: ${String(action)}` }, { status: 400 });
    }
  } catch (error) {
    const authFailure = authErrorResponse(error);

    if (authFailure !== null) {
      return new Response(authFailure.body, { status: authFailure.status });
    }

    log.error('wa.thread.route_failed', describeError(error));

    return new Response({ error: 'Internal error' }, { status: 500 });
  }
};
