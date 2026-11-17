import { inject, injectable } from 'inversify';
import { Guild, Message, User } from 'discord.js';
import type { IConfigService } from '../config/ConfigService';
import { TYPES } from '../di/symbols';
import {
  WelcomeMessageRepository,
  WELCOME_JOIN_WINDOW_MS,
  type WelcomeMemberSnapshot,
} from '../repositories/WelcomeMessageRepository';
import type { IServerMemberRepository } from '../repositories/ServerMemberRepository';
import type { IGPTService } from './GPTService';

const MIN_WELCOME_CONFIDENCE = 0.98;
function normalizeName(name: string): string {
  return name.normalize('NFKC').trim().replace(/^@/, '').toLowerCase();
}
function discordImageUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === 'https:' &&
      !parsed.username &&
      !parsed.password &&
      !parsed.port &&
      ((['cdn.discordapp.com', 'media.discordapp.net'].includes(parsed.hostname) &&
        parsed.pathname.startsWith('/attachments/')) ||
        ((parsed.hostname === 'media.discordapp.net' ||
          /^images-ext-\d+\.discordapp\.net$/.test(parsed.hostname)) &&
          parsed.pathname.startsWith('/external/')))
    );
  } catch {
    return false;
  }
}
export function welcomeImageUrls(message: Message): string[] {
  return [...message.attachments.values()]
    .filter((a) => a.contentType?.startsWith('image/'))
    .map((a) => a.url)
    .concat(message.embeds.flatMap((e) => (e.image ? [e.image.proxyURL ?? e.image.url] : [])))
    .filter(discordImageUrl);
}
export function welcomeNameMatches(
  name: string,
  userId: string,
  snapshots: Partial<Record<string, WelcomeMemberSnapshot>>
): boolean {
  const normalized = normalizeName(name);
  if (!normalized || !snapshots[userId]?.names.some((n) => normalizeName(n) === normalized))
    return false;
  return !Object.entries(snapshots).some(
    ([id, snapshot]) =>
      id !== userId && snapshot?.names.some((n) => normalizeName(n) === normalized)
  );
}

@injectable()
export class WelcomeMessageCleanupService {
  private readonly running = new Map<string, Promise<void>>();
  constructor(
    @inject(TYPES.ConfigService) private readonly config: IConfigService,
    @inject(TYPES.WelcomeMessageRepository) private readonly repository: WelcomeMessageRepository,
    @inject(TYPES.ServerMemberRepository) private readonly members: IServerMemberRepository,
    @inject(TYPES.GPTService) private readonly gpt: IGPTService
  ) {}

  async collect(message: Message): Promise<void> {
    if (!message.guild || !message.author.bot) return;
    const { settings, is_active } = await this.config.getServerConfig(message.guild.id);
    if (
      is_active === false ||
      settings.welcome_cleanup_enabled === false ||
      settings.welcome_cleanup_bot_id !== message.author.id ||
      settings.welcome_cleanup_channel_id !== message.channelId
    )
      return;
    if (welcomeImageUrls(message).length === 0 && message.mentions.users.size === 0) return;
    const snapshots: Record<string, WelcomeMemberSnapshot> = {};
    for (const member of message.guild.members.cache.values()) {
      if (member.user.bot || member.joinedTimestamp === null) continue;
      const age = message.createdTimestamp - member.joinedTimestamp;
      if (age < 0 || age > WELCOME_JOIN_WINDOW_MS) continue;
      snapshots[member.id] = {
        names: [
          ...new Set(
            [member.user.username, member.user.globalName, member.nickname].filter(
              (name): name is string => Boolean(name)
            )
          ),
        ],
        joinedAt: new Date(member.joinedTimestamp).toISOString(),
      };
    }
    await this.repository.collect({
      server_id: message.guild.id,
      message_id: message.id,
      channel_id: message.channelId,
      bot_id: message.author.id,
      created_at: message.createdAt,
      member_snapshots: snapshots,
    });
  }

  cleanupAfterBan(guild: Guild, user: User): Promise<void> {
    const key = `${guild.id}:${user.id}`;
    const existing = this.running.get(key);
    if (existing) return existing;
    const run = this.cleanup(guild, user)
      .catch((error: unknown) => {
        console.warn(
          `Welcome cleanup failed for banned member ${user.id} in guild ${guild.id}:`,
          error
        );
      })
      .finally(() => {
        this.running.delete(key);
      });
    this.running.set(key, run);
    return run;
  }

  private async cleanup(guild: Guild, user: User): Promise<void> {
    const { settings, is_active } = await this.config.getServerConfig(guild.id, {
      forceRefresh: true,
      failOnReadError: true,
    });
    if (
      is_active === false ||
      settings.welcome_cleanup_enabled === false ||
      !settings.welcome_cleanup_channel_id ||
      !settings.welcome_cleanup_bot_id
    )
      return;
    const channel = await guild.channels.fetch(settings.welcome_cleanup_channel_id);
    if (!channel?.isTextBased() || !('messages' in channel)) return;
    const member = await this.members.findByServerAndUser(guild.id, user.id);
    const candidates = await this.repository.findForBan(
      guild.id,
      user.id,
      channel.id,
      settings.welcome_cleanup_bot_id,
      member?.join_date ?? null
    );
    for (const candidate of candidates) {
      try {
        const message = await channel.messages.fetch({
          message: candidate.message_id,
          force: true,
          cache: false,
        });
        if (
          !message.author.bot ||
          message.author.id !== settings.welcome_cleanup_bot_id ||
          message.channelId !== channel.id
        )
          continue;
        const mentions = [...message.mentions.users.keys()];
        let confirmed = mentions.length === 1 && mentions[0] === user.id;
        if (!confirmed && mentions.length === 0) {
          const urls = welcomeImageUrls(message);
          if (!urls.length) continue;
          // shortcut: missing join snapshots leave image-only cards untouched; add persisted join snapshots if missed coverage matters.
          if (!candidate.member_snapshots[user.id]) continue;
          const recipient = await this.gpt.extractWelcomeRecipient(urls);
          confirmed =
            recipient?.is_welcome === true &&
            recipient.confidence >= MIN_WELCOME_CONFIDENCE &&
            recipient.recipient_name !== null &&
            welcomeNameMatches(recipient.recipient_name, user.id, candidate.member_snapshots);
        }
        if (!confirmed) continue;
        const current = await this.config.getServerConfig(guild.id, {
          forceRefresh: true,
          failOnReadError: true,
        });
        if (
          current.is_active === false ||
          current.settings.welcome_cleanup_enabled === false ||
          current.settings.welcome_cleanup_channel_id !== channel.id ||
          current.settings.welcome_cleanup_bot_id !== message.author.id
        )
          return;
        const fresh = await channel.messages.fetch({
          message: message.id,
          force: true,
          cache: false,
        });
        if (
          fresh.editedTimestamp !== message.editedTimestamp ||
          fresh.author.id !== message.author.id
        )
          continue;
        await fresh.delete();
        await this.repository.remove(guild.id, message.id);
      } catch (error) {
        if ((error as { code?: number } | null)?.code === 10008)
          await this.repository.remove(guild.id, candidate.message_id);
        else console.warn(`Could not clean up welcome message ${candidate.message_id}:`, error);
      }
    }
  }
}
