import type { IThreadManager } from '../../services/ThreadManager';
import type { IConfigService } from '../../config/ConfigService';
import type { IReportCandidateService } from '../../services/ReportCandidateService';
import { ReportIntakeService } from '../../services/ReportIntakeService';
import { ServerMemberRepository } from '../../repositories/ServerMemberRepository';
import { Prisma } from '../../db/prisma';
import { ReportIntakeRepository } from '../../repositories/ReportIntakeRepository';
import { ServerRepository } from '../../repositories/ServerRepository';
import { UserRepository } from '../../repositories/UserRepository';
import { ReportIntakeStatus, type ReportIntakeUpdate } from '../../repositories/types';
import { getPrismaClient } from '../testDb';
import { InMemoryReportIntakeRepository } from '../fakes/inMemoryRepositories';

const describeIntegration = process.env.JEST_INTEGRATION === '1' ? describe : describe.skip;
describeIntegration('ReportIntakeRepository conditional state (integration)', () => {
  it.each(['postgres', 'memory'])(
    'schedules a settled reporter card when a guarded ban completes (%s)',
    async (backend) => {
      const setup = await pending();
      const repository =
        backend === 'postgres' ? setup.repository : new InMemoryReportIntakeRepository();
      const intake = await repository.create({
        serverId: setup.intake.server_id,
        reporterId: setup.intake.reporter_id,
        status: ReportIntakeStatus.SUBMITTED,
        metadata: {
          workflow: 'staged',
          report_ban_operation_id: 'owned-ban',
          retained: 'evidence',
          reporter_presentation: { nextDueAt: null, followupMessageId: 'receipt' },
        },
      });
      expect(await repository.updateBan(intake.id, 'other-ban', { complete: true })).toBeNull();
      expect((await repository.findById(intake.id))?.metadata).toEqual(intake.metadata);
      expect(
        await repository.updateIfCurrent(intake, {
          metadata: {
            ...(intake.metadata as object),
            reporter_presentation: { nextDueAt: null, restoreArchive: true },
          },
        })
      ).toBeNull();
      const closedAt = new Date().toISOString();
      const finished = await repository.updateBan(intake.id, 'owned-ban', {
        complete: true,
        metadata: {
          observed_action_closed_at: closedAt,
          observed_action_close_reason: 'observed_ban',
        },
      });
      expect(finished).toMatchObject({
        status: ReportIntakeStatus.ACTIONED,
        closed_at: expect.any(Date),
        metadata: {
          report_ban_operation_id: 'owned-ban',
          retained: 'evidence',
          observed_action_closed_at: closedAt,
          reporter_presentation: { nextDueAt: expect.any(String), followupMessageId: 'receipt' },
        },
      });
      expect((await repository.findById(intake.id))?.metadata).toEqual(finished!.metadata);
      expect(
        (await repository.claimPendingPresentation(new Date(), intake.id))?.intake.status
      ).toBe(ReportIntakeStatus.ACTIONED);
      const snapshot = (await repository.findById(intake.id))!;
      const root = snapshot.metadata as Record<string, unknown>;
      const presentation = root.reporter_presentation as Record<string, unknown>;
      const metadata = {
        ...root,
        reporter_presentation: { ...presentation, restoreArchive: true },
      };
      const presented = await repository.updateIfCurrent(snapshot, { metadata });
      expect(presented).toMatchObject({
        metadata: {
          report_ban_operation_id: 'owned-ban',
          reporter_presentation: { restoreArchive: true },
        },
      });
      expect(await repository.updateIfCurrent(snapshot, { metadata })).toBeNull();
      const denied: ReportIntakeUpdate[] = [
        { status: ReportIntakeStatus.SUBMITTED, metadata },
        { closedAt: null, metadata },
        { confirmedTargetUserId: 'another-target', metadata },
        { metadata: { ...metadata, report_ban_operation_id: '' } },
        { metadata: { ...metadata, observed_action_closed_at: null } },
      ];
      for (const change of denied)
        expect(await repository.updateIfCurrent(presented!, change)).toBeNull();
      expect(await repository.update(intake.id, { metadata })).toBeNull();
    }
  );

  it.each(['postgres', 'memory'])(
    'does not schedule reporter work when a ban reservation is only released (%s)',
    async (backend) => {
      const setup = await pending();
      const repository =
        backend === 'postgres' ? setup.repository : new InMemoryReportIntakeRepository();
      const intake = await repository.create({
        serverId: setup.intake.server_id,
        reporterId: setup.intake.reporter_id,
        status: ReportIntakeStatus.SUBMITTED,
        metadata: {
          report_ban_operation_id: 'owned-ban',
          reporter_presentation: { nextDueAt: null },
        },
      });
      const released = await repository.updateBan(intake.id, 'owned-ban', { release: true });
      expect(released?.metadata).toEqual({ reporter_presentation: { nextDueAt: null } });
      expect(released?.status).toBe(ReportIntakeStatus.SUBMITTED);
    }
  );

  it('rejects a confirmation after its metadata snapshot changes', async () => {
    const prisma = getPrismaClient();
    await new ServerRepository(prisma).getOrCreateServer('guild-copy');
    await new UserRepository(prisma).getOrCreateUser(
      'reporter-copy',
      'reporter',
      new Date('2020-01-01')
    );
    const repository = new ReportIntakeRepository(prisma);
    const intake = await repository.create({
      serverId: 'guild-copy',
      reporterId: 'reporter-copy',
      status: ReportIntakeStatus.NEEDS_REPORTER_CONFIRMATION,
      metadata: { prompt: 'old' },
    });
    const selection = {
      targetUserId: 'target-copy',
      expectedMetadata: intake.metadata,
      metadata: { prompt: 'old', confirmed_by: 'reporter-copy' },
    };
    await repository.update(intake.id, { metadata: { prompt: 'new' } });
    expect(await repository.confirmTargetIfUnset(intake.id, selection)).toBeNull();
    expect(await repository.findById(intake.id)).toMatchObject({
      confirmed_target_user_id: null,
      metadata: { prompt: 'new' },
    });
  });
  async function pending() {
    const prisma = getPrismaClient();
    await new ServerRepository(prisma).getOrCreateServer('guild-copy');
    await new UserRepository(prisma).getOrCreateUser(
      'reporter-copy',
      'reporter',
      new Date('2020-01-01')
    );
    const repository = new ReportIntakeRepository(prisma);
    const intake = await repository.create({
      serverId: 'guild-copy',
      reporterId: 'reporter-copy',
      status: ReportIntakeStatus.NEEDS_REPORTER_CONFIRMATION,
      metadata: { a: 1, b: 2 },
    });
    return { prisma, repository, intake };
  }

  it('denies malformed reporter metadata without throwing or losing obligations', async () => {
    const { repository, intake } = await pending();
    const metadata = { reporter_presentation: { openingMessageId: 123, restoreArchive: true } };
    await repository.update(intake.id, { metadata });
    await expect(
      repository.confirmTargetIfUnset(intake.id, {
        targetUserId: 'target-copy',
        expectedMetadata: metadata,
        metadata,
      })
    ).resolves.toBeNull();
    expect((await repository.findById(intake.id))!.metadata).toEqual(metadata);
  });

  it.each([true, false])(
    'only one of confirmation and rejection commits, confirmation first: %s',
    async (confirmationFirst) => {
      const { repository, intake } = await pending();
      const select = () =>
        repository.confirmTargetIfUnset(intake.id, {
          targetUserId: 'target-copy',
          expectedMetadata: intake.metadata,
          metadata: { selected: true },
        });
      const reject = () =>
        repository.updateIfCurrent(intake, {
          status: ReportIntakeStatus.COLLECTING_EVIDENCE,
          metadata: { rejected: true },
        });
      const results = await Promise.all(
        confirmationFirst ? [select(), reject()] : [reject(), select()]
      );
      expect(results.filter(Boolean)).toHaveLength(1);
      const stored = await repository.findById(intake.id);
      if (stored?.confirmed_target_user_id) {
        expect(stored.confirmed_target_user_id).toBe('target-copy');
        expect(stored.status).toBe(ReportIntakeStatus.NEEDS_REPORTER_CONFIRMATION);
      } else {
        expect(stored?.status).toBe(ReportIntakeStatus.COLLECTING_EVIDENCE);
        expect(stored?.metadata).toEqual({ rejected: true });
      }
    }
  );

  it.each([true, false])(
    'submission and thread-close writes retain both outcomes, submit first: %s',
    async (submissionFirst) => {
      const { prisma, repository, intake } = await pending();
      await repository.update(intake.id, { confirmedTargetUserId: 'target-copy' });
      await prisma.report_intakes.update({
        where: { id: intake.id },
        data: { thread_id: 'thread-copy' },
      });
      const service = new ReportIntakeService(
        repository,
        new ServerRepository(prisma),
        new UserRepository(prisma),
        new ServerMemberRepository(prisma),
        {} as IConfigService,
        {} as IReportCandidateService,
        {
          retireReportConfirmationPrompts: jest.fn().mockResolvedValue(undefined),
        } as unknown as IThreadManager
      );
      const submit = () =>
        service.markSubmitted({
          intakeId: intake.id,
          targetUserId: 'target-copy',
          submittedById: 'reporter-copy',
        });
      const close = () =>
        service.closeIntakeForThread({ threadId: 'thread-copy', closedById: 'reporter-copy' });
      const results = await Promise.all(
        submissionFirst ? [submit(), close()] : [close(), submit()]
      );
      expect(results).toContain(true);
      expect(results).toContainEqual(expect.objectContaining({ closed: true }));
      expect(await repository.findById(intake.id)).toMatchObject({
        status: ReportIntakeStatus.SUBMITTED,
        confirmed_target_user_id: 'target-copy',
        metadata: { submitted_by: 'reporter-copy', thread_closed_by: 'reporter-copy' },
      });
    }
  );

  it('compares JSON snapshots independently of object key order', async () => {
    const { repository, intake } = await pending();
    expect(
      await repository.updateIfCurrent(
        { ...intake, metadata: { b: 2, a: 1 } },
        { summary: 'retained' }
      )
    ).toMatchObject({ summary: 'retained' });
    expect(await repository.updateIfCurrent(intake, { metadata: { a: 3 } })).not.toBeNull();
    expect(await repository.updateIfCurrent(intake, { summary: 'stale' })).toBeNull();
  });

  it.each([Prisma.DbNull, Prisma.JsonNull])(
    'handles a null metadata snapshot: %s',
    async (nullValue) => {
      const { prisma, repository, intake } = await pending();
      await prisma.report_intakes.update({
        where: { id: intake.id },
        data: { metadata: nullValue },
      });
      const snapshot = await repository.findById(intake.id);
      if (!snapshot) throw new Error('Fixture intake missing');
      expect(snapshot.metadata).toBeNull();
      expect(
        await repository.updateIfCurrent(snapshot, { metadata: { legacy: true } })
      ).toMatchObject({ metadata: { legacy: true } });
      expect(await repository.updateIfCurrent(snapshot, { summary: 'stale null' })).toBeNull();
    }
  );

  it('rejects an old unconfirmed snapshot after a selection reserves the report', async () => {
    const { repository, intake } = await pending();
    await repository.confirmTargetIfUnset(intake.id, {
      targetUserId: 'target-copy',
      expectedMetadata: intake.metadata,
      metadata: intake.metadata as Record<string, unknown>,
    });
    expect(
      await repository.updateIfCurrent(intake, { status: ReportIntakeStatus.CLOSED_BY_REPORTER })
    ).toBeNull();
    expect(await repository.findById(intake.id)).toMatchObject({
      status: ReportIntakeStatus.NEEDS_REPORTER_CONFIRMATION,
      confirmed_target_user_id: 'target-copy',
    });
  });
});
