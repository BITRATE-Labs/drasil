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
