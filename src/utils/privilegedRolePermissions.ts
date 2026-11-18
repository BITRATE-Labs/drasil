import { COMPROMISED_RESTRICTION_PRIVILEGED_PERMISSION_FLAGS } from '@drasil/application';
import { PermissionFlagsBits } from 'discord.js';

export const STANDARD_QUARANTINE_PRIVILEGED_ROLE_PERMISSIONS = [
  PermissionFlagsBits.Administrator,
  PermissionFlagsBits.ManageRoles,
  PermissionFlagsBits.ManageGuild,
  PermissionFlagsBits.ModerateMembers,
] as const;

export const COMPROMISED_ACCOUNT_PRIVILEGED_ROLE_PERMISSIONS =
  COMPROMISED_RESTRICTION_PRIVILEGED_PERMISSION_FLAGS;
