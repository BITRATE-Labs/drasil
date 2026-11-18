import { facts, role } from './restrictionTestData';
import { assessRestrictionFacts } from './restrictionAssessment';
import type {
  RestrictionAudit,
  RestrictionFix,
  RestrictionFacts,
  RestrictionSelection,
} from './restrictionTypes';
import type { RestrictionPlanDependencies } from './restrictionActions';
export interface RestrictionFixture {
  audit: RestrictionAudit;
  state: RestrictionFacts;
  selection: RestrictionSelection;
  deps: RestrictionPlanDependencies & {
    authority: { loadFresh: jest.Mock };
    auditStore: { load: jest.Mock };
    readFresh: jest.Mock;
  };
}
export const context = {
  guildId: 'guild',
  requestId: 'apply',
  source: 'test',
  actor: { kind: 'user' as const, userId: 'owner' },
};
export const fix: RestrictionFix = {
  id: 'repair',
  kind: 'access_repair',
  summary: 'Repair',
  before: 'before',
  after: 'after',
  affectedScope: ['case'],
  affectedCount: 1,
  defaultSelected: true,
  selectable: true,
  effects: [
    {
      kind: 'set_role_permissions',
      guildId: 'guild',
      roleId: 'case',
      mask: '8',
      expected: '8',
      desired: '0',
    },
  ],
};
export function fixture(): RestrictionFixture {
  const state = facts({ roles: [role({ id: 'guild' }), role({ id: 'case', permissions: '8' })] });
  const audit: RestrictionAudit = {
    schemaVersion: 1,
    guildId: 'guild',
    observedAt: state.observedAt,
    completedAt: state.completedAt,
    revision: 'r1',
    expiresAt: '2026-11-17T12:10:00Z',
    setup: assessRestrictionFacts(state).setup,
    cases: [...assessRestrictionFacts(state).cases],
    coverage: [],
    fixes: [fix],
    facts: state,
  };
  return {
    audit,
    state,
    selection: { auditRequestId: 'audit', auditRevision: 'r1', selectedFixIds: ['repair'] },
    deps: {
      authority: {
        loadFresh: jest.fn().mockResolvedValue({
          guildId: 'guild',
          userId: 'owner',
          present: true,
          owner: true,
          permissions: '0',
          roleIds: [],
        }),
      },
      auditStore: { load: jest.fn().mockResolvedValue(audit) },
      now: (): Date => new Date('2026-11-17T12:01:00Z'),
      readFresh: jest.fn().mockResolvedValue(state),
    },
  };
}
