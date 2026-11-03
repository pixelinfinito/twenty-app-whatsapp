import { AsyncLocalStorage } from 'node:async_hooks';
import type { CoreApiClient } from 'twenty-client-sdk/core';
import type { Caller } from './auth';

export type ToolPrincipal = {
  version: 1;
  workspaceId: string;
  kind: 'member' | 'apiKey' | 'agent';
  id: string;
  workspaceMemberId: string | null;
  agentId?: string;
  permissionFlagUniversalIdentifiers: string[];
  surface: 'MCP' | 'AI_TOOL';
};

export type ToolScope = {
  principal: ToolPrincipal;
  caller: Caller;
  readClient: CoreApiClient;
  accessToken: string;
  applicationReads?: boolean;
};

const scopes = new AsyncLocalStorage<ToolScope>();
export const toolScope = () => scopes.getStore();
export const withToolScope = <T>(scope: ToolScope, run: () => Promise<T>): Promise<T> =>
  scopes.run(scope, run);

/** Internal identity/policy checks must not lose hidden suppression records. */
export const withApplicationReads = <T>(run: () => Promise<T>): Promise<T> => {
  const scope = toolScope();
  return scope ? scopes.run({ ...scope, applicationReads: true }, run) : run();
};
