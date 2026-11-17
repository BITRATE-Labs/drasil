import 'reflect-metadata';
import { Collection, type Guild, type Message, type User } from 'discord.js';
import { mock } from 'jest-mock-extended';
import type { IConfigService } from '../../config/ConfigService';
import type { IServerMemberRepository } from '../../repositories/ServerMemberRepository';
import {
  WelcomeMessageRepository,
  type WelcomeCandidate,
} from '../../repositories/WelcomeMessageRepository';
import {
  WelcomeMessageCleanupService,
  welcomeImageUrls,
  welcomeNameMatches,
} from '../../services/WelcomeMessageCleanupService';
import type { IGPTService } from '../../services/GPTService';
import type { Server } from '../../repositories/types';

const joined = new Date('2026-11-16T12:00:00Z');
const snapshots = {
  target: { names: ['new_member_42', 'Friendly person'], joinedAt: joined.toISOString() },
};
function setup() {
  const config = mock<IConfigService>();
  const repository = mock<WelcomeMessageRepository>();
  const members = mock<IServerMemberRepository>();
  const gpt = mock<IGPTService>();
  const settings = {
    welcome_cleanup_enabled: true,
    welcome_cleanup_bot_id: 'bot',
    welcome_cleanup_channel_id: 'welcome',
  };
  config.getServerConfig.mockResolvedValue({ settings } as Server);
  const fetchMessage = jest.fn();
  const cache = new Collection();
  const channel = { id: 'welcome', isTextBased: () => true, messages: { fetch: fetchMessage } };
  const guild = {
    id: 'guild',
    channels: { fetch: jest.fn().mockResolvedValue(channel) },
    members: { cache },
  } as unknown as Guild;
  const user = { id: 'target' } as User;
  const message = {
    id: 'message',
    guild,
    channelId: 'welcome',
    author: { id: 'bot', bot: true },
    createdTimestamp: joined.getTime() + 1000,
    createdAt: new Date(joined.getTime() + 1000),
    attachments: new Collection([
      [
        'image',
        { url: 'https://cdn.discordapp.com/attachments/1/2/welcome.png', contentType: 'image/png' },
      ],
    ]),
    embeds: [],
    mentions: { users: new Collection() },
    delete: jest.fn().mockResolvedValue(undefined),
  } as unknown as Message;
  const candidate: WelcomeCandidate = {
    server_id: 'guild',
    message_id: 'message',
    channel_id: 'welcome',
    bot_id: 'bot',
    created_at: message.createdAt,
    member_snapshots: structuredClone(snapshots),
  };
  repository.findForBan.mockResolvedValue([candidate]);
  fetchMessage.mockResolvedValue(message);
  gpt.extractWelcomeRecipient.mockResolvedValue({
    is_welcome: true,
    recipient_name: 'NEW_MEMBER_42',
    confidence: 0.99,
  });
  const service = new WelcomeMessageCleanupService(config, repository, members, gpt);
  return {
    config,
    repository,
    members,
    gpt,
    settings,
    guild,
    user,
    message,
    candidate,
    service,
    cache,
    fetchMessage,
  };
}

describe('welcome cleanup', () => {
  it('collects only the configured source and snapshots contemporaneous joins without model work', async () => {
    const f = setup();
    f.cache.set('target', {
      id: 'target',
      user: { username: 'new_member_42', globalName: 'Friendly person', bot: false },
      nickname: null,
      joinedTimestamp: joined.getTime(),
    });
    f.cache.set('old', {
      id: 'old',
      user: { username: 'old', bot: false },
      joinedTimestamp: joined.getTime() - 120001,
    });
    await f.service.collect(f.message);
    expect(f.repository.collect).toHaveBeenCalledWith(
      expect.objectContaining({ member_snapshots: snapshots })
    );
    expect(f.gpt.extractWelcomeRecipient).not.toHaveBeenCalled();
    await f.service.collect({ ...f.message, channelId: 'elsewhere' } as Message);
    await f.service.collect({ ...f.message, author: { id: 'other', bot: true } } as Message);
    await f.service.collect({
      ...f.message,
      attachments: new Collection(),
      mentions: { users: new Collection([['target', f.user]]) },
    } as Message);
    expect(f.repository.collect).toHaveBeenCalledTimes(1);
  });

  it('defaults to enabled but does nothing until both sources are selected', async () => {
    const f = setup();
    delete (f.settings as Partial<typeof f.settings>).welcome_cleanup_enabled;
    await f.service.cleanupAfterBan(f.guild, f.user);
    expect(f.message.delete).toHaveBeenCalledTimes(1);
    delete (f.settings as Partial<typeof f.settings>).welcome_cleanup_bot_id;
    await f.service.collect(f.message);
    await f.service.cleanupAfterBan(f.guild, f.user);
    expect(f.repository.collect).not.toHaveBeenCalled();
    expect(f.message.delete).toHaveBeenCalledTimes(1);
  });

  it('does not collect or analyze when disabled', async () => {
    const f = setup();
    f.settings.welcome_cleanup_enabled = false;
    await f.service.collect(f.message);
    await f.service.cleanupAfterBan(f.guild, f.user);
    expect(f.repository.collect).not.toHaveBeenCalled();
    expect(f.gpt.extractWelcomeRecipient).not.toHaveBeenCalled();
  });

  it('deletes an exclusive exact mention without a model call', async () => {
    const f = setup();
    f.message.mentions.users.set('target', f.user);
    await f.service.cleanupAfterBan(f.guild, f.user);
    expect(f.gpt.extractWelcomeRecipient).not.toHaveBeenCalled();
    expect(f.message.delete).toHaveBeenCalledTimes(1);
    expect(f.repository.remove).toHaveBeenCalledWith('guild', 'message');
  });

  it('verifies a welcome image against the saved join-time name', async () => {
    const f = setup();
    await f.service.cleanupAfterBan(f.guild, f.user);
    expect(f.gpt.extractWelcomeRecipient).toHaveBeenCalledTimes(1);
    expect(f.message.delete).toHaveBeenCalledTimes(1);
  });

  it.each([
    'not-welcome',
    'low-confidence',
    'wrong-name',
    'ambiguous',
    'missing-snapshot',
    'provider-failure',
    'other-mentioned',
  ])('keeps %s matches', async (kind) => {
    const f = setup();
    if (kind === 'not-welcome')
      f.gpt.extractWelcomeRecipient.mockResolvedValue({
        is_welcome: false,
        recipient_name: 'new_member_42',
        confidence: 1,
      });
    if (kind === 'low-confidence')
      f.gpt.extractWelcomeRecipient.mockResolvedValue({
        is_welcome: true,
        recipient_name: 'new_member_42',
        confidence: 0.7,
      });
    if (kind === 'wrong-name')
      f.gpt.extractWelcomeRecipient.mockResolvedValue({
        is_welcome: true,
        recipient_name: 'someone else',
        confidence: 1,
      });
    if (kind === 'ambiguous')
      f.candidate.member_snapshots.other = {
        names: ['NEW_MEMBER_42'],
        joinedAt: joined.toISOString(),
      };
    if (kind === 'missing-snapshot') f.candidate.member_snapshots = {};
    if (kind === 'provider-failure') f.gpt.extractWelcomeRecipient.mockResolvedValue(null);
    if (kind === 'other-mentioned') f.message.mentions.users.set('other', { id: 'other' } as User);
    await f.service.cleanupAfterBan(f.guild, f.user);
    expect(f.message.delete).not.toHaveBeenCalled();
  });

  it('rechecks author and current configuration before deleting', async () => {
    const f = setup();
    f.fetchMessage.mockResolvedValueOnce({ ...f.message, author: { id: 'other', bot: true } });
    await f.service.cleanupAfterBan(f.guild, f.user);
    expect(f.gpt.extractWelcomeRecipient).not.toHaveBeenCalled();
    f.gpt.extractWelcomeRecipient.mockImplementation(async () => {
      f.settings.welcome_cleanup_enabled = false;
      return { is_welcome: true, recipient_name: 'new_member_42', confidence: 1 };
    });
    await f.service.cleanupAfterBan(f.guild, f.user);
    expect(f.message.delete).not.toHaveBeenCalled();
  });

  it('forgets already-deleted messages and contains provider and deletion errors', async () => {
    const f = setup();
    f.fetchMessage.mockRejectedValueOnce({ code: 10008 });
    await expect(f.service.cleanupAfterBan(f.guild, f.user)).resolves.toBeUndefined();
    expect(f.repository.remove).toHaveBeenCalledWith('guild', 'message');
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    (f.message.delete as jest.Mock).mockRejectedValueOnce(new Error('Missing permissions'));
    await expect(f.service.cleanupAfterBan(f.guild, f.user)).resolves.toBeUndefined();
    f.repository.findForBan.mockRejectedValueOnce(new Error('Database unavailable'));
    await expect(f.service.cleanupAfterBan(f.guild, f.user)).resolves.toBeUndefined();
  });

  it('keeps edited messages and respects paused server configuration', async () => {
    const f = setup();
    f.fetchMessage
      .mockResolvedValueOnce(f.message)
      .mockResolvedValueOnce({ ...f.message, editedTimestamp: Date.now() });
    await f.service.cleanupAfterBan(f.guild, f.user);
    expect(f.message.delete).not.toHaveBeenCalled();
    f.config.getServerConfig.mockResolvedValue({
      settings: f.settings,
      is_active: false,
    } as Server);
    await f.service.collect(f.message);
    await f.service.cleanupAfterBan(f.guild, f.user);
    expect(f.repository.collect).not.toHaveBeenCalled();
    expect(f.message.delete).not.toHaveBeenCalled();
  });

  it('shares concurrent cleanup for the same ban', async () => {
    const f = setup();
    await Promise.all([
      f.service.cleanupAfterBan(f.guild, f.user),
      f.service.cleanupAfterBan(f.guild, f.user),
    ]);
    expect(f.gpt.extractWelcomeRecipient).toHaveBeenCalledTimes(1);
    expect(f.message.delete).toHaveBeenCalledTimes(1);
  });

  it('uses only Discord-hosted current images, including proxied embed cards', () => {
    const f = setup();
    const message = {
      ...f.message,
      embeds: [
        {
          image: {
            url: 'https://untrusted.test/card',
            proxyURL:
              'https://images-ext-1.discordapp.net/external/hash/https/example.com/card.png',
          },
        },
        { image: { url: 'https://untrusted.test/secret' } },
      ],
    } as Message;
    expect(welcomeImageUrls(message)).toEqual([
      'https://cdn.discordapp.com/attachments/1/2/welcome.png',
      'https://images-ext-1.discordapp.net/external/hash/https/example.com/card.png',
    ]);
    expect(welcomeNameMatches('new_member', 'target', snapshots)).toBe(false);
  });
});
