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
  DetectionType,
  VerificationStatus,
  ModerationQueueItemType,
} from '../../repositories/types';
import type { IConfigService } from '../../config/ConfigService';
import type { Client, GuildMember } from 'discord.js';
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
