import {
  WelcomeMessageRepository,
  type WelcomeCandidate,
} from '../../repositories/WelcomeMessageRepository';
import { MessageContextRepository } from '../../repositories/MessageContextRepository';
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
      snapshots_complete: true,
      verification_attempted: false,
      recipient_id: null,
      verified_edited_at: null,
      expires_at: new Date('2099-01-01'),
      member_snapshots: { target: { names: ['old-name'], joinedAt: joined.toISOString() } },
    };
    await repository.collect(row);
    await repository.collect({ ...row, member_snapshots: {} });
    await repository.collect({
      ...row,
      message_id: '2',
      created_at: new Date(joined.getTime() + 120000),
      snapshots_complete: true,
      verification_attempted: false,
      recipient_id: null,
      verified_edited_at: null,
      expires_at: new Date('2099-01-01'),
      member_snapshots: {},
    });
    await repository.collect({
      ...row,
      message_id: '3',
      created_at: new Date(joined.getTime() + 120001),
      snapshots_complete: true,
      verification_attempted: false,
      recipient_id: null,
      verified_edited_at: null,
      expires_at: new Date('2099-01-01'),
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
    await restarted.recordRecipient('welcome-test', '1', 'other', null);
    expect(await restarted.findForBan('welcome-test', 'target', 'welcome', 'bot', null)).toEqual(
      []
    );
    expect(
      await restarted.findForBan('welcome-test', 'other', 'welcome', 'bot', joined)
    ).toHaveLength(2);
    await restarted.recordRecipient('welcome-test', '1', 'target', null);
    await restarted.remove('other-guild', '1');
    expect(
      await restarted.findForBan('welcome-test', 'target', 'welcome', 'bot', null)
    ).toHaveLength(1);
    await restarted.remove('welcome-test', '1');
    expect(await restarted.findForBan('welcome-test', 'target', 'welcome', 'bot', null)).toEqual(
      []
    );
  });
  it('prunes expired, disabled, and reconfigured references through the existing retention sweep', async () => {
    const prisma = getPrismaClient();
    await prisma.servers.create({
      data: {
        guild_id: 'retention',
        settings: { welcome_cleanup_bot_id: 'bot', welcome_cleanup_channel_id: 'welcome' },
      },
    });
    const data = {
      server_id: 'retention',
      channel_id: 'welcome',
      bot_id: 'bot',
      created_at: new Date(),
      member_snapshots: {},
      snapshots_complete: true,
      verification_attempted: false,
      recipient_id: null,
      verified_edited_at: null,
    };
    await prisma.welcome_message_candidates.create({
      data: { ...data, message_id: 'expired', expires_at: new Date('2000-01-01') },
    });
    await prisma.welcome_message_candidates.create({
      data: {
        ...data,
        message_id: 'old-source',
        channel_id: 'old',
        expires_at: new Date('2099-01-01'),
      },
    });
    await prisma.welcome_message_candidates.create({
      data: { ...data, message_id: 'current', expires_at: new Date('2099-01-01') },
    });
    const contexts = new MessageContextRepository(prisma);
    expect(await contexts.pruneExpired()).toBe(0);
    expect(await prisma.welcome_message_candidates.count()).toBe(1);
    await prisma.servers.update({
      where: { guild_id: 'retention' },
      data: { settings: { welcome_cleanup_enabled: false } },
    });
    expect(await contexts.pruneExpired()).toBe(0);
    expect(await prisma.welcome_message_candidates.count()).toBe(0);
  });
  it('caps stored references and bounds candidates nearest the join time', async () => {
    const prisma = getPrismaClient();
    await prisma.servers.create({ data: { guild_id: 'bounded' } });
    await prisma.$executeRaw`
      INSERT INTO public.welcome_message_candidates (server_id, message_id, channel_id, bot_id, created_at, expires_at)
      SELECT 'bounded', 'old-' || n::text, 'welcome', 'bot', '2000-01-01'::timestamptz, '2099-01-01'::timestamptz
      FROM generate_series(1, 50000) n
    `;
    const repository = new WelcomeMessageRepository(prisma);
    const joined = new Date();
    const row: WelcomeCandidate = {
      server_id: 'bounded',
      message_id: 'nearest',
      channel_id: 'welcome',
      bot_id: 'bot',
      created_at: joined,
      expires_at: new Date('2099-01-01'),
      member_snapshots: {},
      snapshots_complete: false,
      verification_attempted: false,
      recipient_id: null,
      verified_edited_at: null,
    };
    await repository.collect(row);
    expect(await prisma.welcome_message_candidates.count()).toBe(50000);
    for (let i = 0; i < 21; i++)
      await repository.collect({
        ...row,
        message_id: `later-${i}`,
        created_at: new Date(joined.getTime() + 1000 + i),
      });
    const candidates = await repository.findForBan('bounded', 'target', 'welcome', 'bot', joined);
    expect(candidates).toHaveLength(20);
    expect(candidates[0].message_id).toBe('nearest');
  });
});
