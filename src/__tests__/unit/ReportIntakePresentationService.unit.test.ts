import { findAuthoredReportMessage } from '../../utils/reportPresentationDiscord';
import type { IModerationQueueRepository } from '../../repositories/ModerationQueueRepository';
import type { IConfigService } from '../../config/ConfigService';
import type { IThreadManager } from '../../services/ThreadManager';
import { mock } from 'jest-mock-extended';
import { ReportIntakeService } from '../../services/ReportIntakeService';
import {
  Client,
  Collection,
  EmbedBuilder,
  type MessageCreateOptions,
  type Message,
} from 'discord.js';
import { ReportIntakePresentationService } from '../../services/ReportIntakePresentationService';
import {
  InMemoryReportIntakeRepository,
  InMemoryServerRepository,
} from '../fakes/inMemoryRepositories';
import { ReportIntakeStatus } from '../../repositories/types';

async function fixture() {
  const servers = new InMemoryServerRepository();
  await servers.getOrCreateServer('guild');
  await servers.updateSettings('guild', { report_intake_staged_enabled: true });
  const repository = new InMemoryReportIntakeRepository(servers);
  const intake = await repository.create({
    serverId: 'guild',
    reporterId: 'reporter',
    threadId: 'thread',
    status: ReportIntakeStatus.COLLECTING_EVIDENCE,
    metadata: { workflow: 'staged' },
  });
  const messages = new Map<
    string,
    {
      id: string;
      author: { id: string };
      guildId: string;
      channelId: string;
      createdTimestamp: number;
      embeds: unknown[];
      components: readonly unknown[];
      edit: jest.Mock;
    }
  >();
  const channel = {
    id: 'thread',
    guildId: 'guild',
    archived: false,
    isThread: () => true,
    setArchived: jest.fn(async (archived: boolean): Promise<void> => {
      channel.archived = archived;
    }),
    fetch: jest.fn(async (): Promise<{ archived: boolean }> => ({ archived: channel.archived })),
    messages: {
      fetch: jest.fn(async (input: unknown) => {
        if (typeof input !== 'string') {
          const options = input as { limit: number; before?: string };
          return new Collection(
            [...messages]
              .reverse()
              .filter(([id]) => !options.before || BigInt(id) < BigInt(options.before))
              .slice(0, options.limit)
          );
        }
        const message = messages.get(input);
        if (!message) throw Object.assign(new Error('Missing'), { code: 10008 });
        return message;
      }),
    },
    send: jest.fn(async (payload: MessageCreateOptions) => {
      const message = {
        id: String(messages.size + 1),
        author: { id: 'bot' },
        guildId: 'guild',
        channelId: 'thread',
        createdTimestamp: Date.now(),
        embeds: payload.embeds!.map((x) => (x as EmbedBuilder).toJSON()),
        components: payload.components || [],
        edit: jest.fn(),
      };
      message.edit.mockImplementation(async (next: MessageCreateOptions) => {
        if (channel.archived) throw new Error('Cannot edit archived thread');
        if (next.embeds) message.embeds = next.embeds.map((x) => (x as EmbedBuilder).toJSON());
        message.components = next.components || [];
        return message;
      });
      messages.set(message.id, message);
      return message;
    }),
  };
  const client = {
    user: { id: 'bot' },
    channels: { fetch: jest.fn().mockResolvedValue(channel) },
  } as unknown as Client;
  const config = mock<IConfigService>();
  config.getServerConfig.mockResolvedValue({
    settings: { report_intake_staged_enabled: true },
  } as never);
  const queue = mock<IModerationQueueRepository>();
  const service = new ReportIntakePresentationService(repository, client, config, queue);
  return { repository, intake, channel, messages, service, client, config, queue };
}
async function suggest(f: Awaited<ReturnType<typeof fixture>>): Promise<void> {
  const candidate = {
    candidateId: 'candidate',
    discordUserId: 'target',
    serverId: 'guild',
    username: 'someone',
    globalName: 'Someone',
    nickname: null,
    displayName: 'Someone',
    avatarUrl: null,
    matchedFields: ['globalName'],
    sourceRefs: [],
    subjectMatches: [{ subjectId: 'subject', sourceRefs: [], matchedFields: ['globalName'] }],
  };
  const current = (await f.repository.findById(f.intake.id))!;
  await f.repository.update(f.intake.id, {
    status: ReportIntakeStatus.NEEDS_REPORTER_CONFIRMATION,
    analysisDueAt: new Date(Date.now() + 600000),
    metadata: {
      ...(current.metadata as object),
      analysis: {
        schemaVersion: 1,
        sources: {},
        requestReservations: [],
        outcome: {
          kind: 'confirm',
          candidate,
          coverage: { kind: 'not_required', reason: 'validated_anchor' },
          includedEvidenceIds: [],
          excludedEvidenceIds: [],
        },
        coverage: null,
        handoff: { state: 'none' },
      },
    },
  });
}

describe('durable reporter presentation', () => {
  it('edits the opening card as evidence arrives instead of adding acknowledgments', async () => {
    const f = await fixture();
    await f.service.reconcile(f.intake.id);
    await f.repository.update(f.intake.id, { summary: 'New evidence' });
    await f.service.reconcile(f.intake.id);
    expect(f.messages.size).toBe(1);
    expect(f.channel.send).toHaveBeenCalledTimes(1);
    expect((await f.repository.findById(f.intake.id))?.metadata).toMatchObject({
      reporter_presentation: { attemptViewKey: expect.stringMatching(/^v1:sha256:[0-9a-f]{64}$/) },
    });
  });
  it('does not treat permission failures as missing messages', async () => {
    const f = await fixture();
    await f.service.reconcile(f.intake.id);
    f.channel.messages.fetch.mockRejectedValue(
      Object.assign(new Error('Forbidden'), { code: 50013 })
    );
    await expect(f.service.reconcile(f.intake.id)).rejects.toThrow('Forbidden');
    expect(f.channel.send).toHaveBeenCalledTimes(1);
  });
  it('replaces a definitely deleted card without pinging', async () => {
    const f = await fixture();
    await f.service.reconcile(f.intake.id);
    f.messages.clear();
    await f.service.reconcile(f.intake.id);
    expect(f.channel.send).toHaveBeenCalledTimes(2);
    expect(f.channel.send.mock.calls[1][0].allowedMentions).toEqual({ parse: [] });
  });
  it('keeps a final receipt from regressing after a late reconciliation', async () => {
    const f = await fixture();
    await f.service.reconcile(f.intake.id);
    await f.repository.update(f.intake.id, {
      status: ReportIntakeStatus.SUBMITTED,
      confirmedTargetUserId: 'target',
    });
    await f.service.reconcile(f.intake.id);
    await f.service.reconcile(f.intake.id);
    expect(f.messages.size).toBe(2);
    expect(JSON.stringify([...f.messages.values()].at(-1)?.embeds)).toContain('Report submitted');
  });
  it('reuses the confirmation for a new revision and changes its authorization token', async () => {
    const f = await fixture();
    await f.service.reconcile(f.intake.id);
    await suggest(f);
    await f.service.reconcile(f.intake.id);
    const first = JSON.stringify(f.messages.get('2')?.components);
    await f.service.reconcile(f.intake.id);
    expect(f.messages.size).toBe(2);
    expect(JSON.stringify(f.messages.get('2')?.components)).not.toBe(first);
    expect(f.channel.send.mock.calls[1][0].allowedMentions).toEqual({
      parse: [],
      users: ['reporter'],
    });
    const saved = (await f.repository.findById(f.intake.id))!;
    const metadata = saved.metadata as Record<string, unknown>;
    const intakes = new ReportIntakeService(
      f.repository,
      mock(),
      mock(),
      mock(),
      mock(),
      mock(),
      mock<IThreadManager>({
        retireReportConfirmationPrompts: jest.fn().mockResolvedValue(undefined),
      })
    );
    expect(
      await intakes.rejectCandidates({
        intakeId: f.intake.id,
        rejectedById: 'reporter',
        promptMessageId: '2',
        promptToken: String(metadata.last_confirmation_prompt_token),
        expectedEvidenceRevision: saved.evidence_revision,
      })
    ).toMatchObject({ rejected: true });
    expect((await f.repository.findById(f.intake.id))?.status).toBe(
      ReportIntakeStatus.NEEDS_ADMIN_CONFIRMATION
    );
  });
  it('recovers a send accepted before its message ID was persisted', async () => {
    const f = await fixture();
    const update = f.repository.updateIfCurrent.bind(f.repository);
    let fail = true;
    jest.spyOn(f.repository, 'updateIfCurrent').mockImplementation(async (intake, data) => {
      if (fail && JSON.stringify(data.metadata).includes('openingMessageId":"1')) {
        fail = false;
        throw new Error('DB unavailable');
      }
      return update(intake, data);
    });
    await expect(f.service.reconcile(f.intake.id)).rejects.toThrow('DB unavailable');
    await f.service.reconcile(f.intake.id);
    expect(f.channel.send).toHaveBeenCalledTimes(1);
  });

  it.each([true, false])(
    'gates a settled undispatched retry on the rollout, enabled=%s',
    async (enabled) => {
      const f = await fixture();
      await f.service.reconcile(f.intake.id);
      const intake = (await f.repository.findById(f.intake.id))!;
      await f.repository.update(f.intake.id, {
        status: ReportIntakeStatus.NEEDS_ADMIN_CONFIRMATION,
        confirmedTargetUserId: 'target',
        metadata: {
          ...(intake.metadata as object),
          submission: {
            token: 'submission',
            targetUserId: 'target',
            state: 'not_dispatched',
            claimedAt: new Date().toISOString(),
            settledAt: new Date().toISOString(),
          },
        },
      });
      f.config.getServerConfig.mockResolvedValue({
        settings: { report_intake_staged_enabled: enabled },
      } as never);
      if (enabled) {
        await f.service.reconcile(f.intake.id);
        expect(JSON.stringify(f.messages.get('2')?.components)).toContain('Try again');
      } else {
        await expect(f.service.reconcile(f.intake.id)).rejects.toThrow(
          'Staged report confirmation disabled'
        );
        expect(f.messages.size).toBe(1);
      }
    }
  );
  it('adopts a shipped receipt without publishing another GUID or message', async () => {
    const f = await fixture();
    await f.channel.send({
      embeds: [new EmbedBuilder().setFooter({ text: `Report receipt ${f.intake.id}` })],
    });
    await f.repository.update(f.intake.id, {
      status: ReportIntakeStatus.SUBMITTED,
      confirmedTargetUserId: 'target',
    });
    await f.service.reconcile(f.intake.id);
    expect(f.messages.size).toBe(1);
    expect(JSON.stringify(f.messages.get('1')?.embeds)).not.toContain('Report receipt');
  });
});

it('does not take over the shipped non-staged multiple-candidate flow', async () => {
  const f = await fixture();
  await f.repository.update(f.intake.id, { metadata: {} });
  expect(await f.service.reconcile(f.intake.id)).toBe(false);
  expect(f.channel.send).not.toHaveBeenCalled();
});
it.each(['unknown', 'dispatching'])('never enables retry for %s submission', async (state) => {
  const f = await fixture();
  await f.repository.update(f.intake.id, {
    status: ReportIntakeStatus.NEEDS_ADMIN_CONFIRMATION,
    confirmedTargetUserId: 'target',
    metadata: {
      workflow: 'staged',
      submission: {
        token: 'token',
        targetUserId: 'target',
        state,
        claimedAt: new Date().toISOString(),
        dispatchedAt: new Date().toISOString(),
        ...(state === 'unknown' ? { settledAt: new Date().toISOString() } : {}),
      },
    },
  });
  await f.service.reconcile(f.intake.id);
  expect(f.messages.get('1')?.components).toEqual([]);
});
it('removes stale controls and schedules correction when state changes during an edit', async () => {
  const f = await fixture();
  await f.service.reconcile(f.intake.id);
  f.messages.get('1')!.edit.mockImplementationOnce(async () => {
    await f.repository.update(f.intake.id, {
      status: ReportIntakeStatus.SUBMITTED,
      confirmedTargetUserId: 'target',
    });
    return f.messages.get('1');
  });
  await expect(f.service.reconcile(f.intake.id)).rejects.toThrow('changed');
  expect(f.messages.get('1')!.edit).toHaveBeenLastCalledWith({ components: [] });
  expect((await f.repository.findById(f.intake.id))?.metadata).toMatchObject({
    reporter_presentation: { nextDueAt: expect.any(String) },
  });
});
it('stops recovery when history is incomplete rather than duplicating an uncertain send', async () => {
  const f = await fixture();
  const page = new Collection(
    Array.from(
      { length: 100 },
      (_, i) =>
        [
          String(i),
          { id: String(i), author: { id: 'someone' }, createdTimestamp: Date.now() },
        ] as const
    )
  );
  f.channel.messages.fetch.mockResolvedValue(page as never);
  await expect(f.service.reconcile(f.intake.id)).rejects.toThrow('incomplete');
  expect(f.queue.setReportDeliveryFailure).toHaveBeenCalledWith(
    expect.objectContaining({ intake: expect.objectContaining({ id: f.intake.id }) }),
    'history_incomplete'
  );
  expect(f.channel.send).not.toHaveBeenCalled();
});

it('recovers an accepted confirmation reservation even when newer evidence changes the card state', async () => {
  const f = await fixture();
  await f.service.reconcile(f.intake.id);
  await suggest(f);
  const update = f.repository.updateIfCurrent.bind(f.repository);
  let fail = true;
  jest.spyOn(f.repository, 'updateIfCurrent').mockImplementation(async (intake, data) => {
    if (fail && JSON.stringify(data.metadata).includes('followupMessageId":"2')) {
      fail = false;
      throw new Error('ID save failed');
    }
    return update(intake, data);
  });
  await expect(f.service.reconcile(f.intake.id)).rejects.toThrow('ID save failed');
  const current = (await f.repository.findById(f.intake.id))!;
  await f.repository.update(f.intake.id, {
    status: ReportIntakeStatus.COLLECTING_EVIDENCE,
    metadata: {
      ...(current.metadata as object),
      analysis: {
        schemaVersion: 1,
        sources: {},
        requestReservations: [],
        handoff: { state: 'none' },
        outcome: null,
        coverage: null,
      },
    },
  });
  await f.service.reconcile(f.intake.id);
  await suggest(f);
  await f.service.reconcile(f.intake.id);
  expect(f.messages.size).toBe(2);
  expect(
    f.channel.send.mock.calls.filter(([payload]) => payload.allowedMentions?.users?.length)
  ).toHaveLength(1);
});

it.each([-60000, 60000])(
  'recovers an unrecorded confirmation with Discord clock offset %i',
  async (offset) => {
    const f = await fixture();
    await f.service.reconcile(f.intake.id);
    await suggest(f);
    const send = f.channel.send.getMockImplementation()!;
    f.channel.send.mockImplementation(async (payload) => {
      const message = await send(payload);
      message.createdTimestamp += offset;
      return message;
    });
    const update = f.repository.updateIfCurrent.bind(f.repository);
    let fail = true;
    jest.spyOn(f.repository, 'updateIfCurrent').mockImplementation(async (intake, data) => {
      if (fail && JSON.stringify(data.metadata).includes('followupMessageId":"2')) {
        fail = false;
        throw new Error('ID save failed');
      }
      return update(intake, data);
    });
    await expect(f.service.reconcile(f.intake.id)).rejects.toThrow('ID save failed');
    expect(f.messages.get('2')!.components).toEqual([]);
    await f.service.reconcile(f.intake.id);
    expect(f.channel.send).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(f.messages.get('2')!.components)).toContain('Submit report');
  }
);

it('does not ping again when an uncertain first confirmation was deleted before recovery', async () => {
  const f = await fixture();
  await suggest(f);
  const update = f.repository.updateIfCurrent.bind(f.repository);
  let fail = true;
  jest.spyOn(f.repository, 'updateIfCurrent').mockImplementation(async (intake, data) => {
    if (fail && JSON.stringify(data.metadata).includes('followupMessageId":"1')) {
      fail = false;
      throw new Error('ID save failed');
    }
    return update(intake, data);
  });
  await expect(f.service.reconcile(f.intake.id)).rejects.toThrow('ID save failed');
  f.messages.clear();
  await f.service.reconcile(f.intake.id);
  expect(
    f.channel.send.mock.calls.filter(([payload]) => payload.allowedMentions?.users?.length)
  ).toHaveLength(1);
});

it('does not publish a saved confirmation when the rollout is disabled', async () => {
  const f = await fixture();
  await suggest(f);
  f.config.getServerConfig.mockResolvedValue({
    settings: { report_intake_staged_enabled: false },
  } as never);
  await expect(f.service.reconcile(f.intake.id)).rejects.toThrow(
    'Staged report confirmation disabled'
  );
  expect(f.config.getServerConfig).toHaveBeenCalledWith('guild', {
    forceRefresh: true,
    failOnReadError: true,
  });
  expect(f.channel.send).not.toHaveBeenCalled();
});
it('rechecks the rollout before enabling a newly sent confirmation', async () => {
  const f = await fixture();
  await suggest(f);
  const send = f.channel.send.getMockImplementation()!;
  f.channel.send.mockImplementation(async (payload) => {
    const message = await send(payload);
    f.config.getServerConfig.mockResolvedValue({
      settings: { report_intake_staged_enabled: false },
    } as never);
    return message;
  });
  await expect(f.service.reconcile(f.intake.id)).rejects.toThrow(
    'Staged report confirmation disabled'
  );
  expect(f.messages.get('1')!.components).toEqual([]);
});

it.each([
  ReportIntakeStatus.CLOSED_BY_REPORTER,
  ReportIntakeStatus.DISMISSED,
  ReportIntakeStatus.FALSE_POSITIVE,
  ReportIntakeStatus.ACTIONED,
])(
  'updates a %s card and restores archival without reopening it on later reconciliation',
  async (status) => {
    const f = await fixture();
    await f.service.reconcile(f.intake.id);
    await f.repository.update(f.intake.id, {
      status,
      closedAt: new Date(),
      ...(status === ReportIntakeStatus.ACTIONED
        ? {
            metadata: {
              ...((await f.repository.findById(f.intake.id))!.metadata as object),
              observed_action_closed_at: new Date().toISOString(),
            },
          }
        : {}),
    });
    f.channel.archived = true;
    await f.service.reconcile(f.intake.id);
    expect(f.channel.setArchived.mock.calls.map(([archived]) => archived)).toEqual([false, true]);
    expect(f.channel.archived).toBe(true);
    expect(JSON.stringify([...f.messages.values()].map((m) => m.embeds))).toContain(
      'Thread closed'
    );
    expect((await f.repository.findById(f.intake.id))?.metadata).toMatchObject({
      reporter_presentation: { closedCardView: expect.stringMatching(/^v1:sha256:[0-9a-f]{64}$/) },
    });
    f.channel.setArchived.mockClear();
    await f.service.reconcile(f.intake.id);
    expect(f.channel.setArchived).not.toHaveBeenCalled();
  }
);
it('recovers a failed rearchive without editing or reopening the finished card again', async () => {
  const f = await fixture();
  await f.service.reconcile(f.intake.id);
  await f.repository.update(f.intake.id, {
    status: ReportIntakeStatus.CLOSED_BY_REPORTER,
    closedAt: new Date(),
  });
  f.channel.archived = true;
  f.channel.setArchived.mockImplementation(async (archived) => {
    if (archived) throw new Error('archive failed');
    f.channel.archived = false;
  });
  await expect(f.service.reconcile(f.intake.id)).rejects.toThrow('archive failed');
  expect(f.channel.archived).toBe(false);
  const metadata = (await f.repository.findById(f.intake.id))!.metadata;
  expect(metadata).toMatchObject({ reporter_presentation: { restoreArchive: true } });
  f.channel.setArchived.mockImplementation(async (archived) => {
    f.channel.archived = archived;
  });
  f.channel.setArchived.mockClear();
  await f.service.reconcile(f.intake.id);
  expect(f.channel.setArchived.mock.calls.map(([archived]) => archived)).toEqual([true]);
  expect(f.channel.archived).toBe(true);
});
it.each(['before archive', 'during archive'])('preserves moderator undo %s', async (timing) => {
  const f = await fixture();
  await f.service.reconcile(f.intake.id);
  const original = (await f.repository.findById(f.intake.id))!;
  await f.repository.update(f.intake.id, {
    status: ReportIntakeStatus.DISMISSED,
    closedAt: new Date(),
    metadata: {
      ...(original.metadata as object),
      observed_action_closed_at: new Date().toISOString(),
    },
  });
  f.channel.archived = true;
  const undo = async (): Promise<void> => {
    const current = (await f.repository.findById(f.intake.id))!;
    const metadata = { ...(current.metadata as Record<string, unknown>) };
    delete metadata.observed_action_closed_at;
    await f.repository.update(f.intake.id, {
      status: ReportIntakeStatus.SUBMITTED,
      closedAt: null,
      metadata: { ...metadata, observed_action_reopened_at: new Date().toISOString() },
    });
    f.channel.archived = false;
  };
  let undone = false;
  const archive = f.channel.setArchived.getMockImplementation()!;
  f.channel.setArchived.mockImplementation(async (archived) => {
    if (
      !undone &&
      ((timing === 'before archive' && !archived) || (timing === 'during archive' && archived))
    ) {
      undone = true;
      await undo();
    }
    await archive(archived);
  });
  await expect(f.service.reconcile(f.intake.id)).rejects.toThrow('Report presentation changed');
  expect(f.channel.archived).toBe(false);
  expect((await f.repository.findById(f.intake.id))?.status).toBe(ReportIntakeStatus.SUBMITTED);
});
it('retires confirmation controls if the rollout is disabled during their edit', async () => {
  const f = await fixture();
  await suggest(f);
  const send = f.channel.send.getMockImplementation()!;
  f.channel.send.mockImplementation(async (payload) => {
    const message = await send(payload);
    const edit = message.edit.getMockImplementation()!;
    message.edit.mockImplementation(async (next: MessageCreateOptions) => {
      const result = await edit(next);
      f.config.getServerConfig.mockResolvedValue({
        settings: { report_intake_staged_enabled: false },
      } as never);
      return result;
    });
    return message;
  });
  await expect(f.service.reconcile(f.intake.id)).rejects.toThrow(
    'Staged report confirmation disabled'
  );
  expect(f.messages.get('1')!.components).toEqual([]);
});

it('starts a fresh short retry delay after successful card updates', async () => {
  const f = await fixture();
  for (let i = 0; i < 5; i++) await f.service.reconcile(f.intake.id);
  f.channel.messages.fetch.mockRejectedValue(new Error('temporary outage'));
  await expect(f.service.reconcile(f.intake.id)).rejects.toThrow('temporary outage');
  const saved = (await f.repository.findById(f.intake.id))!;
  const presentation = (saved.metadata as { reporter_presentation: { nextDueAt: string } })
    .reporter_presentation;
  expect(new Date(presentation.nextDueAt).getTime() - Date.now()).toBeLessThanOrEqual(30000);
});
it('preserves malformed presentation metadata and blocks only its delivery', async () => {
  const f = await fixture();
  await f.repository.update(f.intake.id, {
    metadata: { workflow: 'staged', reporter_presentation: { openingMessageId: 123 } },
  });
  await expect(f.service.reconcile(f.intake.id)).rejects.toThrow(
    'Invalid reporter presentation metadata'
  );
  expect(f.channel.send).not.toHaveBeenCalled();
  expect((await f.repository.findById(f.intake.id))!.metadata).toMatchObject({
    reporter_presentation: { openingMessageId: 123 },
  });
});

it('reschedules after a lost write without invoking legacy instruction fallback', async () => {
  const f = await fixture();
  jest.spyOn(f.repository, 'updateIfCurrent').mockResolvedValueOnce(null);
  await expect(f.service.reconcile(f.intake.id)).resolves.toBe(true);
  expect(f.channel.send).toHaveBeenCalledTimes(1);
});

it('settles reporter delivery only for a definite missing channel', async () => {
  const f = await fixture();
  jest
    .spyOn(f.client.channels, 'fetch')
    .mockRejectedValue(Object.assign(new Error('Unknown Channel'), { code: 10003 }));
  await f.service.reconcile(f.intake.id);
  expect((await f.repository.findById(f.intake.id))!.metadata).toMatchObject({
    reporter_presentation: { threadMissing: true, nextDueAt: null },
  });
  expect(
    await f.repository.claimPendingPresentation(new Date(Date.now() + 86400000), f.intake.id)
  ).toBeNull();
});
it('retains retries when the channel is forbidden rather than deleted', async () => {
  const f = await fixture();
  jest
    .spyOn(f.client.channels, 'fetch')
    .mockRejectedValue(Object.assign(new Error('Forbidden'), { code: 50001 }));
  await expect(f.service.reconcile(f.intake.id)).rejects.toThrow('Forbidden');
  expect((await f.repository.findById(f.intake.id))!.metadata).toMatchObject({
    reporter_presentation: { nextDueAt: expect.any(String) },
  });
});

it('preserves malformed delivery obligations on direct worker publication', async () => {
  const f = await fixture();
  await suggest(f);
  const current = (await f.repository.findById(f.intake.id))!;
  const invalid = { openingMessageId: 123, restoreArchive: true };
  await f.repository.update(f.intake.id, {
    metadata: { ...(current.metadata as object), reporter_presentation: invalid },
  });
  const claim = await f.repository.claimPendingPresentation(new Date(), f.intake.id);
  expect(claim).not.toBeNull();
  await expect(f.service.presentClaim(claim!)).rejects.toThrow(
    'Invalid reporter presentation metadata'
  );
  expect((await f.repository.findById(f.intake.id))!.metadata).toMatchObject({
    reporter_presentation: invalid,
  });
  expect(f.channel.send).not.toHaveBeenCalled();
});

it('clears recovery attention after the card is successfully restored', async () => {
  const f = await fixture();
  await f.repository.update(f.intake.id, {
    metadata: {
      workflow: 'staged',
      reporter_presentation: { deliveryAttention: true, nextDueAt: new Date().toISOString() },
    },
  });
  await f.service.reconcile(f.intake.id);
  expect(f.queue.setReportDeliveryFailure).toHaveBeenCalledWith(
    expect.objectContaining({ intake: expect.objectContaining({ id: f.intake.id }) }),
    null
  );
});

it('does not assume a recovered match is unique beyond the bounded history window', async () => {
  const now = Date.now();
  const messages = new Collection<string, Message>(
    Array.from({ length: 100 }, (_, index) => [
      String(index),
      { id: String(index), author: { id: 'bot' }, createdTimestamp: now } as Message,
    ])
  );
  const fetch = jest.fn().mockResolvedValue(messages);
  await expect(
    findAuthoredReportMessage(
      { messages: { fetch } },
      'bot',
      (message) => message.id === '0',
      new Date(now - 60000)
    )
  ).rejects.toThrow('incomplete');
  expect(fetch).toHaveBeenCalledTimes(10);
});
