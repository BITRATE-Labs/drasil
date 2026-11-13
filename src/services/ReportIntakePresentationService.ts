import { IModerationQueueRepository } from '../repositories/ModerationQueueRepository';
import { IConfigService } from '../config/ConfigService';
import { getReportIntakeSettings } from '../utils/reportIntakeSettings';
import {
  findAuthoredReportMessage,
  ReportHistoryRecoveryError,
} from '../utils/reportPresentationDiscord';
import { inject, injectable } from 'inversify';
import {
  Client,
  ComponentType,
  SnowflakeUtil,
  type Message,
  type ThreadChannel,
  type EmbedBuilder,
  type MessageEditOptions,
} from 'discord.js';
import { randomBytes } from 'node:crypto';
import { projectReportIntakeState } from '@drasil/application';
import { TYPES } from '../di/symbols';
import { IReportIntakeRepository } from '../repositories/ReportIntakeRepository';
import {
  ownsPresentation,
  presentationMetadata,
  reporterActionRequiresRollout,
} from '../repositories/reportIntakeProcessing';
import {
  ReportIntakeStatus,
  type ReportIntake,
  type ReportPresentationClaim,
} from '../repositories/types';
import {
  buildReportIntakePresentation,
  type ReportIntakePresentationState,
  type ReportPresentationAction,
} from '../utils/reportIntakePresentation';
import {
  readReporterPresentation,
  reportRoot,
  reporterViewKey,
  type ReporterPresentation,
} from '../utils/reportIntakePresentationMetadata';
import {
  buildReportIntakeAdminActionsCustomId,
  buildReportIntakeThreadCloseCustomId,
} from '../utils/reportIntakeAdminActions';

export interface IReportIntakePresentationService {
  reconcile(intakeId: string): Promise<boolean>;
  presentClaim(claim: ReportPresentationClaim): Promise<void>;
}
@injectable()
export class ReportIntakePresentationService implements IReportIntakePresentationService {
  constructor(
    @inject(TYPES.ReportIntakeRepository) private repository: IReportIntakeRepository,
    @inject(TYPES.DiscordClient) private client: Client,
    @inject(TYPES.ConfigService) private configService: IConfigService,
    @inject(TYPES.ModerationQueueRepository) private queueRepository: IModerationQueueRepository
  ) {}
  async reconcile(intakeId: string): Promise<boolean> {
    let intake = await this.repository.findById(intakeId);
    if (!intake || !projectReportIntakeState(intake).staged) return false;
    if (reporterActionRequiresRollout(intake, new Date())) {
      const config = await this.configService.getServerConfig(intake.server_id, {
        forceRefresh: true,
        failOnReadError: true,
      });
      if (!getReportIntakeSettings(config.settings).stagedEnabled) return true;
    }
    let scheduled = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      const storedReporter = readReporterPresentation(intake);
      if (storedReporter?.threadMissing) return true;
      if (!storedReporter && reportRoot(intake).reporter_presentation !== undefined)
        throw new Error('Invalid reporter presentation metadata');
      const reporter = storedReporter ?? { nextDueAt: null };
      const saved = await this.repository.updateIfCurrent(intake, {
        metadata: {
          ...reportRoot(intake),
          reporter_presentation: { ...reporter, nextDueAt: new Date().toISOString() },
        },
      });
      if (saved) {
        scheduled = true;
        break;
      }
      const latest = await this.repository.findById(intakeId);
      if (!latest) throw new Error('Report intake unavailable');
      intake = latest;
    }
    if (!scheduled) {
      if (readReporterPresentation(intake)?.nextDueAt) return true;
      throw new Error('Report presentation scheduling changed');
    }
    const claim = await this.repository.claimPendingPresentation(new Date(), intakeId);
    if (!claim) return true;
    try {
      await this.presentClaim(claim);
      await this.repository.completePresentation(claim, { kind: 'published' });
    } catch (error) {
      await this.repository.completePresentation(claim, { kind: 'failed' });
      throw error;
    }
    return true;
  }
  private async current(claim: ReportPresentationClaim): Promise<ReportIntake> {
    const intake = await this.repository.findById(claim.intake.id);
    if (!intake || !ownsPresentation(intake, claim, new Date()))
      throw new Error('Report presentation changed');
    return intake;
  }
  private project(intake: ReportIntake, token: string): ReportIntakePresentationState {
    const { analysis } = presentationMetadata(intake);
    const state = projectReportIntakeState(intake);
    const close = {
      label: 'Close report',
      customId: buildReportIntakeThreadCloseCustomId(intake.id),
    };
    const admin = {
      label: 'Admin actions',
      customId: buildReportIntakeAdminActionsCustomId(intake.id),
    };
    const actions = [close, admin];
    const reviewed =
      state.status === 'submitted' ||
      state.status === 'actioned' ||
      (analysis.handoff.state !== 'none' && analysis.handoff.state !== 'pending');
    if (this.isClosed(intake)) return { kind: reviewed ? 'closed_review' : 'closed', actions: [] };
    if (state.status === 'submitted' || state.submission?.state === 'accepted') {
      const outcome = analysis.outcome;
      const candidate =
        outcome?.kind === 'confirm'
          ? outcome.candidate
          : outcome?.candidates.find((c) => c.discordUserId === intake.confirmed_target_user_id);
      return {
        kind: 'submitted',
        targetName: candidate?.globalName || candidate?.username || 'the reported account',
        actions: [{ ...close, label: 'Close thread' }, admin],
      };
    }
    if (state.submission) {
      if (state.submission.state === 'dispatching') return { kind: 'submitting', actions: [] };
      if (state.submission.state === 'unknown') return { kind: 'uncertain', actions: [] };
      if (!state.submission.settledAt) return { kind: 'submitting', actions: [] };
      return {
        kind: 'failed',
        actions: [
          {
            label: 'Try again',
            customId: `report_intake_confirm:${intake.id}:${state.submission.targetUserId}:${token}`,
            primary: true,
          },
          ...actions,
        ],
      };
    }
    if (state.status === 'needs_admin_confirmation') {
      return analysis.handoff.state !== 'none' && analysis.handoff.state !== 'pending'
        ? { kind: 'review', actions: [{ ...close, label: 'Close thread' }, admin] }
        : { kind: 'checking', actions };
    }
    if (
      state.status === 'needs_reporter_confirmation' &&
      intake.analysis_revision === intake.evidence_revision &&
      analysis.outcome?.kind === 'confirm' &&
      intake.analysis_due_at &&
      intake.analysis_due_at > new Date()
    ) {
      const candidate = analysis.outcome.candidate;
      const controls: ReportPresentationAction[] = [
        {
          label: 'Submit report',
          customId: `report_intake_confirm:${intake.id}:${candidate.discordUserId}:${token}`,
          primary: true,
        },
        { label: 'Not this person', customId: `report_intake_reject:${intake.id}:${token}` },
        ...actions,
      ];
      return { kind: 'confirm', candidate, actions: controls };
    }
    if (readReporterPresentation(intake)?.followupMessageId)
      return { kind: 'updating', actions: [] };
    return { kind: intake.evidence_revision ? 'checking' : 'start', actions };
  }
  private async checkRollout(
    state: ReportIntakePresentationState,
    intake: ReportIntake
  ): Promise<void> {
    if (state.kind !== 'confirm' && state.kind !== 'failed') return;
    const config = await this.configService.getServerConfig(intake.server_id, {
      forceRefresh: true,
      failOnReadError: true,
    });
    if (!getReportIntakeSettings(config.settings).stagedEnabled)
      throw new Error('Staged report confirmation disabled');
  }
  async presentClaim(claim: ReportPresentationClaim): Promise<void> {
    const intake = await this.current(claim);
    if (reportRoot(intake).reporter_presentation !== undefined && !readReporterPresentation(intake))
      throw new Error('Invalid reporter presentation metadata');
    if (readReporterPresentation(intake)?.threadMissing) return;
    try {
      await this.presentAvailableClaim(claim);
      if (readReporterPresentation(await this.current(claim))?.deliveryAttention)
        await this.queueRepository.setReportDeliveryFailure(claim, null);
    } catch (error) {
      if (error instanceof ReportHistoryRecoveryError)
        await this.queueRepository.setReportDeliveryFailure(claim, error.reason);
      if ((error as { code?: number }).code !== 10003) throw error;
      const latest = await this.current(claim);
      const reporter = readReporterPresentation(latest);
      if (
        !(await this.repository.updateIfCurrent(latest, {
          metadata: {
            ...reportRoot(latest),
            reporter_presentation: { ...reporter, threadMissing: true, nextDueAt: null },
          },
        }))
      )
        throw new Error('Report presentation changed');
    }
  }
  private async presentAvailableClaim(claim: ReportPresentationClaim): Promise<void> {
    let intake = await this.current(claim);
    const closed = this.isClosed(intake);
    if (!closed && !readReporterPresentation(intake)?.restoreArchive)
      return this.presentActiveClaim(claim);
    const channel = intake.thread_id ? await this.client.channels.fetch(intake.thread_id) : null;
    if (!channel) throw Object.assign(new Error('Report thread missing'), { code: 10003 });
    if (!channel.isThread() || channel.guildId !== intake.server_id)
      throw new Error('Report thread mismatch');
    if (!closed) {
      await this.restoreClosedThread(claim, channel);
      return this.presentActiveClaim(claim);
    }
    let reporter = readReporterPresentation(intake);
    if (!channel.archived && !reporter?.restoreArchive) {
      await this.restoreClosedThread(claim, channel);
      intake = await this.current(claim);
      reporter = readReporterPresentation(intake);
    }
    const view = reporterViewKey(intake);
    if (reporter?.closedCardView === view && channel.archived && !reporter.restoreArchive) return;
    if (
      !(await this.repository.updateIfCurrent(intake, {
        metadata: {
          ...reportRoot(intake),
          reporter_presentation: { ...reporter, restoreArchive: true },
        },
      }))
    )
      throw new Error('Report closure changed');
    try {
      if (reporter?.closedCardView !== view) {
        if (channel.archived) await channel.setArchived(false, 'Update closed report card');
        await this.presentActiveClaim(claim);
        intake = await this.current(claim);
        reporter = readReporterPresentation(intake);
        if (
          !(await this.repository.updateIfCurrent(intake, {
            metadata: {
              ...reportRoot(intake),
              reporter_presentation: { ...reporter, closedCardView: view },
            },
          }))
        )
          throw new Error('Report closure changed');
      }
    } finally {
      await this.restoreClosedThread(claim, channel);
    }
  }
  private isClosed(intake: ReportIntake): boolean {
    const metadata = reportRoot(intake);
    return Boolean(
      metadata.thread_closed_at ||
      metadata.observed_action_closed_at ||
      intake.status === ReportIntakeStatus.CLOSED_BY_REPORTER ||
      (intake.closed_at &&
        intake.status !== ReportIntakeStatus.SUBMITTED &&
        intake.status !== ReportIntakeStatus.ACTIONED)
    );
  }
  private async restoreClosedThread(
    claim: ReportPresentationClaim,
    channel: ThreadChannel
  ): Promise<void> {
    // An observed-action undo can race the archive call; keep repair durable until intent agrees.
    let settled = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      const before = await this.repository.findById(claim.intake.id);
      if (!before || before.thread_id !== channel.id) throw new Error('Report closure changed');
      const archived = this.isClosed(before);
      if (!archived && !reportRoot(before).observed_action_reopened_at)
        throw new Error('Report closure changed');
      try {
        await channel.setArchived(
          archived,
          archived ? 'Report intake closed' : 'Report intake reopened'
        );
      } catch (error) {
        const verified = await channel.fetch(true).catch(() => null);
        if (!verified || verified.archived !== archived) throw error;
      }
      const after = await this.repository.findById(claim.intake.id);
      if (after && this.isClosed(after) === archived) {
        settled = true;
        break;
      }
    }
    if (!settled) throw new Error('Report closure changed');
    const intake = await this.current(claim);
    const reporter = readReporterPresentation(intake);
    if (
      !(await this.repository.updateIfCurrent(intake, {
        metadata: {
          ...reportRoot(intake),
          reporter_presentation: { ...reporter, restoreArchive: false },
        },
      }))
    )
      throw new Error('Report closure changed');
  }
  private async presentActiveClaim(claim: ReportPresentationClaim): Promise<void> {
    let intake = await this.current(claim);
    if (!intake.thread_id || !this.client.user) throw new Error('Report thread unavailable');
    const channel = await this.client.channels.fetch(intake.thread_id);
    if (!channel) throw Object.assign(new Error('Report thread missing'), { code: 10003 });
    if (
      !('messages' in channel) ||
      !('send' in channel) ||
      !('guildId' in channel) ||
      channel.guildId !== intake.server_id ||
      channel.id !== intake.thread_id
    )
      throw new Error('Report thread mismatch');
    const token = randomBytes(5).toString('hex');
    let state = this.project(intake, token);
    await this.checkRollout(state, intake);
    let reporter = readReporterPresentation(intake) ?? { nextDueAt: new Date().toISOString() };
    // Account for an uncertain send before choosing the card for the latest state.
    if (reporter.pendingSend) {
      const reservation = reporter.pendingSend;
      const recovered = await findAuthoredReportMessage(
        channel,
        this.client.user.id,
        (candidate) =>
          candidate.channelId === intake.thread_id &&
          (!reservation.afterMessageId ||
            BigInt(candidate.id) > BigInt(reservation.afterMessageId)) &&
          candidate.embeds.some(
            (embed) => embed.author?.name === 'Your report' && embed.title === reservation.title
          ),
        new Date(
          reservation.afterMessageId ? SnowflakeUtil.timestampFrom(reservation.afterMessageId) : 0
        )
      );
      intake = await this.current(claim);
      const resolved = { ...reporter, ...(recovered ? { [reservation.slot]: recovered.id } : {}) };
      delete resolved.pendingSend;
      if (
        !(await this.repository.updateIfCurrent(intake, {
          metadata: { ...reportRoot(intake), reporter_presentation: resolved },
        }))
      )
        throw new Error('Report reservation changed');
      intake = await this.current(claim);
      reporter = resolved;
      state = this.project(intake, token);
    }
    const slot: 'openingMessageId' | 'followupMessageId' =
      reporter.followupMessageId || !['start', 'checking'].includes(state.kind)
        ? 'followupMessageId'
        : 'openingMessageId';
    const legacyId = reportRoot(intake).last_confirmation_prompt_message_id;
    const previousId =
      reporter[slot] ||
      (slot === 'followupMessageId' && typeof legacyId === 'string' ? legacyId : undefined);
    let message: Message | null = null;
    if (previousId) {
      try {
        message = await channel.messages.fetch(previousId);
      } catch (error) {
        if ((error as { code?: number }).code !== 10008) throw error;
      }
    }
    if (
      message &&
      (message.author.id !== this.client.user.id || message.channelId !== intake.thread_id)
    )
      throw new Error('Report message mismatch');
    if (!message && !previousId) {
      message = await findAuthoredReportMessage(
        channel,
        this.client.user.id,
        (candidate) => {
          if (candidate.channelId !== intake.thread_id) return false;
          const ids = candidate.components.flatMap((row) =>
            row.type === ComponentType.ActionRow
              ? row.components.flatMap((c) => ('customId' in c && c.customId ? [c.customId] : []))
              : []
          );
          const confirmation = ids.some(
            (id) =>
              id.startsWith(`report_intake_confirm:${intake.id}:`) ||
              id.startsWith(`report_intake_reject:${intake.id}:`)
          );
          const opening =
            ids.includes(buildReportIntakeThreadCloseCustomId(intake.id)) &&
            !confirmation &&
            candidate.embeds.every(
              (e) => !e.title || ['Tell us what happened', 'Checking your report'].includes(e.title)
            );
          const receipt =
            slot === 'followupMessageId' &&
            candidate.embeds.some((e) => e.footer?.text === `Report receipt ${intake.id}`);
          return (slot === 'openingMessageId' ? opening : confirmation) || receipt;
        },
        intake.created_at ?? new Date(0)
      );
    }
    const payload = buildReportIntakePresentation(state);
    if (!message) {
      intake = await this.current(claim);
      reporter = readReporterPresentation(intake) ?? reporter;
      const title = (payload.embeds?.[0] as EmbedBuilder | undefined)?.data.title;
      if (!title) throw new Error('Report card title missing');
      // Discord's latest message is a recovery boundary independent of our host clock.
      const latestMessage = (await channel.messages.fetch({ limit: 1 })).first();
      const first =
        state.kind === 'confirm' &&
        !previousId &&
        !reporter.pendingSend &&
        !reporter.confirmationMentionReserved;
      const reserved: ReporterPresentation = {
        ...reporter,
        ...(first ? { confirmationMentionReserved: true } : {}),
        pendingSend: {
          slot,
          revision: intake.evidence_revision,
          afterMessageId: latestMessage?.id ?? null,
          title,
        },
      };
      const saved = await this.repository.updateIfCurrent(intake, {
        metadata: { ...reportRoot(intake), reporter_presentation: reserved },
      });
      if (!saved) throw new Error('Report reservation changed');
      await this.current(claim);
      await this.checkRollout(state, intake);
      message = await channel.send({
        ...payload,
        components: state.kind === 'confirm' || state.kind === 'failed' ? [] : payload.components,
        ...(first
          ? {
              content: `<@${intake.reporter_id}>`,
              allowedMentions: { parse: [], users: [intake.reporter_id] },
            }
          : {}),
      });
    }
    intake = await this.current(claim);
    reporter = readReporterPresentation(intake) ?? reporter;
    const savedReporter = { ...reporter };
    delete savedReporter.pendingSend;
    const metadata: Record<string, unknown> = {
      ...reportRoot(intake),
      reporter_presentation: { ...savedReporter, [slot]: message.id },
    };
    if (state.kind === 'confirm' || state.kind === 'failed') {
      const { analysis } = presentationMetadata(intake);
      const target =
        state.kind === 'failed'
          ? intake.confirmed_target_user_id
          : analysis.outcome?.kind === 'confirm'
            ? analysis.outcome.candidate.discordUserId
            : null;
      if (!target) throw new Error('Report suggestion changed');
      metadata.last_confirmation_prompt_message_id = message.id;
      metadata.last_confirmation_prompt_token = token;
      metadata.last_confirmation_prompt_candidate_ids = [target];
      metadata.confirmation_prompt_candidate_ids_by_token = { [token]: [target] };
      metadata.last_confirmation_prompt_revision = intake.evidence_revision;
      metadata.confirmation_prompt_message_ids = [message.id];
    }
    const saved = await this.repository.updateIfCurrent(intake, { metadata });
    if (!saved) throw new Error('Report message changed');
    intake = await this.current(claim);
    state = this.project(intake, token);
    await this.checkRollout(state, intake);
    const edited = buildReportIntakePresentation(state);
    await message.edit({
      content: edited.content,
      embeds: edited.embeds,
      components: edited.components,
      allowedMentions: { parse: [] },
    } as MessageEditOptions);
    try {
      const current = await this.current(claim);
      await this.checkRollout(this.project(current, token), current);
    } catch (error) {
      await message.edit({ components: [] }).catch(() => undefined);
      const latest = await this.repository.findById(intake.id);
      if (latest) {
        const presentation = readReporterPresentation(latest);
        if (presentation)
          await this.repository.updateIfCurrent(latest, {
            metadata: {
              ...reportRoot(latest),
              reporter_presentation: { ...presentation, nextDueAt: new Date().toISOString() },
            },
          });
      }
      throw error;
    }
    if (slot === 'followupMessageId' && savedReporter.openingMessageId) {
      const opening = await channel.messages
        .fetch(savedReporter.openingMessageId)
        .catch((error) => {
          if ((error as { code?: number }).code === 10008) return null;
          throw error;
        });
      if (opening?.author.id === this.client.user.id) {
        const start = buildReportIntakePresentation({ kind: 'start', actions: [] });
        await opening.edit({
          content: start.content,
          embeds: start.embeds,
          components: [],
        } as MessageEditOptions);
      }
    }
  }
}
