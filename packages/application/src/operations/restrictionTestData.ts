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
    userId: 'user',
    purpose: 'standard_case',
    roleIds: ['case'],
    owner: false,
    metadataAvailable: true,
    threadId: null,
    ...input,
  };
}
export function facts(input: Partial<RestrictionFacts> = {}): RestrictionFacts {
  return {
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
}
