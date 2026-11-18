import { createModerationActionRequestDataAdapter } from '@/lib/moderationActionRequestDataAdapter';
import { RestrictionAuditWizard } from '@/components/operations/RestrictionAuditWizard';
import { WorkspaceAccessFailure } from '@/components/workspace/WorkspaceReadFailure';
import {
  createRestrictionAuditDataAdapter,
  requireRestrictionAccess,
} from '@/lib/restrictionAuditDataAdapter';
import { createSetupDataAdapter } from '@/lib/setupDataAdapter';
import { fetchDiscordGuildChannels } from '@/lib/discordApi';
import {
  queueRestrictionAudit,
  reviewRestrictionSelection,
  applyRestrictionSelection,
  readRestrictionDiagnostics,
} from './actions';
interface RestrictionPageQuery {
  readonly audit?: string;
  readonly apply?: string;
}
interface RestrictionPageProps {
  readonly params: Promise<{ readonly guildId: string }>;
  readonly searchParams: Promise<RestrictionPageQuery>;
}
export default async function RestrictionsPage(props: RestrictionPageProps) {
  const { guildId } = await props.params;
  const query = await props.searchParams;
  const path = `/admin/guild/${guildId}/operations/restrictions`;
  const returnTo = `${path}?${new URLSearchParams({ ...(typeof query.audit === 'string' ? { audit: query.audit } : {}), ...(typeof query.apply === 'string' ? { apply: query.apply } : {}) })}`;
  try {
    await requireRestrictionAccess(guildId, returnTo);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('NEXT_REDIRECT')) throw error;
    return (
      <WorkspaceAccessFailure
        code={
          error instanceof Error && /access required|Administrator/.test(error.message)
            ? 'access_denied'
            : 'unavailable'
        }
      />
    );
  }
  return loadRestrictions(guildId, query);
}
async function loadRestrictions(guildId: string, query: RestrictionPageQuery) {
  try {
    const adapter = createRestrictionAuditDataAdapter();
    const recent = !query.audit
      ? await createModerationActionRequestDataAdapter().listRecentRequests(guildId, 25)
      : [];
    const auditId =
      typeof query.audit === 'string'
        ? query.audit
        : recent.find((r) => r.actionType === 'audit_case_role_lockdown')?.id;
    const auditData =
      typeof auditId === 'string'
        ? await adapter.readAudit(guildId, auditId)
        : { request: null, audit: null };
    const applyRequest =
      typeof query.apply === 'string' ? await adapter.readApply(guildId, query.apply) : null;
    const [server, channels] = await Promise.all([
      createSetupDataAdapter().getServer(guildId),
      fetchDiscordGuildChannels(guildId),
    ]);
    const allowed = new Set(server?.settings.case_role_lockdown_allowed_channel_ids ?? []);
    const categories = new Set(server?.settings.case_role_lockdown_allowed_category_ids ?? []);
    return (
      <RestrictionAuditWizard
        guildId={guildId}
        auditRequest={auditData.request}
        audit={auditData.audit}
        applyRequest={applyRequest}
        onAudit={queueRestrictionAudit.bind(null, guildId)}
        onReview={reviewRestrictionSelection.bind(null, guildId)}
        onApply={applyRestrictionSelection.bind(null, guildId)}
        onDiagnostics={readRestrictionDiagnostics.bind(null, guildId, auditId ?? '')}
        exceptions={channels
          .filter((c) => c.type !== 4 && (allowed.has(c.id) || categories.has(c.parent_id ?? '')))
          .map((c) => ({ id: c.id, name: c.name }))}
      />
    );
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('NEXT_REDIRECT')) throw error;
    return <WorkspaceAccessFailure code="unavailable" />;
  }
}
