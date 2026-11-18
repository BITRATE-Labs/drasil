import type { RestrictionRoleDisposition, RestrictionRolePolicyInput } from './restrictionTypes';

export const STANDARD_RESTRICTION_PRIVILEGED_PERMISSIONS =
  (1n << 3n) | (1n << 28n) | (1n << 5n) | (1n << 40n);
/** Global powers defeat compromised-account containment even when channels are hidden. */
export const COMPROMISED_RESTRICTION_PRIVILEGED_PERMISSION_FLAGS = [
  1n << 3n,
  1n << 28n,
  1n << 5n,
  1n << 40n,
  1n << 4n,
  1n << 1n,
  1n << 2n,
  1n << 13n,
  1n << 34n,
  1n << 29n,
  1n << 0n,
  1n << 22n,
  1n << 23n,
  1n << 24n,
  1n << 27n,
  1n << 30n,
  1n << 43n,
  1n << 33n,
  1n << 44n,
  1n << 17n,
] as const;
export const COMPROMISED_RESTRICTION_PRIVILEGED_PERMISSIONS =
  COMPROMISED_RESTRICTION_PRIVILEGED_PERMISSION_FLAGS.reduce((mask, flag) => mask | flag, 0n);
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
