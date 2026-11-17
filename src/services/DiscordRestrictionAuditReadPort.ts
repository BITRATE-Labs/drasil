import { restrictionRoleFact } from '../utils/restrictionRoleFact';
import type {
  RestrictionCaseFact,
  RestrictionChannelFact,
  RestrictionFacts,
  RestrictionThreadFact,
} from '@drasil/application';
import {
  ChannelType,
  Client,
  Guild,
  OverwriteType,
  ThreadChannel,
  Routes,
  type RESTGetAPIGuildChannelsResult,
} from 'discord.js';
import { IConfigService } from '../config/ConfigService';
import { PrismaClient } from '../db/prisma';
import { CaseKind, VerificationStatus } from '../repositories/types';
import { getCaseRoleLockdownSettings } from '../utils/caseRoleLockdownSettings';
import { getManualIntakeSettings } from '../utils/manualIntakeSettings';
import { getRoleQuarantineSettings } from '../utils/roleQuarantineSettings';
import type { RestrictionAuditReadPort, RestrictionPage } from './RestrictionAuditService';

function threadFact(thread: ThreadChannel): RestrictionThreadFact {
  if (!thread.parentId) throw new Error('Thread parent metadata unavailable');
  return {
    id: thread.id,
    parentId: thread.parentId,
    private: thread.type === ChannelType.PrivateThread,
    archived: thread.archived ?? false,
    locked: thread.locked ?? false,
    memberIds: [],
    metadataAvailable: true,
  };
}

/** Discord and database metadata only. All reads are scoped to the requested guild. */
export class DiscordRestrictionAuditReadPort implements RestrictionAuditReadPort {
  public constructor(
    private readonly client: Client,
    private readonly config: Pick<IConfigService, 'getServerConfig'>,
    private readonly prisma: PrismaClient
  ) {}
  private async guild(guildId: string): Promise<Guild> {
    return this.client.guilds.fetch(guildId);
  }

  public async readBase(guildId: string): Promise<RestrictionFacts> {
    const guild = await this.client.guilds.fetch({ guild: guildId, force: true });
    const settings = await this.config.getServerConfig(guildId);
    const [roles, channels] = await Promise.all([guild.roles.fetch(), guild.channels.fetch()]);
    // Discord.js retains cached overwrites when the raw response omits them.
    const rawChannels = (await this.client.rest.get(
      Routes.guildChannels(guildId)
    )) as RESTGetAPIGuildChannelsResult;
    const bot = await guild.members.fetchMe().catch(() => null);
    const lockdown = getCaseRoleLockdownSettings(settings.settings);
    const quarantine = getRoleQuarantineSettings(settings.settings);
    const channelFacts: RestrictionChannelFact[] = [];
    const types = new Map<number, RestrictionChannelFact['type']>([
      [ChannelType.GuildText, 'text'],
      [ChannelType.GuildAnnouncement, 'text'],
      [ChannelType.GuildVoice, 'voice'],
      [ChannelType.GuildStageVoice, 'stage'],
      [ChannelType.GuildForum, 'forum'],
      [ChannelType.GuildMedia, 'media'],
      [ChannelType.GuildCategory, 'category'],
    ]);
    for (const channel of channels.values()) {
      if (!channel || channel.isThread()) continue;
      const type = types.get(channel.type);
      if (!type || !('permissionOverwrites' in channel)) continue;
      const raw = rawChannels.find((item) => item.id === channel.id);
      const overwrites =
        raw && 'permission_overwrites' in raw && Array.isArray(raw.permission_overwrites)
          ? raw.permission_overwrites
          : null;
      const parentId = raw && 'parent_id' in raw ? (raw.parent_id ?? null) : null;
      const parent = rawChannels.find((item) => item.id === parentId);
      const parentOverwrites =
        parent && 'permission_overwrites' in parent && Array.isArray(parent.permission_overwrites)
          ? parent.permission_overwrites
          : null;
      const overwriteKey = (entries: NonNullable<typeof overwrites>): string =>
        JSON.stringify(
          entries
            .map((entry) => [entry.id, entry.type, entry.allow, entry.deny])
            .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
        );
      channelFacts.push({
        id: channel.id,
        name: channel.name,
        type,
        parentId,
        permissionsLocked:
          overwrites !== null &&
          parentOverwrites !== null &&
          overwriteKey(overwrites) === overwriteKey(parentOverwrites),
        overwrites: (overwrites ?? []).map((o) => ({
          id: o.id,
          type: o.type === OverwriteType.Member ? 'member' : 'role',
          allow: o.allow,
          deny: o.deny,
        })),
        metadataAvailable: overwrites !== null && (parentId === null || parentOverwrites !== null),
      });
    }
    return {
      guildId,
      caseRoleId: settings.case_role_id,
      quarantineMode: quarantine.mode,
      exemptRoleIds: [...quarantine.exemptRoleIds],
      manualIntakeRoleId: getManualIntakeSettings(settings.settings).roleId,
      botHighestPosition: bot?.roles.highest.position ?? null,
      roles: [...roles.values()].map((role) => restrictionRoleFact(role, bot)),
      observedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      channels: channelFacts,
      channelsComplete: true,
      cases: [],
      casesComplete: false,
      threads: [],
      threadsComplete: false,
      exceptionChannelIds: [
        ...new Set([
          ...lockdown.allowedChannelIds,
          ...channelFacts
            .filter((c) => c.parentId && lockdown.allowedCategoryIds.includes(c.parentId))
            .map((c) => c.id),
        ]),
      ],
      recoveryParentId: settings.verification_channel_id,
      knownParentContentExposure: false,
    };
  }

  public async readCases(
    guildId: string,
    cursor: string | null,
    limit: number
  ): Promise<RestrictionPage<RestrictionCaseFact>> {
    const rows = await this.prisma.verification_events.findMany({
      where: { server_id: guildId, status: VerificationStatus.PENDING, user_id: { not: null } },
      orderBy: { id: 'asc' },
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      take: limit,
    });
    return {
      items: rows.map((row) => {
        if (!row.user_id) throw new Error('Case member binding unavailable');
        return {
          caseId: row.id,
          caseRoleId: row.quarantine_case_role_id,
          caseRevision: String(row.case_revision),
          userId: row.user_id,
          purpose:
            row.case_kind === CaseKind.COMPROMISED_ACCOUNT
              ? 'compromised_account'
              : 'standard_case',
          roleIds: [],
          owner: false,
          metadataAvailable: false,
          threadId: row.thread_id,
        };
      }),
      next: rows.length === limit ? rows[rows.length - 1].id : null,
    };
  }

  public async readMember(
    guildId: string,
    item: RestrictionCaseFact
  ): Promise<RestrictionCaseFact> {
    const guild = await this.guild(guildId);
    const member = await guild.members.fetch({ user: item.userId, force: true });
    return {
      ...item,
      roleIds: [...member.roles.cache.keys()],
      owner: member.id === guild.ownerId,
      metadataAvailable: true,
    };
  }

  public async readThreads(
    guildId: string,
    cursor: string | null,
    limit: number
  ): Promise<RestrictionPage<RestrictionThreadFact>> {
    const guild = await this.guild(guildId);
    if (!cursor) {
      const active = await guild.channels.fetchActiveThreads();
      return {
        items: [...active.threads.values()].map(threadFact),
        next: JSON.stringify({ index: 0, type: 'public', before: null }),
      };
    }
    const state = JSON.parse(cursor) as {
      index: number;
      type: 'public' | 'private';
      before: string | null;
    };
    const parents = [...guild.channels.cache.values()]
      .filter((c) => !c.isThread() && 'threads' in c)
      .sort((a, b) => a.id.localeCompare(b.id));
    if (state.index >= parents.length) return { items: [], next: null };
    const parent = parents[state.index];
    const page = await parent.threads.fetchArchived(
      {
        type: state.type,
        ...(state.type === 'private' ? { fetchAll: true } : {}),
        limit,
        ...(state.before ? { before: new Date(state.before) } : {}),
      },
      false
    );
    const items = [...page.threads.values()];
    const timestamp = items.length ? items[items.length - 1].archiveTimestamp : null;
    if (page.hasMore && timestamp === null) throw new Error('Archived thread cursor unavailable');
    const next =
      page.hasMore && timestamp !== null
        ? { ...state, before: new Date(timestamp).toISOString() }
        : state.type === 'public' && parent.type === ChannelType.GuildText
          ? { ...state, type: 'private', before: null }
          : { index: state.index + 1, type: 'public', before: null };
    return {
      items: items.map(threadFact),
      next: next.index >= parents.length ? null : JSON.stringify(next),
    };
  }

  public async readThreadMembers(
    guildId: string,
    threadId: string,
    cursor: string | null,
    limit: number
  ): Promise<RestrictionPage<string>> {
    const guild = await this.guild(guildId);
    const thread = await guild.channels.fetch(threadId, { force: true });
    if (!thread?.isThread()) throw new Error('Thread unavailable in this guild');
    const members = await thread.members.fetch({
      limit,
      ...(cursor ? { after: cursor } : {}),
      withMember: true,
      cache: false,
    });
    const ids = [...members.keys()];
    return { items: ids, next: ids.length === limit ? ids[ids.length - 1] : null };
  }
}
