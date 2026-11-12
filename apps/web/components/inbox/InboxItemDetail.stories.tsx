import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { fixtureModerationInboxItems } from '@/lib/inboxFixtures';
import type { WorkspaceItemDetail } from '@/lib/moderationWorkspaceTypes';
import type { ModerationInboxAction } from '@drasil/contracts';
import type { ModerationActionRequestSummary } from '@/lib/moderationActionRequestDataAdapter';
import type { WorkspaceActions } from '@/lib/workspaceActionTypes';
import { InboxItemDetail } from './InboxItemDetail';

function MixedResponse() {
  const original = fixtureModerationInboxItems().find((item) => item.kind === 'observed_alert')!;
  const [queueId, setQueueId] = useState('response-queue');
  const [acknowledged, setAcknowledged] = useState(false);
  const [requests, setRequests] = useState<ModerationActionRequestSummary[]>([]);
  const [tracked, setTracked] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState('');
  const allowedActions: ModerationInboxAction[] = [
    ...(!acknowledged ? ['acknowledge' as const] : []),
    'dismiss_no_action',
    'open_case',
    'view_history',
  ];
  const detail: WorkspaceItemDetail = {
    kind: 'observed_alert',
    automaticResponse: {
      action: 'notify',
      outcome: 'failed',
      attention: acknowledged ? 'acknowledged' : 'required',
      caseId: null,
      updatedAt: '2026-11-11T00:00:00.000Z',
      failures: [{ step: 'notification', code: 'notification_delivery_failed' }],
    },
    item: {
      ...original,
      kind: 'observed_alert',
      title: 'Automatic response needs review',
      summary: 'Moderator notification incomplete.',
      queueItemId: queueId,
      allowedActions,
    },
    policy: {
      allowedActions,
      canQueueCaseActions: true,
      canOpenReportCases: true,
      canManageCleanup: false,
      kickReasonRequired: true,
      banReasonRequired: true,
    },
    detection: {
      id: original.sourceId,
      detectionType: 'suspicious_content',
      confidence: 0.8,
      reasons: [],
      detectedAt: original.createdAt,
      sourceMessageUrl: null,
      observedAction: null,
      observedActionAt: null,
      latestCaseId: null,
      observedActionBy: null,
      sourceChannelId: null,
      sourceMessageId: null,
      accounting: {
        excluded: false,
        scope: null,
        reason: null,
        excludedBy: null,
        excludedAt: null,
      },
    },
    requests,
  };
  const actions: WorkspaceActions = {
    caseAction: async () => ({ kind: 'failed', message: 'Unexpected case action' }),
    reportAction: async () => ({ kind: 'failed', message: 'Unexpected report action' }),
    attentionAction: async ({ queueItemId }, form) => {
      if (form.get('confirmedRecordId') !== queueItemId) throw new Error('Wrong attention binding');
      setSubmitted(`ack:${queueItemId}`);
      setAcknowledged(true);
      return {
        kind: 'attention',
        result: {
          itemId: queueItemId,
          status: 'acknowledged',
          actor: { id: 'staff', surface: 'web' },
        },
      };
    },
    observedAction: async ({ detectionId, action }, form) => {
      if (form.get('confirmedRecordId') !== detectionId) throw new Error('Wrong detection binding');
      setSubmitted(`${action}:${detectionId}`);
      const id = 'response-close-request';
      setRequests([
        {
          id,
          guildId: original.guildId,
          actionType: 'dismiss_observed_detection',
          requestedAction: action,
          actorSurface: 'web',
          targetUserId: original.subject.userId,
          detectionEventId: detectionId,
          verificationEventId: null,
          reportIntakeId: null,
          messageDeletionJobId: null,
          status: 'queued',
          requestedAt: '2026-11-11T00:00:00.000Z',
          updatedAt: '2026-11-11T00:00:00.000Z',
          completedAt: null,
          failedAt: null,
          lastError: null,
          resultSummary: null,
        },
      ]);
      return { kind: 'request', receipt: { id, status: 'queued' } };
    },
  };
  return (
    <>
      <button onClick={() => setQueueId('replacement-queue')}>Replace queue association</button>
      <button
        onClick={() =>
          setRequests((previous) =>
            previous.map((request) => ({
              ...request,
              status: 'completed',
              completedAt: '2026-11-11T00:00:01.000Z',
              updatedAt: '2026-11-11T00:00:01.000Z',
              resultSummary: 'Review alert closed.',
            }))
          )
        }
      >
        Finish queued close
      </button>
      <output data-testid="submitted-target">{submitted}</output>
      <output data-testid="tracked-request">{tracked}</output>
      <InboxItemDetail
        detail={detail}
        loadedAt="2026-11-11T00:00:00.000Z"
        returnHref="/inbox"
        trackedRequestId={tracked}
        onTrackedRequest={setTracked}
        actions={actions}
      />
    </>
  );
}
const meta = {
  title: 'Moderation workspace/Response controls',
  component: MixedResponse,
} satisfies Meta<typeof MixedResponse>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Mixed: Story = {};
