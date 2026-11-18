import { Client } from 'discord.js';
import { ConfigService } from '../../config/ConfigService';
import { InMemoryServerRepository } from '../fakes/inMemoryRepositories';
import { PrismaClient } from '../../db/prisma';
import { DiscordRestrictionAuditReadPort } from '../../services/DiscordRestrictionAuditReadPort';
import { RestrictionAuditService } from '../../services/RestrictionAuditService';
import {
  executeRestrictionPlan,
  prepareRestrictionPlan,
  restrictionMaterialFingerprint,
} from '@drasil/application';
import {
  fixture,
  context,
} from '../../../packages/application/src/operations/restrictionExecutionTestData';

async function freshFixture() {
  const repository = new InMemoryServerRepository();
  const state = fixture();
  const client = {
    guilds: {
      fetch: jest.fn().mockResolvedValue({
        roles: {
          fetch: jest
            .fn()
            .mockResolvedValue(
              new Map(
                state.state.roles.map((r) => [
                  r.id,
                  { ...r, permissions: { bitfield: BigInt(r.permissions) } },
                ])
              )
            ),
        },
        channels: {
          fetch: jest.fn().mockResolvedValue(new Map()),
          fetchActiveThreads: jest.fn().mockResolvedValue({ threads: new Map() }),
          cache: new Map(),
        },
        members: { fetchMe: jest.fn().mockResolvedValue(null) },
      }),
    },
    rest: { get: jest.fn().mockResolvedValue([]) },
  } as unknown as Client;
  const config = new ConfigService(repository, client);
  await config.updateServerConfig('guild', {
    case_role_id: 'case',
    settings: { manual_intake_role_id: '123456789012345678', manual_intake_enabled: false },
  });
  const port = new DiscordRestrictionAuditReadPort(client, config, {
    verification_events: { findMany: jest.fn().mockResolvedValue([]) },
  } as unknown as PrismaClient);
  const service = new RestrictionAuditService(port);
  state.audit.facts = await port.readBase('guild');
  state.deps.readFresh.mockImplementation(async () => (await service.auditGuild('guild')).facts);
  const plan = await prepareRestrictionPlan(context, state.selection, state.deps);
  const write = jest.fn();
  const deps = {
    ...state.deps,
    attemptToken: 'private',
    executionStore: {
      loadPlan: async () => plan,
      loadProgress: async () => null,
      saveProgress: async () => true,
    },
    write,
    observe: jest.fn(),
    audit: (guildId: string) => service.auditGuild(guildId),
  };
  return { repository, config, port, plan, deps, write };
}
const databaseUrl = process.env.DATABASE_URL;
beforeEach(() => {
  process.env.DATABASE_URL = 'in-memory';
});
afterEach(() => {
  if (databaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = databaseUrl;
  jest.restoreAllMocks();
});
test.each(['change', 'read failure'])(
  'selected execution refuses warm cached config after %s',
  async (mode) => {
    const f = await freshFixture();
    await f.config.getServerConfig('guild');
    if (mode === 'change') await f.repository.upsertByGuildId('guild', { case_role_id: 'changed' });
    else {
      jest.spyOn(console, 'error').mockImplementation(() => undefined);
      jest
        .spyOn(f.repository, 'findByGuildId')
        .mockRejectedValue(new Error('database unavailable'));
    }
    const result = await executeRestrictionPlan(context, 'apply', f.deps);
    expect(result.stopReason).toBe('stale_state');
    expect(result.progress.receipts.map((r) => r.state)).toEqual(['not_attempted']);
    expect(f.write).not.toHaveBeenCalled();
    if (mode === 'read failure') expect(result.verification.setup.status).toBe('unverified');
    if (mode === 'read failure')
      expect(result.verification.setup.findingCodes).toContain('metadata_unavailable');
  }
);
test('manual intake enablement changes effective policy and approval fingerprint while preserving configured ID', async () => {
  const f = await freshFixture();
  const disabled = await f.port.readBase('guild');
  await f.repository.upsertByGuildId('guild', {
    settings: { manual_intake_role_id: '123456789012345678', manual_intake_enabled: true },
  });
  const enabled = await f.port.readBase('guild');
  expect(disabled.manualIntakeRoleId).toBeNull();
  expect(enabled.manualIntakeRoleId).toBe('123456789012345678');
  expect(restrictionMaterialFingerprint(enabled, f.plan.effects)).not.toBe(
    restrictionMaterialFingerprint(disabled, f.plan.effects)
  );
});
