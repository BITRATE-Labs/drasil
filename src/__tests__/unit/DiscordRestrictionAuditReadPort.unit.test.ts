import { ChannelType, Client, GuildMember, Role } from 'discord.js';
import { IConfigService } from '../../config/ConfigService';
import { PrismaClient } from '../../db/prisma';
import { DiscordRestrictionAuditReadPort } from '../../services/DiscordRestrictionAuditReadPort';
import { restrictionRoleFact } from '../../utils/restrictionRoleFact';

it('pages guild-scoped pending cases in fixed batches of 50', async () => {
  const findMany = jest.fn().mockResolvedValue(
    Array.from({ length: 50 }, (_, i) => ({
      id: String(i),
      case_revision: i,
      user_id: 'user',
      thread_id: null,
      case_kind: 'standard',
      quarantine_case_role_id: 'persisted',
    }))
  );
  const port = new DiscordRestrictionAuditReadPort(
    {} as Client,
    {} as IConfigService,
    { verification_events: { findMany } } as unknown as PrismaClient
  );
  const page = await port.readCases('guild', 'previous', 50);
  expect(findMany).toHaveBeenCalledWith({
    where: { server_id: 'guild', status: 'pending', user_id: { not: null } },
    orderBy: { id: 'asc' },
    cursor: { id: 'previous' },
    skip: 1,
    take: 50,
  });
  expect(page.next).toBe('49');
  expect(page.items[0]).toMatchObject({
    caseRevision: '0',
    caseRoleId: 'persisted',
    metadataAvailable: false,
  });
});
it('paginates public forum archives without requesting unsupported private threads', async () => {
  const fetchArchived = jest
    .fn()
    .mockResolvedValueOnce({
      threads: new Map([
        [
          'first',
          {
            id: 'first',
            parentId: 'forum',
            type: ChannelType.PublicThread,
            archiveTimestamp: 1000,
            archived: true,
            locked: false,
          },
        ],
      ]),
      hasMore: true,
    })
    .mockResolvedValueOnce({ threads: new Map(), hasMore: false });
  const forum = {
    id: 'forum',
    type: ChannelType.GuildForum,
    isThread: () => false,
    threads: { fetchArchived },
  };
  const guild = {
    channels: {
      cache: new Map([['forum', forum]]),
      fetchActiveThreads: jest.fn().mockResolvedValue({ threads: new Map() }),
    },
  };
  const port = new DiscordRestrictionAuditReadPort(
    { guilds: { fetch: jest.fn().mockResolvedValue(guild) } } as unknown as Client,
    {} as IConfigService,
    {} as PrismaClient
  );
  const active = await port.readThreads('guild', null, 100);
  const first = await port.readThreads('guild', active.next, 100);
  expect(fetchArchived).toHaveBeenLastCalledWith({ type: 'public', limit: 100 }, false);
  const last = await port.readThreads('guild', first.next, 100);
  expect(fetchArchived).toHaveBeenLastCalledWith(
    { type: 'public', limit: 100, before: new Date(1000) },
    false
  );
  expect(last.next).toBeNull();
});
it('uses supported paginated private thread member reads and fresh guild-scoped channel fetches', async () => {
  const fetchMembers = jest.fn().mockResolvedValue(new Map([['user', {}]]));
  const fetchChannel = jest
    .fn()
    .mockResolvedValue({ isThread: () => true, members: { fetch: fetchMembers } });
  const port = new DiscordRestrictionAuditReadPort(
    {
      guilds: { fetch: jest.fn().mockResolvedValue({ channels: { fetch: fetchChannel } }) },
    } as unknown as Client,
    {} as IConfigService,
    {} as PrismaClient
  );
  expect(await port.readThreadMembers('guild', 'thread', 'previous', 100)).toEqual({
    items: ['user'],
    next: null,
  });
  expect(fetchChannel).toHaveBeenCalledWith('thread', { force: true });
  expect(fetchMembers).toHaveBeenCalledWith({
    limit: 100,
    after: 'previous',
    withMember: true,
    cache: false,
  });
});
it('preserves Discord equal-position ordering for quarantine policy', () => {
  const role = {
    id: 'r',
    name: 'Member',
    position: 10,
    permissions: { bitfield: 0n },
    managed: false,
    tags: null,
  } as unknown as Role;
  const bot = {
    roles: { highest: { position: 10, comparePositionTo: () => 1 } },
  } as unknown as GuildMember;
  expect(restrictionRoleFact(role, bot).position).toBe(9);
});
