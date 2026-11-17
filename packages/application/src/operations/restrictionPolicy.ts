import type { RestrictionRoleDisposition, RestrictionRolePolicyInput } from './restrictionTypes';

export const STANDARD_RESTRICTION_PRIVILEGED_PERMISSIONS =
  (1n << 3n) | (1n << 28n) | (1n << 5n) | (1n << 40n);
export function classifyRestrictionRoles(
  input: RestrictionRolePolicyInput
): readonly RestrictionRoleDisposition[] {
  return input.roles.map((role) => {
    const standard = input.purpose === 'standard_case';
    let skipReason: RestrictionRoleDisposition['skipReason'] = null;
    if (role.id === input.guildId) skipReason = 'everyone role';
    else if (role.id === input.caseRoleId) skipReason = 'case role';
    else if (
      standard &&
      (input.exemptRoleIds.includes(role.id) || role.id === input.manualIntakeRoleId)
    )
      skipReason = 'configured exempt role';
    else if (role.botManaged) skipReason = 'bot-managed role';
    else if (role.managed) skipReason = 'managed role';
    else if (
      standard &&
      (BigInt(role.permissions) & STANDARD_RESTRICTION_PRIVILEGED_PERMISSIONS) !== 0n
    )
      skipReason = 'privileged role';
    else if (input.botHighestPosition === null) skipReason = 'Drasil member could not be loaded';
    else if (role.position >= input.botHighestPosition)
      skipReason = 'role is at or above Drasil role';
    return { roleId: role.id, removable: skipReason === null, skipReason };
  });
}
