import type {
  RestrictionFacts,
  RestrictionRoleFact,
  RestrictionChannelFact,
  RestrictionCaseFact,
} from './restrictionTypes';
export function role(input: Partial<RestrictionRoleFact> = {}): RestrictionRoleFact {
  return {
    id: 'member',
    name: 'Member',
    position: 1,
    permissions: '0',
    managed: false,
    botManaged: false,
    ...input,
  };
}
export function channel(input: Partial<RestrictionChannelFact> = {}): RestrictionChannelFact {
  return {
    id: 'channel',
    name: 'Community',
    type: 'text',
    parentId: null,
    permissionsLocked: false,
    overwrites: [],
    metadataAvailable: true,
    ...input,
  };
}
export function caseFact(input: Partial<RestrictionCaseFact> = {}): RestrictionCaseFact {
  return {
    caseId: 'case-id',
    caseRoleId: null,
    caseRevision: 'revision',
    joinedAt: '2020-01-01T00:00:00.000Z',
    userId: 'user',
    purpose: 'standard_case',
    roleIds: ['case'],
    owner: false,
    metadataAvailable: true,
    threadId: null,
    repairEligibility: { reason: null, blockedRoles: [] },
    ...input,
  };
}
export function facts(input: Partial<RestrictionFacts> = {}): RestrictionFacts {
  const result: RestrictionFacts = {
    guildId: 'guild',
    caseRoleId: 'case',
    quarantineMode: 'on',
    exemptRoleIds: [],
    manualIntakeRoleId: null,
    botHighestPosition: 10,
    roles: [role({ id: 'guild' }), role({ id: 'case' }), role()],
    observedAt: '2026-11-17T12:00:00Z',
    completedAt: '2026-11-17T12:00:01Z',
    channels: [channel()],
    channelsComplete: true,
    cases: [],
    casesComplete: true,
    threads: [],
    threadsComplete: true,
    exceptionChannelIds: [],
    recoveryParentId: null,
    knownParentContentExposure: false,
    ...input,
  };
  if (!('recoveryParentId' in input)) {
    result.recoveryParentId = 'recovery';
    result.channels = [
      ...result.channels,
      channel({
        id: 'recovery',
        name: 'Recovery',
        overwrites: [
          {
            id: 'case',
            type: 'role',
            allow: String((1n << 10n) | (1n << 16n) | (1n << 38n)),
            deny: String((1n << 11n) | (1n << 6n)),
          },
        ],
      }),
    ];
  }
  return result;
}
