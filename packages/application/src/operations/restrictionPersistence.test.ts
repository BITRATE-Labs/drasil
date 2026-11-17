import { createRestrictionStores } from '../postgres/restriction';
import type { DelegationDatabase } from '../postgres/delegation';
const database = (): DelegationDatabase => ({ query: jest.fn(), transaction: jest.fn() });
test('malformed versions and wrong stored plan bindings fail closed', async () => {
  const db = database();
  const store = createRestrictionStores(db);
  jest.mocked(db.query).mockResolvedValue({ rows: [{ value: { schemaVersion: 2 } }] });
  expect(await store.load('id', 'guild')).toBeNull();
  expect(await store.loadProgress('id')).toBeNull();
  jest
    .mocked(db.query)
    .mockResolvedValue({
      rows: [
        {
          server_id: 'other',
          actor_id: 'actor',
          value: {
            auditRequestId: 'audit',
            auditRevision: 'revision',
            selectedFixIds: ['fix'],
            actorId: 'actor',
            guildId: 'guild',
            effects: [],
            materialStateFingerprint: 'hash',
            expiresAt: new Date().toISOString(),
          },
        },
      ],
    });
  expect(await store.loadPlan('id')).toBeNull();
});
test('invalid revision never issues a write', async () => {
  const db = database();
  expect(
    await createRestrictionStores(db).saveProgress('id', 'token', 3, {
      schemaVersion: 1,
      revision: 3,
      currentEffectIndex: 0,
      receipts: [],
    })
  ).toBe(false);
  expect(db.query).not.toHaveBeenCalled();
});
