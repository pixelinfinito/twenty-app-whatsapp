import { CoreApiClient } from 'twenty-client-sdk/core';
import { MetadataApiClient } from 'twenty-client-sdk/metadata';

/**
 * Memoised API clients.
 *
 * A logic function invocation is short-lived but can make dozens of calls;
 * rebuilding the genql client each time rebuilds its type map for nothing. The
 * clients read `TWENTY_API_URL` and the injected app access token from the
 * environment, so there is nothing to configure and nothing to pass around.
 */

let core: CoreApiClient | null = null;
let metadata: MetadataApiClient | null = null;

export const coreClient = (): CoreApiClient => (core ??= new CoreApiClient());

export const metadataClient = (): MetadataApiClient => (metadata ??= new MetadataApiClient());

/** Role checks need the app's permission to read assignments, even for an agent. */
let applicationMetadata: MetadataApiClient | null = null;

export const applicationMetadataClient = (): MetadataApiClient =>
  (applicationMetadata ??= new MetadataApiClient({ runAs: 'application' }));

/** Test seam. Also the correct response to a token rotation mid-process. */
export const resetClients = (): void => {
  core = null;
  metadata = null;
  applicationMetadata = null;
};
