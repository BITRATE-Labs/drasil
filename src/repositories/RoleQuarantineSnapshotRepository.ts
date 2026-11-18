import { restrictionSnapshotRoleBlock } from '@drasil/application';
import { restrictionActiveFenceSql } from '@drasil/application/postgres';
import { getManualIntakeSettings } from '../utils/manualIntakeSettings';
import { getRoleGateSettings } from '../utils/roleGateSettings';
import { inject, injectable } from 'inversify';
import {
  case_containment_status,
  Prisma,
  PrismaClient,
  role_quarantine_snapshot_purpose,
  role_quarantine_snapshot_status,
  verification_status,
} from '../db/prisma';
import { TYPES } from '../di/symbols';
import { RepositoryError } from './BaseRepository';
import {
  ServerSettings,
  RoleQuarantineSnapshot,
  RoleQuarantineSnapshotCreate,
  RoleQuarantineSnapshotStatus,
  RoleQuarantineSnapshotUpdate,
  CaseContainmentStatus,
  VerificationStatus,
} from './types';

/** Unsettled ownership can still finish removing a role after case resolution. */
export function unsettledRestrictionRoleIds(snapshot: RoleQuarantineSnapshot): string[] {
  const metadata = snapshot.metadata as Prisma.JsonObject | null;
  const owners = metadata?.restriction_role_owners as Prisma.JsonObject | undefined;
  return snapshot.planned_role_ids.filter((id) => {
    const owner = owners?.[id] as Prisma.JsonObject | undefined;
    return (
      snapshot.original_role_ids.includes(id) &&
      !!owner &&
      (owner.state === 'started' || owner.state === 'unknown')
    );
  });
}

export interface RestrictionRepairAppend {
  caseId: string;
  caseRevision: number;
  requestId: string;
  attemptToken: string;
  userId: string;
  roleIds: readonly string[];
}
export interface RestrictionRepairOutcome {
  snapshotId: string;
  requestId: string;
  attemptToken: string;
  roleId: string;
  state: 'applied' | 'failed' | 'unknown';
}
export interface IRoleQuarantineSnapshotRepository {
  appendRestrictionRepairRoles(
    input: RestrictionRepairAppend
  ): Promise<RoleQuarantineSnapshot | null>;
  recordRestrictionRepairOutcome(
    input: RestrictionRepairOutcome
  ): Promise<RoleQuarantineSnapshot | null>;
  create(data: RoleQuarantineSnapshotCreate): Promise<RoleQuarantineSnapshot>;
  createForQuarantineAttempt(
    data: RoleQuarantineSnapshotCreate,
    verificationEventId: string,
    attemptId: string
  ): Promise<RoleQuarantineSnapshot | null>;
  findActiveByServerAndUser(
    serverId: string,
    userId: string
  ): Promise<RoleQuarantineSnapshot | null>;
  findActiveCompletedForRestoration(limit?: number): Promise<RoleQuarantineSnapshot[]>;
  update(id: string, data: RoleQuarantineSnapshotUpdate): Promise<RoleQuarantineSnapshot | null>;
  updateForQuarantineAttempt(
    id: string,
    data: RoleQuarantineSnapshotUpdate,
    verificationEventId: string,
    attemptId: string
  ): Promise<RoleQuarantineSnapshot | null>;
}

@injectable()
export class RoleQuarantineSnapshotRepository implements IRoleQuarantineSnapshotRepository {
  public constructor(@inject(TYPES.PrismaClient) private readonly prisma: PrismaClient) {}

  public async appendRestrictionRepairRoles(
    input: RestrictionRepairAppend
  ): Promise<RoleQuarantineSnapshot | null> {
    return this.prisma.$transaction(async (tx) => {
      const requests = await tx.$queryRawUnsafe<Array<{ server_id: string }>>(
        `select q.server_id from moderation_action_requests q where q.id=$1::uuid and q.action_type='apply_case_role_lockdown' and ${restrictionActiveFenceSql} for update of q`,
        input.requestId,
        input.attemptToken
      );
      const request = requests.at(0);
      if (!request) return null;
      const cases = await tx.$queryRaw<
        Array<{ id: string }>
      >`select id from verification_events where id=${input.caseId}::uuid and server_id=${request.server_id} and user_id=${input.userId} and status='pending' and case_revision=${input.caseRevision} and quarantine_attempt_id is null for update`;
      if (!cases.length) return null;
      const departed = await tx.moderation_outcomes.findFirst({
        where: { verification_event_id: input.caseId, outcome_type: 'member_left' },
      });
      if (departed) return null;
      const competing = await tx.role_quarantine_snapshots.findFirst({
        where: {
          server_id: request.server_id,
          user_id: input.userId,
          status: 'active',
          OR: [{ verification_event_id: { not: input.caseId } }, { verification_event_id: null }],
        },
        select: { id: true },
      });
      if (competing) return null;
      const snapshots = await tx.$queryRaw<
        RoleQuarantineSnapshot[]
      >`select * from role_quarantine_snapshots where verification_event_id=${input.caseId}::uuid order by created_at desc for update`;
      let snapshot = snapshots.at(0);
      if (snapshot && snapshot.status !== 'active') return null;
      const server = await tx.servers.findUnique({ where: { guild_id: request.server_id } });
      const settings = (server?.settings ?? {}) as ServerSettings;
      const intake = getManualIntakeSettings(settings),
        gate = getRoleGateSettings(settings);
      if (
        input.roleIds.some(
          (id) =>
            (intake.enabled && id === intake.roleId) || (gate.enabled && id === gate.honeypotRoleId)
        )
      )
        return null;
      const metadata = (snapshot?.metadata ?? {}) as Prisma.JsonObject;
      const owners = (metadata.restriction_role_owners ?? {}) as Prisma.JsonObject;
      if (input.roleIds.some((id) => restrictionSnapshotRoleBlock(snapshot ?? null, id, input)))
        return null;
      const nextOwners = { ...owners };
      for (const id of input.roleIds)
        nextOwners[id] = owners[id] ?? {
          requestId: input.requestId,
          attemptToken: input.attemptToken,
          state: 'started',
        };
      const union = (prior: string[] = []): string[] => [...new Set([...prior, ...input.roleIds])];
      const data = {
        original_role_ids: union(snapshot?.original_role_ids),
        planned_role_ids: union(snapshot?.planned_role_ids),
        metadata: { ...metadata, restriction_role_owners: nextOwners },
        updated_at: new Date(),
      };
      if (snapshot)
        return (await tx.role_quarantine_snapshots.update({
          where: { id: snapshot.id },
          data,
        })) as RoleQuarantineSnapshot;
      snapshot = (await tx.role_quarantine_snapshots.create({
        data: {
          ...data,
          server_id: request.server_id,
          user_id: input.userId,
          verification_event_id: input.caseId,
        },
      })) as RoleQuarantineSnapshot;
      return snapshot;
    });
  }

  public async recordRestrictionRepairOutcome(
    input: RestrictionRepairOutcome
  ): Promise<RoleQuarantineSnapshot | null> {
    return this.prisma.$transaction(async (tx) => {
      const requests = await tx.$queryRawUnsafe<Array<{ server_id: string }>>(
        `select q.server_id from moderation_action_requests q where q.id=$1::uuid and ${restrictionActiveFenceSql} for update of q`,
        input.requestId,
        input.attemptToken
      );
      if (!requests.length) return null;
      const rows = await tx.$queryRaw<
        RoleQuarantineSnapshot[]
      >`select * from role_quarantine_snapshots where id=${input.snapshotId}::uuid and server_id=${requests[0].server_id} for update`;
      const snapshot = rows.at(0);
      if (!snapshot) return null;
      const metadata = (snapshot.metadata ?? {}) as Prisma.JsonObject;
      const owners = (metadata.restriction_role_owners ?? {}) as Prisma.JsonObject;
      const owner = owners[input.roleId] as Prisma.JsonObject | undefined;
      if (
        !owner ||
        owner.requestId !== input.requestId ||
        owner.attemptToken !== input.attemptToken ||
        (owner.state !== 'started' && owner.state !== input.state)
      )
        return null;
      return (await tx.role_quarantine_snapshots.update({
        where: { id: snapshot.id },
        data: {
          removed_role_ids:
            input.state === 'applied'
              ? [...new Set([...snapshot.removed_role_ids, input.roleId])]
              : snapshot.removed_role_ids,
          metadata: {
            ...metadata,
            restriction_role_owners: {
              ...owners,
              [input.roleId]: { ...owner, state: input.state },
            },
          },
          updated_at: new Date(),
        },
      })) as RoleQuarantineSnapshot;
    });
  }

  public async create(data: RoleQuarantineSnapshotCreate): Promise<RoleQuarantineSnapshot> {
    try {
      const created = await this.prisma.role_quarantine_snapshots.create({
        data: this.toCreateData(data),
      });

      return created as RoleQuarantineSnapshot;
    } catch (error) {
      this.handleError(error, 'createRoleQuarantineSnapshot');
    }
  }

  public async createForQuarantineAttempt(
    data: RoleQuarantineSnapshotCreate,
    verificationEventId: string,
    attemptId: string
  ): Promise<RoleQuarantineSnapshot | null> {
    try {
      return (await this.prisma.$transaction(async (transaction) => {
        if (!(await this.renewQuarantineAttempt(transaction, verificationEventId, attemptId))) {
          return null;
        }
        const created = await transaction.role_quarantine_snapshots.create({
          data: this.toCreateData(data),
        });
        return created as RoleQuarantineSnapshot;
      })) as RoleQuarantineSnapshot | null;
    } catch (error) {
      this.handleError(error, 'createRoleQuarantineSnapshotForAttempt');
    }
  }

  public async findActiveByServerAndUser(
    serverId: string,
    userId: string
  ): Promise<RoleQuarantineSnapshot | null> {
    try {
      const snapshot = await this.prisma.role_quarantine_snapshots.findFirst({
        where: {
          server_id: serverId,
          user_id: userId,
          status: RoleQuarantineSnapshotStatus.ACTIVE as role_quarantine_snapshot_status,
        },
        orderBy: { created_at: 'desc' },
      });

      return snapshot as RoleQuarantineSnapshot | null;
    } catch (error) {
      this.handleError(error, 'findActiveRoleQuarantineSnapshot');
    }
  }

  public async findActiveCompletedForRestoration(limit = 100): Promise<RoleQuarantineSnapshot[]> {
    try {
      const snapshots = await this.prisma.role_quarantine_snapshots.findMany({
        where: {
          status: RoleQuarantineSnapshotStatus.ACTIVE as role_quarantine_snapshot_status,
          verification_events: {
            is: { status: VerificationStatus.VERIFIED as verification_status },
          },
        },
        orderBy: { updated_at: 'asc' },
        take: Math.max(1, Math.min(limit, 500)),
      });
      return snapshots as RoleQuarantineSnapshot[];
    } catch (error) {
      this.handleError(error, 'findActiveCompletedRoleQuarantines');
    }
  }

  public async update(
    id: string,
    data: RoleQuarantineSnapshotUpdate
  ): Promise<RoleQuarantineSnapshot | null> {
    try {
      const updated = await this.prisma.$transaction((transaction) =>
        this.updatePreservingRepairOwnership(transaction, id, data)
      );

      return updated as RoleQuarantineSnapshot;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
        return null;
      }
      this.handleError(error, 'updateRoleQuarantineSnapshot');
    }
  }

  public async updateForQuarantineAttempt(
    id: string,
    data: RoleQuarantineSnapshotUpdate,
    verificationEventId: string,
    attemptId: string
  ): Promise<RoleQuarantineSnapshot | null> {
    try {
      return (await this.prisma.$transaction(async (transaction) => {
        if (!(await this.renewQuarantineAttempt(transaction, verificationEventId, attemptId))) {
          return null;
        }
        const updated = await this.updatePreservingRepairOwnership(transaction, id, data);
        return updated as RoleQuarantineSnapshot;
      })) as RoleQuarantineSnapshot | null;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
        return null;
      }
      this.handleError(error, 'updateRoleQuarantineSnapshotForAttempt');
    }
  }

  private async updatePreservingRepairOwnership(
    transaction: Prisma.TransactionClient,
    id: string,
    data: RoleQuarantineSnapshotUpdate
  ): Promise<RoleQuarantineSnapshot | null> {
    const rows = await transaction.$queryRaw<
      RoleQuarantineSnapshot[]
    >`select * from role_quarantine_snapshots where id=${id}::uuid for update`;
    const current = rows.at(0);
    if (!current) return null;
    const update = this.toUpdateData(data);
    const restorationWorksetChanged =
      data.expectedRestorationRoleIds !== undefined &&
      JSON.stringify(
        [
          ...new Set(
            current.removed_role_ids.filter((id) => current.original_role_ids.includes(id))
          ),
        ].sort()
      ) !== JSON.stringify([...data.expectedRestorationRoleIds].sort());
    if (
      current.status === RoleQuarantineSnapshotStatus.ACTIVE &&
      data.status === RoleQuarantineSnapshotStatus.RESTORED &&
      (unsettledRestrictionRoleIds(current).length || restorationWorksetChanged)
    ) {
      update.status = RoleQuarantineSnapshotStatus.ACTIVE;
      update.restored_at = undefined;
      update.restored_by = undefined;
    }
    if (data.metadata !== undefined) {
      const incoming = data.metadata;
      const currentMetadata = (current.metadata ?? {}) as Prisma.JsonObject;
      const metadata: Prisma.JsonObject =
        incoming && typeof incoming === 'object' && !Array.isArray(incoming) ? { ...incoming } : {};
      delete metadata.restriction_role_owners;
      if (currentMetadata.restriction_role_owners !== undefined)
        metadata.restriction_role_owners = currentMetadata.restriction_role_owners;
      update.metadata = metadata as Prisma.InputJsonValue;
    }
    return (await transaction.role_quarantine_snapshots.update({
      where: { id },
      data: update,
    })) as RoleQuarantineSnapshot;
  }

  private async renewQuarantineAttempt(
    transaction: Prisma.TransactionClient,
    verificationEventId: string,
    attemptId: string
  ): Promise<boolean> {
    const renewed = await transaction.verification_events.updateMany({
      where: {
        id: verificationEventId,
        status: VerificationStatus.PENDING as verification_status,
        containment_status: CaseContainmentStatus.IN_PROGRESS as case_containment_status,
        quarantine_attempt_id: attemptId,
      },
      data: { updated_at: new Date() },
    });
    return renewed.count === 1;
  }

  private toCreateData(
    data: RoleQuarantineSnapshotCreate
  ): Prisma.role_quarantine_snapshotsUncheckedCreateInput {
    return {
      server_id: data.serverId,
      user_id: data.userId,
      verification_event_id: data.verificationEventId ?? null,
      mode: data.mode,
      purpose: data.purpose as role_quarantine_snapshot_purpose | undefined,
      original_role_ids: data.originalRoleIds,
      planned_role_ids: data.plannedRoleIds,
      removed_role_ids: data.removedRoleIds ?? [],
      restored_role_ids: data.restoredRoleIds ?? [],
      skipped_roles: (data.skippedRoles ?? []) as Prisma.InputJsonValue,
      failed_removals: (data.failedRemovals ?? []) as Prisma.InputJsonValue,
      failed_restores: (data.failedRestores ?? []) as Prisma.InputJsonValue,
      metadata: (data.metadata ?? {}) as Prisma.InputJsonValue,
    };
  }

  private toUpdateData(
    data: RoleQuarantineSnapshotUpdate
  ): Prisma.role_quarantine_snapshotsUncheckedUpdateInput {
    return {
      verification_event_id: data.verificationEventId,
      status: data.status as role_quarantine_snapshot_status | undefined,
      purpose: data.purpose as role_quarantine_snapshot_purpose | undefined,
      original_role_ids: data.originalRoleIds,
      planned_role_ids: data.plannedRoleIds,
      removed_role_ids: data.removedRoleIds,
      restored_role_ids: data.restoredRoleIds,
      skipped_roles:
        data.skippedRoles === undefined ? undefined : (data.skippedRoles as Prisma.InputJsonValue),
      failed_removals:
        data.failedRemovals === undefined
          ? undefined
          : (data.failedRemovals as Prisma.InputJsonValue),
      failed_restores:
        data.failedRestores === undefined
          ? undefined
          : (data.failedRestores as Prisma.InputJsonValue),
      restored_at: data.restoredAt === undefined ? undefined : data.restoredAt,
      restored_by: data.restoredBy === undefined ? undefined : data.restoredBy,
      metadata: data.metadata === undefined ? undefined : (data.metadata as Prisma.InputJsonValue),
      updated_at: new Date(),
    };
  }

  private handleError(error: unknown, operation: string): never {
    console.error(`Repository error during ${operation}:`, error);

    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      throw new RepositoryError(
        `Database error during ${operation}: ${error.message} (Code: ${error.code})`,
        error
      );
    }
    if (error instanceof Error) {
      throw new RepositoryError(`Unexpected error during ${operation}: ${error.message}`, error);
    }
    throw new RepositoryError(`Unknown error during ${operation}`, error);
  }
}
