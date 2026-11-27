import { createHash } from 'node:crypto';
import {
  DiscordAPIError,
  GuildMember,
  MessageFlags,
  PermissionFlagsBits,
  RESTJSONErrorCodes,
  ThreadChannel,
} from 'discord.js';
import {
  buildSpoilerImageAttachmentFiles,
  messageAttachmentsToReportMetadata,
  toSpoilerFilename,
} from '../utils/reportAttachments';
import { recordObservation } from '../observability/langfuse';
import { isCurrentReportImageSource } from '../utils/reportAiSettings';
import type { MessageReportAttachment, MessageReportContext } from './SecurityActionService';

const MAX_COPIED_IMAGES = 4;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

async function resolveImageSources(
  member: GuildMember,
  channelId: string,
  messageId: string,
  captured: readonly MessageReportAttachment[]
): Promise<readonly MessageReportAttachment[]> {
  if (captured.length === 0) return [];
  const channel = await member.guild.channels.fetch(channelId, { force: true }).catch(() => null);
  if (!channel?.isTextBased()) return [];
  try {
    const message = await channel.messages.fetch({ message: messageId, force: true, cache: false });
    const capturedIds = new Set(captured.map((attachment) => attachment.id));
    return messageAttachmentsToReportMetadata(message).filter(
      (attachment) => attachment.id && capturedIds.has(attachment.id)
    );
  } catch (error) {
    // An explicit source deletion can race evidence capture. Require a current bot
    // permission check before using the report's original signed attachment URL.
    const bot = member.guild.members.me;
    const permissions = bot && channel.permissionsFor(bot);
    return error instanceof DiscordAPIError &&
      error.code === RESTJSONErrorCodes.UnknownMessage &&
      permissions?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory])
      ? captured
      : [];
  }
}

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

  const content = report.content;
  const attachments = report.attachments ?? [];
  if (!content?.trim() && attachments.length === 0) return;

  try {
    const parent =
      thread.parent ??
      (thread.parentId ? await member.guild.channels.fetch(thread.parentId) : null);
    const everyonePermissions = parent?.permissionsFor(member.guild.id);
    const memberPermissions = parent?.permissionsFor(member);
    if (!everyonePermissions || !memberPermissions) {
      recordObservation('tool', { metadata: { report_evidence_delivery: 'unknown_permissions' } });
      console.warn('Could not verify reported message evidence destination permissions.');
      return;
    }
    if (
      everyonePermissions.has(PermissionFlagsBits.ViewChannel) ||
      memberPermissions.has(PermissionFlagsBits.ViewChannel)
    ) {
      recordObservation('tool', { metadata: { report_evidence_delivery: 'unsafe_destination' } });
      console.warn('Reported message evidence requires a staff-only thread.');
      return;
    }

    const sources = await resolveImageSources(
      member,
      report.channelId,
      report.messageId,
      attachments
    );
    const images = sources
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
    const files = await buildSpoilerImageAttachmentFiles(boundedImages, {
      fetchImage: (url) => fetch(url, { redirect: 'error', signal: AbortSignal.timeout(2500) }),
      logger: console,
    });
    const lines = [
      '**Reported message (captured at report time)**',
      `Source: <https://discord.com/channels/${report.guildId}/${report.channelId}/${report.messageId}>`,
    ];
    const reportedImageCount = attachments.filter((attachment) =>
      attachment.contentType?.toLowerCase().startsWith('image/')
    ).length;
    const textFiles: typeof files = [];
    const otherAttachmentCount = attachments.length - reportedImageCount;
    if (otherAttachmentCount > 0) {
      lines.push(`Other reported files: ${otherAttachmentCount}.`);
    }
    if (content?.trim()) {
      // Attach long or code-fenced messages to keep their original text intact.
      if (content.length <= 1600 && !content.includes('```')) {
        lines.push('```\n' + content + '\n```');
      } else {
        textFiles.push({
          attachment: Buffer.from(content),
          name: toSpoilerFilename('reported-message.txt'),
        });
      }
    }
    const nonce = createHash('sha256')
      .update(`${thread.id}:${report.messageId}`)
      .digest('hex')
      .slice(0, 24);
    const sendEvidence = (images: typeof files): ReturnType<ThreadChannel['send']> =>
      thread.send({
        content: [
          ...lines,
          ...(reportedImageCount
            ? [`Reported images copied: ${images.length} of ${reportedImageCount}.`]
            : []),
        ].join('\n'),
        files: [...images, ...textFiles],
        flags: MessageFlags.SuppressEmbeds,
        allowedMentions: { parse: [], repliedUser: false },
        nonce,
        enforceNonce: true,
      });
    try {
      await sendEvidence(files);
    } catch (error) {
      if (files.length === 0) throw error;
      await sendEvidence([]);
    }
  } catch {
    recordObservation('tool', { metadata: { report_evidence_delivery: 'copy_failed' } });
    console.warn('Could not copy reported message into admin evidence.');
  }
}
