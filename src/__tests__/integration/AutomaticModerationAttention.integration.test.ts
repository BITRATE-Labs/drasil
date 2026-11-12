import { EventHandler } from '../../controllers/EventHandler';
import {
  PermissionFlagsBits,
  PermissionsBitField,
  type Message,
  type Client,
  type GuildMember,
} from 'discord.js';
import { SecurityActionService } from '../../services/SecurityActionService';
import { ServerMemberRepository } from '../../repositories/ServerMemberRepository';
import type { INotificationManager } from '../../services/NotificationManager';
import type { IAdminActionService } from '../../services/AdminActionService';
import type { IThreadManager } from '../../services/ThreadManager';
import type {
  IUserModerationService,
  ICombinedBanLifecycleService,
} from '../../services/UserModerationService';
import { createAttentionActions, readAutomaticModerationResponse } from '@drasil/application';
import { DetectionEventsRepository } from '../../repositories/DetectionEventsRepository';
import { ModerationQueueRepository } from '../../repositories/ModerationQueueRepository';
import { ServerRepository } from '../../repositories/ServerRepository';
import { UserRepository } from '../../repositories/UserRepository';
import { ModerationQueueService } from '../../services/ModerationQueueService';
import {
  VerificationEventRepository,
  type IVerificationEventRepository,
} from '../../repositories/VerificationEventRepository';
import {
  AdminActionType,
  DetectionType,
  CaseAttentionState,
  VerificationStatus,
  ModerationQueueItemType,
} from '../../repositories/types';
import type { IConfigService } from '../../config/ConfigService';
import { getPrismaClient } from '../testDb';
const suite = process.env.JEST_INTEGRATION === '1' ? describe : describe.skip;
const response = {
  action: 'kick',
  outcome: 'kicked',
  updatedAt: '2026-11-11T00:00:00.000Z',
  failures: [{ step: 'notification', code: 'notification_delivery_failed' }],
  attention: 'required',
  caseId: null,
};
suite('automatic moderation attention', () => {
  async function fixture() {
    const prisma = getPrismaClient();
    const servers = new ServerRepository(prisma);
    const server = await servers.getOrCreateServer('attention-guild');
    await new UserRepository(prisma).getOrCreateUser(
      'attention-user',
      'synthetic',
      new Date('2020-01-01')
    );
    const detections = new DetectionEventsRepository(prisma);
    const queue = new ModerationQueueRepository(prisma);
    const event = await detections.create({
      server_id: server.guild_id,
      user_id: 'attention-user',
      detection_type: DetectionType.SUSPICIOUS_CONTENT,
      confidence: 0.1,
      metadata: { observed_action: 'kick', automatic_moderation_response: response },
    });
    const service = new ModerationQueueService(
      { channels: { fetch: jest.fn() } } as unknown as Client,
      { getServerConfig: async () => server } as unknown as IConfigService,
      servers,
      { findReviewablePendingByServer: async () => [] } as unknown as IVerificationEventRepository,
      detections,
      queue
    );
    return { prisma, server, detections, queue, event, service };
  }
  it.each(['pending', 'failed', 'unknown', 'kicked'] as const)(
    'closes %s response through the real service without member access and never resurrects it',
    async (outcome) => {
      const f = await fixture();
      await f.detections.patchMetadata(f.event.id, {
        automatic_moderation_response: { ...response, outcome },
      });
      await f.service.upsertObservedAlertMirrorById(f.event.id);
      const security = new SecurityActionService(
        {} as INotificationManager,
        f.detections,
        new ServerMemberRepository(f.prisma),
        new VerificationEventRepository(f.prisma),
        new UserRepository(f.prisma),
        new ServerRepository(f.prisma),
        {} as IAdminActionService,
        {} as IThreadManager,
        {} as IUserModerationService & ICombinedBanLifecycleService,
        {} as Client,
        undefined,
        undefined,
        f.service
      );
      expect(
        await security.dismissObservedDetection(
          f.server.guild_id,
          'attention-user',
          f.event.id,
          { id: 'moderator' } as import('discord.js').User,
          AdminActionType.DISMISS
        )
      ).toBe(true);
      await f.service.syncServerQueue(f.server.guild_id);
      const saved = await f.detections.findById(f.event.id);
      expect(saved?.metadata).toMatchObject({
        observed_action: 'kick',
        automatic_response_resolved_by: 'moderator',
        automatic_moderation_response: {
          outcome,
          failures: response.failures,
          attention: 'resolved',
        },
      });
      expect(await f.queue.findByObservedAlert(f.event.id)).toBeNull();
      await f.service.upsertObservedAlertMirror(f.event);
      expect(await f.queue.findByObservedAlert(f.event.id)).toBeNull();
    }
  );
  it('durable close survives Discord cleanup failure, and a later changed outcome renews attention', async () => {
    const f = await fixture();
    await f.detections.patchMetadata(f.event.id, {
      automatic_moderation_response: { ...response, outcome: 'pending', failures: [] },
    });
    await f.service.upsertObservedAlertMirrorById(f.event.id);
    const cleanup = jest
      .spyOn(f.service, 'deleteQueueMessage')
      .mockRejectedValue(new Error('Discord unavailable'));
    const security = new SecurityActionService(
      {
        upsertObservedDetectionNotification: jest.fn().mockResolvedValue(null),
      } as unknown as INotificationManager,
      f.detections,
      new ServerMemberRepository(f.prisma),
      new VerificationEventRepository(f.prisma),
      new UserRepository(f.prisma),
      new ServerRepository(f.prisma),
      {} as IAdminActionService,
      {} as IThreadManager,
      {} as IUserModerationService & ICombinedBanLifecycleService,
      {} as Client,
      undefined,
      undefined,
      f.service
    );
    expect(
      await security.dismissObservedDetection(
        f.server.guild_id,
        'attention-user',
        f.event.id,
        { id: 'moderator' } as import('discord.js').User,
        AdminActionType.DISMISS
      )
    ).toBe(true);
    expect(
      readAutomaticModerationResponse((await f.detections.findById(f.event.id))?.metadata)
        ?.attention
    ).toBe('resolved');
    expect(await f.queue.findByObservedAlert(f.event.id)).not.toBeNull();
    cleanup.mockRestore();
    await security.recordAutomaticResponseFailure(
      {
        id: 'attention-user',
        guild: { id: f.server.guild_id },
        user: { id: 'attention-user', username: 'synthetic', createdTimestamp: 0 },
      } as GuildMember,
      {
        label: 'SUSPICIOUS',
        confidence: 0.8,
        reasons: [],
        triggerSource: DetectionType.SUSPICIOUS_CONTENT,
        triggerContent: '',
        detectionEventId: f.event.id,
      },
      {
        action: 'kick',
        outcome: 'unknown',
        attention: 'required',
        caseId: null,
        updatedAt: new Date().toISOString(),
        failures: [{ step: 'kick', code: 'kick_outcome_unknown' }],
      }
    );
    expect(
      readAutomaticModerationResponse((await f.detections.findById(f.event.id))?.metadata)
    ).toMatchObject({ outcome: 'unknown', attention: 'required' });
    expect(await f.queue.findByObservedAlert(f.event.id)).not.toBeNull();
  });
  it.each(['notify', 'restrict'] as const)(
    'closing %s attention is idempotent and cannot close a transferred case',
    async (action) => {
      const f = await fixture();
      const original = { ...response, action, outcome: 'failed' };
      await f.detections.updateMetadata(f.event.id, { automatic_moderation_response: original });
      const security = new SecurityActionService(
        {} as INotificationManager,
        f.detections,
        new ServerMemberRepository(f.prisma),
        new VerificationEventRepository(f.prisma),
        new UserRepository(f.prisma),
        new ServerRepository(f.prisma),
        {} as IAdminActionService,
        {} as IThreadManager,
        {} as IUserModerationService & ICombinedBanLifecycleService,
        {} as Client
      );
      const moderator = { id: 'moderator' } as import('discord.js').User;
      expect(
        await security.dismissObservedDetection(
          f.server.guild_id,
          'attention-user',
          f.event.id,
          moderator,
          AdminActionType.DISMISS
        )
      ).toBe(true);
      const saved = await f.detections.findById(f.event.id);
      expect(
        await security.dismissObservedDetection(
          f.server.guild_id,
          'attention-user',
          f.event.id,
          moderator,
          AdminActionType.DISMISS
        )
      ).toBe(false);
      expect((await f.detections.findById(f.event.id))?.metadata).toEqual(saved?.metadata);
      expect(
        await f.detections.claimObservedAction(f.event.id, {
          observed_action: 'kick',
          observed_action_by: 'stale-moderator',
        })
      ).toBeNull();
      await f.detections.patchMetadata(f.event.id, {
        automatic_moderation_response: {
          ...original,
          caseId: '32fb6a35-e54e-48d7-879d-a67e5e96bd92',
        },
      });
      expect(
        await security.dismissObservedDetection(
          f.server.guild_id,
          'attention-user',
          f.event.id,
          moderator,
          AdminActionType.DISMISS
        )
      ).toBe(false);
    }
  );

  it('a stale close cleanup preserves failure attention renewed after completion committed', async () => {
    const f = await fixture();
    await f.service.upsertObservedAlertMirrorById(f.event.id);
    let committed!: () => void;
    let resume!: () => void;
    const saved = new Promise<void>((resolve) => {
      committed = resolve;
    });
    const paused = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const complete = f.detections.completeAutomaticResponseAttention.bind(f.detections);
    jest
      .spyOn(f.detections, 'completeAutomaticResponseAttention')
      .mockImplementationOnce(async (input) => {
        const result = await complete(input);
        committed();
        await paused;
        return result;
      });
    const security = new SecurityActionService(
      {} as INotificationManager,
      f.detections,
      new ServerMemberRepository(f.prisma),
      new VerificationEventRepository(f.prisma),
      new UserRepository(f.prisma),
      new ServerRepository(f.prisma),
      {} as IAdminActionService,
      {} as IThreadManager,
      {} as IUserModerationService & ICombinedBanLifecycleService,
      {} as Client,
      undefined,
      undefined,
      f.service
    );
    const closing = security.dismissObservedDetection(
      f.server.guild_id,
      'attention-user',
      f.event.id,
      { id: 'moderator' } as import('discord.js').User,
      AdminActionType.DISMISS
    );
    await saved;
    try {
      await f.detections.patchMetadata(f.event.id, {
        automatic_moderation_response: {
          ...response,
          failures: [{ step: 'persistence', code: 'persistence_failed' }],
          updatedAt: new Date().toISOString(),
        },
      });
      await f.service.upsertObservedAlertMirrorById(f.event.id);
    } finally {
      resume();
    }
    expect(await closing).toBe(true);
    const current = await f.queue.findByObservedAlert(f.event.id);
    expect(readAutomaticModerationResponse(current?.metadata)).toMatchObject({
      attention: 'required',
      failures: [{ step: 'persistence', code: 'persistence_failed' }],
    });
  });

  it('completion CAS tolerates acknowledgement but rejects changed failure, guild, user, outcome and owner', async () => {
    const f = await fixture();
    const original = readAutomaticModerationResponse(f.event.metadata)!;
    const input = {
      detectionEventId: f.event.id,
      serverId: f.server.guild_id,
      userId: 'attention-user',
      expectedResponse: original,
      actorId: 'moderator',
      completedAt: new Date(),
    };
    for (const change of [
      { outcome: 'unknown' },
      { caseId: '32fb6a35-e54e-48d7-879d-a67e5e96bd92' },
      { failures: [{ step: 'persistence', code: 'persistence_failed' }] },
    ]) {
      await f.detections.patchMetadata(f.event.id, {
        automatic_moderation_response: { ...response, ...change },
      });
      expect(await f.detections.completeAutomaticResponseAttention(input)).toBeNull();
    }
    await f.detections.patchMetadata(f.event.id, {
      automatic_moderation_response: { ...response, attention: 'acknowledged' },
    });
    expect(
      await f.detections.completeAutomaticResponseAttention({ ...input, serverId: 'other' })
    ).toBeNull();
    expect(
      await f.detections.completeAutomaticResponseAttention({ ...input, userId: 'other' })
    ).toBeNull();
    expect(await f.detections.completeAutomaticResponseAttention(input)).not.toBeNull();
    expect(await f.detections.completeAutomaticResponseAttention(input)).toBeNull();
  });
  it('acknowledgement racing completion cannot reopen the response', async () => {
    const f = await fixture();
    await f.service.upsertObservedAlertMirrorById(f.event.id);
    const queue = (await f.queue.findByObservedAlert(f.event.id))!;
    await Promise.all([
      f.queue.acknowledgeAutomaticResponse({
        itemId: queue.id,
        guildId: f.server.guild_id,
        actorId: 'reader',
        acknowledgedAt: new Date(),
      }),
      f.detections.completeAutomaticResponseAttention({
        detectionEventId: f.event.id,
        serverId: f.server.guild_id,
        userId: 'attention-user',
        expectedResponse: readAutomaticModerationResponse(f.event.metadata)!,
        actorId: 'closer',
        completedAt: new Date(),
      }),
    ]);
    expect(
      readAutomaticModerationResponse((await f.detections.findById(f.event.id))?.metadata)
        ?.attention
    ).toBe('resolved');
    await f.service.syncServerQueue(f.server.guild_id);
    expect(await f.queue.findByObservedAlert(f.event.id)).toBeNull();
  });

  it.each(['null', 'throw'])(
    'staff watchlist delivery %s leaves one durable notify attention without enforcement',
    async (failure) => {
      const f = await fixture();
      await f.prisma.detection_events.delete({ where: { id: f.event.id } });
      const deliver =
        failure === 'null'
          ? jest.fn().mockResolvedValue(null)
          : jest.fn().mockRejectedValue(new Error('private provider error'));
      const notifications = {
        upsertObservedDetectionNotification: deliver,
      } as unknown as INotificationManager;
      const cases = new VerificationEventRepository(f.prisma);
      const enforce = jest.fn();
      const security = new SecurityActionService(
        notifications,
        f.detections,
        new ServerMemberRepository(f.prisma),
        cases,
        new UserRepository(f.prisma),
        new ServerRepository(f.prisma),
        {} as IAdminActionService,
        {} as IThreadManager,
        { applyCaseRole: enforce, kickUser: enforce } as unknown as IUserModerationService &
          ICombinedBanLifecycleService,
        {} as Client,
        undefined,
        undefined,
        f.service
      );
      const config = {
        initialize: jest.fn().mockResolvedValue(undefined),
        getCachedServerConfig: () => f.server,
        getServerConfig: async () => ({
          ...f.server,
          settings: { detection_response_mode: 'restrict' },
        }),
      } as unknown as IConfigService;
      type Dependencies = ConstructorParameters<typeof EventHandler>;
      const handler = new EventHandler(
        {} as Client,
        {} as Dependencies[1],
        notifications,
        config,
        security,
        {} as Dependencies[5],
        {} as Dependencies[6],
        {} as Dependencies[7],
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        f.service,
        undefined,
        undefined,
        {
          findEnabled: async () => [
            {
              id: 'test-watchlist',
              label: 'Synthetic watched link',
              term: 'riskydomain.test',
              requiresLinkOrVideo: true,
            },
          ],
        } as unknown as Dependencies[18]
      );
      const member = {
        id: 'attention-user',
        guild: { id: f.server.guild_id },
        permissions: new PermissionsBitField(PermissionFlagsBits.KickMembers),
        user: { id: 'attention-user', username: 'synthetic', createdTimestamp: 0 },
      } as unknown as GuildMember;
      const message = {
        id: 'synthetic-message',
        author: { id: member.id, bot: false },
        guild: member.guild,
        member,
        system: false,
        content: 'riskydomain.test https://example.com/video',
        channelId: 'synthetic-channel',
        channel: { isThread: () => false },
        delete: jest.fn(),
      } as unknown as Message;
      await handler['handleMessage'](message);
      expect(deliver).toHaveBeenCalledTimes(1);
      const rows = await f.queue.listByServer(f.server.guild_id);
      expect(rows).toHaveLength(1);
      expect(readAutomaticModerationResponse(rows[0].metadata)).toMatchObject({
        action: 'notify',
        outcome: 'failed',
        attention: 'required',
        caseId: null,
        failures: [{ step: 'notification', code: 'notification_delivery_failed' }],
      });
      expect(await f.prisma.verification_events.count()).toBe(0);
      expect(await f.prisma.detection_events.count()).toBe(1);
      expect(enforce).not.toHaveBeenCalled();
      expect(message.delete).not.toHaveBeenCalled();
      expect(JSON.stringify(rows)).not.toContain('private provider error');
    }
  );
  it.each([false, true])(
    'refreshes no-case delivery failure after acknowledgement during delivery (already known: %s)',
    async (alreadyKnown) => {
      const f = await fixture();
      const initial = {
        action: 'kick' as const,
        outcome: 'kicked' as const,
        attention: 'required' as const,
        caseId: null,
        updatedAt: new Date().toISOString(),
        failures: [{ step: 'persistence' as const, code: 'persistence_failed' as const }],
      };
      await f.detections.updateMetadata(f.event.id, {
        automatic_moderation_response: {
          ...initial,
          failures: [...initial.failures, ...(alreadyKnown ? response.failures : [])],
        },
      });
      let acknowledged:
        Awaited<ReturnType<typeof f.queue.acknowledgeAutomaticResponse>> | undefined;
      const deliver = jest.fn().mockImplementation(async () => {
        const item = (await f.queue.findByObservedAlert(f.event.id))!;
        acknowledged = await f.queue.acknowledgeAutomaticResponse({
          itemId: item.id,
          guildId: f.server.guild_id,
          actorId: 'staff',
          acknowledgedAt: new Date(),
        });
        return null;
      });
      const security = new SecurityActionService(
        { upsertObservedDetectionNotification: deliver } as unknown as INotificationManager,
        f.detections,
        new ServerMemberRepository(f.prisma),
        new VerificationEventRepository(f.prisma),
        new UserRepository(f.prisma),
        new ServerRepository(f.prisma),
        {} as IAdminActionService,
        {} as IThreadManager,
        {} as IUserModerationService & ICombinedBanLifecycleService,
        {} as Client,
        undefined,
        undefined,
        f.service
      );
      await security.recordAutomaticResponseFailure(
        {
          id: 'attention-user',
          guild: { id: f.server.guild_id },
          user: { username: 'synthetic' },
        } as GuildMember,
        {
          label: 'SUSPICIOUS',
          confidence: 0.8,
          reasons: [],
          triggerSource: DetectionType.SUSPICIOUS_CONTENT,
          triggerContent: '',
          detectionEventId: f.event.id,
        },
        initial
      );
      const saved = readAutomaticModerationResponse(
        (await f.detections.findById(f.event.id))?.metadata
      );
      expect(saved).toMatchObject({
        action: 'kick',
        outcome: 'kicked',
        attention: alreadyKnown ? 'acknowledged' : 'required',
        failures: [...initial.failures, ...response.failures],
      });
      const rows = await f.queue.listByServer(f.server.guild_id);
      expect(rows).toHaveLength(1);
      expect(acknowledged).toBe('acknowledged');
      expect(readAutomaticModerationResponse(rows[0].metadata)).toEqual(saved);
      expect(deliver).toHaveBeenCalledTimes(1);
    }
  );
  it('persists one case mirror with no Discord destinations and never an observed failure duplicate', async () => {
    const f = await fixture();
    await f.service.upsertObservedAlertMirrorById(f.event.id);
    expect(await f.queue.findByObservedAlert(f.event.id)).not.toBeNull();
    const cases = new VerificationEventRepository(f.prisma);
    const owner = await cases.createFromDetection(
      f.event.id,
      f.server.guild_id,
      'attention-user',
      VerificationStatus.PENDING,
      {
        action_failures: [
          { action: 'case_role', message: 'role_assignment_failed', at: new Date().toISOString() },
        ],
      }
    );
    await f.detections.linkToVerificationEvent(f.event.id, owner.id);
    await f.detections.patchMetadata(f.event.id, {
      automatic_moderation_response: {
        action: 'restrict',
        outcome: 'case_opened',
        updatedAt: new Date().toISOString(),
        attention: 'required',
        caseId: owner.id,
        failures: [{ step: 'role', code: 'role_assignment_failed' }],
      },
    });
    const security = new SecurityActionService(
      {} as INotificationManager,
      f.detections,
      new ServerMemberRepository(f.prisma),
      cases,
      new UserRepository(f.prisma),
      new ServerRepository(f.prisma),
      {} as IAdminActionService,
      {} as IThreadManager,
      {} as IUserModerationService & ICombinedBanLifecycleService,
      {} as Client,
      undefined,
      undefined,
      f.service
    );
    const member = {
      id: 'attention-user',
      guild: { id: f.server.guild_id },
      user: { id: 'attention-user', username: 'synthetic' },
    } as GuildMember;
    const detection = {
      label: 'SUSPICIOUS' as const,
      confidence: 0.8,
      reasons: [],
      triggerSource: DetectionType.SUSPICIOUS_CONTENT,
      triggerContent: '',
      detectionEventId: f.event.id,
    };
    await security.recordAutomaticResponseFailure(member, detection, {
      action: 'restrict',
      outcome: 'case_opened',
      updatedAt: new Date().toISOString(),
      attention: 'required',
      caseId: owner.id,
      failures: [{ step: 'role', code: 'role_assignment_failed' }],
    });
    await security.recordAutomaticResponseFailure(member, detection, {
      action: 'restrict',
      outcome: 'case_opened',
      updatedAt: new Date().toISOString(),
      attention: 'required',
      caseId: owner.id,
      failures: [{ step: 'role', code: 'role_assignment_failed' }],
    });
    const rows = await f.queue.listByCase(owner.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      item_type: ModerationQueueItemType.CASE_MIRROR,
      queue_message_id: null,
    });
    expect(await f.queue.findByObservedAlert(f.event.id)).toBeNull();
  });

  it.each([VerificationStatus.KICKED, VerificationStatus.PENDING])(
    'retains detection attention for a non-reviewable case (%s)',
    async (status) => {
      const f = await fixture();
      await f.service.upsertObservedAlertMirrorById(f.event.id);
      expect(await f.queue.findByObservedAlert(f.event.id)).not.toBeNull();
      const cases = new VerificationEventRepository(f.prisma);
      const owner = await cases.createFromDetection(
        f.event.id,
        f.server.guild_id,
        'attention-user',
        status,
        {
          action_failures: [
            {
              action: 'case_role',
              message: 'role_assignment_failed',
              at: new Date().toISOString(),
            },
          ],
        }
      );
      if (status === VerificationStatus.PENDING)
        await f.prisma.verification_events.update({
          where: { id: owner.id },
          data: { attention_state: CaseAttentionState.PARKED },
        });
      await f.detections.linkToVerificationEvent(f.event.id, owner.id);
      await f.detections.patchMetadata(f.event.id, {
        automatic_moderation_response: {
          action: 'kick',
          outcome: 'kicked',
          updatedAt: new Date().toISOString(),
          attention: 'required',
          caseId: owner.id,
          failures: [{ step: 'notification', code: 'notification_delivery_failed' }],
        },
      });
      const security = new SecurityActionService(
        {} as INotificationManager,
        f.detections,
        new ServerMemberRepository(f.prisma),
        cases,
        new UserRepository(f.prisma),
        new ServerRepository(f.prisma),
        {} as IAdminActionService,
        {} as IThreadManager,
        {} as IUserModerationService & ICombinedBanLifecycleService,
        {} as Client,
        undefined,
        undefined,
        f.service
      );
      const member = {
        id: 'attention-user',
        guild: { id: f.server.guild_id },
        user: { id: 'attention-user', username: 'synthetic' },
      } as GuildMember;
      const detection = {
        label: 'SUSPICIOUS' as const,
        confidence: 0.8,
        reasons: [],
        triggerSource: DetectionType.SUSPICIOUS_CONTENT,
        triggerContent: '',
        detectionEventId: f.event.id,
      };
      await security.recordAutomaticResponseFailure(member, detection, {
        action: 'kick',
        outcome: 'kicked',
        updatedAt: new Date().toISOString(),
        attention: 'required',
        caseId: owner.id,
        failures: [{ step: 'notification', code: 'notification_delivery_failed' }],
      });
      await security.recordAutomaticResponseFailure(member, detection, {
        action: 'kick',
        outcome: 'kicked',
        updatedAt: new Date().toISOString(),
        attention: 'required',
        caseId: owner.id,
        failures: [{ step: 'notification', code: 'notification_delivery_failed' }],
      });
      expect(await f.queue.listByCase(owner.id)).toHaveLength(0);
      const item = await f.queue.findByObservedAlert(f.event.id);
      expect(item).not.toBeNull();
      expect(readAutomaticModerationResponse(item?.metadata)).toMatchObject({
        outcome: 'kicked',
        caseId: null,
      });
      await f.service.syncServerQueue(f.server.guild_id);
      expect((await f.queue.findByObservedAlert(f.event.id))?.id).toBe(item!.id);
      await f.queue.acknowledgeAutomaticResponse({
        itemId: item!.id,
        guildId: f.server.guild_id,
        actorId: 'moderator',
        acknowledgedAt: new Date(),
      });
      await f.service.syncServerQueue(f.server.guild_id);
      expect(
        readAutomaticModerationResponse((await f.queue.findByObservedAlert(f.event.id))?.metadata)
      ).toMatchObject({ outcome: 'kicked', attention: 'acknowledged' });
      expect((await f.detections.findById(f.event.id))?.latest_verification_event_id).toBe(
        owner.id
      );
    }
  );

  it('persists response attention without Discord delivery and retains unresolved attention through reconciliation', async () => {
    const f = await fixture();
    await f.service.upsertObservedAlertMirrorById(f.event.id);
    const first = await f.queue.findByObservedAlert(f.event.id);
    expect(first).not.toBeNull();
    expect(first?.queue_message_id).toBeNull();
    await f.service.upsertObservedAlertMirrorById(f.event.id);
    await f.service.syncServerQueue(f.server.guild_id);
    expect((await f.queue.listByObservedAlert(f.event.id)).map((item) => item.id)).toEqual([
      first!.id,
    ]);
    await f.detections.patchMetadata(f.event.id, {
      automatic_moderation_response: { ...response, attention: 'resolved' },
    });
    await f.service.syncServerQueue(f.server.guild_id);
    expect(await f.queue.findByObservedAlert(f.event.id)).toBeNull();
    expect((await f.detections.findById(f.event.id))?.metadata?.observed_action).toBe('kick');
  });
  it('acknowledgement preserves the action outcome and unresolved row', async () => {
    const f = await fixture();
    await f.service.upsertObservedAlertMirrorById(f.event.id);
    const item = (await f.queue.findByObservedAlert(f.event.id))!;
    const input = {
      itemId: item.id,
      guildId: f.server.guild_id,
      actorId: 'moderator',
      acknowledgedAt: new Date(),
    };
    expect(await f.queue.acknowledgeAutomaticResponse({ ...input, guildId: 'foreign' })).toBe(
      'already_handled'
    );
    const actions = createAttentionActions({
      repository: f.queue,
      authority: {
        loadFresh: async (guildId, userId) => ({
          guildId,
          userId,
          present: true,
          owner: true,
          permissions: '0',
          roleIds: [],
        }),
      },
      messageDeleter: {
        deleteQueueMessage: async () => {
          throw new Error('must retain item');
        },
      },
    });
    expect(
      await actions.acknowledge(
        {
          guildId: f.server.guild_id,
          requestId: 'ack',
          source: 'discord_interaction',
          actor: { kind: 'user', userId: 'moderator' },
        },
        { itemId: item.id }
      )
    ).toMatchObject({ kind: 'outcome', outcome: { status: 'acknowledged' } });
    expect(await f.queue.acknowledgeAutomaticResponse(input)).toBe('already_handled');
    await f.service.syncServerQueue(f.server.guild_id);
    const event = await f.detections.findById(f.event.id);
    expect(readAutomaticModerationResponse(event?.metadata)).toEqual({
      ...response,
      attention: 'acknowledged',
    });
    expect(
      readAutomaticModerationResponse((await f.queue.findByObservedAlert(f.event.id))?.metadata)
    ).toEqual({ ...response, attention: 'acknowledged' });
  });
  it('two concurrent calls claim the same detection at most once', async () => {
    const f = await fixture();
    await f.detections.updateMetadata(f.event.id, {});
    const results = await Promise.all([
      f.detections.claimObservedAction(f.event.id, {
        observed_action: 'kick',
        observed_action_by: 'one',
      }),
      f.detections.claimObservedAction(f.event.id, {
        observed_action: 'kick',
        observed_action_by: 'two',
      }),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });
  it('rejects malformed and case-owned snapshots while preserving ordinary eligibility', async () => {
    const f = await fixture();
    await f.detections.updateMetadata(f.event.id, {
      automatic_moderation_response: { ...response, outcome: 'notified' },
    });
    expect(
      await f.detections.findUnresolvedObservedNotificationsByServer(f.server.guild_id)
    ).toHaveLength(0);
    await f.detections.updateMetadata(f.event.id, {
      automatic_moderation_response: {
        ...response,
        caseId: '11111111-1111-4111-8111-111111111111',
      },
    });
    expect(
      await f.detections.findUnresolvedObservedNotificationsByServer(f.server.guild_id)
    ).toHaveLength(0);
    await f.detections.updateMetadata(f.event.id, {
      observed_notification_message_id: 'notification',
    });
    expect(
      await f.detections.findUnresolvedObservedNotificationsByServer(f.server.guild_id)
    ).toHaveLength(1);
  });
  it('does not reverse acknowledgement when a captured required refresh resumes', async () => {
    const f = await fixture();
    await f.service.upsertObservedAlertMirrorById(f.event.id);
    const stale = (await f.detections.findById(f.event.id))!;
    const item = (await f.queue.findByObservedAlert(f.event.id))!;
    await f.queue.acknowledgeAutomaticResponse({
      itemId: item.id,
      guildId: f.server.guild_id,
      actorId: 'staff',
      acknowledgedAt: new Date(),
    });
    await f.service.upsertObservedAlertMirror(stale);
    expect(
      readAutomaticModerationResponse((await f.detections.findById(f.event.id))?.metadata)
        ?.attention
    ).toBe('acknowledged');
    expect(
      readAutomaticModerationResponse((await f.queue.findByObservedAlert(f.event.id))?.metadata)
        ?.attention
    ).toBe('acknowledged');
  });
  it('does not recreate resolved attention when a captured required refresh resumes', async () => {
    const f = await fixture();
    const stale = (await f.detections.findById(f.event.id))!;
    await f.detections.patchMetadata(f.event.id, {
      automatic_moderation_response: { ...response, attention: 'resolved' },
    });
    await f.service.syncServerQueue(f.server.guild_id);
    await f.service.upsertObservedAlertMirror(stale);
    expect(await f.queue.findByObservedAlert(f.event.id)).toBeNull();
    expect(
      readAutomaticModerationResponse((await f.detections.findById(f.event.id))?.metadata)
        ?.attention
    ).toBe('resolved');
  });
  it('does not recreate newly case-owned attention when a captured required refresh resumes', async () => {
    const f = await fixture();
    const stale = (await f.detections.findById(f.event.id))!;
    await f.detections.patchMetadata(f.event.id, {
      automatic_moderation_response: {
        ...response,
        caseId: '11111111-1111-4111-8111-111111111111',
      },
    });
    await f.service.upsertObservedAlertMirror(stale);
    expect(await f.queue.findByObservedAlert(f.event.id)).toBeNull();
    expect(
      readAutomaticModerationResponse((await f.detections.findById(f.event.id))?.metadata)?.caseId
    ).toBe('11111111-1111-4111-8111-111111111111');
  });
  it.each(['resolved', 'case_owned'])(
    'immediately cleans an existing mirror when current response becomes %s',
    async (state) => {
      const f = await fixture();
      await f.service.upsertObservedAlertMirrorById(f.event.id);
      const item = (await f.queue.findByObservedAlert(f.event.id))!;
      await f.queue.updateDiscordMessage(item.id, 'saved-channel', 'saved-message');
      const cleanup = jest.spyOn(f.service, 'deleteQueueMessage').mockResolvedValue(true);
      await f.detections.patchMetadata(f.event.id, {
        automatic_moderation_response: {
          ...response,
          ...(state === 'resolved'
            ? { attention: 'resolved' }
            : { caseId: '11111111-1111-4111-8111-111111111111' }),
        },
      });
      await f.service.upsertObservedAlertMirrorById(f.event.id);
      expect(await f.queue.findById(item.id)).toBeNull();
      expect(cleanup).toHaveBeenCalledWith(
        expect.objectContaining({
          id: item.id,
          queue_channel_id: 'saved-channel',
          queue_message_id: 'saved-message',
        })
      );
    }
  );
  it('scheduled stale cleanup preserves case-owned failure attention created after case enumeration', async () => {
    const f = await fixture();
    await f.detections.updateMetadata(f.event.id, {});
    const cases = new VerificationEventRepository(f.prisma);
    const service = new ModerationQueueService(
      {} as Client,
      { getServerConfig: async () => f.server } as unknown as IConfigService,
      new ServerRepository(f.prisma),
      cases,
      f.detections,
      f.queue
    );
    const enumerate = cases.findReviewablePendingByServer.bind(cases);
    let enumerated!: () => void;
    let resume!: () => void;
    const captured = new Promise<void>((resolve) => {
      enumerated = resolve;
    });
    const paused = new Promise<void>((resolve) => {
      resume = resolve;
    });
    jest.spyOn(cases, 'findReviewablePendingByServer').mockImplementationOnce(async (serverId) => {
      const pending = await enumerate(serverId);
      enumerated();
      await paused;
      return pending;
    });
    const reconciliation = service.syncServerQueue(f.server.guild_id);
    await captured;
    let ownerId: string | undefined;
    try {
      const owner = await cases.createFromDetection(
        f.event.id,
        f.server.guild_id,
        'attention-user',
        VerificationStatus.PENDING,
        {
          action_failures: [
            {
              action: 'case_role',
              message: 'role_assignment_failed',
              at: new Date().toISOString(),
            },
          ],
        }
      );
      ownerId = owner.id;
      const failure = {
        action: 'restrict',
        outcome: 'case_opened',
        attention: 'required',
        caseId: owner.id,
        updatedAt: new Date().toISOString(),
        failures: [{ step: 'role', code: 'role_assignment_failed' }],
      };
      await f.detections.linkToVerificationEvent(f.event.id, owner.id);
      await f.detections.patchMetadata(f.event.id, { automatic_moderation_response: failure });
      const updated = await cases.patchMetadata(owner.id, {
        automatic_moderation_response: failure,
      });
      await service.upsertCaseMirror(updated!);
    } finally {
      resume();
    }
    await reconciliation;
    const rows = await f.queue.listByServer(f.server.guild_id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      item_type: ModerationQueueItemType.CASE_MIRROR,
      verification_event_id: ownerId,
    });
    expect(
      readAutomaticModerationResponse((await cases.findById(ownerId!))?.metadata)
    ).toMatchObject({ attention: 'required', caseId: ownerId });
  });
  it('scheduled case cleanup serializes parked-case renewal without deleting renewed attention', async () => {
    const f = await fixture();
    await f.detections.updateMetadata(f.event.id, {});
    const cases = new VerificationEventRepository(f.prisma);
    const owner = await cases.createFromDetection(
      f.event.id,
      f.server.guild_id,
      'attention-user',
      VerificationStatus.PENDING,
      {
        action_failures: [
          { action: 'case_role', message: 'role_assignment_failed', at: new Date().toISOString() },
        ],
      }
    );
    await f.service.upsertCaseMirror(owner);
    const obsolete = (await f.queue.findByCase(owner.id))!;
    await cases.update(owner.id, { attention_state: CaseAttentionState.PARKED });
    let renewal: Promise<void> | undefined;
    const cleanup = jest.spyOn(f.service, 'deleteQueueMessage').mockImplementationOnce(async () => {
      renewal = cases
        .update(owner.id, { attention_state: CaseAttentionState.REVIEW_REQUIRED })
        .then(async (renewed) => f.service.upsertCaseMirror(renewed!));
      return true;
    });
    await f.service.syncServerQueue(f.server.guild_id);
    await renewal;
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(await f.queue.findById(obsolete.id)).toBeNull();
    const current = await f.queue.findByCase(owner.id);
    expect(current).not.toBeNull();
    expect(current?.id).not.toBe(obsolete.id);
    expect((await cases.findById(owner.id))?.attention_state).toBe('review_required');
  });

  it.each(['false', 'throw'])(
    'scheduled terminal-case cleanup retains its mirror when Discord cleanup returns %s',
    async (failure) => {
      const f = await fixture();
      await f.detections.updateMetadata(f.event.id, {});
      const cases = new VerificationEventRepository(f.prisma);
      const owner = await cases.createFromDetection(
        f.event.id,
        f.server.guild_id,
        'attention-user',
        VerificationStatus.PENDING,
        {}
      );
      await f.service.upsertCaseMirror(owner);
      const item = (await f.queue.findByCase(owner.id))!;
      await cases.update(owner.id, { status: VerificationStatus.KICKED });
      const cleanup = jest.spyOn(f.service, 'deleteQueueMessage');
      if (failure === 'false') {
        cleanup.mockResolvedValue(false);
        await f.service.syncServerQueue(f.server.guild_id);
      } else {
        cleanup.mockRejectedValue(new Error('cleanup unavailable'));
        await expect(f.service.syncServerQueue(f.server.guild_id)).rejects.toThrow(
          'cleanup unavailable'
        );
      }
      expect((await f.queue.findByCase(owner.id))?.id).toBe(item.id);
    }
  );

  it('scheduled stale cleanup preserves attention created after source enumeration', async () => {
    const f = await fixture();
    await f.detections.updateMetadata(f.event.id, {});
    const enumerate = f.detections.findUnresolvedObservedNotificationsByServer.bind(f.detections);
    let enumerated!: () => void;
    let resume!: () => void;
    const captured = new Promise<void>((resolve) => {
      enumerated = resolve;
    });
    const paused = new Promise<void>((resolve) => {
      resume = resolve;
    });
    jest
      .spyOn(f.detections, 'findUnresolvedObservedNotificationsByServer')
      .mockImplementationOnce(async (serverId) => {
        const events = await enumerate(serverId);
        enumerated();
        await paused;
        return events;
      });
    const reconciliation = f.service.syncServerQueue(f.server.guild_id);
    await captured;
    try {
      await f.detections.patchMetadata(f.event.id, { automatic_moderation_response: response });
      await f.service.upsertObservedAlertMirrorById(f.event.id);
    } finally {
      resume();
    }
    await reconciliation;
    const rows = await f.queue.listByServer(f.server.guild_id);
    expect(rows).toHaveLength(1);
    expect(readAutomaticModerationResponse(rows[0].metadata)).toEqual(response);
  });
  it('stale cleanup cannot delete newer required attention', async () => {
    const f = await fixture();
    await f.service.upsertObservedAlertMirrorById(f.event.id);
    const obsolete = (await f.queue.findByObservedAlert(f.event.id))!;
    await f.detections.patchMetadata(f.event.id, {
      automatic_moderation_response: { ...response, attention: 'resolved' },
    });
    let renewal: Promise<void> | undefined;
    const cleanup = jest.spyOn(f.service, 'deleteQueueMessage').mockImplementationOnce(async () => {
      renewal = f.detections
        .patchMetadata(f.event.id, { automatic_moderation_response: response })
        .then(async () => f.service.upsertObservedAlertMirrorById(f.event.id));
      return true;
    });
    await f.service.upsertObservedAlertMirrorById(f.event.id);
    await renewal;
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(await f.queue.findById(obsolete.id)).toBeNull();
    const current = await f.queue.findByObservedAlert(f.event.id);
    expect(current?.id).not.toBe(obsolete.id);
    expect(readAutomaticModerationResponse(current?.metadata)?.attention).toBe('required');
  });
  it('retains an obsolete mirror when Discord cleanup fails', async () => {
    const f = await fixture();
    await f.service.upsertObservedAlertMirrorById(f.event.id);
    const item = (await f.queue.findByObservedAlert(f.event.id))!;
    await f.detections.patchMetadata(f.event.id, {
      automatic_moderation_response: { ...response, attention: 'resolved' },
    });
    jest.spyOn(f.service, 'deleteQueueMessage').mockResolvedValue(false);
    await f.service.upsertObservedAlertMirrorById(f.event.id);
    expect((await f.queue.findByObservedAlert(f.event.id))?.id).toBe(item.id);
    expect(
      readAutomaticModerationResponse((await f.detections.findById(f.event.id))?.metadata)
        ?.attention
    ).toBe('resolved');
  });
  it('propagates cleanup exceptions and rolls back without losing the mirror', async () => {
    const f = await fixture();
    await f.service.upsertObservedAlertMirrorById(f.event.id);
    const item = (await f.queue.findByObservedAlert(f.event.id))!;
    await f.detections.patchMetadata(f.event.id, {
      automatic_moderation_response: { ...response, attention: 'resolved' },
    });
    jest.spyOn(f.service, 'deleteQueueMessage').mockRejectedValue(new Error('cleanup failed'));
    await expect(f.service.upsertObservedAlertMirrorById(f.event.id)).rejects.toThrow(
      'cleanup failed'
    );
    expect((await f.queue.findByObservedAlert(f.event.id))?.id).toBe(item.id);
  });
});
