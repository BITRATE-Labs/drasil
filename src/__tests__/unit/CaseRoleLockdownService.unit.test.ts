import { type Guild, type GuildMember, Collection } from 'discord.js';
import { CaseRoleLockdownService } from '../../services/CaseRoleLockdownService';
import { fixture } from '../../../packages/application/src/operations/restrictionExecutionTestData';

test('compatibility reports consume the shared assessment without coarse write methods', async () => {
  const f = fixture();
  const service = new CaseRoleLockdownService({ auditGuild: async () => f.audit });
  const report = await service.auditGuild({ id: 'guild' } as Guild);
  expect(report.issues.map((i) => i.code)).toEqual(f.audit.setup.findings.map((i) => i.code));
  expect('applyGuild' in service).toBe(false);
});

test('member assessment keeps staff privilege diagnostics while ignoring removed ordinary roles', async () => {
  const f = fixture();
  const member = {
    id: 'member',
    guild: { id: 'guild', ownerId: 'owner' },
    roles: { cache: new Collection([['case', {}]]) },
    joinedAt: new Date(),
  } as unknown as GuildMember;
  const service = new CaseRoleLockdownService({ auditGuild: async () => f.audit });
  const audit = await service.auditMemberBypasses(member);
  expect(audit.retainedAdministratorRoleIds).toEqual(['case']);
});

test.each(['case', 'guild'])(
  'member containment projection retains dangerous global powers from %s',
  async (target) => {
    const f = fixture();
    f.state.roles.forEach((r) => {
      r.permissions = r.id === target ? '4' : '0';
    });
    const member = {
      id: 'member',
      guild: { id: 'guild', ownerId: 'owner' },
      roles: { cache: new Collection([['case', {}]]) },
      joinedAt: new Date(),
    } as unknown as GuildMember;
    const service = new CaseRoleLockdownService({ auditGuild: async () => f.audit });
    const audit = await service.auditMemberBypasses(member);
    expect(audit.retainedPrivilegedRoleIds).toContain(target);
    expect(audit.assessment?.findingCodes).toContain('retained_privileged_permissions');
  }
);
