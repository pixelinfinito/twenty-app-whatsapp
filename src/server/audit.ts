import { redactForLog, logger } from './logger';
import { toolScope } from './tool-scope';

/**
 * Audited actions (SEC-10, SEC-12).
 *
 * Every entry is written twice on purpose: a structured log line, which
 * survives a record purge and is what an incident investigation greps, and —
 * where the action concerns a Person — a timeline activity, which is where a
 * colleague looking at the record will actually see it. Neither alone answers
 * the question an auditor asks.
 *
 * The highest-stakes entry is a campaign launch. It records the full audience
 * definition, the recipient count, the exclusion breakdown and the template, so
 * "who sent 5 000 messages, to whom, and on what basis" is answerable months
 * later without reconstructing state that no longer exists.
 */

export const AUDIT_ACTION = {
  TEMPLATE_SEND: 'template.send',
  CONSENT_CHANGE: 'consent.change',
  THREAD_ASSIGN: 'thread.assign',
  THREAD_RELINK: 'thread.relink',
  THREAD_BLOCK: 'thread.block',
  TEMPLATE_PUBLISH: 'template.publish',
  TEMPLATE_UNPUBLISH: 'template.unpublish',
  ACCOUNT_CONNECT: 'account.connect',
  ACCOUNT_DISCONNECT: 'account.disconnect',
  ACCOUNT_SETTINGS: 'account.settings',
  CAMPAIGN_CREATE: 'campaign.create',
  CAMPAIGN_LAUNCH: 'campaign.launch',
  CAMPAIGN_PAUSE: 'campaign.pause',
  CAMPAIGN_RESUME: 'campaign.resume',
  CAMPAIGN_CANCEL: 'campaign.cancel',
  /**
   * Only ever a campaign that never sent anything — the rule in
   * `canDeleteCampaign` refuses the rest. Audited anyway: the line is what
   * answers "where did the campaign I built on Friday go", which is otherwise
   * unanswerable once the row is gone.
   */
  CAMPAIGN_DELETE: 'campaign.delete',
  /**
   * Visibility, not content — but audited, because "the campaign is not on the
   * page" and "the campaign was deleted" look identical to whoever comes
   * looking, and only one of them is true.
   */
  CAMPAIGN_ARCHIVE: 'campaign.archive',
  CAMPAIGN_UNARCHIVE: 'campaign.unarchive',
  WEBHOOK_REPLAY: 'webhook.replay',
  /**
   * A contact created from a card a customer shared.
   *
   * Audited because the subject never consented to being in this CRM and is
   * not the person who was messaging — "who put this record here, and from
   * what" is the question a data-subject request asks, and without this line
   * the answer is a Person row with no provenance at all (R-11).
   */
  PERSON_CREATED_FROM_CARD: 'person.created_from_card',
  ERASURE: 'person.erasure',
} as const;
export type AuditAction = (typeof AUDIT_ACTION)[keyof typeof AUDIT_ACTION];

export type AuditEntry = {
  action: AuditAction;
  /** The workspace member who did it; null for automatic system actions. */
  actorId: string | null;
  /** What it was done to. */
  subject: {
    personId?: string | null;
    threadId?: string | null;
    campaignId?: string | null;
    templateId?: string | null;
    accountId?: string | null;
  };
  details?: Record<string, unknown>;
  occurredAt?: Date;
};

/**
 * A field-level diff with secrets excluded.
 *
 * Settings changes are audited by *what changed*, not by the whole record: a
 * dump would grow to include a token the moment someone adds one, and the
 * before/after pair is what an investigation actually needs.
 */
export const diffFields = <T extends Record<string, unknown>>(
  before: T,
  after: Partial<T>,
): Record<string, { from: unknown; to: unknown }> =>
  Object.fromEntries(
    Object.entries(after)
      .filter(([key, value]) => before[key] !== value)
      .map(([key, value]) => [key, { from: before[key], to: value }]),
  );

/**
 * Auditing must never fail the action it records — an assignment that threw
 * because its audit line could not be written would be worse than an
 * unaudited assignment. The failure is itself logged.
 */
export const audit = ({
  action,
  actorId,
  subject,
  details = {},
  occurredAt = new Date(),
}: AuditEntry): void => {
  logger.info(`wa.audit.${action}`, {
    correlationId: subject.campaignId ?? subject.threadId ?? subject.personId ?? null,
    actorId,
    occurredAt: occurredAt.toISOString(),
    ...subject,
    details: redactForLog({
      ...details,
      ...(toolScope() ? { initiatedBy: toolScope()!.principal } : {}),
    }),
  });
};
