import { ChatInputCommandInteraction, Guild } from 'discord.js';
import { LockdownConfigCommandHandler } from '../../controllers/LockdownConfigCommandHandler';
import { IConfigService } from '../../config/ConfigService';
test('view names only explicit read-only exceptions and separates recovery technical access', async () => {
  const editReply = jest.fn();
  const interaction = {
    options: { getSubcommand: () => 'view' },
    deferReply: jest.fn(),
    editReply,
  } as unknown as ChatInputCommandInteraction;
  const config = {
    getServerConfig: jest.fn().mockResolvedValue({
      verification_channel_id: 'recovery',
      settings: {
        report_instructions_channel_id: 'reports',
        case_role_lockdown_allowed_channel_ids: ['111111'],
        case_role_lockdown_allowed_category_ids: ['222222'],
      },
    }),
  } as unknown as IConfigService;
  await new LockdownConfigCommandHandler(config).handleLockdownConfigCommand(interaction, {
    id: 'guild',
  } as Guild);
  expect(editReply.mock.calls[0][0].content).toContain('Explicit read-only channels: <#111111>');
  expect(editReply.mock.calls[0][0].content).toContain(
    'Recovery parent (technical case-thread access): <#recovery>'
  );
  expect(editReply.mock.calls[0][0].content).not.toContain('<#reports>');
  expect(editReply.mock.calls[0][0].content).not.toContain('Auto-allowed');
});
