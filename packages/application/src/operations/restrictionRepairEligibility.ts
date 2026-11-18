import type { RestrictionCaseFact, RestrictionRoleFact } from './restrictionTypes';
import { STANDARD_RESTRICTION_PRIVILEGED_PERMISSIONS } from './restrictionPolicy';

export interface RestrictionRepairSnapshot {
  readonly status: string;
  readonly planned_role_ids: readonly string[];
  readonly metadata: unknown;
}
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
/** Prior removals remain owned even when their old transport reported failure. */
export function restrictionSnapshotRoleBlock(
  snapshot: RestrictionRepairSnapshot | null,
  roleId: string,
  claim?: { readonly requestId: string; readonly attemptToken: string }
): string | null {
  if (!snapshot) return null;
  if (snapshot.status !== 'active') return 'The case role snapshot is no longer active';
  const owners = record(record(snapshot.metadata)?.restriction_role_owners);
  const owner = owners?.[roleId];
  if (owner !== undefined) {
    const binding = record(owner);
    if (
      !claim ||
      binding?.requestId !== claim.requestId ||
      binding?.attemptToken !== claim.attemptToken
    )
      return 'A prior restriction repair owns this role removal';
  } else if (snapshot.planned_role_ids.includes(roleId)) {
    return 'An earlier quarantine planned this removal without restriction ownership';
  }
  return null;
}
/** This bounded projection stays in private audit facts, without request or attempt tokens. */
export function restrictionRepairEligibility(
  snapshot: RestrictionRepairSnapshot | null,
  quarantineAttemptId: string | null,
  departed: boolean,
  competingSnapshot = false
): NonNullable<RestrictionCaseFact['repairEligibility']> {
  const owners = record(record(snapshot?.metadata)?.restriction_role_owners);
  return {
    reason: competingSnapshot
      ? 'Another case owns an active role snapshot for this member'
      : quarantineAttemptId
        ? 'A quarantine attempt is still active'
        : departed
          ? 'The case member previously departed'
          : snapshot && snapshot.status !== 'active'
            ? 'The case role snapshot is no longer active'
            : null,
    blockedRoles: [
      ...new Set([...(snapshot?.planned_role_ids ?? []), ...Object.keys(owners ?? {})]),
    ]
      .sort()
      .flatMap((roleId) => {
        const reason = restrictionSnapshotRoleBlock(snapshot, roleId);
        return reason ? [{ roleId, reason }] : [];
      }),
  };
}
export function restrictionMemberHasProtectedRole(
  roles: readonly Pick<RestrictionRoleFact, 'id' | 'permissions'>[],
  caseRoleId: string | null
): boolean {
  return roles.some(
    (role) =>
      role.id !== caseRoleId &&
      (BigInt(role.permissions) & STANDARD_RESTRICTION_PRIVILEGED_PERMISSIONS) !== 0n
  );
}
