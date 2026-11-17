import { RestrictionAuditService } from '../../services/RestrictionAuditService';
import { facts, channel } from '../../../packages/application/src/operations/restrictionTestData';
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

it('requests all archived private threads, including unjoined threads, on every timestamp page', async () => {
  const unjoined = {
    id: 'unjoined',
    parentId: 'parent',
    type: ChannelType.PrivateThread,
    archiveTimestamp: 1000,
    archived: true,
    locked: false,
  };
  const fetchArchived = jest
    .fn()
    .mockImplementation(async (options: { fetchAll?: boolean; before?: Date }) =>
      options.fetchAll
        ? { threads: new Map([['unjoined', unjoined]]), hasMore: !options.before }
        : { threads: new Map(), hasMore: false }
    );
  const parent = {
    id: 'parent',
    type: ChannelType.GuildText,
    isThread: () => false,
    threads: { fetchArchived },
  };
  const port = new DiscordRestrictionAuditReadPort(
    {
      guilds: {
        fetch: jest.fn().mockResolvedValue({ channels: { cache: new Map([['parent', parent]]) } }),
      },
    } as unknown as Client,
    {} as IConfigService,
    {} as PrismaClient
  );
  const first = await port.readThreads(
    'guild',
    JSON.stringify({ index: 0, type: 'private', before: null }),
    100
  );
  expect(first.items.map((t) => t.id)).toContain('unjoined');
  expect(first.next).not.toBeNull();
  const second = await port.readThreads('guild', first.next, 100);
  expect(fetchArchived).toHaveBeenLastCalledWith(
    { type: 'private', fetchAll: true, limit: 100, before: new Date(1000) },
    false
  );
  expect(second.next).toBeNull();
});
it('marks omitted raw overwrites unavailable instead of trusting retained Discord cache', async () => {
  const cached = {
    id: 'channel',
    name: 'Community',
    type: ChannelType.GuildText,
    parentId: null,
    permissionsLocked: false,
    isThread: () => false,
    permissionOverwrites: {
      cache: new Map([
        ['case', { id: 'case', type: 0, allow: { bitfield: 0n }, deny: { bitfield: 1024n } }],
      ]),
    },
  };
  const get = jest
    .fn()
    .mockResolvedValue([{ id: 'channel', type: ChannelType.GuildText, name: 'Community' }]);
  const guild = {
    roles: { fetch: jest.fn().mockResolvedValue(new Map()) },
    channels: { fetch: jest.fn().mockResolvedValue(new Map([['channel', cached]])) },
    members: { fetchMe: jest.fn().mockResolvedValue(null) },
  };
  const port = new DiscordRestrictionAuditReadPort(
    { guilds: { fetch: jest.fn().mockResolvedValue(guild) }, rest: { get } } as unknown as Client,
    {
      getServerConfig: jest
        .fn()
        .mockResolvedValue({ settings: {}, case_role_id: 'case', verification_channel_id: null }),
    },
    {} as PrismaClient
  );
  const unavailable = await port.readBase('guild');
  expect(get).toHaveBeenCalledWith('/guilds/guild/channels');
  expect(unavailable.channels[0]).toMatchObject({ metadataAvailable: false, overwrites: [] });
  get.mockResolvedValue([
    { id: 'channel', type: ChannelType.GuildText, permission_overwrites: [] },
  ]);
  expect((await port.readBase('guild')).channels[0]).toMatchObject({
    metadataAvailable: true,
    overwrites: [],
  });
});

it('keeps coverage partial when the all-private archive route is denied', async () => {
  const fetchArchived = jest.fn().mockImplementation(async (options: { fetchAll?: boolean }) => {
    if (options.fetchAll) throw new Error('Missing permissions');
    return { threads: new Map(), hasMore: false };
  });
  const parent = {
    id: 'parent',
    type: ChannelType.GuildText,
    isThread: () => false,
    threads: { fetchArchived },
  };
  const guild = {
    channels: {
      cache: new Map([['parent', parent]]),
      fetchActiveThreads: jest.fn().mockResolvedValue({
        threads: new Map([
          [
            'known',
            {
              id: 'known',
              parentId: 'parent',
              type: ChannelType.PublicThread,
              archived: false,
              locked: false,
            },
          ],
        ]),
      }),
    },
  };
  const port = new DiscordRestrictionAuditReadPort(
    { guilds: { fetch: jest.fn().mockResolvedValue(guild) } } as unknown as Client,
    {} as IConfigService,
    {} as PrismaClient
  );
  jest.spyOn(port, 'readBase').mockResolvedValue(facts({ channels: [channel({ id: 'parent' })] }));
  jest.spyOn(port, 'readCases').mockResolvedValue({ items: [], next: null });
  const audit = await new RestrictionAuditService(port).auditGuild('guild');
  expect(audit.coverage.find((c) => c.area === 'threads')?.state).toBe('partial');
  expect(audit.setup.status).not.toBe('verified');
  expect(fetchArchived).toHaveBeenLastCalledWith(
    { type: 'private', fetchAll: true, limit: 100 },
    false
  );
});

it('derives unsynced child access and parent identity from the same raw overwrite snapshot', async () => {
  const staleChild = {
    id: 'child',
    name: 'Child',
    type: ChannelType.GuildText,
    parentId: 'parent',
    permissionsLocked: true,
    isThread: () => false,
    permissionOverwrites: { cache: new Map() },
  };
  const staleParent = {
    ...staleChild,
    id: 'parent',
    type: ChannelType.GuildCategory,
    parentId: null,
  };
  const roles = new Map(
    facts().roles.map((role) => [
      role.id,
      { ...role, permissions: { bitfield: role.id === 'guild' ? 1024n : 0n }, tags: null },
    ])
  );
  const raw = [
    {
      id: 'parent',
      type: ChannelType.GuildCategory,
      parent_id: null,
      permission_overwrites: [{ id: 'case', type: 0, allow: '0', deny: '1024' }],
    },
    {
      id: 'child',
      type: ChannelType.GuildText,
      parent_id: 'parent',
      permission_overwrites: [{ id: 'case', type: 0, allow: '1024', deny: '0' }],
    },
  ];
  const guild = {
    roles: { fetch: jest.fn().mockResolvedValue(roles) },
    channels: {
      fetch: jest.fn().mockResolvedValue(
        new Map<string, typeof staleParent | typeof staleChild>([
          ['parent', staleParent],
          ['child', staleChild],
        ])
      ),
    },
    members: { fetchMe: jest.fn().mockResolvedValue(null) },
  };
  const get = jest.fn().mockResolvedValue(raw);
  const port = new DiscordRestrictionAuditReadPort(
    { guilds: { fetch: jest.fn().mockResolvedValue(guild) }, rest: { get } } as unknown as Client,
    {
      getServerConfig: jest
        .fn()
        .mockResolvedValue({ settings: {}, case_role_id: 'case', verification_channel_id: null }),
    },
    {} as PrismaClient
  );
  const collected = await port.readBase('guild');
  expect(collected.channels.find((c) => c.id === 'child')).toMatchObject({
    parentId: 'parent',
    permissionsLocked: false,
    metadataAvailable: true,
  });
  const { assessRestrictionFacts } = await import('@drasil/application');
  expect(
    assessRestrictionFacts({ ...collected, casesComplete: true, threadsComplete: true }).setup
      .findingCodes
  ).toContain('unexpected_channel_access');
  raw[1].permission_overwrites = [...raw[0].permission_overwrites];
  staleChild.parentId = 'old-parent';
  expect((await port.readBase('guild')).channels.find((c) => c.id === 'child')).toMatchObject({
    parentId: 'parent',
    permissionsLocked: true,
  });
});
