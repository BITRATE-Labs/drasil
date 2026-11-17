import * as setupData from '@/lib/setupDataAdapter';
import { FixtureSetupDataAdapter } from '@/e2e/legacy/setupDataAdapter';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  token: vi.fn(),
  assertCanManageGuild: vi.fn(),
  queue: vi.fn(),
  welcomeMember: vi.fn(),
  welcomeChannel: vi.fn(),
  welcomeSearch: vi.fn(),
  welcomeRoles: vi.fn(),
  welcomeBots: vi.fn(),
}));

vi.mock('@/lib/application/adapters/authority', () => ({
  createWebAuthority: () => ({
    loadFresh: async (guildId: string, userId: string) =>
      userId === 'fixture-admin'
        ? { guildId, userId, present: true, owner: true, permissions: '8', roleIds: [] }
        : null,
  }),
}));

vi.mock('@/lib/discordApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/discordApi')>()),
  fetchDiscordGuildMember: mocks.welcomeMember,
  fetchDiscordChannel: mocks.welcomeChannel,
  searchGuildBots: mocks.welcomeSearch,
  fetchDiscordGuildRoles: mocks.welcomeRoles,
  fetchGuildBots: mocks.welcomeBots,
}));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({
  redirect: (path: string) => {
    throw new Error(path);
  },
}));
vi.mock('@/lib/session', () => ({
  getCurrentAdminSession: mocks.session,
  getCurrentDiscordToken: mocks.token,
}));
vi.mock('@/lib/setupDashboardService', () => ({
  createSetupDashboardService: () => ({ assertCanManageGuild: mocks.assertCanManageGuild }),
}));
vi.mock('@/lib/setupArtifactActionQueue', () => ({
  queueReportInstructionsRepairRequest: mocks.queue,
}));

import {
  saveGuildSetup,
  searchWelcomeBots,
  queueReportInstructionsRepair,
  queueReportInstructionsRepost,
} from './actions';

vi.spyOn(setupData, 'createSetupDataAdapter').mockImplementation(
  () => new FixtureSetupDataAdapter()
);

describe('report panel setup actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.session.mockResolvedValue({ userId: 'admin' });
    mocks.token.mockResolvedValue({ accessToken: 'token' });
    mocks.assertCanManageGuild.mockResolvedValue({ owner: true, permissions: '0' });
    mocks.queue.mockResolvedValue({ id: 'request', status: 'queued' });
  });

  it.each([false, true])('passes explicit repost=%s with the rendered panel ID', async (repost) => {
    const data = new FormData();
    data.set('reportInstructionsChannelId', 'channel');
    data.set('reportInstructionsMessageId', 'old-panel');
    data.set('reportInstructionsExpectedChannelId', 'original-channel');
    data.set('reportInstructionsSubmissionId', 'submission-1');
    await (repost ? queueReportInstructionsRepost : queueReportInstructionsRepair)('guild', data);
    expect(mocks.queue).toHaveBeenCalledWith({
      context: {
        guildId: 'guild',
        source: 'web',
        requestId: 'submission-1',
        actor: { kind: 'user', userId: 'admin' },
      },
      channelId: 'channel',
      repost,
      expectedMessageId: 'old-panel',
      expectedChannelId: 'original-channel',
      submissionId: 'submission-1',
    });
  });

  it('retains administrator authorization for reposts', async () => {
    mocks.assertCanManageGuild.mockResolvedValue({ owner: false, permissions: '0' });
    const data = new FormData();
    data.set('reportInstructionsChannelId', 'channel');
    await expect(queueReportInstructionsRepost('guild', data)).rejects.toThrow('Administrator');
    expect(mocks.queue).not.toHaveBeenCalled();
  });
});

it('saves the actual fixture setup form without live authority requests', async () => {
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('DRASIL_WEB_E2E_FIXTURE_MODE', 'true');
  mocks.session.mockResolvedValue({ userId: 'fixture-admin' });
  mocks.token.mockResolvedValue({ accessToken: 'fixture-token' });
  mocks.assertCanManageGuild.mockResolvedValue({ owner: true, permissions: '32' });
  const fetch = vi.fn(() => {
    throw new Error('Unexpected live Discord request');
  });
  vi.stubGlobal('fetch', fetch);
  const form = new FormData();
  form.set('heuristicMessageThreshold', '17');
  await saveGuildSetup('guild-1', form);
  const { fixtureServerRecord } = await import('@/lib/e2eFixtures');
  expect(fixtureServerRecord().heuristic_message_threshold).toBe(17);
  expect(fixtureServerRecord().updated_by).toBe('fixture-admin');
  expect(fetch).not.toHaveBeenCalled();
});

afterEach(async () => {
  const { resetFixtureServerRecord } = await import('@/lib/e2eFixtures');
  resetFixtureServerRecord();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it.each(['none', 'discord_image', 'turnstile'])(
  'maps the administrator method choice %s',
  async (method) => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('DRASIL_WEB_E2E_FIXTURE_MODE', 'true');
    vi.stubEnv('DRASIL_CAPTCHA_IMAGE_ANSWER_SECRET', Buffer.alloc(32, 1).toString('base64'));
    vi.stubEnv('NEXT_PUBLIC_TURNSTILE_SITE_KEY', 'test-site');
    vi.stubEnv('TURNSTILE_SECRET_KEY', 'test-secret');
    vi.stubEnv('DRASIL_CAPTCHA_BINDING_SECRET', 'test-binding');
    vi.stubEnv('TURNSTILE_EXPECTED_HOSTNAME', 'example.test');
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://example.test');
    mocks.session.mockResolvedValue({ userId: 'fixture-admin' });
    mocks.token.mockResolvedValue({ accessToken: 'fixture-token' });
    const form = new FormData();
    form.set('captchaMethod', method);
    await saveGuildSetup('guild-1', form);
    const { fixtureServerRecord } = await import('@/lib/e2eFixtures');
    expect(fixtureServerRecord().settings.captcha_method).toBe(method);
  }
);

it('rejects a member method selection before saving', async () => {
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('DRASIL_WEB_E2E_FIXTURE_MODE', 'true');
  mocks.session.mockResolvedValue({ userId: 'member' });
  mocks.token.mockResolvedValue({ accessToken: 'fixture-token' });
  const form = new FormData();
  form.set('captchaMethod', 'none');
  await expect(saveGuildSetup('guild-1', form)).rejects.toThrow(/actor_unavailable|Administrator/);
});

it('validates and saves welcome sources from this server', async () => {
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('DRASIL_WEB_E2E_FIXTURE_MODE', 'true');
  mocks.session.mockResolvedValue({ userId: 'fixture-admin' });
  mocks.token.mockResolvedValue({ accessToken: 'token' });
  mocks.assertCanManageGuild.mockResolvedValue({ owner: true, permissions: '8' });
  mocks.welcomeMember.mockResolvedValue({ roles: [], user: { bot: true } });
  mocks.welcomeChannel.mockResolvedValue({ guild_id: 'guild-1', type: 0 });
  const form = new FormData();
  form.set('welcomeCleanupEnabled', 'on');
  form.set('welcomeCleanupBotId', '123456789012345678');
  form.set('welcomeCleanupChannelId', '234567890123456789');
  await saveGuildSetup('guild-1', form);
  const { fixtureServerRecord } = await import('@/lib/e2eFixtures');
  expect(fixtureServerRecord().settings).toMatchObject({
    welcome_cleanup_enabled: true,
    welcome_cleanup_bot_id: '123456789012345678',
    welcome_cleanup_channel_id: '234567890123456789',
  });
  form.set('welcomeCleanupBotId', '123456789012345679');
  mocks.welcomeMember.mockResolvedValue({ roles: [], user: { bot: false } });
  await expect(saveGuildSetup('guild-1', form)).rejects.toThrow('Choose a bot');
  mocks.welcomeMember.mockResolvedValue({ roles: [], user: { bot: true } });
  form.set('welcomeCleanupChannelId', '234567890123456780');
  mocks.welcomeChannel.mockResolvedValue({ guild_id: 'another-server', type: 0 });
  await expect(saveGuildSetup('guild-1', form)).rejects.toThrow('Choose a text channel');
  mocks.welcomeChannel.mockResolvedValue({ guild_id: 'guild-1', type: 15 });
  await expect(saveGuildSetup('guild-1', form)).rejects.toThrow('Choose a text channel');
});

it('saves unrelated settings without revalidating unchanged welcome sources', async () => {
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('DRASIL_WEB_E2E_FIXTURE_MODE', 'true');
  mocks.session.mockResolvedValue({ userId: 'fixture-admin' });
  mocks.token.mockResolvedValue({ accessToken: 'token' });
  mocks.assertCanManageGuild.mockResolvedValue({ owner: true, permissions: '8' });
  mocks.welcomeMember.mockResolvedValue({ roles: [], user: { bot: true } });
  mocks.welcomeChannel.mockResolvedValue({ guild_id: 'guild-1', type: 0 });
  const form = new FormData();
  form.set('welcomeCleanupBotId', '123456789012345678');
  form.set('welcomeCleanupChannelId', '234567890123456789');
  await saveGuildSetup('guild-1', form);
  mocks.welcomeMember.mockClear().mockRejectedValue(new Error('Discord unavailable'));
  mocks.welcomeChannel.mockClear().mockRejectedValue(new Error('Discord unavailable'));
  form.set('heuristicMessageThreshold', '17');
  await saveGuildSetup('guild-1', form);
  expect(mocks.welcomeMember).not.toHaveBeenCalled();
  expect(mocks.welcomeChannel).not.toHaveBeenCalled();
});

it('authenticates bot-name search and returns only safe picker fields', async () => {
  mocks.session.mockResolvedValue(null);
  mocks.token.mockResolvedValue(null);
  await expect(searchWelcomeBots('234567890123456789', 'helper')).rejects.toThrow('Sign in');
  mocks.session.mockResolvedValue({ userId: 'fixture-admin' });
  mocks.token.mockResolvedValue({ accessToken: 'token' });
  mocks.assertCanManageGuild.mockResolvedValue({ owner: true, permissions: '8' });
  mocks.welcomeSearch.mockResolvedValue([
    { id: '123456789012345678', username: 'helper', bot: true, avatar: null },
  ]);
  expect(await searchWelcomeBots('234567890123456789', ' helper ')).toEqual([
    {
      id: '123456789012345678',
      name: 'helper',
      detail: '@helper',
      avatarUrl: expect.stringContaining('cdn.discordapp.com/embed/avatars/'),
    },
  ]);
  expect(mocks.welcomeSearch).toHaveBeenCalledWith('234567890123456789', 'helper');
});

it('loads the known bot list through the authenticated empty-search request', async () => {
  mocks.session.mockResolvedValue({ userId: 'fixture-admin' });
  mocks.token.mockResolvedValue({ accessToken: 'token' });
  mocks.assertCanManageGuild.mockResolvedValue({ owner: true, permissions: '8' });
  mocks.welcomeRoles.mockResolvedValue([]);
  mocks.welcomeBots.mockResolvedValue([
    { id: '123456789012345678', username: 'known-bot', bot: true, avatar: null },
  ]);
  const bots = await searchWelcomeBots('234567890123456789', '');
  expect(bots[0].name).toBe('known-bot');
  expect(mocks.welcomeRoles).toHaveBeenCalledWith('234567890123456789');
  expect(mocks.welcomeBots).toHaveBeenCalledWith('234567890123456789', []);
});
