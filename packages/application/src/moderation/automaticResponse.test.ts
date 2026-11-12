import { formatCaseActionFailures, readAutomaticModerationResponse } from './automaticResponse';
import { acknowledgeAutomaticResponseMetadata } from '../operations/attention';
const response = {
  action: 'kick',
  outcome: 'kicked',
  updatedAt: '2026-11-11T00:00:00.000Z',
  failures: [{ step: 'notification', code: 'notification_delivery_failed' }],
  attention: 'required',
  caseId: null,
};
it('reads validated response metadata', () => {
  expect(readAutomaticModerationResponse({ automatic_moderation_response: response })).toEqual(
    response
  );
});
it.each([
  null,
  {},
  { ...response, outcome: 'notified' },
  { ...response, updatedAt: 'bad' },
  { ...response, failures: [{ step: 'notification', code: 'raw exception' }] },
])('rejects malformed external responses', (value) => {
  expect(readAutomaticModerationResponse({ automatic_moderation_response: value })).toBeNull();
});
it('acknowledgement preserves the action outcome', () => {
  const acknowledged = { ...response, attention: 'acknowledged' };
  expect(readAutomaticModerationResponse({ automatic_moderation_response: acknowledged })).toEqual(
    acknowledged
  );
});

it('acknowledges only required unowned attention without changing evidence', () => {
  const metadata = {
    retained: true,
    observed_action: 'kick',
    automatic_moderation_response: response,
  };
  expect(acknowledgeAutomaticResponseMetadata(metadata)).toEqual({
    ...metadata,
    automatic_moderation_response: { ...response, attention: 'acknowledged' },
  });
  expect(
    acknowledgeAutomaticResponseMetadata({
      automatic_moderation_response: { ...response, attention: 'resolved' },
    })
  ).toBeNull();
  expect(
    acknowledgeAutomaticResponseMetadata({
      automatic_moderation_response: { ...response, attention: 'acknowledged' },
    })
  ).toBeNull();
  expect(
    acknowledgeAutomaticResponseMetadata({
      automatic_moderation_response: {
        ...response,
        caseId: '11111111-1111-4111-8111-111111111111',
      },
    })
  ).toBeNull();
});

test('keeps confirmed kick separate from case follow-up failure', () => {
  expect(
    formatCaseActionFailures({
      automatic_moderation_response: {
        action: 'kick',
        outcome: 'kicked',
        attention: 'required',
        caseId: '11111111-1111-4111-8111-111111111111',
        updatedAt: '2026-11-11T00:00:00.000Z',
        failures: [{ step: 'notification', code: 'notification_delivery_failed' }],
      },
      action_failures: [
        { action: 'notification', message: 'private detail', at: '2026-11-11T00:00:00.000Z' },
      ],
    })
  ).toBe('Member kicked. Notification delivery failed.');
});
