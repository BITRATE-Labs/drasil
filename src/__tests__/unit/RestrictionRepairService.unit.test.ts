import { createBotRestrictionEffects } from '../../application/adapters/restriction';
import { facts, channel } from '../../../packages/application/src/operations/restrictionTestData';
import type { Client } from 'discord.js';
import type { IRestrictionAuditService } from '../../services/RestrictionAuditService';
import {
  RoleQuarantineService,
  type IRoleQuarantineService,
} from '../../services/RoleQuarantineService';
import { repairFixture } from '../fixtures/restrictionRepair';
import type { IRoleQuarantineSnapshotRepository } from '../../repositories/RoleQuarantineSnapshotRepository';
import type { IVerificationEventRepository } from '../../repositories/VerificationEventRepository';
import { RoleQuarantineSnapshotPurpose } from '../../repositories/types';
function fixture() {
  const f = repairFixture();
  const snapshot = {
    id: 'snapshot',
    server_id: 'guild',
    user_id: 'member',
    purpose: RoleQuarantineSnapshotPurpose.STANDARD_CASE,
    original_role_ids: ['earlier', 'ordinary'],
    planned_role_ids: ['earlier', 'ordinary'],
    removed_role_ids: ['earlier'],
    created_at: new Date(),
  };
  const snapshots = {
    appendRestrictionRepairRoles: jest.fn().mockResolvedValue(snapshot),
    recordRestrictionRepairOutcome: jest.fn().mockResolvedValue(snapshot),
  };
  const cases = {
    findById: jest.fn(async () => f.event),
    findActiveByUserAndServer: jest.fn(async () => f.event),
  };
  return {
    ...f,
    snapshots,
    cases,
    service: new RoleQuarantineService(
      f.config,
      snapshots as unknown as IRoleQuarantineSnapshotRepository,
      cases as unknown as IVerificationEventRepository
    ),
  };
}
test('saves snapshot ownership before selected removal', async () => {
  const f = fixture();
  const result = await f.service.repairCaseRoles(f.member, f.event, ['ordinary'], f.actor, f.fence);
  expect(result.removedRoleIds).toEqual(['ordinary']);
  expect(f.snapshots.appendRestrictionRepairRoles.mock.invocationCallOrder[0]).toBeLessThan(
    (f.member.roles.remove as jest.Mock).mock.invocationCallOrder[0]
  );
  expect(f.snapshots.recordRestrictionRepairOutcome).toHaveBeenCalledWith(
    expect.objectContaining({ roleId: 'ordinary', state: 'applied' })
  );
});
test.each(['closed', 'departed', 'staff', 'hierarchy', 'fence'])(
  'does not begin removal after %s change',
  async (mode) => {
    const f = fixture();
    if (mode === 'closed')
      f.cases.findById.mockResolvedValue({ ...f.event, status: 'verified' } as typeof f.event);
    if (mode === 'departed')
      (f.member.guild.members.fetch as jest.Mock).mockRejectedValue(new Error('gone'));
    if (mode === 'staff') Object.assign(f.ordinary, { permissions: { bitfield: 8n } });
    if (mode === 'hierarchy') Object.assign(f.ordinary, { position: 101 });
    if (mode === 'fence') f.fence.assertOwner.mockRejectedValue(new Error('lost'));
    await expect(
      f.service.repairCaseRoles(f.member, f.event, ['ordinary'], f.actor, f.fence)
    ).rejects.toThrow();
    expect(f.member.roles.remove).not.toHaveBeenCalled();
  }
);

test('overwrite adapter changes only approved bits and read-back does not trust API success', async () => {
  const f = fixture();
  const edit = jest.fn().mockResolvedValue(undefined);
  const input = facts({
    channels: [channel({ overwrites: [{ id: 'case', type: 'role', allow: '17408', deny: '0' }] })],
  });
  const target = {
    permissionOverwrites: {
      cache: new Map([['case', { type: 0, allow: { bitfield: 17408n }, deny: { bitfield: 0n } }]]),
      edit,
    },
  };
  const client = {
    guilds: {
      fetch: jest
        .fn()
        .mockResolvedValue({ channels: { fetch: jest.fn().mockResolvedValue(target) } }),
    },
  } as unknown as Client;
  const auditService = {
    auditGuild: jest.fn().mockResolvedValue({ facts: input }),
  } as unknown as IRestrictionAuditService;
  const adapter = createBotRestrictionEffects({
    client,
    configService: f.config,
    cases: f.cases as unknown as IVerificationEventRepository,
    quarantine: f.service,
    auditService,
    actorId: 'actor',
    repairFence: f.fence,
  });
  const effect = {
    kind: 'edit_overwrite' as const,
    guildId: 'guild',
    channelId: 'channel',
    roleId: 'case',
    expected: { allow: '17408', deny: '0' },
    desired: { allow: '16384', deny: '1024' },
  };
  await adapter.write(effect);
  expect(edit).toHaveBeenCalledWith('case', { ViewChannel: false }, expect.anything());
  expect((await adapter.observe(effect)).state).toBe('before_observed');
});
test('unsync adapter rejects a changed frozen source before writing', async () => {
  const f = fixture();
  const set = jest.fn();
  const input = facts({
    channels: [channel({ id: 'child', parentId: 'parent', permissionsLocked: true })],
  });
  const child = {
    parentId: 'parent',
    permissionsLocked: true,
    permissionOverwrites: { cache: new Map(), set },
  };
  const parent = {
    permissionOverwrites: {
      cache: new Map([
        ['changed', { id: 'changed', type: 0, allow: { bitfield: 1024n }, deny: { bitfield: 0n } }],
      ]),
    },
  };
  const client = {
    guilds: {
      fetch: jest.fn().mockResolvedValue({
        channels: { fetch: jest.fn(async (id: string) => (id === 'child' ? child : parent)) },
      }),
    },
  } as unknown as Client;
  const auditService = {
    auditGuild: jest.fn().mockResolvedValue({ facts: input }),
  } as unknown as IRestrictionAuditService;
  const adapter = createBotRestrictionEffects({
    client,
    configService: f.config,
    cases: f.cases as unknown as IVerificationEventRepository,
    quarantine: f.service as IRoleQuarantineService,
    auditService,
    actorId: 'actor',
    repairFence: f.fence,
  });
  await expect(
    adapter.write({
      kind: 'unsync_channel',
      guildId: 'guild',
      channelId: 'child',
      parentId: 'parent',
      expected: [],
      desired: [{ id: 'case', type: 'role', allow: '0', deny: '1024' }],
    })
  ).rejects.toThrow('source changed');
  expect(set).not.toHaveBeenCalled();
});
