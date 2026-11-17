import { createHash } from 'crypto';
import { hasAuthority, type AuthorityPort } from '../authorization';
import type { ActionContext } from '../context';
import type { RestrictionAuditStore } from './restrictionPersistence';
import { normalizeRestrictionEffects } from './restrictionProposals';
import {
  restrictionSelectionSchema,
  type ApprovedRestrictionPlan,
  type RestrictionSelection,
  type RestrictionFacts,
  type RestrictionFix,
  type RestrictionEffect,
} from './restrictionTypes';
export interface RestrictionPlanDependencies {
  readonly authority: AuthorityPort;
  readonly auditStore: RestrictionAuditStore;
  readonly now: () => Date;
  readFresh(guildId: string, fixes: readonly RestrictionFix[]): Promise<RestrictionFacts>;
}
export async function restrictionAuthorized(
  context: ActionContext,
  authority: AuthorityPort
): Promise<boolean> {
  if (context.actor.kind !== 'user') return false;
  const actor = await authority.loadFresh(context.guildId, context.actor.userId);
  return (
    !!actor &&
    actor.present &&
    actor.guildId === context.guildId &&
    actor.userId === context.actor.userId &&
    hasAuthority(actor, 0n)
  );
}
const sorted = <T extends { id: string }>(items: readonly T[]): T[] =>
  [...items].sort((a, b) => a.id.localeCompare(b.id));
/** Freeze only selected targets and the roles/members that determine their access. */
export function restrictionMaterialFingerprint(
  facts: RestrictionFacts,
  effects: readonly RestrictionEffect[]
): string {
  const channelIds = new Set<string>();
  const caseIds = new Set<string>();
  const roleIds = new Set<string>([facts.guildId, ...(facts.caseRoleId ? [facts.caseRoleId] : [])]);
  for (const effect of effects) {
    if ('channelId' in effect) channelIds.add(effect.channelId);
    if ('parentId' in effect) channelIds.add(effect.parentId);
    if ('caseId' in effect) caseIds.add(effect.caseId);
    if ('roleId' in effect) roleIds.add(effect.roleId);
  }
  // Category writes also change every currently synchronized child.
  for (const effect of effects)
    if (effect.kind === 'edit_overwrite')
      for (const channel of facts.channels)
        if (channel.parentId === effect.channelId && channel.permissionsLocked)
          channelIds.add(channel.id);
  const cases = facts.cases.filter((c) => caseIds.has(c.caseId));
  for (const item of cases) {
    for (const id of item.roleIds) roleIds.add(id);
    if (item.caseRoleId) roleIds.add(item.caseRoleId);
  }
  const channels = facts.channels.filter((c) => channelIds.has(c.id));
  for (const item of channels)
    for (const overwrite of item.overwrites)
      if (overwrite.type === 'role') roleIds.add(overwrite.id);
  const threadIds = new Set(cases.map((c) => c.threadId));
  const projection = {
    configurationAvailable: facts.configurationAvailable !== false,
    guildId: facts.guildId,
    caseRoleId: facts.caseRoleId,
    botHighestPosition: facts.botHighestPosition,
    quarantineMode: facts.quarantineMode,
    exemptRoleIds: [...facts.exemptRoleIds].sort(),
    manualIntakeRoleId: facts.manualIntakeRoleId,
    repairExcludedRoleIds: [...(facts.repairExcludedRoleIds ?? [])].sort(),
    exceptionChannelIds: facts.exceptionChannelIds.filter((id) => channelIds.has(id)).sort(),
    recoveryParentId: channelIds.has(facts.recoveryParentId ?? '') ? facts.recoveryParentId : null,
    roles: sorted(facts.roles.filter((r) => roleIds.has(r.id))).map((r) => ({
      id: r.id,
      position: r.position,
      permissions: r.permissions,
      managed: r.managed,
      botManaged: r.botManaged,
    })),
    channels: sorted(channels).map((c) => ({
      id: c.id,
      type: c.type,
      parentId: c.parentId,
      permissionsLocked: c.permissionsLocked,
      metadataAvailable: c.metadataAvailable,
      overwrites: sorted(c.overwrites),
    })),
    cases: [...cases]
      .sort((a, b) => a.caseId.localeCompare(b.caseId))
      .map((c) => ({ ...c, roleIds: [...c.roleIds].sort() })),
    threads: sorted(facts.threads.filter((t) => threadIds.has(t.id))).map((t) => ({
      ...t,
      memberIds: [...t.memberIds].sort(),
    })),
  };
  return createHash('sha256').update(JSON.stringify(projection)).digest('hex');
}
export async function prepareRestrictionPlan(
  context: ActionContext,
  selection: RestrictionSelection,
  deps: RestrictionPlanDependencies
): Promise<ApprovedRestrictionPlan> {
  const input = restrictionSelectionSchema.parse(selection);
  if (!(await restrictionAuthorized(context, deps.authority)) || context.actor.kind !== 'user')
    throw new Error('authority_lost');
  const audit = await deps.auditStore.load(input.auditRequestId, context.guildId);
  if (!audit || audit.guildId !== context.guildId || audit.revision !== input.auditRevision)
    throw new Error('audit_binding_mismatch');
  if (Date.parse(audit.expiresAt) <= deps.now().getTime()) throw new Error('expired');
  const fixes = input.selectedFixIds.map((id) => audit.fixes.find((f) => f.id === id));
  if (fixes.some((f) => !f || !f.selectable || f.kind === 'manual' || f.effects.length === 0))
    throw new Error('unsupported_selection');
  const selected = fixes as RestrictionFix[];
  const effects = [...normalizeRestrictionEffects(selected.flatMap((f) => f.effects))];
  if (effects.some((e) => e.guildId !== context.guildId))
    throw new Error('effect_binding_mismatch');
  const fresh = await deps.readFresh(context.guildId, selected);
  const fingerprint = restrictionMaterialFingerprint(audit.facts, effects);
  if (fingerprint !== restrictionMaterialFingerprint(fresh, effects))
    throw new Error('stale_state');
  if (Date.parse(audit.expiresAt) <= deps.now().getTime()) throw new Error('expired');
  return {
    ...input,
    actorId: context.actor.userId,
    guildId: context.guildId,
    effects,
    materialStateFingerprint: fingerprint,
    expiresAt: audit.expiresAt,
  };
}
export { restrictionFactsAfter } from './restrictionFactsAfter';
