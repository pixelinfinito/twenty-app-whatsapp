import {
  ACCOUNT_STATUS,
  CONSENT_STATUS,
  LANE,
  QUALITY,
  type AccountStatus,
  type ConsentStatus,
  type Quality,
  type SourceKind,
  type TemplateCategory,
} from '../domain/constants';
import { toE164, toWaId } from '../domain/phone/normalise';
import {
  DENIAL,
  evaluateSendPermission,
  type Denial,
  type SendContext,
  type Warning,
} from '../domain/policy/send-permission';
import {
  renderTemplateBody,
  validateParameters,
  type ResolvedParameters,
} from '../domain/template-render';
import type { VariableSpec } from '../domain/template-spec';
import { bindWorkflowParameters } from '../domain/workflow-parameters';
import { AUDIT_ACTION, audit } from './audit';
import { personPhones } from './audience';
import { isUniqueViolation } from './batching';
import { config, forAccount } from './config';
import { queueOutbound } from './outbound';
import {
  findAccountById,
  findAccountByPhoneNumberId,
  listAccounts,
  type WhatsappAccountRecord,
} from './repositories/accounts';
import { asJson, isUuid, toDate } from './repositories/base';
import {
  findMessageByClientToken,
  type WhatsappMessageRecord,
} from './repositories/messages';
import { findPersonById, type PersonRecord } from './repositories/people';
import {
  findTemplateById,
  listTemplatesForAccount,
  type WhatsappTemplateRecord,
} from './repositories/templates';
import { findThread, type WhatsappThreadRecord } from './repositories/threads';
import { upsertThread } from './threads';

/** Refusals shared by workflow and agent-triggered template sends. */
export const ACTION_REFUSAL = {
  ...DENIAL,
  PERSON_UNKNOWN: 'PERSON_UNKNOWN',
  ACCOUNT_UNKNOWN: 'ACCOUNT_UNKNOWN',
  ACCOUNT_AMBIGUOUS: 'ACCOUNT_AMBIGUOUS',
  TEMPLATE_UNKNOWN: 'TEMPLATE_UNKNOWN',
  NO_PHONE: 'NO_PHONE',
  MISSING_VARIABLES: 'MISSING_VARIABLES',
  NO_THREAD: 'NO_THREAD',
  IDEMPOTENCY_CONFLICT: 'IDEMPOTENCY_CONFLICT',
} as const;

export type ActionRefusal =
  | (typeof ACTION_REFUSAL)[keyof typeof ACTION_REFUSAL]
  | Denial;

export type AccountResolution = 'workflow' | 'exact';
export type TemplateResolution = 'workflow' | 'exact';

export type TemplateSendSource = {
  sourceKind: SourceKind;
  sentById: string | null;
  requestId: string | null;
  channel: 'WORKFLOW_ACTION' | 'TWENTY_MCP' | 'TWENTY_AI';
  accountResolution: AccountResolution;
  templateResolution: TemplateResolution;
};

export type TemplateSendInput = {
  personId: unknown;
  accountId?: unknown;
  templateId: unknown;
  parameters?: unknown;
  createThreadIfMissing?: unknown;
};

export type TemplateSendResult = {
  status: 'accepted' | 'denied';
  messageId: string | null;
  threadId: string | null;
  denialReason: ActionRefusal | null;
  missingVariables?: string[];
  warnings: Warning[];
  replayed: boolean;
};

export type ResolvedTemplateTarget = {
  person: PersonRecord;
  account: WhatsappAccountRecord;
  waId: string;
  thread: WhatsappThreadRecord | null;
};

const EMPTY_VARIABLE_SPEC: VariableSpec = {
  namedParameters: false,
  header: null,
  body: { variableCount: 0, indices: [], names: [], text: null, example: [] },
  footer: null,
  buttons: [],
  totalVariableCount: 0,
};

export const idOf = (value: unknown): string | null => {
  if (typeof value === 'string') {
    const trimmed = value.trim();

    return trimmed.length === 0 ? null : trimmed;
  }

  if (value !== null && typeof value === 'object') {
    const id = (value as { id?: unknown }).id;

    if (typeof id === 'string' && id.trim().length > 0) return id.trim();
  }

  return null;
};

export const personIdOf = (input: {
  personId?: unknown;
  person?: unknown;
}): string | null => idOf(input.personId) ?? idOf(input.person);

export const asBoolean = (value: unknown, fallback: boolean): boolean => {
  if (typeof value === 'boolean') return value;

  if (typeof value === 'string') {
    const lowered = value.trim().toLowerCase();

    if (['true', '1', 'yes', 'on'].includes(lowered)) return true;
    if (['false', '0', 'no', 'off'].includes(lowered)) return false;
  }

  return fallback;
};

export const waIdForPerson = (
  person: PersonRecord,
  defaultCallingCode: string,
): string | null => {
  const phones = personPhones(person);

  for (const candidate of [phones.primary, ...phones.additional]) {
    const e164 = toE164(candidate, defaultCallingCode);

    if (e164 !== null) return toWaId(e164);
  }

  return null;
};

const refuse = (
  reason: ActionRefusal,
  extra: Partial<TemplateSendResult> = {},
): TemplateSendResult => ({
  status: 'denied',
  messageId: null,
  threadId: null,
  denialReason: reason,
  warnings: [],
  replayed: false,
  ...extra,
});

export const resolveAccountForTemplateSend = async (
  accountId: unknown,
  resolution: AccountResolution,
): Promise<
  { ok: true; account: WhatsappAccountRecord } | { ok: false; reason: ActionRefusal }
> => {
  const named = idOf(accountId) ?? '';

  if (named.length > 0) {
    const account =
      resolution === 'exact'
        ? isUuid(named)
          ? await findAccountById(named)
          : null
        : isUuid(named)
          ? ((await findAccountById(named)) ?? (await findAccountByPhoneNumberId(named)))
          : await findAccountByPhoneNumberId(named);

    return account === null
      ? { ok: false, reason: ACTION_REFUSAL.ACCOUNT_UNKNOWN }
      : { ok: true, account };
  }

  const connected = await listAccounts([ACCOUNT_STATUS.CONNECTED]);

  if (connected.length === 0) return { ok: false, reason: ACTION_REFUSAL.ACCOUNT_UNKNOWN };
  if (connected.length > 1) return { ok: false, reason: ACTION_REFUSAL.ACCOUNT_AMBIGUOUS };

  return { ok: true, account: connected[0]! };
};

export const resolveTemplateForSend = async (
  account: WhatsappAccountRecord,
  templateId: unknown,
  resolution: TemplateResolution,
): Promise<WhatsappTemplateRecord | null> => {
  const wantedId = idOf(templateId) ?? '';
  if (wantedId.length === 0) return null;

  if (isUuid(wantedId)) {
    const byId = await findTemplateById(wantedId);
    const belongsToAccount =
      byId !== null &&
      (resolution === 'workflow'
        ? byId.accountId === null || byId.accountId === undefined || byId.accountId === account.id
        : byId.accountId === account.id);

    if (belongsToAccount) return byId;
    if (resolution === 'exact') return null;
  } else if (resolution === 'exact') {
    return null;
  }

  const wantedName = wantedId.trim().toLowerCase();
  const candidates = (await listTemplatesForAccount(account.id)).filter(
    (template) => (template.name ?? '').toLowerCase() === wantedName,
  );

  return candidates.length === 1 ? candidates[0]! : null;
};

/** Resolve a Person/account/number without creating a conversation. */
export const resolveTemplateTarget = async ({
  personId,
  accountId,
  accountResolution,
}: {
  personId: unknown;
  accountId?: unknown;
  accountResolution: AccountResolution;
}): Promise<
  | { ok: true; target: ResolvedTemplateTarget }
  | { ok: false; reason: ActionRefusal }
> => {
  const exactPersonId = idOf(personId);
  if (
    exactPersonId === null ||
    (accountResolution === 'exact' && !isUuid(exactPersonId))
  ) {
    return { ok: false, reason: ACTION_REFUSAL.PERSON_UNKNOWN };
  }

  const person = await findPersonById(exactPersonId);
  if (person === null) return { ok: false, reason: ACTION_REFUSAL.PERSON_UNKNOWN };

  const resolvedAccount = await resolveAccountForTemplateSend(accountId, accountResolution);
  if (!resolvedAccount.ok) return resolvedAccount;

  const account = resolvedAccount.account;
  const defaultCallingCode = forAccount(
    account.defaultCountryCallingCode,
    config.defaultCountryCallingCode,
  );
  const waId = waIdForPerson(person, defaultCallingCode);

  if (waId === null) return { ok: false, reason: ACTION_REFUSAL.NO_PHONE };

  return {
    ok: true,
    target: {
      person,
      account,
      waId,
      thread: await findThread(account.id, waId),
    },
  };
};

export const templateSendContext = (
  target: ResolvedTemplateTarget,
  template: WhatsappTemplateRecord,
  thread: WhatsappThreadRecord | null = target.thread,
): SendContext => ({
  now: new Date(),
  thread: {
    serviceWindowExpiresAt: toDate(thread?.serviceWindowExpiresAt),
    isBlocked: thread?.isBlocked === true,
  },
  person: {
    whatsappOptInStatus: (target.person.whatsappOptInStatus ??
      CONSENT_STATUS.UNKNOWN) as ConsentStatus,
  },
  account: {
    status: (target.account.status ?? ACCOUNT_STATUS.PENDING) as AccountStatus,
    qualityRating: (target.account.qualityRating ?? QUALITY.UNKNOWN) as Quality,
  },
  template: {
    status: template.status as NonNullable<SendContext['template']>['status'],
    publishedToCrm: template.publishedToCrm === true,
    isUsableInCrm: template.isUsableInCrm === true,
  },
});

const canonicalValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value === null || typeof value !== 'object') return value;

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalValue(child)]),
  );
};

export const sameTemplateSendIntent = (
  existing: WhatsappMessageRecord,
  intent: {
    threadId: string;
    templateId: string;
    sourceKind: SourceKind;
    parameters: ResolvedParameters;
  },
): boolean =>
  existing.threadId === intent.threadId &&
  existing.templateId === intent.templateId &&
  existing.sourceKind === intent.sourceKind &&
  JSON.stringify(canonicalValue(asJson(existing.templateParameters, null))) ===
    JSON.stringify(canonicalValue(intent.parameters));

const replayResult = (
  existing: WhatsappMessageRecord,
  warnings: Warning[],
): TemplateSendResult => ({
  status: 'accepted',
  messageId: existing.id,
  threadId: existing.threadId ?? null,
  denialReason: null,
  warnings,
  replayed: true,
});

export const executeTemplateSend = async (
  input: TemplateSendInput,
  source: TemplateSendSource,
): Promise<TemplateSendResult> => {
  const resolvedTarget = await resolveTemplateTarget({
    personId: input.personId,
    accountId: input.accountId,
    accountResolution: source.accountResolution,
  });

  if (!resolvedTarget.ok) return refuse(resolvedTarget.reason);

  const target = resolvedTarget.target;
  const template = await resolveTemplateForSend(
    target.account,
    input.templateId,
    source.templateResolution,
  );
  if (template === null) return refuse(ACTION_REFUSAL.TEMPLATE_UNKNOWN);

  const createIfMissing = asBoolean(input.createThreadIfMissing, true);
  if (target.thread === null && !createIfMissing) return refuse(ACTION_REFUSAL.NO_THREAD);

  const variableSpec = asJson<VariableSpec>(template.variableSpec, EMPTY_VARIABLE_SPEC);
  const parameters = bindWorkflowParameters(variableSpec, input.parameters);
  const validation = validateParameters(variableSpec, parameters);
  const sendIntent = {
    kind: 'TEMPLATE' as const,
    lane: LANE.INTERACTIVE,
    ...(template.category === null || template.category === undefined
      ? {}
      : { templateCategory: template.category as TemplateCategory }),
  };

  /**
   * A retry must be read-only. In particular, replaying an accepted request may
   * not create or relink a conversation before discovering the original
   * message. The workflow surface has no request id and keeps its established
   * create-before-validation behaviour.
   */
  if (source.requestId !== null) {
    if (!validation.ok) {
      return refuse(ACTION_REFUSAL.MISSING_VARIABLES, {
        threadId: target.thread?.id ?? null,
        missingVariables: validation.missingKeys,
      });
    }

    const preflightVerdict = evaluateSendPermission(
      sendIntent,
      templateSendContext(target, template),
    );
    if (!preflightVerdict.allowed) {
      return refuse(preflightVerdict.reason, {
        threadId: target.thread?.id ?? null,
        warnings: preflightVerdict.warnings,
      });
    }

    const existing = await findMessageByClientToken(source.requestId);
    if (existing !== null) {
      const existingThread = target.thread;

      return existingThread !== null &&
        sameTemplateSendIntent(existing, {
          threadId: existingThread.id,
          templateId: template.id,
          sourceKind: source.sourceKind,
          parameters,
        })
        ? replayResult(existing, preflightVerdict.warnings)
        : refuse(ACTION_REFUSAL.IDEMPOTENCY_CONFLICT, {
            threadId: existingThread?.id ?? null,
            warnings: preflightVerdict.warnings,
          });
    }
  }

  const { thread } = await upsertThread({
    account: target.account,
    waId: target.waId,
    personId: target.person.id,
  });

  if (!validation.ok) {
    return refuse(ACTION_REFUSAL.MISSING_VARIABLES, {
      threadId: thread.id,
      missingVariables: validation.missingKeys,
    });
  }

  const verdict = evaluateSendPermission(
    sendIntent,
    templateSendContext(target, template, thread),
  );

  if (!verdict.allowed) {
    return refuse(verdict.reason, { threadId: thread.id, warnings: verdict.warnings });
  }

  const intent = {
    threadId: thread.id,
    templateId: template.id,
    sourceKind: source.sourceKind,
    parameters,
  };

  let message: WhatsappMessageRecord;

  try {
    message = await queueOutbound({
      thread,
      account: target.account,
      spec: { kind: 'template', templateId: template.id, contextWamid: null },
      body: renderTemplateBody(variableSpec, parameters),
      lane: LANE.INTERACTIVE,
      sourceKind: source.sourceKind,
      sentById: source.sentById,
      clientToken: source.requestId,
      template: {
        id: template.id,
        name: template.name,
        language: template.language,
        category: template.category,
        parameters,
      },
    });
  } catch (error) {
    if (source.requestId === null || !isUniqueViolation(error)) throw error;

    const raced = await findMessageByClientToken(source.requestId);
    if (raced === null) throw error;

    return sameTemplateSendIntent(raced, intent)
      ? replayResult(raced, verdict.warnings)
      : refuse(ACTION_REFUSAL.IDEMPOTENCY_CONFLICT, {
          threadId: thread.id,
          warnings: verdict.warnings,
        });
  }

  audit({
    action: AUDIT_ACTION.TEMPLATE_SEND,
    actorId: source.sentById,
    subject: {
      threadId: thread.id,
      personId: target.person.id,
      templateId: template.id,
      accountId: target.account.id,
    },
    details: {
      messageId: message.id,
      template: template.name,
      sourceKind: source.sourceKind,
      channel: source.channel,
      requestId: source.requestId,
    },
  });

  return {
    status: 'accepted',
    messageId: message.id,
    threadId: thread.id,
    denialReason: null,
    warnings: verdict.warnings,
    replayed: false,
  };
};
