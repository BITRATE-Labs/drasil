import type { ActionContext } from '../context';
import { normalizeRestrictionEffects } from './restrictionProposals';
import type { RestrictionExecutionStore } from './restrictionPersistence';
import {
  restrictionAuthorized,
  restrictionFactsAfter,
  restrictionMaterialFingerprint,
  type RestrictionPlanDependencies,
} from './restrictionActions';
import type {
  RestrictionApplyResult,
  RestrictionAudit,
  RestrictionEffect,
  RestrictionEffectObservation,
  RestrictionProgress,
} from './restrictionTypes';
export interface RestrictionExecutionDependencies extends RestrictionPlanDependencies {
  readonly attemptToken: string;
  readonly reconcileOnly?: boolean;
  readonly executionStore: RestrictionExecutionStore;
  write(effect: RestrictionEffect): Promise<void>;
  observe(effect: RestrictionEffect): Promise<RestrictionEffectObservation>;
  audit(guildId: string): Promise<RestrictionAudit>;
}
/** Only explicit rejection evidence proves that a failed transport did not apply. */
export class RestrictionWriteRejected extends Error {}
export async function executeRestrictionPlan(
  context: ActionContext,
  requestId: string,
  deps: RestrictionExecutionDependencies
): Promise<RestrictionApplyResult> {
  let progress: RestrictionProgress = (await deps.executionStore.loadProgress(requestId)) ?? {
    schemaVersion: 1,
    revision: 0,
    currentEffectIndex: 0,
    receipts: [],
  };
  const finish = async (
    stopReason: RestrictionApplyResult['stopReason']
  ): Promise<RestrictionApplyResult> => {
    const audit = await deps.audit(context.guildId);
    return { progress, stopReason, verification: { setup: audit.setup, cases: audit.cases } };
  };
  const plan = await deps.executionStore.loadPlan(requestId);
  if (
    !plan ||
    context.requestId !== requestId ||
    plan.guildId !== context.guildId ||
    context.actor.kind !== 'user' ||
    plan.actorId !== context.actor.userId ||
    !(await restrictionAuthorized(context, deps.authority))
  )
    return finish('authority_lost');
  if (deps.reconcileOnly && progress.receipts.length === 0) return finish('interrupted');
  const save = async (
    index: number,
    state: RestrictionProgress['receipts'][number]['state'],
    observation: RestrictionEffectObservation | null,
    error: string | null
  ): Promise<boolean> => {
    const next: RestrictionProgress = {
      schemaVersion: 1,
      revision: progress.revision + 1,
      currentEffectIndex: index,
      receipts: [
        ...progress.receipts.filter((r) => r.effectIndex !== index),
        { effectIndex: index, state, observation, error },
      ].sort((a, b) => a.effectIndex - b.effectIndex),
    };
    if (
      !(await deps.executionStore.saveProgress(
        requestId,
        deps.attemptToken,
        progress.revision,
        next
      ))
    ) {
      progress = (await deps.executionStore.loadProgress(requestId)) ?? progress;
      return false;
    }
    progress = next;
    return true;
  };
  const observe = async (effect: RestrictionEffect): Promise<RestrictionEffectObservation> => {
    try {
      return await deps.observe(effect);
    } catch {
      return {
        state: 'unavailable',
        observedAt: deps.now().toISOString(),
        reason: 'read_back_unavailable',
      };
    }
  };
  // Recovery is observation only, including takeover with expired approval.
  if (progress.receipts.length) {
    for (const receipt of progress.receipts) {
      if (receipt.state !== 'started' && receipt.state !== 'unknown') continue;
      const effect = plan.effects[receipt.effectIndex];
      if (!effect) return finish('stale_state');
      const observation = await observe(effect);
      if (
        !(await save(
          receipt.effectIndex,
          observation.state === 'desired_satisfied' ? 'applied' : 'unknown',
          observation,
          receipt.error
        ))
      )
        return finish('fence_lost');
    }
    return finish('interrupted');
  }
  if (Date.parse(plan.expiresAt) <= deps.now().getTime()) return finish('expired');
  const audit = await deps.auditStore.load(plan.auditRequestId, context.guildId);
  if (!audit || audit.revision !== plan.auditRevision) return finish('stale_state');
  const fixes = audit.fixes.filter((f) => plan.selectedFixIds.includes(f.id));
  if (
    fixes.length !== plan.selectedFixIds.length ||
    fixes.some((f) => !f.selectable || f.kind === 'manual') ||
    JSON.stringify(
      normalizeRestrictionEffects(
        plan.selectedFixIds.flatMap((id) => audit.fixes.find((f) => f.id === id)?.effects ?? [])
      )
    ) !== JSON.stringify(plan.effects) ||
    audit.expiresAt !== plan.expiresAt
  )
    return finish('stale_state');
  let expected = audit.facts;
  if (restrictionMaterialFingerprint(expected, plan.effects) !== plan.materialStateFingerprint)
    return finish('stale_state');
  for (let index = 0; index < plan.effects.length; index++) {
    if (!(await restrictionAuthorized(context, deps.authority))) return finish('authority_lost');
    if (Date.parse(plan.expiresAt) <= deps.now().getTime()) return finish('expired');
    const fresh = await deps.readFresh(context.guildId, fixes);
    if (
      restrictionMaterialFingerprint(fresh, plan.effects) !==
      restrictionMaterialFingerprint(expected, plan.effects)
    )
      return finish('stale_state');
    if (Date.parse(plan.expiresAt) <= deps.now().getTime()) return finish('expired');
    if (!(await restrictionAuthorized(context, deps.authority))) return finish('authority_lost');
    if (!(await save(index, 'started', null, null))) return finish('fence_lost');
    let failure: unknown;
    try {
      await deps.write(plan.effects[index]);
    } catch (error) {
      failure = error;
    }
    const observation = await observe(plan.effects[index]);
    const state =
      observation.state === 'desired_satisfied'
        ? 'applied'
        : failure instanceof RestrictionWriteRejected && observation.state === 'before_observed'
          ? 'failed'
          : 'unknown';
    if (!(await save(index, state, observation, failure ? 'write_error' : null)))
      return finish('fence_lost');
    if (state !== 'applied') return finish(state === 'failed' ? 'write_failed' : 'unknown_outcome');
    if (failure)
      return finish(
        failure instanceof RestrictionWriteRejected ? 'write_failed' : 'unknown_outcome'
      );
    expected = restrictionFactsAfter(expected, plan.effects[index]);
  }
  return finish('completed');
}
