import { getPostgresPool } from './setupDataAdapter';
import { fetchDiscordGuildChannels, fetchDiscordGuildRoles } from './discordApi';
import {
  describeRestrictionEffect,
  presentRestrictionAudit,
  presentRestrictionFix,
} from './restrictionAuditPresentation';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  prepareRestrictionPlan,
  projectRestrictionAudit,
  restrictionSelectionSchema,
  type ApprovedRestrictionPlan,
  type RestrictionSelection,
  type RestrictionEffect,
  type RestrictionChannelFact,
} from '@drasil/application';
import { encryptJson, decryptJson } from './crypto';
import { createWebActionContext } from './application/context';
import { createWebRestrictionPlanDependencies } from './mcp/adapters/restriction';
import { queueModerationQueueOperation } from './moderationQueueOperationActionQueue';
import { createModerationActionRequestDataAdapter } from './moderationActionRequestDataAdapter';
import {
  getCurrentAdminSession,
  getCurrentDiscordToken,
  getOauthEncryptionSecret,
} from './session';
import { loadWorkspaceAccess } from './workspaceAccess';
import { redirect } from 'next/navigation';
const referenceSchema = restrictionSelectionSchema.extend({
  purpose: z.literal('restriction_review'),
  submissionId: z.string().uuid(),
  guildId: z.string(),
  actorId: z.string(),
  expiresAt: z.iso.datetime(),
  digest: z.string(),
});
export function restrictionPlanDigest(plan: ApprovedRestrictionPlan): string {
  return createHash('sha256')
    .update(JSON.stringify({ effects: plan.effects, fingerprint: plan.materialStateFingerprint }))
    .digest('hex');
}
export function createRestrictionReviewReference(
  plan: ApprovedRestrictionPlan,
  secret: string
): string {
  return encryptJson(
    {
      purpose: 'restriction_review',
      submissionId: randomUUID(),
      auditRequestId: plan.auditRequestId,
      auditRevision: plan.auditRevision,
      selectedFixIds: plan.selectedFixIds,
      guildId: plan.guildId,
      actorId: plan.actorId,
      expiresAt: plan.expiresAt,
      digest: restrictionPlanDigest(plan),
    },
    secret
  );
}
export function readRestrictionReviewReference(
  reference: string,
  secret: string,
  guildId: string,
  actorId: string,
  now = new Date()
) {
  const parsed = referenceSchema.safeParse(decryptJson(reference, secret));
  if (
    !parsed.success ||
    parsed.data.guildId !== guildId ||
    parsed.data.actorId !== actorId ||
    Date.parse(parsed.data.expiresAt) <= now.getTime()
  )
    throw new Error('Review expired or unavailable.');
  return parsed.data;
}
export async function requireRestrictionAccess(
  guildId: string,
  returnTo = `/admin/guild/${guildId}/operations/restrictions`
) {
  const [session, token] = await Promise.all([getCurrentAdminSession(), getCurrentDiscordToken()]);
  const access = await loadWorkspaceAccess(guildId, session, token);
  if (access.kind === 'authentication_required' || !session)
    redirect(`/api/auth/discord?${new URLSearchParams({ returnTo })}`);
  if (access.kind !== 'ready')
    throw new Error(
      access.kind === 'access_denied' ? 'Server access required' : 'Unable to verify server access'
    );
  if (!access.actor.owner && (BigInt(access.actor.permissions) & 8n) === 0n)
    throw new Error('Administrator permission required');
  return createWebActionContext({ guildId, userId: session.userId });
}
async function restrictionNames(
  guildId: string,
  effects: readonly RestrictionEffect[] = [],
  assessedChannels?: readonly RestrictionChannelFact[]
) {
  const caseIds = [...new Set(effects.flatMap((e) => ('caseId' in e ? [e.caseId] : [])))];
  const members = caseIds.length
    ? await getPostgresPool().query<{ discord_id: string; username: string | null }>(
        'select distinct u.discord_id,u.username from users u join verification_events v on v.user_id=u.discord_id where v.server_id=$1 and v.id::text=any($2::text[])',
        [guildId, caseIds]
      )
    : { rows: [] };
  const [channels, roles] = await Promise.all([
    fetchDiscordGuildChannels(guildId),
    fetchDiscordGuildRoles(guildId),
  ]);
  return {
    assessedChannels,
    members: new Map(
      members.rows.filter((r) => r.username).map((r) => [r.discord_id, r.username!])
    ),
    channels: new Map(channels.map((c) => [c.id, c.name])),
    categories: new Set(channels.filter((c) => c.type === 4).map((c) => c.id)),
    roles: new Map(roles.map((r) => [r.id, r.name])),
  };
}
export function createRestrictionAuditDataAdapter() {
  return {
    async queueAudit(guildId: string) {
      const context = await requireRestrictionAccess(guildId);
      return queueModerationQueueOperation({
        context,
        command: { kind: 'audit_case_role_lockdown' },
      });
    },
    async readAudit(guildId: string, requestId: string, diagnosticOffset = 0) {
      await requireRestrictionAccess(guildId);
      if (!Number.isSafeInteger(diagnosticOffset) || diagnosticOffset < 0)
        throw new Error('Invalid diagnostic page');
      const deps = createWebRestrictionPlanDependencies();
      const [request, audit] = await Promise.all([
        createModerationActionRequestDataAdapter().getRequest(guildId, requestId),
        deps.auditStore.load(requestId, guildId),
      ]);
      return {
        request,
        audit: audit
          ? presentRestrictionAudit(
              projectRestrictionAudit(requestId, audit, diagnosticOffset),
              await restrictionNames(
                guildId,
                audit.fixes.flatMap((f) => f.effects),
                audit.facts.channels
              )
            )
          : null,
      };
    },
    async prepareSelection(guildId: string, selection: RestrictionSelection) {
      const context = await requireRestrictionAccess(guildId);
      const deps = createWebRestrictionPlanDependencies();
      const plan = await prepareRestrictionPlan(context, selection, deps);
      const audit = await deps.auditStore.load(plan.auditRequestId, guildId);
      if (!audit) throw new Error('Audit unavailable');
      const names = await restrictionNames(guildId, plan.effects, audit.facts.channels);
      return {
        reference: createRestrictionReviewReference(plan, getOauthEncryptionSecret()),
        expiresAt: plan.expiresAt,
        fixes: audit.fixes
          .filter((f) => plan.selectedFixIds.includes(f.id))
          .map((f) => presentRestrictionFix(f, names)),
      };
    },
    async queueApply(guildId: string, approvedPlanReference: string) {
      const context = await requireRestrictionAccess(guildId);
      if (context.actor.kind !== 'user') throw new Error('Server access required');
      const reference = readRestrictionReviewReference(
        approvedPlanReference,
        getOauthEncryptionSecret(),
        guildId,
        context.actor.userId
      );
      const selection = restrictionSelectionSchema.parse({
        auditRequestId: reference.auditRequestId,
        auditRevision: reference.auditRevision,
        selectedFixIds: reference.selectedFixIds,
      });
      const plan = await prepareRestrictionPlan(
        context,
        selection,
        createWebRestrictionPlanDependencies()
      );
      if (
        restrictionPlanDigest(plan) !== reference.digest ||
        plan.expiresAt !== reference.expiresAt
      )
        throw new Error('Material changes require a fresh review');
      return queueModerationQueueOperation({
        context: { ...context, requestId: reference.submissionId },
        command: { kind: 'apply_case_role_lockdown', ...selection },
      });
    },
    async readApply(guildId: string, requestId: string) {
      await requireRestrictionAccess(guildId);
      const request = await createModerationActionRequestDataAdapter().getRequest(
        guildId,
        requestId
      );
      if (request?.actionType !== 'apply_case_role_lockdown') return null;
      const { createRestrictionStores } = await import('@drasil/application/postgres');
      const { createWebDelegationDatabase } = await import('./mcp/adapters/database');
      const plan = await createRestrictionStores(createWebDelegationDatabase()).loadPlan(requestId);
      if (!plan || plan.guildId !== guildId) return request;
      const audit = await createWebRestrictionPlanDependencies().auditStore.load(
        plan.auditRequestId,
        guildId
      );
      const names = await restrictionNames(
        guildId,
        plan.effects,
        audit?.revision === plan.auditRevision ? audit.facts.channels : undefined
      );
      return {
        ...request,
        restrictionEffectDescriptions: plan.effects.map((effect) =>
          describeRestrictionEffect(effect, names)
        ),
      };
    },
  };
}
