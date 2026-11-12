import type { Collection, Message } from 'discord.js';

export interface ReportHistoryChannel {
  messages: {
    fetch(options: { limit: number; before?: string }): Promise<Collection<string, Message>>;
  };
}

export class ReportHistoryRecoveryError extends Error {
  constructor(readonly reason: 'history_ambiguous' | 'history_incomplete') {
    super(
      `Report presentation history is ${reason === 'history_ambiguous' ? 'ambiguous' : 'incomplete'}`
    );
  }
}

// A full bounded scan is required before retrying an uncertain accepted send.
export async function findAuthoredReportMessage(
  channel: ReportHistoryChannel,
  authorId: string,
  marker: string | ((message: Message) => boolean),
  since: Date
): Promise<Message | null> {
  let before: string | undefined;
  let recovered: Message | null = null;
  for (let page = 0; page < 10; page++) {
    const messages = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
    for (const message of messages.values()) {
      if (message.author.id !== authorId) continue;
      const matches =
        typeof marker === 'string'
          ? message.embeds.some((embed) => embed.footer?.text === marker)
          : marker(message);
      if (!matches) continue;
      if (typeof marker === 'string') return message;
      if (recovered && recovered.id !== message.id)
        throw new ReportHistoryRecoveryError('history_ambiguous');
      recovered = message;
    }
    const last = messages.last();
    if (!last || messages.size < 100 || last.createdTimestamp < since.getTime()) return recovered;
    before = last.id;
  }
  throw new ReportHistoryRecoveryError('history_incomplete');
}
