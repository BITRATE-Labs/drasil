import { z } from 'zod';
import { canonicalDigest } from '@drasil/application';
import type { ReportIntake } from '../repositories/types';

export const reporterPresentationSchema = z.object({
  deliveryAttention: z.boolean().optional(),
  threadMissing: z.boolean().optional(),
  restoreArchive: z.boolean().optional(),
  closedCardView: z.string().optional(),
  attemptViewKey: z.string().optional(),
  openingMessageId: z.string().optional(),
  confirmationMentionReserved: z.boolean().optional(),
  followupMessageId: z.string().optional(),
  nextDueAt: z.string().nullable().default(null),
  pendingSend: z
    .object({
      slot: z.enum(['openingMessageId', 'followupMessageId']),
      revision: z.number().int().nonnegative(),
      afterMessageId: z.string().regex(/^\d+$/).nullable(),
      title: z.string(),
    })
    .optional(),
});
export type ReporterPresentation = z.infer<typeof reporterPresentationSchema>;
export function reportRoot(intake: ReportIntake): Record<string, unknown> {
  const parsed = z.record(z.string(), z.unknown()).safeParse(intake.metadata ?? {});
  return parsed.success ? parsed.data : {};
}
export function readReporterPresentation(intake: ReportIntake): ReporterPresentation | null {
  const value = reportRoot(intake).reporter_presentation;
  const parsed = reporterPresentationSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
export function reporterViewKey(intake: ReportIntake): string {
  const m = reportRoot(intake);
  const a = m.analysis as Record<string, unknown> | undefined;
  return canonicalDigest([
    intake.status,
    intake.closed_at ?? null,
    intake.evidence_revision,
    intake.analysis_revision,
    intake.confirmed_target_user_id ?? null,
    m.submission ?? null,
    m.thread_closed_at ?? null,
    m.observed_action_closed_at ?? null,
    m.observed_action_reopened_at ?? null,
    a?.outcome ?? null,
    (a?.handoff as { state?: string } | undefined)?.state ?? null,
  ]);
}
export function scheduleReporterChange(
  intake: ReportIntake,
  change: Partial<ReportIntake>
): Partial<ReportIntake> {
  const next = { ...intake, ...change };
  const presentation = readReporterPresentation(next);
  if (!presentation || reporterViewKey(intake) === reporterViewKey(next)) return change;
  return {
    ...change,
    metadata: {
      ...reportRoot(next),
      reporter_presentation: {
        ...presentation,
        nextDueAt:
          next.status === 'expired' || presentation.threadMissing ? null : new Date().toISOString(),
      },
    } as ReportIntake['metadata'],
  };
}
