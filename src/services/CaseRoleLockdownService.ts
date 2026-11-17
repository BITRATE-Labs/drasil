import {
  assessRestrictionFacts,
  proposeRestrictionFixes,
  COMPROMISED_RESTRICTION_PRIVILEGED_PERMISSIONS,
  type RestrictionAudit,
  type RestrictionFacts,
  type CaseRoleLockdownIssue,
  type CaseRoleLockdownPlannedAction,
  type CaseRoleLockdownApplyFailure,
  type CaseRoleLockdownReport,
} from '@drasil/application';
import { IRestrictionAuditService } from './RestrictionAuditService';
export type {
  CaseRoleLockdownSeverity,
  CaseRoleLockdownActionScope,
  CaseRoleLockdownIssue,
  CaseRoleLockdownPlannedAction,
  CaseRoleLockdownApplyFailure,
  CaseRoleLockdownReport,
} from '@drasil/application';
import { Guild, GuildMember, PermissionFlagsBits, ThreadChannel } from 'discord.js';
import { inject, injectable } from 'inversify';
import { IConfigService } from '../config/ConfigService';
import { TYPES } from '../di/symbols';
export interface CaseRoleLockdownAuditContext {
  readonly siblingThreadsByParentId: Map<string, Promise<readonly ThreadChannel[]>>;
}

export interface CaseRoleLockdownMemberBypass {
  readonly channelId: string;
  readonly channelName: string;
  readonly subjectType: 'member' | 'role';
  readonly subjectId: string;
  readonly permissions: readonly string[];
}

export interface CaseRoleLockdownMemberAudit {
  readonly assessment?: import('@drasil/application').RestrictionCaseAssessment;
  readonly memberId: string;
  readonly bypasses: readonly CaseRoleLockdownMemberBypass[];
  readonly retainedPrivilegedRoleIds: readonly string[];
  readonly retainedAdministratorRoleIds: readonly string[];
  readonly unremovablePrivilegeReasons: readonly string[];
}

export interface ICaseRoleLockdownService {
  auditGuild(
    guild: Guild,
    recoveryThreadId?: string | null,
    caseRoleId?: string | null
  ): Promise<CaseRoleLockdownReport>;
  auditMemberBypasses(
    member: GuildMember,
    ignoredRoleIds?: ReadonlySet<string>,
    allowedThreadId?: string | null,
    caseRoleId?: string | null,
    context?: CaseRoleLockdownAuditContext
  ): Promise<CaseRoleLockdownMemberAudit>;
}

@injectable()
export class CaseRoleLockdownService implements ICaseRoleLockdownService {
  private readonly restrictionAuditContexts = new WeakMap<
    CaseRoleLockdownAuditContext,
    Map<string, Promise<RestrictionAudit>>
  >();
  constructor(
    @inject(TYPES.ConfigService)
    private readonly configService: Pick<
      IConfigService,
      'getServerConfig' | 'updateServerSettings'
    >,
    @inject(TYPES.RestrictionAuditService)
    private readonly restrictionAuditService: IRestrictionAuditService
  ) {}

  public async auditGuild(
    guild: Guild,
    recoveryThreadId?: string | null,
    caseRoleId?: string | null
  ): Promise<CaseRoleLockdownReport> {
    const audit = await this.restrictionAuditService.auditGuild(guild.id);
    return this.projectRestrictionAudit(audit, recoveryThreadId, caseRoleId);
  }
  public async auditMemberBypasses(
    member: GuildMember,
    ignoredRoleIds: ReadonlySet<string> = new Set(),
    allowedThreadId?: string | null,
    caseRoleId?: string | null,
    context?: CaseRoleLockdownAuditContext
  ): Promise<CaseRoleLockdownMemberAudit> {
    let audits = context ? this.restrictionAuditContexts.get(context) : undefined;
    if (context && !audits) {
      audits = new Map();
      this.restrictionAuditContexts.set(context, audits);
    }
    let pending = audits?.get(member.guild.id);
    if (!pending) {
      pending = this.restrictionAuditService.auditGuild(member.guild.id);
      audits?.set(member.guild.id, pending);
    }
    const audit = await pending;
    return this.projectRestrictionMember(
      audit,
      member,
      ignoredRoleIds,
      allowedThreadId,
      caseRoleId
    );
  }

  private restrictionFacts(
    audit: RestrictionAudit,
    recoveryThreadId?: string | null,
    caseRoleId?: string | null
  ): RestrictionFacts {
    const parentId = recoveryThreadId
      ? audit.facts.threads.find((t) => t.id === recoveryThreadId)?.parentId
      : undefined;
    return {
      ...audit.facts,
      caseRoleId: caseRoleId === undefined ? audit.facts.caseRoleId : caseRoleId,
      recoveryParentId: parentId ?? audit.facts.recoveryParentId,
    };
  }

  private projectRestrictionAudit(
    audit: RestrictionAudit,
    recoveryThreadId?: string | null,
    caseRoleId?: string | null
  ): CaseRoleLockdownReport {
    const facts = this.restrictionFacts(audit, recoveryThreadId, caseRoleId);
    const setup = assessRestrictionFacts(facts).setup;
    const issues: CaseRoleLockdownIssue[] = setup.findings.map((finding) => ({
      severity: finding.kind === 'limitation' ? 'warning' : 'error',
      code: finding.code,
      message: `Restriction audit: ${finding.code.replace(/_/g, ' ')}${finding.channelId ? ` (${finding.channelId})` : ''}.`,
    }));
    if (
      audit.coverage.some((c) => c.area !== 'parent_content' && c.state !== 'complete') &&
      !issues.some((i) => i.code === 'metadata_unavailable')
    )
      issues.push({
        severity: 'error',
        code: 'metadata_unavailable',
        message: 'Required restriction metadata is unavailable.',
      });
    const plannedActions: CaseRoleLockdownPlannedAction[] = proposeRestrictionFixes(
      facts,
      assessRestrictionFacts(facts)
    ).flatMap((fix) =>
      fix.effects
        .filter((effect) => effect.kind === 'edit_overwrite')
        .map((effect) => ({
          scope:
            facts.channels.find((c) => c.id === effect.channelId)?.type === 'category'
              ? ('category' as const)
              : ('channel' as const),
          channelId: effect.channelId,
          channelName:
            facts.channels.find((c) => c.id === effect.channelId)?.name ?? effect.channelId,
        }))
    );
    return {
      assessment: setup,
      ...this.toReport({
        guildId: audit.guildId,
        checkedAt: new Date(audit.completedAt),
        enabled: setup.status === 'verified',
        allowedChannelIds: facts.exceptionChannelIds,
        allowedCategoryIds: [],
        autoAllowedChannelIds: facts.recoveryParentId ? [facts.recoveryParentId] : [],
        issues,
        plannedActions,
        appliedActions: [],
        failedActions: [],
        syncedAllowedChannels: [],
        unsyncedAllowedChannels: [],
      }),
    };
  }

  private projectRestrictionMember(
    audit: RestrictionAudit,
    member: GuildMember,
    ignoredRoleIds: ReadonlySet<string>,
    allowedThreadId?: string | null,
    caseRoleId?: string | null
  ): CaseRoleLockdownMemberAudit {
    const base = this.restrictionFacts(audit, allowedThreadId, caseRoleId);
    const collected = base.cases.find((c) => c.userId === member.id);
    const roles = (collected?.roleIds ?? [...member.roles.cache.keys()]).filter(
      (id) => !ignoredRoleIds.has(id)
    );
    const facts = {
      ...base,
      cases: [
        {
          caseId: collected?.caseId ?? `member:${member.id}`,
          caseRoleId: caseRoleId === undefined ? (collected?.caseRoleId ?? null) : caseRoleId,
          caseRevision: collected?.caseRevision ?? 'prospective',
          joinedAt: collected?.joinedAt ?? member.joinedAt?.toISOString() ?? null,
          userId: member.id,
          purpose: collected?.purpose ?? ('standard_case' as const),
          roleIds: roles,
          owner: member.id === member.guild.ownerId,
          metadataAvailable: collected?.metadataAvailable ?? true,
          threadId: allowedThreadId === undefined ? (collected?.threadId ?? null) : allowedThreadId,
        },
      ],
    };
    const assessment = assessRestrictionFacts(facts).cases[0];
    const privileged = base.roles.filter(
      (role) =>
        (role.id === base.guildId || roles.includes(role.id)) &&
        (BigInt(role.permissions) & COMPROMISED_RESTRICTION_PRIVILEGED_PERMISSIONS) !== 0n
    );
    return {
      assessment,
      memberId: member.id,
      bypasses: assessment.findings
        .filter((f) => f.kind === 'access_failure' || f.kind === 'coverage')
        .map((f) => ({
          channelId: f.channelId ?? 'guild',
          channelName:
            base.channels.find((c) => c.id === f.channelId)?.name ??
            f.channelId ??
            'Required metadata',
          subjectType: 'member' as const,
          subjectId: member.id,
          permissions: [f.code],
        })),
      retainedPrivilegedRoleIds: privileged.map((r) => r.id),
      retainedAdministratorRoleIds: privileged
        .filter((r) => (BigInt(r.permissions) & PermissionFlagsBits.Administrator) !== 0n)
        .map((r) => r.id),
      unremovablePrivilegeReasons: assessment.findingCodes.filter(
        (code) => code === 'owner_bypass' || code === 'administrator_bypass'
      ),
    };
  }

  private toReport(input: {
    readonly guildId: string;
    readonly checkedAt: Date;
    readonly enabled: boolean;
    readonly allowedChannelIds: readonly string[];
    readonly allowedCategoryIds: readonly string[];
    readonly autoAllowedChannelIds: readonly string[];
    readonly issues: readonly CaseRoleLockdownIssue[];
    readonly plannedActions: readonly CaseRoleLockdownPlannedAction[];
    readonly appliedActions: readonly CaseRoleLockdownPlannedAction[];
    readonly failedActions: readonly CaseRoleLockdownApplyFailure[];
    readonly syncedAllowedChannels: readonly CaseRoleLockdownPlannedAction[];
    readonly unsyncedAllowedChannels: readonly CaseRoleLockdownPlannedAction[];
  }): CaseRoleLockdownReport {
    return {
      ...input,
      errorCount: input.issues.filter((issue) => issue.severity === 'error').length,
      warningCount: input.issues.filter((issue) => issue.severity === 'warning').length,
    };
  }
}
