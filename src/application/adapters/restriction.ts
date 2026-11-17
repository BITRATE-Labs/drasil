import { getRoleQuarantineSettings } from '../../utils/roleQuarantineSettings';
import { getManualIntakeSettings } from '../../utils/manualIntakeSettings';
import {
  PermissionFlagsBits,
  type Client,
  type PermissionOverwriteOptions,
  OverwriteType,
} from 'discord.js';
import {
  RestrictionWriteRejected,
  parseSetupStoredRecord,
  type RestrictionEffect,
  type RestrictionEffectObservation,
  type RestrictionFacts,
} from '@drasil/application';
import type { IConfigService } from '../../config/ConfigService';
import type { IVerificationEventRepository } from '../../repositories/VerificationEventRepository';
import type {
  IRoleQuarantineService,
  RestrictionRepairFence,
} from '../../services/RoleQuarantineService';
import type { IRestrictionAuditService } from '../../services/RestrictionAuditService';
export interface BotRestrictionEffectDependencies {
  readonly client: Client;
  readonly configService: IConfigService;
  readonly cases: IVerificationEventRepository;
  readonly quarantine: IRoleQuarantineService;
  readonly auditService: IRestrictionAuditService;
  readonly actorId: string;
  readonly repairFence: Omit<RestrictionRepairFence, 'caseRevision' | 'joinedAt'>;
}
const canonicalIds = (ids: readonly string[]): string => JSON.stringify([...ids].sort());
const overwrites = (
  items: readonly { id: string; type: string; allow: string; deny: string }[]
): string =>
  JSON.stringify(
    [...items].sort((a, b) => a.id.localeCompare(b.id) || a.type.localeCompare(b.type))
  );
function matches(facts: RestrictionFacts, effect: RestrictionEffect, desired: boolean): boolean {
  if (facts.guildId !== effect.guildId) return false;
  switch (effect.kind) {
    case 'set_role_permissions': {
      const role = facts.roles.find((r) => r.id === effect.roleId);
      return (
        !!role &&
        (BigInt(role.permissions) & BigInt(effect.mask)) ===
          (BigInt(desired ? effect.desired : effect.expected) & BigInt(effect.mask))
      );
    }
    case 'edit_overwrite': {
      const channel = facts.channels.find((c) => c.id === effect.channelId);
      if (!channel?.metadataAvailable) return false;
      const item = channel.overwrites.find((o) => o.id === effect.roleId && o.type === 'role');
      const state = desired ? effect.desired : effect.expected;
      return state ? !!item && item.allow === state.allow && item.deny === state.deny : !item;
    }
    case 'unsync_channel': {
      const channel = facts.channels.find((c) => c.id === effect.channelId);
      return (
        !!channel?.metadataAvailable &&
        channel.parentId === effect.parentId &&
        (!desired || !channel.permissionsLocked) &&
        overwrites(channel.overwrites) === overwrites(desired ? effect.desired : effect.expected)
      );
    }
    case 'update_quarantine_policy': {
      const state = desired ? effect.desired : effect.expected;
      return (
        facts.quarantineMode === state.quarantineMode &&
        facts.manualIntakeRoleId === state.manualIntakeRoleId &&
        canonicalIds(facts.exemptRoleIds) === canonicalIds(state.exemptRoleIds)
      );
    }
    case 'quarantine_case_roles': {
      const member = facts.cases.find(
        (c) => c.caseId === effect.caseId && c.userId === effect.memberId
      );
      return (
        !!member?.metadataAvailable &&
        member.caseRevision === effect.caseRevision &&
        member.joinedAt === effect.joinedAt &&
        canonicalIds(member.roleIds) === canonicalIds(desired ? effect.desired : effect.expected)
      );
    }
  }
}
/** Real effects only. Worker admission and receipts remain in the application executor. */
export function createBotRestrictionEffects(deps: BotRestrictionEffectDependencies): {
  readFresh(guildId: string): Promise<RestrictionFacts>;
  write(effect: RestrictionEffect): Promise<void>;
  observe(effect: RestrictionEffect): Promise<RestrictionEffectObservation>;
} {
  const readFresh = async (guildId: string): Promise<RestrictionFacts> =>
    (await deps.auditService.auditGuild(guildId)).facts;
  return {
    readFresh,
    async write(effect): Promise<void> {
      await deps.repairFence.assertOwner();
      const before = await readFresh(effect.guildId);
      if (!matches(before, effect, false))
        throw new RestrictionWriteRejected('Restriction precondition changed');
      const guild = await deps.client.guilds.fetch(effect.guildId);
      switch (effect.kind) {
        case 'set_role_permissions': {
          const role = await guild.roles.fetch(effect.roleId, { force: true });
          if (!role || role.permissions.bitfield.toString() !== effect.expected)
            throw new RestrictionWriteRejected('Role changed');
          await deps.repairFence.assertOwner();
          await role.setPermissions(
            (role.permissions.bitfield & ~BigInt(effect.mask)) |
              (BigInt(effect.desired) & BigInt(effect.mask))
          );
          return;
        }
        case 'edit_overwrite': {
          const channel = await guild.channels.fetch(effect.channelId, { force: true });
          if (!channel || !('permissionOverwrites' in channel))
            throw new RestrictionWriteRejected('Channel unavailable');
          const current = channel.permissionOverwrites.cache.get(effect.roleId);
          if (
            effect.expected
              ? !current ||
                current.allow.bitfield.toString() !== effect.expected.allow ||
                current.deny.bitfield.toString() !== effect.expected.deny
              : !!current
          )
            throw new RestrictionWriteRejected('Overwrite changed');
          if (current && current.type !== OverwriteType.Role)
            throw new RestrictionWriteRejected('Member overwrite is manual');
          if (!effect.desired) {
            await deps.repairFence.assertOwner();
            if (current) await current.delete('Drasil selected restriction repair');
            return;
          }
          const options: PermissionOverwriteOptions = {};
          const beforeAllow = BigInt(effect.expected?.allow ?? '0'),
            beforeDeny = BigInt(effect.expected?.deny ?? '0');
          const allow = BigInt(effect.desired.allow),
            deny = BigInt(effect.desired.deny);
          const mask = (beforeAllow ^ allow) | (beforeDeny ^ deny);
          for (const [name, bit] of Object.entries(PermissionFlagsBits))
            if ((mask & bit) !== 0n)
              options[name as keyof PermissionOverwriteOptions] =
                (allow & bit) !== 0n ? true : (deny & bit) !== 0n ? false : null;
          await deps.repairFence.assertOwner();
          await channel.permissionOverwrites.edit(effect.roleId, options, {
            type: OverwriteType.Role,
            reason: 'Drasil selected restriction repair',
          });
          return;
        }
        case 'unsync_channel': {
          const channel = await guild.channels.fetch(effect.channelId, { force: true });
          const parent = await guild.channels.fetch(effect.parentId, { force: true });
          if (
            !channel ||
            !parent ||
            !('permissionOverwrites' in channel) ||
            !('permissionOverwrites' in parent) ||
            channel.parentId !== effect.parentId
          )
            throw new RestrictionWriteRejected('Inheritance changed');
          const target = [...channel.permissionOverwrites.cache.values()].map((o) => ({
            id: o.id,
            type: o.type === OverwriteType.Role ? 'role' : 'member',
            allow: o.allow.bitfield.toString(),
            deny: o.deny.bitfield.toString(),
          }));
          if (!channel.permissionsLocked || overwrites(target) !== overwrites(effect.expected))
            throw new RestrictionWriteRejected('Inherited channel changed');
          const source = [...parent.permissionOverwrites.cache.values()].map((o) => ({
            id: o.id,
            type: o.type === OverwriteType.Role ? 'role' : 'member',
            allow: o.allow.bitfield.toString(),
            deny: o.deny.bitfield.toString(),
          }));
          if (overwrites(source) !== overwrites(effect.expected))
            throw new RestrictionWriteRejected('Inheritance source changed');
          await deps.repairFence.assertOwner();
          await channel.permissionOverwrites.set(
            effect.desired.map((o) => ({
              id: o.id,
              type: o.type === 'role' ? OverwriteType.Role : OverwriteType.Member,
              allow: BigInt(o.allow),
              deny: BigInt(o.deny),
            })),
            'Drasil selected restriction repair'
          );
          return;
        }
        case 'update_quarantine_policy': {
          if (effect.expected.manualIntakeRoleId !== effect.desired.manualIntakeRoleId)
            throw new RestrictionWriteRejected('Intake role changes require setup');
          await deps.repairFence.assertOwner();
          const current = await deps.configService.findServerConfig(effect.guildId);
          if (!current) throw new RestrictionWriteRejected('Configuration unavailable');
          const policy = getRoleQuarantineSettings(current.settings);
          const manual = getManualIntakeSettings(current.settings);
          if (
            policy.mode !== effect.expected.quarantineMode ||
            canonicalIds(policy.exemptRoleIds) !== canonicalIds(effect.expected.exemptRoleIds) ||
            manual.roleId !== effect.expected.manualIntakeRoleId
          )
            throw new RestrictionWriteRejected('Policy changed');
          await deps.repairFence.assertOwner();
          const updated = await deps.configService.updateSetupIfUnchanged(
            effect.guildId,
            {
              approvedState: parseSetupStoredRecord(current as unknown as Record<string, unknown>),
            },
            {
              settings: {
                role_quarantine_mode: effect.desired.quarantineMode,
                role_quarantine_exempt_role_ids: effect.desired.exemptRoleIds,
              },
            }
          );
          if (!updated) throw new RestrictionWriteRejected('Configuration changed');
          return;
        }
        case 'quarantine_case_roles': {
          const current = await deps.cases.findById(effect.caseId);
          if (!current || String(current.case_revision) !== effect.caseRevision)
            throw new RestrictionWriteRejected('Case changed');
          const member = await guild.members.fetch({ user: effect.memberId, force: true });
          const actor = await deps.client.users.fetch(deps.actorId);
          await deps.quarantine.repairCaseRoles(member, current, effect.roleIds, actor, {
            ...deps.repairFence,
            caseRevision: current.case_revision,
            joinedAt: effect.joinedAt,
          });
          return;
        }
      }
    },
    async observe(effect): Promise<RestrictionEffectObservation> {
      try {
        const facts = await readFresh(effect.guildId);
        return {
          state: matches(facts, effect, true)
            ? 'desired_satisfied'
            : matches(facts, effect, false)
              ? 'before_observed'
              : 'unavailable',
          observedAt: facts.completedAt,
          reason: null,
        };
      } catch {
        return {
          state: 'unavailable',
          observedAt: new Date().toISOString(),
          reason: 'read_back_unavailable',
        };
      }
    },
  };
}
