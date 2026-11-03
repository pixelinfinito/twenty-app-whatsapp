import type {
  AccountStatus,
  MessagingTier,
  Quality,
} from '../../domain/constants';
import { logger } from '../logger';
import { nodesOf, query } from './base';

/**
 * `whatsappAccount` reads and the narrow writes ingestion performs.
 *
 * The account is the routing anchor: a webhook arrives naming a
 * `phone_number_id`, and everything downstream — throttle, calling code,
 * auto-creation, assignment — is read from the matching record. A change that
 * cannot find its account is another tenant's traffic and must be dropped
 * (specs/03 §2.2), which is why `findByPhoneNumberId` returning null is a
 * meaningful answer rather than an error.
 */

const ACCOUNT_FIELDS = {
  id: true,
  name: true,
  phoneNumberId: true,
  wabaId: true,
  displayPhoneNumber: true,
  displayName: true,
  status: true,
  statusDetail: true,
  qualityRating: true,
  messagingLimitTier: true,
  tierUniqueUsersUsed: true,
  tierWindowStartedAt: true,
  throughputPerSecond: true,
  sendThrottlePerSecond: true,
  interactiveCursorAt: true,
  campaignCursorAt: true,
  webhookLastEventAt: true,
  webhookLastVerifiedAt: true,
  tokenLastCheckedAt: true,
  defaultCountryCallingCode: true,
  isTestAccount: true,
  contactAutoCreationEnabled: true,
  autoAssignStrategy: true,
  lastAssignedIndex: true,
  assignmentMemberIds: true,
} as const;

export type WhatsappAccountRecord = {
  id: string;
  name?: string | null;
  phoneNumberId?: string | null;
  wabaId?: string | null;
  displayPhoneNumber?: string | null;
  displayName?: string | null;
  status?: string | null;
  statusDetail?: string | null;
  qualityRating?: string | null;
  messagingLimitTier?: string | null;
  tierUniqueUsersUsed?: number | null;
  tierWindowStartedAt?: string | null;
  throughputPerSecond?: number | null;
  sendThrottlePerSecond?: number | null;
  interactiveCursorAt?: string | null;
  campaignCursorAt?: string | null;
  webhookLastEventAt?: string | null;
  webhookLastVerifiedAt?: string | null;
  tokenLastCheckedAt?: string | null;
  defaultCountryCallingCode?: string | null;
  isTestAccount?: boolean | null;
  contactAutoCreationEnabled?: boolean | null;
  autoAssignStrategy?: string | null;
  lastAssignedIndex?: number | null;
  assignmentMemberIds?: string[] | null;
};

export const findAccountByPhoneNumberId = async (
  phoneNumberId: string | null | undefined,
): Promise<WhatsappAccountRecord | null> => {
  if (typeof phoneNumberId !== 'string' || phoneNumberId.length === 0) return null;

  const result = await query(
    (client) =>
      client.query({
        whatsappAccounts: {
          __args: { filter: { phoneNumberId: { eq: phoneNumberId } }, first: 1 },
          edges: { node: ACCOUNT_FIELDS },
        },
      }),
    'accounts.findByPhoneNumberId',
  );

  return (nodesOf(result.whatsappAccounts)[0] as WhatsappAccountRecord | undefined) ?? null;
};

/**
 * The WABA fallback matters more than it looks: template and account events
 * carry no `phone_number_id` at all, so without it every template approval
 * would be dropped as unclaimed (specs/03 §2.2).
 */
export const findAccountByWabaId = async (
  wabaId: string | null | undefined,
): Promise<WhatsappAccountRecord | null> => {
  if (typeof wabaId !== 'string' || wabaId.length === 0) return null;

  const result = await query(
    (client) =>
      client.query({
        whatsappAccounts: {
          __args: { filter: { wabaId: { eq: wabaId } }, first: 1 },
          edges: { node: ACCOUNT_FIELDS },
        },
      }),
    'accounts.findByWabaId',
  );

  return (nodesOf(result.whatsappAccounts)[0] as WhatsappAccountRecord | undefined) ?? null;
};

export const findAccountById = async (id: string): Promise<WhatsappAccountRecord | null> => {
  const result = await query(
    (client) =>
      client.query({
        whatsappAccounts: {
          __args: { filter: { id: { eq: id } }, first: 1 },
          edges: { node: ACCOUNT_FIELDS },
        },
      }),
    'accounts.findById',
  );

  return nodesOf<WhatsappAccountRecord>(result.whatsappAccounts)[0] ?? null;
};

/** More numbers than this in one workspace is not a shape this app is built for. */
const ACCOUNT_PAGE = 100;

export const listAccounts = async (
  statuses?: AccountStatus[],
): Promise<WhatsappAccountRecord[]> => {
  const result = await query(
    (client) =>
      client.query({
        whatsappAccounts: {
          __args: {
            orderBy: [{ createdAt: 'AscNullsFirst' }],
            first: ACCOUNT_PAGE,
            ...(statuses === undefined ? {} : { filter: { status: { in: statuses } } }),
          },
          edges: { node: ACCOUNT_FIELDS },
          pageInfo: { hasNextPage: true },
        },
      }),
    'accounts.list',
  );

  /**
   * One page, deliberately — a workspace with a hundred connected numbers is
   * not a shape this app is built for, and paging here would add a loop to
   * every health check to serve nobody. But the hourly sweep skipping accounts
   * in silence is the failure D-33 is about, so a full page says so.
   */
  if (result.whatsappAccounts?.pageInfo?.hasNextPage === true) {
    logger.warn('accounts.list_truncated', { limit: ACCOUNT_PAGE });
  }

  return nodesOf(result.whatsappAccounts) as WhatsappAccountRecord[];
};

export type AccountPatch = {
  status?: AccountStatus;
  /** Only on reconnect, when a number has moved to a different WABA (D-48). */
  wabaId?: string;
  statusDetail?: string | null;
  qualityRating?: Quality;
  messagingLimitTier?: MessagingTier;
  displayPhoneNumber?: string | null;
  displayName?: string | null;
  webhookLastEventAt?: string;
  webhookLastVerifiedAt?: string;
  tokenLastCheckedAt?: string;
  tierUniqueUsersUsed?: number;
  tierWindowStartedAt?: string | null;
  throughputPerSecond?: number;
  interactiveCursorAt?: string | null;
  campaignCursorAt?: string | null;
  lastAssignedIndex?: number;
  /**
   * Operator-editable settings (the `updateAccount` admin action). Separate
   * from the fields above, which are all written by the app's own machinery —
   * these are the ones a human sets and, having set one wrong, needs to fix
   * without reaching for the GraphQL API.
   */
  name?: string;
  /** Validated by `parseCountryCallingCode` before it reaches here. */
  defaultCountryCallingCode?: string | null;
  isTestAccount?: boolean;
  contactAutoCreationEnabled?: boolean;
  sendThrottlePerSecond?: number;
};

export const patchAccount = async (id: string, data: AccountPatch): Promise<void> => {
  await query(
    (client) =>
      client.mutation({
        updateWhatsappAccount: { __args: { id, data }, id: true },
      }),
    'accounts.patch',
  );
};
