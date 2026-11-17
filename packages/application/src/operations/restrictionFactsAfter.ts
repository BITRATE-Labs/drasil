import type { RestrictionFacts, RestrictionEffect } from './restrictionTypes';
/** Advance the approved before-state only by our verified effects. */
export function restrictionFactsAfter(
  facts: RestrictionFacts,
  effect: RestrictionEffect
): RestrictionFacts {
  switch (effect.kind) {
    case 'set_role_permissions':
      return {
        ...facts,
        roles: facts.roles.map((r) =>
          r.id === effect.roleId
            ? {
                ...r,
                permissions: (
                  (BigInt(r.permissions) & ~BigInt(effect.mask)) |
                  (BigInt(effect.desired) & BigInt(effect.mask))
                ).toString(),
              }
            : r
        ),
      };
    case 'update_quarantine_policy':
      return { ...facts, ...effect.desired };
    case 'quarantine_case_roles':
      return {
        ...facts,
        cases: facts.cases.map((c) =>
          c.caseId === effect.caseId
            ? {
                ...c,
                roleIds: c.roleIds.filter((id) => !effect.roleIds.includes(id)),
                repairEligibility: c.repairEligibility
                  ? {
                      ...c.repairEligibility,
                      blockedRoles: c.repairEligibility.blockedRoles.filter(
                        ({ roleId }) => !effect.roleIds.includes(roleId)
                      ),
                    }
                  : undefined,
              }
            : c
        ),
      };
    case 'edit_overwrite':
      return {
        ...facts,
        channels: facts.channels.map((c) =>
          c.id === effect.channelId || (c.parentId === effect.channelId && c.permissionsLocked)
            ? {
                ...c,
                overwrites: [
                  ...c.overwrites.filter((o) => !(o.type === 'role' && o.id === effect.roleId)),
                  ...(effect.desired
                    ? [{ id: effect.roleId, type: 'role' as const, ...effect.desired }]
                    : []),
                ],
              }
            : c
        ),
      };
    case 'unsync_channel':
      return {
        ...facts,
        channels: facts.channels.map((c) =>
          c.id === effect.channelId
            ? { ...c, permissionsLocked: false, overwrites: effect.desired }
            : c
        ),
      };
  }
}
