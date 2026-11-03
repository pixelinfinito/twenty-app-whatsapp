import { useCallback, useMemo } from 'react';
import { RestApiClient } from 'twenty-client-sdk/rest';

import type { FieldError } from '../../domain/interactive/validate';
import type { ResolvedParameters } from '../../domain/template-render';

/**
 * Everything that changes something (specs/04, specs/05).
 *
 * Separate from `use-feed` because reads and writes fail differently and the
 * component has to treat them differently: a failed poll is a stale screen and
 * a banner, a failed send is a message the customer never received and a bubble
 * that must say so.
 *
 * Nothing here decides whether an action is *allowed*. The routes re-check the
 * caller's role and re-run the policy gate immediately before the Meta call
 * (SEC-5, AR-17); a disabled button is a courtesy, never a control.
 */

export type SendOutcome =
  | { ok: true; messageId: string; replayed: boolean }
  /** `409` — the policy gate refused. `code` is a `DENIAL`, never a sentence. */
  | { ok: false; kind: 'denied'; code: string; warnings: string[] }
  /**
   * `400` with a field map — a builder's own validation, run authoritatively on
   * the server. Distinct from `error` because it has somewhere to *go*: the
   * quick-reply form puts each entry under the box that caused it, rather than
   * showing one sentence about a message with eight fields.
   */
  | { ok: false; kind: 'invalid'; fields: FieldError[]; message: string }
  /**
   * `message` is the route's machine code where it sent one, and `detail` the
   * sentence beside it. Kept apart so the component can translate the code and
   * still show what the server actually said — an attachment refusal is useless
   * without the reason (D-58).
   */
  | { ok: false; kind: 'error'; message: string; detail?: string | null };

export type { FieldError };

type ErrorBody = {
  code?: string;
  warnings?: string[];
  error?: string;
  detail?: string;
  missing?: string[];
  fields?: FieldError[];
};

const bodyOf = (error: unknown): { status: number | null; body: ErrorBody } => {
  const detail = error as { status?: number; body?: unknown };

  return {
    status: typeof detail?.status === 'number' ? detail.status : null,
    body:
      typeof detail?.body === 'object' && detail.body !== null
        ? (detail.body as ErrorBody)
        : {},
  };
};

/**
 * A token that survives a double-click, a re-render and a retried request.
 *
 * `crypto.randomUUID` is not guaranteed here, so it is used when present and
 * composed from the clock and two random draws when not — the requirement is
 * uniqueness within one workspace's sends, not cryptographic strength.
 */
export const newClientToken = (): string => {
  const random = globalThis.crypto;

  if (typeof random?.randomUUID === 'function') return random.randomUUID();

  return `wa-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}${Math.random()
    .toString(36)
    .slice(2)}`;
};

export type ThreadActionName =
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

/** Everything a rich send shares: which conversation, and what it replies to. */
export type SendBase = {
  threadId: string;
  clientToken: string;
  contextWamid?: string | null;
};

export type MediaKind = 'image' | 'video' | 'audio' | 'document' | 'sticker';

export type Actions = {
  sendText: (input: SendBase & { body: string }) => Promise<SendOutcome>;
  sendTemplate: (input: {
    threadId?: string;
    accountId?: string;
    waId?: string;
    templateId: string;
    parameters: ResolvedParameters;
    clientToken: string;
    contextWamid?: string | null;
  }) => Promise<SendOutcome>;
  sendMedia: (
    input: SendBase & {
      mediaKind: MediaKind;
      fileId?: string | null;
      fileUrl?: string | null;
      filePath?: string | null;
      filename?: string | null;
      caption?: string | null;
      voice?: boolean;
    },
  ) => Promise<SendOutcome>;
  /**
   * An empty emoji removes the reaction — the same call, because that is how
   * Meta models a removal too. No `contextWamid`: a reaction already names its
   * target, and adding a context makes Meta reject the payload.
   */
  sendReaction: (input: {
    threadId: string;
    clientToken: string;
    targetWamid: string;
    emoji: string;
  }) => Promise<SendOutcome>;
  sendInteractive: (
    input: SendBase & { interactive: Record<string, unknown> },
  ) => Promise<SendOutcome>;
  sendLocation: (
    input: SendBase & {
      latitude: number;
      longitude: number;
      name?: string | null;
      address?: string | null;
    },
  ) => Promise<SendOutcome>;
  sendContacts: (input: SendBase & { contacts: unknown[] }) => Promise<SendOutcome>;
  threadAction: (
    action: ThreadActionName,
    input: Record<string, unknown>,
  ) => Promise<{ ok: boolean; error?: string }>;
};

export const useActions = (): Actions => {
  const client = useMemo(() => new RestApiClient(), []);

  const send = useCallback(
    async (payload: Record<string, unknown>): Promise<SendOutcome> => {
      try {
        const result = await client.post<{ message?: { id?: string }; replayed?: boolean }>(
          '/s/whatsapp/send',
          payload,
        );

        return {
          ok: true,
          messageId: result.message?.id ?? '',
          replayed: result.replayed === true,
        };
      } catch (error) {
        const { status, body } = bodyOf(error);

        /**
         * A denial is not an exception to be toasted and forgotten. It becomes
         * an inline state on the composer, because the rep has to *do*
         * something different — pick a template, or stop — and a toast that has
         * faded cannot be re-read (specs/08 §3.3).
         */
        if (status === 409 && typeof body.code === 'string') {
          return { ok: false, kind: 'denied', code: body.code, warnings: body.warnings ?? [] };
        }

        /**
         * A field-addressed rejection from a builder's own validator. It is
         * the difference between "this message is invalid" and a message under
         * the box that caused it — see the send route's `INTERACTIVE_INVALID`.
         */
        if (status === 400 && Array.isArray(body.fields) && body.fields.length > 0) {
          return {
            ok: false,
            kind: 'invalid',
            fields: body.fields,
            message: body.error ?? 'INVALID',
          };
        }

        return {
          ok: false,
          kind: 'error',
          message:
            body.error ?? (error instanceof Error ? error.message : String(error)),
          detail: typeof body.detail === 'string' ? body.detail : null,
        };
      }
    },
    [client],
  );

  return {
    sendText: useCallback(
      ({ threadId, body, clientToken, contextWamid = null }: SendBase & { body: string }) =>
        send({
          threadId,
          clientToken,
          message: { kind: 'text', body, contextWamid },
        }),
      [send],
    ),

    sendTemplate: useCallback(
      ({ threadId, accountId, waId, templateId, parameters, clientToken, contextWamid = null }) =>
        send({
          ...(threadId === undefined ? {} : { threadId }),
          ...(accountId === undefined ? {} : { accountId }),
          ...(waId === undefined ? {} : { waId }),
          clientToken,
          message: { kind: 'template', templateId, parameters, contextWamid },
        }),
      [send],
    ),

    sendMedia: useCallback(
      ({
        threadId,
        clientToken,
        contextWamid = null,
        mediaKind,
        fileId = null,
        fileUrl = null,
        filePath = null,
        filename = null,
        caption = null,
        voice = false,
      }) =>
        send({
          threadId,
          clientToken,
          message: {
            kind: 'media',
            mediaKind,
            fileId,
            fileUrl,
            filePath,
            filename,
            caption,
            voice,
            contextWamid,
          },
        }),
      [send],
    ),

    sendReaction: useCallback(
      ({ threadId, clientToken, targetWamid, emoji }) =>
        send({
          threadId,
          clientToken,
          message: { kind: 'reaction', targetWamid, emoji },
        }),
      [send],
    ),

    sendInteractive: useCallback(
      ({ threadId, clientToken, contextWamid = null, interactive }) =>
        send({
          threadId,
          clientToken,
          message: { kind: 'interactive', interactive, contextWamid },
        }),
      [send],
    ),

    sendLocation: useCallback(
      ({ threadId, clientToken, contextWamid = null, latitude, longitude, name = null, address = null }) =>
        send({
          threadId,
          clientToken,
          message: { kind: 'location', latitude, longitude, name, address, contextWamid },
        }),
      [send],
    ),

    sendContacts: useCallback(
      ({ threadId, clientToken, contextWamid = null, contacts }) =>
        send({
          threadId,
          clientToken,
          message: { kind: 'contacts', contacts, contextWamid },
        }),
      [send],
    ),

    threadAction: useCallback(
      async (action, input) => {
        try {
          await client.post('/s/whatsapp/thread', { action, ...input });

          return { ok: true };
        } catch (error) {
          const { body } = bodyOf(error);

          return {
            ok: false,
            error: body.error ?? (error instanceof Error ? error.message : String(error)),
          };
        }
      },
      [client],
    ),

  };
};
