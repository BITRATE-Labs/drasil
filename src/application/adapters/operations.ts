import { createBotRestrictionEffects } from './restriction';
import { createBotDelegationDatabase } from './delegationDatabase';
import { createRestrictionStores, restrictionActiveFenceSql } from '@drasil/application/postgres';
import { getRestrictionAttemptToken } from '../../repositories/ModerationActionRequestRepository';
import {
  ModerationActionRequestType,
  type ModerationActionRequest,
} from '../../repositories/types';
import type { IRestrictionAuditService } from '../../services/RestrictionAuditService';
import type { IRoleQuarantineService } from '../../services/RoleQuarantineService';
import type { IVerificationEventRepository } from '../../repositories/VerificationEventRepository';
import type { PrismaClient } from '../../db/prisma';
import { createApprovedSetupConfiguration, type ApprovedSetupConfiguration } from './approvedSetup';
import {
  ActionDeniedError,
  executeRestrictionPlan,
  canonicalDigest,
  encodeQueuedAction,
  type ActionContext,
  type ExecutionRecord,
  createOperationsActions,
  type ActionResult,
  type AuthorityPort,
  type ConfirmationPort,
  type OperationsActions,
  type OperationsOutcome,
  type RoleIntakeProgress,
} from '@drasil/application';
import type { Client } from 'discord.js';
import type { IConfigService } from '../../config/ConfigService';
import type { IModerationQueueService } from '../../services/ModerationQueueService';
import type { ICaseThreadClosureSweepService } from '../../services/CaseThreadClosureSweepService';
import type { IIntegrityAuditService } from '../../services/IntegrityAuditService';
import type { ISecurityActionService } from '../../services/SecurityActionService';
import { getDetectionResponseSettings } from '../../utils/detectionResponseSettings';
import { createBotAuthority } from './authority';
export interface BotOperationsDependencies {
  readonly client: Client;
  readonly configService: IConfigService;
  readonly queueService: IModerationQueueService;
  readonly securityActionService: ISecurityActionService;
  readonly caseThreadClosureSweepService: ICaseThreadClosureSweepService;
  readonly actionRequests?: import('../../repositories/ModerationActionRequestRepository').IModerationActionRequestRepository;
  readonly restrictionAuditService?: IRestrictionAuditService;
  readonly prisma?: PrismaClient;
  readonly roleQuarantineService?: IRoleQuarantineService;
  readonly verificationEventRepository?: IVerificationEventRepository;
  readonly integrityAuditService: IIntegrityAuditService;
}
export interface BotOperationsRuntime {
  readonly actions: OperationsActions;
  enqueueAudit(context: ActionContext): Promise<string>;
  forExecution(execution: ExecutionRecord, request?: ModerationActionRequest): OperationsActions;
  forRequest(request: ModerationActionRequest, reconcileOnly?: boolean): OperationsActions;
  withProgress(onProgress: (progress: RoleIntakeProgress) => Promise<void>): OperationsActions;
}
export function createBotOperationsRuntime(
  deps: BotOperationsDependencies & { readonly confirmations: ConfirmationPort },
  authority: AuthorityPort = createBotAuthority(deps.client)
): BotOperationsRuntime {
  const create = (
    onProgress?: (progress: RoleIntakeProgress) => Promise<void>,
    approved?: ApprovedSetupConfiguration,
    request?: ModerationActionRequest,
    reconcileOnly = false
  ): OperationsActions =>
    createOperationsActions({
      authority,
      confirmations: deps.confirmations,
      policy: {
        async loadFresh(guildId) {
          const config = approved
            ? await approved.read(guildId)
            : await deps.configService.getServerConfig(guildId, {
                forceRefresh: true,
                failOnReadError: true,
              });
          return {
            intakeReasonRequired: getDetectionResponseSettings(config.settings)
              .adminCaseOpenRequiresReason,
          };
        },
      },
      queue: {
        async sync(guildId) {
          await deps.queueService.syncServerQueue(guildId);
        },
        clear: (guildId) => deps.queueService.clearServerQueue(guildId),
      },
      closure: {
        sweep: (input) =>
          deps.caseThreadClosureSweepService.sweepResolvedCaseThreads({
            serverId: input.guildId,
            days: input.days,
            limit: input.limit,
            execute: input.execute,
            ...(input.userId ? { userId: input.userId } : {}),
          }),
      },
      lockdown: {
        async audit(context) {
          if (!request || request.id !== context.requestId || !deps.restrictionAuditService)
            throw new ActionDeniedError('audit_request_required');
          return deps.restrictionAuditService.auditGuild(context.guildId);
        },
        async apply(context, selection) {
          if (
            !request ||
            !deps.prisma ||
            !deps.restrictionAuditService ||
            !deps.roleQuarantineService ||
            !deps.verificationEventRepository ||
            context.actor.kind !== 'user'
          )
            throw new ActionDeniedError('plan_required');
          const attemptToken = getRestrictionAttemptToken(request);
          if (!attemptToken) throw new ActionDeniedError('plan_required');
          const database = createBotDelegationDatabase(deps.prisma);
          const stores = createRestrictionStores(database);
          const plan = await stores.loadPlan(request.id);
          if (
            !plan ||
            canonicalDigest(selection) !==
              canonicalDigest({
                auditRequestId: plan.auditRequestId,
                auditRevision: plan.auditRevision,
                selectedFixIds: plan.selectedFixIds,
              })
          )
            throw new ActionDeniedError('plan_required');
          const auditService = deps.restrictionAuditService;
          const effects = createBotRestrictionEffects({
            client: deps.client,
            configService: deps.configService,
            cases: deps.verificationEventRepository,
            quarantine: deps.roleQuarantineService,
            auditService: deps.restrictionAuditService,
            actorId: context.actor.userId,
            repairFence: {
              requestId: request.id,
              attemptToken,
              async assertOwner() {
                const { rows } = await database.query(
                  `select q.id from moderation_action_requests q where q.id=$1::uuid and ${restrictionActiveFenceSql}`,
                  [request.id, attemptToken]
                );
                if (!rows.length) throw new ActionDeniedError('fence_lost');
              },
            },
          });
          return executeRestrictionPlan(context, request.id, {
            authority,
            auditStore: stores,
            executionStore: stores,
            now: () => new Date(),
            attemptToken,
            reconcileOnly,
            ...effects,
            audit: (guildId) => auditService.auditGuild(guildId),
          });
        },
      },
      integrity: {
        async audit(input) {
          return deps.integrityAuditService.auditGuild(
            await deps.client.guilds.fetch(input.guildId),
            {
              scope: input.scope,
              days: input.days,
              limit: input.limit,
              userId: input.userId ?? undefined,
            }
          );
        },
      },
      intake: {
        async run(input) {
          const guild = await deps.client.guilds.fetch(input.guildId);
          const role = await guild.roles.fetch(input.roleId);
          if (!role || role.guild.id !== input.guildId)
            throw new Error('Role-intake role was not found in this server.');
          const moderator = await deps.client.users.fetch(input.actorId);
          return deps.securityActionService.intakeRoleMembers({
            role,
            moderator,
            reason: input.reason?.trim() || undefined,
            action: 'open_case',
            execute: input.execute,
            limit: input.limit,
            onProgress,
          });
        },
      },
    });
  return {
    actions: create(),
    async enqueueAudit(context): Promise<string> {
      if (!deps.actionRequests) throw new ActionDeniedError('audit_request_unavailable');
      const encoded = encodeQueuedAction(context, { kind: 'audit_case_role_lockdown' });
      const request = await deps.actionRequests.enqueue({
        ...encoded,
        actionType: ModerationActionRequestType.AUDIT_CASE_ROLE_LOCKDOWN,
      });
      return request.id;
    },
    withProgress: create,
    forRequest: (request, reconcileOnly) => create(undefined, undefined, request, reconcileOnly),
    forExecution(execution, request): OperationsActions {
      if (
        execution.command.kind === 'audit_case_role_lockdown' ||
        execution.command.kind === 'apply_case_role_lockdown'
      )
        return create(undefined, undefined, request);
      if (execution.preconditions.kind !== 'setup')
        throw new ActionDeniedError('setup_preconditions_required');
      return create(
        undefined,
        createApprovedSetupConfiguration(deps.configService, execution.preconditions)
      );
    },
  };
}
export function requireOperationsOutcome(
  result: ActionResult<OperationsOutcome>
): OperationsOutcome {
  if (result.kind === 'denied')
    throw new ActionDeniedError(
      result.code,
      result.code === 'reason_required'
        ? 'Role intake execution requires a case reason.'
        : `Operation denied: ${result.code}`
    );
  return result.outcome;
}
