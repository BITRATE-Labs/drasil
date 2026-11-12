import { z } from 'zod';
const shared = {
  updatedAt: z.iso.datetime(),
  failures: z.array(
    z
      .object({
        step: z.enum(['role', 'thread', 'kick', 'persistence', 'notification']),
        code: z.enum([
          'role_assignment_failed',
          'thread_creation_failed',
          'kick_rejected',
          'kick_outcome_unknown',
          'persistence_failed',
          'notification_delivery_failed',
        ]),
      })
      .strict()
  ),
  attention: z.enum(['required', 'acknowledged', 'resolved']),
  caseId: z.string().uuid().nullable(),
};
export const automaticModerationResponseSchema = z.discriminatedUnion('action', [
  z
    .object({
      ...shared,
      action: z.literal('kick'),
      outcome: z.enum(['pending', 'kicked', 'failed', 'unknown']),
    })
    .strict(),
  z
    .object({
      ...shared,
      action: z.literal('restrict'),
      outcome: z.enum(['pending', 'case_opened', 'failed']),
    })
    .strict(),
  z
    .object({
      ...shared,
      action: z.literal('notify'),
      outcome: z.enum(['pending', 'notified', 'failed']),
    })
    .strict(),
]);
export type AutomaticModerationResponse = z.infer<typeof automaticModerationResponseSchema>;
export function readAutomaticModerationResponse(
  metadata: unknown
): AutomaticModerationResponse | null {
  const result = z
    .object({ automatic_moderation_response: automaticModerationResponseSchema })
    .safeParse(metadata);
  return result.success ? result.data.automatic_moderation_response : null;
}
export function hasAutomaticResponseAttention(metadata: unknown): boolean {
  const response = readAutomaticModerationResponse(metadata);
  return response !== null && response.caseId === null && response.attention !== 'resolved';
}

export function formatAutomaticModerationResponse(response: AutomaticModerationResponse): string {
  const lines: string[] = [];
  if (response.action === 'kick') {
    switch (response.outcome) {
      case 'kicked':
        lines.push('Member kicked.');
        break;
      case 'failed':
        lines.push(
          'Automatic kick failed. The member may still have access. In Discord, inspect the member and use the Kick User or Ban User menu action if needed.'
        );
        break;
      case 'unknown':
        lines.push(
          'Kick outcome could not be confirmed. Check membership before taking further action.'
        );
        break;
      case 'pending':
        lines.push('Kick outcome is pending. Check membership before taking further action.');
        break;
    }
  } else if (response.action === 'restrict') {
    lines.push(
      response.outcome === 'case_opened'
        ? 'Moderation case opened.'
        : 'Restriction incomplete. Moderator action required.'
    );
  } else {
    lines.push(
      response.outcome === 'notified'
        ? 'Moderator notification delivered.'
        : 'Moderator notification incomplete.'
    );
  }
  const failureCopy = {
    role: 'Case role could not be applied. Moderator action required.',
    thread: 'Case thread could not be created. Moderator action required.',
    kick: '',
    persistence: 'Follow-up records could not be saved.',
    notification: 'Notification delivery failed.',
  };
  for (const failure of response.failures) {
    const copy = failureCopy[failure.step];
    if (copy && !lines.includes(copy)) lines.push(copy);
  }
  return lines.join(' ');
}

export function formatCaseActionFailures(metadata: unknown, roleApplied = false): string | null {
  const response = readAutomaticModerationResponse(metadata);
  if (response?.action === 'kick' && response.failures.length)
    return formatAutomaticModerationResponse(response);
  const result = z
    .object({
      action_failures: z.array(
        z.object({
          action: z.enum([
            'case_role',
            'restrict',
            'thread',
            'private_evidence_thread',
            'role_quarantine',
            'notification',
            'persistence',
          ]),
          message: z.string(),
          at: z.string(),
        })
      ),
    })
    .safeParse(metadata);
  if (!result.success || !result.data.action_failures.length) return null;
  const actions = new Set(result.data.action_failures.map((failure) => failure.action));
  const lines: string[] = [];
  if (actions.has('case_role') || actions.has('restrict')) {
    lines.push(
      'Restriction incomplete. Case role could not be applied. Moderator action required.'
    );
  } else if (roleApplied) {
    lines.push('Case role applied.');
  } else {
    lines.push('Case saved.');
  }
  if (actions.has('thread'))
    lines.push('Case thread could not be created. Moderator action required.');
  if (actions.has('private_evidence_thread'))
    lines.push('Moderator evidence thread could not be created.');
  if (actions.has('role_quarantine'))
    lines.push('Role quarantine incomplete. Moderator action required.');
  if (actions.has('notification')) lines.push('Notification delivery failed.');
  if (actions.has('persistence'))
    lines.push('Case update failed. Check the case state and bot logs.');
  return lines.join(' ');
}
