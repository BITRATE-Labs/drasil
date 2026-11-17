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
