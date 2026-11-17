import type { Meta, StoryObj } from '@storybook/react-vite';
import { RestrictionAuditWizard } from './RestrictionAuditWizard';
import { fixtureRestrictionAudit, fixtureRestrictionResult } from '@/lib/restrictionAuditFixtures';
const audit = fixtureRestrictionAudit();
const meta = {
  title: 'Operations/Restriction audit',
  component: RestrictionAuditWizard,
  args: {
    guildId: audit.guildId,
    auditRequest: null,
    audit,
    applyRequest: null,
    onReview: async (selection) => ({
      reference: 'story-only',
      expiresAt: audit.expiresAt,
      fixes: audit.fixes.filter((f) => selection.selectedFixIds.includes(f.id)),
    }),
    onApply: async () => ({ id: 'story-request', status: 'queued' }),
  },
} satisfies Meta<typeof RestrictionAuditWizard>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Choose: Story = {};
export const Review: Story = {
  args: {
    initialReview: { reference: 'story-only', expiresAt: audit.expiresAt, fixes: [audit.fixes[0]] },
  },
};
export const PartialResults: Story = {
  args: {
    applyRequest: {
      id: 'story-request',
      status: 'completed',
      restrictionApply: fixtureRestrictionResult(),
    },
  },
};
