import { VerificationStatus, type VerificationEvent } from '../../repositories/types';

type VerificationEventFixtureOverrides = Partial<
  Pick<
    VerificationEvent,
    | 'id'
    | 'server_id'
    | 'user_id'
    | 'detection_event_id'
    | 'thread_id'
    | 'private_evidence_thread_id'
    | 'notification_channel_id'
    | 'notification_message_id'
    | 'status'
    | 'case_revision'
    | 'created_at'
    | 'updated_at'
    | 'resolved_at'
    | 'resolved_by'
    | 'notes'
    | 'metadata'
  >
>;

export const buildVerificationEvent = (
  overrides: VerificationEventFixtureOverrides = {}
): VerificationEvent => ({
  id: overrides.id ?? 'ver-1',
  server_id: overrides.server_id ?? 'guild-1',
  user_id: overrides.user_id ?? 'user-1',
  detection_event_id: overrides.detection_event_id ?? null,
  thread_id: overrides.thread_id ?? null,
  private_evidence_thread_id: overrides.private_evidence_thread_id ?? null,
  notification_channel_id: overrides.notification_channel_id ?? null,
  notification_message_id: overrides.notification_message_id ?? null,
  status: overrides.status ?? VerificationStatus.PENDING,
  case_revision: overrides.case_revision ?? 0,
  created_at: overrides.created_at ?? new Date(),
  updated_at: overrides.updated_at ?? new Date(),
  resolved_at: overrides.resolved_at ?? null,
  resolved_by: overrides.resolved_by ?? null,
  notes: overrides.notes ?? null,
  metadata: overrides.metadata ?? null,
});
