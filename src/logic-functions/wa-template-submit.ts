import { defineLogicFunction } from 'twenty-sdk/define';
import {
  Response,
  kv,
  type LogicFunctionExecutionContext,
  type RoutePayload,
} from 'twenty-sdk/logic-function';

import { LF_TEMPLATE_SUBMIT } from '../constants/universal-identifiers';
import {
  assessSupport,
  deriveVariableSpec,
  type MetaTemplateComponent,
} from '../domain/template-spec';
import { getProvider } from '../providers/whatsapp';
import { MetaApiError } from '../providers/whatsapp/errors';
import { AUDIT_ACTION, audit } from '../server/audit';
import { authErrorResponse, requireCaller, requireRole } from '../server/auth';
import { config } from '../server/config';
import { describeError, logger } from '../server/logger';
import { METRIC, count } from '../server/metrics';
import { findAccountById } from '../server/repositories/accounts';
import {
  createTemplateRecord,
  findTemplateById,
  listTemplatesForAccount,
  patchTemplate,
} from '../server/repositories/templates';
import { templateCategoryFor, templateStatusFor } from './wa-template-sync';

/**
 * Submitting a template to Meta for review (FR-TPL-6, specs/06 §6).
 *
 * **This is its own file, and it has to be.** The spec suggested folding it
 * into `wa-template-sync` as a second exported `defineLogicFunction`, which
 * type-checks and builds and then simply does not exist: the SDK discovers one
 * function per file, from the *default* export. A named export is ignored
 * without a warning, so the route would have 404'd with nothing anywhere
 * explaining why. Found by reading a plan that was missing a function.
 */

export type TemplateAction = 'submit' | 'publish' | 'unpublish' | 'list';

export type TemplateSubmitBody = {
  /** Absent means `submit`, which is what this route did before publishing existed. */
  action?: TemplateAction;
  accountId?: string;
  /** `publish` / `unpublish`. */
  templateId?: string;
  name?: string;
  language?: string;
  category?: string;
  components?: MetaTemplateComponent[];
};

/**
 * Why a template may not be published (FR-TPL-2).
 *
 * Publishing is the deliberate human act that makes a template selectable by a
 * rep or a campaign, and until now nothing in the app could perform it — every
 * other writer of `publishedToCrm` only ever sets it to `false`. So a template
 * synced from Meta was permanently invisible, and the flag that the send path,
 * the picker and the campaign gate all read had no way of ever becoming true.
 *
 * The two conditions are the same ones the send path re-checks. Publishing an
 * unapproved or unrenderable template would put a row in the picker that fails
 * at Meta for every recipient.
 */
export const publishRefusal = (template: {
  status?: string | null;
  isUsableInCrm?: boolean | null;
  unsupportedReason?: string | null;
}): string | null => {
  if (template.status !== 'APPROVED') {
    return `Only an approved template can be published; this one is ${template.status ?? 'unknown'}`;
  }

  if (template.isUsableInCrm !== true) {
    return `This template cannot be rendered by the app: ${template.unsupportedReason ?? 'unsupported'}`;
  }

  return null;
};


/** Meta's own rule; a name that breaks it is rejected with an opaque error. */
export const TEMPLATE_NAME_PATTERN = /^[a-z0-9_]{1,512}$/;

export const submitCountKey = (wabaId: string, at: Date = new Date()): string =>
  `wa:template-submits:${wabaId}:${at.toISOString().slice(0, 13)}`;

/**
 * Every placeholder needs an example value.
 *
 * Meta rejects a submission without them, and the rejection names neither the
 * component nor the placeholder — it is the single most common first-attempt
 * failure. Checking here turns it into a sentence an operator can act on.
 */
export const missingExamples = (components: MetaTemplateComponent[]): string[] => {
  const missing: string[] = [];

  for (const component of components) {
    const text = typeof component.text === 'string' ? component.text : '';
    const placeholders = text.match(/\{\{\s*[A-Za-z0-9_]+\s*\}\}/g) ?? [];

    if (placeholders.length === 0) continue;

    const example = component.example as
      | { body_text?: unknown[][]; header_text?: unknown[] }
      | undefined;

    const supplied =
      (component.type ?? '').toUpperCase() === 'HEADER'
        ? (example?.header_text?.length ?? 0)
        : (example?.body_text?.[0]?.length ?? 0);

    if (supplied < placeholders.length) {
      missing.push(
        `${component.type ?? 'component'}: ${placeholders.length} placeholder(s), ${supplied} example(s)`,
      );
    }
  }

  return missing;
};

export const handler = async (
  event: RoutePayload<TemplateSubmitBody>,
  executionContext: LogicFunctionExecutionContext,
): Promise<Response> => {
  const log = logger.child({ fn: 'wa-template-submit' });

  try {
    const caller = await requireCaller(executionContext);
    requireRole(caller, 'admin');

    const body = event.body ?? {};
    const action = body.action ?? 'submit';

    if (action === 'list') {
      if (typeof body.accountId !== 'string') {
        return new Response({ error: 'accountId is required' }, { status: 400 });
      }

      /**
       * The settings tab's list, which is *not* the picker's. It carries every
       * template whatever its state, because the whole point of the tab is
       * seeing the rejected and unsupported ones and being told why.
       */
      const templates = await listTemplatesForAccount(body.accountId, 200);

      return new Response(
        {
          templates: templates.map((template) => ({
            ...template,
            publishRefusal: publishRefusal(template),
          })),
        },
        { status: 200 },
      );
    }

    if (action === 'publish' || action === 'unpublish') {
      if (typeof body.templateId !== 'string') {
        return new Response({ error: 'templateId is required' }, { status: 400 });
      }

      const template = await findTemplateById(body.templateId);

      if (template === null) {
        return new Response({ error: 'Unknown template' }, { status: 404 });
      }

      const refusal = action === 'publish' ? publishRefusal(template) : null;

      if (refusal !== null) return new Response({ error: refusal }, { status: 409 });

      await patchTemplate(template.id, { publishedToCrm: action === 'publish' });

      audit({
        action:
          action === 'publish'
            ? AUDIT_ACTION.TEMPLATE_PUBLISH
            : AUDIT_ACTION.TEMPLATE_UNPUBLISH,
        actorId: caller.workspaceMemberId,
        subject: { templateId: template.id },
        details: { name: template.name ?? null, status: template.status ?? null },
      });

      log.info('wa.template.publish_changed', {
        correlationId: template.id,
        publishedToCrm: action === 'publish',
      });

      return new Response(
        { templateId: template.id, publishedToCrm: action === 'publish' },
        { status: 200 },
      );
    }

    const name = (body.name ?? '').trim().toLowerCase();

    if (!TEMPLATE_NAME_PATTERN.test(name)) {
      return new Response(
        { error: 'name must be lowercase letters, digits and underscores' },
        { status: 400 },
      );
    }

    const account =
      typeof body.accountId === 'string' ? await findAccountById(body.accountId) : null;

    if (account === null || typeof account.wabaId !== 'string') {
      return new Response({ error: 'Unknown account' }, { status: 404 });
    }

    const components = Array.isArray(body.components) ? body.components : [];

    if (components.length === 0) {
      return new Response({ error: 'components is required' }, { status: 400 });
    }

    const gaps = missingExamples(components);

    if (gaps.length > 0) {
      return new Response(
        { error: 'MISSING_EXAMPLES', detail: gaps },
        { status: 400 },
      );
    }

    /**
     * Meta permits 100 creations per WABA per hour and answers the 101st with an
     * error that says nothing useful. Counting locally and refusing at 90 leaves
     * headroom for another client on the same WABA and produces a message that
     * names the limit and when it resets.
     */
    const key = submitCountKey(account.wabaId);
    const used = (await kv.get<number>(key, { scope: 'WORKSPACE' })) ?? 0;
    const cap = config.templateSubmitHourlyCap();

    if (used >= cap) {
      count(METRIC.TEMPLATE_SUBMIT_THROTTLED);

      return new Response(
        {
          error: 'RATE_LIMITED',
          detail: `${used} of ${cap} submissions used this hour; try again next hour`,
        },
        { status: 429 },
      );
    }

    const category = templateCategoryFor(body.category);
    const language = (body.language ?? 'pt_PT').trim();

    const created = await getProvider().createTemplate(account.wabaId, {
      name,
      language,
      category,
      components,
    });

    await kv.set(key, used + 1, { scope: 'WORKSPACE' });

    /**
     * The local record is written immediately in `PENDING` so the review is
     * trackable. Meta's verdict arrives by webhook
     * (`message_template_status_update`), never by polling.
     */
    const support = assessSupport(components);

    const record = await createTemplateRecord({
      accountId: account.id,
      metaTemplateId: created.id,
      name,
      language,
      category,
      status: templateStatusFor(created.status),
      components: { components } as Record<string, unknown>,
      variableSpec: deriveVariableSpec(components) as unknown as Record<string, unknown>,
      isUsableInCrm: support.isUsableInCrm,
      unsupportedReason: support.unsupportedReason,
      publishedToCrm: false,
      lastSyncedAt: new Date().toISOString(),
    });

    count(METRIC.TEMPLATE_SUBMITTED);

    audit({
      action: AUDIT_ACTION.TEMPLATE_PUBLISH,
      actorId: caller.workspaceMemberId,
      subject: { templateId: record.id, accountId: account.id },
      details: { name, language, requestedCategory: category, metaTemplateId: created.id },
    });

    /**
     * Category is a *request*, not a decision. Meta may re-categorise, and the
     * synced category is what drives billing and campaign eligibility — so the
     * response says so rather than letting the UI imply otherwise.
     */
    return new Response(
      {
        templateId: record.id,
        metaTemplateId: created.id,
        status: created.status,
        requestedCategory: category,
        note: 'Category is a request; Meta may re-categorise on review',
      },
      { status: 202 },
    );
  } catch (error) {
    const authFailure = authErrorResponse(error);

    if (authFailure !== null) {
      return new Response(authFailure.body, { status: authFailure.status });
    }

    if (error instanceof MetaApiError) {
      log.warn('wa.template.submit_rejected', { code: error.code, detail: error.details });

      return new Response(
        { error: 'META_REJECTED', code: error.code, detail: error.details ?? error.message },
        { status: 502 },
      );
    }

    log.error('wa.template.submit_failed', describeError(error));

    return new Response({ error: 'Internal error' }, { status: 500 });
  }
};

export default defineLogicFunction({
  universalIdentifier: LF_TEMPLATE_SUBMIT,
  name: 'wa-template-submit',
  description:
    'Submits a new template to Meta for review, with example validation and a local hourly cap.',
  timeoutSeconds: 60,
  httpRouteTriggerSettings: {
    path: '/whatsapp/template',
    httpMethod: 'POST',
    isAuthRequired: true,
  },
  handler,
});
