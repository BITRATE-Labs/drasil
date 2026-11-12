import type { IThreadManager } from '../../services/ThreadManager';
import { mock } from 'jest-mock-extended';
import { ReportIntakeService } from '../../services/ReportIntakeService';
import { Client, Collection, EmbedBuilder, type MessageCreateOptions } from 'discord.js';
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
    messages: {
      fetch: jest.fn(async (input: unknown) => {
        if (typeof input !== 'string') return new Collection(messages);
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
  const service = new ReportIntakePresentationService(repository, client);
  return { repository, intake, channel, messages, service, client };
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

  it('offers retry only after a definitely undispatched attempt has settled', async () => {
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
    await f.service.reconcile(f.intake.id);
    expect(JSON.stringify(f.messages.get('2')?.components)).toContain('Try again');
  });
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
