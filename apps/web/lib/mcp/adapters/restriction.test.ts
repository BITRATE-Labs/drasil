import { beforeEach, expect, test, vi } from 'vitest';
import { fixtureRestrictionAudit } from '../../restrictionAuditFixtures';
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
const serverRecord = {
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
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.query.mockResolvedValue({ rows: [serverRecord] });
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

function selectedCase() {
  const fix = fixtureRestrictionAudit('guild').fixes.find((f) => f.id === 'member')!;
  const effect = fix.effects[0];
  if (effect.kind !== 'quarantine_case_roles') throw new Error('Expected member fixture');
  mocks.query
    .mockResolvedValueOnce({
      rows: [
        {
          ...serverRecord,
        },
      ],
    })
    .mockResolvedValueOnce({
      rows: [
        {
          id: effect.caseId,
          user_id: effect.memberId,
          case_revision: 4,
          case_kind: 'compromised_account',
          thread_id: 'thread',
          quarantine_case_role_id: 'original-case',
          quarantine_attempt_id: null,
          repair_snapshot: null,
          departed: false,
        },
      ],
    });
  mocks.member.mockImplementation(async (_guild, user) =>
    user === 'bot'
      ? { roles: ['bot-role'] }
      : { roles: ['case', 'community'], joined_at: '2026-11-01T00:00:00.000Z' }
  );
  mocks.channel.mockResolvedValue({
    id: 'thread',
    guild_id: 'guild',
    parent_id: 'child',
    type: 12,
    thread_metadata: { archived: true, locked: true },
  });
  mocks.members.mockResolvedValue([{ user_id: effect.memberId }]);
  return fix;
}
test('selected actual case refresh binds persisted role, revision, join and private archived membership', async () => {
  const fix = selectedCase();
  const facts = await readWebRestrictionFacts('guild', [fix]);
  expect(facts.cases[0]).toMatchObject({
    caseRoleId: 'original-case',
    caseRevision: '4',
    joinedAt: '2026-11-01T00:00:00.000Z',
    purpose: 'compromised_account',
    roleIds: ['guild', 'case', 'community'],
  });
  expect(facts.threads[0]).toMatchObject({
    id: 'thread',
    private: true,
    archived: true,
    locked: true,
    memberIds: [facts.cases[0].userId],
  });
  expect(mocks.query).toHaveBeenLastCalledWith(
    expect.stringContaining("server_id=$2 and status='pending'"),
    [facts.cases[0].caseId, 'guild']
  );
});
test('missing membership identity refuses selected case admission', async () => {
  const fix = selectedCase();
  mocks.member.mockResolvedValue({ roles: ['bot-role'] });
  await expect(readWebRestrictionFacts('guild', [fix])).rejects.toThrow('metadata_unavailable');
  expect(mocks.channel).not.toHaveBeenCalled();
});
test('foreign thread and failed paginated membership reads refuse admission', async () => {
  let fix = selectedCase();
  mocks.channel.mockResolvedValue({
    id: 'thread',
    guild_id: 'foreign',
    parent_id: 'child',
    type: 12,
    thread_metadata: { archived: false, locked: false },
  });
  await expect(readWebRestrictionFacts('guild', [fix])).rejects.toThrow('metadata_unavailable');
  fix = selectedCase();
  mocks.members.mockRejectedValue(new Error('Restriction thread coverage incomplete.'));
  await expect(readWebRestrictionFacts('guild', [fix])).rejects.toThrow('coverage incomplete');
});

test.each([false, true])(
  'uses only enabled manual intake as effective exemption: %s',
  async (enabled) => {
    mocks.query.mockResolvedValue({
      rows: [
        {
          ...serverRecord,
          settings: { manual_intake_enabled: enabled, manual_intake_role_id: '123456789012345678' },
        },
      ],
    });
    const facts = await readWebRestrictionFacts('guild', []);
    expect(facts.manualIntakeRoleId).toBe(enabled ? '123456789012345678' : null);
  }
);

test('selected-case facts expose bounded ownership blocks without private owner tokens', async () => {
  const fix = selectedCase();
  mocks.query.mockReset();
  mocks.query.mockResolvedValueOnce({ rows: [serverRecord] }).mockResolvedValueOnce({
    rows: [
      {
        id: 'case-id',
        user_id: 'user',
        case_revision: 1,
        case_kind: 'standard',
        thread_id: null,
        quarantine_case_role_id: null,
        quarantine_attempt_id: null,
        departed: false,
        competing_snapshot: true,
        repair_snapshot: {
          status: 'active',
          planned_role_ids: ['community'],
          metadata: {
            restriction_role_owners: {
              community: {
                requestId: 'private-request',
                attemptToken: 'private-token',
                state: 'unknown',
              },
            },
          },
        },
      },
    ],
  });
  const result = await readWebRestrictionFacts('guild', [fix]);
  expect(result.cases[0].repairEligibility).toEqual({
    reason: 'Another case owns an active role snapshot for this member',
    blockedRoles: [
      { roleId: 'community', reason: 'A prior restriction repair owns this role removal' },
    ],
  });
  expect(JSON.stringify(result)).not.toMatch(/private-request|private-token/);
});
