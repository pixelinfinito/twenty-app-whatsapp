import { CoreApiClient } from 'twenty-client-sdk/core';
import type { InputJsonSchema, LogicFunctionExecutionContext } from 'twenty-sdk/logic-function';
import { PERMISSION_WHATSAPP_ADMIN, PERMISSION_WHATSAPP_OPERATOR } from '../constants/tool-identifiers';
import { ForbiddenError, UnauthorizedError, type Caller } from './auth';
import { ToolError, toolDenied } from './tool-errors';
import { describeError, logger } from './logger';
import { validateToolInput } from './tool-schema';
import { toolScope, withToolScope, type ToolPrincipal } from './tool-scope';

export type WhatsappToolContext = LogicFunctionExecutionContext & { toolCaller?: ToolPrincipal };

export const authenticatedTool = async <T>(
  schema: InputJsonSchema, input: unknown, context: WhatsappToolContext | undefined,
  run: (input: Record<string, unknown>) => Promise<T>,
): Promise<T | ReturnType<typeof toolDenied>> => {
  try {
    validateToolInput(schema, input);
    const principal = context?.toolCaller;
    const accessToken = process.env.TWENTY_TOOL_CALLER_ACCESS_TOKEN;
    if (!context || !principal || principal.version !== 1 || !accessToken) {
      throw new ToolError('PLATFORM_UPGRADE_REQUIRED', 'Trusted caller delegation v1 is required. No WhatsApp operation was executed.');
    }
    if (principal.workspaceId !== context.workspaceId || !principal.id ||
      !['member', 'apiKey', 'agent'].includes(principal.kind) || !['MCP', 'AI_TOOL'].includes(principal.surface) ||
      !Array.isArray(principal.permissionFlagUniversalIdentifiers)) throw new ToolError('UNAUTHORIZED');
    if (principal.kind === 'member'
      ? !principal.workspaceMemberId || principal.workspaceMemberId !== context.workspaceMemberId
      : principal.workspaceMemberId !== null) throw new ToolError('UNAUTHORIZED');
    const flags = principal.permissionFlagUniversalIdentifiers;
    const isAdmin = flags.includes(PERMISSION_WHATSAPP_ADMIN);
    if (!isAdmin && !flags.includes(PERMISSION_WHATSAPP_OPERATOR)) throw new ToolError('FORBIDDEN');
    const caller: Caller = {
      userWorkspaceId: context.userWorkspaceId, workspaceMemberId: principal.workspaceMemberId,
      roleUniversalIdentifiers: [], isAdmin, isAgent: true, isMachine: principal.kind !== 'member',
    };
    const readClient = new CoreApiClient({ headers: { Authorization: `Bearer ${accessToken}` } });
    return await withToolScope({ principal, caller, readClient, accessToken }, () => run(input as Record<string, unknown>));
  } catch (error) {
    if (error instanceof ToolError) return toolDenied(error.code, error.message);
    if (error instanceof UnauthorizedError) return toolDenied('UNAUTHORIZED');
    if (error instanceof ForbiddenError) return toolDenied('FORBIDDEN');
    logger.error('wa.tool.failed', describeError(error));
    // Provider and authentication errors may contain confidential request data.
    return toolDenied('OPERATION_FAILED', 'Inspect target state before repeating an uncertain operation.');
  }
};

/** Preserved by the manifest; the companion platform patch enforces this. */
export const toolTrigger = (inputSchema: InputJsonSchema, admin = false) => ({
  inputSchema,
  ...(admin ? { requiredPermissionFlagUniversalIdentifiers: [PERMISSION_WHATSAPP_ADMIN] }
    : { requiredAnyPermissionFlagUniversalIdentifiers: [PERMISSION_WHATSAPP_OPERATOR, PERMISSION_WHATSAPP_ADMIN] }),
  callerDelegationVersion: 1,
});

export const assertToolAdmin = () => {
  if (!toolScope()?.caller.isAdmin) throw new ToolError('FORBIDDEN');
};
