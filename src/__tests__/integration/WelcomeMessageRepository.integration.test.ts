import {
  WelcomeMessageRepository,
  type WelcomeCandidate,
} from '../../repositories/WelcomeMessageRepository';
import { getPrismaClient } from '../testDb';
const describeIntegration = process.env.JEST_INTEGRATION === '1' ? describe : describe.skip;
describeIntegration('welcome message persistence', () => {
  it('preserves snapshots across repository instances and scopes lookup to source, member, and join window', async () => {
    const prisma = getPrismaClient();
    await prisma.servers.create({ data: { guild_id: 'welcome-test' } });
    const repository = new WelcomeMessageRepository(prisma);
    const joined = new Date('2026-11-16T12:00:00Z');
    const row: WelcomeCandidate = {
      server_id: 'welcome-test',
      message_id: '1',
      channel_id: 'welcome',
      bot_id: 'bot',
      created_at: joined,
      member_snapshots: { target: { names: ['old-name'], joinedAt: joined.toISOString() } },
    };
    await repository.collect(row);
    await repository.collect({ ...row, member_snapshots: {} });
    await repository.collect({
      ...row,
      message_id: '2',
      created_at: new Date(joined.getTime() + 120000),
      member_snapshots: {},
    });
    await repository.collect({
      ...row,
      message_id: '3',
      created_at: new Date(joined.getTime() + 120001),
      member_snapshots: {},
    });
    const restarted = new WelcomeMessageRepository(prisma);
    expect(
      (await restarted.findForBan('welcome-test', 'target', 'welcome', 'bot', null))[0]
        ?.member_snapshots.target?.names
    ).toEqual(['old-name']);
    expect(
      (await restarted.findForBan('welcome-test', 'target', 'welcome', 'bot', joined)).map(
        (c) => c.message_id
      )
    ).toEqual(['1', '2']);
    expect(await restarted.findForBan('welcome-test', 'other', 'welcome', 'bot', null)).toEqual([]);
    expect(
      await restarted.findForBan('welcome-test', 'target', 'other-channel', 'bot', joined)
    ).toEqual([]);
    expect(
      await restarted.findForBan('welcome-test', 'target', 'welcome', 'other-bot', joined)
    ).toEqual([]);
    await restarted.remove('other-guild', '1');
    expect(
      await restarted.findForBan('welcome-test', 'target', 'welcome', 'bot', null)
    ).toHaveLength(1);
    await restarted.remove('welcome-test', '1');
    expect(await restarted.findForBan('welcome-test', 'target', 'welcome', 'bot', null)).toEqual(
      []
    );
  });
});
