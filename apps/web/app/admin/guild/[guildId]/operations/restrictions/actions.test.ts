import { expect, it, vi } from 'vitest';
const adapter = vi.hoisted(() => ({
  queueAudit: vi.fn(),
  prepareSelection: vi.fn(),
  queueApply: vi.fn(),
  readAudit: vi.fn(),
}));
vi.mock('@/lib/restrictionAuditDataAdapter', () => ({
  createRestrictionAuditDataAdapter: () => adapter,
}));
import { applyRestrictionSelection, reviewRestrictionSelection } from './actions';
it('forwards only the opaque reviewed reference to authenticated apply admission', async () => {
  adapter.queueApply.mockResolvedValue({ id: 'request', status: 'queued' });
  await applyRestrictionSelection('guild', 'opaque-reference');
  expect(adapter.queueApply).toHaveBeenCalledWith('guild', 'opaque-reference');
});
it('forwards selected references without client effect bodies', async () => {
  const selection = { auditRequestId: 'audit', auditRevision: 'revision', selectedFixIds: ['fix'] };
  await reviewRestrictionSelection('guild', selection);
  expect(adapter.prepareSelection).toHaveBeenCalledWith('guild', selection);
});
it('returns an explicit stale review state across the production server-action boundary', async () => {
  adapter.queueApply.mockRejectedValueOnce(new Error('stale_state'));
  await expect(applyRestrictionSelection('guild', 'opaque-reference')).resolves.toEqual({
    error: 'Permissions or settings changed. Run a fresh audit and review again.',
  });
});
