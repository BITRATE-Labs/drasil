import { randomUUID } from 'crypto';
import { fixture as restrictionFixture } from '../../../packages/application/src/operations/restrictionExecutionTestData';
import { Pool } from 'pg';
import { type Client } from 'discord.js';
import { mockDeep } from 'jest-mock-extended';
import {
  createDelegatedAccess,
  createDelegatedActionService,
  createSetupIntentResolver,
  parseSetupStoredRecord,
  shippedResetChanges,
  type DelegatedScope,
  decodeQueuedAction,
} from '@drasil/application';
import { createDelegationStore, createRestrictionStores } from '@drasil/application/postgres';
import { createWebDelegationDatabase } from '../../../apps/web/lib/mcp/adapters/database';
import {
  createBotDelegationDatabase,
  createDelegatedWorkerAdmission,
} from '../../application/adapters/delegation';
import {
  createBotOperationsRuntime,
  type BotOperationsDependencies,
} from '../../application/adapters/operations';
import { createCaseConfirmationStore } from '../../application/context';
import { ModerationActionRequestRepository } from '../../repositories/ModerationActionRequestRepository';
import { ModerationActionRequestService } from '../../services/ModerationActionRequestService';
import { getPrismaClient } from '../testDb';

jest.mock('../../../apps/web/lib/setupDataAdapter', () => ({ getPostgresPool: jest.fn() }));
const integration = process.env.JEST_INTEGRATION === '1' ? describe : describe.skip;
const invocation = {
  workflowId: 'apply_case_role_lockdown' as const,
  guildId: 'guild',
  idempotencyKey: 'apply',
  input: { unsyncAllowedChannels: false },
};
integration.each(['pg', 'prisma'] as const)('MCP lockdown configuration via %s', (driver) => {
  let pool: Pool;
  const previousEnabled = process.env.DRASIL_MCP_ENABLED;
  beforeEach(() => {
    process.env.DRASIL_MCP_ENABLED = 'true';
  });
  beforeAll(() => {
    pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  });
  afterAll(async () => {
    await pool.end();
    if (previousEnabled === undefined) delete process.env.DRASIL_MCP_ENABLED;
    else process.env.DRASIL_MCP_ENABLED = previousEnabled;
  });

  async function fixture(
    scopes: readonly DelegatedScope[],
    enabled: false | undefined,
    selectedPlan = false
  ) {
    await pool.query('insert into servers(guild_id,case_role_id,settings) values($1,$2,$3)', [
      'guild',
      'case-role',
      JSON.stringify(enabled === undefined ? {} : { case_role_lockdown_enabled: enabled }),
    ]);
    const database =
      driver === 'pg'
        ? createWebDelegationDatabase(pool)
        : createBotDelegationDatabase(getPrismaClient());
    const store = createDelegationStore(database);
    const grant = await store.createConnection({
      userId: 'actor',
      clientId: 'client',
      selection: { mode: 'selected', guildIds: ['guild'] },
      scopes,
    });
    const principal = {
      userId: grant.userId,
      clientId: grant.clientId,
      connectionId: grant.connectionId,
      grantVersion: grant.version,
      scopes: grant.scopes,
    };
    // Current administrator authority is independent of the delegated scope ceiling.
    const authority = {
      loadFresh: async () => ({
        guildId: 'guild',
        userId: 'actor',
        present: true,
        owner: false,
        permissions: '8',
        roleIds: [],
      }),
    };
    const access = createDelegatedAccess({
      store,
      authority,
      staffRoles: { loadRoleIds: async () => [] },
      guilds: {
        isActive: async () => true,
        listActive: async () => ({ guildIds: ['guild'], nextCursor: null }),
      },
    });
    const selected = restrictionFixture();
    selected.audit.expiresAt = new Date(Date.now() + 600000).toISOString();
    const auditId = randomUUID();
    if (selectedPlan)
      await pool.query(
        "insert into moderation_action_requests(id,server_id,action_type,actor_id,actor_surface,status,idempotency_key,metadata,result) values($1::uuid,'guild','audit_case_role_lockdown','actor','web','completed',$1::text,$2::jsonb,$3::jsonb)",
        [
          auditId,
          JSON.stringify({ restriction_schema_version: 1 }),
          JSON.stringify({ restriction_audit: selected.audit }),
        ]
      );
    const resolver = createSetupIntentResolver({
      restriction: {
        authority,
        auditStore: createRestrictionStores(database),
        now: () => new Date(),
        readFresh: async () => selected.state,
      },
      loadServer: async () =>
        parseSetupStoredRecord(
          (await pool.query("select * from servers where guild_id='guild'")).rows[0]
        ),
      loadGuildResources: async () => ({ roles: [], channels: [] }),
      authority,
      provider: { isConfigured: () => false },
      loadHeuristicDefaults: async (scope) => shippedResetChanges(scope),
    });
    const resolve = jest.spyOn(resolver, 'resolve');
    const service = createDelegatedActionService({
      store,
      access,
      restrictionAudits: createRestrictionStores(database),
      resolver,
      direct: { execute: jest.fn() },
    });
    const confirmations = createCaseConfirmationStore();
    const repository = new ModerationActionRequestRepository(getPrismaClient());
    const setPermissions = jest.fn(async (bits: bigint) => {
      selected.state.roles.find((r) => r.id === 'case')!.permissions = String(bits);
      return {} as never;
    });
    const client = mockDeep<Client>();
    client.guilds.fetch.mockResolvedValue({
      roles: {
        fetch: async () => ({
          permissions: {
            bitfield: BigInt(selected.state.roles.find((r) => r.id === 'case')!.permissions),
          },
          setPermissions,
        }),
      },
    } as never);
    const operationsRuntime = createBotOperationsRuntime(
      {
        ...mockDeep<BotOperationsDependencies>(),
        client,
        configService: { getServerConfig: async () => ({ settings: {} }) } as never,
        prisma: getPrismaClient(),
        restrictionAuditService: {
          auditGuild: async () => ({ ...selected.audit, facts: selected.state }),
        },
        roleQuarantineService: mockDeep(),
        verificationEventRepository: mockDeep(),
        confirmations: confirmations.confirmations,
      },
      authority
    );
    const worker = new ModerationActionRequestService(
      repository,
      {
        delegation: createDelegatedWorkerAdmission({ store, access }),
        operationsRuntime,
        caseConfirmations: confirmations,
      } as never,
      mockDeep()
    );
    const selectedInvocation = {
      ...invocation,
      input: { ...selected.selection, auditRequestId: auditId },
    };
    async function accept() {
      const intent = await service.submit(principal, selectedInvocation);
      expect(intent.state).toBe('confirmation_required');
      return service.confirm(principal, intent.confirmationId!, 'client_confirmation');
    }
    return {
      database,
      store,
      principal,
      authority,
      access,
      service,
      resolve,
      selected,
      auditId,
      repository,
      worker,
      setPermissions,
      accept,
      selectedInvocation,
    };
  }

  it('denies a moderate-only administrator before resolving, saving an intent or producing effects', async () => {
    const f = await fixture(['drasil:read', 'drasil:moderate'], false);
    expect(
      await f.service.submit(f.principal, {
        ...invocation,
        input: { auditRequestId: 'audit', auditRevision: 'r1', selectedFixIds: ['repair'] },
      })
    ).toMatchObject({
      state: 'denied',
      code: 'scope_denied',
    });
    expect(f.resolve).not.toHaveBeenCalled();
    expect(await f.access.getCapabilities(f.principal, 'guild')).toMatchObject({
      kind: 'allowed',
      capabilities: { workflows: expect.not.arrayContaining(['apply_case_role_lockdown']) },
    });
    for (const table of ['mcp_intents', 'mcp_executions', 'moderation_action_requests'])
      expect((await pool.query(`select count(*)::int as n from ${table}`)).rows[0].n).toBe(0);
    expect(
      (await pool.query('select settings from servers')).rows[0].settings.case_role_lockdown_enabled
    ).toBe(false);
  });

  it.each([false, undefined] as const)(
    'old coarse approval cannot enable lockdown from %s',
    async (enabled) => {
      const f = await fixture(['drasil:read', 'drasil:configure'], enabled);
      expect((await f.service.submit(f.principal, invocation)).state).toBe('denied');
      expect(
        (
          await pool.query(
            "select count(*)::int n from moderation_action_requests where action_type='apply_case_role_lockdown'"
          )
        ).rows[0].n
      ).toBe(0);
      expect(
        (await pool.query('select settings from servers')).rows[0].settings
          .case_role_lockdown_enabled
      ).toBe(enabled);
    }
  );

  it('freezes selected effects and executes reviewed repairs through the worker', async () => {
    const f = await fixture(['drasil:read', 'drasil:configure'], false, true);
    const receipt = await f.accept();
    expect((await f.repository.findById(receipt.requestId!))?.metadata).toMatchObject({
      restriction_schema_version: 1,
      restriction_plan: { actorId: 'actor', selectedFixIds: ['repair'] },
    });
    expect(await f.worker.processPendingRequests(1)).toBe(1);
    expect(await f.repository.findById(receipt.requestId!)).toMatchObject({
      status: 'completed',
      result: { restriction_apply: { stopReason: 'completed' } },
      last_error: null,
    });
    expect(f.setPermissions).toHaveBeenCalledTimes(1);
    expect((await f.repository.findById(receipt.requestId!))?.result).toMatchObject({
      restriction_apply: { stopReason: 'completed' },
      restriction_progress: { receipts: [{ state: 'applied' }] },
    });
    expect(
      (await f.service.status(f.principal, receipt.executionId!)).outcome?.restrictionApply
        ?.stopReason
    ).toBe('completed');
    expect(
      await f.service.status({ ...f.principal, connectionId: randomUUID() }, receipt.executionId!)
    ).toMatchObject({ state: 'denied' });
    expect(await createRestrictionStores(f.database).load(f.auditId, 'foreign')).toBeNull();
  });
  it('rejects selected-ID tampering between acceptance and worker execution', async () => {
    const f = await fixture(['drasil:read', 'drasil:configure'], false, true);
    const receipt = await f.accept();
    await pool.query(
      "update moderation_action_requests set metadata=jsonb_set(metadata,'{operation_command,selectedFixIds}',$2::jsonb) where id=$1::uuid",
      [receipt.requestId, JSON.stringify(['foreign'])]
    );
    await f.worker.processPendingRequests(1);
    expect(f.setPermissions).not.toHaveBeenCalled();
    expect(await f.repository.findById(receipt.requestId!)).toMatchObject({
      status: 'completed',
      result: { action_type: 'delegated_admission', state: 'denied', code: 'binding_mismatch' },
    });
    expect(await f.service.status(f.principal, receipt.executionId!)).toMatchObject({
      state: 'denied',
      code: 'binding_mismatch',
    });
  });
  it('rechecks connection revocation before worker writes', async () => {
    const f = await fixture(['drasil:read', 'drasil:configure'], false, true);
    const receipt = await f.accept();
    await f.store.revokeConnection(f.principal, f.principal.grantVersion);
    await f.worker.processPendingRequests(1);
    expect(f.setPermissions).not.toHaveBeenCalled();
    expect((await f.repository.findById(receipt.requestId!))?.result).toMatchObject({
      state: 'denied',
    });
  });
  it('does not relabel durable started evidence as an unstarted revocation denial', async () => {
    const f = await fixture(['drasil:read', 'drasil:configure'], false, true);
    const receipt = await f.accept();
    const claimed = (await f.repository.claimNext())!;
    const progress = {
      schemaVersion: 1,
      revision: 1,
      currentEffectIndex: 0,
      receipts: [{ effectIndex: 0, state: 'started', observation: null, error: null }],
    };
    await pool.query('update moderation_action_requests set result=$2::jsonb where id=$1::uuid', [
      claimed.id,
      JSON.stringify({ restriction_progress: progress }),
    ]);
    await f.store.revokeConnection(f.principal, f.principal.grantVersion);
    const current = (await f.repository.findById(claimed.id))!;
    const admission = createDelegatedWorkerAdmission({ store: f.store, access: f.access });
    expect(
      await admission.authorizeDelegatedRequest(current, false, decodeQueuedAction(current))
    ).toMatchObject({
      kind: 'denied',
      code: 'uncertain_prior_effect',
      persistence: 'observe_only',
    });
    expect(await f.repository.findById(claimed.id)).toMatchObject({
      status: 'processing',
      result: { restriction_progress: progress },
    });
    expect(f.setPermissions).not.toHaveBeenCalled();
    expect(receipt.requestId).toBe(claimed.id);
  });
  it.each([false, true])(
    'interrupted MCP work only reconciles, prior receipt=%s',
    async (priorReceipt) => {
      const f = await fixture(['drasil:read', 'drasil:configure'], false, true);
      const receipt = await f.accept();
      const claimed = (await f.repository.claimNext())!;
      const admission = createDelegatedWorkerAdmission({ store: f.store, access: f.access });
      expect(
        (await admission.authorizeDelegatedRequest(claimed, false, decodeQueuedAction(claimed)))
          .kind
      ).toBe('new_execution');
      if (priorReceipt)
        await pool.query(
          'update moderation_action_requests set result=$2::jsonb where id=$1::uuid',
          [
            claimed.id,
            JSON.stringify({
              restriction_progress: {
                schemaVersion: 1,
                revision: 1,
                currentEffectIndex: 0,
                receipts: [{ effectIndex: 0, state: 'started', observation: null, error: null }],
              },
            }),
          ]
        );
      await pool.query(
        "update moderation_action_requests set updated_at=clock_timestamp()-interval '16 minutes' where id=$1::uuid",
        [claimed.id]
      );
      await f.worker.processPendingRequests(1);
      expect(f.setPermissions).not.toHaveBeenCalled();
      expect((await f.repository.findById(receipt.requestId!))?.result).toMatchObject({
        restriction_apply: { stopReason: 'interrupted' },
      });
    }
  );
});
