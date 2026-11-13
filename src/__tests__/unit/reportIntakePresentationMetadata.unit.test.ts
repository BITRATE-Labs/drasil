import { ReportIntakeStatus, type ReportIntake } from '../../repositories/types';
import {
  readReporterPresentation,
  reporterViewKey,
  scheduleReporterChange,
} from '../../utils/reportIntakePresentationMetadata';
import { InMemoryReportIntakeRepository } from '../fakes/inMemoryRepositories';

async function fixture(metadata: ReportIntake['metadata']): Promise<ReportIntake> {
  const intake = await new InMemoryReportIntakeRepository().create({
    serverId: 'guild',
    reporterId: 'reporter',
  });
  return { ...intake, metadata };
}

it('keeps the view key stable when nested JSON object keys are reordered', async () => {
  const intake = await fixture({
    reporter_presentation: { nextDueAt: null },
    analysis: {
      outcome: { kind: 'admin_review', coverage: { kind: 'unavailable', reason: 'transport' } },
      handoff: { state: 'delivered' },
    },
  });
  const metadata = {
    analysis: {
      handoff: { state: 'delivered' },
      outcome: { coverage: { reason: 'transport', kind: 'unavailable' }, kind: 'admin_review' },
    },
    reporter_presentation: { nextDueAt: null },
  };
  expect(reporterViewKey({ ...intake, metadata })).toBe(reporterViewKey(intake));
  expect(reporterViewKey(intake)).toMatch(/^v1:sha256:[0-9a-f]{64}$/);
  const change = { metadata };
  expect(scheduleReporterChange(intake, change)).toBe(change);
});

it('changes the view key when evidence array order changes', async () => {
  const intake = await fixture({
    analysis: { outcome: { includedEvidenceIds: ['first', 'second'] } },
  });
  expect(
    reporterViewKey({
      ...intake,
      metadata: { analysis: { outcome: { includedEvidenceIds: ['second', 'first'] } } },
    })
  ).not.toBe(reporterViewKey(intake));
});

it('normalizes absent top-level view fields to null', async () => {
  const intake = await fixture({});
  expect(
    reporterViewKey({
      ...intake,
      metadata: {
        submission: null,
        thread_closed_at: null,
        analysis: { outcome: null, handoff: { state: null } },
      },
    })
  ).toBe(reporterViewKey(intake));
});

it.each([null, 'invalid', ['invalid']])(
  'handles malformed metadata root %j without throwing',
  async (metadata) => {
    const intake = await fixture(metadata);
    expect(readReporterPresentation(intake)).toBeNull();
    expect(reporterViewKey(intake)).toBe(reporterViewKey({ ...intake, metadata: {} }));
  }
);

it('preserves malformed reporter obligations when scheduling a changed status', async () => {
  const metadata = {
    reporter_presentation: { pendingSend: { title: 'reserved' }, nextDueAt: 123 },
    analysis: { outcome: ['invalid'] },
  };
  const intake = await fixture(metadata);
  expect(readReporterPresentation(intake)).toBeNull();
  const change = { status: ReportIntakeStatus.SUBMITTED, metadata };
  expect(scheduleReporterChange(intake, change)).toBe(change);
  expect(reporterViewKey(intake)).toMatch(/^v1:sha256:[0-9a-f]{64}$/);
});

it.each(['observed_action_closed_at', 'observed_action_reopened_at'])(
  'invalidates the view and schedules presentation when %s changes',
  async (key) => {
    const intake = await fixture({ reporter_presentation: { nextDueAt: null } });
    intake.status = ReportIntakeStatus.ACTIONED;
    intake.closed_at = new Date();
    const metadata = { ...(intake.metadata as object), [key]: new Date().toISOString() };
    expect(reporterViewKey({ ...intake, metadata })).not.toBe(reporterViewKey(intake));
    expect(scheduleReporterChange(intake, { metadata }).metadata).toMatchObject({
      reporter_presentation: { nextDueAt: expect.any(String) },
    });
  }
);
