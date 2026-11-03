import { describe, expect, it } from 'vitest';

import { ROLE_ADMIN, ROLE_AGENT } from '../constants/universal-identifiers';
import {
  ForbiddenError,
  UnauthorizedError,
  authErrorResponse,
  requireRole,
  rolesForCaller,
  type Caller,
} from './auth';
import {
  clearClaims,
  phoneClaimKey,
  wabaClaimKey,
} from '../logic-functions/wa-account-admin-route';

const caller = (overrides: Partial<Caller> = {}): Caller => ({
  userWorkspaceId: 'uw-1',
  workspaceMemberId: 'wm-1',
  roleUniversalIdentifiers: [],
  isAdmin: false,
  isAgent: false,
  isMachine: false,
  ...overrides,
});

describe('requireRole', () => {
  it('lets an admin through an admin gate', () => {
    expect(() =>
      requireRole(caller({ isAdmin: true, isAgent: true }), 'admin'),
    ).not.toThrow();
  });

  it('refuses an agent at an admin gate', () => {
    expect(() =>
      requireRole(caller({ isAgent: true, roleUniversalIdentifiers: [ROLE_AGENT] }), 'admin'),
    ).toThrow(ForbiddenError);
  });

  it('refuses someone with no role at all', () => {
    expect(() => requireRole(caller(), 'agent')).toThrow(ForbiddenError);
  });

  /** Admin implies agent: every admin can do everything a rep can. */
  it('lets an admin through an agent gate', () => {
    expect(() =>
      requireRole(caller({ isAdmin: true, isAgent: true, roleUniversalIdentifiers: [ROLE_ADMIN] }), 'agent'),
    ).not.toThrow();
  });

  it('names the required role without naming the caller', () => {
    try {
      requireRole(caller(), 'admin');
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toContain('admin');
      expect((error as Error).message).not.toContain('uw-1');
    }
  });
});


/**
 * D-53. The join that failed in production, and the reason it failed: the
 * platform lists role members by `workspaceMember.id` and leaves
 * `userWorkspaceId` null, while the route event carries only `userWorkspaceId`.
 * Matching on either key is what lets a real person be placed at all.
 */
describe('rolesForCaller', () => {
  const roles = [
    {
      universalIdentifier: ROLE_AGENT,
      canUpdateAllSettings: false,
      members: [{ id: 'wm-1', userWorkspaceId: null }],
    },
    {
      universalIdentifier: ROLE_ADMIN,
      canUpdateAllSettings: false,
      members: [{ id: 'wm-2', userWorkspaceId: null }],
    },
  ];

  it('places a caller by workspace member id when the platform sends no userWorkspaceId', () => {
    expect(
      rolesForCaller(roles, { userWorkspaceId: 'uw-1', workspaceMemberId: 'wm-1' }).map(
        (role) => role.universalIdentifier,
      ),
    ).toEqual([ROLE_AGENT]);
  });

  /** The old behaviour, kept working for a platform that does fill the field in. */
  it('still places a caller by userWorkspaceId when it is present', () => {
    const filled = [
      { ...roles[0], members: [{ id: 'wm-1', userWorkspaceId: 'uw-1' }] },
      roles[1],
    ];

    expect(
      rolesForCaller(filled, { userWorkspaceId: 'uw-1', workspaceMemberId: null }).map(
        (role) => role.universalIdentifier,
      ),
    ).toEqual([ROLE_AGENT]);
  });

  /**
   * A caller we could not identify gets nothing — not everything. Without this,
   * a failed identity lookup would read as "matches every role whose members
   * also have a null id", which is how a fail-open is written by accident.
   */
  it('gives an unidentified caller no roles at all', () => {
    expect(rolesForCaller(roles, { userWorkspaceId: 'uw-9', workspaceMemberId: null })).toEqual(
      [],
    );
  });

  it('does not let a null userWorkspaceId on both sides count as a match', () => {
    const orphan = [
      { universalIdentifier: ROLE_ADMIN, canUpdateAllSettings: true, members: [] },
    ];

    expect(rolesForCaller(orphan, { userWorkspaceId: 'uw-1', workspaceMemberId: 'wm-1' })).toEqual(
      [],
    );
  });
});

describe('authErrorResponse', () => {
  it('maps the two auth failures to their status codes', () => {
    expect(authErrorResponse(new UnauthorizedError())?.status).toBe(401);
    expect(authErrorResponse(new ForbiddenError())?.status).toBe(403);
  });

  /** Anything else is a bug, not a permission decision, and must not read as 403. */
  it('returns null for an unrelated error', () => {
    expect(authErrorResponse(new Error('database exploded'))).toBeNull();
  });
});

describe('routing claims', () => {
  it('keys both forms exactly as the resolver reads them', () => {
    expect(phoneClaimKey('1206450239224164')).toBe('wa:phone-number:1206450239224164');
    expect(wabaClaimKey('2129199877947066')).toBe('wa:waba:2129199877947066');
  });

  /**
   * Several numbers commonly share one WABA. Clearing the WABA claim on
   * disconnecting one of them would silently stop every *other* number's
   * template and account events — with nothing in the UI to suggest why.
   */
  it('keeps the WABA claim when another account still uses it', async () => {
    const deleted: string[] = [];
    const kvModule = await import('twenty-sdk/logic-function');
    const originalDelete = kvModule.kv.delete;
    const originalGet = kvModule.kv.get;

    kvModule.kv.delete = (async (key: string) => {
      deleted.push(key);

      return true;
    }) as typeof kvModule.kv.delete;
    kvModule.kv.get = (async () => 'ws-1') as typeof kvModule.kv.get;

    try {
      await clearClaims({
        workspaceId: 'ws-1',
        phoneNumberId: 'pn-1',
        wabaId: 'waba-1',
        wabaStillInUse: true,
      });
      expect(deleted).toEqual(['wa:phone-number:pn-1']);

      deleted.length = 0;
      await clearClaims({
        workspaceId: 'ws-1',
        phoneNumberId: 'pn-1',
        wabaId: 'waba-1',
        wabaStillInUse: false,
      });
      expect(deleted).toEqual(['wa:phone-number:pn-1', 'wa:waba:waba-1']);
    } finally {
      kvModule.kv.delete = originalDelete;
      kvModule.kv.get = originalGet;
    }
  });

  /**
   * The claims are SERVER-scoped and shared across every workspace on the
   * server, so a disconnect must never delete a claim another tenant holds —
   * that would silence their number's deliveries from a workspace that does
   * not own it.
   */
  it('never deletes a claim held by another workspace', async () => {
    const deleted: string[] = [];
    const kvModule = await import('twenty-sdk/logic-function');
    const originalDelete = kvModule.kv.delete;
    const originalGet = kvModule.kv.get;

    kvModule.kv.delete = (async (key: string) => {
      deleted.push(key);

      return true;
    }) as typeof kvModule.kv.delete;
    kvModule.kv.get = (async () => 'someone-else') as typeof kvModule.kv.get;

    try {
      await clearClaims({
        workspaceId: 'ws-1',
        phoneNumberId: 'pn-1',
        wabaId: 'waba-1',
        wabaStillInUse: false,
      });
      expect(deleted).toEqual([]);
    } finally {
      kvModule.kv.delete = originalDelete;
      kvModule.kv.get = originalGet;
    }
  });
});
