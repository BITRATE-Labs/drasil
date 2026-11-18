import {
  RestrictionAuditService,
  RestrictionAuditReadPort,
} from '../../services/RestrictionAuditService';
import { facts, caseFact } from '../../../packages/application/src/operations/restrictionTestData';

describe('RestrictionAuditService', () => {
  it('paginates cases and preserves partial archived-thread coverage', async () => {
    const read: RestrictionAuditReadPort = {
      readBase: jest.fn().mockResolvedValue(facts()),
      readCases: jest
        .fn()
        .mockResolvedValueOnce({ items: [caseFact()], next: 'next' })
        .mockResolvedValueOnce({ items: [caseFact({ caseId: 'second' })], next: null }),
      readMember: jest.fn().mockImplementation(async (_guild, item) => item),
      readThreads: jest
        .fn()
        .mockResolvedValueOnce({
          items: [
            {
              id: 't',
              parentId: 'channel',
              private: true,
              archived: false,
              locked: false,
              memberIds: [],
              metadataAvailable: true,
            },
          ],
          next: 'archive',
        })
        .mockRejectedValueOnce(new Error('denied')),
      readThreadMembers: jest.fn().mockResolvedValue({ items: [], next: null }),
    };
    const audit = await new RestrictionAuditService(
      read,
      () => new Date('2026-11-17T12:00:00Z')
    ).auditGuild('guild');
    expect(read.readCases).toHaveBeenCalledTimes(2);
    expect(audit.facts.cases).toHaveLength(2);
    expect(audit.coverage.find((x) => x.area === 'threads')?.state).toBe('partial');
    expect(audit.setup.status).not.toBe('verified');
    expect(audit.coverage.find((x) => x.area === 'parent_content')?.state).toBe('out_of_scope');
    expect(audit.expiresAt).toBe('2026-11-17T12:10:00.000Z');
  });
});

function readPort(base = facts()): RestrictionAuditReadPort {
  return {
    readBase: jest.fn().mockResolvedValue(base),
    readCases: jest.fn().mockResolvedValue({ items: base.cases, next: null }),
    readMember: jest.fn().mockImplementation(async (_guild, item) => item),
    readThreads: jest.fn().mockResolvedValue({ items: base.threads, next: null }),
    readThreadMembers: jest.fn().mockImplementation(async (_guild, id) => ({
      items: base.threads.find((t) => t.id === id)?.memberIds ?? [],
      next: null,
    })),
  };
}

it.each(['voice', 'forum', 'media'] as const)(
  'collects %s channel access with missing overwrites',
  async (type) => {
    const input = facts({
      roles: facts().roles.map((r) => (r.id === 'guild' ? { ...r, permissions: '1024' } : r)),
      channels: [{ ...facts().channels[0], type }],
    });
    const audit = await new RestrictionAuditService(readPort(input)).auditGuild('guild');
    expect(audit.setup.findingCodes).toContain('unexpected_channel_access');
    expect(audit.fixes.some((f) => f.effects.some((e) => e.kind === 'edit_overwrite'))).toBe(true);
  }
);
it('does not verify obfuscated overwrites or API-denied member reads', async () => {
  const port = readPort(
    facts({ channels: [{ ...facts().channels[0], metadataAvailable: false }], cases: [caseFact()] })
  );
  (port.readMember as jest.Mock).mockRejectedValue(new Error('API denied'));
  const audit = await new RestrictionAuditService(port).auditGuild('guild');
  expect(audit.setup.status).not.toBe('verified');
  expect(audit.coverage.find((c) => c.area === 'channels')?.state).toBe('partial');
  expect(audit.coverage.find((c) => c.area === 'affected_members')?.state).toBe('unavailable');
});
it('checks private membership, public siblings and archived-thread reopening metadata', async () => {
  const input = facts({
    recoveryParentId: 'channel',
    roles: facts().roles.map((r) =>
      r.id === 'guild'
        ? { ...r, permissions: ((1n << 10n) | (1n << 16n) | (1n << 38n)).toString() }
        : r
    ),
    cases: [caseFact({ threadId: 'own' })],
    threads: [
      {
        id: 'own',
        parentId: 'channel',
        private: true,
        archived: true,
        locked: false,
        memberIds: ['user'],
        metadataAvailable: true,
      },
      {
        id: 'public',
        parentId: 'channel',
        private: false,
        archived: true,
        locked: false,
        memberIds: [],
        metadataAvailable: true,
      },
    ],
  });
  const port = readPort(input);
  let audit = await new RestrictionAuditService(port).auditGuild('guild');
  expect(audit.cases[0].findingCodes).toContain('sibling_thread_access');
  expect(audit.cases[0].findingCodes).not.toContain('case_thread_access_missing');
  (port.readThreadMembers as jest.Mock).mockResolvedValue({ items: [], next: null });
  audit = await new RestrictionAuditService(port).auditGuild('guild');
  expect(audit.cases[0].findingCodes).toContain('case_thread_access_missing');
  expect(port.readThreadMembers).toHaveBeenCalledWith('guild', 'own', null, 100);
});
it('bounds an in-flight denial or stalled read by the injected audit deadline', async () => {
  jest.useFakeTimers({ now: new Date('2026-11-17T12:00:00Z') });
  try {
    const port = readPort();
    (port.readBase as jest.Mock).mockReturnValue(new Promise(() => undefined));
    const pending = new RestrictionAuditService(port, () => new Date(), 90_000).auditGuild('guild');
    await jest.advanceTimersByTimeAsync(90_000);
    const audit = await pending;
    expect(audit.setup.status).not.toBe('verified');
    expect(audit.coverage.filter((c) => c.state === 'unavailable').length).toBeGreaterThan(0);
    expect(port.readCases).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  } finally {
    jest.useRealTimers();
  }
});

it('projects the injected shared audit and reuses the existing member audit context', async () => {
  const { RestrictionAuditService } = await import('../../services/RestrictionAuditService');
  const { CaseRoleLockdownService } = await import('../../services/CaseRoleLockdownService');
  const input = facts({ channels: [{ ...facts().channels[0], metadataAvailable: false }] });
  const audit = await new RestrictionAuditService(readPort(input)).auditGuild('guild');
  const shared = { auditGuild: jest.fn().mockResolvedValue(audit) };
  const service = new CaseRoleLockdownService(shared);
  const report = await service.auditGuild({ id: 'guild' } as import('discord.js').Guild);
  expect(report.issues.some((i) => i.code === 'metadata_unavailable')).toBe(true);
  const context = { siblingThreadsByParentId: new Map() };
  const member = {
    id: 'user',
    guild: { id: 'guild' },
    roles: { cache: new Map([['case', {}]]) },
  } as unknown as import('discord.js').GuildMember;
  await service.auditMemberBypasses(member, new Set(), null, null, context);
  await service.auditMemberBypasses(member, new Set(), null, null, context);
  expect(shared.auditGuild).toHaveBeenCalledTimes(2);
});

it('runs one shared audit for integrity checks without repeating legacy lockdown reads', async () => {
  const { IntegrityAuditService } = await import('../../services/IntegrityAuditService');
  const input = facts({ channels: [{ ...facts().channels[0], metadataAvailable: false }] });
  const audit = await new RestrictionAuditService(readPort(input)).auditGuild('guild');
  const shared = { auditGuild: jest.fn().mockResolvedValue(audit) };
  const service = new IntegrityAuditService(
    {} as import('discord.js').Client,
    {
      getServerConfig: jest.fn().mockResolvedValue({ settings: {}, case_role_id: 'case' }),
    } as unknown as import('../../config/ConfigService').IConfigService,
    {
      listCandidates: jest.fn().mockResolvedValue({
        pendingVerificationEvents: [],
        recentResolvedVerificationEvents: [],
        caseRoleMembers: [],
        activeRoleQuarantineSnapshots: [],
        moderationQueueItems: [],
      }),
    },
    shared
  );
  const report = await service.auditGuild({ id: 'guild' } as import('discord.js').Guild);
  expect(shared.auditGuild).toHaveBeenCalledTimes(1);
  expect(report.findings.some((f) => f.code === 'restriction_metadata_unavailable')).toBe(true);
});
