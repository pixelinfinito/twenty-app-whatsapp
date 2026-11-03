import { coreClient } from '../clients';
import { withRetry } from '../batching';

/**
 * Shared plumbing for the typed repositories.
 *
 * The generated genql client is fully typed against this workspace's schema, so
 * the repositories do not wrap it to add safety — they wrap it to add
 * *discipline*: every read goes through the retry policy, every list unwraps
 * the Relay envelope the same way, and no handler assembles a GraphQL document
 * by hand.
 */

/**
 * Twenty types every RAW_JSON column as an object, never a bare array. Anything
 * list-shaped is therefore stored under a key — `{ contacts: [...] }` rather
 * than `[...]` — which the normaliser produces directly so no repository has to
 * re-wrap it on the way past.
 */
export type JsonObject = Record<string, unknown>;

type RawConnection = {
  edges?: readonly (unknown | null)[] | null;
  pageInfo?: { hasNextPage?: boolean | null; endCursor?: string | null } | null;
};

/**
 * Unwraps a Relay connection.
 *
 * The node type is asserted rather than inferred. genql's result types are
 * deep `Pick` unions that do not unify structurally with a hand-written record
 * shape, and fighting that would produce a type helper nobody could read. The
 * safety that matters is preserved: `client.query` still validates the
 * *selection* against the workspace schema, so a renamed or misspelled field is
 * a compile error at the call site.
 */
export const nodesOf = <T>(connection: RawConnection | null | undefined): T[] =>
  (connection?.edges ?? [])
    .map((edge) => (edge as { node?: T | null } | null)?.node)
    .filter((node): node is T => node !== null && node !== undefined);

export const pageOf = <T>(
  connection: RawConnection | null | undefined,
): { items: T[]; nextCursor: string | null } => ({
  items: nodesOf<T>(connection),
  nextCursor:
    connection?.pageInfo?.hasNextPage === true ? (connection.pageInfo.endCursor ?? null) : null,
});

/**
 * **Never use the singular record query for a lookup that may miss.**
 *
 * `whatsappThread(filter: …)` does not return `null` for a record that is not
 * there — it returns `null` *and* a GraphQL error, `RECORD_NOT_FOUND`, which
 * genql raises. So a `findXById` written the obvious way throws instead of
 * reporting absence, and every caller's `=== null` branch is unreachable:
 * a deleted thread turns a clean 404 into a 500, and inside a queued job it
 * turns a missing record into a lost job.
 *
 * Every finder therefore uses the plural query with an id filter and
 * `first: 1`, which answers an empty connection. An architecture test keeps it
 * that way, because the singular form is the one an editor's autocomplete
 * offers first.
 */

/**
 * Whether a value can be handed to an `id` filter at all.
 *
 * `id` is a `UUIDFilter`, and the server validates the *shape* before it looks
 * anything up — so `findAccountById('123456789')` does not answer "not found",
 * it raises. That matters wherever a caller may legitimately supply either an
 * id or a human-facing alternative: `findAccountById(x) ?? findAccountByPhoneNumberId(x)`
 * reads as a fallback chain and is not one, because the first call throws
 * before the `??` is ever reached.
 *
 * The workflow action is where this bites hardest — a step author types a
 * template *name*, since a select's options cannot be resolved at design time —
 * but the same shape appears anywhere a `phone_number_id` may stand in for an
 * account id.
 */
export const isUuid = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.trim());

/**
 * Every repository read and write funnels through these two, so the retry
 * policy and the call counters cannot be forgotten at a call site.
 */
export const query = async <T>(
  build: (client: ReturnType<typeof coreClient>) => T,
  label: string,
): Promise<Awaited<T>> => withRetry(() => build(coreClient()), { label });

export const mutate = query;

/** Twenty stores RAW_JSON as parsed JSON but tolerates a string on write. */
export const asJson = <T>(value: unknown, fallback: T): T => {
  if (value === null || value === undefined) return fallback;

  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }

  return value as T;
};

export const toDate = (value: unknown): Date | null => {
  if (value instanceof Date) return value;
  if (typeof value !== 'string' || value.length === 0) return null;

  const parsed = new Date(value);

  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

export const iso = (value: Date | null | undefined): string | null =>
  value instanceof Date ? value.toISOString() : null;
