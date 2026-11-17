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
import { MESSAGE_CONTEXT_RETENTION_DAYS } from '../repositories/MessageContextRepository';
import type { IGPTService } from './GPTService';

export const WELCOME_MAX_IMAGE_CHECKS = 3;
export const WELCOME_SNAPSHOT_LIMIT = 50;
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
  private readonly guildRuns = new Map<string, Promise<void>>();
  constructor(
    @inject(TYPES.ConfigService) private readonly config: IConfigService,
    @inject(TYPES.WelcomeMessageRepository) private readonly repository: WelcomeMessageRepository,
    @inject(TYPES.ServerMemberRepository) private readonly members: IServerMemberRepository,
    @inject(TYPES.GPTService) private readonly gpt: IGPTService
  ) {}

  async collect(message: Message): Promise<void> {
    if (!message.guild || !message.author.bot || !welcomeImageUrls(message).length) return;
    if (message.author.id === message.guild.members.me?.id) return;
    const cached = this.config.getCachedServerConfig(message.guild.id);
    if (
      cached &&
      (cached.settings.welcome_cleanup_enabled === false ||
        cached.settings.welcome_cleanup_bot_id !== message.author.id ||
        cached.settings.welcome_cleanup_channel_id !== message.channelId)
    )
      return;
    const { settings, is_active } = cached ?? (await this.config.getServerConfig(message.guild.id));
    if (
      is_active === false ||
      settings.welcome_cleanup_enabled === false ||
      settings.welcome_cleanup_bot_id !== message.author.id ||
      settings.welcome_cleanup_channel_id !== message.channelId
    )
      return;
    if (welcomeImageUrls(message).length === 0) return;
    const snapshots: Record<string, WelcomeMemberSnapshot> = {};
    let snapshotsComplete = message.guild.members.cache.size === message.guild.memberCount;
    let snapshotCount = 0;
    for (const member of message.guild.members.cache.values()) {
      if (member.user.bot || member.joinedTimestamp === null) continue;
      const age = message.createdTimestamp - member.joinedTimestamp;
      if (age < 0 || age > WELCOME_JOIN_WINDOW_MS) continue;
      if (snapshotCount >= WELCOME_SNAPSHOT_LIMIT) {
        snapshotsComplete = false;
        break;
      }
      snapshotCount++;
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
      snapshots_complete: snapshotsComplete,
      verification_attempted: false,
      recipient_id: null,
      verified_edited_at: null,
      expires_at: new Date(
        message.createdTimestamp +
          Math.max(0, settings.message_retention_days ?? MESSAGE_CONTEXT_RETENTION_DAYS) *
            24 *
            60 *
            60 *
            1000
      ),
    });
  }

  cleanupAfterBan(guild: Guild, user: User): Promise<void> {
    const key = `${guild.id}:${user.id}`;
    const existing = this.running.get(key);
    if (existing) return existing;
    const previous = this.guildRuns.get(guild.id) ?? Promise.resolve();
    const run = previous
      .then(() => this.cleanup(guild, user))
      .catch((error: unknown) => {
        console.warn(
          `Welcome cleanup failed for banned member ${user.id} in guild ${guild.id}:`,
          error
        );
      })
      .finally(() => {
        this.running.delete(key);
        if (this.guildRuns.get(guild.id) === run) this.guildRuns.delete(guild.id);
      });
    this.running.set(key, run);
    this.guildRuns.set(guild.id, run);
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
    let imageChecks = 0;
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
        let recipientId: string | null = null;
        const editedAt = message.editedAt ?? null;
        const cachedVerdict =
          candidate.verification_attempted &&
          (candidate.verified_edited_at?.getTime() ?? null) === (message.editedTimestamp ?? null);
        const welcomeText = [
          message.content,
          ...message.embeds.flatMap((embed) => [embed.title, embed.description]),
        ].join(' ');
        if (cachedVerdict) recipientId = candidate.recipient_id;
        else if (
          mentions.length === 1 &&
          new RegExp(
            `(?:\\bwelcome[\\s,!:-]*<@!?${mentions[0]}>|<@!?${mentions[0]}>[\\s,!:-]*welcome\\b)`,
            'iu'
          ).test(welcomeText)
        )
          recipientId = mentions[0];
        else if (mentions.length <= 1 && candidate.snapshots_complete) {
          const urls = welcomeImageUrls(message);
          if (!urls.length) continue;
          if (imageChecks >= WELCOME_MAX_IMAGE_CHECKS) return;
          imageChecks++;
          const recipient = await this.gpt.extractWelcomeRecipient(urls);
          // A failed provider read is not a negative verdict. End this run without caching it.
          if (recipient === null) return;
          if (recipient.is_welcome && recipient.confidence >= MIN_WELCOME_CONFIDENCE) {
            if (recipient.recipient_name) {
              const name = recipient.recipient_name;
              const matchedId =
                Object.keys(candidate.member_snapshots).find((id) =>
                  welcomeNameMatches(name, id, candidate.member_snapshots)
                ) ?? null;
              if (!mentions.length || matchedId === mentions[0]) recipientId = matchedId;
            }
          }
        }
        await this.repository.recordRecipient(guild.id, message.id, recipientId, editedAt);
        if (recipientId !== user.id) continue;
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
        return;
      } catch (error) {
        if ((error as { code?: number } | null)?.code === 10008)
          await this.repository.remove(guild.id, candidate.message_id);
        else console.warn(`Could not clean up welcome message ${candidate.message_id}:`, error);
      }
    }
  }
}
