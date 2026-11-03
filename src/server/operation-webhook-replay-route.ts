import { Response, type LogicFunctionExecutionContext, type RoutePayload } from 'twenty-sdk/logic-function';

import {
  WEBHOOK_PROCESSING_STATUS,
  type WebhookProcessingStatus,
} from '../domain/constants';
import type { MetaChange } from '../domain/webhook/types';
import { AUDIT_ACTION, audit } from '../server/audit';
import { authErrorResponse, requireCaller, requireRole } from '../server/auth';
import { enqueueAll } from '../server/jobs';
import { describeError, logger } from '../server/logger';
import { findAccountById } from '../server/repositories/accounts';
import { asJson } from '../server/repositories/base';
import { findThreadById } from '../server/repositories/threads';
import {
  countWebhookEvents,
  findWebhookEventsByIds,
  listWebhookEvents,
  markWebhookEvent,
  type WhatsappWebhookEventRecord,
} from '../server/repositories/webhook-events';
import { accountForChange, jobsForChange } from '../logic-functions/wa-webhook-ingest';

/**
 * Replay and reconciliation (TRD §12.4, NFR-R1, specs/11 §6).
 *
 * Meta retries a webhook for seven days and offers **no replay API**, so
 * `whatsappWebhookEvent` is the only place history can be reprocessed from —
 * which is why its retention floor is seven days and why nothing is ever
 * discarded before a row exists.
 *
 * **Replaying is safe by construction, not by care.** Every processor is
 * idempotent on the WAMID (D-12, AR-8): a replayed inbound message finds its
 * row and stops, a replayed status is filtered by the monotonic state machine.
 * That property is what makes this route usable — an operator staring at a
 * broken conversation will press the button twice, and it has to be true that
 * doing so costs nothing.
 *
 * The route re-enqueues the **original** payload through the **same** fan-out
 * the live path uses (`jobsForChange`). A second, replay-specific dispatcher
 * would be a copy of the routing table that drifts, and the drift would only
 * show up during an incident.
 */

export type ReplayAction = 'list' | 'replay' | 'replayFailed' | 'resyncThread';

export type ReplayRouteBody = {
  action?: ReplayAction;
  eventIds?: unknown;
  /** `list`: `RECEIVED` · `PROCESSED` · `FAILED` · `SKIPPED_DUPLICATE`. */
  statuses?: unknown;
  since?: unknown;
  until?: unknown;
  threadId?: unknown;
  /** `replayFailed` / `resyncThread`: return the count and enqueue nothing. */
  dryRun?: unknown;
  limit?: unknown;
  after?: unknown;
};

/**
 * How many events one request will re-drive.
 *
 * Not a performance limit — a blast-radius limit. "Replay everything that
 * failed this month" against a workspace with a bad token for a week is tens of
 * thousands of jobs issued from a single click, and the operator who clicked it
 * cannot stop them. Capped, reported as capped, and repeatable.
 */
export const MAX_REPLAY_PER_REQUEST = 200;

/** Bounds the diagnostics list, which a human reads rather than a machine. */
export const MAX_LIST = 200;

const STATUSES = new Set<string>(Object.values(WEBHOOK_PROCESSING_STATUS));

export const parseStatuses = (value: unknown): WebhookProcessingStatus[] => {
  if (!Array.isArray(value)) return [];

  return [
    ...new Set(
      value
        .map((entry) => (typeof entry === 'string' ? entry.trim().toUpperCase() : ''))
        .filter((entry): entry is WebhookProcessingStatus => STATUSES.has(entry)),
    ),
  ];
};

export const parseIds = (value: unknown): string[] =>
  Array.isArray(value)
    ? [
        ...new Set(
          value
            .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
            .filter((entry) => entry.length > 0),
        ),
      ]
    : [];

/**
 * A date the operator supplied, or null.
 *
 * An unparseable date returns null rather than "now" or "the epoch": those two
 * mistakes bound a bulk replay at nothing and at everything respectively, and
 * neither would be visible in the confirmation the operator reads.
 */
export const parseDate = (value: unknown): Date | null => {
  if (typeof value !== 'string' || value.trim().length === 0) return null;

  const parsed = new Date(value.trim());

  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

export const parseLimit = (value: unknown, ceiling: number): number => {
  const parsed = typeof value === 'number' ? value : Number(value);

  if (!Number.isFinite(parsed) || parsed <= 0) return ceiling;

  return Math.min(ceiling, Math.trunc(parsed));
};

/** The stored payload, as ingest wrote it: one change plus its entry id. */
export type StoredChange = MetaChange & { _entryId?: string | null };

export type ReplayOutcome = {
  eventId: string;
  replayed: boolean;
  jobs: number;
  /** Machine codes; the settings tab owns the wording (specs/01 §7). */
  reason?: 'no_payload' | 'foreign' | 'unhandled' | 'enqueue_failed';
};

/**
 * Re-drives one stored event.
 *
 * The account is resolved from the payload rather than remembered, because the
 * stored row does not carry one — and resolving it the same way ingest does is
 * what keeps a replay from landing in a different account than the original, or
 * from being refused as another tenant's traffic when the number has since been
 * reconnected.
 */
export const replayEvent = async (
  event: WhatsappWebhookEventRecord,
): Promise<ReplayOutcome> => {
  const stored = asJson<StoredChange | null>(event.payload, null);

  if (stored === null || typeof stored !== 'object') {
    return { eventId: event.id, replayed: false, jobs: 0, reason: 'no_payload' };
  }

  const change: MetaChange = { field: stored.field, value: stored.value };
  const account = await accountForChange({ id: stored._entryId ?? undefined }, change);

  if (account === null) {
    return { eventId: event.id, replayed: false, jobs: 0, reason: 'foreign' };
  }

  const jobs = jobsForChange({
    change,
    webhookEventId: event.id,
    accountId: account.id,
    correlationId: event.dedupKey ?? event.id,
  });

  /**
   * Nothing to re-drive. A field the app does not handle was marked `PROCESSED`
   * at ingest with "unhandled field", and replaying it would produce the same
   * nothing — so it is reported rather than silently counted as a success.
   */
  if (jobs.length === 0) {
    return { eventId: event.id, replayed: false, jobs: 0, reason: 'unhandled' };
  }

  const enqueued = await enqueueAll(jobs);

  if (enqueued === 0) {
    return { eventId: event.id, replayed: false, jobs: 0, reason: 'enqueue_failed' };
  }

  /**
   * Marked in flight only *after* something was actually queued.
   *
   * The order matters in the failure case: marking first and then failing to
   * enqueue would take the row out of the failed list with nothing scheduled to
   * process it — the one state in which an operator has no way to notice the
   * event was lost.
   */
  await markWebhookEvent(event.id, WEBHOOK_PROCESSING_STATUS.RECEIVED, null);

  return { eventId: event.id, replayed: true, jobs: enqueued };
};

const replayMany = async (
  events: WhatsappWebhookEventRecord[],
): Promise<{ outcomes: ReplayOutcome[]; replayed: number; jobs: number }> => {
  const outcomes: ReplayOutcome[] = [];

  for (const event of events) {
    try {
      outcomes.push(await replayEvent(event));
    } catch (error) {
      logger.warn('wa.replay.event_failed', {
        fn: 'wa-webhook-replay-route',
        correlationId: event.id,
        ...describeError(error),
      });

      outcomes.push({
        eventId: event.id,
        replayed: false,
        jobs: 0,
        reason: 'enqueue_failed',
      });
    }
  }

  return {
    outcomes,
    replayed: outcomes.filter((outcome) => outcome.replayed).length,
    jobs: outcomes.reduce((total, outcome) => total + outcome.jobs, 0),
  };
};

/**
 * Everything in the raw log that mentions this conversation.
 *
 * "Resync a thread" cannot mean asking Meta — there is no endpoint that returns
 * a conversation's history or a message's current status. What it can mean, and
 * what is actually useful, is re-driving the stored events for that number: the
 * inbound messages and the statuses, through the same processors, from the same
 * bytes. The search is a `like` over serialised JSON, which is why it is bounded
 * by the retention window and a limit and lives on an admin-only route.
 */
export const eventsForThread = async (
  threadId: string,
  since: Date | null,
  limit: number,
): Promise<
  { ok: true; events: WhatsappWebhookEventRecord[]; waId: string } | { ok: false; error: string }
> => {
  const thread = await findThreadById(threadId);

  if (thread === null) return { ok: false, error: 'Unknown thread' };

  const waId = typeof thread.waId === 'string' ? thread.waId : '';

  if (waId.length === 0) {
    return { ok: false, error: 'The conversation has no WhatsApp id to search for' };
  }

  /**
   * Scoped to the thread's own account. Two numbers in one workspace can hold a
   * conversation with the same contact, and re-driving the other one's events
   * would write messages into a conversation they do not belong to.
   */
  const account =
    typeof thread.accountId === 'string' ? await findAccountById(thread.accountId) : null;

  if (account === null) {
    return { ok: false, error: 'The conversation has no connected number' };
  }

  const { items } = await listWebhookEvents({ payloadContains: waId, since, limit });

  const phoneNumberId = account.phoneNumberId ?? null;

  const events = items.filter((event) => {
    const stored = asJson<StoredChange | null>(event.payload, null);
    const metadataId = stored?.value?.metadata?.phone_number_id ?? null;

    /**
     * A change with no `phone_number_id` — a template or account event — is not
     * about a conversation at all, so it is dropped rather than guessed at.
     */
    return metadataId !== null && metadataId === phoneNumberId;
  });

  return { ok: true, events, waId };
};

export const handler = async (event: RoutePayload<ReplayRouteBody>, executionContext?: LogicFunctionExecutionContext): Promise<Response> => {
  const log = logger.child({ fn: 'wa-webhook-replay-route' });

  try {
    const caller = await requireCaller(event, executionContext);

    /**
     * Admin for every action, including the read. The payloads hold message
     * bodies, phone numbers and profile names — the raw log is the most
     * sensitive table the app owns, and reading it is an operator's job, not an
     * agent's (SEC-5, SEC-7).
     */
    requireRole(caller, 'admin');

    const body = event.body ?? {};
    const action = body.action ?? 'list';

    switch (action) {
      case 'list': {
        const page = await listWebhookEvents({
          statuses: parseStatuses(body.statuses),
          since: parseDate(body.since),
          until: parseDate(body.until),
          limit: parseLimit(body.limit, MAX_LIST),
          after: typeof body.after === 'string' && body.after.length > 0 ? body.after : null,
        });

        return new Response(
          { events: page.items, nextCursor: page.nextCursor },
          { status: 200 },
        );
      }

      case 'replay': {
        const eventIds = parseIds(body.eventIds);

        if (eventIds.length === 0) {
          return new Response({ error: 'eventIds is required' }, { status: 400 });
        }

        if (eventIds.length > MAX_REPLAY_PER_REQUEST) {
          return new Response(
            { error: `At most ${MAX_REPLAY_PER_REQUEST} events per request` },
            { status: 400 },
          );
        }

        const events = await findWebhookEventsByIds(eventIds);

        /**
         * A named id that no longer exists is reported, not ignored. The most
         * likely reason is that the retention purge removed it, and "we replayed
         * 4 of the 6 you selected" is the only answer that lets an operator
         * work out why the fifth conversation is still wrong.
         */
        const found = new Set(events.map((record) => record.id));
        const missing = eventIds.filter((id) => !found.has(id));

        const result = await replayMany(events);

        audit({
          action: AUDIT_ACTION.WEBHOOK_REPLAY,
          actorId: caller.workspaceMemberId,
          subject: {},
          details: {
            requested: eventIds.length,
            replayed: result.replayed,
            jobs: result.jobs,
            missing: missing.length,
          },
        });

        log.warn('wa.replay.completed', {
          requested: eventIds.length,
          replayed: result.replayed,
          jobs: result.jobs,
        });

        return new Response(
          { ...result, requested: eventIds.length, missing },
          { status: 200 },
        );
      }

      /**
       * The bulk path, and the one that needs a number before it needs rows: an
       * operator confirming "replay everything that failed" is entitled to know
       * whether that is nine events or nine thousand. `dryRun` returns exactly
       * the count the confirmation shows.
       */
      case 'replayFailed': {
        const since = parseDate(body.since);
        const until = parseDate(body.until);
        const statuses = [WEBHOOK_PROCESSING_STATUS.FAILED];

        const matching = await countWebhookEvents({ statuses, since, until });

        if (body.dryRun !== false) {
          return new Response(
            {
              dryRun: true,
              matching,
              wouldReplay: Math.min(matching, MAX_REPLAY_PER_REQUEST),
              cap: MAX_REPLAY_PER_REQUEST,
            },
            { status: 200 },
          );
        }

        const { items } = await listWebhookEvents({
          statuses,
          since,
          until,
          limit: MAX_REPLAY_PER_REQUEST,
        });

        const result = await replayMany(items);

        audit({
          action: AUDIT_ACTION.WEBHOOK_REPLAY,
          actorId: caller.workspaceMemberId,
          subject: {},
          details: {
            scope: 'failed',
            since: since?.toISOString() ?? null,
            until: until?.toISOString() ?? null,
            matching,
            replayed: result.replayed,
            jobs: result.jobs,
          },
        });

        log.warn('wa.replay.failed_batch', {
          matching,
          replayed: result.replayed,
          jobs: result.jobs,
        });

        return new Response(
          {
            ...result,
            matching,
            /** True when rows are left over — the operator runs it again. */
            truncated: matching > items.length,
          },
          { status: 200 },
        );
      }

      case 'resyncThread': {
        const threadId = typeof body.threadId === 'string' ? body.threadId.trim() : '';

        if (threadId.length === 0) {
          return new Response({ error: 'threadId is required' }, { status: 400 });
        }

        const found = await eventsForThread(
          threadId,
          parseDate(body.since),
          parseLimit(body.limit, MAX_REPLAY_PER_REQUEST),
        );

        if (!found.ok) return new Response({ error: found.error }, { status: 404 });

        if (body.dryRun !== false) {
          return new Response(
            { dryRun: true, matching: found.events.length },
            { status: 200 },
          );
        }

        const result = await replayMany(found.events);

        audit({
          action: AUDIT_ACTION.WEBHOOK_REPLAY,
          actorId: caller.workspaceMemberId,
          subject: { threadId },
          details: {
            scope: 'thread',
            matching: found.events.length,
            replayed: result.replayed,
            jobs: result.jobs,
          },
        });

        log.warn('wa.replay.thread', {
          correlationId: threadId,
          matching: found.events.length,
          replayed: result.replayed,
        });

        return new Response({ ...result, matching: found.events.length }, { status: 200 });
      }

      default:
        return new Response({ error: `Unknown action: ${String(action)}` }, { status: 400 });
    }
  } catch (error) {
    const authFailure = authErrorResponse(error);

    if (authFailure !== null) {
      return new Response(authFailure.body, { status: authFailure.status });
    }

    log.error('wa.replay.route_failed', describeError(error));

    return new Response({ error: 'Internal error' }, { status: 500 });
  }
};

