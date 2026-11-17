import { assessRestrictionFacts } from './restrictionAssessment';
import { channel, facts } from './restrictionTestData';
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
  expect(fix.effects.map((e) => e.kind)).toEqual(['unsync_channel', 'edit_overwrite']);
});
it('keeps protected staff roles out of current-case quarantine proposals', () => {
  const input = facts({
    roles: [...facts().roles, { ...facts().roles[2], id: 'staff', permissions: '8' }],
    cases: [
      {
        caseId: 'case-id',
        caseRoleId: null,
        caseRevision: '2',
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
  expect(effect).toMatchObject({
    roleIds: ['member'],
    expected: ['case', 'staff', 'member'],
    desired: ['case', 'staff'],
    caseRevision: '2',
  });
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
