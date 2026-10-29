import { createCloudApiProvider } from './cloud-api.provider';
import { optionalSecret, requireSecret } from './config';
import {
  computeMetaSignature,
  verifyMetaSignature,
  verifyMetaVerifyToken,
} from './verify-signature';
import type { WhatsAppProvider } from './types';

/**
 * The provider factory (AR-18, D-14).
 *
 * One implementation exists today. The indirection earns its keep anyway: it is
 * the seam every test substitutes at, and it is the single place that would
 * change if a second WhatsApp BSP were ever added. `WA_PROVIDER` naming an
 * unknown value fails loudly rather than falling back to Meta — a silent
 * fallback would send real customer messages through a provider nobody
 * selected.
 */

const REGISTRY: Record<string, () => WhatsAppProvider> = {
  META_CLOUD_API: createCloudApiProvider,
};

/**
 * Values that earlier versions shipped as the declared default.
 *
 * An application variable already saved in a workspace is a *user setting*, so
 * changing the declaration does not overwrite it — every install that ever ran
 * the old build still holds `cloud-api`. This is an alias, not a fallback: it
 * names the same single provider, and an unrecognised value still throws.
 * Removable once no install carries the old value.
 */
const ALIASES: Record<string, string> = {
  CLOUD_API: 'META_CLOUD_API',
};

export const DEFAULT_PROVIDER = 'META_CLOUD_API';

let cached: { key: string; provider: WhatsAppProvider } | null = null;

/** `cloud-api`, `Cloud-API` and `CLOUD_API` all denote one thing. */
const canonicalise = (raw: string): string => {
  const normalised = raw.trim().toUpperCase().replace(/-/g, '_');

  return ALIASES[normalised] ?? normalised;
};

export const getProvider = (): WhatsAppProvider => {
  const key = canonicalise(process.env.WA_PROVIDER ?? DEFAULT_PROVIDER);

  if (cached?.key === key) return cached.provider;

  const factory = REGISTRY[key];
  if (factory === undefined) {
    throw new Error(
      `Unknown WA_PROVIDER "${key}". Known providers: ${Object.keys(REGISTRY).join(', ')}`,
    );
  }

  const provider = factory();
  cached = { key, provider };

  return provider;
};

/** Test seam: forces the next `getProvider()` to rebuild. */
export const resetProviderCache = (): void => {
  cached = null;
};

/**
 * Signature and token checks that read their own secret.
 *
 * `verify-signature.ts` stays dependency-free so the capture harness can import
 * it and pass a secret from `.dev.vars` — that is what makes a capture session
 * a live conformance test. These two wrappers exist so that no *handler* ever
 * names `META_APP_SECRET` or `META_VERIFY_TOKEN`: the secret enters the process
 * in one directory, which is the rule the architecture test enforces.
 */
export const verifyIncomingSignature = ({
  rawBody,
  header,
}: {
  rawBody: string | Buffer;
  header: string | undefined;
}): boolean =>
  verifyMetaSignature({ rawBody, header, appSecret: requireSecret('META_APP_SECRET') });

export const verifyIncomingToken = (provided: string | undefined): boolean =>
  verifyMetaVerifyToken(provided, requireSecret('META_VERIFY_TOKEN'));

/**
 * Signs a body the way Meta would, for the health panel's route probe.
 *
 * `optionalSecret`, not `requireSecret`: an install that has not set the app
 * secret yet still deserves to learn whether its webhook route exists, and
 * throwing here would turn a diagnostic into the outage it was meant to
 * report. `null` means "could not sign", and the probe degrades to asking only
 * whether the route is registered.
 *
 * The third wrapper, for the same reason as the two above: the health check
 * must not name `META_APP_SECRET`.
 */
export const signOutgoingProbe = (rawBody: string): string | null => {
  const secret = optionalSecret('META_APP_SECRET');

  return secret === null || secret.length === 0
    ? null
    : computeMetaSignature(rawBody, secret);
};

export * from './types';
export * from './errors';
export * from './payload';
export {
  META_SIGNATURE_HEADER,
  verifyMetaSignature,
  verifyMetaVerifyToken,
  constantTimeEquals,
} from './verify-signature';
