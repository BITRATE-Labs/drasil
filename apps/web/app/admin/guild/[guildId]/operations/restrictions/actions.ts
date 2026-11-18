'use server';
import type { RestrictionSelection } from '@drasil/application';
import { createRestrictionAuditDataAdapter } from '@/lib/restrictionAuditDataAdapter';
async function safeAction<T>(action: () => Promise<T>): Promise<T | { readonly error: string }> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('NEXT_REDIRECT')) throw error;
    const code = error instanceof Error ? error.message : '';
    return {
      error: /stale|expired|Material|Review expired/.test(code)
        ? 'Permissions or settings changed. Run a fresh audit and review again.'
        : /authority|access|Administrator/.test(code)
          ? 'Your server authority could not be confirmed. Sign in and check access again.'
          : 'The request could not be completed. Run a fresh audit and review again.',
    };
  }
}
export async function queueRestrictionAudit(guildId: string) {
  return safeAction(() => createRestrictionAuditDataAdapter().queueAudit(guildId));
}
export async function reviewRestrictionSelection(guildId: string, selection: RestrictionSelection) {
  return safeAction(() => createRestrictionAuditDataAdapter().prepareSelection(guildId, selection));
}
export async function applyRestrictionSelection(guildId: string, reference: string) {
  return safeAction(() => createRestrictionAuditDataAdapter().queueApply(guildId, reference));
}
export async function readRestrictionDiagnostics(
  guildId: string,
  requestId: string,
  offset: number
) {
  return safeAction(
    async () =>
      (await createRestrictionAuditDataAdapter().readAudit(guildId, requestId, offset)).audit
  );
}
