import { caseFact } from './restrictionTestData';
import { prepareRestrictionPlan } from './restrictionActions';
import { context, fixture, fix } from './restrictionExecutionTestData';
import type { RestrictionFix } from './restrictionTypes';
test.each([
  { selectedFixIds: [] },
  { selectedFixIds: ['repair', 'repair'] },
  { selectedFixIds: ['unknown'] },
  { effects: [] },
  { auditRevision: 'old' },
])('rejects invalid selection %j', async (change) => {
  const f = fixture();
  await expect(
    prepareRestrictionPlan(context, { ...f.selection, ...change }, f.deps)
  ).rejects.toThrow();
});
test.each(['foreign', 'expired', 'manual', 'conflict'])('rejects %s audit', async (mode) => {
  const f = fixture();
  if (mode === 'foreign') f.audit.guildId = 'other';
  if (mode === 'expired') f.audit.expiresAt = '2026-11-17T12:00:00Z';
  if (mode === 'manual') f.audit.fixes = [{ ...fix, kind: 'manual' }];
  if (mode === 'conflict') {
    f.audit.fixes.push({
      ...fix,
      id: 'other',
      effects: [{ ...fix.effects[0], desired: '8' }] as RestrictionFix['effects'],
    });
    f.selection.selectedFixIds.push('other');
  }
  await expect(prepareRestrictionPlan(context, f.selection, f.deps)).rejects.toThrow();
});
test('renames are cosmetic, permission changes are material', async () => {
  const f = fixture();
  f.deps.readFresh.mockResolvedValue({
    ...f.state,
    roles: f.state.roles.map((r) => ({ ...r, name: 'Renamed' })),
  });
  await expect(prepareRestrictionPlan(context, f.selection, f.deps)).resolves.toMatchObject({
    actorId: 'owner',
    effects: fix.effects,
    expiresAt: f.audit.expiresAt,
  });
  f.deps.readFresh.mockResolvedValue({ ...f.state, botHighestPosition: 0 });
  await expect(prepareRestrictionPlan(context, f.selection, f.deps)).rejects.toThrow('stale_state');
});

test('grouped policy and current-member repair freezes both effects and membership identity', async () => {
  const f = fixture();
  const member = caseFact({ roleIds: ['case', 'member'] });
  f.state.cases = [member];
  f.audit.fixes[0] = {
    ...fix,
    effects: [
      {
        kind: 'update_quarantine_policy',
        guildId: 'guild',
        expected: { quarantineMode: 'on', exemptRoleIds: [], manualIntakeRoleId: null },
        desired: { quarantineMode: 'on', exemptRoleIds: [], manualIntakeRoleId: null },
      },
      {
        kind: 'quarantine_case_roles',
        guildId: 'guild',
        caseId: member.caseId,
        caseRevision: member.caseRevision,
        joinedAt: member.joinedAt!,
        memberId: 'user',
        roleIds: ['member'],
        expected: member.roleIds,
        desired: ['case'],
      },
    ],
  };
  const plan = await prepareRestrictionPlan(context, f.selection, f.deps);
  expect(plan.effects.map((e) => e.kind)).toEqual([
    'update_quarantine_policy',
    'quarantine_case_roles',
  ]);
  f.deps.readFresh.mockResolvedValue({
    ...f.state,
    cases: [{ ...member, joinedAt: '2026-11-17T12:00:00Z' }],
  });
  await expect(prepareRestrictionPlan(context, f.selection, f.deps)).rejects.toThrow('stale_state');
});
