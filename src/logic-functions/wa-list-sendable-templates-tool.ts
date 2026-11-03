import { authenticatedTool, toolTrigger, type WhatsappToolContext } from '../server/tool-runtime';
import type { InputJsonSchema } from 'twenty-sdk/logic-function';
import { defineLogicFunction } from 'twenty-sdk/define';

import { LF_LIST_SENDABLE_TEMPLATES_TOOL } from '../constants/universal-identifiers';
import {
  LANE,
  TEMPLATE_CATEGORY,
  TEMPLATE_STATUS,
  type TemplateCategory,
} from '../domain/constants';
import { evaluateSendPermission } from '../domain/policy/send-permission';
import { renderTemplateBody, type ResolvedParameters } from '../domain/template-render';
import type { VariableSpec } from '../domain/template-spec';
import { describeError, logger } from '../server/logger';
import { METRIC, count } from '../server/metrics';
import { asJson, isUuid } from '../server/repositories/base';
import {
  listSendableTemplatesPage,
  type WhatsappTemplateRecord,
} from '../server/repositories/templates';
import {
  resolveTemplateTarget,
  templateSendContext,
  type ActionRefusal,
} from '../server/template-send';

export const listSendableTemplatesInputSchema: InputJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    personId: {
      type: 'string',
      description: 'Exact Twenty Person record id. Resolve a unique Person with Twenty MCP first.',
    },
    accountId: {
      type: 'string',
      description:
        'Optional WhatsApp account record id. Omit only when exactly one connected account exists.',
    },
    language: {
      type: 'string',
      description: 'Optional exact Meta language code, for example pt_BR, pt_PT or en_US.',
    },
    category: {
      type: 'string',
      enum: ['MARKETING', 'UTILITY', 'AUTHENTICATION'],
      description: 'Optional business-purpose filter.',
    },
    nameContains: {
      type: 'string',
      description: 'Optional case-insensitive template-name fragment.',
    },
    first: {
      type: 'integer',
      minimum: 1,
      maximum: 50,
      description: 'Page size; defaults to 20 and never exceeds 50.',
    },
    after: {
      type: 'string',
      description: 'Opaque cursor returned by the previous call.',
    },
  },
  required: ['personId'],
};

type ParameterContract = {
  body: Array<{ key: string; example: string | null; required: true }>;
  header:
    | null
    | { kind: 'text'; keys: string[]; examples: string[] }
    | { kind: 'media'; mediaType: 'IMAGE' | 'VIDEO' | 'DOCUMENT' };
  buttons: Array<{ index: number; kind: 'url'; required: true }>;
};

const emptyVariableSpec = (): VariableSpec => ({
  namedParameters: false,
  header: null,
  body: { variableCount: 0, indices: [], names: [], text: null, example: [] },
  footer: null,
  buttons: [],
  totalVariableCount: 0,
});

export const parameterContractForTemplate = (
  template: WhatsappTemplateRecord,
): { contract: ParameterContract; preview: string } => {
  const spec = asJson<VariableSpec>(template.variableSpec, emptyVariableSpec());
  const bodyKeys = spec.namedParameters
    ? spec.body.names
    : spec.body.indices.map((index) => String(index));
  const exampleParameters: ResolvedParameters = {
    body: bodyKeys.map((_key, index) => spec.body.example[index] ?? ''),
    buttons: [],
  };

  const header: ParameterContract['header'] =
    spec.header === null
      ? null
      : spec.header.format === 'TEXT'
        ? {
            kind: 'text',
            keys: spec.namedParameters
              ? spec.header.names
              : spec.header.indices.map((index) => String(index)),
            examples: spec.header.example,
          }
        : spec.header.format === 'IMAGE' ||
            spec.header.format === 'VIDEO' ||
            spec.header.format === 'DOCUMENT'
          ? { kind: 'media', mediaType: spec.header.format }
          : null;

  return {
    contract: {
      body: bodyKeys.map((key, index) => ({
        key,
        example: spec.body.example[index] ?? null,
        required: true,
      })),
      header,
      buttons: spec.buttons
        .filter((button) => button.hasVariable && button.type === 'URL')
        .map((button) => ({ index: button.index, kind: 'url', required: true })),
    },
    preview: renderTemplateBody(spec, exampleParameters),
  };
};

export type ListSendableTemplatesInput = {
  personId?: unknown;
  accountId?: unknown;
  language?: unknown;
  category?: unknown;
  nameContains?: unknown;
  first?: unknown;
  after?: unknown;
};

const denied = (reason: ActionRefusal) => ({
  status: 'denied' as const,
  reason,
  templates: [] as never[],
});

const categoryOf = (value: unknown): TemplateCategory | null =>
  Object.values(TEMPLATE_CATEGORY).includes(value as TemplateCategory)
    ? (value as TemplateCategory)
    : null;

export const runListSendableTemplates = async (input: ListSendableTemplatesInput) => {
  const personId = typeof input.personId === 'string' ? input.personId.trim() : '';
  const accountId = typeof input.accountId === 'string' ? input.accountId.trim() : '';

  if (!isUuid(personId)) return denied('PERSON_UNKNOWN');
  if (accountId.length > 0 && !isUuid(accountId)) return denied('ACCOUNT_UNKNOWN');

  const resolved = await resolveTemplateTarget({
    personId,
    ...(accountId.length === 0 ? {} : { accountId }),
    accountResolution: 'exact',
  });
  if (!resolved.ok) return denied(resolved.reason);

  const target = resolved.target;
  const baselineTemplate: WhatsappTemplateRecord = {
    id: '00000000-0000-4000-8000-000000000000',
    status: TEMPLATE_STATUS.APPROVED,
    publishedToCrm: true,
    isUsableInCrm: true,
    category: TEMPLATE_CATEGORY.UTILITY,
    accountId: target.account.id,
  };
  const baselineVerdict = evaluateSendPermission(
    { kind: 'TEMPLATE', lane: LANE.INTERACTIVE, templateCategory: TEMPLATE_CATEGORY.UTILITY },
    templateSendContext(target, baselineTemplate),
  );

  if (!baselineVerdict.allowed) return denied(baselineVerdict.reason);

  const page = await listSendableTemplatesPage({
    accountId: target.account.id,
    language: typeof input.language === 'string' ? input.language.trim() || null : null,
    category: categoryOf(input.category),
    nameContains:
      typeof input.nameContains === 'string' ? input.nameContains.trim() || null : null,
    first: typeof input.first === 'number' ? input.first : null,
    after: typeof input.after === 'string' ? input.after : null,
  });

  const templates = page.templates.flatMap((template) => {
    const verdict = evaluateSendPermission(
      {
        kind: 'TEMPLATE',
        lane: LANE.INTERACTIVE,
        ...(template.category === null || template.category === undefined
          ? {}
          : { templateCategory: template.category as TemplateCategory }),
      },
      templateSendContext(target, template),
    );

    if (!verdict.allowed) return [];

    const parameterContract = parameterContractForTemplate(template);

    return [
      {
        id: template.id,
        name: template.name ?? '',
        language: template.language ?? '',
        category: (template.category ?? TEMPLATE_CATEGORY.UTILITY) as TemplateCategory,
        preview: parameterContract.preview,
        parameters: parameterContract.contract,
        warnings: verdict.warnings,
      },
    ];
  });

  return {
    status: 'ready' as const,
    personId: target.person.id,
    account: {
      id: target.account.id,
      name: target.account.name ?? null,
      displayPhoneNumber: target.account.displayPhoneNumber ?? null,
    },
    templates,
    pageInfo: page.pageInfo,
  };
};

const executeHandler = async (input: ListSendableTemplatesInput) => {
  try {
    const result = await runListSendableTemplates(input ?? {});

    count(
      result.status === 'ready'
        ? METRIC.MCP_TEMPLATE_DISCOVERY_READY
        : METRIC.MCP_TEMPLATE_DISCOVERY_DENIED,
    );
    logger.info('wa.mcp.template_discovery', {
      personId: typeof input?.personId === 'string' ? input.personId : null,
      status: result.status,
      ...(result.status === 'ready'
        ? { accountId: result.account.id, templateCount: result.templates.length }
        : { reason: result.reason }),
    });

    return result;
  } catch (error) {
    count(METRIC.MCP_TEMPLATE_DISCOVERY_FAILED);
    logger.error('wa.mcp.template_discovery_failed', describeError(error));
    throw error;
  }
};

export const handler = (input: ListSendableTemplatesInput, context?: WhatsappToolContext) =>
  authenticatedTool(listSendableTemplatesInputSchema, input, context, () => executeHandler(input))
    .then((result) => result.status === 'denied' && 'code' in result ? { ...result, reason: result.code, templates: [] } : result);

export default defineLogicFunction({
  universalIdentifier: LF_LIST_SENDABLE_TEMPLATES_TOOL,
  name: 'whatsapp-list-sendable-templates',
  description:
    'Lists WhatsApp templates that are currently approved, published and safe to send to one Twenty CRM Person. Call this after uniquely resolving the Person and before whatsapp-send-template. This tool never sends a message.',
  timeoutSeconds: 15,
  toolTriggerSettings: toolTrigger(listSendableTemplatesInputSchema),
  handler,
});
