import { backoffDelayMs } from '../domain/pacing';
import { describeError, logger } from './logger';
import { METRIC, count } from './metrics';

/**
 * Core API call discipline (NFR-R2, C-1).
 *
 * Two constraints drive everything here. Twenty caps a bulk mutation at **60
 * records**, and the workspace has a request budget an unthrottled campaign
 * would exhaust in seconds — starving the interactive traffic a rep is waiting
 * on. So writes chunk at 60 and retry with backoff, and a 429 is treated as
 * back-pressure rather than an error.
 */

export const MAX_BATCH = 60;

export const chunk = <T>(items: readonly T[], size = MAX_BATCH): T[][] => {
  if (size < 1) throw new RangeError('chunk size must be at least 1');

  const chunks: T[][] = [];

  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }

  return chunks;
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Rate limiting and transient server errors are the only retryable shapes. A
 * validation error is deterministic — retrying it burns the budget that the
 * traffic behind it needs.
 */
export const isRetryableCoreError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error);

  if (/\b(429|too many requests|rate.?limit)\b/i.test(message)) return true;
  if (/\b(500|502|503|504|timeout|ETIMEDOUT|ECONNRESET|socket hang up)\b/i.test(message)) {
    return true;
  }

  return false;
};

export type RetryOptions = {
  maxAttempts?: number;
  baseDelayMs?: number;
  label?: string;
};

export const withRetry = async <T>(
  operation: () => T,
  { maxAttempts = 4, baseDelayMs = 500, label = 'core' }: RetryOptions = {},
): Promise<Awaited<T>> => {
  let lastError: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      count(METRIC.API_CORE_CALL);

      return await operation();
    } catch (error) {
      lastError = error;

      if (!isRetryableCoreError(error)) {
        count(METRIC.API_CORE_ERROR);
        throw error;
      }

      count(METRIC.API_CORE_429);

      const delay = backoffDelayMs(attempt, Math.random, baseDelayMs, maxAttempts - 1);
      if (delay === null) break;

      logger.debug('core.retry', { label, attempt: attempt + 1, delayMs: delay });
      await sleep(delay);
    }
  }

  logger.warn('core.retry_exhausted', { label, ...describeError(lastError) });
  throw lastError;
};

/**
 * Runs `handler` over chunks of ≤60, sequentially.
 *
 * Sequential on purpose: parallel chunks would multiply the request rate by the
 * chunk count exactly when the batch is largest, which is the moment the budget
 * is tightest.
 */
export const inBatches = async <T, R>(
  items: readonly T[],
  handler: (batch: T[], index: number) => Promise<R>,
  { size = MAX_BATCH, label = 'batch' }: { size?: number; label?: string } = {},
): Promise<R[]> => {
  const results: R[] = [];
  const batches = chunk(items, size);

  for (const [index, batch] of batches.entries()) {
    results.push(await withRetry(() => handler(batch, index), { label }));
  }

  return results;
};

/**
 * Twenty surfaces a unique-index collision as a GraphQL error. It is a normal
 * outcome for us, not a failure: it is precisely how `dedupKey` suppresses a
 * Meta redelivery and how `IDX_THREAD_ACCOUNT_WAID` resolves two simultaneous
 * inbound messages from a new number into one thread (D-12).
 */
export const isUniqueViolation = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error);

  return /duplicate key|unique constraint|already exists|uniqueness violation/i.test(message);
};
