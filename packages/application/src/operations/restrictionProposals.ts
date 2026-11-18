import { restrictionFactsAfter } from './restrictionFactsAfter';
import { restrictionMemberHasProtectedRole } from './restrictionRepairEligibility';
import { assessRestrictionFacts } from './restrictionAssessment';
import {
  classifyRestrictionRoles,
  STANDARD_RESTRICTION_PRIVILEGED_PERMISSIONS,
} from './restrictionPolicy';
import type {
  RestrictionAssessmentSet,
  RestrictionEffect,
  RestrictionFacts,
  RestrictionFix,
} from './restrictionTypes';

const VIEW = 1n << 10n;
const HISTORY = 1n << 16n;
const REPLY = 1n << 38n;
const INTERACTIONS =
  (1n << 0n) |
  (1n << 4n) |
  (1n << 6n) |
  (1n << 9n) |
  (1n << 11n) |
  (1n << 13n) |
  (1n << 17n) |
  (1n << 20n) |
  (1n << 21n) |
  (1n << 25n) |
  (1n << 29n) |
  (1n << 31n) |
  (1n << 32n) |
  (1n << 34n) |
  (1n << 35n) |
  (1n << 36n) |
  REPLY |
  (1n << 39n) |
  (1n << 42n) |
  (1n << 48n) |
  (1n << 51n);

/** Combine compatible edits only when they bind the same material before-state. */
export function normalizeRestrictionEffects(
  effects: readonly RestrictionEffect[]
): readonly RestrictionEffect[] {
  const result = new Map<string, RestrictionEffect>();
  for (const effect of effects) {
    const key =
      effect.kind === 'edit_overwrite'
        ? `${effect.kind}:${effect.guildId}:${effect.channelId}:${effect.roleId}`
        : effect.kind === 'set_role_permissions'
          ? `${effect.kind}:${effect.guildId}:${effect.roleId}`
          : effect.kind === 'update_quarantine_policy'
            ? `${effect.kind}:${effect.guildId}`
            : effect.kind === 'unsync_channel'
              ? `${effect.kind}:${effect.guildId}:${effect.channelId}`
              : `${effect.kind}:${effect.guildId}:${effect.caseId}`;
    const prior = result.get(key);
    if (!prior) {
      result.set(key, effect);
      continue;
    }
    if (JSON.stringify(prior) === JSON.stringify(effect)) continue;
    if (
      prior.kind === 'set_role_permissions' &&
      effect.kind === prior.kind &&
      prior.expected === effect.expected
    ) {
      const overlap = BigInt(prior.mask) & BigInt(effect.mask);
      if (((BigInt(prior.desired) ^ BigInt(effect.desired)) & overlap) !== 0n)
        throw new Error('Conflicting restriction effects');
      const mask = BigInt(prior.mask) | BigInt(effect.mask);
      result.set(key, {
        ...prior,
        mask: mask.toString(),
        desired: (
          (BigInt(prior.expected) & ~mask) |
          (BigInt(prior.desired) & BigInt(prior.mask)) |
          (BigInt(effect.desired) & BigInt(effect.mask))
        ).toString(),
      });
      continue;
    }
    if (
      prior.kind === 'edit_overwrite' &&
      effect.kind === prior.kind &&
      JSON.stringify(prior.expected) === JSON.stringify(effect.expected) &&
      prior.desired &&
      effect.desired
    ) {
      const beforeAllow = BigInt(prior.expected?.allow ?? '0');
      const beforeDeny = BigInt(prior.expected?.deny ?? '0');
      const priorMask =
        (beforeAllow ^ BigInt(prior.desired.allow)) | (beforeDeny ^ BigInt(prior.desired.deny));
      const nextMask =
        (beforeAllow ^ BigInt(effect.desired.allow)) | (beforeDeny ^ BigInt(effect.desired.deny));
      const overlap = priorMask & nextMask;
      if (
        (((BigInt(prior.desired.allow) ^ BigInt(effect.desired.allow)) |
          (BigInt(prior.desired.deny) ^ BigInt(effect.desired.deny))) &
          overlap) ===
        0n
      ) {
        result.set(key, {
          ...prior,
          desired: {
            allow: (
              (BigInt(prior.desired.allow) & ~nextMask) |
              (BigInt(effect.desired.allow) & nextMask)
            ).toString(),
            deny: (
              (BigInt(prior.desired.deny) & ~nextMask) |
              (BigInt(effect.desired.deny) & nextMask)
            ).toString(),
          },
        });
        continue;
      }
    }
    throw new Error('Conflicting restriction effects');
  }
  return [...result.values()];
}

export function proposeRestrictionFixes(
  facts: RestrictionFacts,
  assessment: RestrictionAssessmentSet
): readonly RestrictionFix[] {
  const fixes: RestrictionFix[] = [];
  const add = (
    id: string,
    summary: string,
    scope: string[],
    effects: RestrictionEffect[],
    defaultSelected = false,
    kind: RestrictionFix['kind'] = 'access_repair'
  ): void => {
    fixes.push({
      id,
      kind,
      summary,
      before: 'Observed permission or policy mismatch',
      after: 'Apply only the listed frozen changes; a fresh audit verifies access',
      affectedScope: scope,
      affectedCount: scope.length,
      defaultSelected:
        defaultSelected &&
        facts.channelsComplete &&
        facts.casesComplete &&
        facts.threadsComplete &&
        facts.cases.every((member) => member.metadataAvailable) &&
        facts.channels.every((channel) => channel.metadataAvailable) &&
        facts.threads.every((thread) => thread.metadataAvailable) &&
        assessment.setup.coverage.every(
          (coverage) => coverage.area === 'parent_content' || coverage.state === 'complete'
        ),
      selectable: effects.length > 0,
      effects: [...normalizeRestrictionEffects(effects)],
    });
  };
  let working = facts;
  const accessFindings = assessment.setup.findings.filter(
    (f) => f.code === 'unexpected_channel_access' || f.code === 'exception_write_access'
  );
  const ordinary = classifyRestrictionRoles({
    ...facts,
    exemptRoleIds: [],
    purpose: 'standard_case',
  });
  const includeExemptions = facts.exemptRoleIds.filter(
    (id) =>
      !facts.repairExcludedRoleIds?.includes(id) &&
      ordinary.find((role) => role.roleId === id)?.removable &&
      accessFindings.some((finding) => {
        const channel = facts.channels.find((c) => c.id === finding.channelId);
        const source = channel?.permissionsLocked
          ? facts.channels.find((c) => c.id === channel.parentId)
          : channel;
        const overwrite = source?.overwrites.find((o) => o.type === 'role' && o.id === id);
        const permissions = facts.roles.find((r) => r.id === id)?.permissions ?? '0';
        return (
          ((BigInt(overwrite?.allow ?? '0') | BigInt(permissions)) & (VIEW | INTERACTIONS)) !== 0n
        );
      })
  );
  if (accessFindings.length && (facts.quarantineMode !== 'on' || includeExemptions.length)) {
    const expected = {
      quarantineMode: facts.quarantineMode,
      exemptRoleIds: facts.exemptRoleIds,
      manualIntakeRoleId: facts.manualIntakeRoleId,
    };
    const desired = {
      ...expected,
      quarantineMode: 'on' as const,
      exemptRoleIds: facts.exemptRoleIds.filter((id) => !includeExemptions.includes(id)),
    };
    add(
      'policy:quarantine',
      includeExemptions.length
        ? 'Include eligible exempt ordinary roles in future quarantine'
        : 'Enable quarantine of eligible ordinary roles for future cases',
      includeExemptions,
      [{ kind: 'update_quarantine_policy', guildId: facts.guildId, expected, desired }]
    );
    fixes[fixes.length - 1].after =
      'Future cases quarantine eligible ordinary roles. Current case removals require their own listed effects; ordinary members keep their roles.';
    working = { ...facts, ...desired };
  }
  const role = facts.roles.find((r) => r.id === facts.caseRoleId);
  if (
    role &&
    role.id !== facts.guildId &&
    !role.managed &&
    facts.botHighestPosition !== null &&
    role.position < facts.botHighestPosition
  ) {
    const privileges = BigInt(role.permissions) & STANDARD_RESTRICTION_PRIVILEGED_PERMISSIONS;
    if (privileges !== 0n)
      add(
        `role:${role.id}`,
        'Remove privileged permissions from the case role',
        [role.id],
        [
          {
            kind: 'set_role_permissions',
            guildId: facts.guildId,
            roleId: role.id,
            mask: privileges.toString(),
            expected: role.permissions,
            desired: (BigInt(role.permissions) & ~privileges).toString(),
          },
        ],
        true
      );
    const findings = assessRestrictionFacts(working).setup.findings;
    const targets = new Set<string>();
    for (const finding of findings) {
      if (
        !finding.channelId ||
        ![
          'unexpected_channel_access',
          'exception_write_access',
          'recovery_parent_access_missing',
        ].includes(finding.code)
      )
        continue;
      const channel = facts.channels.find((c) => c.id === finding.channelId);
      if (
        !channel ||
        !channel.metadataAvailable ||
        (channel.id === facts.recoveryParentId && channel.type !== 'text')
      )
        continue;
      const parent = facts.channels.find((c) => c.id === channel.parentId);
      const inherited = channel.permissionsLocked && parent?.metadataAvailable;
      const mixed =
        inherited &&
        facts.channels.some(
          (c) =>
            c.parentId === parent.id &&
            (facts.exceptionChannelIds.includes(c.id) || c.id === facts.recoveryParentId)
        );
      const target = inherited && !mixed ? parent : channel;
      if (targets.has(target.id)) continue;
      targets.add(target.id);
      const recovery = target.id === facts.recoveryParentId;
      const exception = facts.exceptionChannelIds.includes(target.id);
      const allowMask = recovery ? VIEW | HISTORY | REPLY : exception ? VIEW | HISTORY : 0n;
      const denyMask = recovery
        ? INTERACTIONS & ~REPLY
        : exception
          ? INTERACTIONS
          : VIEW | INTERACTIONS;
      const source = inherited && mixed ? parent.overwrites : target.overwrites;
      const before = source.find((o) => o.id === role.id && o.type === 'role');
      const expected = before ? { allow: before.allow, deny: before.deny } : null;
      const desired = {
        allow: ((BigInt(before?.allow ?? '0') & ~denyMask) | allowMask).toString(),
        deny: ((BigInt(before?.deny ?? '0') & ~allowMask) | denyMask).toString(),
      };
      if (expected?.allow === desired.allow && expected.deny === desired.deny) continue;
      const effects: RestrictionEffect[] = [];
      if (inherited && mixed)
        effects.push({
          kind: 'unsync_channel',
          guildId: facts.guildId,
          channelId: channel.id,
          parentId: parent.id,
          expected: source,
          desired: [
            ...source.filter((o) => !(o.id === role.id && o.type === 'role')),
            { id: role.id, type: 'role', ...desired },
          ],
        });
      else
        effects.push({
          kind: 'edit_overwrite',
          guildId: facts.guildId,
          channelId: target.id,
          roleId: role.id,
          expected,
          desired,
        });
      const scope = [
        target.id,
        ...facts.channels
          .filter((c) => c.parentId === target.id && c.permissionsLocked)
          .map((c) => c.id),
      ];
      const after = assessRestrictionFacts(effects.reduce(restrictionFactsAfter, working)).setup;
      const repairsAccess = findings.some(
        (f) =>
          scope.includes(f.channelId ?? '') &&
          f.kind === 'access_failure' &&
          !after.findings.some(
            (remaining) => remaining.code === f.code && remaining.channelId === f.channelId
          )
      );
      add(
        `overwrite:${target.id}:${role.id}`,
        inherited && mixed
          ? 'Unsync this channel and correct case-role access together'
          : repairsAccess
            ? 'Correct case-role access on this channel and its synced children'
            : 'Add optional case-role deny coverage; retained allows still need review',
        scope,
        effects,
        repairsAccess && !(inherited && mixed),
        repairsAccess ? 'access_repair' : 'hardening'
      );
    }
  }
  const policy = fixes.find((fix) => fix.id === 'policy:quarantine');
  if (policy) {
    const dependent = fixes.filter(
      (fix) =>
        fix.kind === 'access_repair' &&
        fix.effects.some(
          (effect) => effect.kind === 'edit_overwrite' || effect.kind === 'unsync_channel'
        )
    );
    if (dependent.length) {
      const scope = [
        ...new Set([...policy.affectedScope, ...dependent.flatMap((fix) => fix.affectedScope)]),
      ];
      fixes.splice(
        0,
        fixes.length,
        ...fixes.filter((fix) => fix !== policy && !dependent.includes(fix)),
        {
          ...policy,
          summary: 'Update ordinary-role quarantine and correct case-role channel access together',
          affectedScope: scope,
          affectedCount: scope.length,
          effects: [
            ...normalizeRestrictionEffects([
              ...policy.effects,
              ...dependent.flatMap((fix) => fix.effects),
            ]),
          ],
        }
      );
    }
  }
  for (const member of facts.cases) {
    const memberAssessment = assessment.cases.find((c) => c.caseId === member.caseId);
    if (
      !member.metadataAvailable ||
      !member.joinedAt ||
      member.owner ||
      !memberAssessment?.findings.some((f) => f.kind === 'access_failure')
    )
      continue;
    // The wizard never removes privileged staff roles, even for compromised-account cases.
    const dispositions = classifyRestrictionRoles({
      ...working,
      caseRoleId: member.caseRoleId ?? facts.caseRoleId,
      purpose: 'standard_case',
    });
    const protectedMember = restrictionMemberHasProtectedRole(
      facts.roles.filter((r) => member.roleIds.includes(r.id)),
      member.caseRoleId ?? facts.caseRoleId
    );
    const candidates = member.roleIds.filter(
      (id) => id !== facts.caseRoleId && dispositions.find((d) => d.roleId === id)?.removable
    );
    const removable: string[] = [];
    for (const id of candidates) {
      const reason = member.roleIds.some((roleId) => !facts.roles.some((r) => r.id === roleId))
        ? 'Member role metadata is unavailable'
        : protectedMember
          ? 'This member retains a protected staff role; automatic removal is disabled'
          : !member.repairEligibility
            ? 'Snapshot ownership evidence is unavailable'
            : (member.repairEligibility.reason ??
              member.repairEligibility.blockedRoles.find((r) => r.roleId === id)?.reason ??
              (facts.repairExcludedRoleIds?.includes(id)
                ? 'This role is managed by the active role policy'
                : null));
      if (!reason) {
        removable.push(id);
        continue;
      }
      fixes.push({
        id: `manual:quarantine:${member.caseId}:${id}`,
        kind: 'manual',
        summary: reason,
        before: 'Current case role removal is not eligible',
        after: 'Requires moderator review; no automatic change',
        affectedScope: [member.userId, id],
        affectedCount: 1,
        defaultSelected: false,
        selectable: false,
        effects: [],
      });
    }
    if (!removable.length) continue;
    const effect: RestrictionEffect = {
      kind: 'quarantine_case_roles',
      guildId: facts.guildId,
      caseId: member.caseId,
      caseRevision: member.caseRevision,
      joinedAt: member.joinedAt,
      memberId: member.userId,
      roleIds: removable,
      expected: member.roleIds,
      desired: member.roleIds.filter((id) => !removable.includes(id)),
    };
    const policyIndex = fixes.findIndex((fix) => fix.id === 'policy:quarantine');
    if (policyIndex !== -1 && removable.some((id) => includeExemptions.includes(id))) {
      const policy = fixes[policyIndex];
      fixes[policyIndex] = {
        ...policy,
        summary: 'Update ordinary-role quarantine and remove the listed roles from current cases',
        affectedScope: [...new Set([...policy.affectedScope, member.userId])],
        affectedCount: policy.affectedCount + 1,
        effects: [...policy.effects, effect],
      };
    } else
      add(
        `quarantine:${member.caseId}`,
        'Quarantine eligible ordinary roles on this case member',
        [member.userId],
        [effect]
      );
  }

  const manual = new Set<string>();
  for (const finding of [
    ...assessment.setup.findings,
    ...assessment.cases.flatMap((c) => c.findings),
  ]) {
    if (
      finding.kind === 'limitation' ||
      finding.kind === 'coverage' ||
      finding.kind === 'manual' ||
      (finding.kind === 'access_failure' &&
        !fixes.some(
          (fix) =>
            fix.selectable &&
            finding.channelId !== null &&
            fix.affectedScope.includes(finding.channelId)
        )) ||
      finding.userId ||
      ['sibling_thread_access', 'case_thread_access_missing', 'case_thread_unavailable'].includes(
        finding.code
      )
    ) {
      const id = `manual:${finding.code}:${finding.channelId ?? 'guild'}:${finding.userId ?? 'setup'}`;
      if (manual.has(id)) continue;
      manual.add(id);
      fixes.push({
        id,
        kind: finding.kind === 'limitation' ? 'hardening' : 'manual',
        summary: `Review ${finding.code.replace(/_/g, ' ')}`,
        before: 'Observed finding or missing evidence',
        after: 'Requires moderator review; no automatic change',
        affectedScope: [finding.channelId, finding.userId].filter((v): v is string => v !== null),
        affectedCount: finding.userId ? 1 : 0,
        defaultSelected: false,
        selectable: false,
        effects: [],
      });
    }
  }
  return fixes;
}
