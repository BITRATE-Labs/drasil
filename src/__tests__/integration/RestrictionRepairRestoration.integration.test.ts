import { RoleQuarantineSnapshotStatus } from '../../repositories/types';
import { RoleQuarantineService } from '../../services/RoleQuarantineService';
import { RoleQuarantineSnapshotRepository } from '../../repositories/RoleQuarantineSnapshotRepository';
import { VerificationEventRepository } from '../../repositories/VerificationEventRepository';
import { ModerationActionRequestRepository } from '../../repositories/ModerationActionRequestRepository';
import { repairFixture } from '../fixtures/restrictionRepair';
import { getPrismaClient } from '../testDb';
const integration = process.env.JEST_INTEGRATION === '1' ? describe : describe.skip;
integration('restriction repair restoration', () => {
  async function fixture() {
    const f = repairFixture();
    const prisma = getPrismaClient();
    await prisma.servers.create({ data: { guild_id: 'guild' } });
    await prisma.users.create({ data: { discord_id: 'member' } });
    const event = await prisma.verification_events.create({
      data: { server_id: 'guild', user_id: 'member', quarantine_case_role_id: 'case-role' },
    });
    const prior = await prisma.role_quarantine_snapshots.create({
      data: {
        server_id: 'guild',
        user_id: 'member',
        verification_event_id: event.id,
        original_role_ids: ['earlier'],
        planned_role_ids: ['earlier'],
        removed_role_ids: ['earlier'],
      },
    });
    const request = await prisma.moderation_action_requests.create({
      data: {
        server_id: 'guild',
        actor_id: 'actor',
        actor_surface: 'web',
        action_type: 'apply_case_role_lockdown',
        idempotency_key: 'repair',
        metadata: { restriction_schema_version: 1 },
      },
    });
    const claim = await new ModerationActionRequestRepository(prisma).claimNext();
    const fence = {
      ...f.fence,
      requestId: request.id,
      attemptToken: (claim!.metadata as Record<string, string>).restriction_attempt_token,
    };
    const cases = new VerificationEventRepository(prisma);
    const service = new RoleQuarantineService(
      f.config,
      new RoleQuarantineSnapshotRepository(prisma),
      cases
    );
    return { ...f, prisma, event: (await cases.findById(event.id))!, prior, fence, service };
  }
  it('restores prior and repaired removals exactly once', async () => {
    const f = await fixture();
    await f.service.repairCaseRoles(f.member, f.event, ['ordinary'], f.actor, f.fence);
    await f.prisma.verification_events.update({
      where: { id: f.event.id },
      data: { status: 'verified', case_revision: 1 },
    });
    const result = await f.service.restoreMemberRoles(f.member, f.actor);
    expect([...result.restoredRoleIds].sort()).toEqual(['earlier', 'ordinary']);
    expect(f.member.roles.add).toHaveBeenCalledTimes(2);
    expect((await f.service.restoreMemberRoles(f.member, f.actor)).status).toBe(
      'no_active_snapshot'
    );
    expect(f.member.roles.add).toHaveBeenCalledTimes(2);
  });
  it('reconciles an in-flight removal after closure without reopening restored snapshot', async () => {
    const f = await fixture();
    (f.member.roles.remove as jest.Mock).mockImplementation(async () => {
      await f.prisma.verification_events.update({
        where: { id: f.event.id },
        data: { status: 'verified', case_revision: 1 },
      });
      await f.service.restoreMemberRoles(f.member, f.actor);
      f.member.roles.cache.delete('ordinary');
    });
    await f.service.repairCaseRoles(f.member, f.event, ['ordinary'], f.actor, f.fence);
    expect(f.member.roles.cache.has('ordinary')).toBe(true);
    const saved = await f.prisma.role_quarantine_snapshots.findUnique({
      where: { id: f.prior.id },
    });
    expect(saved!.status).toBe('active');
    expect(saved!.removed_role_ids.sort()).toEqual(['earlier', 'ordinary']);
    expect(f.member.roles.add).toHaveBeenCalledTimes(2);
  });
  it('reconciles exact late removal even after losing request ownership', async () => {
    const f = await fixture();
    (f.member.roles.remove as jest.Mock).mockImplementation(async () => {
      await f.prisma.verification_events.update({
        where: { id: f.event.id },
        data: { status: 'verified', case_revision: 1 },
      });
      await f.service.restoreMemberRoles(f.member, f.actor);
      await f.prisma.moderation_action_requests.update({
        where: { id: f.fence.requestId },
        data: { updated_at: new Date(Date.now() - 16 * 60_000) },
      });
      f.member.roles.cache.delete('ordinary');
    });
    await expect(
      f.service.repairCaseRoles(f.member, f.event, ['ordinary'], f.actor, f.fence)
    ).rejects.toThrow('stopped');
    expect(f.member.roles.cache.has('ordinary')).toBe(true);
    const saved = await f.prisma.role_quarantine_snapshots.findUnique({
      where: { id: f.prior.id },
    });
    expect(saved!.status).toBe('active');
    expect(saved!.removed_role_ids).toEqual(['earlier']);
    expect(f.member.roles.add).toHaveBeenCalledTimes(2);
  });
  it('restores from durable unsettled ownership after pending-case lease loss and process-local effects are discarded', async () => {
    const f = await fixture();
    (f.member.roles.remove as jest.Mock).mockImplementation(async () => {
      f.member.roles.cache.delete('ordinary');
      await f.prisma.moderation_action_requests.update({
        where: { id: f.fence.requestId },
        data: { updated_at: new Date(Date.now() - 16 * 60_000) },
      });
    });
    await expect(
      f.service.repairCaseRoles(f.member, f.event, ['ordinary'], f.actor, f.fence)
    ).rejects.toThrow('stopped');
    expect((await f.service.restoreMemberRoles(f.member, f.actor)).status).toBe(
      'held_pending_case'
    );
    expect(f.member.roles.add).not.toHaveBeenCalled();
    await f.prisma.verification_events.update({
      where: { id: f.event.id },
      data: { status: 'verified', case_revision: 1 },
    });
    const restarted = new RoleQuarantineService(
      f.config,
      new RoleQuarantineSnapshotRepository(f.prisma),
      new VerificationEventRepository(f.prisma)
    );
    const restored = await restarted.restoreMemberRoles(f.member, f.actor);
    expect(restored.status).toBe('partially_restored');
    expect([...restored.restoredRoleIds].sort()).toEqual(['earlier', 'ordinary']);
    expect(
      (await f.prisma.role_quarantine_snapshots.findUnique({ where: { id: f.prior.id } }))!.status
    ).toBe('active');
    const staleFinalize = await new RoleQuarantineSnapshotRepository(f.prisma).update(f.prior.id, {
      status: RoleQuarantineSnapshotStatus.RESTORED,
      restoredAt: new Date(),
    });
    expect(staleFinalize!.status).toBe('active');
    await restarted.restoreMemberRoles(f.member, f.actor);
    expect(f.member.roles.add).toHaveBeenCalledTimes(2);
  });
  it('does not report fully restored when ownership is appended after the restoration read', async () => {
    const f = await fixture();
    (f.member.roles.add as jest.Mock).mockImplementation(async (role: { id: string }) => {
      const appended = await new RoleQuarantineSnapshotRepository(
        f.prisma
      ).appendRestrictionRepairRoles({
        caseId: f.event.id,
        caseRevision: 0,
        requestId: f.fence.requestId,
        attemptToken: f.fence.attemptToken,
        userId: 'member',
        roleIds: ['ordinary'],
      });
      expect(appended).not.toBeNull();
      await f.prisma.verification_events.update({
        where: { id: f.event.id },
        data: { status: 'verified', case_revision: 1 },
      });
      f.member.roles.cache.set(role.id, f.earlier);
    });
    const result = await f.service.restoreMemberRoles(f.member, f.actor);
    expect(result.status).toBe('partially_restored');
    expect(
      (await f.prisma.role_quarantine_snapshots.findUnique({ where: { id: f.prior.id } }))!.status
    ).toBe('active');
  });
});
