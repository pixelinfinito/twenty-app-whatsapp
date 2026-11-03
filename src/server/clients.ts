import { CoreApiClient } from 'twenty-client-sdk/core';
import { MetadataApiClient } from 'twenty-client-sdk/metadata';
import { toolScope } from './tool-scope';

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

export const applicationCoreClient = (): CoreApiClient =>
  (core ??= new CoreApiClient({ runAs: 'application' }));

export const coreClient = (): CoreApiClient => {
  const app = applicationCoreClient();
  const scoped = toolScope();
  if (!scoped || scoped.applicationReads) return app;
  // Reads enforce the invoking principal's field and row permissions. App-owned
  // mutations remain behind the shared operation's validation and role gates.
  return new Proxy(app, {
    get(target, property) {
      if (property === 'query') return scoped.readClient.query.bind(scoped.readClient);
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
};

export const metadataClient = (): MetadataApiClient => (metadata ??= new MetadataApiClient({ runAs: 'application' }));

/** Test seam. Also the correct response to a token rotation mid-process. */
export const resetClients = (): void => {
  core = null;
  metadata = null;
};
