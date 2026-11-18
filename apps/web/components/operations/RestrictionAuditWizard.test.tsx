import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { RestrictionAuditWizard, selectableFixIds } from './RestrictionAuditWizard';
import { fixtureRestrictionAudit } from '@/lib/restrictionAuditFixtures';
const audit = fixtureRestrictionAudit();
it('selects every automatic fix, excluding manual findings', () => {
  expect(selectableFixIds(audit)).toEqual(['exception', 'member', 'hardening']);
});
it('renders default choice, closed disclosures, bulk controls and the original brand', () => {
  const html = renderToStaticMarkup(
    createElement(RestrictionAuditWizard, {
      guildId: audit.guildId,
      audit,
      auditRequest: null,
      applyRequest: null,
      onReview: async () => {
        throw new Error('unused');
      },
      onApply: async () => {
        throw new Error('unused');
      },
    })
  );
  expect(html).toContain('Select all');
  expect(html).toContain('Clear all');
  expect(html).toContain('/brand/drasil-tree.png');
  expect(html).toContain('What changes');
  expect(html).not.toContain('<details open');
  expect(html.match(/checked=""/g)).toHaveLength(1);
  expect(html).toContain('1 change selected');
  expect(html).not.toContain('These changes cannot');
});
it('reports loading and failed audits without a false success', () => {
  const html = renderToStaticMarkup(
    createElement(RestrictionAuditWizard, {
      guildId: audit.guildId,
      audit: null,
      auditRequest: { id: 'request', status: 'processing' },
      applyRequest: null,
      onReview: async () => {
        throw new Error('unused');
      },
      onApply: async () => {
        throw new Error('unused');
      },
    })
  );
  expect(html).toContain('Audit in progress');
  expect(html).not.toContain('Verified');
});
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh() {} }) }));
it('renders healthy empty audits without suggesting an apply or claiming content isolation', () => {
  const healthy = { ...audit, fixes: [], setup: { ...audit.setup, status: 'verified' as const } };
  const html = renderToStaticMarkup(
    createElement(RestrictionAuditWizard, {
      guildId: audit.guildId,
      audit: healthy,
      auditRequest: null,
      applyRequest: null,
      onReview: async () => {
        throw new Error('unused');
      },
      onApply: async () => {
        throw new Error('unused');
      },
    })
  );
  expect(html).toContain('No automatic fixes proposed');
  expect(html).toContain('Recovery-parent message content was not inspected');
  expect(html).not.toContain('Apply changes');
});
it('keeps interrupted effects and setup/current-case verification distinct', async () => {
  const { fixtureRestrictionResult } = await import('@/lib/restrictionAuditFixtures');
  const html = renderToStaticMarkup(
    createElement(RestrictionAuditWizard, {
      guildId: audit.guildId,
      audit,
      auditRequest: null,
      applyRequest: {
        id: 'apply',
        status: 'completed',
        restrictionApply: fixtureRestrictionResult(),
      },
      onReview: async () => {
        throw new Error('unused');
      },
      onApply: async () => {
        throw new Error('unused');
      },
    })
  );
  expect(html).toContain('Batch stopped:');
  expect(html).toContain('interrupted');
  expect(html).toContain('unknown');
  expect(html).toContain('Server setup:');
  expect(html).toContain('Current case');
  expect(html).not.toContain('Selected batch finished');
});

it('renders every approved effect from a real stopped execution and preserves MCP/web parity', async () => {
  const {
    executeRestrictionPlan,
    prepareRestrictionPlan,
    restrictionFactsAfter,
    projectHumanOutcome,
  } = await import('@drasil/application');
  const { fixtureRestrictionAuditSnapshot } = await import('@/lib/restrictionAuditFixtures');
  const { parseModerationActionRequestRow } =
    await import('@/lib/moderationActionRequestDataAdapter');
  const snapshot = fixtureRestrictionAuditSnapshot();
  const context = {
    guildId: snapshot.guildId,
    actor: { kind: 'user' as const, userId: 'owner' },
    source: 'test',
    requestId: 'apply',
  };
  let state = snapshot.facts;
  const planDeps = {
    authority: {
      loadFresh: vi.fn().mockResolvedValue({
        guildId: snapshot.guildId,
        userId: 'owner',
        present: true,
        owner: true,
        permissions: '8',
        roleIds: [],
      }),
    },
    auditStore: { load: vi.fn().mockResolvedValue(snapshot) },
    now: () => new Date(snapshot.observedAt),
    readFresh: async () => state,
  };
  const selection = {
    auditRequestId: 'audit',
    auditRevision: snapshot.revision,
    selectedFixIds: ['exception', 'member', 'hardening'],
  };
  const plan = await prepareRestrictionPlan(context, selection, planDeps);
  let writes = 0;
  const result = await executeRestrictionPlan(context, 'apply', {
    ...planDeps,
    attemptToken: 'private',
    executionStore: {
      loadPlan: async () => plan,
      loadProgress: async () => null,
      saveProgress: async () => true,
    },
    write: async (effect) => {
      if (++writes === 2) throw new Error('timeout');
      state = restrictionFactsAfter(state, effect);
    },
    observe: async () => ({
      state: writes === 1 ? 'desired_satisfied' : 'unavailable',
      observedAt: snapshot.observedAt,
      reason: null,
    }),
    audit: async () => snapshot,
  });
  const web = parseModerationActionRequestRow({
    id: 'apply',
    action_type: 'apply_case_role_lockdown',
    actor_surface: 'web',
    status: 'completed',
    requested_at: snapshot.observedAt,
    updated_at: snapshot.observedAt,
    completed_at: snapshot.observedAt,
    failed_at: null,
    last_error: null,
    target_user_id: null,
    result: { restriction_apply: result },
  });
  const mcp = projectHumanOutcome(
    { kind: 'apply_case_role_lockdown', ...selection },
    { restriction_apply: result }
  );
  expect(web.restrictionApply).toEqual(mcp.outcome?.restrictionApply);
  expect(result.progress.receipts.map((r) => r.state)).toEqual([
    'applied',
    'unknown',
    'not_attempted',
  ]);
  const html = renderToStaticMarkup(
    createElement(RestrictionAuditWizard, {
      guildId: snapshot.guildId,
      audit,
      auditRequest: null,
      applyRequest: web,
      onReview: vi.fn(),
      onApply: vi.fn(),
    })
  );
  expect(html).toContain('Selected change 3');
  expect(html).toContain('not attempted');
});
