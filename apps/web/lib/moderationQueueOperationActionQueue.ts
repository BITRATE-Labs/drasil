import { createWebRestrictionPlanDependencies } from './mcp/adapters/restriction';
import { insertModerationActionRequestWithReceipt } from './moderationActionRequestQueue';
import { getPostgresPool } from './setupDataAdapter';
import {
  queuedOperationCommandSchema,
  prepareRestrictionPlan,
  restrictionSelectionSchema,
  encodeQueuedAction,
  type ActionContext,
  type QueuedOperationCommand,
} from '@drasil/application';
import { submitQueuedAction } from './application/queuedSubmission';
import type { ModerationActionRequestReceipt } from './moderationActionRequestQueue';
// Native website integrity audits retain their existing read path.
type NativeQueuedOperationCommand = Exclude<QueuedOperationCommand, { kind: 'audit_integrity' }>;
export type ModerationQueueOperationAction = NativeQueuedOperationCommand['kind'];
export interface QueueModerationQueueOperationInput {
  readonly context: ActionContext;
  readonly command: NativeQueuedOperationCommand;
}
export async function queueModerationQueueOperation(
  input: QueueModerationQueueOperationInput
): Promise<ModerationActionRequestReceipt> {
  const command = queuedOperationCommandSchema.parse(input.command);

  if (command.kind === 'apply_case_role_lockdown') {
    const selection = restrictionSelectionSchema.parse({
      auditRequestId: command.auditRequestId,
      auditRevision: command.auditRevision,
      selectedFixIds: command.selectedFixIds,
    });
    const plan = await prepareRestrictionPlan(
      input.context,
      selection,
      createWebRestrictionPlanDependencies()
    );
    const encoded = encodeQueuedAction(input.context, command);
    return insertModerationActionRequestWithReceipt(getPostgresPool(), {
      ...encoded,
      metadata: { ...encoded.metadata, restriction_schema_version: 1, restriction_plan: plan },
    });
  }
  return submitQueuedAction({ context: input.context, command });
}
