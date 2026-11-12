import { injectable, inject } from 'inversify';
import { GuildMember, PermissionFlagsBits } from 'discord.js';
import { TYPES } from '../di/symbols';
import { IConfigService } from '../config/ConfigService';

/**
 * Interface for the RoleManager
 */
export interface IRoleManager {
  getCaseRoleId(guildId: string): Promise<string | null>;
  assertSafeCaseRole(member: GuildMember, roleId: string): Promise<void>;
  /**
   * Assigns the case role to a guild member
   * @param member The guild member receiving the case role
   * @returns Promise resolving to true if successful, false if the role couldn't be assigned
   */
  assignCaseRole(member: GuildMember, roleId?: string): Promise<boolean>;

  /**
   * Removes the case role from a guild member
   * @param member The guild member losing the case role
   * @returns Promise resolving to true if successful, false if the role couldn't be removed
   */
  removeCaseRole(member: GuildMember, roleId?: string): Promise<boolean>;
}

/**
 * Service for managing Discord roles
 * This service ONLY manages roles for users and nothing else
 */
@injectable()
export class RoleManager implements IRoleManager {
  private configService: IConfigService;

  constructor(@inject(TYPES.ConfigService) configService: IConfigService) {
    this.configService = configService;
  }

  /** Resolve once when assignment and compensation must use the same role. */
  public async getCaseRoleId(guildId: string): Promise<string | null> {
    return (await this.configService.getCaseRole(guildId))?.id ?? null;
  }

  public async assertSafeCaseRole(member: GuildMember, roleId: string): Promise<void> {
    const role = await member.guild.roles.fetch(roleId, { force: true });
    if (!member.guild.members.me) await member.guild.members.fetchMe();
    if (!member.guild.members.me)
      throw new Error('Bot membership is unavailable for role validation.');
    if (
      !role ||
      role.id === member.guild.id ||
      role.managed ||
      !role.editable ||
      role.permissions.bitfield !== 0n
    ) {
      throw new Error('Case role is missing, unassignable, or grants guild permissions.');
    }
    const unsafeAllows = [
      PermissionFlagsBits.Administrator,
      PermissionFlagsBits.ManageGuild,
      PermissionFlagsBits.ManageChannels,
      PermissionFlagsBits.ManageRoles,
      PermissionFlagsBits.ManageMessages,
      PermissionFlagsBits.ManageThreads,
      PermissionFlagsBits.ManageWebhooks,
      PermissionFlagsBits.ModerateMembers,
      PermissionFlagsBits.KickMembers,
      PermissionFlagsBits.BanMembers,
      PermissionFlagsBits.MuteMembers,
      PermissionFlagsBits.DeafenMembers,
      PermissionFlagsBits.MoveMembers,
    ];
    const channels = await member.guild.channels.fetch();
    for (const channel of channels.values()) {
      if (!channel || !('permissionOverwrites' in channel)) continue;
      const overwrite = channel.permissionOverwrites.cache.get(roleId);
      if (overwrite && unsafeAllows.some((permission) => overwrite.allow.has(permission))) {
        throw new Error('Case role grants channel management or moderation permissions.');
      }
    }
  }

  /**
   * Assigns the case role to a guild member
   * @param member The guild member receiving the case role
   * @returns Promise resolving to true if successful, false if the role couldn't be assigned
   */
  public async assignCaseRole(member: GuildMember, roleId?: string): Promise<boolean> {
    const caseRole = roleId ?? (await this.getCaseRoleId(member.guild.id));
    if (!caseRole) {
      console.error('No case role ID configured');
      return false;
    }

    await this.assertSafeCaseRole(member, caseRole);
    await member.roles.add(caseRole);

    return true;
  }

  /**
   * Removes the case role from a guild member
   * @param member The guild member losing the case role
   * @returns Promise resolving to true if successful, false if the role couldn't be removed
   */
  public async removeCaseRole(member: GuildMember, roleId?: string): Promise<boolean> {
    const caseRole = roleId ?? (await this.configService.getCaseRole(member.guild.id));
    if (!caseRole) {
      console.error('No case role ID configured');
      return false;
    }

    await member.roles.remove(caseRole);

    return true;
  }
}
