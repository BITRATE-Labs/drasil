import type { AuthorityPort } from '../authorization';
import type { ConfirmationPort } from '../confirmation';
import type { OperationCommand } from './commands';
import type {
  CaseThreadClosureSweepReport,
  IntegrityAuditReport,
  RoleIntakeResult,
} from './reports';
export interface OperationsDependencies {
  readonly authority: AuthorityPort;
  readonly confirmations: ConfirmationPort;
  readonly policy: {
    loadFresh(guildId: string): Promise<{ readonly intakeReasonRequired: boolean }>;
  };
  readonly queue: { sync(guildId: string): Promise<void>; clear(guildId: string): Promise<number> };
  readonly closure: {
    sweep(
      input: Extract<OperationCommand, { kind: 'close_resolved_case_threads' }> & {
        readonly guildId: string;
      }
    ): Promise<CaseThreadClosureSweepReport>;
  };
  readonly lockdown: {
    audit(
      context: import('../context').ActionContext
    ): Promise<import('./restrictionTypes').RestrictionAudit>;
    apply(
      context: import('../context').ActionContext,
      selection: import('./restrictionTypes').RestrictionSelection
    ): Promise<import('./restrictionTypes').RestrictionApplyResult>;
  };
  readonly integrity: {
    audit(
      input: Extract<OperationCommand, { kind: 'audit_integrity' }> & { readonly guildId: string }
    ): Promise<IntegrityAuditReport>;
  };
  readonly intake: {
    run(
      input: Extract<OperationCommand, { kind: 'intake_role_members' }> & {
        readonly guildId: string;
        readonly actorId: string;
      }
    ): Promise<RoleIntakeResult>;
  };
}
