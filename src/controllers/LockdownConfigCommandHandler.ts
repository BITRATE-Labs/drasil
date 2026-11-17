import { requireSetupOutcome } from '../application/adapters/setup';
import { createDiscordActionContext } from '../application/context';
import type { BotApplication } from '../application/createBotApplication';
import { ChannelType, ChatInputCommandInteraction, Guild, MessageFlags } from 'discord.js';
import { IConfigService } from '../config/ConfigService';
import { ServerSettings } from '../repositories/types';
import { ICaseRoleLockdownService } from '../services/CaseRoleLockdownService';
import { getCaseRoleLockdownSettings } from '../utils/caseRoleLockdownSettings';

export class LockdownConfigCommandHandler {
  public constructor(
    private readonly configService: IConfigService,
    private readonly caseRoleLockdownService?: ICaseRoleLockdownService,
    private readonly application?: BotApplication
  ) {}

  public async handleLockdownConfigCommand(
    interaction: ChatInputCommandInteraction,
    guild: Guild
  ): Promise<void> {
    const subcommand = interaction.options.getSubcommand(true);

    if (subcommand === 'view') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const serverConfig = await this.configService.getServerConfig(guild.id);
      await interaction.editReply({
        content: this.formatCaseRoleLockdownSettings(
          guild.id,
          serverConfig.verification_channel_id,
          serverConfig.settings
        ),
        allowedMentions: { parse: [] },
      });
      return;
    }

    if (subcommand === 'disable') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      if (!this.application) throw new Error('Setup application is unavailable.');
      requireSetupOutcome(
        await this.application.setup.execute(
          createDiscordActionContext({
            guildId: guild.id,
            userId: interaction.user.id,
            requestId: interaction.id,
          }),
          { kind: 'disable_lockdown' }
        )
      );
      await interaction.editReply({
        content:
          'Case-role lockdown marked disabled. Existing Discord channel overwrites were not removed.',
      });
      return;
    }

    if (subcommand === 'allow-add' || subcommand === 'allow-remove') {
      await this.handleLockdownAllowListCommand(interaction, guild.id, subcommand === 'allow-add');
      return;
    }

    if (!this.caseRoleLockdownService) {
      await interaction.reply({
        content: 'Case-role lockdown is not available in this runtime.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      if (!this.application) throw new Error('Operations application is unavailable.');
      const context = createDiscordActionContext({
        guildId: guild.id,
        userId: interaction.user.id,
        requestId: interaction.id,
      });
      const reviewUrl = `${(process.env.NEXT_PUBLIC_APP_URL ?? process.env.DRASIL_WEB_PUBLIC_URL ?? 'https://drasil.app').replace(/\/$/, '')}/admin/guild/${encodeURIComponent(guild.id)}/operations/restrictions`;
      if (subcommand === 'apply') {
        await interaction.editReply({
          content: `plan_required: Run a fresh restriction audit and review selected repairs before applying them. ${reviewUrl}`,
          allowedMentions: { parse: [] },
        });
        return;
      }
      const requestId = await this.application.operationsRuntime.enqueueAudit(context);
      await interaction.editReply({
        content: `Restriction audit queued. Request: ${requestId}. Review coverage and selected repairs: ${reviewUrl}`,
        allowedMentions: { parse: [] },
      });
    } catch (error) {
      console.error(`Failed to run lockdown ${subcommand} for guild ${guild.id}:`, error);
      await interaction.editReply({
        content: 'Failed to run case-role lockdown. Please check permissions and try again.',
      });
    }
  }

  private async handleLockdownAllowListCommand(
    interaction: ChatInputCommandInteraction,
    guildId: string,
    added: boolean
  ): Promise<void> {
    const channel = interaction.options.getChannel('channel', true);
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const isCategory = channel.type === ChannelType.GuildCategory;
    if (!this.application) throw new Error('Setup application is unavailable.');
    requireSetupOutcome(
      await this.application.setup.execute(
        createDiscordActionContext({
          guildId,
          userId: interaction.user.id,
          requestId: interaction.id,
        }),
        {
          kind: added ? 'lockdown_allow_add' : 'lockdown_allow_remove',
          targetId: channel.id,
          targetKind: isCategory ? 'category' : 'channel',
        }
      )
    );

    await interaction.editReply({
      content: `${isCategory ? 'Category' : 'Channel'} <#${channel.id}> ${added ? 'added to' : 'removed from'} the case-role lockdown allow-list. Run \`/config lockdown audit\` to check for conflicts.`,
      allowedMentions: { parse: [] },
    });
  }

  private formatCaseRoleLockdownSettings(
    guildId: string,
    verificationChannelId: string | null,
    settings: ServerSettings
  ): string {
    const lockdownSettings = getCaseRoleLockdownSettings(settings);
    return [
      `Case-role lockdown: \`${lockdownSettings.enabled ? 'enabled' : 'disabled'}\``,
      `Explicit read-only channels: ${this.formatChannelIdList(lockdownSettings.allowedChannelIds)}`,
      `Explicit read-only categories: ${this.formatChannelIdList(lockdownSettings.allowedCategoryIds)}`,
      `Recovery parent (technical case-thread access): ${this.formatChannelIdList(verificationChannelId ? [verificationChannelId] : [])}`,
      `Guild ID: \`${guildId}\``,
      '',
      'Run `/config lockdown audit`, then review selected repairs in the dashboard.',
      'Lockdown does not delete messages. Message cleanup should be a separate moderator-confirmed action.',
    ].join('\n');
  }

  private formatChannelIdList(channelIds: readonly string[]): string {
    if (channelIds.length === 0) {
      return '`none`';
    }

    return channelIds.map((channelId) => `<#${channelId}>`).join(', ');
  }
}
