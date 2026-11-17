import {
  approvedRestrictionPlanSchema,
  restrictionAuditSchema,
  restrictionProgressSchema,
} from '../operations/restrictionTypes';
import type {
  RestrictionAuditStore,
  RestrictionExecutionStore,
} from '../operations/restrictionPersistence';
import type { DelegationDatabase } from './delegation';

/** The same fence guards effects, snapshot admission and durable receipts. */
export const restrictionActiveFenceSql = `q.status='processing' and q.metadata->>'restriction_schema_version'='1' and q.metadata->>'restriction_attempt_token'=$2 and q.updated_at >= clock_timestamp()-interval '15 minutes' and (q.actor_surface<>'mcp' or exists (select 1 from mcp_executions e where e.queue_request_id=q.id and q.metadata->'delegation'->>'executionId'=e.id::text and e.started_at is not null and e.completed_at is null))`;
export function createRestrictionStores(
  database: DelegationDatabase
): RestrictionAuditStore & RestrictionExecutionStore {
  return {
    async load(id, guildId): ReturnType<RestrictionAuditStore['load']> {
      const { rows } = await database.query(
        `select result->'restriction_audit' as value from moderation_action_requests where id=$1::uuid and server_id=$2 and status='completed' and action_type='audit_case_role_lockdown' and metadata->>'restriction_schema_version'='1'`,
        [id, guildId]
      );
      const parsed = restrictionAuditSchema.safeParse(rows[0]?.value);
      return parsed.success && parsed.data.guildId === guildId ? parsed.data : null;
    },
    async loadPlan(id): ReturnType<RestrictionExecutionStore['loadPlan']> {
      const { rows } = await database.query(
        `select server_id,actor_id,metadata->'restriction_plan' as value from moderation_action_requests where id=$1::uuid and action_type='apply_case_role_lockdown' and metadata->>'restriction_schema_version'='1'`,
        [id]
      );
      const row = rows[0];
      const parsed = approvedRestrictionPlanSchema.safeParse(row?.value);
      return parsed.success &&
        parsed.data.guildId === row?.server_id &&
        parsed.data.actorId === row?.actor_id
        ? parsed.data
        : null;
    },
    async loadProgress(id): ReturnType<RestrictionExecutionStore['loadProgress']> {
      const { rows } = await database.query(
        `select result->'restriction_progress' as value from moderation_action_requests where id=$1::uuid and action_type='apply_case_role_lockdown' and metadata->>'restriction_schema_version'='1'`,
        [id]
      );
      const parsed = restrictionProgressSchema.safeParse(rows[0]?.value);
      return parsed.success ? parsed.data : null;
    },
    async saveProgress(
      id,
      token,
      revision,
      next
    ): ReturnType<RestrictionExecutionStore['saveProgress']> {
      const parsed = restrictionProgressSchema.safeParse(next);
      if (
        !parsed.success ||
        next.revision !== revision + 1 ||
        new Set(next.receipts.map((receipt) => receipt.effectIndex)).size !== next.receipts.length
      )
        return false;
      const { rows } = await database.query(
        `update moderation_action_requests q set result=jsonb_set(coalesce(result,'{}'::jsonb),'{restriction_progress}',$4::jsonb), updated_at=clock_timestamp() where q.id=$1::uuid and q.action_type='apply_case_role_lockdown' and ${restrictionActiveFenceSql} and coalesce(q.result->'restriction_progress'->>'revision','0')=$3 and not exists (select 1 from jsonb_array_elements(coalesce(q.result->'restriction_progress'->'receipts','[]'::jsonb)) prior where not exists (select 1 from jsonb_array_elements($4::jsonb->'receipts') incoming where incoming->'effectIndex'=prior->'effectIndex' and (case prior->>'state' when 'not_attempted' then true when 'started' then incoming->>'state' in ('started','applied','failed','unknown') when 'unknown' then incoming->>'state' in ('unknown','applied') else incoming=prior end))) returning q.id`,
        [id, token, String(revision), JSON.stringify(parsed.data)]
      );
      return rows.length === 1;
    },
  };
}
