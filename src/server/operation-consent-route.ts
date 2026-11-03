import { Response, type LogicFunctionExecutionContext, type RoutePayload } from 'twenty-sdk/logic-function';

import {
  CONSENT_METHOD,
  CONSENT_STATUS,
  type ConsentMethod,
  type ConsentStatus,
} from '../domain/constants';
import { AUDIT_ACTION, audit } from '../server/audit';
import { authErrorResponse, requireCaller, requireRole } from '../server/auth';
import { setConsent } from '../server/consent';
import { erasePerson } from '../server/erasure';
import { describeError, logger } from '../server/logger';
import { METRIC, count } from '../server/metrics';
import { listConsentEvents } from '../server/repositories/consent-events';
import { findPersonById } from '../server/repositories/people';

/**
 * Consent as an operator surface (FR-CON-1, SEC-8, SEC-10, specs/06 §11).
 *
 * Four actions, and the asymmetry between them is the point. Recording a single
 * opt-in is something a rep does in the flow of a conversation; importing five
 * thousand of them, or erasing someone, is an administrative act with an
 * audit trail and a confirmation step.
 *
 * **There is deliberately no "mark everyone opted-in".** Every action here
 * names its subjects, because the wording shown to each of them is the evidence
 * that makes the record worth anything (SEC-11), and a bulk button would
 * inevitably be used without any.
 */

export type ConsentAction = 'set' | 'import' | 'erase' | 'history';

export type ConsentImportRow = {
  personId?: string;
  status?: string;
  wordingShown?: string;
  occurredAt?: string;
  notes?: string;
};

export type ConsentRouteBody = {
  action?: ConsentAction;
  personId?: string;
  status?: string;
  method?: string;
  wordingShown?: string;
  sourceReference?: string;
  notes?: string;
  rows?: ConsentImportRow[];
  /** `erase`: returns the counts that would be deleted and deletes nothing. */
  dryRun?: boolean;
};

/** Batches are capped so one request cannot become an unbounded write storm. */
export const MAX_IMPORT_ROWS = 60;

const CONSENT_STATUSES = new Set<string>([CONSENT_STATUS.OPTED_IN, CONSENT_STATUS.OPTED_OUT]);

/**
 * `UNKNOWN` is not settable, and that is not an oversight.
 *
 * It is the *absence* of a decision, so "setting" it would mean deleting
 * evidence — which is what the erasure routine is for, with an audit trail and
 * a confirmation. Quietly reverting someone to unknown through a normal write
 * would be the easiest possible way to lose an opt-out.
 */
export const parseStatus = (
  value: unknown,
): Exclude<ConsentStatus, 'UNKNOWN'> | null => {
  const upper = typeof value === 'string' ? value.trim().toUpperCase() : '';

  return CONSENT_STATUSES.has(upper)
    ? (upper as Exclude<ConsentStatus, 'UNKNOWN'>)
    : null;
};

const METHODS = new Set<string>(Object.values(CONSENT_METHOD));

export const parseMethod = (value: unknown, fallback: ConsentMethod): ConsentMethod => {
  const upper = typeof value === 'string' ? value.trim().toUpperCase() : '';

  return METHODS.has(upper) ? (upper as ConsentMethod) : fallback;
};

export type ImportOutcome = {
  personId: string;
  applied: boolean;
  reason?: string;
};

export const handler = async (
  event: RoutePayload<ConsentRouteBody>,
  executionContext?: LogicFunctionExecutionContext,
): Promise<Response> => {
  const log = logger.child({ fn: 'wa-consent-route' });

  try {
    const caller = await requireCaller(event, executionContext);

    const body = event.body ?? {};
    const action = body.action ?? 'history';

    switch (action) {
      /**
       * A rep recording consent captured in conversation. Agent-level, because
       * it is part of talking to a customer — but `wordingShown` is required,
       * since a consent record with no record of what was agreed to is not
       * evidence of anything.
       */
      case 'set': {
        requireRole(caller, 'agent');

        const personId = body.personId;
        const status = parseStatus(body.status);

        if (typeof personId !== 'string' || personId.length === 0) {
          return new Response({ error: 'personId is required' }, { status: 400 });
        }

        if (status === null) {
          return new Response(
            { error: 'status must be OPTED_IN or OPTED_OUT' },
            { status: 400 },
          );
        }

        const wordingShown = (body.wordingShown ?? '').trim();

        if (wordingShown.length === 0) {
          return new Response(
            { error: 'wordingShown is required: a consent record without it is not evidence' },
            { status: 400 },
          );
        }

        if ((await findPersonById(personId)) === null) {
          return new Response({ error: 'Unknown person' }, { status: 404 });
        }

        const result = await setConsent({
          personId,
          newStatus: status,
          method: parseMethod(body.method, CONSENT_METHOD.IN_THREAD),
          actorId: caller.workspaceMemberId,
          wordingShown,
          sourceReference: body.sourceReference ?? null,
          notes: body.notes ?? null,
        });

        audit({
          action: AUDIT_ACTION.CONSENT_CHANGE,
          actorId: caller.workspaceMemberId,
          subject: { personId },
          details: { to: status, changed: result.changed, from: result.previousStatus },
        });

        return new Response({ personId, status, changed: result.changed }, { status: 200 });
      }

      /**
       * Bulk, admin-only, and row-by-row rather than all-or-nothing: an import
       * of 60 records where one names a deleted person should apply the other
       * 59 and say which one it skipped, not refuse the lot.
       */
      case 'import': {
        requireRole(caller, 'admin');

        const rows = Array.isArray(body.rows) ? body.rows : [];

        if (rows.length === 0) {
          return new Response({ error: 'rows is required' }, { status: 400 });
        }

        if (rows.length > MAX_IMPORT_ROWS) {
          return new Response(
            { error: `At most ${MAX_IMPORT_ROWS} rows per request` },
            { status: 400 },
          );
        }

        const outcomes: ImportOutcome[] = [];

        for (const row of rows) {
          const personId = row.personId;
          const status = parseStatus(row.status);

          if (typeof personId !== 'string' || personId.length === 0) {
            outcomes.push({ personId: String(personId), applied: false, reason: 'no personId' });
            continue;
          }

          if (status === null) {
            outcomes.push({ personId, applied: false, reason: 'invalid status' });
            continue;
          }

          try {
            const occurredAt =
              typeof row.occurredAt === 'string' ? new Date(row.occurredAt) : new Date();

            const result = await setConsent({
              personId,
              newStatus: status,
              method: CONSENT_METHOD.IMPORT,
              actorId: caller.workspaceMemberId,
              wordingShown: row.wordingShown ?? null,
              notes: row.notes ?? null,
              occurredAt: Number.isNaN(occurredAt.getTime()) ? new Date() : occurredAt,
            });

            outcomes.push({ personId, applied: result.changed });
          } catch (error) {
            log.warn('wa.consent.import_row_failed', { personId, ...describeError(error) });
            outcomes.push({ personId, applied: false, reason: 'write failed' });
          }
        }

        const applied = outcomes.filter((outcome) => outcome.applied).length;

        count(METRIC.CONSENT_IMPORTED, applied);

        audit({
          action: AUDIT_ACTION.CONSENT_CHANGE,
          actorId: caller.workspaceMemberId,
          subject: {},
          details: { imported: applied, submitted: rows.length, method: 'IMPORT' },
        });

        return new Response({ applied, submitted: rows.length, outcomes }, { status: 200 });
      }

      /**
       * The one action with no undo. Admin-only, audited, and offering a dry run
       * that returns the counts so an operator sees the blast radius first.
       */
      case 'erase': {
        requireRole(caller, 'admin');

        const personId = body.personId;

        if (typeof personId !== 'string' || personId.length === 0) {
          return new Response({ error: 'personId is required' }, { status: 400 });
        }

        const dryRun = body.dryRun !== false;

        const result = await erasePerson({
          personId,
          actorId: caller.workspaceMemberId,
          dryRun,
        });

        if (!dryRun) {
          audit({
            action: AUDIT_ACTION.ERASURE,
            actorId: caller.workspaceMemberId,
            subject: { personId },
            details: { ...result },
          });
        }

        return new Response(result, { status: 200 });
      }

      case 'history': {
        requireRole(caller, 'agent');

        const personId = body.personId;

        if (typeof personId !== 'string' || personId.length === 0) {
          return new Response({ error: 'personId is required' }, { status: 400 });
        }

        return new Response({ events: await listConsentEvents(personId) }, { status: 200 });
      }

      default:
        return new Response({ error: `Unknown action: ${String(action)}` }, { status: 400 });
    }
  } catch (error) {
    const authFailure = authErrorResponse(error);

    if (authFailure !== null) {
      return new Response(authFailure.body, { status: authFailure.status });
    }

    log.error('wa.consent.route_failed', describeError(error));

    return new Response({ error: 'Internal error' }, { status: 500 });
  }
};
