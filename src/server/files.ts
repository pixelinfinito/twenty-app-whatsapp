import { describeError, logger } from './logger';
import { BodyTooLargeError, readBodyCapped } from './read-body';
import { toolScope } from './tool-scope';

/**
 * Reading a file back out of Twenty's own storage (specs/04 §5 step 6, D-18).
 *
 * Native uploads first enter Twenty storage through the host API. The sender
 * reads retained files using freshly signed URLs before uploading to Meta.
 *
 * **This is the one module outside the provider allowed to make an HTTP
 * request, and the allowance is narrow by construction.** `resolveFileUrl`
 * always returns a URL on the workspace's own API origin, under the file
 * store, so the function cannot be repurposed into a general HTTP client — in
 * particular it cannot be handed Meta's media CDN URL, which is the exact hole
 * AR-11 exists to close. A test asserts the guard is still here, because an
 * exception to an architectural rule that nobody re-checks is just a rule that
 * was dropped.
 *
 * `RestApiClient` from the SDK is deliberately not used: it reads every
 * response with `response.text()`, which corrupts binary content silently.
 */

export class WorkspaceFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceFileError';
  }
}

export type WorkspaceFileHandle = {
  /** Absolute URL as returned on a FILES column, or a `/files/...` path. */
  url?: string | null;
  /** Storage path as returned by `uploadFile`. */
  path?: string | null;
};

const apiBaseUrl = (): string => {
  const raw = process.env.TWENTY_API_URL;

  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new WorkspaceFileError('TWENTY_API_URL is not set');
  }

  return raw.trim().replace(/\/+$/, '');
};

/**
 * The one path prefix Twenty serves stored file bytes from. Everything else on
 * the origin — `/rest`, `/graphql`, `/metadata` — is the workspace's *data*,
 * and this module holds the app's own token.
 */
const FILE_STORE_PREFIX = '/files/';

/**
 * Resolves a handle to an absolute URL **on the workspace's own API origin and
 * inside the file store**, and throws when the handle does not name a file
 * store path at all.
 *
 * Relative forms are resolved rather than rejected because that is what the
 * platform hands us: a FILES column's `url` is frequently a path, and a caller
 * forced to reassemble the base URL would reassemble it wrongly somewhere.
 *
 * **The origin is rebuilt, not validated** (D-58). The previous rule — refuse
 * anything whose origin is not `TWENTY_API_URL` — refused every attachment a
 * rep could actually supply: the panel asks them to "copy the file's address
 * from its record in Twenty", and the address in a browser is the *front-end*
 * host, while `TWENTY_API_URL` is the API one. Every outbound image, video,
 * audio file and PDF failed on it, with a message about Meta that named the
 * wrong system entirely. Taking `pathname` and `search` and re-hanging them on
 * the API origin is *stronger* than the check it replaces: the fetch target is
 * now workspace-origin by construction rather than by validation, so no input
 * — a hostile one included — can make this module talk to another host.
 *
 * The path restriction survives untouched, and it is the load-bearing one.
 * `fileUrl` and `filePath` arrive from route callers, so without it any agent
 * could name `/rest/people?...`, have this module fetch the authenticated JSON
 * with `TWENTY_APP_ACCESS_TOKEN`, and send the workspace's CRM data to a
 * WhatsApp number as a "document" — an exfiltration channel, not a file read.
 */
export const resolveFileUrl = (handle: WorkspaceFileHandle): string => {
  const base = apiBaseUrl();
  const raw = (handle.path?.trim() || handle.url || '').trim();

  if (raw.length === 0) throw new WorkspaceFileError('No file url or path was given');

  /**
   * `uploadFile` answers with a storage path — `attachment/x.png` — and not a
   * file-store URL, so a handle carrying only `filePath` would otherwise
   * resolve to `/attachment/x.png` and be refused by the prefix check below
   * for being exactly what it was asked to be.
   */
  const relative = raw.replace(/^\/+/, '');
  const candidate = /^https?:\/\//i.test(raw)
    ? raw
    : `${base}/${relative.startsWith('files/') || relative.startsWith('file/files-field/') ? relative : `files/${relative}`}`;

  let supplied: URL;
  let expected: URL;

  try {
    supplied = new URL(candidate);
    expected = new URL(base);
  } catch (error) {
    throw new WorkspaceFileError(`Could not parse the file url: ${String(error)}`);
  }

  /**
   * `new URL()` has already collapsed `.`/`..` segments, so a literal
   * traversal cannot reach here — but an *encoded* one (`%2e%2e`) survives in
   * `pathname` and would be decoded by the server, so it is rejected too.
   */
  const decodedPath = ((): string => {
    try {
      return decodeURIComponent(supplied.pathname);
    } catch {
      return supplied.pathname;
    }
  })();

  /**
   * A deployment whose API lives under a path — `https://host/api` — serves
   * its files under that path too, and the address a rep copies carries it.
   * Compared against the mount point rather than the bare prefix so neither
   * shape is refused for the other's spelling.
   */
  const mount = `${expected.pathname.replace(/\/+$/, '')}${FILE_STORE_PREFIX}`;

  const idMount = `${expected.pathname.replace(/\/+$/, '')}/file/files-field/`;
  const isFileById = supplied.pathname.startsWith(idMount) && /^[0-9a-f-]{36}$/i.test(supplied.pathname.slice(idMount.length));
  if ((!supplied.pathname.startsWith(mount) && !isFileById) || decodedPath.includes('..')) {
    throw new WorkspaceFileError(
      `Refusing to read ${supplied.pathname}: only ${mount} paths are workspace files`,
    );
  }

  // Path and query only. The query carries the file store's own signed token,
  // which is what makes a copied address readable at all.
  const resolved = new URL(expected.origin);

  resolved.pathname = supplied.pathname;
  resolved.search = supplied.search;

  return resolved.toString();
};

export type FetchLike = typeof globalThis.fetch;

export type DownloadedFile = { buffer: Buffer; mimeType: string };

/**
 * A workspace file read sits in the send path — a campaign's header image is
 * fetched before the template goes out — so it needs its own deadline. Without
 * one, a stalled connection held the sender until the platform's function
 * timeout, and every message behind it waited (D-45).
 */
export const FILE_TIMEOUT_MS = 30_000;

/**
 * WhatsApp's own largest outbound media is a 100 MB document, so nothing
 * bigger can ever be sent — buffering more than that is only ever a memory
 * exhaustion, never a successful send.
 */
export const MAX_WORKSPACE_FILE_BYTES = 100 * 1024 * 1024;

/**
 * How many times the file store may point somewhere else before we stop.
 *
 * An object-storage backend answers a file read with a 302 to a pre-signed URL
 * on the bucket's own host, so refusing every redirect refuses every send on
 * such a deployment. One hop is the real shape; three is slack for a CDN in
 * front of it, and a bound is what keeps a redirect loop from becoming the
 * function timeout.
 */
export const MAX_FILE_REDIRECTS = 3;

export const downloadWorkspaceFile = async (
  handle: WorkspaceFileHandle,
  { fetchImpl = globalThis.fetch }: { fetchImpl?: FetchLike } = {},
): Promise<DownloadedFile> => {
  const first = resolveFileUrl(handle);
  const invocation = toolScope();
  const signedToken = new URL(first).searchParams.get('token');
  if (invocation && signedToken) {
    // File URLs are bearer capabilities: the native file guard uses the URL's
    // workspace, not the Authorization header. Do not accept another workspace's
    // capability. The storage endpoint still verifies the signature and expiry.
    try {
      const payload = JSON.parse(Buffer.from(signedToken.split('.')[1] ?? '', 'base64url').toString('utf8')) as { workspaceId?: unknown };
      if (payload.workspaceId !== invocation.principal.workspaceId) throw new WorkspaceFileError('The file belongs to another workspace');
    } catch (error) {
      if (error instanceof WorkspaceFileError) throw error;
      throw new WorkspaceFileError('Invalid workspace file token');
    }
  }
  const origin = new URL(first).origin;
  const token = toolScope()?.accessToken ?? process.env.TWENTY_APP_APPLICATION_ACCESS_TOKEN ?? process.env.TWENTY_APP_ACCESS_TOKEN;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FILE_TIMEOUT_MS);

  try {
    let url = first;
    let response!: Response;

    for (let hop = 0; ; hop += 1) {
      response = await fetchImpl(url, {
        method: 'GET',
        /**
         * The app's token goes to the workspace and nowhere else. A pre-signed
         * storage URL authenticates itself through its own signature, and
         * forwarding a bearer token to whatever host a redirect names is how a
         * workspace credential ends up in a third party's access log.
         */
        headers:
          typeof token === 'string' && token.length > 0 && new URL(url).origin === origin
            ? { Authorization: `Bearer ${token}` }
            : {},
        signal: controller.signal,
        /**
         * Followed by hand rather than by `fetch`, so the hop count is ours and
         * the header decision above is re-made for each destination. `redirect:
         * 'error'` used to stand here and made an object-storage backend
         * unsendable; `redirect: 'follow'` would have leaked the token.
         */
        redirect: 'manual',
      });

      const location = response.headers.get('location');

      if (response.status < 300 || response.status > 399 || location === null) break;

      if (hop >= MAX_FILE_REDIRECTS) {
        throw new WorkspaceFileError(
          `The file store redirected more than ${MAX_FILE_REDIRECTS} times`,
        );
      }

      const next = ((): URL => {
        try {
          return new URL(location, url);
        } catch {
          throw new WorkspaceFileError(`The file store redirected to an unreadable address`);
        }
      })();

      if (next.protocol !== 'https:' && next.protocol !== 'http:') {
        throw new WorkspaceFileError(
          `Refusing to follow the file store to ${next.protocol}//…`,
        );
      }

      url = next.toString();
    }

    if (!response.ok) {
      throw new WorkspaceFileError(
        `Reading the file failed with HTTP ${response.status} ${response.statusText}`,
      );
    }

    // The body read stays inside the deadline; a stalled download is the case
    // the deadline exists for.
    return {
      buffer: await readBodyCapped(response, MAX_WORKSPACE_FILE_BYTES),
      mimeType: response.headers.get('content-type') ?? 'application/octet-stream',
    };
  } catch (error) {
    if (error instanceof WorkspaceFileError) throw error;

    if (error instanceof BodyTooLargeError) {
      throw new WorkspaceFileError(
        `The file exceeds the ${MAX_WORKSPACE_FILE_BYTES}-byte ceiling for outbound media`,
      );
    }

    logger.warn('files.download_failed', describeError(error));

    throw new WorkspaceFileError(
      controller.signal.aborted
        ? `Reading the file timed out after ${FILE_TIMEOUT_MS} ms`
        : `Could not read the file: ${String(error)}`,
    );
  } finally {
    clearTimeout(timer);
  }
};
