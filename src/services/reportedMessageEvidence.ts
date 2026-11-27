import { createHash } from 'node:crypto';
import { GuildMember, MessageFlags, PermissionFlagsBits, ThreadChannel } from 'discord.js';
import { buildSpoilerImageAttachmentFiles, toSpoilerFilename } from '../utils/reportAttachments';
import { isCurrentReportImageSource } from '../utils/reportAiSettings';
import type { MessageReportContext } from './SecurityActionService';

const MAX_COPIED_IMAGES = 4;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export async function postReportedMessageEvidence(
  thread: ThreadChannel,
  member: GuildMember,
  report: MessageReportContext
): Promise<void> {
  if (
    report.guildId !== member.guild.id ||
    thread.guildId !== member.guild.id ||
    !report.channelId ||
    !/^\d+$/.test(report.channelId) ||
    !/^\d+$/.test(report.messageId)
  )
    return;

  const parent = thread.parent;
  if (
    !parent ||
    parent.permissionsFor(member.guild.roles.everyone).has(PermissionFlagsBits.ViewChannel) !==
      false ||
    parent.permissionsFor(member).has(PermissionFlagsBits.ViewChannel) !== false
  ) {
    console.warn('Reported message evidence requires a staff-only thread.');
    return;
  }

  const content = report.content;
  const attachments = report.attachments ?? [];
  if (!content?.trim() && attachments.length === 0) return;

  try {
    const images = attachments
      .flatMap((item) => {
        const { url, id, contentType, size } = item;
        if (
          !url ||
          !id ||
          !contentType ||
          size === undefined ||
          !isCurrentReportImageSource(
            { url, attachmentId: id, contentType, size },
            MAX_IMAGE_BYTES
          ) ||
          new URL(url).pathname.split('/')[2] !== report.channelId
        )
          return [];
        return [{ ...item, proxyUrl: undefined }];
      })
      .slice(0, MAX_COPIED_IMAGES);
    let remainingBytes = MAX_IMAGE_BYTES;
    const boundedImages = images.filter((image) => {
      const size = image.size ?? 0;
      if (size > remainingBytes) return false;
      remainingBytes -= size;
      return true;
    });
    const signal = AbortSignal.timeout(2500);
    const files = await buildSpoilerImageAttachmentFiles(boundedImages, {
      fetchImage: (url) => fetch(url, { redirect: 'error', signal }),
      logger: console,
    });
    const lines = [
      '**Reported message Â· captured at report time**',
      `Source: <https://discord.com/channels/${report.guildId}/${report.channelId}/${report.messageId}>`,
    ];
    if (attachments.length > files.length) {
      lines.push(`Attachments preserved: ${files.length} of ${attachments.length}.`);
    }
    if (content?.trim()) {
      // Attach long or code-fenced messages to keep their original text intact.
      if (content.length <= 1600 && !content.includes('```')) {
        lines.push('```\n' + content + '\n```');
      } else {
        files.push({
          attachment: Buffer.from(content),
          name: toSpoilerFilename('reported-message.txt'),
        });
      }
    }
    await thread.send({
      content: lines.join('\n'),
      files,
      flags: MessageFlags.SuppressEmbeds,
      allowedMentions: { parse: [], repliedUser: false },
      nonce: createHash('sha256')
        .update(`${thread.id}:${report.messageId}`)
        .digest('hex')
        .slice(0, 24),
      enforceNonce: true,
    });
  } catch (error) {
    console.warn('Could not copy reported message into admin evidence:', error);
  }
}
