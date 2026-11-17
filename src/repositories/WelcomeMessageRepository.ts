import { inject, injectable } from 'inversify';
import { PrismaClient } from '../db/prisma';
import { TYPES } from '../di/symbols';

export const WELCOME_JOIN_WINDOW_MS = 2 * 60 * 1000;
export interface WelcomeMemberSnapshot {
  names: string[];
  joinedAt: string;
}
export interface WelcomeCandidate {
  server_id: string;
  message_id: string;
  channel_id: string;
  bot_id: string;
  created_at: Date;
  snapshots_complete: boolean;
  verification_attempted: boolean;
  recipient_id: string | null;
  verified_edited_at: Date | null;
  expires_at: Date;
  member_snapshots: Partial<Record<string, WelcomeMemberSnapshot>>;
}

@injectable()
export class WelcomeMessageRepository {
  constructor(@inject(TYPES.PrismaClient) private readonly prisma: PrismaClient) {}

  async collect(candidate: WelcomeCandidate): Promise<void> {
    const snapshots = JSON.stringify(candidate.member_snapshots);
    await this.prisma.$executeRaw`
      INSERT INTO public.welcome_message_candidates
        (server_id, message_id, channel_id, bot_id, created_at, member_snapshots, snapshots_complete, expires_at)
      VALUES (${candidate.server_id}, ${candidate.message_id}, ${candidate.channel_id},
        ${candidate.bot_id}, ${candidate.created_at}, CAST(${snapshots} AS jsonb), ${candidate.snapshots_complete}, ${candidate.expires_at})
      ON CONFLICT (server_id, message_id) DO NOTHING
    `;
  }

  async findForBan(
    serverId: string,
    userId: string,
    channelId: string,
    botId: string,
    joinedAt: Date | null
  ): Promise<WelcomeCandidate[]> {
    const until = joinedAt ? new Date(joinedAt.getTime() + WELCOME_JOIN_WINDOW_MS) : null;
    return this.prisma.$queryRaw<WelcomeCandidate[]>`
      SELECT * FROM public.welcome_message_candidates
      WHERE server_id = ${serverId} AND channel_id = ${channelId} AND bot_id = ${botId}
        AND expires_at > now()
        AND (NOT verification_attempted OR recipient_id = ${userId})
        AND (member_snapshots ? ${userId}
          OR (created_at >= ${joinedAt}::timestamptz AND created_at <= ${until}::timestamptz))
      ORDER BY created_at
    `;
  }

  async recordRecipient(
    serverId: string,
    messageId: string,
    recipientId: string | null,
    editedAt: Date | null
  ): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE public.welcome_message_candidates
      SET verification_attempted = true, recipient_id = ${recipientId}, verified_edited_at = ${editedAt}
      WHERE server_id = ${serverId} AND message_id = ${messageId}
    `;
  }

  async remove(serverId: string, messageId: string): Promise<void> {
    await this.prisma.$executeRaw`
      DELETE FROM public.welcome_message_candidates
      WHERE server_id = ${serverId} AND message_id = ${messageId}
    `;
  }
}
