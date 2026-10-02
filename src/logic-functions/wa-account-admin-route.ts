import { defineLogicFunction } from 'twenty-sdk/define';
import { Response, kv, type RoutePayload } from 'twenty-sdk/logic-function';

import {
  LF_ACCOUNT_ADMIN_ROUTE,
  LF_WEBHOOK_RESOLVER,
} from '../constants/universal-identifiers';
import {
  ACCOUNT_STATUS,
  MESSAGING_TIER,
  QUALITY,
  REQUIRED_WEBHOOK_FIELDS,
  type MessagingTier,
  type Quality,
} from '../domain/constants';
import { getProvider } from '../providers/whatsapp';
import { MetaApiError } from '../providers/whatsapp/errors';
import { AUDIT_ACTION, audit } from '../server/audit';
import { authErrorResponse, requireCaller, requireRole } from '../server/auth';
import { listVariables, setVariable } from '../server/variables';
import { config, parseCountryCallingCode } from '../server/config';
import { describeError, logger } from '../server/logger';
import { provisionNotificationWorkflow } from '../server/notification-workflow';
import { budgetForAccount, tierFor } from '../server/tier-ledger';
import { currentWorkspaceId } from '../server/workspace';
import { consentWordingDrift } from './wa-consent-keyword';
import { syncAccount } from './wa-template-sync';
import { nodesOf, query } from '../server/repositories/base';
import {
  findAccountByPhoneNumberId,
  findAccountById,
  patchAccount,
  type WhatsappAccountRecord,
} from '../server/repositories/accounts';
import {
  findFailedOutboundMessages,
  findStuckQueuedMessages,
} from '../server/repositories/messages';
import { findFailedWebhookEvents } from '../server/repositories/webhook-events';
import { STUCK_MESSAGE_MS } from './wa-health-check';

/**
 * Account connect / test / disconnect (FR-ACC-1, FR-ACC-6, D-3, SEC-5).
 *
 * `whatsappAccount` is `isUICreatable: false` precisely so this route is the
 * only way an account comes into existence. The reason is the **kv routing
 * claim**: the webhook resolver runs in the app-owner workspace and can only
 * find the owning workspace through `wa:phone-number:{id}`. A record created by
 * hand in the UI would have no claim, so every message for that number would be
 * answered "unclaimed" and silently discarded — with a perfectly healthy-looking
 * account record sitting in the CRM.
 *
 * Writing the claim and the record together, here, is what makes that
 * impossible.
 */

export type AccountAction =
  | 'connect'
  | 'updateAccount'
  | 'test'
  | 'disconnect'
  | 'list'
  | 'syncTemplates'
  | 'diagnostics'
  | 'variables'
  | 'setVariable'
  | 'createNotificationWorkflow';

export type AccountRouteBody = {
  action?: AccountAction;
  accountId?: string;
  name?: string;
  wabaId?: string;
  phoneNumberId?: string;
  defaultCountryCallingCode?: string;
  isTestAccount?: boolean;
  contactAutoCreationEnabled?: boolean;
  sendThrottlePerSecond?: number;
  /** Ask Meta to start delivering this WABA's events to us (appendix A §1). */
  subscribeApp?: boolean;
  /** `setVariable` only. */
  key?: string;
  value?: string;
};

/**
 * The submitted calling code, normalised — or the refusal, as one value.
 *
 * `undefined` means the caller did not send the field at all, which must stay
 * distinguishable from "sent it empty": the first leaves the stored value
 * alone, the second clears it back to the `WA_DEFAULT_COUNTRY_CALLING_CODE`
 * fallback. Collapsing the two would make the field impossible to unset.
 */
const readCallingCode = (
  body: AccountRouteBody,
): { ok: true; value: string | null | undefined } | { ok: false; error: string } => {
  const raw = body.defaultCountryCallingCode;

  if (raw === undefined) return { ok: true, value: undefined };
  if (raw === null || raw.trim() === '') return { ok: true, value: null };

  const parsed = parseCountryCallingCode(raw);

  if (parsed === null) {
    return {
      ok: false,
      error:
        'defaultCountryCallingCode must be a country calling code of 1-3 digits, such as +244 — not a full phone number',
    };
  }

  return { ok: true, value: parsed };
};

const QUALITY_FROM_META: Record<string, Quality> = {
  GREEN: QUALITY.GREEN,
  YELLOW: QUALITY.YELLOW,
  RED: QUALITY.RED,
  UNKNOWN: QUALITY.UNKNOWN,
};

const TIER_FROM_META: Record<string, MessagingTier> = {
  TIER_250: MESSAGING_TIER.TIER_250,
  TIER_1K: MESSAGING_TIER.TIER_1K,
  TIER_2K: MESSAGING_TIER.TIER_2K,
  TIER_10K: MESSAGING_TIER.TIER_10K,
  TIER_100K: MESSAGING_TIER.TIER_100K,
  TIER_UNLIMITED: MESSAGING_TIER.TIER_UNLIMITED,
};

export const phoneClaimKey = (phoneNumberId: string): string =>
  `wa:phone-number:${phoneNumberId}`;

export const wabaClaimKey = (wabaId: string): string => `wa:waba:${wabaId}`;

/**
 * Both claims are written, not just the phone one.
 *
 * Template and account webhooks carry no `phone_number_id` at all — only the
 * WABA id on the entry — so an account with just the phone claim would receive
 * messages and silently lose every template approval (D-3).
 */
export const writeClaims = async ({
  workspaceId,
  phoneNumberId,
  wabaId,
}: {
  workspaceId: string;
  phoneNumberId: string;
  wabaId: string;
}): Promise<void> => {
  await kv.set(phoneClaimKey(phoneNumberId), workspaceId, { scope: 'SERVER' });
  await kv.set(wabaClaimKey(wabaId), workspaceId, { scope: 'SERVER' });
};

export type ClaimOwners = { phone: string | null; waba: string | null };

/**
 * Who currently holds each routing claim — `null` when unclaimed.
 *
 * The claims are SERVER-scoped and therefore **shared across every workspace
 * on the server**, which is what makes them worth stealing: whoever holds
 * `wa:phone-number:{id}` receives that number's signed webhooks. So no write
 * or delete of a claim happens without first reading who owns it.
 */
export const readClaimOwners = async ({
  phoneNumberId,
  wabaId,
}: {
  phoneNumberId: string;
  wabaId: string;
}): Promise<ClaimOwners> => ({
  phone: (await kv.get<string>(phoneClaimKey(phoneNumberId), { scope: 'SERVER' })) ?? null,
  waba: (await kv.get<string>(wabaClaimKey(wabaId), { scope: 'SERVER' })) ?? null,
});

/**
 * The WABA claim is *not* cleared on disconnect when another connected account
 * still shares that WABA — several numbers commonly live under one business
 * account, and clearing it would break the others' template events.
 *
 * Deletion is owner-checked: a claim held by a *different* workspace is left
 * alone, so disconnecting a local record whose Meta IDs happen to match
 * another tenant's number cannot silence that tenant's deliveries.
 */
export const clearClaims = async ({
  workspaceId,
  phoneNumberId,
  wabaId,
  wabaStillInUse,
}: {
  workspaceId: string;
  phoneNumberId: string;
  wabaId: string;
  wabaStillInUse: boolean;
}): Promise<void> => {
  const owners = await readClaimOwners({ phoneNumberId, wabaId });

  if (owners.phone === workspaceId) {
    await kv.delete(phoneClaimKey(phoneNumberId), { scope: 'SERVER' });
  }

  if (!wabaStillInUse && owners.waba === workspaceId) {
    await kv.delete(wabaClaimKey(wabaId), { scope: 'SERVER' });
  }
};

const ACCOUNT_SUMMARY = {
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
  webhookLastEventAt: true,
  webhookLastVerifiedAt: true,
  tokenLastCheckedAt: true,
  isTestAccount: true,
} as const;

/** Two hours without a successful token check is the health panel's amber. */
const TOKEN_FRESH_MS = 2 * 3_600_000;
const DAY_MS = 24 * 3_600_000;

export type HealthRow = {
  key: string;
  ok: boolean;
  /** A machine value, never a sentence — the settings tab owns the wording. */
  detail: Record<string, unknown>;
};

/**
 * The health panel's rows and the callback card's URLs (NFR-O3, FR-ACC-2/4).
 *
 * Every row answers a question an operator asks when something is wrong, and
 * each is computed from a record rather than from a cached verdict, so a panel
 * that says "green" is saying something about the data and not about the last
 * time a cron happened to run.
 *
 * The verify token is deliberately absent. It is a secret, so the card says
 * whether it is *configured* and never what it is — a settings page that
 * displayed it would put it in every screenshot of a support ticket.
 */
const diagnostics = async () => {
  const now = Date.now();

  const result = await query(
    (client) =>
      client.query({
        whatsappAccounts: {
          __args: { first: 60 },
          edges: {
            node: {
              ...ACCOUNT_SUMMARY,
              tierUniqueUsersUsed: true,
              tierWindowStartedAt: true,
              sendThrottlePerSecond: true,
              throughputPerSecond: true,
              defaultCountryCallingCode: true,
              contactAutoCreationEnabled: true,
            },
          },
        },
      }),
    'accounts.diagnostics',
  );

  const accounts = nodesOf<WhatsappAccountRecord>(result.whatsappAccounts);

  const [failedEvents, stuck, failedOutbound] = await Promise.all([
    findFailedWebhookEvents(60),
    findStuckQueuedMessages(new Date(now - STUCK_MESSAGE_MS), 60),
    /**
     * Sends that were refused (D-65). A stuck `QUEUED` row is a message nothing
     * moved; a `FAILED` one is a message something decided about — and until
     * now only the first was reported here, so every failed outbound
     * attachment was invisible on the one screen an operator opens to ask what
     * is wrong.
     */
    findFailedOutboundMessages(new Date(now - DAY_MS), 60),
  ]);

  const recentFailures = failedEvents.filter((event) => {
    const at = event.receivedAt;

    return typeof at !== 'string' || now - new Date(at).getTime() < DAY_MS;
  });

  const stalenessMs = config.webhookStalenessHours() * 3_600_000;
  const base = (process.env.TWENTY_API_URL ?? '').replace(/\/+$/, '');

  const rows: HealthRow[] = accounts.flatMap((account): HealthRow[] => {
    const checked = account.tokenLastCheckedAt;
    const lastEvent = account.webhookLastEventAt;

    return [
      {
        key: 'token',
        ok:
          typeof checked === 'string' && now - new Date(checked).getTime() < TOKEN_FRESH_MS,
        detail: { accountId: account.id, tokenLastCheckedAt: checked ?? null },
      },
      {
        /**
         * A number that has *never* received an event is not stale — it is new.
         * Reporting a freshly connected quiet number as broken is how a health
         * panel teaches people to ignore it.
         */
        key: 'webhook',
        ok:
          typeof lastEvent !== 'string' ||
          now - new Date(lastEvent).getTime() < stalenessMs,
        detail: {
          accountId: account.id,
          webhookLastEventAt: lastEvent ?? null,
          stalenessHours: config.webhookStalenessHours(),
        },
      },
      {
        /**
         * `UNKNOWN` is "Meta has no data yet", not "Meta lowered the rating" —
         * and it is what every number reports until it has sent enough traffic
         * to be graded. Failing the row on it greeted every new connection
         * with "cut marketing sends and review the templates", which is advice
         * about a problem that does not exist, on a number that has never sent
         * anything. Same reasoning as the `webhook` row above: silence from a
         * new number is not a fault.
         *
         * YELLOW and RED still fail. Those are gradings.
         */
        key: 'quality',
        ok:
          account.qualityRating === QUALITY.GREEN ||
          account.qualityRating === QUALITY.UNKNOWN ||
          account.qualityRating === null ||
          account.qualityRating === undefined,
        detail: { accountId: account.id, qualityRating: account.qualityRating ?? null },
      },
      {
        /**
         * Green while a campaign could still start today. `available` is what
         * is left *after* the reserve held back for 1:1 traffic (AR-21), which
         * is the number that decides whether tonight's campaign runs — not the
         * raw limit, and not the raw usage.
         */
        key: 'tier',
        ok: budgetForAccount(account).available > 0,
        detail: {
          accountId: account.id,
          tier: tierFor(account),
          ...budgetForAccount(account),
          windowStartedAt: account.tierWindowStartedAt ?? null,
        },
      },
    ];
  });

  rows.push(
    {
      key: 'failedWebhookEvents',
      ok: recentFailures.length === 0,
      detail: { count: recentFailures.length },
    },
    {
      key: 'stuckOutbound',
      ok: stuck.length === 0,
      detail: { count: stuck.length, olderThanMinutes: STUCK_MESSAGE_MS / 60_000 },
    },
    {
      key: 'failedOutbound',
      ok: failedOutbound.length === 0,
      detail: { count: failedOutbound.length },
    },
    /**
     * Workspace-wide, not per-account: the wording and the keyword lists are
     * application variables, so the drift is the same for every number. It
     * belongs in the health panel because nothing else can catch it — a
     * confirmation naming a dead keyword sends perfectly, and the failure is
     * on the customer's side, in a reply the app then does not act on.
     */
    (() => {
      const drift = consentWordingDrift(
        {
          optOutConfirmation:
            config.confirmationLocale() === 'en'
              ? config.optOutConfirmationEn()
              : config.optOutConfirmationPt(),
          optInConfirmation:
            config.confirmationLocale() === 'en'
              ? config.optInConfirmationEn()
              : config.optInConfirmationPt(),
        },
        { optOut: config.optOutKeywords(), optIn: config.optInKeywords() },
      );

      return {
        key: 'consentWording',
        ok: drift.length === 0,
        detail: {
          count: drift.length,
          words: drift.map((entry) => entry.word),
          expectedIn: drift.map((entry) => entry.expectedIn),
        },
      };
    })(),
  );

  return {
    accounts,
    rows,
    webhook: {
      /**
       * The URL to paste into Meta is `directUrl`: the resolver declares both
       * HTTP methods (D-1), so one URL answers the GET handshake and the POST
       * deliveries with no proxy rule at all.
       */
      directUrl: base === '' ? null : `${base}/webhooks/server/${LF_WEBHOOK_RESOLVER}`,
      /**
       * The legacy fallback for a Twenty that does not route GET to server
       * routes: a method-splitting alias an operator configures in their own
       * reverse proxy, GET → `verifyUrl`, POST → `directUrl`.
       */
      callbackUrl: base === '' ? null : `${base}/whatsapp/webhook`,
      verifyUrl: base === '' ? null : `${base}/s/whatsapp/verify`,
      verifyTokenConfigured: (process.env.META_VERIFY_TOKEN ?? '').length > 0,
      requiredFields: [...REQUIRED_WEBHOOK_FIELDS],
    },
    failedEvents: recentFailures.slice(0, 20),
    stuckOutbound: stuck.slice(0, 20).map((message) => ({
      id: message.id,
      threadId: message.threadId ?? null,
      createdAt: message.createdAt ?? null,
    })),
    /**
     * The code *and* the detail. The code is what a dashboard groups by; the
     * detail is the only place the actual cause survives — "only /files/ paths
     * are workspace files" is the sentence that ends an investigation, and it
     * exists nowhere else (D-58, D-65).
     */
    failedOutbound: failedOutbound.slice(0, 20).map((message) => ({
      id: message.id,
      threadId: message.threadId ?? null,
      type: message.messageType ?? null,
      errorCode: message.errorCode ?? null,
      errorDetail: message.errorDetail ?? null,
      createdAt: message.createdAt ?? null,
    })),
  };
};

const countOtherAccountsOnWaba = async (
  wabaId: string,
  excludeAccountId: string,
): Promise<number> => {
  const result = await query(
    (client) =>
      client.query({
        whatsappAccounts: {
          __args: { filter: { wabaId: { eq: wabaId } }, first: 10 },
          edges: { node: { id: true, status: true } },
        },
      }),
    'accounts.countOnWaba',
  );

  return nodesOf<{ id: string; status?: string | null }>(result.whatsappAccounts).filter(
    (account) => account.id !== excludeAccountId && account.status !== ACCOUNT_STATUS.DISABLED,
  ).length;
};

/** A live `GET /{phone_number_id}`, which is the only real proof of a connection. */
const probeNumber = async (
  accountId: string,
  phoneNumberId: string,
): Promise<{ ok: true; detail: string } | { ok: false; detail: string }> => {
  try {
    const number = await getProvider().getPhoneNumber(phoneNumberId);

    await patchAccount(accountId, {
      status: ACCOUNT_STATUS.CONNECTED,
      statusDetail: null,
      displayPhoneNumber: number.displayPhoneNumber,
      displayName: number.verifiedName,
      qualityRating: QUALITY_FROM_META[(number.qualityRating ?? '').toUpperCase()] ?? QUALITY.UNKNOWN,
      ...(TIER_FROM_META[(number.messagingLimitTier ?? '').toUpperCase()] === undefined
        ? {}
        : {
            messagingLimitTier: TIER_FROM_META[
              (number.messagingLimitTier ?? '').toUpperCase()
            ]!,
          }),
      tokenLastCheckedAt: new Date().toISOString(),
    });

    return { ok: true, detail: number.verifiedName ?? number.displayPhoneNumber ?? phoneNumberId };
  } catch (error) {
    const detail =
      error instanceof MetaApiError
        ? `${error.code ?? error.httpStatus ?? 'error'}: ${error.details ?? error.message}`
        : String(error);

    /**
     * A failed probe marks the account `ERROR` rather than deleting it. The
     * record and its claim stay, so a token fixed an hour later resumes
     * delivery without re-entering anything — and the webhook events that
     * arrived meanwhile were still recorded.
     */
    await patchAccount(accountId, {
      status: ACCOUNT_STATUS.ERROR,
      statusDetail: detail.slice(0, 500),
      tokenLastCheckedAt: new Date().toISOString(),
    });

    return { ok: false, detail };
  }
};

export const handler = async (
  event: RoutePayload<AccountRouteBody>,
): Promise<Response> => {
  const log = logger.child({ fn: 'wa-account-admin-route' });

  try {
    const caller = await requireCaller(event);
    requireRole(caller, 'admin');

    const body = event.body ?? {};
    const action = body.action ?? 'list';

    switch (action) {
      case 'list': {
        const result = await query(
          (client) =>
            client.query({
              whatsappAccounts: {
                __args: { first: 60 },
                edges: { node: ACCOUNT_SUMMARY },
              },
            }),
          'accounts.listSummary',
        );

        return new Response(
          { accounts: nodesOf<WhatsappAccountRecord>(result.whatsappAccounts) },
          { status: 200 },
        );
      }

      case 'diagnostics':
        return new Response(await diagnostics(), { status: 200 });

      /**
       * D-10 layer 3, made real (specs/09 §6).
       *
       * The only layer that reaches a rep who is not looking at Twenty, and the
       * only one the app cannot build for them — there is no notification API,
       * so it has to be a workflow the workspace owns. This provisions it as a
       * **draft** the operator reviews and activates; the response names what
       * they still have to decide rather than pretending it is finished.
       */
      case 'createNotificationWorkflow': {
        const outcome = await provisionNotificationWorkflow();

        if (!outcome.ok) return new Response({ error: outcome.error }, { status: 502 });

        log.info('wa.account.notification_workflow', {
          workflowId: outcome.result.workflowId,
          existed: outcome.result.existed,
        });

        return new Response(outcome.result, { status: 200 });
      }

      /**
       * The app's own application variables (FR-CON-3, NFR-M1).
       *
       * A settings front component replaces Twenty's variable editor rather
       * than sitting beside it, so without these two actions the confirmation
       * wording — the one thing specified as changeable without a deploy — had
       * become unchangeable by anyone.
       */
      case 'variables':
        return new Response({ variables: await listVariables() }, { status: 200 });

      case 'setVariable': {
        const key = (body.key ?? '').trim();
        const value = body.value;

        if (key.length === 0 || typeof value !== 'string') {
          return new Response({ error: 'key and value are required' }, { status: 400 });
        }

        const outcome = await setVariable(key, value);

        if (!outcome.ok) return new Response({ error: outcome.error }, { status: 400 });

        log.info('wa.account.variable_set', { key });

        return new Response({ variables: await listVariables() }, { status: 200 });
      }

      case 'connect': {
        const phoneNumberId = (body.phoneNumberId ?? '').trim();
        const wabaId = (body.wabaId ?? '').trim();

        if (phoneNumberId.length === 0 || wabaId.length === 0) {
          return new Response(
            { error: 'phoneNumberId and wabaId are required' },
            { status: 400 },
          );
        }

        /**
         * Refuse at the door rather than store and regret. A bad calling code
         * does nothing visible at connect time — it surfaces weeks later as
         * sends failing for contacts stored without a country code, which is
         * about as far from the cause as a symptom gets.
         */
        const callingCode = readCallingCode(body);

        if (callingCode.ok === false) {
          return new Response({ error: callingCode.error }, { status: 400 });
        }

        /**
         * Deliberately *not* `event.userWorkspaceId`, which is the membership
         * id. The resolver dispatches on the value stored here, so a membership
         * id would route every delivery to nowhere — and both are UUIDs, so
         * nothing would complain.
         */
        const workspaceId = await currentWorkspaceId();

        if (workspaceId === null) {
          log.error('wa.account.no_workspace_id');

          return new Response(
            { error: 'Could not determine the workspace for the routing claim' },
            { status: 500 },
          );
        }

        /**
         * Ownership before anything else (SEC-5). A connect naming another
         * tenant's Meta IDs must be refused outright — overwriting their
         * SERVER-scoped claims would silently divert their inbound messages,
         * statuses and template events into this workspace. The kv store has
         * no compare-and-set, so this is read-check-write; the remaining race
         * needs two admins connecting the same number in the same instant,
         * and the loser's claim is still visible in the resolver's routing.
         */
        const claimOwners = await readClaimOwners({ phoneNumberId, wabaId });

        if (
          (claimOwners.phone !== null && claimOwners.phone !== workspaceId) ||
          (claimOwners.waba !== null && claimOwners.waba !== workspaceId)
        ) {
          log.warn('wa.account.claim_conflict', { phoneNumberId, wabaId });

          return new Response(
            {
              error:
                'This phone number or WhatsApp Business Account is already connected in another workspace',
            },
            { status: 409 },
          );
        }

        const existing = await findAccountByPhoneNumberId(phoneNumberId);

        const account: WhatsappAccountRecord | null =
          existing ??
          (await query(
            (client) =>
              client.mutation({
                createWhatsappAccount: {
                  __args: {
                    data: {
                      name: body.name ?? `WhatsApp ${phoneNumberId}`,
                      phoneNumberId,
                      wabaId,
                      status: ACCOUNT_STATUS.PENDING,
                      ...(callingCode.value === undefined
                        ? {}
                        : { defaultCountryCallingCode: callingCode.value }),
                      ...(body.isTestAccount === undefined
                        ? {}
                        : { isTestAccount: body.isTestAccount }),
                      ...(body.contactAutoCreationEnabled === undefined
                        ? {}
                        : { contactAutoCreationEnabled: body.contactAutoCreationEnabled }),
                      ...(body.sendThrottlePerSecond === undefined
                        ? {}
                        : { sendThrottlePerSecond: body.sendThrottlePerSecond }),
                    },
                  },
                  ...ACCOUNT_SUMMARY,
                },
              }),
            'accounts.create',
          ).then((result) => (result.createWhatsappAccount ?? null) as WhatsappAccountRecord | null));

        if (account === null) {
          log.error('wa.account.create_returned_nothing', { phoneNumberId });

          return new Response({ error: 'Could not create the account record' }, { status: 500 });
        }

        /**
         * A number can move between WABAs, and reconnecting it under a new one
         * used to leave the record pointing at the old WABA while the routing
         * claim pointed at the new one. Template sync reads the record and
         * webhook routing reads the claim, so the two would have disagreed
         * about which business this number belongs to — silently, and in the
         * direction where every template is stale (D-48).
         */
        const movedWaba =
          existing !== null && typeof existing.wabaId === 'string' && existing.wabaId !== wabaId;

        if (movedWaba) {
          log.warn('wa.account.waba_changed', {
            accountId: account.id,
            from: existing!.wabaId,
            to: wabaId,
          });

          await patchAccount(account.id, { wabaId });
        }

        // The claim goes down before the probe: a token that fails today must
        // not leave a number whose webhooks are discarded as unclaimed.
        await writeClaims({ workspaceId, phoneNumberId, wabaId });

        const probe = await probeNumber(account.id, phoneNumberId);

        /**
         * A failed probe *rolls back claims this request newly wrote*. Keeping
         * an unproven claim would let anyone squat an unclaimed number — and
         * later refuse its real owner's connect. A claim that was already ours
         * before this request is kept, so a token that fails today on an
         * established number still resumes delivery once fixed.
         */
        if (!probe.ok) {
          if (claimOwners.phone === null) {
            await kv.delete(phoneClaimKey(phoneNumberId), { scope: 'SERVER' });
          }

          if (claimOwners.waba === null) {
            await kv.delete(wabaClaimKey(wabaId), { scope: 'SERVER' });
          }
        }

        /**
         * Subscribing the app to the WABA is the step whose absence is
         * invisible: the dashboard shows the webhook verified, active and every
         * field subscribed, the Test button works, and real messages are
         * discarded with no error anywhere. Confirmed 2026-08-15.
         */
        let subscribed: boolean | null = null;

        if (body.subscribeApp !== false) {
          try {
            await getProvider().subscribeApp(wabaId);
            subscribed = true;
          } catch (error) {
            subscribed = false;
            log.warn('wa.account.subscribe_failed', {
              accountId: account.id,
              ...describeError(error),
            });
          }
        }

        audit({
          action: AUDIT_ACTION.ACCOUNT_CONNECT,
          actorId: caller.workspaceMemberId,
          subject: { accountId: account.id },
          details: {
            phoneNumberId,
            wabaId,
            probeOk: probe.ok,
            subscribed,
            ...(movedWaba ? { previousWabaId: existing!.wabaId } : {}),
          },
        });

        return new Response(
          {
            accountId: account.id,
            created: existing === null,
            connection: probe,
            subscribedApp: subscribed,
          },
          { status: probe.ok ? 200 : 502 },
        );
      }

      /**
       * The settings-only fields of a number already connected.
       *
       * It exists because `defaultCountryCallingCode` was writable exactly
       * once, in the connect form, and wrong values had to be repaired through
       * Twenty's GraphQL API — an escape hatch no operator should need for a
       * field the app itself put in front of them. Deliberately narrow: the
       * routing identity (`phoneNumberId`, `wabaId`) is *not* editable here,
       * because changing it has to move the SERVER-scoped claims with it, and
       * that is what `connect` is for.
       */
      case 'updateAccount': {
        const account =
          body.accountId === undefined ? null : await findAccountById(body.accountId);

        if (account === null) {
          return new Response({ error: 'Unknown account' }, { status: 404 });
        }

        const callingCode = readCallingCode(body);

        if (callingCode.ok === false) {
          return new Response({ error: callingCode.error }, { status: 400 });
        }

        const patch = {
          ...(body.name === undefined ? {} : { name: body.name }),
          ...(callingCode.value === undefined
            ? {}
            : { defaultCountryCallingCode: callingCode.value }),
          ...(body.isTestAccount === undefined ? {} : { isTestAccount: body.isTestAccount }),
          ...(body.contactAutoCreationEnabled === undefined
            ? {}
            : { contactAutoCreationEnabled: body.contactAutoCreationEnabled }),
          ...(body.sendThrottlePerSecond === undefined
            ? {}
            : { sendThrottlePerSecond: body.sendThrottlePerSecond }),
        };

        if (Object.keys(patch).length === 0) {
          return new Response({ error: 'Nothing to update' }, { status: 400 });
        }

        await patchAccount(account.id, patch);

        audit({
          action: AUDIT_ACTION.ACCOUNT_SETTINGS,
          actorId: caller.workspaceMemberId,
          subject: { accountId: account.id },
          details: { fields: Object.keys(patch) },
        });

        return new Response({ accountId: account.id, updated: Object.keys(patch) }, { status: 200 });
      }

      case 'test': {
        const account =
          body.accountId === undefined ? null : await findAccountById(body.accountId);

        if (account === null || typeof account.phoneNumberId !== 'string') {
          return new Response({ error: 'Unknown account' }, { status: 404 });
        }

        const probe = await probeNumber(account.id, account.phoneNumberId);

        return new Response({ connection: probe }, { status: probe.ok ? 200 : 502 });
      }

      case 'disconnect': {
        const account =
          body.accountId === undefined ? null : await findAccountById(body.accountId);

        const phoneNumberId = account?.phoneNumberId;
        const wabaId = account?.wabaId;

        if (
          account === null ||
          typeof phoneNumberId !== 'string' ||
          typeof wabaId !== 'string'
        ) {
          return new Response({ error: 'Unknown account' }, { status: 404 });
        }

        const workspaceId = await currentWorkspaceId();

        if (workspaceId === null) {
          log.error('wa.account.no_workspace_id');

          return new Response(
            { error: 'Could not determine the workspace that owns the routing claim' },
            { status: 500 },
          );
        }

        const others = await countOtherAccountsOnWaba(wabaId, account.id);

        await clearClaims({ workspaceId, phoneNumberId, wabaId, wabaStillInUse: others > 0 });

        /**
         * Disabled, not deleted. The conversations, messages and campaign
         * history belong to the CRM, and a disconnect is an operational action
         * — deleting a number's account would cascade away a year of customer
         * correspondence.
         */
        await patchAccount(account.id, {
          status: ACCOUNT_STATUS.DISABLED,
          statusDetail: 'disconnected',
        });

        audit({
          action: AUDIT_ACTION.ACCOUNT_DISCONNECT,
          actorId: caller.workspaceMemberId,
          subject: { accountId: account.id },
          details: { wabaClaimKept: others > 0 },
        });

        return new Response({ accountId: account.id, wabaClaimKept: others > 0 }, { status: 200 });
      }

      /**
       * The settings panel's "Sync now" (specs/06 §1).
       *
       * It lives here rather than as a second trigger on `wa-template-sync`
       * because that function is a cron worker returning a result object, and
       * an HTTP route has to return a `Response` — one function cannot sensibly
       * be both. The settings page is already talking to this route about this
       * account, so the action belongs where the operator already is.
       */
      case 'syncTemplates': {
        const account =
          body.accountId === undefined ? null : await findAccountById(body.accountId);

        if (account === null) {
          return new Response({ error: 'Unknown account' }, { status: 404 });
        }

        const result = await syncAccount(account);

        return new Response(result, { status: result.error === undefined ? 200 : 502 });
      }

      default:
        return new Response({ error: `Unknown action: ${String(action)}` }, { status: 400 });
    }
  } catch (error) {
    const authFailure = authErrorResponse(error);

    if (authFailure !== null) {
      return new Response(authFailure.body, { status: authFailure.status });
    }

    /**
     * A permission refusal from the platform is the operator's answer, not a
     * bug. It reaches here when someone without workspace-settings rights opens
     * the Variables tab, and "Internal error" would send them to the logs for
     * something the platform decided on purpose.
     */
    if (
      error instanceof Error &&
      error.message === 'Entity performing the request does not have permission'
    ) {
      log.info('wa.account.permission_denied', { action: String(event.body?.action) });

      return new Response(
        { error: 'Your Twenty role does not allow this action' },
        { status: 403 },
      );
    }

    log.error('wa.account.route_failed', describeError(error));

    return new Response({ error: 'Internal error' }, { status: 500 });
  }
};

export default defineLogicFunction({
  universalIdentifier: LF_ACCOUNT_ADMIN_ROUTE,
  name: 'wa-account-admin-route',
  description:
    'Connects, tests and disconnects WhatsApp numbers, writing the workspace routing claim.',
  timeoutSeconds: 30,
  httpRouteTriggerSettings: {
    path: '/whatsapp/account',
    httpMethod: 'POST',
    isAuthRequired: true,
    // The caller's own token, so `requireCaller` can ask the platform who they
    // are rather than guess from a `userWorkspaceId` nothing else joins on (D-53).
    forwardedRequestHeaders: ['authorization'],
  },
  handler,
});
