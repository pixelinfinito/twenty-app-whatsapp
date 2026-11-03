import { kv, type LogicFunctionExecutionContext } from 'twenty-sdk/logic-function';

import { ROLE_ADMIN, ROLE_AGENT } from '../constants/universal-identifiers';
import { metadataClient } from './clients';
import { config } from './config';
import { describeError, logger } from './logger';
import { toolScope } from './tool-scope';

/**
 * Server-side role re-checks (SEC-5).
 *
 * Object permissions protect the Core API. They do **not** protect our HTTP
 * routes, which run with the app's own role — so a route that trusted the
 * caller would let any authenticated agent connect a number or launch a
 * campaign. A front component hiding a button is a convenience, never a
 * control.
 */

export class UnauthorizedError extends Error {
  readonly status = 401;

  constructor(message = 'Authentication required') {
    super(message);
    this.name = 'UnauthorizedError';
  }
}

export class ForbiddenError extends Error {
  readonly status = 403;

  constructor(message = 'Insufficient permissions') {
    super(message);
    this.name = 'ForbiddenError';
  }
}

export type CallerRole = 'admin' | 'agent';

export type Caller = {
  /** Null for a machine caller — see `requireCaller`. */
  userWorkspaceId: string | null;
  workspaceMemberId: string | null;
  roleUniversalIdentifiers: string[];
  isAdmin: boolean;
  isAgent: boolean;
  /** An authenticated credential that is not a workspace member (an API key). */
  isMachine: boolean;
};

type RoleMember = { id: string; userWorkspaceId: string | null };

type RoleAssignment = {
  universalIdentifier: string | null;
  canUpdateAllSettings: boolean;
  members: RoleMember[];
};

const ROLE_CACHE_KEY = 'wa:role-assignments';
const ROLE_CACHE_TTL_MS = 60_000;

type CachedRoles = { at: number; roles: RoleAssignment[] };

/**
 * Role assignments change rarely and every route needs them, so they are cached
 * for a minute. The TTL is short on purpose: revoking someone's admin role is a
 * security action, and waiting an hour for it to take effect would make the
 * cache the vulnerability.
 */
const loadRoleAssignments = async (): Promise<RoleAssignment[]> => {
  const cached = await kv.get<CachedRoles>(ROLE_CACHE_KEY, { scope: 'WORKSPACE' });

  if (cached !== null && Date.now() - cached.at < ROLE_CACHE_TTL_MS) return cached.roles;

  const result = await metadataClient().query({
    getRoles: {
      universalIdentifier: true,
      canUpdateAllSettings: true,
      workspaceMembers: { id: true, userWorkspaceId: true },
    },
  });

  const roles: RoleAssignment[] = (result.getRoles ?? []).map((role) => ({
    universalIdentifier: role.universalIdentifier ?? null,
    canUpdateAllSettings: role.canUpdateAllSettings === true,
    /**
     * `userWorkspaceId` is kept when the platform sends it and tolerated when
     * it does not. On the build this app was written against it is **null for
     * every member**, which is what made D-53 possible: the previous version
     * of this filter required it to be a string, so it discarded every member
     * of every role and left an empty map that refused everyone.
     */
    members: (role.workspaceMembers ?? [])
      .filter((member): member is { id: string } => typeof member?.id === 'string')
      .map((member) => ({
        id: member.id,
        userWorkspaceId:
          typeof (member as { userWorkspaceId?: unknown }).userWorkspaceId === 'string'
            ? ((member as { userWorkspaceId?: string }).userWorkspaceId ?? null)
            : null,
      })),
  }));

  await kv.set(ROLE_CACHE_KEY, { at: Date.now(), roles }, { scope: 'WORKSPACE' });

  return roles;
};

/** Forces the next check to re-read — call after changing a role assignment. */
export const invalidateRoleCache = async (): Promise<void> => {
  await kv.delete(ROLE_CACHE_KEY, { scope: 'WORKSPACE' });
};

export type AuthEvent = {
  userWorkspaceId?: string | null;
  headers?: Record<string, string | undefined>;
};

/** Every role this caller holds, matched by whichever key the platform gave us. */
export const rolesForCaller = (
  roles: RoleAssignment[],
  identity: { userWorkspaceId: string; workspaceMemberId: string | null },
): RoleAssignment[] =>
  roles.filter((role) =>
    role.members.some(
      (member) =>
        (identity.workspaceMemberId !== null && member.id === identity.workspaceMemberId) ||
        (member.userWorkspaceId !== null &&
          member.userWorkspaceId === identity.userWorkspaceId),
    ),
  );

export type CallerContext = Pick<LogicFunctionExecutionContext, 'userWorkspaceId' | 'workspaceMemberId'>;

/** Identity comes from Twenty's trusted execution context, never a request header or body. */
export const requireCaller = async (_event: AuthEvent, context?: CallerContext): Promise<Caller> => {
  const invocation = toolScope();
  if (invocation) return invocation.caller;
  if (context === undefined) throw new UnauthorizedError('Missing execution context');
  const userWorkspaceId = context.userWorkspaceId;

  /**
   * No membership on an `isAuthRequired: true` route means a **machine
   * caller**, not an anonymous one.
   *
   * Verified against the running platform: an absent or invalid token is
   * rejected before the handler is entered ("Missing authentication token" /
   * "Token invalid."). So reaching this line without a membership means a valid
   * workspace-level credential — an API key.
   *
   * Machine callers are **refused by default**. Twenty lets an API key be
   * assigned a restricted role, and this app has no way to read which role a
   * given key holds — `currentUser` answers nothing for a key — so treating
   * every key as an admin would silently promote a read-only or unrelated
   * credential to sending messages, connecting numbers, changing consent and
   * running erasure. A workspace that runs trusted automation against these
   * routes opts in explicitly with `WA_ALLOW_API_KEY_ADMIN=true`, and should
   * scope that automation to a dedicated key.
   *
   * When enabled, machine actions are audited with a null actor, so "who
   * connected this number" reads "an API key" rather than a member's name.
   */
  if (typeof userWorkspaceId !== 'string' || userWorkspaceId.length === 0) {
    if (!config.allowApiKeyAdmin()) {
      logger.warn('auth.machine_caller_refused');

      throw new ForbiddenError(
        'API keys cannot call WhatsApp routes on this workspace. Set the WA_ALLOW_API_KEY_ADMIN application variable to true to allow trusted automation.',
      );
    }

    logger.info('auth.machine_caller');

    return {
      userWorkspaceId: null,
      workspaceMemberId: null,
      roleUniversalIdentifiers: [],
      isAdmin: true,
      isAgent: true,
      isMachine: true,
    };
  }

  let roles: RoleAssignment[];

  try {
    roles = await loadRoleAssignments();
  } catch (error) {
    /**
     * Fails closed. If the role map cannot be read we cannot tell an admin from
     * an agent, and guessing in the permissive direction on a route that
     * connects phone numbers is not a trade worth making.
     */
    logger.error('auth.role_lookup_failed', describeError(error));

    throw new ForbiddenError('Could not verify permissions');
  }

  // Twenty binds this member ID to the authenticated route invocation.
  const workspaceMemberId = context?.workspaceMemberId ?? null;

  const mine = rolesForCaller(roles, { userWorkspaceId, workspaceMemberId });

  const identifiers = mine
    .map((role) => role.universalIdentifier)
    .filter((identifier): identifier is string => identifier !== null);

  /**
   * A Twenty workspace administrator counts as a WhatsApp admin.
   *
   * Without this the first connection is impossible: the app ships its roles
   * but assigns them to nobody, so a fresh install would have no one able to
   * connect a number — including the person who installed it. `canUpdateAllSettings`
   * is Twenty's own "may configure this workspace" flag, which is exactly the
   * authority this route needs.
   */
  const isWorkspaceAdmin = mine.some((role) => role.canUpdateAllSettings);
  const isAdmin = identifiers.includes(ROLE_ADMIN) || isWorkspaceAdmin;

  return {
    userWorkspaceId,
    workspaceMemberId,
    roleUniversalIdentifiers: identifiers,
    isAdmin,
    // Admin implies agent: every admin can also do everything a rep can.
    isAgent: isAdmin || identifiers.includes(ROLE_AGENT),
    isMachine: false,
  };
};

export const requireRole = (caller: Caller, role: CallerRole): void => {
  const permitted = role === 'admin' ? caller.isAdmin : caller.isAgent;

  if (!permitted) {
    logger.warn('auth.forbidden', {
      required: role,
      roles: caller.roleUniversalIdentifiers,
    });

    throw new ForbiddenError(`This action requires the WhatsApp ${role} role`);
  }
};

/**
 * Turns an auth failure into the response shape a route returns, so every route
 * reports the same thing for the same reason.
 */
export const authErrorResponse = (
  error: unknown,
): { status: number; body: { error: string } } | null => {
  if (error instanceof UnauthorizedError || error instanceof ForbiddenError) {
    return { status: error.status, body: { error: error.message } };
  }

  return null;
};
