import { describe, expect, it } from 'vitest';
import {
  createRestrictionReviewReference,
  readRestrictionReviewReference,
  restrictionPlanDigest,
} from './restrictionAuditDataAdapter';
import type { ApprovedRestrictionPlan } from '@drasil/application';
const plan: ApprovedRestrictionPlan = {
  auditRequestId: 'audit',
  auditRevision: 'revision',
  selectedFixIds: ['fix'],
  guildId: 'guild',
  actorId: 'actor',
  expiresAt: '2030-01-01T00:00:00.000Z',
  materialStateFingerprint: 'material',
  effects: [
    {
      kind: 'set_role_permissions',
      guildId: 'guild',
      roleId: 'role',
      mask: '8',
      expected: '8',
      desired: '0',
    },
  ],
};
describe('server review reference', () => {
  it('binds actor, guild, selection, expiry and admitted effects without exposing effects', () => {
    const token = createRestrictionReviewReference(plan, 'secret');
    expect(token).not.toContain('effects');
    expect(
      readRestrictionReviewReference(token, 'secret', 'guild', 'actor', new Date('2029-01-01'))
    ).toMatchObject({ selectedFixIds: ['fix'], digest: restrictionPlanDigest(plan) });
    expect(() => readRestrictionReviewReference(token, 'secret', 'foreign', 'actor')).toThrow();
    expect(() => readRestrictionReviewReference(token, 'secret', 'guild', 'other')).toThrow();
    expect(() => readRestrictionReviewReference(token, 'wrong', 'guild', 'actor')).toThrow();
    expect(() =>
      readRestrictionReviewReference(token, 'secret', 'guild', 'actor', new Date('2030-01-01'))
    ).toThrow();
    expect(restrictionPlanDigest({ ...plan, materialStateFingerprint: 'changed' })).not.toBe(
      restrictionPlanDigest(plan)
    );
  });
});
import { beforeEach, vi } from 'vitest';
import { fixtureRestrictionAuditSnapshot } from './restrictionAuditFixtures';
import { createRestrictionAuditDataAdapter } from './restrictionAuditDataAdapter';
const mocks = vi.hoisted(() => ({
  access: vi.fn(),
  queue: vi.fn(),
  fresh: vi.fn(),
  load: vi.fn(),
  request: vi.fn(),
  channels: vi.fn(),
  loadPlan: vi.fn(),
}));
vi.mock('./workspaceAccess', () => ({ loadWorkspaceAccess: mocks.access }));
vi.mock('./session', () => ({
  getCurrentAdminSession: async () => ({ userId: 'actor' }),
  getCurrentDiscordToken: async () => ({ accessToken: 'token' }),
  getOauthEncryptionSecret: () => 'secret',
}));
vi.mock('./moderationQueueOperationActionQueue', () => ({
  queueModerationQueueOperation: mocks.queue,
}));
vi.mock('./moderationActionRequestDataAdapter', () => ({
  createModerationActionRequestDataAdapter: () => ({ getRequest: mocks.request }),
}));
vi.mock('./mcp/adapters/restriction', () => ({
  createWebRestrictionPlanDependencies: () => ({
    authority: {
      loadFresh: async (guildId: string, userId: string) => ({
        guildId,
        userId,
        owner: true,
        permissions: '8',
        present: true,
      }),
    },
    auditStore: { load: mocks.load },
    now: () => new Date(),
    readFresh: mocks.fresh,
  }),
}));
beforeEach(() => {
  vi.clearAllMocks();
  mocks.channels.mockResolvedValue([]);
  mocks.access.mockResolvedValue({ kind: 'ready', actor: { owner: true, permissions: '8' } });
  const audit = fixtureRestrictionAuditSnapshot();
  mocks.load.mockResolvedValue(audit);
  mocks.fresh.mockResolvedValue(audit.facts);
  mocks.queue.mockResolvedValue({ id: 'queued', status: 'queued' });
});
it('admits real server selection, re-admits reviewed effects and queues stable references only', async () => {
  const adapter = createRestrictionAuditDataAdapter();
  const audit = fixtureRestrictionAuditSnapshot();
  const selection = {
    auditRequestId: 'audit',
    auditRevision: audit.revision,
    selectedFixIds: ['exception'],
  };
  const review = await adapter.prepareSelection(audit.guildId, selection);
  await adapter.queueApply(audit.guildId, review.reference);
  await adapter.queueApply(audit.guildId, review.reference);
  expect(mocks.queue.mock.calls[0][0].command).toEqual({
    kind: 'apply_case_role_lockdown',
    ...selection,
  });
  expect(mocks.queue.mock.calls[0][0].context.requestId).toBe(
    mocks.queue.mock.calls[1][0].context.requestId
  );
  expect(mocks.fresh).toHaveBeenCalledTimes(3);
});
it('rejects stale selected facts before queue and rejects effect injection', async () => {
  const adapter = createRestrictionAuditDataAdapter();
  const audit = fixtureRestrictionAuditSnapshot();
  const selection = {
    auditRequestId: 'audit',
    auditRevision: audit.revision,
    selectedFixIds: ['exception'],
  };
  const review = await adapter.prepareSelection(audit.guildId, selection);
  mocks.fresh.mockResolvedValue({ ...audit.facts, quarantineMode: 'on' });
  await expect(adapter.queueApply(audit.guildId, review.reference)).rejects.toThrow('stale_state');
  await expect(
    adapter.prepareSelection(audit.guildId, { ...selection, effects: [] } as never)
  ).rejects.toThrow();
  expect(mocks.queue).not.toHaveBeenCalled();
});
it('denies authority before loading private snapshots or paging diagnostics', async () => {
  mocks.access.mockResolvedValue({ kind: 'access_denied' });
  await expect(createRestrictionAuditDataAdapter().readAudit('guild', 'audit', 50)).rejects.toThrow(
    'Server access required'
  );
  expect(mocks.load).not.toHaveBeenCalled();
});
it('projects later diagnostic pages without losing fixes or disclosing snapshots', async () => {
  const audit = fixtureRestrictionAuditSnapshot();
  mocks.load.mockResolvedValue({
    ...audit,
    setup: {
      ...audit.setup,
      findings: Array.from({ length: 55 }, () => ({
        code: 'metadata_unavailable',
        kind: 'coverage',
        channelId: null,
        userId: null,
        roleIds: [],
      })),
    },
  });
  const result = await createRestrictionAuditDataAdapter().readAudit(audit.guildId, 'audit', 50);
  expect(result.audit?.fixes).toHaveLength(4);
  expect(result.audit?.diagnostics).toHaveLength(5);
  expect(result.audit).not.toHaveProperty('facts');
});

vi.mock('./discordApi', () => ({
  fetchDiscordGuildChannels: mocks.channels,
  fetchDiscordGuildRoles: async () => [],
}));

vi.mock('./setupDataAdapter', () => ({
  getPostgresPool: () => ({ query: async () => ({ rows: [] }) }),
}));
it('uses the original assessed per-category children for authoritative apply descriptions', async () => {
  const { fixtureGroupedCategoryRestrictionAudit } = await import('./restrictionAuditFixtures');
  const audit = fixtureGroupedCategoryRestrictionAudit();
  mocks.load.mockResolvedValue(audit);
  mocks.fresh.mockResolvedValue(audit.facts);
  mocks.channels.mockResolvedValue(
    audit.facts.channels.map((c) => ({
      id: c.id,
      name: c.name,
      type: c.type === 'category' ? 4 : 0,
      parent_id: 'different-current-parent',
    }))
  );
  mocks.request.mockResolvedValue({
    id: 'apply',
    actionType: 'apply_case_role_lockdown',
    status: 'completed',
  });
  mocks.loadPlan.mockResolvedValue({
    ...plan,
    guildId: audit.guildId,
    auditRevision: audit.revision,
    effects: audit.fixes[0].effects,
  });
  const adapter = createRestrictionAuditDataAdapter();
  const review = await adapter.prepareSelection(audit.guildId, {
    auditRequestId: 'audit',
    auditRevision: audit.revision,
    selectedFixIds: ['grouped'],
  });
  expect(review.fixes[0].after).toContain(
    'in #Category A. Applies to role 910000000000000021 holders. Synchronized child channels also affected: #a-child.'
  );
  expect(review.fixes[0].after).toContain(
    'in #Category B. Applies to role 910000000000000021 holders. Synchronized child channels also affected: #b-child.'
  );
  const result = await adapter.readApply(audit.guildId, 'apply');
  const descriptions =
    result && 'restrictionEffectDescriptions' in result ? result.restrictionEffectDescriptions : [];
  expect(descriptions[0]).toContain('also affected: #a-child.');
  expect(descriptions[0]).not.toContain('#b-child');
  expect(descriptions[1]).toContain('also affected: #b-child.');
  expect(descriptions[1]).not.toContain('#a-child');
  expect(result).not.toHaveProperty('facts');
});
vi.mock('@drasil/application/postgres', () => ({
  createRestrictionStores: () => ({ loadPlan: mocks.loadPlan }),
}));
vi.mock('./mcp/adapters/database', () => ({ createWebDelegationDatabase: () => ({}) }));

it('does not claim zero affected children when the original apply snapshot is unavailable', async () => {
  mocks.request.mockResolvedValue({
    id: 'apply',
    actionType: 'apply_case_role_lockdown',
    status: 'completed',
  });
  mocks.loadPlan.mockResolvedValue({
    ...plan,
    effects: [
      {
        kind: 'edit_overwrite',
        guildId: 'guild',
        channelId: 'category',
        roleId: 'role',
        expected: null,
        desired: { allow: '0', deny: '1024' },
      },
    ],
  });
  mocks.channels.mockResolvedValue([{ id: 'category', name: 'Category', type: 4 }]);
  mocks.load.mockResolvedValue(null);
  const result = await createRestrictionAuditDataAdapter().readApply('guild', 'apply');
  const descriptions =
    result && 'restrictionEffectDescriptions' in result ? result.restrictionEffectDescriptions : [];
  expect(descriptions[0]).toContain('assessed child scope unavailable');
  expect(descriptions[0]).not.toContain('none in the assessed scope');
});
