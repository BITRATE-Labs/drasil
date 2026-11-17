import { classifyRestrictionRoles } from './restrictionPolicy';
import { facts, role } from './restrictionTestData';

test('standard preserves staff and configured exclusions, compromised removes them', () => {
  const input = facts({
    roles: [role({ id: 'staff', permissions: String(1n << 28n) }), role({ id: 'manual' })],
    manualIntakeRoleId: 'manual',
  });
  expect(
    classifyRestrictionRoles({ ...input, purpose: 'standard_case' }).map((item) => item.skipReason)
  ).toEqual(['privileged role', 'configured exempt role']);
  expect(
    classifyRestrictionRoles({ ...input, purpose: 'compromised_account' }).every(
      (item) => item.removable
    )
  ).toBe(true);
});
test.each([
  [{ botManaged: true }, 'bot-managed role'],
  [{ managed: true }, 'managed role'],
  [{ position: 10 }, 'role is at or above Drasil role'],
] as const)('preserves enforcement skip %s', (overrides, reason) => {
  expect(
    classifyRestrictionRoles({
      ...facts({ roles: [role(overrides)] }),
      purpose: 'standard_case',
    })[0].skipReason
  ).toBe(reason);
});
test('unknown bot hierarchy is not removable', () => {
  expect(
    classifyRestrictionRoles({
      ...facts({ botHighestPosition: null }),
      purpose: 'standard_case',
    }).every((item) => !item.removable)
  ).toBe(true);
});

import { restrictionSelectionSchema, restrictionFactsSchema } from './restrictionTypes';
test('rejects duplicate selected IDs and client-authored effects', () => {
  expect(
    restrictionSelectionSchema.safeParse({
      auditRequestId: 'audit',
      auditRevision: 'revision',
      selectedFixIds: ['fix', 'fix'],
    }).success
  ).toBe(false);
  expect(
    restrictionSelectionSchema.safeParse({
      auditRequestId: 'audit',
      auditRevision: 'revision',
      selectedFixIds: ['fix'],
      effects: [],
    }).success
  ).toBe(false);
  expect(
    restrictionFactsSchema.safeParse(facts({ roles: [role({ permissions: '-1' })] })).success
  ).toBe(false);
});
