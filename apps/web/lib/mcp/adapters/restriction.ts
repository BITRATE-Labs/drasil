import {
  type RestrictionFacts,
  type RestrictionFix,
  type RestrictionChannelFact,
  type RestrictionPlanDependencies,
  parseSetupStoredRecord,
  restrictionRepairEligibility,
} from '@drasil/application';
import { createRestrictionStores } from '@drasil/application/postgres';
import {
  fetchDiscordBotUser,
  fetchDiscordGuild,
  fetchDiscordGuildMember,
  fetchDiscordGuildRoles,
  fetchDiscordGuildChannels,
  fetchDiscordChannel,
  fetchDiscordThreadMembers,
} from '../../discordApi';
import { getPostgresPool } from '../../setupDataAdapter';
import { createWebAuthority } from '../../application/adapters/authority';
import { createWebDelegationDatabase } from './database';

/** Refresh selected material facts with existing REST readers, never enumerate all guild cases. */
export async function readWebRestrictionFacts(
  guildId: string,
  fixes: readonly RestrictionFix[]
): Promise<RestrictionFacts> {
  const pool = getPostgresPool();
  const stored = await pool.query('select * from servers where guild_id=$1', [guildId]);
  if (!stored.rows[0]) throw new Error('stale_state');
  const config = parseSetupStoredRecord(stored.rows[0]);
  const settings = config.settings;
  const [guild, bot, roles, channels] = await Promise.all([
    fetchDiscordGuild(guildId),
    fetchDiscordBotUser(),
    fetchDiscordGuildRoles(guildId),
    fetchDiscordGuildChannels(guildId),
  ]);
  if (guild.id !== guildId) throw new Error('binding_mismatch');
  const botMember = await fetchDiscordGuildMember(guildId, bot.id);
  const botRoles = roles.filter((r) => r.id === guildId || botMember.roles.includes(r.id));
  const highest = [...botRoles].sort(
    (a, b) =>
      b.position - a.position ||
      (/^\d+$/.test(a.id) && /^\d+$/.test(b.id) ? (BigInt(a.id) < BigInt(b.id) ? -1 : 1) : 0)
  )[0];
  if (!highest) throw new Error('metadata_unavailable');
  const key = (
    entries: readonly { id: string; type: number; allow: string; deny: string }[]
  ): string =>
    JSON.stringify(
      [...entries]
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((o) => [o.id, o.type, o.allow, o.deny])
    );
  const types = new Map<number, RestrictionChannelFact['type']>([
    [0, 'text'],
    [5, 'announcement'],
    [2, 'voice'],
    [13, 'stage'],
    [15, 'forum'],
    [16, 'media'],
    [4, 'category'],
  ]);
  const channelFacts: RestrictionChannelFact[] = channels.flatMap((channel) => {
    const type = types.get(channel.type);
    if (!type) return [];
    const parentId = channel.parent_id ?? null;
    const parent = channels.find((c) => c.id === parentId);
    const entries = channel.permission_overwrites;
    return [
      {
        id: channel.id,
        name: channel.name,
        type,
        parentId,
        permissionsLocked:
          !!entries &&
          !!parent?.permission_overwrites &&
          key(entries) === key(parent.permission_overwrites),
        overwrites: (entries ?? []).map((o) => ({
          id: o.id,
          type: o.type === 1 ? ('member' as const) : ('role' as const),
          allow: o.allow,
          deny: o.deny,
        })),
        metadataAvailable: !!entries && (parentId === null || !!parent?.permission_overwrites),
      },
    ];
  });
  const caseIds = [
    ...new Set(fixes.flatMap((f) => f.effects.flatMap((e) => ('caseId' in e ? [e.caseId] : [])))),
  ];
  const cases: RestrictionFacts['cases'] = [];
  const threads: RestrictionFacts['threads'] = [];
  for (const caseId of caseIds) {
    const { rows } = await pool.query(
      `select id,user_id,case_revision,case_kind,thread_id,quarantine_case_role_id,quarantine_attempt_id,
        (select row_to_json(s) from (select status,planned_role_ids,metadata from role_quarantine_snapshots where verification_event_id=v.id order by created_at desc limit 1) s) as repair_snapshot,
        exists(select 1 from moderation_outcomes where verification_event_id=v.id and outcome_type='member_left') as departed,
        exists(select 1 from role_quarantine_snapshots where server_id=v.server_id and user_id=v.user_id and status='active' and verification_event_id is distinct from v.id) as competing_snapshot
        from verification_events v where id=$1::uuid and server_id=$2 and status='pending'`,
      [caseId, guildId]
    );
    const row = rows[0];
    if (!row?.user_id) throw new Error('stale_state');
    const member = await fetchDiscordGuildMember(guildId, row.user_id);
    if (!member.joined_at) throw new Error('metadata_unavailable');
    const eligibility = restrictionRepairEligibility(
      row.repair_snapshot,
      row.quarantine_attempt_id,
      row.departed,
      row.competing_snapshot
    );
    cases.push({
      repairEligibility: {
        ...eligibility,
        blockedRoles: eligibility.blockedRoles.filter(({ roleId }) =>
          member.roles.includes(roleId)
        ),
      },
      caseId: row.id,
      caseRoleId: row.quarantine_case_role_id,
      caseRevision: String(row.case_revision),
      joinedAt: new Date(member.joined_at).toISOString(),
      userId: row.user_id,
      purpose: row.case_kind === 'compromised_account' ? 'compromised_account' : 'standard_case',
      roleIds: [...new Set([guildId, ...member.roles])],
      owner: guild.owner_id === row.user_id,
      metadataAvailable: true,
      threadId: row.thread_id,
    });
    if (row.thread_id && !threads.some((t) => t.id === row.thread_id)) {
      const thread = await fetchDiscordChannel(row.thread_id);
      if (thread.guild_id !== guildId || !thread.parent_id || !thread.thread_metadata)
        throw new Error('metadata_unavailable');
      const members = await fetchDiscordThreadMembers(thread.id);
      threads.push({
        id: thread.id,
        parentId: thread.parent_id,
        private: thread.type === 12,
        archived: thread.thread_metadata.archived,
        locked: thread.thread_metadata.locked,
        memberIds: members.map((m) => m.user_id),
        metadataAvailable: true,
      });
    }
  }
  const allowedCategories = settings.case_role_lockdown_allowed_category_ids ?? [];
  const now = new Date().toISOString();
  return {
    configurationAvailable: true,
    guildId,
    caseRoleId: config.case_role_id,
    quarantineMode: settings.role_quarantine_mode ?? 'off',
    exemptRoleIds: settings.role_quarantine_exempt_role_ids ?? [],
    manualIntakeRoleId: settings.manual_intake_enabled
      ? settings.manual_intake_role_id?.trim() || null
      : null,
    repairExcludedRoleIds:
      settings.role_gate_enabled && settings.honeypot_role_id ? [settings.honeypot_role_id] : [],
    botHighestPosition: highest.position,
    roles: roles.map((r) => ({
      ...r,
      position:
        r.position === highest.position &&
        r.id !== highest.id &&
        /^\d+$/.test(r.id) &&
        /^\d+$/.test(highest.id) &&
        BigInt(highest.id) < BigInt(r.id)
          ? r.position - 1
          : r.position,
      botManaged: typeof r.tags?.bot_id === 'string',
    })),
    observedAt: now,
    completedAt: now,
    channels: channelFacts,
    channelsComplete: true,
    cases,
    casesComplete: false,
    threads,
    threadsComplete: false,
    exceptionChannelIds: [
      ...new Set([
        ...(settings.case_role_lockdown_allowed_channel_ids ?? []),
        ...channelFacts
          .filter((c) => c.parentId && allowedCategories.includes(c.parentId))
          .map((c) => c.id),
      ]),
    ],
    recoveryParentId: config.verification_channel_id,
    knownParentContentExposure: false,
  };
}
export function createWebRestrictionPlanDependencies(): RestrictionPlanDependencies {
  return {
    authority: createWebAuthority(),
    auditStore: createRestrictionStores(createWebDelegationDatabase()),
    now: () => new Date(),
    readFresh: readWebRestrictionFacts,
  };
}
