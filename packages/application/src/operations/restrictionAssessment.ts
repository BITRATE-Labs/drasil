import {
  classifyRestrictionRoles,
  STANDARD_RESTRICTION_PRIVILEGED_PERMISSIONS,
  COMPROMISED_RESTRICTION_PRIVILEGED_PERMISSIONS,
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
const ADMINISTRATIVE_MUTATIONS =
  (1n << 4n) | (1n << 13n) | (1n << 29n) | MANAGE_THREADS | (1n << 51n);
const TEXT_INTERACTIONS =
  SEND | (1n << 6n) | (1n << 31n) | (1n << 35n) | (1n << 36n) | THREAD_REPLY;
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

function setupPermissionCandidates(
  facts: RestrictionFacts,
  channel: RestrictionChannelFact,
  optionalRoleIds: readonly string[]
): readonly (bigint | null)[] {
  const fixedRoleIds = facts.caseRoleId ? [facts.caseRoleId] : [];
  const overwrites = channel.permissionsLocked
    ? (facts.channels.find((item) => item.id === channel.parentId)?.overwrites ?? [])
    : channel.overwrites;
  const candidates = new Map<string, readonly string[]>([['baseline', fixedRoleIds]]);
  const capabilities = TEXT_INTERACTIONS | VOICE_INTERACTIONS | ADMINISTRATIVE_MUTATIONS;
  for (let bit = 0n; bit <= 51n; bit++) {
    const capability = 1n << bit;
    if ((capabilities & capability) === 0n && capability !== VIEW) continue;
    const required = VIEW | capability;
    // A deny on an optional role cannot protect members who do not hold that role.
    // For each possible allow combination, retain every role that cannot block it.
    for (const allowed of [0n, VIEW, capability, required]) {
      const roleIds = optionalRoleIds.filter((roleId) => {
        const overwrite = overwrites.find((entry) => entry.type === 'role' && entry.id === roleId);
        if (!overwrite) return true;
        return ((BigInt(overwrite.allow) | BigInt(overwrite.deny)) & required & ~allowed) === 0n;
      });
      candidates.set(roleIds.join(','), [...fixedRoleIds, ...roleIds]);
    }
  }
  return [...candidates.values()].map((roleIds) => effective(facts, channel, roleIds, null, false));
}

function usableInteractions(channel: RestrictionChannelFact, permissions: bigint): bigint {
  // EmbedLinks and AttachFiles modify a permitted send; neither permits posting by itself.
  const threadCreation = channel.type === 'text' ? (1n << 35n) | (1n << 36n) : 0n;
  let interactions =
    permissions &
    (SEND | (1n << 6n) | (1n << 31n) | threadCreation | THREAD_REPLY | ADMINISTRATIVE_MUTATIONS);
  if (channel.type === 'voice' || channel.type === 'stage') {
    if ((permissions & CONNECT) !== 0n) interactions |= permissions & VOICE_INTERACTIONS;
  }
  return interactions;
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
    const caseRoleId = member?.caseRoleId ?? facts.caseRoleId;
    const findings: RestrictionFinding[] = [];
    const add = (
      code: RestrictionFindingCode,
      channelId: string | null = null,
      kind: RestrictionFinding['kind'] = 'access_failure'
    ): void => {
      if (findings.some((finding) => finding.code === code && finding.channelId === channelId))
        return;
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
    if (!caseRoleId || !facts.roles.some((role) => role.id === caseRoleId))
      add('case_role_missing');
    const roleIds = member?.roleIds ?? [
      ...setupRoles,
      ...(facts.caseRoleId ? [facts.caseRoleId] : []),
    ];
    if (
      facts.roles.some(
        (role) =>
          (role.id === facts.guildId || roleIds.includes(role.id)) &&
          (BigInt(role.permissions) & COMPROMISED_RESTRICTION_PRIVILEGED_PERMISSIONS) !== 0n
      )
    ) {
      add('retained_privileged_permissions', null, 'manual');
    }
    if (!facts.roles.some((role) => role.id === facts.guildId)) unknown = true;
    if (member && caseRoleId && !roleIds.includes(caseRoleId)) add('case_role_not_assigned');
    if (member?.owner) add('owner_bypass', null, 'manual');
    if (
      member &&
      facts.roles.some(
        (role) => roleIds.includes(role.id) && (BigInt(role.permissions) & ADMIN) !== 0n
      )
    )
      add('administrator_bypass', null, 'manual');
    let checkedChannels = 0;
    const permissionsByChannel = new Map<string, readonly bigint[]>();
    for (const channel of facts.channels) {
      const candidates = member
        ? [effective(facts, channel, roleIds, member.userId, member.owner)]
        : setupPermissionCandidates(facts, channel, setupRoles);
      if (candidates.some((permissions) => permissions === null)) unknown = true;
      const known = candidates.filter((permissions): permissions is bigint => permissions !== null);
      if (known.length === 0) continue;
      checkedChannels++;
      permissionsByChannel.set(channel.id, known);
      for (const permissions of known) {
        if (channel.type === 'category' || (permissions & VIEW) === 0n) continue;
        const exception = facts.exceptionChannelIds.includes(channel.id);
        const recovery = channel.id === facts.recoveryParentId;
        if (!exception && !recovery) add('unexpected_channel_access', channel.id);
        const interactions = usableInteractions(channel, permissions);
        if (
          (exception || recovery) &&
          (recovery ? interactions & ~THREAD_REPLY : interactions) !== 0n
        )
          add('exception_write_access', channel.id);
        // Denying Add Reactions cannot prevent joining an existing reaction.
        if (exception) add('reaction_limitation', channel.id, 'limitation');
      }
    }
    if (facts.knownParentContentExposure) add('parent_content_exposure', facts.recoveryParentId);
    let checkedThreads = 0;
    for (const thread of facts.threads) {
      const candidates = permissionsByChannel.get(thread.parentId);
      if (!thread.metadataAvailable || candidates === undefined) {
        unknown = true;
        continue;
      }
      checkedThreads++;
      for (const permissions of candidates) {
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
