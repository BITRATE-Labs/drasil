import type { PublicRestrictionAudit, RestrictionApplyResult } from '@drasil/application';
export function fixtureRestrictionAudit(
  guildId = '910000000000000001',
  now = new Date()
): PublicRestrictionAudit {
  const observedAt = now.toISOString();
  const coverage = [
    {
      area: 'channels' as const,
      state: 'complete' as const,
      checked: 1,
      total: 1,
      reason: null,
      observedAt,
      completedAt: observedAt,
    },
    {
      area: 'parent_content' as const,
      state: 'out_of_scope' as const,
      checked: 0,
      total: null,
      reason: 'Message history was not inspected.',
      observedAt,
      completedAt: observedAt,
    },
  ];
  return {
    schemaVersion: 1,
    guildId,
    auditRequestId: '91000000-0000-4000-8000-000000000031',
    observedAt,
    completedAt: observedAt,
    expiresAt: new Date(now.getTime() + 600000).toISOString(),
    revision: 'fixture-revision',
    setup: {
      status: 'incomplete',
      findingCodes: ['exception_write_access'],
      scope: 'permissions_and_membership',
      coverage,
    },
    cases: [
      {
        caseId: '91000000-0000-4000-8000-000000000001',
        caseRevision: '1',
        userId: '910000000000000004',
        status: 'unverified',
        findingCodes: ['metadata_unavailable'],
        scope: 'permissions_and_membership',
      },
    ],
    coverage,
    fixes: [
      {
        id: 'exception',
        kind: 'access_repair',
        summary: 'Keep #rules read-only',
        before: 'The case role can reply in #rules threads.',
        after: 'Deny Send Messages in Threads for the case role in #rules.',
        affectedScope: ['#rules', 'All current and future restricted members'],
        affectedCount: 1,
        defaultSelected: true,
        selectable: true,
        effects: [
          {
            kind: 'edit_overwrite',
            guildId,
            channelId: '910000000000000007',
            roleId: '910000000000000021',
            expected: { allow: '274877973504', deny: '103079217152' },
            desired: { allow: '66560', deny: '377957124096' },
          },
        ],
      },
      {
        id: 'member',
        kind: 'access_repair',
        summary: 'Remove leftover role access',
        before: 'One current case keeps Community access.',
        after:
          'Remove and save Community for the affected restricted member. Ordinary members keep their access.',
        affectedScope: ['One current case'],
        affectedCount: 1,
        defaultSelected: false,
        selectable: true,
        effects: [
          {
            kind: 'quarantine_case_roles',
            guildId,
            caseId: '91000000-0000-4000-8000-000000000001',
            caseRevision: '1',
            joinedAt: observedAt,
            memberId: '910000000000000004',
            roleIds: ['910000000000000024'],
            expected: [guildId, '910000000000000021', '910000000000000024'],
            desired: [guildId, '910000000000000021'],
          },
        ],
      },
      {
        id: 'hardening',
        kind: 'hardening',
        summary: 'Protect #workshop',
        before: 'Other permissions already hide #workshop.',
        after: 'Add explicit case-role View Channel denies to #workshop.',
        affectedScope: ['#workshop'],
        affectedCount: 1,
        defaultSelected: false,
        selectable: true,
        effects: [
          {
            kind: 'edit_overwrite',
            guildId,
            channelId: '910000000000000023',
            roleId: '910000000000000021',
            expected: null,
            desired: { allow: '0', deny: '1024' },
          },
        ],
      },
      {
        id: 'staff',
        kind: 'manual',
        summary: 'Protected staff access needs attention',
        before: 'A protected staff role grants extra access.',
        after: 'Review the staff case manually. Drasil preserves protected roles.',
        affectedScope: ['Protected staff case'],
        affectedCount: 1,
        defaultSelected: false,
        selectable: false,
        effects: [],
      },
    ],
    diagnostics: [
      {
        code: 'metadata_unavailable',
        kind: 'coverage',
        channelId: null,
        userId: null,
        roleIds: [],
        caseId: null,
        caseRevision: null,
      },
    ],
    diagnosticOffset: 0,
    diagnosticTotal: 1,
    nextDiagnosticOffset: null,
  };
}
export function fixtureRestrictionResult(): RestrictionApplyResult {
  const audit = fixtureRestrictionAudit();
  return {
    progress: {
      schemaVersion: 1,
      revision: 2,
      currentEffectIndex: 1,
      receipts: [
        {
          effectIndex: 0,
          state: 'applied',
          observation: { state: 'desired_satisfied', observedAt: audit.observedAt, reason: null },
          error: null,
        },
        { effectIndex: 1, state: 'unknown', observation: null, error: 'Interrupted request' },
      ],
    },
    stopReason: 'interrupted',
    verification: {
      setup: { ...audit.setup, findings: [] },
      cases: audit.cases.map((c) => ({ ...c, findings: [], coverage: audit.coverage })),
    },
  };
}
import type { RestrictionAudit } from '@drasil/application';
/** Controlled provider snapshot for the shared chooser fixture, never application runtime. */
export function fixtureRestrictionAuditSnapshot(now = new Date()): RestrictionAudit {
  const audit = fixtureRestrictionAudit(undefined, now);
  const {
    auditRequestId,
    diagnostics,
    diagnosticOffset,
    diagnosticTotal,
    nextDiagnosticOffset,
    ...summary
  } = audit;
  void auditRequestId;
  void diagnostics;
  void diagnosticOffset;
  void diagnosticTotal;
  void nextDiagnosticOffset;
  return {
    ...summary,
    setup: { ...audit.setup, findings: [] },
    cases: audit.cases.map((c) => ({ ...c, findings: [], coverage: audit.coverage })),
    facts: {
      guildId: audit.guildId,
      caseRoleId: '910000000000000021',
      quarantineMode: 'off',
      exemptRoleIds: [],
      manualIntakeRoleId: null,
      botHighestPosition: 10,
      roles: [
        {
          id: '910000000000000021',
          name: 'Restricted',
          permissions: '0',
          position: 2,
          managed: false,
          botManaged: false,
        },
        {
          id: '910000000000000022',
          name: 'Drasil',
          permissions: '8',
          position: 10,
          managed: true,
          botManaged: true,
        },
        {
          id: '910000000000000024',
          name: 'Community',
          permissions: '0',
          position: 1,
          managed: false,
          botManaged: false,
        },
        {
          id: audit.guildId,
          name: '@everyone',
          permissions: '0',
          position: 0,
          managed: false,
          botManaged: false,
        },
        {
          id: '910000000000000020',
          name: 'Staff',
          permissions: '0',
          position: 1,
          managed: false,
          botManaged: false,
        },
      ],
      observedAt: audit.observedAt,
      completedAt: audit.completedAt,
      channels: [
        {
          id: '910000000000000023',
          name: 'workshop',
          type: 'text',
          parentId: null,
          permissionsLocked: false,
          overwrites: [],
          metadataAvailable: true,
        },
        {
          id: '910000000000000007',
          name: 'rules',
          type: 'text',
          parentId: null,
          permissionsLocked: false,
          overwrites: [
            { id: '910000000000000021', type: 'role', allow: '274877973504', deny: '103079217152' },
          ],
          metadataAvailable: true,
        },
      ],
      channelsComplete: true,
      cases: [
        {
          caseId: audit.cases[0].caseId,
          caseRoleId: '910000000000000021',
          caseRevision: '1',
          joinedAt: audit.observedAt,
          userId: audit.cases[0].userId,
          purpose: 'standard_case',
          roleIds: [audit.guildId, '910000000000000021', '910000000000000024'],
          owner: false,
          metadataAvailable: true,
          threadId: null,
          repairEligibility: { reason: null, blockedRoles: [] },
        },
      ],
      casesComplete: true,
      threads: [],
      threadsComplete: true,
      exceptionChannelIds: ['910000000000000007'],
      recoveryParentId: null,
      knownParentContentExposure: false,
    },
  };
}
export function fixtureGroupedCategoryRestrictionAudit() {
  const audit = fixtureRestrictionAuditSnapshot();
  const base = audit.facts.channels[0];
  audit.facts.channels = [
    { ...base, id: 'category-a', name: 'Category A', type: 'category' },
    { ...base, id: 'child-a', name: 'a-child', parentId: 'category-a', permissionsLocked: true },
    {
      ...base,
      id: 'independent-a',
      name: 'a-independent',
      parentId: 'category-a',
      permissionsLocked: false,
    },
    { ...base, id: 'category-b', name: 'Category B', type: 'category' },
    { ...base, id: 'child-b', name: 'b-child', parentId: 'category-b', permissionsLocked: true },
  ];
  audit.fixes = [
    {
      ...audit.fixes[0],
      id: 'grouped',
      affectedScope: ['category-a', 'child-a', 'category-b', 'child-b'],
      effects: ['category-a', 'category-b'].map((channelId) => ({
        kind: 'edit_overwrite' as const,
        guildId: audit.guildId,
        channelId,
        roleId: '910000000000000021',
        expected: null,
        desired: { allow: '0', deny: '1024' },
      })),
    },
  ];
  return audit;
}
