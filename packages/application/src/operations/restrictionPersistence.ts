import type {
  ApprovedRestrictionPlan,
  RestrictionAudit,
  RestrictionProgress,
} from './restrictionTypes';
export interface RestrictionAuditStore {
  load(auditRequestId: string, guildId: string): Promise<RestrictionAudit | null>;
}
export interface RestrictionExecutionStore {
  loadPlan(requestId: string): Promise<ApprovedRestrictionPlan | null>;
  loadProgress(requestId: string): Promise<RestrictionProgress | null>;
  saveProgress(
    requestId: string,
    attemptToken: string,
    expectedRevision: number,
    next: RestrictionProgress
  ): Promise<boolean>;
}
