import { executeRestrictionPlan } from './restrictionExecution';
import { prepareRestrictionPlan } from './restrictionActions';
import { context, fixture } from './restrictionExecutionTestData';
import type { RestrictionProgress, ApprovedRestrictionPlan } from './restrictionTypes';
import type { RestrictionExecutionStore } from './restrictionPersistence';
import type { RestrictionFixture } from './restrictionExecutionTestData';
interface ExecutionFixture extends RestrictionFixture {
  plan: ApprovedRestrictionPlan;
  deps: RestrictionFixture['deps'] & {
    attemptToken: string;
    executionStore: jest.Mocked<RestrictionExecutionStore>;
    write: jest.Mock;
    observe: jest.Mock;
    audit: jest.Mock;
  };
}
async function execution(): Promise<ExecutionFixture> {
  const f = fixture();
  const plan = await prepareRestrictionPlan(context, f.selection, f.deps);
  let progress: RestrictionProgress | null = null;
  const deps = {
    ...f.deps,
    attemptToken: 'private',
    executionStore: {
      loadPlan: jest.fn().mockResolvedValue(plan),
      loadProgress: jest.fn<Promise<RestrictionProgress | null>, [string]>(async () => progress),
      saveProgress: jest.fn(
        async (_id: string, _token: string, revision: number, next: RestrictionProgress) => {
          if ((progress?.revision ?? 0) !== revision) return false;
          progress = next;
          return true;
        }
      ),
    },
    write: jest.fn(async () => {
      f.state.roles[1].permissions = '0';
    }),
    observe: jest.fn().mockResolvedValue({
      state: 'desired_satisfied',
      observedAt: '2026-11-17T12:01:01Z',
      reason: null,
    }),
    audit: jest.fn().mockResolvedValue(f.audit),
  };
  return { ...f, deps, plan };
}
test('fresh actor binding and authority guard effects', async () => {
  const f = await execution();
  const result = await executeRestrictionPlan(
    { ...context, actor: { kind: 'user', userId: 'other' } },
    'apply',
    f.deps
  );
  expect(result.stopReason).toBe('authority_lost');
  expect(f.deps.write).not.toHaveBeenCalled();
});
test('material drift stops before writes', async () => {
  const f = await execution();
  f.state.roles[1].permissions = '16';
  const result = await executeRestrictionPlan(context, 'apply', f.deps);
  expect(result.stopReason).toBe('stale_state');
  expect(f.deps.write).not.toHaveBeenCalled();
});
test('started is saved before write and observed afterward', async () => {
  const f = await execution();
  const result = await executeRestrictionPlan(context, 'apply', f.deps);
  expect(result.stopReason).toBe('completed');
  expect(result.progress.receipts[0].state).toBe('applied');
  expect(f.deps.executionStore.saveProgress.mock.invocationCallOrder[0]).toBeLessThan(
    f.deps.write.mock.invocationCallOrder[0]
  );
});
test('interrupted effects reconcile read-only and stop', async () => {
  const f = await execution();
  f.deps.executionStore.saveProgress.mockResolvedValue(true);
  f.deps.executionStore.loadProgress.mockResolvedValue({
    schemaVersion: 1,
    revision: 1,
    currentEffectIndex: 0,
    receipts: [{ effectIndex: 0, state: 'started', observation: null, error: null }],
  });
  const result = await executeRestrictionPlan(context, 'apply', f.deps);
  expect(result.stopReason).toBe('interrupted');
  expect(f.deps.observe).toHaveBeenCalled();
  expect(f.deps.write).not.toHaveBeenCalled();
});
test('uncertain transport remains unknown when before-state is observed', async () => {
  const f = await execution();
  f.deps.write.mockRejectedValue(new Error('timeout'));
  f.deps.observe.mockResolvedValue({
    state: 'before_observed',
    observedAt: '2026-11-17T12:01:01Z',
    reason: null,
  });
  expect((await executeRestrictionPlan(context, 'apply', f.deps)).stopReason).toBe(
    'unknown_outcome'
  );
});
test('lost fence stops before Discord', async () => {
  const f = await execution();
  f.deps.executionStore.saveProgress.mockResolvedValue(false);
  expect((await executeRestrictionPlan(context, 'apply', f.deps)).stopReason).toBe('fence_lost');
  expect(f.deps.write).not.toHaveBeenCalled();
});

test('revoked authority stops before writes', async () => {
  const f = await execution();
  f.deps.authority.loadFresh.mockResolvedValue({
    guildId: 'guild',
    userId: 'owner',
    present: true,
    owner: false,
    permissions: '0',
    roleIds: [],
  });
  expect((await executeRestrictionPlan(context, 'apply', f.deps)).stopReason).toBe(
    'authority_lost'
  );
  expect(f.deps.write).not.toHaveBeenCalled();
});
test('second effect failure leaves first applied and third untouched', async () => {
  const f = await execution();
  const effects = [1, 2, 3].map((i) => ({
    kind: 'set_role_permissions' as const,
    guildId: 'guild',
    roleId: 'role' + i,
    mask: '8',
    expected: '8',
    desired: '0',
  }));
  f.state.roles = effects.map((e) => ({
    id: e.roleId,
    name: e.roleId,
    permissions: '8',
    position: 1,
    managed: false,
    botManaged: false,
  }));
  f.audit.fixes[0] = { ...f.audit.fixes[0], effects };
  const plan = await prepareRestrictionPlan(context, f.selection, f.deps);
  f.deps.executionStore.loadPlan.mockResolvedValue(plan);
  f.deps.write
    .mockImplementation(async () => {})
    .mockImplementationOnce(async () => {
      f.state.roles[0].permissions = '0';
    })
    .mockRejectedValueOnce(new Error('timeout'));
  f.deps.observe
    .mockResolvedValueOnce({
      state: 'desired_satisfied',
      observedAt: '2026-11-17T12:01:01Z',
      reason: null,
    })
    .mockResolvedValueOnce({
      state: 'unavailable',
      observedAt: '2026-11-17T12:01:01Z',
      reason: null,
    });
  const result = await executeRestrictionPlan(context, 'apply', f.deps);
  expect(result.stopReason).toBe('unknown_outcome');
  expect(result.progress.receipts.map((r) => r.state)).toEqual([
    'applied',
    'unknown',
    'not_attempted',
  ]);
  expect(f.deps.write).toHaveBeenCalledTimes(2);
});

test('completed writes retain independent fresh permission assessments', async () => {
  const f = await execution();
  const result = await executeRestrictionPlan(context, 'apply', f.deps);
  expect(result.stopReason).toBe('completed');
  expect(result.verification.setup.status).toBe('incomplete');
  expect(result.verification.cases).toEqual(f.audit.cases);
});

test('transport failure stops even when desired state is observed', async () => {
  const f = await execution();
  f.deps.write.mockRejectedValue(new Error('timeout'));
  const result = await executeRestrictionPlan(context, 'apply', f.deps);
  expect(result.stopReason).toBe('unknown_outcome');
  expect(result.progress.receipts[0]).toMatchObject({ state: 'applied', error: 'write_error' });
});

test('all accepted effects are reported when authority is lost before the first write', async () => {
  const f = await execution();
  const result = await executeRestrictionPlan(
    { ...context, actor: { kind: 'user', userId: 'other' } },
    'apply',
    f.deps
  );
  expect(result.progress.receipts).toEqual([
    { effectIndex: 0, state: 'not_attempted', observation: null, error: null },
  ]);
});
test('only not-attempted receipts do not imply mutation, but explicit takeover never replays', async () => {
  const f = await execution();
  const progress: RestrictionProgress = {
    schemaVersion: 1,
    revision: 0,
    currentEffectIndex: 0,
    receipts: [{ effectIndex: 0, state: 'not_attempted', observation: null, error: null }],
  };
  f.deps.executionStore.loadProgress.mockResolvedValue(progress);
  expect(
    (await executeRestrictionPlan(context, 'apply', { ...f.deps, reconcileOnly: true })).stopReason
  ).toBe('interrupted');
  expect(f.deps.write).not.toHaveBeenCalled();
  expect((await executeRestrictionPlan(context, 'apply', f.deps)).stopReason).toBe('completed');
});
