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

test('optional role denies cannot hide baseline setup access', () => {
  const result = assessRestrictionFacts(
    facts({
      quarantineMode: 'off',
      roles: [role({ id: 'guild', permissions: String(view) }), role({ id: 'case' }), role()],
      channels: [
        channel({ overwrites: [{ id: 'member', type: 'role', allow: '0', deny: String(view) }] }),
      ],
    })
  );
  expect(result.setup.status).toBe('incomplete');
  expect(result.setup.findingCodes).toContain('unexpected_channel_access');
});
test('inert embed and attachment permissions do not permit parent posting', () => {
  const result = assessRestrictionFacts(
    facts({
      recoveryParentId: 'channel',
      roles: [
        role({
          id: 'guild',
          permissions: String(view | (1n << 14n) | (1n << 15n) | (1n << 16n) | (1n << 38n)),
        }),
        role({ id: 'case' }),
      ],
      channels: [
        channel({ overwrites: [{ id: 'case', type: 'role', allow: '0', deny: String(send) }] }),
      ],
    })
  );
  expect(result.setup.status).toBe('verified');
  expect(result.setup.findingCodes).not.toContain('exception_write_access');
});
test.each([4n, 13n, 29n])('retained parent administrative mutation bit %s is incomplete', (bit) => {
  const permissions = view | (1n << 16n) | (1n << 38n);
  const result = assessRestrictionFacts(
    facts({
      recoveryParentId: 'channel',
      roles: [
        role({ id: 'guild' }),
        role({ id: 'case', permissions: String(permissions) }),
        role({ managed: true, permissions: String(1n << bit) }),
      ],
      cases: [caseFact({ roleIds: ['case', 'member'], threadId: 'own' })],
      threads: [
        {
          id: 'own',
          parentId: 'channel',
          private: true,
          archived: false,
          locked: false,
          memberIds: ['user'],
          metadataAvailable: true,
        },
      ],
    })
  );
  expect(result.setup.findingCodes).toContain('exception_write_access');
  expect(result.cases[0].findingCodes).toContain('exception_write_access');
  expect(result.cases[0].status).toBe('incomplete');
});

test('optional-role combinations preserve capability prerequisites', () => {
  const parentPermissions = view | (1n << 16n) | (1n << 38n);
  const input = facts({
    quarantineMode: 'off',
    recoveryParentId: 'channel',
    roles: [
      role({ id: 'guild' }),
      role({ id: 'case', permissions: String(parentPermissions) }),
      role({ id: 'writer', permissions: String(send) }),
      role({ id: 'optional-deny' }),
    ],
    channels: [
      channel({
        overwrites: [{ id: 'optional-deny', type: 'role', allow: '0', deny: String(send) }],
      }),
    ],
  });
  expect(assessRestrictionFacts(input).setup.findingCodes).toContain('exception_write_access');
  const hiddenWriter = {
    ...input,
    channels: [
      channel({ overwrites: [{ id: 'writer', type: 'role', allow: '0', deny: String(view) }] }),
    ],
  };
  expect(assessRestrictionFacts(hiddenWriter).setup.findingCodes).not.toContain(
    'exception_write_access'
  );
  expect(assessRestrictionFacts(hiddenWriter).setup.findingCodes).toContain(
    'recovery_parent_access_missing'
  );
});

test('actual cases retain their persisted case role after the guild configuration changes', () => {
  const persisted = { ...caseFact({ roleIds: ['persisted'] }), caseRoleId: 'persisted' };
  const input = facts({ roles: [...facts().roles, role({ id: 'persisted' })], cases: [persisted] });
  expect(assessRestrictionFacts(input).cases[0].findingCodes).not.toContain(
    'case_role_not_assigned'
  );
  expect(assessRestrictionFacts(input).setup.findingCodes).not.toContain('case_role_missing');
});

test.each([1, 2, 4, 13, 29, 30, 33, 43, 44])(
  'dangerous global permission bit %s prevents compromised containment on case or everyone role',
  (bit) => {
    const parentPermissions = view | (1n << 16n) | (1n << 38n);
    for (const target of ['case', 'guild']) {
      const input = facts({
        recoveryParentId: 'channel',
        roles: [
          role({ id: 'guild', permissions: target === 'guild' ? String(1n << BigInt(bit)) : '0' }),
          role({
            id: 'case',
            permissions: String(parentPermissions | (target === 'case' ? 1n << BigInt(bit) : 0n)),
          }),
        ],
        cases: [caseFact({ purpose: 'compromised_account', roleIds: ['case'], threadId: 'own' })],
        threads: [
          {
            id: 'own',
            parentId: 'channel',
            private: true,
            archived: false,
            locked: false,
            memberIds: ['user'],
            metadataAvailable: true,
          },
        ],
      });
      const result = assessRestrictionFacts(input);
      expect(result.setup.findingCodes).toContain('retained_privileged_permissions');
      expect(result.cases[0].findingCodes).toContain('retained_privileged_permissions');
      expect(result.cases[0].status).toBe('incomplete');
    }
  }
);

test.each([null, 'missing'])(
  'missing prospective recovery parent %s is incomplete',
  (recoveryParentId) => {
    expect(assessRestrictionFacts(facts({ recoveryParentId })).setup.findingCodes).toContain(
      'recovery_parent_missing'
    );
  }
);
test.each([0n, 1n << 10n, 1n << 16n, 1n << 38n])(
  'requires every recovery permission, missing %s',
  (missing) => {
    const required = (1n << 10n) | (1n << 16n) | (1n << 38n);
    const input = facts({
      recoveryParentId: 'recovery',
      channels: [
        channel({
          id: 'recovery',
          overwrites: [
            {
              id: 'case',
              type: 'role',
              allow: String(missing ? required & ~missing : 0n),
              deny: '0',
            },
          ],
        }),
      ],
    });
    expect(assessRestrictionFacts(input).setup.findingCodes).toContain(
      'recovery_parent_access_missing'
    );
  }
);
test('unavailable recovery metadata is unverified, known unusable parent is incomplete', () => {
  const input = facts({
    recoveryParentId: 'recovery',
    channels: [channel({ id: 'recovery', metadataAvailable: false })],
  });
  expect(assessRestrictionFacts(input).setup.status).toBe('unverified');
  expect(
    assessRestrictionFacts({ ...input, channels: [channel({ id: 'recovery', type: 'forum' })] })
      .setup.findingCodes
  ).toContain('recovery_parent_unusable');
});

test('missing recovery parent in incomplete channel coverage is unavailable, not a known missing parent', () => {
  const result = assessRestrictionFacts(
    facts({ recoveryParentId: 'unread', channelsComplete: false })
  );
  expect(result.setup.status).toBe('unverified');
  expect(result.setup.findingCodes).not.toContain('recovery_parent_missing');
});
test.each(['announcement', 'category', 'voice', 'media', 'stage', 'forum'] as const)(
  'a %s channel cannot host the private recovery thread',
  (type) => {
    const input = facts({ recoveryParentId: 'channel', channels: [channel({ type })] });
    expect(assessRestrictionFacts(input).setup.findingCodes).toContain('recovery_parent_unusable');
  }
);
