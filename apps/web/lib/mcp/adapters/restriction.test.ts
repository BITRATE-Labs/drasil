import { beforeEach, expect, test, vi } from 'vitest';
import { readWebRestrictionFacts } from './restriction';
const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  guild: vi.fn(),
  bot: vi.fn(),
  roles: vi.fn(),
  channels: vi.fn(),
  member: vi.fn(),
  channel: vi.fn(),
  members: vi.fn(),
}));
vi.mock('../../setupDataAdapter', () => ({ getPostgresPool: () => ({ query: mocks.query }) }));
vi.mock('../../discordApi', () => ({
  fetchDiscordGuild: mocks.guild,
  fetchDiscordBotUser: mocks.bot,
  fetchDiscordGuildRoles: mocks.roles,
  fetchDiscordGuildChannels: mocks.channels,
  fetchDiscordGuildMember: mocks.member,
  fetchDiscordChannel: mocks.channel,
  fetchDiscordThreadMembers: mocks.members,
}));
beforeEach(() => {
  vi.clearAllMocks();
  mocks.query.mockResolvedValue({
    rows: [
      {
        guild_id: 'guild',
        case_role_id: 'case',
        admin_channel_id: null,
        verification_channel_id: null,
        admin_notification_role_id: null,
        heuristic_message_threshold: 5,
        heuristic_message_timeframe_seconds: 60,
        heuristic_suspicious_keywords: [],
        created_at: null,
        updated_at: null,
        updated_by: null,
        settings: {},
        is_active: true,
      },
    ],
  });
  mocks.guild.mockResolvedValue({ id: 'guild', owner_id: 'owner' });
  mocks.bot.mockResolvedValue({ id: 'bot' });
  mocks.roles.mockResolvedValue([
    { id: 'guild', name: '@everyone', permissions: '0', position: 0, managed: false },
    {
      id: 'bot-role',
      name: 'bot',
      permissions: '8',
      position: 10,
      managed: true,
      tags: { bot_id: 'bot' },
    },
  ]);
  mocks.channels.mockResolvedValue([
    { id: 'category', name: 'category', type: 4, permission_overwrites: [] },
    { id: 'child', name: 'child', type: 0, parent_id: 'category', permission_overwrites: [] },
  ]);
  mocks.member.mockResolvedValue({ roles: ['bot-role'] });
});
test('refreshes category children, bot hierarchy and bot-managed role facts from REST', async () => {
  const facts = await readWebRestrictionFacts('guild', []);
  expect(facts.channels.find((c) => c.id === 'child')).toMatchObject({
    parentId: 'category',
    permissionsLocked: true,
    metadataAvailable: true,
  });
  expect(facts.roles.find((r) => r.id === 'bot-role')?.botManaged).toBe(true);
  expect(facts.botHighestPosition).toBe(10);
  expect(mocks.channel).not.toHaveBeenCalled();
});
test('missing overwrite evidence stays unavailable and foreign guild identity rejects admission', async () => {
  mocks.channels.mockResolvedValue([{ id: 'child', name: 'child', type: 0 }]);
  expect((await readWebRestrictionFacts('guild', [])).channels[0].metadataAvailable).toBe(false);
  mocks.guild.mockResolvedValue({ id: 'foreign', owner_id: 'owner' });
  await expect(readWebRestrictionFacts('guild', [])).rejects.toThrow('binding_mismatch');
});
