import { restrictionFactsAfter } from './restrictionActions';
import { restrictionRepairEligibility } from './restrictionRepairEligibility';
import { assessRestrictionFacts } from './restrictionAssessment';
import { channel, facts, caseFact, role } from './restrictionTestData';
import { proposeRestrictionFixes, normalizeRestrictionEffects } from './restrictionProposals';

describe('restriction proposals', () => {
  it('groups inherited children into one frozen category repair', () => {
    const input = facts({
      channels: [
        channel({ id: 'parent', type: 'category' }),
        channel({ id: 'a', parentId: 'parent', permissionsLocked: true }),
        channel({ id: 'b', parentId: 'parent', permissionsLocked: true }),
      ],
      roles: facts().roles.map((r) => (r.id === 'guild' ? { ...r, permissions: '1024' } : r)),
    });
    const fixes = proposeRestrictionFixes(input, assessRestrictionFacts(input)).filter(
      (f) => f.selectable
    );
    expect(fixes).toHaveLength(1);
    expect(fixes[0].affectedScope).toEqual(['parent', 'a', 'b']);
    expect(fixes[0].effects).toHaveLength(1);
    expect(fixes[0].effects[0]).toMatchObject({
      kind: 'edit_overwrite',
      channelId: 'parent',
      expected: null,
    });
    expect(fixes[0].defaultSelected).toBe(true);
  });
  it('does not present prospective conditions as observed members', () => {
    const input = facts({
      quarantineMode: 'off',
      roles: facts().roles.map((r) => (r.id === 'member' ? { ...r, permissions: '1024' } : r)),
    });
    const fixes = proposeRestrictionFixes(input, assessRestrictionFacts(input));
    expect(
      fixes.find((f) => f.effects.some((e) => e.kind === 'update_quarantine_policy'))
    ).toMatchObject({ defaultSelected: false, affectedCount: 0 });
  });
  it('rejects contradictory edits', () => {
    const effect = {
      kind: 'edit_overwrite' as const,
      guildId: 'g',
      channelId: 'c',
      roleId: 'r',
      expected: null,
      desired: { allow: '1024', deny: '0' },
    };
    expect(() =>
      normalizeRestrictionEffects([effect, { ...effect, desired: { allow: '0', deny: '1024' } }])
    ).toThrow('Conflicting');
  });
});

it('merges non-overlapping edits without restoring changed bits from the shared before-state', () => {
  const effect = {
    kind: 'edit_overwrite' as const,
    guildId: 'g',
    channelId: 'c',
    roleId: 'r',
    expected: { allow: '3072', deny: '0' },
  };
  expect(
    normalizeRestrictionEffects([
      { ...effect, desired: { allow: '2048', deny: '1024' } },
      { ...effect, desired: { allow: '1024', deny: '2048' } },
    ])
  ).toEqual([{ ...effect, desired: { allow: '0', deny: '3072' } }]);
});
it('freezes unsync and permission correction as an unchecked inseparable proposal', () => {
  const input = facts({
    exceptionChannelIds: ['a'],
    channels: [
      channel({ id: 'parent', type: 'category' }),
      channel({ id: 'a', parentId: 'parent', permissionsLocked: true }),
    ],
    roles: facts().roles.map((r) => (r.id === 'guild' ? { ...r, permissions: '3072' } : r)),
  });
  const fix = proposeRestrictionFixes(input, assessRestrictionFacts(input)).find(
    (f) => f.selectable
  )!;
  expect(fix.defaultSelected).toBe(false);
  expect(fix.effects.map((e) => e.kind)).toEqual(['unsync_channel']);
  const effect = fix.effects[0];
  expect(effect.kind === 'unsync_channel' && effect.desired).not.toEqual(
    effect.kind === 'unsync_channel' && effect.expected
  );
});
it('keeps protected staff roles out of current-case quarantine proposals', () => {
  const input = facts({
    roles: [...facts().roles, { ...facts().roles[2], id: 'staff', permissions: '8' }],
    cases: [
      {
        caseId: 'case-id',
        caseRoleId: null,
        caseRevision: '2',
        joinedAt: '2020-01-01T00:00:00.000Z',
        userId: 'user',
        purpose: 'compromised_account',
        roleIds: ['case', 'staff', 'member'],
        owner: false,
        metadataAvailable: true,
        threadId: null,
      },
    ],
  });
  const effect = proposeRestrictionFixes(input, assessRestrictionFacts(input))
    .flatMap((f) => f.effects)
    .find((e) => e.kind === 'quarantine_case_roles');
  expect(effect).toBeUndefined();
});

it('does not default-check corrections when required metadata is incomplete', () => {
  const input = facts({
    channelsComplete: false,
    roles: facts().roles.map((r) => (r.id === 'guild' ? { ...r, permissions: '1024' } : r)),
  });
  expect(
    proposeRestrictionFixes(input, assessRestrictionFacts(input)).every((f) => !f.defaultSelected)
  ).toBe(true);
});

it('groups an assumed quarantine policy with dependent channel repairs, unchecked', () => {
  const input = facts({
    quarantineMode: 'off',
    roles: facts().roles.map((r) => (r.id === 'guild' ? { ...r, permissions: '1024' } : r)),
    channels: [channel({ overwrites: [{ id: 'member', type: 'role', allow: '1024', deny: '0' }] })],
  });
  const fixes = proposeRestrictionFixes(input, assessRestrictionFacts(input));
  const channelRepair = fixes.find((f) => f.effects.some((e) => e.kind === 'edit_overwrite'))!;
  expect(channelRepair.defaultSelected).toBe(false);
  expect(channelRepair.effects.some((e) => e.kind === 'update_quarantine_policy')).toBe(true);
  expect(fixes.filter((f) => f.effects.some((e) => e.kind === 'edit_overwrite'))).toHaveLength(1);
});
it.each(['channel', 'thread'] as const)(
  'withholds defaults when individual %s evidence is missing despite complete collections',
  (area) => {
    const input = facts({
      roles: facts().roles.map((r) => (r.id === 'guild' ? { ...r, permissions: '1024' } : r)),
      channels: [
        channel(),
        ...(area === 'channel' ? [channel({ id: 'unknown', metadataAvailable: false })] : []),
      ],
      threads:
        area === 'thread'
          ? [
              {
                id: 'unknown',
                parentId: 'channel',
                private: true,
                archived: true,
                locked: false,
                memberIds: [],
                metadataAvailable: false,
              },
            ]
          : [],
    });
    expect(
      proposeRestrictionFixes(input, assessRestrictionFacts(input)).every((f) => !f.defaultSelected)
    ).toBe(true);
  }
);

it('repairs a winning ordinary exemption with unchecked future policy, not redundant default denies', () => {
  const input = facts({
    exemptRoleIds: ['member'],
    channels: [
      channel({
        overwrites: [
          { id: 'case', type: 'role', allow: '0', deny: '1024' },
          { id: 'member', type: 'role', allow: '1024', deny: '0' },
        ],
      }),
    ],
  });
  const fixes = proposeRestrictionFixes(input, assessRestrictionFacts(input));
  const policy = fixes.find((f) => f.effects.some((e) => e.kind === 'update_quarantine_policy'));
  expect(policy).toMatchObject({ defaultSelected: false });
  expect(policy?.effects).toContainEqual(
    expect.objectContaining({
      kind: 'update_quarantine_policy',
      desired: expect.objectContaining({ exemptRoleIds: [] }),
    })
  );
  expect(fixes.filter((f) => f.defaultSelected)).toEqual([]);
});

it.each([
  {
    status: 'active',
    planned_role_ids: ['member'],
    metadata: { failed_removals: [{ id: 'member' }] },
  },
  {
    status: 'active',
    planned_role_ids: ['member'],
    metadata: {
      restriction_role_owners: {
        member: { requestId: 'private', attemptToken: 'secret', state: 'unknown' },
      },
    },
  },
  { status: 'restored', planned_role_ids: [], metadata: {} },
])('keeps prior removal ownership manual: %j', (snapshot) => {
  const input = facts({
    channels: [channel({ overwrites: [{ id: 'member', type: 'role', allow: '1024', deny: '0' }] })],
    cases: [
      caseFact({
        roleIds: ['case', 'member'],
        repairEligibility: restrictionRepairEligibility(snapshot, null, false),
      }),
    ],
  });
  const fixes = proposeRestrictionFixes(input, assessRestrictionFacts(input));
  expect(fixes.flatMap((f) => f.effects).some((e) => e.kind === 'quarantine_case_roles')).toBe(
    false
  );
  expect(fixes).toContainEqual(
    expect.objectContaining({
      kind: 'manual',
      summary: expect.stringMatching(/snapshot|ownership|owns/),
    })
  );
  expect(JSON.stringify(fixes)).not.toContain('secret');
});
it('groups exemption policy with separately disclosed safe current removals and fixes the winning allow', () => {
  const input = facts({
    exemptRoleIds: ['member'],
    channels: [
      channel({
        overwrites: [
          { id: 'case', type: 'role', allow: '0', deny: '1024' },
          { id: 'member', type: 'role', allow: '1024', deny: '0' },
        ],
      }),
    ],
    cases: [caseFact({ roleIds: ['case', 'member'] })],
  });
  const fix = proposeRestrictionFixes(input, assessRestrictionFacts(input)).find(
    (f) => f.id === 'policy:quarantine'
  )!;
  expect(fix.defaultSelected).toBe(false);
  expect(fix.effects.map((e) => e.kind)).toEqual([
    'update_quarantine_policy',
    'quarantine_case_roles',
  ]);
  const after = assessRestrictionFacts(fix.effects.reduce(restrictionFactsAfter, input));
  expect(after.setup.findingCodes).not.toContain('unexpected_channel_access');
  expect(after.cases[0].findingCodes).not.toContain('unexpected_channel_access');
});
it.each(['staff', 'managed', 'intake', 'policy'])(
  'does not remove %s exemptions to offer an automatic bypass',
  (kind) => {
    const input = facts({
      exemptRoleIds: ['member'],
      manualIntakeRoleId: kind === 'intake' ? 'member' : null,
      repairExcludedRoleIds: kind === 'policy' ? ['member'] : [],
      roles: [
        ...facts().roles.filter((r) => r.id !== 'member'),
        role({ permissions: kind === 'staff' ? '8' : '0', managed: kind === 'managed' }),
      ],
      channels: [
        channel({
          overwrites: [
            { id: 'case', type: 'role', allow: '0', deny: '1024' },
            { id: 'member', type: 'role', allow: '1024', deny: '0' },
          ],
        }),
      ],
    });
    const fixes = proposeRestrictionFixes(input, assessRestrictionFacts(input));
    expect(fixes.flatMap((f) => f.effects).some((e) => e.kind === 'update_quarantine_policy')).toBe(
      false
    );
    expect(
      fixes.filter(
        (f) =>
          f.defaultSelected &&
          f.effects.some((e) => e.kind === 'edit_overwrite' && e.channelId === 'channel')
      )
    ).toEqual([]);
  }
);
