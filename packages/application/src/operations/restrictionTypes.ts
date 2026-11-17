import { z } from 'zod';

const id = z.string().min(1);
const timestamp = z.iso.datetime();
const bits = z.string().regex(/^\d+$/);
export const RESTRICTION_PLAN_TTL_MS = 10 * 60 * 1000;
export const restrictionStatusSchema = z.enum(['verified', 'incomplete', 'unverified']);
export type RestrictionStatus = z.infer<typeof restrictionStatusSchema>;
export const restrictionCoverageSchema = z.object({
  area: z.enum(['channels', 'cases', 'threads', 'affected_members', 'parent_content']),
  state: z.enum(['complete', 'partial', 'unavailable', 'out_of_scope']),
  checked: z.number().int().nonnegative(),
  total: z.number().int().nonnegative().nullable(),
  reason: z.string().nullable(),
  observedAt: timestamp,
  completedAt: timestamp,
});
export type RestrictionCoverage = z.infer<typeof restrictionCoverageSchema>;
export const restrictionFindingCodeSchema = z.enum([
  'case_role_missing',
  'retained_privileged_permissions',
  'metadata_unavailable',
  'unexpected_channel_access',
  'exception_write_access',
  'reaction_limitation',
  'case_role_not_assigned',
  'owner_bypass',
  'administrator_bypass',
  'case_thread_unavailable',
  'case_thread_access_missing',
  'sibling_thread_access',
  'parent_content_exposure',
]);
export type RestrictionFindingCode = z.infer<typeof restrictionFindingCodeSchema>;
export const restrictionFindingSchema = z.object({
  code: restrictionFindingCodeSchema,
  channelId: id.nullable(),
  userId: id.nullable(),
  roleIds: z.array(id),
  kind: z.enum(['access_failure', 'manual', 'limitation', 'coverage']),
});
export type RestrictionFinding = z.infer<typeof restrictionFindingSchema>;
export const restrictionAssessmentSchema = z.object({
  status: restrictionStatusSchema,
  findingCodes: z.array(restrictionFindingCodeSchema),
  findings: z.array(restrictionFindingSchema),
  coverage: z.array(restrictionCoverageSchema),
  scope: z.literal('permissions_and_membership'),
});
export type RestrictionAssessment = z.infer<typeof restrictionAssessmentSchema>;
export const restrictionCaseAssessmentSchema = restrictionAssessmentSchema.extend({
  caseId: id,
  caseRevision: id,
  userId: id,
});
export type RestrictionCaseAssessment = z.infer<typeof restrictionCaseAssessmentSchema>;
export interface RestrictionAssessmentSet {
  readonly setup: RestrictionAssessment;
  readonly cases: readonly RestrictionCaseAssessment[];
}
export const restrictionRoleFactSchema = z.object({
  id,
  name: z.string(),
  position: z.number().int(),
  permissions: bits,
  managed: z.boolean(),
  botManaged: z.boolean(),
});
export type RestrictionRoleFact = z.infer<typeof restrictionRoleFactSchema>;
export const restrictionRolePolicyInputSchema = z.object({
  guildId: id,
  caseRoleId: id.nullable(),
  purpose: z.enum(['standard_case', 'compromised_account']),
  quarantineMode: z.enum(['off', 'audit_only', 'on']),
  exemptRoleIds: z.array(id),
  manualIntakeRoleId: id.nullable(),
  botHighestPosition: z.number().int().nullable(),
  roles: z.array(restrictionRoleFactSchema),
});
export type RestrictionRolePolicyInput = z.infer<typeof restrictionRolePolicyInputSchema>;
export const restrictionRoleSkipReasonSchema = z.enum([
  'everyone role',
  'case role',
  'configured exempt role',
  'bot-managed role',
  'managed role',
  'privileged role',
  'Drasil member could not be loaded',
  'role is at or above Drasil role',
]);
export interface RestrictionRoleDisposition {
  readonly roleId: string;
  readonly removable: boolean;
  readonly skipReason: z.infer<typeof restrictionRoleSkipReasonSchema> | null;
}
export const restrictionOverwriteSchema = z.object({
  id,
  type: z.enum(['role', 'member']),
  allow: bits,
  deny: bits,
});
export type RestrictionOverwrite = z.infer<typeof restrictionOverwriteSchema>;
export const restrictionChannelFactSchema = z.object({
  id,
  name: z.string(),
  type: z.enum(['text', 'voice', 'stage', 'forum', 'media', 'category']),
  parentId: id.nullable(),
  permissionsLocked: z.boolean(),
  overwrites: z.array(restrictionOverwriteSchema),
  metadataAvailable: z.boolean(),
});
export type RestrictionChannelFact = z.infer<typeof restrictionChannelFactSchema>;
export const restrictionThreadFactSchema = z.object({
  id,
  parentId: id,
  private: z.boolean(),
  archived: z.boolean(),
  locked: z.boolean(),
  memberIds: z.array(id),
  metadataAvailable: z.boolean(),
});
export type RestrictionThreadFact = z.infer<typeof restrictionThreadFactSchema>;
export const restrictionCaseFactSchema = z.object({
  caseId: id,
  caseRoleId: id.nullable(),
  caseRevision: id,
  userId: id,
  purpose: z.enum(['standard_case', 'compromised_account']),
  roleIds: z.array(id),
  owner: z.boolean(),
  metadataAvailable: z.boolean(),
  threadId: id.nullable(),
});
export type RestrictionCaseFact = z.infer<typeof restrictionCaseFactSchema>;
export const restrictionFactsSchema = restrictionRolePolicyInputSchema
  .omit({ purpose: true })
  .extend({
    observedAt: timestamp,
    completedAt: timestamp,
    channels: z.array(restrictionChannelFactSchema),
    channelsComplete: z.boolean(),
    cases: z.array(restrictionCaseFactSchema),
    casesComplete: z.boolean(),
    threads: z.array(restrictionThreadFactSchema),
    threadsComplete: z.boolean(),
    exceptionChannelIds: z.array(id),
    recoveryParentId: id.nullable(),
    knownParentContentExposure: z.boolean(),
  });
export type RestrictionFacts = z.infer<typeof restrictionFactsSchema>;
const overwriteState = z.object({ allow: bits, deny: bits }).nullable();
const policyState = restrictionRolePolicyInputSchema.pick({
  quarantineMode: true,
  exemptRoleIds: true,
  manualIntakeRoleId: true,
});
export const restrictionEffectSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('edit_overwrite'),
    guildId: id,
    channelId: id,
    roleId: id,
    expected: overwriteState,
    desired: overwriteState,
  }),
  z.object({
    kind: z.literal('set_role_permissions'),
    guildId: id,
    roleId: id,
    mask: bits,
    expected: bits,
    desired: bits,
  }),
  z.object({
    kind: z.literal('unsync_channel'),
    guildId: id,
    channelId: id,
    parentId: id,
    expected: z.array(restrictionOverwriteSchema),
    desired: z.array(restrictionOverwriteSchema),
  }),
  z.object({
    kind: z.literal('update_quarantine_policy'),
    guildId: id,
    expected: policyState,
    desired: policyState,
  }),
  z.object({
    kind: z.literal('quarantine_case_roles'),
    guildId: id,
    caseId: id,
    caseRevision: id,
    memberId: id,
    roleIds: z.array(id).min(1),
    expected: z.array(id),
    desired: z.array(id),
  }),
]);
export type RestrictionEffect = z.infer<typeof restrictionEffectSchema>;
export const restrictionFixSchema = z.object({
  id,
  kind: z.enum(['access_repair', 'hardening', 'manual']),
  summary: z.string(),
  before: z.string(),
  after: z.string(),
  affectedScope: z.array(id),
  affectedCount: z.number().int().nonnegative(),
  defaultSelected: z.boolean(),
  selectable: z.boolean(),
  effects: z.array(restrictionEffectSchema),
});
export type RestrictionFix = z.infer<typeof restrictionFixSchema>;
export const restrictionAuditSchema = z.object({
  schemaVersion: z.literal(1),
  guildId: id,
  observedAt: timestamp,
  completedAt: timestamp,
  revision: id,
  expiresAt: timestamp,
  setup: restrictionAssessmentSchema,
  cases: z.array(restrictionCaseAssessmentSchema),
  coverage: z.array(restrictionCoverageSchema),
  fixes: z.array(restrictionFixSchema),
  facts: restrictionFactsSchema,
});
export type RestrictionAudit = z.infer<typeof restrictionAuditSchema>;
export const restrictionSelectionSchema = z
  .object({
    auditRequestId: id,
    auditRevision: id,
    selectedFixIds: z
      .array(id)
      .min(1)
      .refine((values) => new Set(values).size === values.length, 'Fix IDs must be unique'),
  })
  .strict();
export type RestrictionSelection = z.infer<typeof restrictionSelectionSchema>;
export const approvedRestrictionPlanSchema = restrictionSelectionSchema.extend({
  actorId: id,
  guildId: id,
  effects: z.array(restrictionEffectSchema),
  materialStateFingerprint: id,
  expiresAt: timestamp,
});
export type ApprovedRestrictionPlan = z.infer<typeof approvedRestrictionPlanSchema>;
export const restrictionEffectObservationSchema = z.object({
  state: z.enum(['desired_satisfied', 'before_observed', 'unavailable']),
  observedAt: timestamp,
  reason: z.string().nullable(),
});
export type RestrictionEffectObservation = z.infer<typeof restrictionEffectObservationSchema>;
export const restrictionProgressSchema = z.object({
  schemaVersion: z.literal(1),
  revision: z.number().int().nonnegative(),
  currentEffectIndex: z.number().int().nonnegative(),
  receipts: z.array(
    z.object({
      effectIndex: z.number().int().nonnegative(),
      state: z.enum(['not_attempted', 'started', 'applied', 'failed', 'unknown']),
      observation: restrictionEffectObservationSchema.nullable(),
      error: z.string().nullable(),
    })
  ),
});
export type RestrictionProgress = z.infer<typeof restrictionProgressSchema>;
export interface RestrictionApplyResult {
  readonly progress: RestrictionProgress;
  readonly stopReason:
    | 'completed'
    | 'write_failed'
    | 'precondition_changed'
    | 'unknown_outcome'
    | 'authority_lost'
    | 'expired';
  readonly verification: RestrictionAssessmentSet;
}
