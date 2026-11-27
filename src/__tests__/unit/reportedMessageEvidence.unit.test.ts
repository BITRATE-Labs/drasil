import { DiscordAPIError, type GuildMember, type ThreadChannel } from 'discord.js';
import { postReportedMessageEvidence } from '../../services/reportedMessageEvidence';

const report = {
  guildId: '123',
  channelId: '456',
  messageId: '789',
  reason: 'Reporter note',
  content: 'The captured advertisement',
};
const member = { guild: { id: '123', roles: { everyone: {} } } } as GuildMember;

function destination(canView = false) {
  const send = jest.fn().mockResolvedValue(undefined);
  const thread = {
    id: '100',
    guildId: '123',
    send,
    parent: { permissionsFor: () => ({ has: () => canView }) },
  } as unknown as ThreadChannel;
  return { thread, send };
}

it('posts the captured report text without fetching the deleted source message', async () => {
  const { thread, send } = destination();
  await postReportedMessageEvidence(thread, member, report);
  expect(send).toHaveBeenCalledWith(
    expect.objectContaining({
      content: expect.stringContaining(report.content),
      allowedMentions: { parse: [], repliedUser: false },
      enforceNonce: true,
    })
  );
  expect(send.mock.calls[0][0].content).not.toContain(report.reason);
});

it.each([true, false])(
  'copies a deleted Discord image only with current source access (%s)',
  async (canRead) => {
    const { thread, send } = destination();
    const url = 'https://cdn.discordapp.com/attachments/456/345/proof.png';
    const sourceMessage = jest
      .fn()
      .mockRejectedValue(
        new DiscordAPIError({ code: 10008, message: 'Unknown Message' }, 10008, 404, 'GET', url, {})
      );
    const authorizedMember = {
      guild: {
        ...member.guild,
        members: { me: {} },
        channels: {
          fetch: jest.fn().mockResolvedValue({
            isTextBased: () => true,
            messages: { fetch: sourceMessage },
            permissionsFor: () => ({ has: () => canRead }),
          }),
        },
      },
    } as unknown as GuildMember;
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(new Response('image'));
    try {
      await postReportedMessageEvidence(thread, authorizedMember, {
        ...report,
        content: undefined,
        attachments: [
          { id: '345', url, name: 'proof.png', contentType: 'image/png', size: 5 },
          {
            id: '999',
            url: 'https://example.com/attachments/456/999/x.png',
            size: 5,
            contentType: 'image/png',
          },
        ],
      });
      expect(sourceMessage).toHaveBeenCalledWith({
        message: report.messageId,
        force: true,
        cache: false,
      });
      if (!canRead) {
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(send).toHaveBeenCalledWith(
          expect.objectContaining({
            files: [],
            content: expect.stringContaining('Reported images copied: 0 of 2'),
          })
        );
        return;
      }
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(fetchSpy).toHaveBeenCalledWith(url, expect.objectContaining({ redirect: 'error' }));
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({
          files: [{ name: 'SPOILER_proof.png', attachment: Buffer.from('image') }],
          content: expect.stringContaining('Reported images copied: 1 of 2'),
        })
      );
    } finally {
      fetchSpy.mockRestore();
    }
  }
);

it('skips cross-guild and publicly visible destinations', async () => {
  const privateThread = destination();
  const publicThread = destination(true);
  const warning = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  try {
    await postReportedMessageEvidence(privateThread.thread, member, { ...report, guildId: '222' });
    await postReportedMessageEvidence(publicThread.thread, member, report);
    expect(privateThread.send).not.toHaveBeenCalled();
    expect(publicThread.send).not.toHaveBeenCalled();
  } finally {
    warning.mockRestore();
  }
});

it('fetches an uncached evidence parent before checking its permissions', async () => {
  const { thread, send } = destination();
  const fetchChannel = jest.fn().mockResolvedValue(thread.parent);
  const uncachedThread = { ...thread, parent: null, parentId: '987' } as unknown as ThreadChannel;
  const reportingMember = {
    ...member,
    guild: { ...member.guild, channels: { fetch: fetchChannel } },
  } as unknown as GuildMember;

  await postReportedMessageEvidence(uncachedThread, reportingMember, report);

  expect(fetchChannel).toHaveBeenCalledWith('987');
  expect(send).toHaveBeenCalledTimes(1);
});
