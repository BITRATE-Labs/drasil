import { facts } from '../../../packages/application/src/operations/restrictionTestData';
import { assessRestrictionFacts } from '@drasil/application';
import { RoleQuarantineSnapshotRepository } from '../../repositories/RoleQuarantineSnapshotRepository';
import { ModerationActionRequestType } from '../../repositories/types';
import { createRestrictionStores } from '@drasil/application/postgres';
import { createBotDelegationDatabase } from '../../application/adapters/delegationDatabase';
import { getPrismaClient } from '../testDb';
import { ModerationActionRequestRepository } from '../../repositories/ModerationActionRequestRepository';
const integration = process.env.JEST_INTEGRATION === '1' ? describe : describe.skip;
integration('restriction request persistence', () => {
  async function fixture() {
    const prisma = getPrismaClient();
    await prisma.servers.create({ data: { guild_id: 'guild' } });
    const request = await prisma.moderation_action_requests.create({
      data: {
        server_id: 'guild',
        actor_id: 'actor',
        actor_surface: 'web',
        action_type: 'apply_case_role_lockdown',
        idempotency_key: 'restriction',
        metadata: { restriction_schema_version: 1 },
      },
    });
    return {
      prisma,
      request,
      repository: new ModerationActionRequestRepository(prisma),
      store: createRestrictionStores(createBotDelegationDatabase(prisma)),
    };
  }
  it('only one claim wins and a replaced owner cannot write', async () => {
    const f = await fixture();
    const claims = await Promise.all([f.repository.claimNext(), f.repository.claimNext()]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const token = (claims.find(Boolean)!.metadata as Record<string, string>)
      .restriction_attempt_token;
    expect(token).toBeTruthy();
    await f.prisma.moderation_action_requests.update({
      where: { id: f.request.id },
      data: { updated_at: new Date(Date.now() - 16 * 60_000) },
    });
    const replacement = await f.repository.claimNext();
    expect(replacement).not.toBeNull();
    expect((replacement!.metadata as Record<string, string>).restriction_attempt_token).not.toBe(
      token
    );
    expect(
      await f.store.saveProgress(f.request.id, token, 0, {
        schemaVersion: 1,
        revision: 1,
        currentEffectIndex: 0,
        receipts: [],
      })
    ).toBe(false);
    await f.repository.heartbeat(f.request.id, token);
    await f.repository.complete(f.request.id, {}, token);
    await f.repository.fail(f.request.id, 'old', token);
    expect((await f.repository.findById(f.request.id))!.status).toBe('processing');
  });
  it('compare-and-swap prevents lost receipts and malformed or foreign reads fail closed', async () => {
    const f = await fixture();
    const claim = await f.repository.claimNext();
    const token = (claim!.metadata as Record<string, string>).restriction_attempt_token;
    const next = { schemaVersion: 1 as const, revision: 1, currentEffectIndex: 0, receipts: [] };
    expect(
      await Promise.all([
        f.store.saveProgress(f.request.id, token, 0, next),
        f.store.saveProgress(f.request.id, token, 0, next),
      ])
    ).toEqual(expect.arrayContaining([true, false]));
    expect((await f.store.loadProgress(f.request.id))!.revision).toBe(1);
    expect(await f.store.load(f.request.id, 'foreign')).toBeNull();
    expect(await f.store.loadPlan(f.request.id)).toBeNull();
  });
  it('concurrent acceptance preserves one immutable selected plan', async () => {
    const f = await fixture();
    const plan = {
      auditRequestId: 'audit',
      auditRevision: 'revision',
      selectedFixIds: ['one'],
      actorId: 'actor',
      guildId: 'guild',
      effects: [],
      materialStateFingerprint: 'frozen',
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    };
    const accept = (selectedFixIds: string[]) =>
      f.repository.enqueue({
        serverId: 'guild',
        actorId: 'actor',
        actorSurface: 'web',
        actionType: ModerationActionRequestType.APPLY_CASE_ROLE_LOCKDOWN,
        idempotencyKey: 'accept',
        metadata: { restriction_schema_version: 1, restriction_plan: { ...plan, selectedFixIds } },
      });
    const accepted = await Promise.all([accept(['one']), accept(['two'])]);
    expect(accepted[0].id).toBe(accepted[1].id);
    const stored = await f.store.loadPlan(accepted[0].id);
    expect([['one'], ['two']]).toContainEqual(stored?.selectedFixIds);
    expect(accepted[0].metadata).toEqual(accepted[1].metadata);
    await accept(['three']);
    expect(await f.store.loadPlan(accepted[0].id)).toEqual(stored);
  });
  it('append preserves earlier roles, blocks competing unknown removal and records late outcomes without reopening', async () => {
    const f = await fixture();
    await f.prisma.users.create({ data: { discord_id: 'member' } });
    const event = await f.prisma.verification_events.create({
      data: { server_id: 'guild', user_id: 'member' },
    });
    const prior = await f.prisma.role_quarantine_snapshots.create({
      data: {
        server_id: 'guild',
        user_id: 'member',
        verification_event_id: event.id,
        original_role_ids: ['earlier'],
        planned_role_ids: ['earlier'],
        removed_role_ids: ['earlier'],
      },
    });
    const claim = await f.repository.claimNext();
    const token = (claim!.metadata as Record<string, string>).restriction_attempt_token;
    const repository = new RoleQuarantineSnapshotRepository(f.prisma);
    const input = {
      caseId: event.id,
      caseRevision: 0,
      requestId: f.request.id,
      attemptToken: token,
      userId: 'member',
      roleIds: ['new'],
    };
    const appended = await repository.appendRestrictionRepairRoles(input);
    expect(appended?.id).toBe(prior.id);
    expect(appended?.planned_role_ids).toEqual(['earlier', 'new']);
    expect(appended?.removed_role_ids).toEqual(['earlier']);
    expect(
      await repository.appendRestrictionRepairRoles({ ...input, roleIds: ['earlier'] })
    ).toBeNull();
    await f.prisma.verification_events.update({
      where: { id: event.id },
      data: { status: 'verified', case_revision: 1 },
    });
    expect(
      await repository.appendRestrictionRepairRoles({ ...input, roleIds: ['later'] })
    ).toBeNull();
    const recorded = await repository.recordRestrictionRepairOutcome({
      snapshotId: prior.id,
      requestId: f.request.id,
      attemptToken: token,
      roleId: 'new',
      state: 'applied',
    });
    expect(recorded?.removed_role_ids).toEqual(['earlier', 'new']);
    expect(
      (await f.prisma.verification_events.findUnique({ where: { id: event.id } }))!.status
    ).toBe('verified');
  });
  it('a later revision cannot erase a durable effect receipt', async () => {
    const f = await fixture();
    const claim = await f.repository.claimNext();
    const token = (claim!.metadata as Record<string, string>).restriction_attempt_token;
    const receipt = { effectIndex: 0, state: 'started' as const, observation: null, error: null };
    expect(
      await f.store.saveProgress(f.request.id, token, 0, {
        schemaVersion: 1,
        revision: 1,
        currentEffectIndex: 0,
        receipts: [receipt],
      })
    ).toBe(true);
    expect(
      await f.store.saveProgress(f.request.id, token, 1, {
        schemaVersion: 1,
        revision: 2,
        currentEffectIndex: 1,
        receipts: [],
      })
    ).toBe(false);
    expect((await f.store.loadProgress(f.request.id))!.receipts).toEqual([receipt]);
  });
  it('loads only a completed valid guild-bound audit version', async () => {
    const f = await fixture();
    const snapshot = facts();
    const audit = {
      schemaVersion: 1,
      guildId: 'guild',
      observedAt: snapshot.observedAt,
      completedAt: snapshot.completedAt,
      revision: 'revision',
      expiresAt: '2026-11-17T12:10:00Z',
      ...assessRestrictionFacts(snapshot),
      coverage: [],
      fixes: [],
      facts: snapshot,
    };
    await f.prisma.moderation_action_requests.update({
      where: { id: f.request.id },
      data: {
        action_type: 'audit_case_role_lockdown',
        status: 'completed',
        result: { restriction_audit: audit },
      },
    });
    expect(await f.store.load(f.request.id, 'guild')).toEqual(audit);
    expect(await f.store.load(f.request.id, 'foreign')).toBeNull();
    await f.prisma.moderation_action_requests.update({
      where: { id: f.request.id },
      data: { result: { restriction_audit: { ...audit, schemaVersion: 2 } } },
    });
    expect(await f.store.load(f.request.id, 'guild')).toBeNull();
  });
});
