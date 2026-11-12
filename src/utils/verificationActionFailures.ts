export const VERIFICATION_ACTION_FAILURES_METADATA_KEY = 'action_failures';

export type VerificationActionFailureKind =
  | 'persistence'
  | 'notification'
  | 'case_role'
  | 'restrict'
  | 'thread'
  | 'private_evidence_thread'
  | 'role_quarantine';

export interface VerificationActionFailure {
  action: VerificationActionFailureKind;
  message: string;
  at: string;
}

export function getVerificationActionFailureCode(
  action: VerificationActionFailureKind,
  error?: unknown
): string {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  if (action === 'thread') {
    switch (code) {
      case 'membership_screening_pending':
      case 'parent_channel_access_denied':
      case 'parent_channel_access_pending':
      case 'parent_channel_access_unverified':
        return code;
    }
  }
  if (action === 'persistence') return 'persistence_failed';
  if (action === 'notification') return 'notification_delivery_failed';
  if (code === 50013 || code === '50013' || code === 'missing_permissions')
    return 'missing_permissions';
  if (code === 50001 || code === '50001' || code === 'missing_access') return 'missing_access';
  return action === 'case_role' || action === 'restrict' || action === 'role_quarantine'
    ? 'role_assignment_failed'
    : 'thread_creation_failed';
}

function metadataToRecord(metadata: unknown): Record<string, unknown> {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return {};
  }

  return { ...(metadata as Record<string, unknown>) };
}

function isVerificationActionFailureKind(value: unknown): value is VerificationActionFailureKind {
  return (
    value === 'persistence' ||
    value === 'notification' ||
    value === 'case_role' ||
    value === 'restrict' ||
    value === 'thread' ||
    value === 'private_evidence_thread' ||
    value === 'role_quarantine'
  );
}

function isVerificationActionFailure(value: unknown): value is VerificationActionFailure {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    isVerificationActionFailureKind(candidate.action) &&
    typeof candidate.message === 'string' &&
    typeof candidate.at === 'string'
  );
}

export function getVerificationActionFailures(metadata: unknown): VerificationActionFailure[] {
  const record = metadataToRecord(metadata);
  const failures = record[VERIFICATION_ACTION_FAILURES_METADATA_KEY];

  if (!Array.isArray(failures)) {
    return [];
  }

  return failures.filter(isVerificationActionFailure);
}

export function appendVerificationActionFailure(
  metadata: unknown,
  failure: VerificationActionFailure,
  maxFailures = 5
): Record<string, unknown> {
  const record = metadataToRecord(metadata);
  const failures = [...getVerificationActionFailures(metadata), failure].slice(-maxFailures);

  return {
    ...record,
    [VERIFICATION_ACTION_FAILURES_METADATA_KEY]: failures,
  };
}

export function clearVerificationActionFailures(
  metadata: unknown,
  actions: readonly VerificationActionFailureKind[]
): Record<string, unknown> {
  const record = metadataToRecord(metadata);
  const actionsToClear = new Set(actions);
  const failures = getVerificationActionFailures(metadata).filter(
    (failure) => !actionsToClear.has(failure.action)
  );

  if (failures.length === 0) {
    delete record[VERIFICATION_ACTION_FAILURES_METADATA_KEY];
    return record;
  }

  return {
    ...record,
    [VERIFICATION_ACTION_FAILURES_METADATA_KEY]: failures,
  };
}
