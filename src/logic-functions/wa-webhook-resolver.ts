import { defineLogicFunction } from 'twenty-sdk/define';
import {
  Response,
  kv,
  type RoutePayload,
  type ServerRouteResolverResult,
} from 'twenty-sdk/logic-function';

import {
  LF_WEBHOOK_INGEST,
  LF_WEBHOOK_RESOLVER,
} from '../constants/universal-identifiers';
import type { MetaEntry, MetaWebhookBody } from '../domain/webhook/types';
import {
  META_SIGNATURE_HEADER,
  verifyIncomingSignature,
} from '../providers/whatsapp';
import { describeError, logger } from '../server/logger';
import { METRIC, count } from '../server/metrics';
import { decideVerification } from './wa-webhook-verify';

/**
 * The webhook front door (AR-6, SEC-2, D-3).
 *
 * Runs in the app-owner workspace and does exactly three things: authenticity,
 * routing, and speed. No record I/O, no Meta calls — NFR-P1 gives it under a
 * second at p95, and Meta retries anything slower, turning a slow handler into
 * a duplicate storm.
 *
 * The signature is verified over the **raw bytes as received**, before the
 * parsed body is trusted for anything. Re-serialising and hashing that would
 * fail on every message containing a Portuguese accent or an emoji, because
 * Meta escapes non-ASCII as `\uXXXX` and `JSON.stringify` does not.
 */

/**
 * Routing keys for a delivery, in preference order (specs/03 §2.2).
 *
 * The WABA fallback is not optional: `message_template_status_update` and
 * `account_update` carry no `phone_number_id` at all, so a phone-only resolver
 * would drop every template approval as unclaimed.
 */
export const routingKeys = (body: MetaWebhookBody): string[] => {
  const keys: string[] = [];

  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const phoneNumberId = change.value?.metadata?.phone_number_id;

      if (typeof phoneNumberId === 'string' && phoneNumberId.length > 0) {
        keys.push(`wa:phone-number:${phoneNumberId}`);
      }
    }

    if (typeof entry.id === 'string' && entry.id.length > 0) {
      keys.push(`wa:waba:${entry.id}`);
    }
  }

  return [...new Set(keys)];
};

export const resolveWorkspaceId = async (
  body: MetaWebhookBody,
): Promise<string | null> => {
  for (const key of routingKeys(body)) {
    const workspaceId = await kv.get<string>(key, { scope: 'SERVER' });

    if (typeof workspaceId === 'string' && workspaceId.length > 0) return workspaceId;
  }

  return null;
};

/** The routing keys of a *single* entry, in the same preference order. */
export const entryRoutingKeys = (entry: MetaEntry): string[] => {
  const keys: string[] = [];

  for (const change of entry.changes ?? []) {
    const phoneNumberId = change.value?.metadata?.phone_number_id;

    if (typeof phoneNumberId === 'string' && phoneNumberId.length > 0) {
      keys.push(`wa:phone-number:${phoneNumberId}`);
    }
  }

  if (typeof entry.id === 'string' && entry.id.length > 0) {
    keys.push(`wa:waba:${entry.id}`);
  }

  return [...new Set(keys)];
};

/**
 * Entries grouped by the workspace that claims them.
 *
 * A single Meta delivery can batch entries for several WABAs, and on a server
 * hosting several workspaces those can belong to different tenants. Resolving
 * the *body* to one workspace would hand tenant B's entries to tenant A —
 * where the ingest's data-isolation guard discards them as foreign, so the
 * delivery is silently lost. Grouping per entry lets the handler dispatch
 * exactly the entries the resolved workspace owns, and say out loud what it
 * could not deliver.
 */
export const partitionEntriesByWorkspace = async (
  body: MetaWebhookBody,
): Promise<{
  groups: Map<string, MetaEntry[]>;
  unclaimedEntries: number;
  /**
   * The keys that found no owner, for the log.
   *
   * Without these, `unclaimed` reports only a count — and a count cannot be
   * acted on. The operator can see the number they connected and the number
   * Meta says it delivered for, but not that the two disagree, which is the
   * only thing that matters and the only thing the count hides.
   *
   * The ids are safe to log: they are business identifiers Meta prints in its
   * own dashboard, and `wa.account.claim_conflict` already logs both.
   */
  unclaimedKeys: string[];
}> => {
  const cache = new Map<string, string | null>();
  const groups = new Map<string, MetaEntry[]>();
  let unclaimedEntries = 0;
  const unclaimedKeys = new Set<string>();

  for (const entry of body.entry ?? []) {
    let workspaceId: string | null = null;

    const tried = entryRoutingKeys(entry);

    for (const key of tried) {
      let owner = cache.get(key);

      if (owner === undefined) {
        owner = (await kv.get<string>(key, { scope: 'SERVER' })) ?? null;
        cache.set(key, owner);
      }

      if (typeof owner === 'string' && owner.length > 0) {
        workspaceId = owner;
        break;
      }
    }

    if (workspaceId === null) {
      unclaimedEntries += 1;
      for (const key of tried) unclaimedKeys.add(key);
      continue;
    }

    const group = groups.get(workspaceId);

    if (group === undefined) groups.set(workspaceId, [entry]);
    else group.push(entry);
  }

  return { groups, unclaimedEntries, unclaimedKeys: [...unclaimedKeys] };
};

export const handler = async (
  event: RoutePayload<MetaWebhookBody>,
): Promise<ServerRouteResolverResult> => {
  // The platform may route the GET handshake here as well as to the dedicated
  // route (probe P-1), so both paths answer it identically.
  if (event.requestContext?.http?.method === 'GET') {
    count(METRIC.WEBHOOK_VERIFY_ATTEMPT);

    const outcome = decideVerification(event.queryStringParameters ?? {});

    if (outcome.status === 200) count(METRIC.WEBHOOK_VERIFY_OK);
    else if (outcome.status === 403) count(METRIC.WEBHOOK_VERIFY_REJECTED);

    return new Response(outcome.body, {
      status: outcome.status,
      headers: { 'content-type': 'text/plain' },
    });
  }

  /**
   * Without the raw body there is nothing to verify against, and processing an
   * unverifiable delivery would accept anything anyone posted at the endpoint.
   * Throwing rather than returning 401 is deliberate: this is a deployment
   * fault, not a rejected request, and it must be loud.
   */
  if (typeof event.rawBody !== 'string') {
    throw new Error('rawBody not forwarded; cannot verify X-Hub-Signature-256');
  }

  if (
    !verifyIncomingSignature({
      rawBody: event.rawBody,
      header: event.headers?.[META_SIGNATURE_HEADER],
    })
  ) {
    count(METRIC.WEBHOOK_SIGNATURE_REJECTED);
    logger.warn('wa.webhook.signature_rejected', { fn: 'wa-webhook-resolver' });

    return new Response({ error: 'invalid signature' }, { status: 401 });
  }

  const body = event.body;

  if (
    body === null ||
    body.object !== 'whatsapp_business_account' ||
    !Array.isArray(body.entry)
  ) {
    return new Response({ ok: true, skipped: 'unrecognised payload' }, { status: 200 });
  }

  let groups: Map<string, MetaEntry[]>;
  let unclaimedEntries: number;
  let unclaimedKeys: string[];

  try {
    ({ groups, unclaimedEntries, unclaimedKeys } = await partitionEntriesByWorkspace(body));
  } catch (error) {
    logger.error('wa.webhook.routing_failed', {
      fn: 'wa-webhook-resolver',
      ...describeError(error),
    });

    throw error;
  }

  /**
   * An unclaimed number is answered 200, not 404. Meta retries a non-2xx for
   * seven days, so refusing traffic for a number we do not host would earn a
   * week of retries for a delivery we will never want.
   */
  if (groups.size === 0) {
    count(METRIC.WEBHOOK_UNCLAIMED);
    /**
     * The keys, not just the count. "1 unclaimed entry" tells an operator
     * nothing they can act on; `wa:phone-number:123…` next to the number they
     * connected tells them immediately whether Meta is delivering for a
     * different number than the one they claimed — which is the only question
     * this log exists to answer.
     */
    logger.warn('wa.webhook.unclaimed', {
      fn: 'wa-webhook-resolver',
      unclaimedEntries,
      unclaimedKeys,
    });

    return new Response({ ok: true, skipped: 'unclaimed number' }, { status: 200 });
  }

  const [workspaceId, entries] = groups.entries().next().value as [string, MetaEntry[]];

  /**
   * The platform can dispatch one delivery to exactly one workspace, so when
   * a batch spans several tenants only the first group can be delivered. That
   * is a real loss — Meta will not retry a 200 — and the one thing worse than
   * losing it is losing it silently.
   */
  if (groups.size > 1) {
    const dropped = [...groups.entries()]
      .filter(([id]) => id !== workspaceId)
      .reduce((total, [, group]) => total + group.length, 0);

    count(METRIC.WEBHOOK_SPLIT_DROPPED, dropped);
    logger.error('wa.webhook.multi_workspace_delivery', {
      fn: 'wa-webhook-resolver',
      workspaces: groups.size,
      deliveredEntries: entries.length,
      droppedEntries: dropped,
    });
  }

  return {
    workspaceId,
    targetLogicFunctionUniversalIdentifier: LF_WEBHOOK_INGEST,
    // Only the entries this workspace owns: the others belong to other
    // tenants, and their raw payloads must not enter this workspace at all.
    payload: { body: { ...body, entry: entries }, receivedAt: new Date().toISOString() },
  };
};

export default defineLogicFunction({
  universalIdentifier: LF_WEBHOOK_RESOLVER,
  name: 'wa-webhook-resolver',
  description:
    'Verifies the Meta webhook signature and dispatches the delivery to the owning workspace.',
  timeoutSeconds: 15,
  serverRouteTriggerSettings: {
    forwardedRequestHeaders: [META_SIGNATURE_HEADER],
    /**
     * The platform answers a server route with POST only by default. Declaring
     * both methods is what makes the one URL Meta asks for — the GET handshake
     * and the POST delivery below — the same one, with no reverse-proxy alias
     * in front of Twenty. Supported since Twenty 2.35.0 (upstream #24401),
     * which is this app's minimum server.
     */
    httpMethods: ['GET', 'POST'],
  },
  handler,
});
