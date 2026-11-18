import { facts, role } from '../../../packages/application/src/operations/restrictionTestData';
import { assessRestrictionFacts } from '@drasil/application';
import { beforeEach, expect, test, vi } from 'vitest';
import { queueModerationQueueOperation } from './moderationQueueOperationActionQueue';
import { type QueuedOperationCommand, decodeQueuedAction } from '@drasil/application';
vi.mock('./mcp/adapters/restriction', () => ({
  createWebRestrictionPlanDependencies: () => mocks.restriction(),
}));
vi.mock('./e2eFixtures', () => ({ isWebE2eFixtureMode: () => false }));
const mocks = vi.hoisted(() => ({
  query: vi.fn().mockResolvedValue({ rows: [{ id: 'request', status: 'queued' }] }),
  restriction: vi.fn(),
}));
vi.mock('./setupDataAdapter', () => ({ getPostgresPool: () => ({ query: mocks.query }) }));
const queue = mocks.query;
const context = {
  guildId: 'guild',
  requestId: 'submission-1',
  source: 'web',
  actor: { kind: 'user' as const, userId: 'admin' },
};
const commands = [
  { kind: 'sync_moderation_queue' },
  { kind: 'clear_moderation_queue' },
  {
    kind: 'close_resolved_case_threads',
    intent: 'administrator_operation',
    execute: false,
    days: 42,
    limit: 51,
    userId: null,
  },
  { kind: 'audit_case_role_lockdown' },
  { kind: 'intake_role_members', execute: true, limit: 12, roleId: 'role', reason: 'reason' },
] satisfies QueuedOperationCommand[];
beforeEach(() => vi.clearAllMocks());
test.each(commands)(
  'queues shared typed operation $kind preserving metadata and idempotency',
  async (command) => {
    expect(await queueModerationQueueOperation({ context, command })).toMatchObject({
      id: 'request',
      status: 'queued',
    });
    const values = queue.mock.calls[0][1];
    expect(values[9]).toMatch(new RegExp(`^web:operation:${command.kind}:guild:`));
    expect(values[2]).toBe('admin');
    expect(values[3]).toBe('web');
    expect(values[4]).toBeNull();
    expect(
      decodeQueuedAction({
        id: 'request',
        server_id: values[0],
        action_type: values[1],
        actor_id: values[2],
        actor_surface: values[3],
        target_user_id: values[4],
        metadata: JSON.parse(values[10]),
      }).command
    ).toEqual(command);
  }
);
test('rejects injected actor context at typed submission boundary', async () => {
  await expect(
    queueModerationQueueOperation({
      context,
      command: { kind: 'sync_moderation_queue', actor: 'forged' } as never,
    })
  ).rejects.toThrow();
  expect(queue).not.toHaveBeenCalled();
});

test('old boolean apply cannot enqueue effects', async () => {
  await expect(
    queueModerationQueueOperation({
      context,
      command: { kind: 'apply_case_role_lockdown', unsyncAllowedChannels: true } as never,
    })
  ).rejects.toThrow();
  expect(queue).not.toHaveBeenCalled();
});

test('native selected apply admits server-owned effects and cannot accept client metadata', async () => {
  const state = facts({ roles: [role({ id: 'guild' }), role({ id: 'case', permissions: '8' })] });
  const assessment = assessRestrictionFacts(state);
  const fix = {
    id: 'repair',
    kind: 'access_repair' as const,
    summary: 'Repair permissions',
    before: '8',
    after: '0',
    affectedScope: ['case'],
    affectedCount: 1,
    defaultSelected: true,
    selectable: true,
    effects: [
      {
        kind: 'set_role_permissions' as const,
        guildId: 'guild',
        roleId: 'case',
        mask: '8',
        expected: '8',
        desired: '0',
      },
    ],
  };
  const audit = {
    schemaVersion: 1 as const,
    guildId: 'guild',
    observedAt: state.observedAt,
    completedAt: state.completedAt,
    revision: 'r1',
    expiresAt: '2026-11-17T12:10:00Z',
    setup: assessment.setup,
    cases: [...assessment.cases],
    coverage: [],
    fixes: [fix],
    facts: state,
  };
  mocks.restriction.mockReturnValue({
    authority: {
      loadFresh: async () => ({
        guildId: 'guild',
        userId: 'admin',
        present: true,
        owner: true,
        permissions: '8',
        roleIds: [],
      }),
    },
    auditStore: { load: async () => audit },
    now: () => new Date('2026-11-17T12:01:00Z'),
    readFresh: async () => state,
  });
  const command = {
    kind: 'apply_case_role_lockdown' as const,
    auditRequestId: 'audit',
    auditRevision: 'r1',
    selectedFixIds: ['repair'],
  };
  await queueModerationQueueOperation({ context, command });
  expect(JSON.parse(queue.mock.calls[0][1][10])).toMatchObject({
    restriction_schema_version: 1,
    restriction_plan: { actorId: 'admin', guildId: 'guild', effects: fix.effects },
  });
  queue.mockClear();
  await expect(
    queueModerationQueueOperation({
      context,
      command: { ...command, restriction_plan: {} } as never,
    })
  ).rejects.toThrow();
  expect(queue).not.toHaveBeenCalled();
});
