import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createCloudApiProvider, isAllowedMediaHost } from './cloud-api.provider';
import { MissingConfigError, requireSecret } from './config';
import { ERROR_CLASS, MetaApiError, classify } from './errors';
import { DEFAULT_PROVIDER, getProvider, resetProviderCache } from './index';

/**
 * Transport behaviour with `fetch` stubbed. What matters here is not that a URL
 * is well formed but that each failure mode maps to the outcome the outbound
 * pipeline depends on — particularly the one that must never be retried.
 */

const ORIGINAL_ENV = { ...process.env };

const jsonResponse = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  process.env.META_ACCESS_TOKEN = 'test-token';
  process.env.META_GRAPH_VERSION = 'v26.0';
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  resetProviderCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  process.env = { ...ORIGINAL_ENV };
  resetProviderCache();
});

const provider = () => createCloudApiProvider();

describe('config', () => {
  /** SEC-1: no default, no `?? ''`, no development fallback. */
  it('fails closed on a missing secret', () => {
    delete process.env.META_ACCESS_TOKEN;

    expect(() => requireSecret('META_ACCESS_TOKEN')).toThrow(MissingConfigError);
  });

  it('treats a whitespace-only value as missing', () => {
    process.env.META_ACCESS_TOKEN = '   ';

    expect(() => requireSecret('META_ACCESS_TOKEN')).toThrow(MissingConfigError);
  });

  it('never puts the value in the error message', () => {
    process.env.META_APP_SECRET = 'super-secret';
    delete process.env.META_VERIFY_TOKEN;

    try {
      requireSecret('META_VERIFY_TOKEN');
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toContain('META_VERIFY_TOKEN');
      expect((error as Error).message).not.toContain('super-secret');
    }
  });
});

describe('sendMessage', () => {
  it('posts to the pinned Graph version with a bearer token', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        contacts: [{ input: '244917164819', wa_id: '244917164819' }],
        messages: [{ id: 'wamid.ABC' }],
      }),
    );

    const result = await provider().sendMessage({
      phoneNumberId: '1206450239224164',
      payload: {
        messaging_product: 'whatsapp',
        to: '244917164819',
        type: 'text',
        text: { body: 'Olá' },
      },
    });

    expect(result).toMatchObject({ wamid: 'wamid.ABC', resolvedWaId: '244917164819' });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://graph.facebook.com/v26.0/1206450239224164/messages');
    expect((init as RequestInit).method).toBe('POST');
    expect((init as { headers: Record<string, string> }).headers.authorization).toBe(
      'Bearer test-token',
    );
  });

  /**
   * The WAMID is the idempotency key for every status webhook that follows. A
   * record without one can never be matched, so a 200 without it is an error.
   */
  it('refuses a success response carrying no message id', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { messages: [] }));

    await expect(
      provider().sendMessage({
        phoneNumberId: '1',
        payload: { messaging_product: 'whatsapp', to: '2', type: 'text' },
      }),
    ).rejects.toThrow(MetaApiError);
  });

  it('turns a Graph error body into a classified MetaApiError', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(400, { error: { message: 'Re-engagement', code: 131047 } }),
    );

    await expect(
      provider().sendMessage({
        phoneNumberId: '1',
        payload: { messaging_product: 'whatsapp', to: '2', type: 'text' },
      }),
    ).rejects.toMatchObject({ code: 131047, httpStatus: 400 });
  });

  /**
   * The single most consequential branch in the transport: an abort means the
   * request was fully written and the outcome is unknown. Retrying could send
   * the customer a duplicate.
   */
  it('marks a timed-out send ambiguous rather than retryable', async () => {
    fetchMock.mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }));

    try {
      await provider().sendMessage({
        phoneNumberId: '1',
        payload: { messaging_product: 'whatsapp', to: '2', type: 'text' },
      });
      expect.unreachable();
    } catch (error) {
      expect((error as MetaApiError).ambiguous).toBe(true);
      expect(classify(error as MetaApiError).class).toBe(ERROR_CLASS.TERMINAL_UNKNOWN);
    }
  });

  it('treats a connection failure as retryable', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNRESET'));

    try {
      await provider().sendMessage({
        phoneNumberId: '1',
        payload: { messaging_product: 'whatsapp', to: '2', type: 'text' },
      });
      expect.unreachable();
    } catch (error) {
      expect((error as MetaApiError).ambiguous).toBe(false);
      expect(classify(error as MetaApiError).class).toBe(ERROR_CLASS.RETRYABLE_BACKOFF);
    }
  });

  it('does not choke on a non-JSON error body', async () => {
    fetchMock.mockResolvedValue(new Response('<html>502</html>', { status: 502 }));

    await expect(
      provider().sendMessage({
        phoneNumberId: '1',
        payload: { messaging_product: 'whatsapp', to: '2', type: 'text' },
      }),
    ).rejects.toMatchObject({ httpStatus: 502 });
  });
});

describe('media', () => {
  it('resolves a media id to a download handle', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        url: 'https://lookaside.fbsbx.com/x',
        mime_type: 'audio/ogg',
        file_size: 12345,
        sha256: 'abc',
      }),
    );

    expect(await provider().fetchMediaUrl('987')).toEqual({
      url: 'https://lookaside.fbsbx.com/x',
      mimeType: 'audio/ogg',
      fileSize: 12345,
      sha256: 'abc',
    });
  });

  it('parses a string file_size', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { url: 'https://x/y', file_size: '999' }));

    expect((await provider().fetchMediaUrl('1')).fileSize).toBe(999);
  });

  /** C-6: the CDN URL is not a Graph call but still needs the bearer token. */
  it('downloads from the CDN URL verbatim, with the token attached', async () => {
    fetchMock.mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { 'content-type': 'audio/ogg' },
      }),
    );

    const result = await provider().downloadMedia('https://lookaside.fbsbx.com/attachments/?mid=1');

    expect(result.mimeType).toBe('audio/ogg');
    expect([...result.buffer]).toEqual([1, 2, 3]);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://lookaside.fbsbx.com/attachments/?mid=1');
    expect((init as { headers: Record<string, string> }).headers.authorization).toBe(
      'Bearer test-token',
    );
  });

  /** The short-lived URL expiring is normal; the caller re-resolves from the id. */
  it('surfaces an expired URL as a 410 the caller can act on', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 410 }));

    await expect(
      provider().downloadMedia('https://lookaside.fbsbx.com/attachments/?mid=expired'),
    ).rejects.toMatchObject({ httpStatus: 410 });
  });

  /**
   * D-41. This is the one call whose URL comes from a payload rather than being
   * built here, and it attaches the access token — so the URL decides who
   * receives the credential.
   */
  describe('where the access token may be sent', () => {
    it.each([
      'https://lookaside.fbsbx.com/attachments/?mid=1',
      'https://graph.facebook.com/v23.0/1234/media',
      'https://scontent.xx.fbcdn.net/v/t62.1/file.jpg',
      'https://mmg.whatsapp.net/d/f/abc.enc',
    ])('allows %s', (url) => {
      expect(isAllowedMediaHost(url)).toBe(true);
    });

    it.each([
      'https://evil.example.com/steal',
      'http://lookaside.fbsbx.com/attachments/?mid=1',
      'https://lookaside.fbsbx.com.evil.example/x',
      'https://fbcdn.net.attacker.io/x',
      'not a url',
    ])('refuses %s', (url) => {
      expect(isAllowedMediaHost(url)).toBe(false);
    });

    it('does not call fetch at all for a host it refuses', async () => {
      fetchMock.mockClear();

      await expect(provider().downloadMedia('https://evil.example.com/steal')).rejects.toThrow(
        /unrecognised media host/,
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  it('uploads media as multipart', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { id: '555' }));

    expect(
      await provider().uploadMedia({
        phoneNumberId: '1',
        buffer: Buffer.from('hello'),
        mimeType: 'image/png',
        filename: 'a.png',
      }),
    ).toEqual({ mediaId: '555' });

    expect((fetchMock.mock.calls[0]![1] as RequestInit).body).toBeInstanceOf(FormData);
  });
});

describe('templates and account', () => {
  it('maps the template list and its cursor', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        data: [
          {
            id: '1',
            name: 'proposta',
            language: 'pt_PT',
            status: 'APPROVED',
            category: 'MARKETING',
            quality_score: { score: 'GREEN' },
            components: [{ type: 'BODY', text: 'Olá {{1}}' }],
          },
        ],
        paging: { cursors: { after: 'CURSOR' } },
      }),
    );

    const result = await provider().listTemplates('waba1');

    expect(result.templates[0]).toMatchObject({
      id: '1',
      name: 'proposta',
      qualityScore: 'GREEN',
    });
    expect(result.nextCursor).toBe('CURSOR');
  });

  it('reports no cursor on the last page', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { data: [], paging: {} }));

    expect(await provider().listTemplates('waba1')).toEqual({ templates: [] });
  });

  it('reads the phone number health fields', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        id: '1',
        display_phone_number: '244978735650',
        verified_name: 'Pixel',
        quality_rating: 'GREEN',
        messaging_limit_tier: 'TIER_1K',
        throughput: { level: 'STANDARD' },
        platform_type: 'CLOUD_API',
        code_verification_status: 'VERIFIED',
      }),
    );

    expect(await provider().getPhoneNumber('1')).toEqual({
      id: '1',
      displayPhoneNumber: '244978735650',
      verifiedName: 'Pixel',
      qualityRating: 'GREEN',
      messagingLimitTier: 'TIER_1K',
      throughputLevel: 'STANDARD',
      platformType: 'CLOUD_API',
      codeVerificationStatus: 'VERIFIED',
    });
  });

  /**
   * The fields that decide whether a webhook can ever fire, and the reason
   * they are read at all.
   *
   * A number can sit in the WABA and answer with a name, a quality rating and
   * a tier while not being registered for Cloud API — every field the probe
   * used to read is populated in that state. So the account went CONNECTED,
   * the panel went green, messages were delivered by WhatsApp with two ticks
   * on the sender's phone, and no event ever arrived.
   */
  it('asks Meta for platform_type and code_verification_status', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { id: '1' }));

    await provider().getPhoneNumber('1');

    const url = String(fetchMock.mock.calls[0][0]);

    expect(url).toContain('platform_type');
    expect(url).toContain('code_verification_status');
  });

  it('reports a number that is in the WABA but not on Cloud API', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        id: '1',
        display_phone_number: '244978735650',
        verified_name: 'Pixel',
        quality_rating: 'GREEN',
        platform_type: 'NOT_APPLICABLE',
      }),
    );

    const number = await provider().getPhoneNumber('1');

    // Healthy-looking on every other field, which is the whole problem.
    expect(number.qualityRating).toBe('GREEN');
    expect(number.platformType).toBe('NOT_APPLICABLE');
  });

  /**
   * The step whose absence is invisible: everything in the dashboard looks
   * correct and real messages are silently discarded (confirmed 2026-08-15).
   */
  it('subscribes the app to a WABA', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { success: true }));

    await provider().subscribeApp('waba1');

    expect(fetchMock.mock.calls[0]![0]).toBe(
      'https://graph.facebook.com/v26.0/waba1/subscribed_apps',
    );
    expect((fetchMock.mock.calls[0]![1] as RequestInit).method).toBe('POST');
  });
});

describe('getProvider', () => {
  it('returns the Cloud API implementation by default', () => {
    delete process.env.WA_PROVIDER;

    expect(getProvider().name).toBe('meta-cloud-api');
  });

  it('memoises within a provider selection', () => {
    expect(getProvider()).toBe(getProvider());
  });

  /** A silent fallback would send real messages through an unselected provider. */
  it('throws on an unknown WA_PROVIDER rather than falling back', () => {
    process.env.WA_PROVIDER = 'TWILIO';

    expect(() => getProvider()).toThrow(/Unknown WA_PROVIDER/);
  });
});

describe('the provider registry and the config declaration', () => {
  /**
   * These are two sources of truth for one string: the SELECT options an admin
   * picks from in Settings, and the keys `getProvider` knows. When they drifted
   * (`cloud-api` vs `META_CLOUD_API`) everything typechecked, every unit test
   * passed, the app applied cleanly — and the first live connect failed with
   * "Unknown WA_PROVIDER". Only a real call could have found it, so now a test
   * does.
   *
   * Read from the source text rather than the module: `defineApplication`
   * returns a wrapped manifest, and asserting against its internal shape would
   * make this test about the SDK instead of about the drift.
   */
  const source = readFileSync(join(process.cwd(), 'src/application-config.ts'), 'utf8');

  const providerBlock = /WA_PROVIDER:\s*\{[\s\S]*?\n {4}\}/.exec(source)?.[0] ?? '';

  const declaredDefault = /value:\s*'([^']+)'/.exec(providerBlock)?.[1] ?? null;

  const declaredOptions = [...providerBlock.matchAll(/\{\s*label:\s*'[^']*',\s*value:\s*'([^']+)'\s*\}/g)].map(
    (match) => match[1]!,
  );

  it('found the declaration to compare against', () => {
    expect(declaredDefault).not.toBeNull();
    expect(declaredOptions.length).toBeGreaterThan(0);
  });

  it('offers exactly the providers the factory can build', () => {
    for (const option of declaredOptions) {
      process.env.WA_PROVIDER = option;
      resetProviderCache();

      expect(() => getProvider(), `option ${option}`).not.toThrow();
    }
  });

  it('declares a default the factory also accepts', () => {
    process.env.WA_PROVIDER = declaredDefault!;
    resetProviderCache();

    expect(() => getProvider()).not.toThrow();
    expect(declaredDefault).toBe(DEFAULT_PROVIDER);
  });
});

describe('legacy provider values', () => {
  /**
   * An application variable already saved in a workspace is a user setting, so
   * changing the declaration does not overwrite it. Every install that ran the
   * earlier build still holds `cloud-api` — which is exactly how the first live
   * connect failed.
   */
  it.each(['cloud-api', 'CLOUD-API', 'Cloud_Api', '  cloud-api  '])(
    'still resolves the shipped legacy value %p',
    (value) => {
      process.env.WA_PROVIDER = value;
      resetProviderCache();

      expect(getProvider().name).toBe('meta-cloud-api');
    },
  );

  /** An alias is not a fallback: anything genuinely unknown still throws. */
  it('does not turn the alias rule into a catch-all', () => {
    for (const value of ['twilio', 'meta-cloud-api-v2', 'infobip']) {
      process.env.WA_PROVIDER = value;
      resetProviderCache();

      expect(() => getProvider(), value).toThrow(/Unknown WA_PROVIDER/);
    }
  });
});
