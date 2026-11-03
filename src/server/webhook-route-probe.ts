import { LF_WEBHOOK_RESOLVER } from '../constants/universal-identifiers';
import { META_SIGNATURE_HEADER, signOutgoingProbe } from '../providers/whatsapp';

/**
 * Does the webhook's `POST` half actually exist? (D-1, issue #1.)
 *
 * Every other check on this panel asks Meta something. This one asks the
 * *platform*, because there is a failure mode where the app is installed, all
 * 47 logic functions are registered, the settings page renders perfectly — and
 * `POST /webhooks/server/{resolver}` answers `404 LOGIC_FUNCTION_NOT_FOUND`.
 *
 * The cause is that `wa-webhook-resolver` is a **server route**, and a server
 * route runs in the app-owner workspace. When the application registration is
 * unclaimed (`ownerWorkspaceId: null`) there is no such workspace, so the
 * platform has nowhere to dispatch it and the route silently does not exist.
 * Nothing in the product says so: the operator pastes the callback URL into
 * Meta, Meta reports a delivery failure with no detail, and the trail ends.
 *
 * Probing beats introspection here. Reading the registration's owner over the
 * metadata API would name the *likeliest* cause while still not proving the
 * route answers; a request to the route proves exactly the thing that matters,
 * and keeps reporting it when the cause is something we have not seen yet.
 */

/** Rejected by the resolver's `object` check, so the probe changes nothing. */
export const PROBE_BODY = JSON.stringify({
  object: 'twenty-app-whatsapp-route-probe',
});

export const PROBE_STATE = {
  /** Registered and answering. With a signature, the HMAC path is proven too. */
  LIVE: 'live',
  /** 404 — no server route. Almost always an unclaimed registration. */
  NOT_REGISTERED: 'notRegistered',
  /** 401 against a signature we generated: `META_APP_SECRET` is wrong. */
  SECRET_MISMATCH: 'secretMismatch',
  /**
   * 403 — the platform refuses to run *any* logic function, because the server
   * has no `LOGIC_FUNCTION_TYPE`. Nothing in this app works in that state, and
   * the resolver itself never answers 403, so the status is unambiguous.
   */
  EXECUTION_DISABLED: 'executionDisabled',
  /**
   * 5xx — the route ran and threw. On a fresh install this is almost always
   * `MissingConfigError: META_APP_SECRET is not set`: the resolver fails
   * closed rather than verifying every signature against an empty key, which
   * is correct, and leaves a 500 as the only outward sign.
   */
  ERRORED: 'errored',
  /** The request never completed. Says nothing about the route. */
  UNREACHABLE: 'unreachable',
  /** A status we have no reading for. Reported, never failed on. */
  UNKNOWN: 'unknown',
} as const;

export type ProbeState = (typeof PROBE_STATE)[keyof typeof PROBE_STATE];

export type ProbeOutcome = {
  ok: boolean;
  state: ProbeState;
  status: number | null;
  signed: boolean;
};

/**
 * The reading, separated from the request so it can be tested without a server.
 *
 * `401` is the interesting one, and it means opposite things depending on
 * whether we signed. Unsigned, it is the resolver refusing an unverifiable
 * delivery — which *proves the route is live*, and is a pass. Signed, the
 * resolver rejected a signature this very app computed, so the app secret it
 * verifies against is not the one it signs with.
 */
export const decideRouteProbe = ({
  status,
  signed,
}: {
  status: number | null;
  signed: boolean;
}): ProbeOutcome => {
  if (status === null) {
    return { ok: false, state: PROBE_STATE.UNREACHABLE, status, signed };
  }

  if (status === 404) {
    return { ok: false, state: PROBE_STATE.NOT_REGISTERED, status, signed };
  }

  if (status === 401) {
    return signed
      ? { ok: false, state: PROBE_STATE.SECRET_MISMATCH, status, signed }
      : { ok: true, state: PROBE_STATE.LIVE, status, signed };
  }

  /**
   * Found on the same live install as the 404 above, one step further in: with
   * the registration claimed the route exists, and the platform then refuses
   * to run it at all. Every route, cron and worker in this app is dead in that
   * state, so it is worth its own sentence rather than the shrug below.
   */
  if (status === 403) {
    return { ok: false, state: PROBE_STATE.EXECUTION_DISABLED, status, signed };
  }

  if (status >= 200 && status < 300) {
    return { ok: true, state: PROBE_STATE.LIVE, status, signed };
  }

  /**
   * A route that throws is not a healthy route, whatever it threw. Reporting
   * it green because the status was unfamiliar is how the missing app secret
   * would have looked fine on a page whose whole job is to say what is wrong.
   */
  if (status >= 500) {
    return { ok: false, state: PROBE_STATE.ERRORED, status, signed };
  }

  /**
   * Green on purpose. A status nobody anticipated is not evidence of the
   * failure this row exists to catch, and a health row that reddens on the
   * unfamiliar is one operators learn to scroll past — the exact fate of the
   * `UNKNOWN` quality row this release also fixes.
   */
  return { ok: true, state: PROBE_STATE.UNKNOWN, status, signed };
};

export const resolverUrl = (baseUrl: string): string =>
  `${baseUrl.replace(/\/+$/, '')}/webhooks/server/${LF_WEBHOOK_RESOLVER}`;

/**
 * Signs the probe when it can, and posts it to our own resolver.
 *
 * Signing matters: a *valid* signature takes the resolver past the HMAC check
 * to its `object` guard, which answers `200 { skipped: 'unrecognised payload' }`
 * without touching a record, a queue or Meta. That both proves more and costs
 * less than an unsigned probe, which would trip the signature-rejected metric —
 * a security signal — on every load of the settings page.
 *
 * `baseUrl` is `TWENTY_API_URL`, which on some deployments is an internal
 * address. That is fine for what this asks: whether the *platform* has the
 * route. Whether Meta can reach it from outside is the proxy alias's job, and a
 * different row's business.
 */
export const probeWebhookRoute = async ({
  baseUrl,
  fetchImpl = fetch,
  timeoutMs = 3_000,
}: {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<ProbeOutcome> => {
  const signature = signOutgoingProbe(PROBE_BODY);
  const signed = signature !== null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(resolverUrl(baseUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(signature === null ? {} : { [META_SIGNATURE_HEADER]: signature }),
      },
      body: PROBE_BODY,
      signal: controller.signal,
    });

    return decideRouteProbe({ status: response.status, signed });
  } catch {
    return decideRouteProbe({ status: null, signed });
  } finally {
    clearTimeout(timer);
  }
};
