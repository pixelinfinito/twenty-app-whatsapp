import { BodyTooLargeError, readBodyCapped } from '../../server/read-body';
import { graphBaseUrl, requireSecret } from './config';
import { MetaApiError, ambiguousError, fromResponseBody, networkError } from './errors';
import type {
  MetaMediaHandle,
  MetaPhoneNumber,
  MetaTemplate,
  MetaTemplateDefinition,
  SendPayload,
  SendResult,
  WhatsAppProvider,
} from './types';

/**
 * The Meta Cloud API implementation — the **only** module in the app that
 * performs HTTP against `graph.facebook.com` (AR-11, enforced by a lint rule).
 *
 * Everything here is about turning Meta's failure modes into ones the caller
 * can reason about: a network error that never left the machine is retryable, a
 * timeout after the request was written is not, and a JSON body that is not
 * JSON is a Meta problem rather than a crash.
 */

const DEFAULT_TIMEOUT_MS = 20_000;
const MEDIA_TIMEOUT_MS = 90_000;

/** Just above WhatsApp's own 100 MB document ceiling — nothing legitimate is bigger. */
export const MAX_MEDIA_DOWNLOAD_BYTES = 110 * 1024 * 1024;

/**
 * The only hosts the access token is ever sent to.
 *
 * A media download is the one call in this app that takes its URL from a
 * payload rather than building it, and it attaches the Bearer token — so the
 * URL decides who receives the credential. The webhook signature makes a
 * hostile URL unlikely, not impossible: one Meta-side open redirect, or one
 * signature check skipped in a future refactor, and the token walks out with
 * the request. An allow-list makes that a rejection instead of a leak (D-41).
 */
const MEDIA_HOSTS = ['graph.facebook.com', 'lookaside.fbsbx.com'];
const MEDIA_HOST_SUFFIXES = ['.fbcdn.net', '.fbsbx.com', '.facebook.com', '.whatsapp.net'];

export const isAllowedMediaHost = (url: string): boolean => {
  let host: string;

  try {
    const parsed = new URL(url);

    if (parsed.protocol !== 'https:') return false;

    host = parsed.hostname.toLowerCase();
  } catch {
    return false;
  }

  return (
    MEDIA_HOSTS.includes(host) || MEDIA_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))
  );
};

const assertMediaHost = (url: string): void => {
  if (isAllowedMediaHost(url)) return;

  throw new MetaApiError('Refusing to send the access token to an unrecognised media host', {
    details: url.slice(0, 200),
  });
};

type RequestInput = {
  method: 'GET' | 'POST';
  path: string;
  query?: Record<string, string | undefined>;
  json?: unknown;
  form?: FormData;
  timeoutMs?: number;
  /**
   * True for calls that create something at Meta. A timeout on one of these is
   * ambiguous rather than retryable: the message may already be on its way.
   */
  mutating?: boolean;
};

const buildUrl = (path: string, query?: Record<string, string | undefined>): string => {
  const url = new URL(`${graphBaseUrl()}/${path.replace(/^\//, '')}`);

  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, value);
  }

  return url.toString();
};

const parseJson = async (response: Response): Promise<unknown> => {
  const text = await response.text();
  if (text.length === 0) return null;

  try {
    return JSON.parse(text);
  } catch {
    return { _unparsed: text.slice(0, 2_000) };
  }
};

const request = async ({
  method,
  path,
  query,
  json,
  form,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  mutating = false,
}: RequestInput): Promise<unknown> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;

  try {
    response = await fetch(buildUrl(path, query), {
      method,
      headers: {
        authorization: `Bearer ${requireSecret('META_ACCESS_TOKEN')}`,
        ...(json === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: json === undefined ? form : JSON.stringify(json),
      signal: controller.signal,
    });
  } catch (cause) {
    /**
     * An abort means the request was fully written and we never read the
     * outcome. For a mutating call that is unrecoverable ambiguity — Meta may
     * have accepted it, and a duplicate customer message is worse than a false
     * failure (appendix B §2).
     */
    const aborted = cause instanceof Error && cause.name === 'AbortError';

    throw aborted && mutating ? ambiguousError(cause) : networkError(cause);
  } finally {
    clearTimeout(timer);
  }

  const body = await parseJson(response);

  if (!response.ok) throw fromResponseBody(response.status, body);

  return body;
};

const asString = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null;

const asNumber = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);

    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
};

export const createCloudApiProvider = (): WhatsAppProvider => ({
  name: 'meta-cloud-api',

  async sendMessage({ phoneNumberId, payload }): Promise<SendResult> {
    const body = (await request({
      method: 'POST',
      path: `${phoneNumberId}/messages`,
      json: payload satisfies SendPayload,
      mutating: true,
    })) as {
      messages?: { id?: string }[];
      contacts?: { wa_id?: string }[];
    } | null;

    const wamid = asString(body?.messages?.[0]?.id);

    /**
     * A 200 with no WAMID has never been observed, but the WAMID is the
     * idempotency key for every status that follows — accepting a record
     * without one would create a message that no webhook can ever match.
     */
    if (wamid === null) {
      throw new MetaApiError('Meta accepted the send but returned no message id', {
        httpStatus: 200,
        raw: body,
        ambiguous: true,
      });
    }

    return { wamid, resolvedWaId: asString(body?.contacts?.[0]?.wa_id), raw: body };
  },

  async markAsRead({ phoneNumberId, wamid }): Promise<void> {
    await request({
      method: 'POST',
      path: `${phoneNumberId}/messages`,
      json: { messaging_product: 'whatsapp', status: 'read', message_id: wamid },
    });
  },

  async uploadMedia({ phoneNumberId, buffer, mimeType, filename }): Promise<{ mediaId: string }> {
    const form = new FormData();
    form.set('messaging_product', 'whatsapp');
    form.set('type', mimeType);
    form.set('file', new Blob([new Uint8Array(buffer)], { type: mimeType }), filename);

    const body = (await request({
      method: 'POST',
      path: `${phoneNumberId}/media`,
      form,
      timeoutMs: MEDIA_TIMEOUT_MS,
      mutating: true,
    })) as { id?: string } | null;

    const mediaId = asString(body?.id);
    if (mediaId === null) {
      throw new MetaApiError('Media upload returned no id', { httpStatus: 200, raw: body });
    }

    return { mediaId };
  },

  async fetchMediaUrl(mediaId): Promise<MetaMediaHandle> {
    const body = (await request({ method: 'GET', path: mediaId })) as {
      url?: string;
      mime_type?: string;
      file_size?: number | string;
      sha256?: string;
    } | null;

    const url = asString(body?.url);
    if (url === null) {
      throw new MetaApiError(`Media ${mediaId} has no download URL`, {
        httpStatus: 200,
        raw: body,
      });
    }

    return {
      url,
      mimeType: asString(body?.mime_type) ?? 'application/octet-stream',
      fileSize: asNumber(body?.file_size) ?? 0,
      sha256: asString(body?.sha256) ?? '',
    };
  },

  /**
   * The download is *not* a Graph call — it is a CDN URL that still requires the
   * Bearer token (C-6). It therefore bypasses `request`, which would rewrite the
   * URL against the Graph base.
   */
  async downloadMedia(url): Promise<{ buffer: Buffer; mimeType: string }> {
    assertMediaHost(url);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), MEDIA_TIMEOUT_MS);

    try {
      let response: Response;

      try {
        response = await fetch(url, {
          headers: { authorization: `Bearer ${requireSecret('META_ACCESS_TOKEN')}` },
          signal: controller.signal,
        });
      } catch (cause) {
        throw networkError(cause);
      }

      if (!response.ok) {
        // 404/410 means the short-lived URL expired; the caller re-resolves from
        // the media id, which stays valid for 7 days (specs/03 §8).
        throw new MetaApiError(`Media download failed with HTTP ${response.status}`, {
          httpStatus: response.status,
        });
      }

      /**
       * The body read stays inside the timeout. It used to sit after the
       * `finally` that cleared the timer, so a connection that stalled
       * mid-download was no longer being aborted by anything of ours — it held
       * the worker until the platform's own timeout (D-41).
       *
       * And it is capped: WhatsApp media tops out at a 100 MB document, so a
       * body past the ceiling can only be a memory exhaustion, and it is cut
       * off mid-stream rather than buffered first.
       */
      try {
        return {
          buffer: await readBodyCapped(response, MAX_MEDIA_DOWNLOAD_BYTES),
          mimeType: response.headers.get('content-type') ?? 'application/octet-stream',
        };
      } catch (error) {
        if (error instanceof BodyTooLargeError) {
          throw new MetaApiError(
            `Media download exceeds the ${MAX_MEDIA_DOWNLOAD_BYTES}-byte ceiling`,
            { httpStatus: 200 },
          );
        }

        throw error;
      }
    } finally {
      clearTimeout(timer);
    }
  },

  async listTemplates(wabaId, cursor): Promise<{ templates: MetaTemplate[]; nextCursor?: string }> {
    const body = (await request({
      method: 'GET',
      path: `${wabaId}/message_templates`,
      query: { limit: '100', after: cursor },
    })) as {
      data?: Record<string, unknown>[];
      paging?: { cursors?: { after?: string } };
    } | null;

    const templates: MetaTemplate[] = (body?.data ?? []).map((raw) => ({
      id: String(raw.id ?? ''),
      name: String(raw.name ?? ''),
      language: String(raw.language ?? ''),
      status: String(raw.status ?? ''),
      category: String(raw.category ?? ''),
      qualityScore: asString((raw.quality_score as { score?: unknown } | undefined)?.score),
      components: Array.isArray(raw.components) ? (raw.components as MetaTemplate['components']) : [],
    }));

    return {
      templates,
      ...(asString(body?.paging?.cursors?.after) === null
        ? {}
        : { nextCursor: body!.paging!.cursors!.after! }),
    };
  },

  async createTemplate(
    wabaId,
    definition: MetaTemplateDefinition,
  ): Promise<{ id: string; status: string }> {
    const body = (await request({
      method: 'POST',
      path: `${wabaId}/message_templates`,
      json: definition,
      mutating: true,
    })) as { id?: string; status?: string } | null;

    return { id: asString(body?.id) ?? '', status: asString(body?.status) ?? 'PENDING' };
  },

  async getPhoneNumber(phoneNumberId): Promise<MetaPhoneNumber> {
    const body = (await request({
      method: 'GET',
      path: phoneNumberId,
      query: {
        fields:
          'display_phone_number,verified_name,quality_rating,messaging_limit_tier,throughput,platform_type,code_verification_status',
      },
    })) as Record<string, unknown> | null;

    return {
      id: asString(body?.id) ?? phoneNumberId,
      displayPhoneNumber: asString(body?.display_phone_number),
      verifiedName: asString(body?.verified_name),
      qualityRating: asString(body?.quality_rating),
      messagingLimitTier: asString(body?.messaging_limit_tier),
      throughputLevel: asString((body?.throughput as { level?: unknown } | undefined)?.level),
      platformType: asString(body?.platform_type),
      codeVerificationStatus: asString(body?.code_verification_status),
    };
  },

  /**
   * The step whose absence is invisible: the dashboard shows the webhook
   * verified, `active` and every field subscribed, the Test button works, and
   * real messages are discarded with no error anywhere. Confirmed 2026-08-15 —
   * `GET /{waba_id}/subscribed_apps` returned an empty array while everything
   * else looked correct.
   */
  async subscribeApp(wabaId): Promise<void> {
    await request({ method: 'POST', path: `${wabaId}/subscribed_apps`, mutating: true });
  },
});
