import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  escapeMarkdown,
  type MessageCreateOptions,
} from 'discord.js';
import type { ReportCandidate } from '../services/ReportCandidateService';

export interface ReportPresentationAction {
  label: string;
  customId: string;
  primary?: boolean;
  disabled?: boolean;
}
type Identity = Pick<ReportCandidate, 'username' | 'globalName' | 'nickname' | 'avatarUrl'>;
export type ReportIntakePresentationState = (
  | { kind: 'confirm'; candidate: Identity; screenshotMatch?: boolean }
  | { kind: 'submitted'; targetName: string }
  | {
      kind:
        | 'start'
        | 'checking'
        | 'updating'
        | 'submitting'
        | 'failed'
        | 'uncertain'
        | 'review'
        | 'close_draft'
        | 'close_review'
        | 'closed'
        | 'closed_review';
    }
) & { actions: readonly ReportPresentationAction[] };

const COPY = {
  start: ['Tell us what happened', "Add a screenshot, message link, or the person's name."],
  checking: ['Checking your report', 'Looking for the account in your report.'],
  updating: ['Checking the new details', 'Your new evidence may change the suggested account.'],
  submitting: ['Submitting your report', 'This should only take a moment.'],
  failed: ["Your report wasn't submitted", 'Your evidence is still here. Try submitting again.'],
  uncertain: [
    'Checking submission',
    "We're checking whether your report went through. Your evidence is still here.",
  ],
  review: [
    'Sent to moderators',
    "A moderator will take a look. You don't need to do anything else.\n\nHave more to add? Send it here.",
  ],
  close_draft: ['Close this report?', "You won't be able to add more in this thread."],
  close_review: [
    'Close this thread?',
    "Moderators will still review your report. You won't be able to add more in this thread.",
  ],
  closed: ['Thread closed', 'You can no longer add to this thread.'],
  closed_review: ['Thread closed', 'Moderators still have your report.'],
} as const;
const NO_ACTIONS = new Set(['updating', 'submitting', 'uncertain', 'closed', 'closed_review']);
const text = (value: string): string => escapeMarkdown(value).replace(/@/g, '@\u200b');

export function buildReportIntakePresentation(
  state: ReportIntakePresentationState
): MessageCreateOptions {
  const embed = new EmbedBuilder().setAuthor({ name: 'Your report' }).setColor(0x8a91ff);
  if (state.kind === 'confirm') {
    const person = state.candidate;
    const name = person.globalName || person.username || 'Account';
    const lines = [`**${text(name)}**`];
    if (person.username) lines.push(`@${text(person.username)}`);
    if (person.nickname && person.nickname !== name)
      lines.push(`Server name: ${text(person.nickname)}`);
    if (state.screenshotMatch) lines.push('', 'This name appears in your screenshot.');
    embed.setTitle('Is this the right person?').setDescription(lines.join('\n'));
    if (person.avatarUrl && /^https:\/\//.test(person.avatarUrl))
      embed.setThumbnail(person.avatarUrl);
  } else if (state.kind === 'submitted') {
    embed
      .setTitle('Report submitted')
      .setColor(0x64b68a)
      .setDescription(
        `Moderators have your report about **${text(state.targetName)}**. You don't need to do anything else.`
      );
  } else {
    const [title, description] = COPY[state.kind];
    embed.setTitle(title).setDescription(description);
  }
  const actions = NO_ACTIONS.has(state.kind) ? [] : state.actions;
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  for (let i = 0; i < actions.length; i += 5) {
    rows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        actions.slice(i, i + 5).map((action) =>
          new ButtonBuilder()
            .setCustomId(action.customId)
            .setLabel(action.label)
            .setStyle(action.primary ? ButtonStyle.Primary : ButtonStyle.Secondary)
            .setDisabled(action.disabled ?? false)
        )
      )
    );
  }
  return { content: '', embeds: [embed], components: rows, allowedMentions: { parse: [] } };
}
