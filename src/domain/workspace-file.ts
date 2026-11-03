/**
 * What counts as an address the sender can read bytes from (D-58).
 *
 * The server's rule lives in `server/files.ts` and is the binding one: only a
 * path inside Twenty's own file store is fetched, so an address pointing
 * anywhere else is a send that is already lost. Every form that asks a rep for
 * a file — the attachment panel, the template picker's media header, the
 * campaign builder's — needs to apply the same rule *before* the send, and none
 * of them can import the server module: it reads `process.env` and makes HTTP
 * requests, neither of which exists in the front-component sandbox.
 *
 * So the shape test lives here, pure and shared. It is deliberately the weaker
 * half of the server's check — it does not know the workspace's origin and does
 * not need to, because the server rebuilds the origin anyway. What it catches
 * is the case that actually happened: a public image URL, a Drive link, a Meta
 * CDN address, typed into a box that accepted any URL at all.
 */

/** The one path prefix Twenty serves stored file bytes from. */
export const FILE_STORE_SEGMENT = '/files/';

/**
 * Whether this looks like a Twenty file address.
 *
 * Absolute and relative forms both pass, because both are things the platform
 * hands out: a FILES column's `url` is often a path, and the address a rep
 * copies out of a browser is absolute and on the *front-end* host rather than
 * the API one. Judging the host would therefore reject the commonest correct
 * answer, which is exactly the mistake the server used to make.
 */
export const isWorkspaceFileAddress = (raw: string | null | undefined): boolean => {
  if (typeof raw !== 'string') return false;

  const trimmed = raw.trim();

  if (trimmed.length === 0) return false;

  try {
    const parsed = new URL(trimmed, 'https://relative.invalid');

    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;

    // `/files/` anywhere in the path, not only at the start: a deployment whose
    // API is mounted under a prefix serves `/api/files/…`.
    return parsed.pathname.includes(FILE_STORE_SEGMENT) || /\/file\/files-field\/[0-9a-f-]{36}$/i.test(parsed.pathname);
  } catch {
    return false;
  }
};
