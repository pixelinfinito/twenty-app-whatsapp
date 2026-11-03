import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WorkspaceFileError, downloadWorkspaceFile, resolveFileUrl } from './files';

/**
 * `server/files.ts` is the only module outside the provider allowed to make an
 * HTTP request, so its origin guard is load-bearing for AR-11 rather than
 * merely defensive. These tests are what keeps the exception narrow — the
 * architecture test asserts the guard exists; these assert it works.
 *
 * The guard changed shape in D-58: the origin is now *rebuilt* rather than
 * *validated*, because validating it refused the only address a rep can
 * actually supply (the front-end host, not the API one) and broke every
 * outbound attachment. The invariant these tests hold to is therefore stronger
 * than the one they held before — every resolved URL is on the workspace API
 * origin, for every input — and the path restriction, which is the part that
 * stops `/rest/people` being read with the app's token, is unchanged.
 */

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV, TWENTY_API_URL: 'https://crm.example.test' };
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('resolving a workspace file url', () => {
  it('accepts an absolute url on the workspace origin', () => {
    expect(resolveFileUrl({ url: 'https://crm.example.test/files/a/b.png' })).toBe(
      'https://crm.example.test/files/a/b.png',
    );
  });

  it('resolves a path against the api base', () => {
    expect(resolveFileUrl({ path: 'files/a/b.png' })).toBe(
      'https://crm.example.test/files/a/b.png',
    );
    expect(resolveFileUrl({ url: '/files/a/b.png' })).toBe(
      'https://crm.example.test/files/a/b.png',
    );
  });

  /**
   * `uploadFile` answers with `attachment/<uuid>.<ext>` and nothing else, so a
   * handle carrying only `filePath` — the voice recorder's — used to resolve to
   * `/attachment/…` and be refused for not being under the file store.
   */
  it('mounts a bare storage path under the file store', () => {
    expect(resolveFileUrl({ path: 'attachment/abc.ogg' })).toBe(
      'https://crm.example.test/files/attachment/abc.ogg',
    );
  });

  /**
   * The reason the guard exists. Meta's media CDN url arrives *inside* a
   * webhook payload, so a file reader that fetched whatever it was handed would
   * be a second, unclassified, unretried path to Meta — exactly what AR-11
   * forbids. It is refused on its *path*, which is the check that survived
   * D-58 — nothing outside `/files/` is readable, on any host.
   */
  it('refuses Meta’s media CDN', () => {
    expect(() =>
      resolveFileUrl({ url: 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1' }),
    ).toThrow(WorkspaceFileError);
  });

  /**
   * D-58. The address a rep copies out of Twenty is the front-end one, and the
   * app's `TWENTY_API_URL` is the API one; refusing the mismatch failed every
   * outbound image, video, audio file and PDF. The path and the signed token
   * are kept, the host is replaced with the workspace's own, and the request
   * therefore cannot reach the host that was typed.
   */
  it.each([
    ['a different front-end host', 'https://app.crm.example.test/files/a/b.png'],
    ['a different scheme', 'http://crm.example.test/files/a/b.png'],
    ['a different port', 'https://crm.example.test:8443/files/a/b.png'],
    ['a hostname that merely begins with it', 'https://crm.example.test.attacker.test/files/a/b.png'],
    ['a bare other host', 'https://evil.test/files/a/b.png'],
  ])('re-hangs %s on the workspace api origin', (_label, url) => {
    expect(resolveFileUrl({ url })).toBe('https://crm.example.test/files/a/b.png');
  });

  /** The signed token is what makes a copied address readable at all. */
  it('keeps the file store’s signed token', () => {
    expect(resolveFileUrl({ url: 'https://app.crm.example.test/files/a/b.png?token=abc.def' })).toBe(
      'https://crm.example.test/files/a/b.png?token=abc.def',
    );
  });

  it('refuses an empty handle', () => {
    expect(() => resolveFileUrl({})).toThrow(/No file url or path/);
  });

  /**
   * The origin check alone is not enough: everything on the origin outside
   * `/files/` is the workspace's *data*, and this module fetches with the
   * app's own token. `/rest/people` sent to a WhatsApp number as a "document"
   * is an exfiltration, not a file read.
   */
  it.each([
    ['the REST API', 'https://crm.example.test/rest/people?limit=100'],
    ['GraphQL', 'https://crm.example.test/graphql'],
    ['a bare path', 'https://crm.example.test/anything'],
    ['a files lookalike', 'https://crm.example.test/files-2/x.png'],
  ])('refuses %s even on the workspace origin', (_label, url) => {
    expect(() => resolveFileUrl({ url })).toThrow(/only \/files\/ paths/);
  });

  it('refuses an encoded traversal out of the file store', () => {
    expect(() => resolveFileUrl({ url: 'https://crm.example.test/files/%2e%2e/rest/people' })).toThrow(
      WorkspaceFileError,
    );
    // A literal traversal is collapsed by URL parsing and lands outside /files/.
    expect(() => resolveFileUrl({ url: 'https://crm.example.test/files/../rest/people' })).toThrow(
      WorkspaceFileError,
    );
  });

  it('fails closed when the api url is not configured', () => {
    delete process.env.TWENTY_API_URL;

    expect(() => resolveFileUrl({ url: 'https://crm.example.test/files/x' })).toThrow(
      /TWENTY_API_URL/,
    );
  });
});

describe('downloading a workspace file', () => {
  const response = (bytes: number[], contentType: string): Response =>
    new Response(new Uint8Array(bytes).buffer as ArrayBuffer, {
      status: 200,
      headers: { 'content-type': contentType },
    });

  it('returns the bytes and the content type', async () => {
    const bytes = [0x89, 0x50, 0x4e, 0x47, 0x00, 0xff];
    const fetchImpl = vi.fn().mockResolvedValue(response(bytes, 'image/png'));

    const file = await downloadWorkspaceFile(
      { path: 'files/a/b.png' },
      { fetchImpl: fetchImpl as unknown as typeof globalThis.fetch },
    );

    expect(file.mimeType).toBe('image/png');
    expect([...file.buffer]).toEqual(bytes);
  });

  /**
   * Binary fidelity is the whole reason this module exists rather than the
   * SDK's REST client, which reads every response with `.text()` and would
   * mangle these bytes into replacement characters without erroring.
   */
  it('preserves bytes that are not valid utf-8', async () => {
    const bytes = [0xff, 0xd8, 0xff, 0xe0, 0x80, 0x81];
    const fetchImpl = vi.fn().mockResolvedValue(response(bytes, 'image/jpeg'));

    const file = await downloadWorkspaceFile(
      { path: 'files/x.jpg' },
      { fetchImpl: fetchImpl as unknown as typeof globalThis.fetch },
    );

    expect([...file.buffer]).toEqual(bytes);
    expect(file.buffer.length).toBe(6);
  });

  it('never issues a request for a path outside the file store', async () => {
    const fetchImpl = vi.fn();

    await expect(
      downloadWorkspaceFile(
        { url: 'https://lookaside.fbsbx.com/x' },
        { fetchImpl: fetchImpl as unknown as typeof globalThis.fetch },
      ),
    ).rejects.toThrow(WorkspaceFileError);

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  /** Whatever host was typed, the request goes to the workspace's own. */
  it('requests the workspace origin even for a foreign address', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response([1], 'image/png'));

    await downloadWorkspaceFile(
      { url: 'https://evil.test/files/a/b.png' },
      { fetchImpl: fetchImpl as unknown as typeof globalThis.fetch },
    );

    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://crm.example.test/files/a/b.png');
  });

  it('sends the app access token when there is one', async () => {
    process.env.TWENTY_APP_ACCESS_TOKEN = 'token-abc';

    const fetchImpl = vi
      .fn()
      .mockResolvedValue(response([1], 'application/pdf'));

    await downloadWorkspaceFile(
      { path: 'files/x.pdf' },
      { fetchImpl: fetchImpl as unknown as typeof globalThis.fetch },
    );

    expect(fetchImpl.mock.calls[0]?.[1]?.headers).toEqual({
      Authorization: 'Bearer token-abc',
    });
  });

  /**
   * D-45. This read sits in the send path — a campaign's header image is
   * fetched before the template goes out — so a stalled connection used to
   * hold the sender until the platform's own timeout, with every message
   * behind it waiting.
   */
  it('passes an abort signal so a stalled read cannot hold the sender', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response([1], 'image/png'));

    await downloadWorkspaceFile(
      { path: 'files/x.png' },
      { fetchImpl: fetchImpl as unknown as typeof globalThis.fetch },
    );

    expect(fetchImpl.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('turns an aborted read into a WorkspaceFileError like any other failure', async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }));

    await expect(
      downloadWorkspaceFile(
        { path: 'files/slow.png' },
        { fetchImpl: fetchImpl as unknown as typeof globalThis.fetch },
      ),
    ).rejects.toBeInstanceOf(WorkspaceFileError);
  });

  /**
   * Redirects are followed by hand, so the hop count and the token decision
   * are ours. `redirect: 'follow'` would hand the app's bearer token to
   * whatever host the file store named.
   */
  it('follows redirects itself rather than letting fetch do it', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response([1], 'image/png'));

    await downloadWorkspaceFile(
      { path: 'files/x.png' },
      { fetchImpl: fetchImpl as unknown as typeof globalThis.fetch },
    );

    expect(fetchImpl.mock.calls[0]?.[1]?.redirect).toBe('manual');
  });

  const redirect = (location: string): Response =>
    new Response(null, { status: 302, headers: { location } });

  /**
   * An object-storage backend answers a file read with a 302 to a pre-signed
   * URL on the bucket's host. Refusing it refused every send on such a
   * deployment.
   */
  it('follows the file store to pre-signed object storage', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(redirect('https://bucket.storage.test/o/abc?sig=xyz'))
      .mockResolvedValueOnce(response([7, 8], 'image/png'));

    const file = await downloadWorkspaceFile(
      { path: 'files/x.png' },
      { fetchImpl: fetchImpl as unknown as typeof globalThis.fetch },
    );

    expect([...file.buffer]).toEqual([7, 8]);
    expect(fetchImpl.mock.calls[1]?.[0]).toBe('https://bucket.storage.test/o/abc?sig=xyz');
  });

  /**
   * The app's token is a workspace credential. A pre-signed URL carries its own
   * signature, so forwarding the bearer would only ever put ours in a third
   * party's access log.
   */
  it('does not forward the app token off the workspace origin', async () => {
    process.env.TWENTY_APP_ACCESS_TOKEN = 'token-abc';

    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(redirect('https://bucket.storage.test/o/abc?sig=xyz'))
      .mockResolvedValueOnce(response([1], 'image/png'));

    await downloadWorkspaceFile(
      { path: 'files/x.png' },
      { fetchImpl: fetchImpl as unknown as typeof globalThis.fetch },
    );

    expect(fetchImpl.mock.calls[0]?.[1]?.headers).toEqual({ Authorization: 'Bearer token-abc' });
    expect(fetchImpl.mock.calls[1]?.[1]?.headers).toEqual({});
  });

  it('stops rather than chasing a redirect loop', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(redirect('https://crm.example.test/files/loop'));

    await expect(
      downloadWorkspaceFile(
        { path: 'files/x.png' },
        { fetchImpl: fetchImpl as unknown as typeof globalThis.fetch },
      ),
    ).rejects.toThrow(/redirected more than/);
  });

  it('refuses a body whose declared length is over the media ceiling', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(new Uint8Array([1]).buffer as ArrayBuffer, {
        status: 200,
        headers: {
          'content-type': 'video/mp4',
          'content-length': String(101 * 1024 * 1024),
        },
      }),
    );

    await expect(
      downloadWorkspaceFile(
        { path: 'files/huge.mp4' },
        { fetchImpl: fetchImpl as unknown as typeof globalThis.fetch },
      ),
    ).rejects.toThrow(/ceiling/);
  });

  it('turns a non-200 into a WorkspaceFileError naming the status', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response('nope', { status: 404, statusText: 'Not Found' }));

    await expect(
      downloadWorkspaceFile(
        { path: 'files/missing.png' },
        { fetchImpl: fetchImpl as unknown as typeof globalThis.fetch },
      ),
    ).rejects.toThrow(/404/);
  });
});


it('accepts only the Twenty 2.54 files-field download route, rebuilding its origin', () => {
  const id = 'f8fbe965-b9d1-48f6-ba60-d57626818508';
  expect(resolveFileUrl({ url: `https://front.example.test/file/files-field/${id}?token=signed` })).toBe(`https://crm.example.test/file/files-field/${id}?token=signed`);
  expect(() => resolveFileUrl({ url: `https://crm.example.test/file/app-tarball/${id}?token=x` })).toThrow(WorkspaceFileError);
  expect(() => resolveFileUrl({ url: 'https://crm.example.test/file/files-field/not-an-id' })).toThrow(WorkspaceFileError);
});
