import { assessRestrictionFacts } from './restrictionAssessment';
import { facts, role, channel, caseFact } from './restrictionTestData';

const view = 1n << 10n;
const send = 1n << 11n;
const allow = { id: 'member', type: 'role' as const, allow: String(view | send), deny: '0' };
const deny = { id: 'case', type: 'role' as const, allow: '0', deny: String(view) };

test('quarantined allow is not a setup access failure', () => {
  expect(
    assessRestrictionFacts(facts({ channels: [channel({ overwrites: [deny, allow] })] })).setup
      .status
  ).toBe('verified');
});
test.each(['off', 'audit_only'] as const)(
  'retained allow with mode %s is incomplete',
  (quarantineMode) => {
    expect(
      assessRestrictionFacts(
        facts({ quarantineMode, channels: [channel({ overwrites: [deny, allow] })] })
      ).setup.status
    ).toBe('incomplete');
  }
);
test('configured exemptions retain access', () => {
  expect(
    assessRestrictionFacts(
      facts({ exemptRoleIds: ['member'], channels: [channel({ overwrites: [deny, allow] })] })
    ).setup.status
  ).toBe('incomplete');
});
test('missing role and unavailable metadata cannot verify', () => {
  expect(assessRestrictionFacts(facts({ caseRoleId: null })).setup.status).toBe('incomplete');
  expect(
    assessRestrictionFacts(facts({ channels: [channel({ metadataAvailable: false })] })).setup
      .status
  ).toBe('unverified');
});
test('hidden channels do not leak posting', () => {
  expect(
    assessRestrictionFacts(
      facts({ roles: [role({ id: 'guild', permissions: String(send) }), role({ id: 'case' })] })
    ).setup.status
  ).toBe('verified');
});
test.each([{ owner: true }, { roleIds: ['case', 'staff'] }])(
  'actual owner/staff case remains incomplete',
  (input) => {
    const result = assessRestrictionFacts(
      facts({
        roles: [
          role({ id: 'guild' }),
          role({ id: 'case' }),
          role({ id: 'staff', permissions: '8' }),
        ],
        cases: [caseFact(input)],
      })
    );
    expect(result.setup.status).toBe('verified');
    expect(result.cases[0].status).toBe('incomplete');
  }
);
test('member allow wins over role deny', () => {
  const result = assessRestrictionFacts(
    facts({
      channels: [channel({ overwrites: [deny, { ...allow, id: 'user', type: 'member' }] })],
      cases: [caseFact()],
    })
  );
  expect(result.cases[0].findingCodes).toContain('unexpected_channel_access');
});
test('content is always outside metadata verification scope', () => {
  const result = assessRestrictionFacts(facts());
  expect(result.setup.scope).toBe('permissions_and_membership');
  expect(result.setup.coverage.find((item) => item.area === 'parent_content')?.state).toBe(
    'out_of_scope'
  );
});

test('actual retained removable role still leaks even when configured quarantine would remove it', () => {
  const result = assessRestrictionFacts(
    facts({
      channels: [channel({ overwrites: [deny, allow] })],
      cases: [caseFact({ roleIds: ['case', 'member'] })],
    })
  );
  expect(result.setup.status).toBe('verified');
  expect(result.cases[0].status).toBe('incomplete');
});
test.each(['channelsComplete', 'casesComplete', 'threadsComplete'] as const)(
  'incomplete %s coverage blocks verification',
  (key) => {
    expect(assessRestrictionFacts(facts({ [key]: false })).setup.status).toBe('unverified');
  }
);
test('synced children use parent overwrites and independent children use their own', () => {
  const parent = channel({
    id: 'category',
    type: 'category',
    overwrites: [{ id: 'case', type: 'role', allow: String(view), deny: '0' }],
  });
  const result = assessRestrictionFacts(
    facts({ channels: [parent, channel({ parentId: 'category', permissionsLocked: true })] })
  );
  expect(result.setup.findings).toEqual([
    expect.objectContaining({ code: 'unexpected_channel_access', channelId: 'channel' }),
  ]);
  expect(
    assessRestrictionFacts(
      facts({ channels: [parent, channel({ parentId: 'category', permissionsLocked: false })] })
    ).setup.status
  ).toBe('verified');
});
test('read-only exceptions report the existing-reaction limitation', () => {
  const result = assessRestrictionFacts(
    facts({
      exceptionChannelIds: ['channel'],
      channels: [
        channel({ overwrites: [{ id: 'case', type: 'role', allow: String(view), deny: '0' }] }),
      ],
    })
  );
  expect(result.setup.findingCodes).toContain('reaction_limitation');
  expect(result.setup.status).toBe('incomplete');
});
test('own private thread is reachable with archived unlocked state, siblings remain private', () => {
  const threadPermissions = view | (1n << 16n) | (1n << 38n);
  const input = facts({
    recoveryParentId: 'channel',
    roles: [role({ id: 'guild' }), role({ id: 'case', permissions: String(threadPermissions) })],
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
        id: 'sibling',
        parentId: 'channel',
        private: true,
        archived: false,
        locked: false,
        memberIds: [],
        metadataAvailable: true,
      },
    ],
  });
  expect(assessRestrictionFacts(input).cases[0].status).toBe('verified');
  expect(
    assessRestrictionFacts({
      ...input,
      threads: input.threads.map((thread) => ({ ...thread, locked: true })),
    }).cases[0].findingCodes
  ).toContain('case_thread_access_missing');
  expect(
    assessRestrictionFacts({
      ...input,
      threads: input.threads.map((thread) => ({ ...thread, memberIds: ['user'] })),
    }).cases[0].findingCodes
  ).toContain('sibling_thread_access');
});
test.each(['voice', 'stage', 'forum', 'media'] as const)(
  'visible %s channels are access failures',
  (type) => {
    expect(
      assessRestrictionFacts(
        facts({
          channels: [
            channel({
              type,
              overwrites: [{ id: 'case', type: 'role', allow: String(view), deny: '0' }],
            }),
          ],
        })
      ).setup.status
    ).toBe('incomplete');
  }
);

test('protected administrative permissions remain a manual case concern without visible channels', () => {
  const result = assessRestrictionFacts(
    facts({
      roles: [
        role({ id: 'guild' }),
        role({ id: 'case' }),
        role({ id: 'staff', permissions: String(1n << 28n) }),
      ],
      cases: [caseFact({ roleIds: ['case', 'staff'] })],
    })
  );
  expect(result.setup.status).toBe('verified');
  expect(result.cases[0].findingCodes).toContain('retained_privileged_permissions');
});
