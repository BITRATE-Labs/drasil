import type { RestrictionRoleFact } from '@drasil/application';
import type { GuildMember, Role } from 'discord.js';

/** Preserve Discord hierarchy ties before the platform-neutral policy compares numeric positions. */
export function restrictionRoleFact(role: Role, bot: GuildMember | null): RestrictionRoleFact {
  return {
    id: role.id,
    name: role.name,
    position:
      bot && bot.roles.highest.comparePositionTo(role) > 0
        ? Math.min(role.position, bot.roles.highest.position - 1)
        : role.position,
    permissions: role.permissions.bitfield.toString(),
    managed: role.managed,
    botManaged: typeof role.tags?.botId === 'string',
  };
}
