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
