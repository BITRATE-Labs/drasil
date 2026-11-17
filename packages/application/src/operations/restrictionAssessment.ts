import {
  classifyRestrictionRoles,
  STANDARD_RESTRICTION_PRIVILEGED_PERMISSIONS,
} from './restrictionPolicy';
import type {
  RestrictionAssessment,
  RestrictionAssessmentSet,
  RestrictionCaseFact,
  RestrictionChannelFact,
  RestrictionCoverage,
  RestrictionFacts,
  RestrictionFinding,
  RestrictionFindingCode,
  RestrictionOverwrite,
} from './restrictionTypes';

const VIEW = 1n << 10n;
const ADMIN = 1n << 3n;
const MANAGE_THREADS = 1n << 34n;
const THREAD_REPLY = 1n << 38n;
const SEND = 1n << 11n;
const CONNECT = 1n << 20n;
const TEXT_INTERACTIONS =
  SEND |
  (1n << 6n) |
  (1n << 13n) |
  (1n << 30n) |
  (1n << 31n) |
  (1n << 35n) |
  (1n << 36n) |
  THREAD_REPLY |
  (1n << 46n) |
  (1n << 49n) |
  (1n << 51n);
const VOICE_INTERACTIONS =
  CONNECT |
  (1n << 21n) |
  (1n << 9n) |
  (1n << 25n) |
  (1n << 32n) |
  (1n << 39n) |
  (1n << 42n) |
  (1n << 48n);

function effective(
  facts: RestrictionFacts,
  channel: RestrictionChannelFact,
  roleIds: readonly string[],
  userId: string | null,
  owner: boolean
): bigint | null {
  const roles = facts.roles.filter(
    (role) => role.id === facts.guildId || roleIds.includes(role.id)
  );
  if (roleIds.some((id) => !facts.roles.some((role) => role.id === id))) return null;
  let permissions = roles.reduce((value, role) => value | BigInt(role.permissions), 0n);
  if (owner || (permissions & ADMIN) !== 0n) return -1n;
  const parent = channel.permissionsLocked
    ? facts.channels.find((item) => item.id === channel.parentId)
    : null;
  if (
    !channel.metadataAvailable ||
    (channel.permissionsLocked && (!parent || !parent.metadataAvailable))
  )
    return null;
  const overwrites = (parent ?? channel).overwrites;
  const apply = (entries: readonly RestrictionOverwrite[]): void => {
    const deny = entries.reduce((value, entry) => value | BigInt(entry.deny), 0n);
    const allow = entries.reduce((value, entry) => value | BigInt(entry.allow), 0n);
    permissions = (permissions & ~deny) | allow;
  };
  apply(overwrites.filter((entry) => entry.type === 'role' && entry.id === facts.guildId));
  apply(
    overwrites.filter(
      (entry) => entry.type === 'role' && roleIds.includes(entry.id) && entry.id !== facts.guildId
    )
  );
  if (userId) apply(overwrites.filter((entry) => entry.type === 'member' && entry.id === userId));
  return permissions;
}

export function assessRestrictionFacts(facts: RestrictionFacts): RestrictionAssessmentSet {
  const dispositions = classifyRestrictionRoles({ ...facts, purpose: 'standard_case' });
  const setupRoles = facts.roles
    .filter(
      (role) =>
        role.id !== facts.guildId &&
        role.id !== facts.caseRoleId &&
        (BigInt(role.permissions) & STANDARD_RESTRICTION_PRIVILEGED_PERMISSIONS) === 0n &&
        (facts.quarantineMode !== 'on' ||
          !dispositions.find((item) => item.roleId === role.id)?.removable)
    )
    .map((role) => role.id);
  const assess = (member: RestrictionCaseFact | null): RestrictionAssessment => {
    const findings: RestrictionFinding[] = [];
    const add = (
      code: RestrictionFindingCode,
      channelId: string | null = null,
      kind: RestrictionFinding['kind'] = 'access_failure'
    ): void => {
      findings.push({
        code,
        channelId,
        userId: member?.userId ?? null,
        roleIds: member?.roleIds ?? setupRoles,
        kind,
      });
    };
    let unknown =
      !facts.channelsComplete ||
      !facts.casesComplete ||
      !facts.threadsComplete ||
      (member !== null && !member.metadataAvailable);
    if (!facts.caseRoleId || !facts.roles.some((role) => role.id === facts.caseRoleId))
      add('case_role_missing');
    const roleIds = member?.roleIds ?? [
      ...setupRoles,
      ...(facts.caseRoleId ? [facts.caseRoleId] : []),
    ];
    if (
      facts.roles.some(
        (role) =>
          roleIds.includes(role.id) &&
          (BigInt(role.permissions) & STANDARD_RESTRICTION_PRIVILEGED_PERMISSIONS) !== 0n
      )
    ) {
      add('retained_privileged_permissions', null, 'manual');
    }
    if (!facts.roles.some((role) => role.id === facts.guildId)) unknown = true;
    if (member && facts.caseRoleId && !roleIds.includes(facts.caseRoleId))
      add('case_role_not_assigned');
    if (member?.owner) add('owner_bypass', null, 'manual');
    if (
      member &&
      facts.roles.some(
        (role) => roleIds.includes(role.id) && (BigInt(role.permissions) & ADMIN) !== 0n
      )
    )
      add('administrator_bypass', null, 'manual');
    let checkedChannels = 0;
    const permissionsByChannel = new Map<string, bigint>();
    for (const channel of facts.channels) {
      const permissions = effective(
        facts,
        channel,
        roleIds,
        member?.userId ?? null,
        member?.owner ?? false
      );
      if (permissions === null) {
        unknown = true;
        continue;
      }
      checkedChannels++;
      permissionsByChannel.set(channel.id, permissions);
      if (channel.type === 'category' || (permissions & VIEW) === 0n) continue;
      const exception = facts.exceptionChannelIds.includes(channel.id);
      const recovery = channel.id === facts.recoveryParentId;
      if (!exception && !recovery) add('unexpected_channel_access', channel.id);
      const interactionMask =
        TEXT_INTERACTIONS |
        (channel.type === 'voice' || channel.type === 'stage' ? VOICE_INTERACTIONS : 0n);
      if (
        (exception || recovery) &&
        (permissions & (recovery ? interactionMask & ~THREAD_REPLY : interactionMask)) !== 0n
      )
        add('exception_write_access', channel.id);
      // Denying Add Reactions cannot prevent joining an existing reaction.
      if (exception) add('reaction_limitation', channel.id, 'limitation');
    }
    if (facts.knownParentContentExposure) add('parent_content_exposure', facts.recoveryParentId);
    let checkedThreads = 0;
    for (const thread of facts.threads) {
      const permissions = permissionsByChannel.get(thread.parentId);
      if (!thread.metadataAvailable || permissions === undefined) {
        unknown = true;
        continue;
      }
      checkedThreads++;
      const manager = (permissions & MANAGE_THREADS) !== 0n;
      const visible =
        (permissions & VIEW) !== 0n &&
        (!thread.private ||
          manager ||
          (member !== null && thread.memberIds.includes(member.userId)));
      if (member && thread.id === member.threadId) {
        if (
          !thread.private ||
          !visible ||
          (permissions & THREAD_REPLY) === 0n ||
          (permissions & (1n << 16n)) === 0n ||
          (thread.locked && !manager)
        )
          add('case_thread_access_missing', thread.id);
      } else if (visible) add('sibling_thread_access', thread.id);
    }
    if (
      member &&
      (!member.threadId || !facts.threads.some((thread) => thread.id === member.threadId))
    ) {
      add('case_thread_unavailable', null, 'coverage');
      unknown = true;
    }
    if (unknown) add('metadata_unavailable', null, 'coverage');
    const coverage = (
      area: RestrictionCoverage['area'],
      checked: number,
      total: number | null,
      complete: boolean
    ): RestrictionCoverage => ({
      area,
      state: complete ? 'complete' : checked ? 'partial' : 'unavailable',
      checked,
      total,
      reason: complete ? null : 'Required metadata unavailable',
      observedAt: facts.observedAt,
      completedAt: facts.completedAt,
    });
    return {
      status: findings.some((finding) => finding.kind !== 'coverage')
        ? 'incomplete'
        : unknown
          ? 'unverified'
          : 'verified',
      findingCodes: [...new Set(findings.map((finding) => finding.code))],
      findings,
      scope: 'permissions_and_membership',
      coverage: [
        coverage(
          'channels',
          checkedChannels,
          facts.channelsComplete ? facts.channels.length : null,
          facts.channelsComplete && checkedChannels === facts.channels.length
        ),
        coverage(
          'cases',
          member ? 1 : facts.cases.length,
          facts.casesComplete ? (member ? 1 : facts.cases.length) : null,
          facts.casesComplete
        ),
        coverage(
          'threads',
          checkedThreads,
          facts.threadsComplete ? facts.threads.length : null,
          facts.threadsComplete && checkedThreads === facts.threads.length
        ),
        coverage(
          'affected_members',
          member?.metadataAvailable ? 1 : 0,
          member ? 1 : 0,
          !member || member.metadataAvailable
        ),
        {
          area: 'parent_content',
          state: 'out_of_scope',
          checked: 0,
          total: null,
          reason: 'Message content is not inspected',
          observedAt: facts.observedAt,
          completedAt: facts.completedAt,
        },
      ],
    };
  };
  return {
    setup: assess(null),
    cases: facts.cases.map((member) => ({
      ...assess(member),
      caseId: member.caseId,
      caseRevision: member.caseRevision,
      userId: member.userId,
    })),
  };
}
