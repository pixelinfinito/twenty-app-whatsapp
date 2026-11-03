import { Response, type LogicFunctionExecutionContext, type RoutePayload } from 'twenty-sdk/logic-function';
import { toolScope } from './tool-scope';

import {
  ACCOUNT_STATUS,
  CONSENT_STATUS,
  LANE,
  MESSAGE_TYPE,
  QUALITY,
  SOURCE_KIND,
  type AccountStatus,
  type ConsentStatus,
  type MessageType,
  type Quality,
  type TemplateCategory,
} from '../domain/constants';
import {
  validateInteractive,
  type FieldError,
} from '../domain/interactive/validate';
import {
  evaluateSendPermission,
  type SendContext,
  type SendIntent,
} from '../domain/policy/send-permission';
import {
  emptyParameters,
  renderTemplateBody,
  validateParameters,
  type ResolvedParameters,
} from '../domain/template-render';
import type { SendSpec } from '../domain/send-spec';
import type { VariableSpec } from '../domain/template-spec';
import { AUDIT_ACTION, audit } from '../server/audit';
import { authErrorResponse, requireCaller, requireRole } from '../server/auth';
import { WorkspaceFileError, resolveFileUrl } from '../server/files';
import { describeError, logger } from '../server/logger';
import { queueOutbound } from '../server/outbound';
import { upsertThread } from '../server/threads';
import {
  findAccountById,
  findAccountByPhoneNumberId,
  listAccounts,
  type WhatsappAccountRecord,
} from '../server/repositories/accounts';
import { asJson, isUuid, toDate } from '../server/repositories/base';
import { findMessageByClientToken } from '../server/repositories/messages';
import { findPersonById } from '../server/repositories/people';
import { findTemplateById } from '../server/repositories/templates';
import { findThreadById, type WhatsappThreadRecord } from '../server/repositories/threads';
import { EMPTY_VARIABLE_SPEC } from '../logic-functions/wa-outbound-sender';

/**
 * The composer's entry point (FR-OUT-1 … FR-OUT-3, specs/04 §2).
 *
 * It does not send anything. It authorises, validates, runs the policy gate,
 * writes a `QUEUED` message and schedules a job — then answers `202` with the
 * record so the thread can render it optimistically. That split is what makes
 * NFR-P3's three seconds achievable: the reply measures *our* acceptance, and
 * the Meta round-trip surfaces a moment later as the `accepted` tick.
 *
 * **The policy gate here is a courtesy, not the control.** It exists so the
 * composer can show a rep why a send is refused before they type it. The
 * binding check is the sender's, on data read at send time — see
 * `wa-outbound-sender`, step 4.
 */

export type ClientMessage =
  | { kind: 'text'; body: string; contextWamid?: string | null }
  | {
      kind: 'media';
      mediaKind: 'image' | 'video' | 'audio' | 'document' | 'sticker';
      fileId?: string | null;
      fileUrl?: string | null;
      filePath?: string | null;
      filename?: string | null;
      caption?: string | null;
      /** A recording rather than an attached audio file; see `SendSpec.voice`. */
      voice?: boolean;
      contextWamid?: string | null;
    }
  | {
      kind: 'template';
      templateId: string;
      parameters: ResolvedParameters;
      contextWamid?: string | null;
    }
  | { kind: 'interactive'; interactive: Record<string, unknown>; contextWamid?: string | null }
  | { kind: 'reaction'; targetWamid: string; emoji: string }
  | {
      kind: 'location';
      latitude: number;
      longitude: number;
      name?: string | null;
      address?: string | null;
      contextWamid?: string | null;
    }
  | { kind: 'contacts'; contacts: unknown[]; contextWamid?: string | null };

export type SendRequestBody = {
  clientToken?: string;
  threadId?: string;
  /** Starting a new conversation: the number to send from and the WhatsApp id. */
  accountId?: string;
  waId?: string;
  message?: unknown;
};

/** WhatsApp's own text ceiling. Cutting silently would change what a rep wrote. */
export const MAX_TEXT_LENGTH = 4096;

const MEDIA_KINDS = new Set(['image', 'video', 'audio', 'document', 'sticker']);

/** Meta's own ceiling on a `contacts` message. */
export const MAX_CONTACT_CARDS = 10;

export type ParseResult =
  | { ok: true; message: ClientMessage }
  /**
   * `fields` is present only where a builder can point at what it rejected.
   * A quick-reply form that receives `"interactive is invalid"` has to make the
   * rep re-read every box; one that receives
   * `action.buttons.1.reply.title / TOO_LONG / 20` puts the message under the
   * box that caused it (spec §"Server hardening required").
   */
  | { ok: false; error: string; fields?: FieldError[] };

const asString = (value: unknown): string | null =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;

/**
 * Validates the request body into something the rest of the route can trust.
 *
 * Pure, and exported, because it is where a malformed or hostile body is
 * supposed to stop — and a validator only worth trusting if it is easy to test
 * every rejection of.
 */
export const parseClientMessage = (raw: unknown): ParseResult => {
  if (raw === null || typeof raw !== 'object') {
    return { ok: false, error: 'message must be an object' };
  }

  const message = raw as Record<string, unknown>;
  const kind = asString(message.kind);

  switch (kind) {
    case 'text': {
      const body = typeof message.body === 'string' ? message.body : '';

      if (body.trim().length === 0) return { ok: false, error: 'text body is empty' };
      if (body.length > MAX_TEXT_LENGTH) {
        return { ok: false, error: `text body exceeds ${MAX_TEXT_LENGTH} characters` };
      }

      return {
        ok: true,
        message: { kind: 'text', body, contextWamid: asString(message.contextWamid) },
      };
    }

    case 'media': {
      const mediaKind = asString(message.mediaKind) ?? '';

      if (!MEDIA_KINDS.has(mediaKind)) {
        return { ok: false, error: `mediaKind must be one of ${[...MEDIA_KINDS].join(', ')}` };
      }

      const fileId = asString(message.fileId);
      const fileUrl = asString(message.fileUrl);
      const filePath = asString(message.filePath);

      if (fileUrl === null && filePath === null) {
        return { ok: false, error: 'a media send needs fileUrl or filePath' };
      }

      return {
        ok: true,
        message: {
          kind: 'media',
          mediaKind: mediaKind as 'image' | 'video' | 'audio' | 'document' | 'sticker',
          fileId,
          fileUrl,
          filePath,
          filename: asString(message.filename),
          caption: asString(message.caption),
          /**
           * Only audio can be a voice note. Accepting the flag on an image
           * would store a lie the transcript then renders — a photo with a
           * microphone label — and nothing downstream would contradict it.
           */
          voice: mediaKind === 'audio' && message.voice === true,
          contextWamid: asString(message.contextWamid),
        },
      };
    }

    case 'template': {
      const templateId = asString(message.templateId);
      if (templateId === null) return { ok: false, error: 'templateId is required' };

      const parameters = (message.parameters ?? emptyParameters()) as ResolvedParameters;

      if (!Array.isArray(parameters.body)) {
        return { ok: false, error: 'parameters.body must be an array' };
      }

      return {
        ok: true,
        message: {
          kind: 'template',
          templateId,
          contextWamid: asString(message.contextWamid),
          parameters: {
            ...parameters,
            buttons: Array.isArray(parameters.buttons) ? parameters.buttons : [],
          },
        },
      };
    }

    case 'interactive': {
      const interactive = message.interactive;

      /**
       * The route used to accept any non-null object here and queue it.
       *
       * That produced a `QUEUED` row and an optimistic bubble for a message
       * Meta was always going to refuse — a duplicate row id, a title one
       * character over the limit — and the refusal arrived minutes later,
       * inside the sender, as an API error nobody could map back to a field.
       * The validator is the difference between a builder that can correct
       * itself and a message that fails after the builder is gone.
       */
      const validation = validateInteractive(interactive);

      if (!validation.ok) {
        return {
          ok: false,
          error: 'INTERACTIVE_INVALID',
          fields: validation.errors,
        };
      }

      return {
        ok: true,
        message: {
          kind: 'interactive',
          interactive: interactive as Record<string, unknown>,
          contextWamid: asString(message.contextWamid),
        },
      };
    }

    case 'reaction': {
      const targetWamid = asString(message.targetWamid);
      if (targetWamid === null) return { ok: false, error: 'targetWamid is required' };

      /**
       * An empty emoji is valid and means "remove the reaction" — the same
       * call, not a delete endpoint. So this checks the type, never emptiness.
       */
      const emoji = typeof message.emoji === 'string' ? message.emoji : null;
      if (emoji === null) return { ok: false, error: 'emoji must be a string' };

      return { ok: true, message: { kind: 'reaction', targetWamid, emoji } };
    }

    case 'location': {
      const latitude = Number(message.latitude);
      const longitude = Number(message.longitude);

      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
        return { ok: false, error: 'latitude and longitude must be numbers' };
      }

      /**
       * Out-of-range coordinates are rejected here rather than by Meta. A
       * transposed pair — 13.23, -8.91 for Luanda — is accepted by the API and
       * sends the customer to a point in the Atlantic, which is a silent
       * failure of exactly the kind FR-CID-2 treats as unacceptable.
       */
      if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
        return { ok: false, error: 'latitude or longitude is out of range' };
      }

      return {
        ok: true,
        message: {
          kind: 'location',
          latitude,
          longitude,
          name: asString(message.name),
          address: asString(message.address),
          contextWamid: asString(message.contextWamid),
        },
      };
    }

    case 'contacts': {
      const contacts = Array.isArray(message.contacts) ? message.contacts : null;

      if (contacts === null || contacts.length === 0) {
        return { ok: false, error: 'contacts must be a non-empty array' };
      }

      if (contacts.length > MAX_CONTACT_CARDS) {
        return { ok: false, error: `contacts takes at most ${MAX_CONTACT_CARDS} cards` };
      }

      /**
       * A card with no name is a card the recipient sees as blank. Meta accepts
       * it; the person on the other end gets an empty contact they cannot use.
       */
      const named = contacts.every((entry) => {
        const card = entry as { name?: { formatted_name?: unknown; first_name?: unknown } };

        return (
          asString(card?.name?.formatted_name) !== null ||
          asString(card?.name?.first_name) !== null
        );
      });

      if (!named) return { ok: false, error: 'every contact needs a name' };

      return {
        ok: true,
        message: {
          kind: 'contacts',
          contacts,
          contextWamid: asString(message.contextWamid),
        },
      };
    }

    default:
      return { ok: false, error: `unsupported message kind: ${kind ?? 'missing'}` };
  }
};

const MESSAGE_TYPE_FOR: Record<string, MessageType> = {
  text: MESSAGE_TYPE.TEXT,
  image: MESSAGE_TYPE.IMAGE,
  video: MESSAGE_TYPE.VIDEO,
  audio: MESSAGE_TYPE.AUDIO,
  document: MESSAGE_TYPE.DOCUMENT,
  sticker: MESSAGE_TYPE.STICKER,
  template: MESSAGE_TYPE.TEMPLATE,
  interactive: MESSAGE_TYPE.INTERACTIVE,
  reaction: MESSAGE_TYPE.REACTION,
  location: MESSAGE_TYPE.LOCATION,
  contacts: MESSAGE_TYPE.CONTACTS,
};

export const messageTypeFor = (message: ClientMessage): MessageType =>
  message.kind === 'media'
    ? (MESSAGE_TYPE_FOR[message.mediaKind] ?? MESSAGE_TYPE.DOCUMENT)
    : (MESSAGE_TYPE_FOR[message.kind] ?? MESSAGE_TYPE.TEXT);

/** The `payload` column: exactly what the sender will rebuild the wire form from. */
export const toSendSpec = (message: ClientMessage): SendSpec => {
  switch (message.kind) {
    case 'template':
      return {
        kind: 'template',
        templateId: message.templateId,
        contextWamid: message.contextWamid,
      };
    case 'media':
      return {
        kind: 'media',
        mediaKind: message.mediaKind,
        fileId: message.fileId,
        fileUrl: message.fileUrl,
        filePath: message.filePath,
        filename: message.filename,
        caption: message.caption,
        ...(message.voice === true ? { voice: true } : {}),
        contextWamid: message.contextWamid,
      };
    default:
      return message as SendSpec;
  }
};

/**
 * Resolves the conversation, creating it when the caller named a number and a
 * WhatsApp id instead of a thread.
 *
 * Creation goes through `upsertThread` like every other path, which is the
 * mechanical guarantee behind FR-THR-1 — and the specific avoidance of the
 * Chatwoot defect where a template send opened a second conversation beside
 * the existing one.
 */
const resolveThread = async (
  body: SendRequestBody,
): Promise<
  | { ok: true; thread: WhatsappThreadRecord; account: WhatsappAccountRecord }
  | { ok: false; status: number; error: string }
> => {
  if (typeof body.threadId === 'string' && body.threadId.length > 0) {
    const thread = await findThreadById(body.threadId);

    if (thread === null) return { ok: false, status: 404, error: 'Unknown thread' };

    const account =
      typeof thread.accountId === 'string' ? await findAccountById(thread.accountId) : null;

    if (account === null) {
      return { ok: false, status: 409, error: 'The conversation has no connected number' };
    }

    return { ok: true, thread, account };
  }

  const waId = (body.waId ?? '').replace(/[^0-9]/g, '');

  if (waId.length === 0) {
    return { ok: false, status: 400, error: 'threadId, or waId with accountId, is required' };
  }

  if (typeof body.accountId === 'string') {
    /**
     * Only an id-shaped value reaches the id lookup. `id` is a `UUIDFilter` and
     * the server validates the shape first, so `findAccountById('123456789')`
     * raises instead of answering "not found" — and the `??` fallback to the
     * `phone_number_id`, which is the form an operator actually has to hand,
     * would never be reached.
     */
    const named = isUuid(body.accountId)
      ? ((await findAccountById(body.accountId)) ??
        (await findAccountByPhoneNumberId(body.accountId)))
      : await findAccountByPhoneNumberId(body.accountId);

    if (named === null) return { ok: false, status: 404, error: 'Unknown account' };

    const { thread } = await upsertThread({ account: named, waId, resolveIdentity: true });

    return { ok: true, thread, account: named };
  }

  const connected = await listAccounts([ACCOUNT_STATUS.CONNECTED]);

  if (connected.length === 0) {
    return { ok: false, status: 409, error: 'No connected WhatsApp number' };
  }

  /**
   * With one connected number — the common case — asking the caller to name it
   * is friction with no decision behind it. With several it is a real decision:
   * the number a message comes from is what the customer sees and replies to,
   * and picking the first row would make that arbitrary and invisible.
   */
  if (connected.length > 1) {
    return {
      ok: false,
      status: 400,
      error: 'accountId is required when more than one number is connected',
    };
  }

  const account = connected[0]!;

  const { thread } = await upsertThread({ account, waId, resolveIdentity: true });

  return { ok: true, thread, account };
};

export const handler = async (
  event: RoutePayload<SendRequestBody>,
  executionContext?: LogicFunctionExecutionContext,
): Promise<Response> => {
  const log = logger.child({ fn: 'wa-send-message-route' });

  try {
    const caller = await requireCaller(event, executionContext);
    requireRole(caller, 'agent');

    const body = event.body ?? {};

    const parsed = parseClientMessage(body.message);

    if (!parsed.ok) {
      return new Response(
        {
          error: parsed.error,
          ...(parsed.fields === undefined ? {} : { fields: parsed.fields }),
        },
        { status: 400 },
      );
    }

    /**
     * Idempotency before anything else that writes.
     *
     * A double-clicked button and the sandbox's retry-on-blip both arrive as
     * two identical POSTs. De-duplicating on content would be wrong — people
     * genuinely send the same message twice — so the browser's token is the
     * only thing that can tell a repeat from a repetition.
     */
    const clientToken = typeof body.clientToken === 'string' ? body.clientToken.trim() : '';

    if (clientToken.length > 0) {
      const existing = await findMessageByClientToken(clientToken);

      if (existing !== null) {
        log.info('wa.send.idempotent_replay', { correlationId: existing.id });

        return new Response(
          { message: existing, threadId: existing.threadId, replayed: true },
          { status: 202 },
        );
      }
    }

    /**
     * An attachment's address is checked here, before a record exists.
     *
     * The sender resolves the same handle a moment later, so this decides
     * nothing the sender does not decide again — but it decides it *while the
     * rep is still looking at the panel they typed the address into*. Without
     * it, an address the file store cannot serve became a queued message, a job,
     * and a failed bubble carrying a sentence about Meta, which is the shape
     * D-58 took. The cheap half of the check — is this a workspace file path at
     * all — catches every case seen so far and costs no network call.
     */
    if (parsed.message.kind === 'media') {
      try {
        resolveFileUrl({ url: parsed.message.fileUrl, path: parsed.message.filePath });
      } catch (error) {
        if (!(error instanceof WorkspaceFileError)) throw error;

        log.info('wa.send.attachment_rejected', { detail: error.message });

        return new Response(
          { error: 'ATTACHMENT_UNREADABLE', detail: error.message },
          { status: 400 },
        );
      }
    }

    const resolved = await resolveThread(body);

    if (!resolved.ok) {
      return new Response({ error: resolved.error }, { status: resolved.status });
    }

    const { thread, account } = resolved;

    const person =
      typeof thread.personId === 'string' ? await findPersonById(thread.personId) : null;
    if (toolScope() && (!(await findThreadById(thread.id)) || (thread.personId && person === null))) {
      return new Response({ code: 'RECORD_UNAVAILABLE' }, { status: 403 });
    }

    const template =
      parsed.message.kind === 'template'
        ? await findTemplateById(parsed.message.templateId)
        : null;

    if (parsed.message.kind === 'template' && template === null) {
      return new Response({ error: 'Unknown template' }, { status: 404 });
    }

    const variableSpec =
      template === null
        ? EMPTY_VARIABLE_SPEC
        : asJson<VariableSpec>(template.variableSpec, EMPTY_VARIABLE_SPEC);

    if (parsed.message.kind === 'template') {
      const validation = validateParameters(variableSpec, parsed.message.parameters);

      if (!validation.ok) {
        return new Response(
          { error: 'MISSING_VARIABLES', missing: validation.missingKeys },
          { status: 400 },
        );
      }
    }

    const intent: SendIntent = {
      kind: parsed.message.kind === 'template' ? 'TEMPLATE' : 'FREEFORM',
      lane: LANE.INTERACTIVE,
      ...(template?.category === null || template?.category === undefined
        ? {}
        : { templateCategory: template.category as TemplateCategory }),
    };

    const context: SendContext = {
      now: new Date(),
      thread: {
        serviceWindowExpiresAt: toDate(thread.serviceWindowExpiresAt),
        isBlocked: thread.isBlocked === true,
      },
      person:
        person === null
          ? null
          : {
              whatsappOptInStatus: (person.whatsappOptInStatus ??
                CONSENT_STATUS.UNKNOWN) as ConsentStatus,
            },
      account: {
        status: (account.status ?? ACCOUNT_STATUS.PENDING) as AccountStatus,
        qualityRating: (account.qualityRating ?? QUALITY.UNKNOWN) as Quality,
      },
      ...(template === null
        ? {}
        : {
            template: {
              status: template.status as NonNullable<SendContext['template']>['status'],
              publishedToCrm: template.publishedToCrm === true,
              isUsableInCrm: template.isUsableInCrm === true,
            },
          }),
    };

    const verdict = evaluateSendPermission(intent, context);

    if (!verdict.allowed) {
      log.info('wa.send.route_denied', { reason: verdict.reason, threadId: thread.id });

      /**
       * `409`, and a machine code rather than a sentence: the component owns
       * pt/en copy (specs/01 §7), so a translation change must never be a
       * server deploy.
       */
      return new Response(
        { code: verdict.reason, warnings: verdict.warnings },
        { status: 409 },
      );
    }

    const renderedBody =
      parsed.message.kind === 'template'
        ? renderTemplateBody(variableSpec, parsed.message.parameters)
        : parsed.message.kind === 'text'
          ? parsed.message.body
          : parsed.message.kind === 'media'
            ? (parsed.message.caption ?? null)
            : null;

    let message;

    try {
      message = await queueOutbound({
        thread,
        account,
        spec: toSendSpec(parsed.message),
        body: renderedBody,
        lane: LANE.INTERACTIVE,
        sourceKind: toolScope() ? SOURCE_KIND.AI_AGENT : SOURCE_KIND.AGENT,
        sentById: caller.workspaceMemberId,
        clientToken: clientToken.length === 0 ? null : clientToken,
        template:
          template === null
            ? null
            : {
                id: template.id,
                name: template.name,
                language: template.language,
                category: template.category,
                parameters:
                  parsed.message.kind === 'template' ? parsed.message.parameters : null,
              },
      });
    } catch (error) {
      /**
       * Two concurrent requests with the same token both pass the read above;
       * `clientToken` is unique, so the loser's *create* fails here. That is
       * the race the earlier lookup cannot close, and the answer is the same
       * replay response the lookup gives.
       */
      if (clientToken.length > 0) {
        const existing = await findMessageByClientToken(clientToken);

        if (existing !== null) {
          log.info('wa.send.idempotent_replay_on_conflict', { correlationId: existing.id });

          return new Response(
            { message: existing, threadId: existing.threadId, replayed: true },
            { status: 202 },
          );
        }
      }

      throw error;
    }

    if (template !== null) {
      audit({
        action: AUDIT_ACTION.TEMPLATE_SEND,
        actorId: caller.workspaceMemberId,
        subject: { threadId: thread.id, personId: thread.personId ?? null, templateId: template.id },
        details: { messageId: message.id, template: template.name },
      });
    }

    return new Response(
      { message, threadId: thread.id, warnings: verdict.warnings },
      { status: 202 },
    );
  } catch (error) {
    if (error instanceof WorkspaceFileError) {
      return new Response({ error: 'ATTACHMENT_UNREADABLE', detail: error.message }, { status: 400 });
    }
    const authFailure = authErrorResponse(error);

    if (authFailure !== null) {
      return new Response(authFailure.body, { status: authFailure.status });
    }

    log.error('wa.send.route_failed', describeError(error));

    return new Response({ error: 'Internal error' }, { status: 500 });
  }
};
