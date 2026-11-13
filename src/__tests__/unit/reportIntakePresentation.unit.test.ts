import { buildReportIntakePresentation } from '../../utils/reportIntakePresentation';
import { EmbedBuilder } from 'discord.js';

const candidate = {
  username: 'example',
  globalName: '**Someone**',
  nickname: 'Server name',
  avatarUrl: null,
};
const card = (state: Parameters<typeof buildReportIntakePresentation>[0]) => {
  const result = buildReportIntakePresentation(state);
  return { result, embed: (result.embeds![0] as EmbedBuilder).toJSON() };
};
describe('reporter cards', () => {
  it('shows an escaped account and distinct server nickname without diagnostics', () => {
    const { result, embed } = card({
      kind: 'confirm',
      candidate,
      screenshotMatch: false,
      actions: [],
    });
    expect(embed.description).toContain('\\*\\*Someone\\*\\*');
    expect(embed.description).toContain('@example');
    expect(embed.description).toContain('Server name');
    expect(embed.description).not.toContain('screenshot');
    expect(embed.footer).toBeUndefined();
    expect(result.allowedMentions).toEqual({ parse: [] });
  });
  it('omits duplicate nickname and absent avatar', () => {
    const { embed } = card({
      kind: 'confirm',
      candidate: { ...candidate, globalName: 'Name', nickname: 'Name' },
      actions: [],
    });
    expect(embed.description).not.toContain('Server name:');
    expect(embed.thumbnail).toBeUndefined();
  });
  it.each(['updating', 'submitting', 'uncertain', 'closed', 'closed_review'] as const)(
    'cannot expose caller-provided submit actions while %s',
    (kind) => {
      const { result } = card({ kind, actions: [{ label: 'Submit report', customId: 'unsafe' }] });
      expect(result.components).toEqual([]);
    }
  );
  it('renders retry only for a definite failure', () => {
    const { result, embed } = card({
      kind: 'failed',
      actions: [{ label: 'Try again', customId: 'retry' }],
    });
    expect(embed.title).toBe("Your report wasn't submitted");
    expect(result.components).toHaveLength(1);
    expect(card({ kind: 'uncertain', actions: [] }).embed.title).toBe('Checking submission');
  });
});
