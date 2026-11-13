import type { CaseSummary, ReportQueueItem } from '@drasil/contracts';
import { describe, expect, it } from 'vitest';
import {
  caseSummaryToInboxItem,
  parseModerationQueueRow,
  reportQueueItemToInboxItem,
  type ModerationQueueRow,
} from './moderationInboxDataAdapter';

const baseCase: CaseSummary = {
  status: 'pending',
  id: 'case-1',
  guildId: 'guild-1',
  userId: 'user-1',
  userIdentity: {
    id: 'user-1',
    username: 'stored-user',
    globalName: null,
    nickname: null,
    displayName: 'Stored User',
    avatarUrl: null,
    displayLabel: 'Stored User',
  },
  createdAt: '2026-06-01T00:00:00.000Z',
  updatedAt: '2026-06-02T00:00:00.000Z',
  stale: true,
  staleHours: 25,
  presenceState: 'in_server',
  confidence: 0.91,
  latestDetectionType: 'gpt_analysis',
  latestDetectionAt: '2026-06-01T00:00:00.000Z',
  lastActionType: null,
  lastActionAt: null,
  surfaces: [
    {
      kind: 'admin_notification',
      label: 'Admin notification',
      url: 'https://discord.com/channels/guild-1/admin-channel-1/admin-message-1',
    },
  ],
  allowedActions: ['view_history', 'verify_user', 'close_no_action', 'refresh_notification'],
};

const baseReport: ReportQueueItem = {
  id: 'report-1',
  guildId: 'guild-1',
  reporterId: 'reporter-1',
  targetUserId: 'user-2',
  status: 'submitted',
  summary: 'Reporter supplied message evidence.',
  summarySource: 'other',
  createdAt: '2026-06-01T00:00:00.000Z',
  updatedAt: '2026-06-02T00:00:00.000Z',
  stale: true,
  staleHours: 26,
  evidenceCount: 2,
  reportThreadUrl: 'https://discord.com/channels/guild-1/report-thread-1',
  latestDetectionId: 'det-1',
  latestCaseId: null,
  allowedActions: [
    'open_report_thread',
    'open_case',
    'mark_actioned',
    'dismiss_no_action',
    'mark_false_positive',
  ],
};

const baseQueueRow: ModerationQueueRow = {
  id: 'queue-1',
  server_id: 'guild-1',
  user_id: 'user-3',
  item_type: 'observed_alert_mirror',
  verification_event_id: null,
  detection_event_id: 'det-observed-1',
  report_intake_id: null,
  source_thread_id: null,
  queue_channel_id: 'queue-channel-1',
  queue_message_id: 'queue-message-1',
  last_source_message_id: null,
  last_notified_at: null,
  created_at: new Date('2026-06-01T00:00:00.000Z'),
  updated_at: new Date('2026-06-02T00:00:00.000Z'),
  metadata: {},
  server_settings: {},
  detection_type: 'suspicious_content',
  detection_confidence: 0.82,
  detection_detected_at: new Date('2026-06-01T00:00:00.000Z'),
  detection_reasons: ['Suspicious link pattern.'],
  detection_metadata: {
    observed_notification_channel_id: 'admin-channel-1',
    observed_notification_message_id: 'observed-message-1',
  },
  case_status: null,
  report_status: null,
  report_summary: null,
  report_metadata: null,
  user_username: 'observed-user',
  user_metadata: {},
};

describe('moderationInboxDataAdapter', () => {
  it('converts active case summaries into inbox case items', () => {
    const item = caseSummaryToInboxItem({
      ...baseCase,
      caseKind: 'compromised_account',
      captchaChallenge: {
        method: 'turnstile',
        methodRevision: 0,
        id: '11111111-1111-4111-8111-111111111111',
        status: 'pending',
        requestSource: 'moderator',
        passEffect: 'evidence_only',
        generation: 1,
        submissionCount: 0,
        expiresAt: '2026-06-04T00:00:00.000Z',
        requestedAt: '2026-06-03T00:00:00.000Z',
        deliveredAt: '2026-06-03T00:01:00.000Z',
        deliveryErrorCode: null,
        passedAt: null,
        bypassedAt: null,
        bypassedBy: null,
        bypassReason: null,
      },
    });

    expect(item).toEqual(
      expect.objectContaining({
        id: 'case:case-1',
        caseKind: 'compromised_account',
        kind: 'case',
        sourceId: 'case-1',
        title: 'Pending moderation case',
        detailHref: '/admin/guild/guild-1/cases/case-1',
        signalLabel: '91% confidence',
        captchaChallenge: expect.objectContaining({ status: 'pending' }),
        allowedActions: ['view_case', 'view_history', 'verify_user', 'refresh_notification'],
      })
    );
  });

  it('converts submitted reports into inbox report items', () => {
    const item = reportQueueItemToInboxItem(baseReport);

    expect(item).toEqual(
      expect.objectContaining({
        id: 'report:report-1',
        kind: 'submitted_report',
        sourceId: 'report-1',
        title: 'Submitted report',
        detailHref: '/admin/guild/guild-1/reports/report-1',
        signalLabel: '2 evidence items',
        allowedActions: [
          'view_report',
          'open_discord',
          'open_case',
          'mark_actioned',
          'dismiss_no_action',
          'mark_false_positive',
        ],
      })
    );
  });

  it('parses observed alert queue rows for the inbox', () => {
    const item = parseModerationQueueRow(baseQueueRow, new Date('2026-06-03T02:00:00.000Z'));

    expect(item).toEqual(
      expect.objectContaining({
        id: 'detection:det-observed-1',
        kind: 'observed_alert',
        sourceId: 'det-observed-1',
        queueItemId: 'queue-1',
        stale: true,
        staleHours: 26,
        statusLabel: 'suspicious_content',
        signalLabel: '82% confidence',
        allowedActions: [
          'open_case',
          'view_history',
          'dismiss_no_action',
          'mark_false_positive',
          'ban_user',
          'open_discord',
        ],
      })
    );
    expect(item?.links).toEqual(
      expect.arrayContaining([
        {
          label: 'Queue message',
          url: 'https://discord.com/channels/guild-1/queue-channel-1/queue-message-1',
        },
        {
          label: 'Observed notification',
          url: 'https://discord.com/channels/guild-1/admin-channel-1/observed-message-1',
        },
      ])
    );
  });

  it('includes observed kick when the server enables observed alert kicks', () => {
    const item = parseModerationQueueRow(
      {
        ...baseQueueRow,
        server_settings: { observed_action_kick_enabled: true },
      },
      new Date('2026-06-03T02:00:00.000Z')
    );

    expect(item?.allowedActions).toEqual([
      'open_case',
      'view_history',
      'dismiss_no_action',
      'mark_false_positive',
      'kick_user',
      'ban_user',
      'open_discord',
    ]);
  });

  it('preserves AI summary provenance for report attention queue rows', () => {
    const item = parseModerationQueueRow(
      {
        ...baseQueueRow,
        item_type: 'report_thread_attention',
        detection_event_id: null,
        report_intake_id: 'report-1',
        report_status: 'collecting_evidence',
        report_summary: 'Possible impersonation attempt',
        report_metadata: { summary_source: 'ai_report_intake_extraction' },
      },
      new Date('2026-06-03T02:00:00.000Z')
    );

    expect(item).toEqual(
      expect.objectContaining({
        kind: 'report_attention',
        summary: 'Possible impersonation attempt',
        summarySource: 'ai',
      })
    );
  });

  it('shows quarantine breach attention as an acknowledgeable urgent inbox item', () => {
    const item = parseModerationQueueRow(
      {
        ...baseQueueRow,
        item_type: 'quarantine_breach_attention',
        verification_event_id: 'case-quarantined-1',
        detection_event_id: null,
        source_thread_id: 'general-channel',
        metadata: {
          latest_message_url:
            'https://discord.com/channels/guild-1/general-channel/breach-message-1',
        },
      },
      new Date('2026-06-03T02:00:00.000Z')
    );

    expect(item).toEqual(
      expect.objectContaining({
        kind: 'support_attention',
        sourceId: 'case-quarantined-1',
        title: 'Quarantine containment breach',
        allowedActions: ['acknowledge', 'open_discord'],
      })
    );
  });
});

it('uses a durable detection ID and preserves the detection event date', () => {
  const item = parseModerationQueueRow(baseQueueRow);
  expect(item?.id).toBe('detection:det-observed-1');
  expect(item?.sourceMetadata?.eventAt).toBe('2026-06-01T00:00:00.000Z');
});

it('labels generated detection summaries without changing original source evidence', () => {
  expect(caseSummaryToInboxItem({ ...baseCase, latestDetectionType: 'gpt_analysis' }).summary).toBe(
    'Latest detection: Content analysis.'
  );
  expect(
    caseSummaryToInboxItem({ ...baseCase, latestDetectionType: 'suspicious_content' }).summary
  ).toBe('Latest detection: Content check.');
});

it('keeps a retired ordinary row reachable for cleanup with its original source link', () => {
  const item = parseModerationQueueRow({
    ...baseQueueRow,
    item_type: 'support_thread_attention',
    attention_cleanup_pending: true,
    source_thread_id: null,
    verification_event_id: null,
    detection_event_id: null,
    metadata: {
      attention_cleanup: {
        source_thread_id: 'original-thread',
        verification_event_id: null,
        detection_event_id: null,
      },
    },
  });
  expect(item).toMatchObject({
    queueItemId: 'queue-1',
    sourceId: 'original-thread',
    sourceMetadata: { sourceThreadId: 'original-thread' },
  });
  expect(item?.allowedActions).toContain('acknowledge');
  expect(item?.links).toContainEqual({
    label: 'Source thread',
    url: 'https://discord.com/channels/guild-1/original-thread',
  });
});

it('renders an unidentified report as admin review', () => {
  const view = parseModerationQueueRow({
    ...baseQueueRow,
    item_type: 'report_thread_attention',
    report_status: 'needs_admin_confirmation',
    report_intake_id: 'report-1',
    report_target_user_id: null,
  })!;
  expect(view.statusLabel).toBe('Needs admin review');
  expect(view.subject.userId).toBeNull();
  expect(view.allowedActions).not.toContain('ban_user');
});

it('retains cleanup retry visibility without treating the retired row as live identity review', () => {
  const view = parseModerationQueueRow({
    ...baseQueueRow,
    item_type: 'report_thread_attention',
    report_status: 'needs_admin_confirmation',
    report_intake_id: 'report-1',
    attention_cleanup_pending: true,
    source_thread_id: null,
    verification_event_id: null,
    detection_event_id: null,
    metadata: {
      attention_cleanup: {
        source_thread_id: 'thread-original',
        verification_event_id: null,
        detection_event_id: null,
      },
    },
  })!;
  expect(view.id).toBe(`queue:${baseQueueRow.id}`);
  expect(view.statusLabel).toBe('Acknowledged, cleanup pending');
  expect(view.links).toContainEqual({
    label: 'Source thread',
    url: 'https://discord.com/channels/guild-1/thread-original',
  });
  expect(view.sourceMetadata).toMatchObject({
    identityReview: false,
    attentionCleanupPending: true,
  });
  expect(view.allowedActions).toContain('acknowledge');
  expect(view.subject.userId).toBeNull();
});
it('retains identity review acknowledgement separately from cleanup retry', () => {
  const view = parseModerationQueueRow({
    ...baseQueueRow,
    item_type: 'report_thread_attention',
    report_status: 'needs_admin_confirmation',
    report_intake_id: 'report-1',
    metadata: { identity_review: {} },
  })!;
  expect(view.allowedActions).toContain('acknowledge');
  expect(view.sourceMetadata).toMatchObject({
    identityReview: true,
    attentionCleanupPending: false,
  });
});

describe('automatic response presentation', () => {
  const response = {
    action: 'kick',
    outcome: 'kicked',
    attention: 'required',
    caseId: null,
    updatedAt: '2026-11-11T00:00:00.000Z',
    failures: [{ step: 'notification', code: 'notification_delivery_failed' }],
  };
  it.each([
    ['kicked', 'Member kicked. Notification delivery failed.'],
    ['failed', 'Automatic kick failed. The member may still have access.'],
    [
      'unknown',
      'Kick outcome could not be confirmed. Check membership before taking further action.',
    ],
    ['pending', 'Kick outcome is pending. Check membership before taking further action.'],
  ])('renders response attention without Discord links (%s)', (outcome, summary) => {
    const item = parseModerationQueueRow({
      ...baseQueueRow,
      queue_channel_id: null,
      queue_message_id: null,
      detection_metadata: {},
      server_settings: { observed_action_kick_enabled: true },
      metadata: { automatic_moderation_response: { ...response, outcome } },
    })!;
    expect(item.title).toBe('Automatic response needs review');
    expect(item.summary).toContain(summary);
    expect(item.links).toEqual([]);
    expect(item.allowedActions).not.toContain('kick_user');
    expect(item.allowedActions).toEqual(['acknowledge', 'dismiss_no_action', 'view_history']);
  });
  it('keeps acknowledged outcome truthful', () => {
    const item = parseModerationQueueRow({
      ...baseQueueRow,
      metadata: { automatic_moderation_response: { ...response, attention: 'acknowledged' } },
    })!;
    expect(item.summary).toContain('Member kicked. Notification delivery failed.');
    expect(item.statusLabel).toBe('Acknowledged, response incomplete');
    expect(item.allowedActions).not.toContain('acknowledge');
  });
  it('does not offer acknowledgement for invalid response metadata', () => {
    const item = parseModerationQueueRow({
      ...baseQueueRow,
      metadata: { automatic_moderation_response: { ...response, outcome: 'invented' } },
    })!;
    expect(item.allowedActions).not.toContain('acknowledge');
  });
});

it('shows case role failure separately from an applied role with thread failure', () => {
  const item = parseModerationQueueRow({
    ...baseQueueRow,
    item_type: 'case_mirror',
    verification_event_id: 'case-1',
    case_role_active: true,
    case_metadata: {
      action_failures: [
        { action: 'thread', message: 'private internal detail', at: '2026-11-11T00:00:00.000Z' },
      ],
    },
  })!;
  expect(item.summary).toContain('Case role applied. Case thread could not be created.');
  expect(item.summary).not.toContain('private internal detail');
});

it.each(['resolved', 'acknowledged'])(
  'does not invite kick replay from a retained %s response row',
  (attention) => {
    const item = parseModerationQueueRow({
      ...baseQueueRow,
      server_settings: { observed_action_kick_enabled: true },
      metadata: {
        automatic_moderation_response: {
          action: 'kick',
          outcome: 'kicked',
          attention,
          caseId: null,
          updatedAt: '2026-11-11T00:00:00.000Z',
          failures: [{ step: 'notification', code: 'notification_delivery_failed' }],
        },
      },
    })!;
    expect(item.allowedActions).not.toContain('kick_user');
    expect(item.allowedActions).not.toContain('acknowledge');
    expect(item.summary).toContain('Member kicked.');
  }
);

it.each(['notify', 'restrict'])(
  'keeps existing observed moderation controls for orphan %s failures',
  (action) => {
    const item = parseModerationQueueRow({
      ...baseQueueRow,
      server_settings: { observed_action_kick_enabled: false },
      metadata: {
        automatic_moderation_response: {
          action,
          outcome: 'failed',
          attention: 'required',
          caseId: null,
          updatedAt: '2026-11-11T00:00:00.000Z',
          failures: [{ step: 'notification', code: 'notification_delivery_failed' }],
        },
      },
    })!;
    expect(item.allowedActions).toEqual(
      expect.arrayContaining([
        'acknowledge',
        'open_case',
        'dismiss_no_action',
        'mark_false_positive',
        'ban_user',
      ])
    );
    expect(item.allowedActions).not.toContain('kick_user');
  }
);

it('omits obsolete queue response after durable source completion even if Discord cleanup failed', () => {
  const response = {
    action: 'kick',
    outcome: 'unknown',
    attention: 'required',
    caseId: null,
    updatedAt: '2026-11-11T00:00:00.000Z',
    failures: [{ step: 'kick', code: 'kick_outcome_unknown' }],
  };
  expect(
    parseModerationQueueRow({
      ...baseQueueRow,
      metadata: { automatic_moderation_response: response },
      detection_metadata: {
        observed_action: 'kick',
        automatic_moderation_response: { ...response, attention: 'resolved' },
      },
    })
  ).toBeNull();
});

it.each(['history_ambiguous', 'history_incomplete'])(
  'surfaces %s recovery attention without a Discord mirror',
  (reason) => {
    const view = parseModerationQueueRow({
      ...baseQueueRow,
      item_type: 'report_thread_attention',
      report_intake_id: 'report-1',
      queue_channel_id: null,
      queue_message_id: null,
      metadata: { reporter_delivery_failure: reason, reporter_delivery_only: true },
    })!;
    expect(view.summary).toContain('Report card recovery blocked:');
    expect(view.summary).toContain('Review the report thread.');
  }
);

it.each(['history_ambiguous', 'history_incomplete'])(
  'keeps the identity-review summary and %s recovery notice',
  (reason) => {
    const view = parseModerationQueueRow({
      ...baseQueueRow,
      item_type: 'report_thread_attention',
      report_intake_id: 'report-1',
      report_summary: 'Review the reported account and attached evidence.',
      metadata: { reporter_delivery_failure: reason },
    })!;
    expect(view.summary).toContain('Review the reported account and attached evidence.');
    expect(view.summary).toContain('Report card recovery blocked:');
    expect(view.summary).toContain('Review the report thread.');
  }
);
