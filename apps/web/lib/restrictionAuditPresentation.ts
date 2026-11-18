import { PermissionFlagsBits } from 'discord-api-types/v10';
import type {
  PublicRestrictionAudit,
  RestrictionEffect,
  RestrictionFix,
  RestrictionChannelFact,
} from '@drasil/application';
export interface RestrictionNames {
  readonly channels: ReadonlyMap<string, string>;
  readonly roles: ReadonlyMap<string, string>;
  readonly members?: ReadonlyMap<string, string>;
  readonly assessedChannels?: readonly RestrictionChannelFact[];
  readonly categories?: ReadonlySet<string>;
}
const permissionNames = [
  ...new Map(
    Object.entries(PermissionFlagsBits).map(([name, bit]) => [
      bit,
      name.replace(/([a-z])([A-Z])/g, '$1 $2'),
    ])
  ).entries(),
];
function permissions(bits: bigint): string {
  return permissionNames
    .filter(([bit]) => (bits & bit) !== 0n)
    .map(([, name]) => name)
    .join(', ');
}
export function describeRestrictionEffect(
  effect: RestrictionEffect,
  names: RestrictionNames
): string {
  const role = (id: string) => names.roles.get(id) ?? `role ${id}`;
  const channel = (id: string) =>
    names.channels.has(id) ? `#${names.channels.get(id)}` : `channel ${id}`;
  const overwrite = (
    expected: { allow: string; deny: string } | null,
    desired: { allow: string; deny: string } | null
  ): string => {
    const oldAllow = BigInt(expected?.allow ?? '0');
    const oldDeny = BigInt(expected?.deny ?? '0');
    const allow = BigInt(desired?.allow ?? '0');
    const deny = BigInt(desired?.deny ?? '0');
    return [
      allow & ~oldAllow
        ? `Allow ${permissions(allow & ~oldAllow)}${oldDeny & allow ? ' (replacing explicit denies)' : ''}`
        : '',
      deny & ~oldDeny
        ? `Deny ${permissions(deny & ~oldDeny)}${oldAllow & deny ? ' (replacing explicit allows)' : ''}`
        : '',
      oldAllow & ~allow & ~deny
        ? `Remove explicit allows for ${permissions(oldAllow & ~allow & ~deny)}`
        : '',
      oldDeny & ~deny & ~allow
        ? `Remove explicit denies for ${permissions(oldDeny & ~deny & ~allow)}`
        : '',
      !desired ? 'Remove this overwrite' : '',
    ]
      .filter(Boolean)
      .join('. ');
  };
  switch (effect.kind) {
    case 'edit_overwrite':
      return `${overwrite(effect.expected, effect.desired)} for ${role(effect.roleId)} in ${channel(effect.channelId)}. Applies to ${role(effect.roleId)} holders.${
        names.assessedChannels?.find((c) => c.id === effect.channelId)?.type === 'category' ||
        names.categories?.has(effect.channelId)
          ? ` Synchronized child channels also affected: ${
              names.assessedChannels
                ? names.assessedChannels
                    .filter((c) => c.parentId === effect.channelId && c.permissionsLocked)
                    .map((c) => channel(c.id))
                    .join(', ') || 'none in the assessed scope'
                : 'assessed child scope unavailable'
            }.`
          : ''
      }`;
    case 'set_role_permissions': {
      const removed = BigInt(effect.expected) & ~BigInt(effect.desired) & BigInt(effect.mask);
      const added = BigInt(effect.desired) & ~BigInt(effect.expected) & BigInt(effect.mask);
      return `${removed ? `Remove ${permissions(removed)}` : ''}${removed && added ? '. ' : ''}${added ? `Enable ${permissions(added)}` : ''} on ${role(effect.roleId)}. Changes this role's global permissions for all role holders.`;
    }
    case 'unsync_channel':
      return `Stop synchronizing ${channel(effect.channelId)} with ${channel(effect.parentId)} and copy the reviewed parent overwrites to this channel. ${effect.desired.map((o) => `${o.type === 'role' ? role(o.id) : `member ${o.id}`}: ${overwrite(effect.expected.find((before) => before.id === o.id && before.type === o.type) ?? null, o) || 'keep copied permissions'}`).join('. ')}. Applies to everyone whose permissions use these overwrites.`;
    case 'update_quarantine_policy':
      return `Set ordinary-role quarantine to ${effect.desired.quarantineMode}. ${effect.expected.exemptRoleIds
        .filter((id) => !effect.desired.exemptRoleIds.includes(id))
        .map((id) => `Include ${role(id)} in future quarantines.`)
        .join(' ')} ${effect.desired.exemptRoleIds
        .filter((id) => !effect.expected.exemptRoleIds.includes(id))
        .map((id) => `Preserve ${role(id)} in future quarantines.`)
        .join(
          ' '
        )}${effect.expected.manualIntakeRoleId !== effect.desired.manualIntakeRoleId ? ` Set manual intake role to ${effect.desired.manualIntakeRoleId ? role(effect.desired.manualIntakeRoleId) : 'none'}.` : ''} Current members require separate selected repairs.`;
    case 'quarantine_case_roles':
      return `Remove and save ${effect.roleIds.map(role).join(', ')} for ${names.members?.get(effect.memberId) ? `${names.members.get(effect.memberId)} (${effect.memberId})` : `member ${effect.memberId}`} in their current case, under the case role-restoration policy. Other members keep their roles.`;
  }
}
export function presentRestrictionFix(
  fix: RestrictionFix,
  names: RestrictionNames
): RestrictionFix {
  return {
    ...fix,
    after: fix.effects.length
      ? fix.effects.map((e) => describeRestrictionEffect(e, names)).join(' ')
      : fix.after,
    affectedScope: fix.affectedScope.map((id) =>
      names.channels.has(id) ? `#${names.channels.get(id)}` : (names.roles.get(id) ?? id)
    ),
  };
}
export function presentRestrictionAudit(
  audit: PublicRestrictionAudit,
  names: RestrictionNames
): PublicRestrictionAudit {
  return { ...audit, fixes: audit.fixes.map((f) => presentRestrictionFix(f, names)) };
}
