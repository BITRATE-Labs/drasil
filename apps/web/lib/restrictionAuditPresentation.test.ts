import { expect, it } from 'vitest';
import { describeRestrictionEffect } from './restrictionAuditPresentation';
const names = {
  channels: new Map([['channel', 'rules']]),
  roles: new Map([['role', 'Community']]),
};
it('names exact overwrite effects without raw bitfields', () => {
  const copy = describeRestrictionEffect(
    {
      kind: 'edit_overwrite',
      guildId: 'guild',
      channelId: 'channel',
      roleId: 'role',
      expected: null,
      desired: { allow: '0', deny: '274877906944' },
    },
    names
  );
  expect(copy).toContain('Deny Send Messages In Threads for Community in #rules');
  expect(copy).not.toContain('274877906944');
});
it('describes both future policy and current member removal without claiming population counts', () => {
  const policy = describeRestrictionEffect(
    {
      kind: 'update_quarantine_policy',
      guildId: 'guild',
      expected: { quarantineMode: 'off', exemptRoleIds: ['role'], manualIntakeRoleId: null },
      desired: { quarantineMode: 'on', exemptRoleIds: [], manualIntakeRoleId: null },
    },
    names
  );
  const member = describeRestrictionEffect(
    {
      kind: 'quarantine_case_roles',
      guildId: 'guild',
      caseId: 'case',
      caseRevision: 'revision',
      joinedAt: new Date().toISOString(),
      memberId: 'member',
      roleIds: ['role'],
      expected: ['role'],
      desired: [],
    },
    names
  );
  expect(policy).toContain('Include Community in future quarantines');
  expect(member).toContain('Remove and save Community for member member');
  expect(member).toContain('Other members keep their roles');
});
it('keeps grouped category review descriptions scoped to each assessed synchronized child', async () => {
  const { fixtureGroupedCategoryRestrictionAudit } = await import('./restrictionAuditFixtures');
  const { presentRestrictionFix } = await import('./restrictionAuditPresentation');
  const audit = fixtureGroupedCategoryRestrictionAudit();
  const context = {
    ...names,
    channels: new Map(audit.facts.channels.map((c) => [c.id, c.name])),
    categories: new Set(['category-a', 'category-b']),
    assessedChannels: audit.facts.channels,
  };
  const copy = presentRestrictionFix(audit.fixes[0], context).after;
  expect(copy).toContain(
    'in #Category A. Applies to role 910000000000000021 holders. Synchronized child channels also affected: #a-child.'
  );
  expect(copy).toContain(
    'in #Category B. Applies to role 910000000000000021 holders. Synchronized child channels also affected: #b-child.'
  );
  expect(copy).not.toContain('#a-independent');
});
