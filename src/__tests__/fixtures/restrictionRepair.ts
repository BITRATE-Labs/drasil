import type { GuildMember, Role, User } from 'discord.js';
import type { IConfigService } from '../../config/ConfigService';
import { VerificationStatus, type VerificationEvent } from '../../repositories/types';
export function repairFixture() {
  const makeRole = (id: string, permissions = 0n): Role =>
    ({
      id,
      name: id,
      position: 1,
      managed: false,
      tags: {},
      permissions: { bitfield: permissions, has: (bit: bigint) => (permissions & bit) !== 0n },
    }) as Role;
  const ordinary = makeRole('ordinary'),
    earlier = makeRole('earlier'),
    caseRole = makeRole('case-role');
  const roles = new Map([ordinary, earlier, caseRole].map((r) => [r.id, r]));
  const held = new Map([ordinary, caseRole].map((r) => [r.id, r]));
  const bot = {
    roles: { highest: { position: 100, comparePositionTo: (r: Role) => 100 - r.position } },
  };
  const member = {
    id: 'member',
    joinedAt: new Date('2020-01-01'),
    roles: {
      cache: held,
      remove: jest.fn(async (r: Role) => {
        held.delete(r.id);
      }),
      add: jest.fn(async (r: Role) => {
        held.set(r.id, r);
      }),
    },
    guild: {
      id: 'guild',
      ownerId: 'owner',
      roles: { cache: roles, fetch: jest.fn(async () => roles) },
      members: { me: bot, fetchMe: jest.fn(async () => bot), fetch: jest.fn(async () => member) },
    },
  } as unknown as GuildMember;
  const event = {
    id: 'case',
    server_id: 'guild',
    user_id: 'member',
    case_revision: 0,
    status: VerificationStatus.PENDING,
    quarantine_case_role_id: 'case-role',
    quarantine_attempt_id: null,
  } as VerificationEvent;
  const config = {
    getServerConfig: jest.fn().mockResolvedValue({
      guild_id: 'guild',
      case_role_id: 'case-role',
      settings: { role_quarantine_mode: 'on' },
    }),
  } as unknown as IConfigService;
  const actor = { id: 'actor' } as User;
  const fence = {
    requestId: 'request',
    attemptToken: 'private',
    caseRevision: 0,
    joinedAt: new Date('2020-01-01').toISOString(),
    assertOwner: jest.fn().mockResolvedValue(undefined),
  };
  return { member, event, config, actor, fence, ordinary, earlier, caseRole };
}
