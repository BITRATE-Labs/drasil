import { DiscordRestrictionAuditReadPort } from '../../services/DiscordRestrictionAuditReadPort';
import type { Client } from 'discord.js';
import type { IConfigService } from '../../config/ConfigService';
import {
  facts,
  caseFact,
  channel,
} from '../../../packages/application/src/operations/restrictionTestData';
import { assessRestrictionFacts, proposeRestrictionFixes } from '@drasil/application';
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
  it.each(['unowned_failed', 'owned_unknown', 'other_case', 'fresh'] as const)(
    'proposals agree with real append admission for %s roles',
    async (mode) => {
      const f = await fixture();
      await f.prisma.users.create({ data: { discord_id: 'member' } });
      const event = await f.prisma.verification_events.create({
        data: { server_id: 'guild', user_id: 'member' },
      });
      const other =
        mode === 'other_case'
          ? await f.prisma.verification_events.create({
              data: { server_id: 'guild', user_id: 'member' },
            })
          : null;
      await f.prisma.role_quarantine_snapshots.create({
        data: {
          server_id: 'guild',
          user_id: 'member',
          verification_event_id: other?.id ?? event.id,
          original_role_ids: ['member'],
          planned_role_ids: mode === 'fresh' ? [] : ['member'],
          failed_removals: [{ id: 'member', reason: 'transport failed' }],
          metadata:
            mode === 'owned_unknown'
              ? {
                  restriction_role_owners: {
                    member: { requestId: 'old', attemptToken: 'private', state: 'unknown' },
                  },
                }
              : {},
        },
      });
      const reader = new DiscordRestrictionAuditReadPort(
        {} as Client,
        {} as IConfigService,
        f.prisma
      );
      const page = await reader.readCases('guild', null, 50);
      const input = facts({
        cases: [
          caseFact({
            ...page.items.find((item) => item.caseId === event.id)!,
            roleIds: ['case', 'member'],
            metadataAvailable: true,
            joinedAt: '2020-01-01T00:00:00.000Z',
          }),
        ],
        channels: [
          channel({ overwrites: [{ id: 'member', type: 'role', allow: '1024', deny: '0' }] }),
        ],
      });
      const fixes = proposeRestrictionFixes(input, assessRestrictionFacts(input));
      expect(
        fixes.flatMap((fix) => fix.effects).some((e) => e.kind === 'quarantine_case_roles')
      ).toBe(mode === 'fresh');
      const claim = await f.repository.claimNext();
      const attemptToken = (claim!.metadata as Record<string, string>).restriction_attempt_token;
      const appended = await new RoleQuarantineSnapshotRepository(
        f.prisma
      ).appendRestrictionRepairRoles({
        caseId: event.id,
        caseRevision: 0,
        requestId: f.request.id,
        attemptToken,
        userId: 'member',
        roleIds: ['member'],
      });
      expect(appended !== null).toBe(mode === 'fresh');
      if (mode !== 'fresh')
        expect(fixes).toContainEqual(
          expect.objectContaining({
            kind: 'manual',
            summary: expect.stringMatching(/ownership|owns/),
          })
        );
    }
  );
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
  it('terminal completion preserves newer durable progress', async () => {
    const f = await fixture();
    const claim = await f.repository.claimNext();
    const token = (claim!.metadata as Record<string, string>).restriction_attempt_token;
    const progress = {
      schemaVersion: 1 as const,
      revision: 1,
      currentEffectIndex: 0,
      receipts: [{ effectIndex: 0, state: 'applied' as const, observation: null, error: null }],
    };
    expect(await f.store.saveProgress(f.request.id, token, 0, progress)).toBe(true);
    await f.repository.complete(
      f.request.id,
      { restriction_progress: { ...progress, revision: 0, receipts: [] } },
      token
    );
    expect(await f.store.loadProgress(f.request.id)).toEqual(progress);
    expect((await f.repository.findById(f.request.id))!.status).toBe('completed');
  });
  it.each(['started', 'unknown'] as const)(
    'cannot reset %s receipt to not_attempted',
    async (state) => {
      const f = await fixture();
      const claim = await f.repository.claimNext();
      const token = (claim!.metadata as Record<string, string>).restriction_attempt_token;
      const receipt = { effectIndex: 0, state, observation: null, error: null };
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
          currentEffectIndex: 0,
          receipts: [{ ...receipt, state: 'not_attempted' }],
        })
      ).toBe(false);
      expect((await f.store.loadProgress(f.request.id))!.receipts).toEqual([receipt]);
    }
  );
  it('stale generic snapshot metadata cannot erase repair ownership', async () => {
    const f = await fixture();
    await f.prisma.users.create({ data: { discord_id: 'member' } });
    const event = await f.prisma.verification_events.create({
      data: { server_id: 'guild', user_id: 'member' },
    });
    const repository = new RoleQuarantineSnapshotRepository(f.prisma);
    const initial = await repository.create({
      serverId: 'guild',
      userId: 'member',
      verificationEventId: event.id,
      mode: 'automatic',
      originalRoleIds: [],
      plannedRoleIds: [],
      metadata: { existing: true },
    });
    const staleMetadata = initial.metadata;
    const claim = await f.repository.claimNext();
    const token = (claim!.metadata as Record<string, string>).restriction_attempt_token;
    const appended = await repository.appendRestrictionRepairRoles({
      caseId: event.id,
      caseRevision: 0,
      requestId: f.request.id,
      attemptToken: token,
      userId: 'member',
      roleIds: ['new'],
    });
    const updated = await repository.update(initial.id, { metadata: staleMetadata });
    expect((updated!.metadata as Record<string, unknown>).restriction_role_owners).toEqual(
      (appended!.metadata as Record<string, unknown>).restriction_role_owners
    );
    expect(
      await repository.recordRestrictionRepairOutcome({
        snapshotId: initial.id,
        requestId: f.request.id,
        attemptToken: token,
        roleId: 'new',
        state: 'applied',
      })
    ).not.toBeNull();
  });
});
