import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  deleteBotMessage,
  exchangeDiscordCode,
  fetchDiscordUser,
  fetchGuildBots,
  WELCOME_BOT_LIST_LIMIT,
  searchGuildBots,
  fetchBotChannelMessages,
  fetchDiscordGuilds,
  type DiscordGuildSummary,
  type DiscordMessage,
} from './discordApi';

function guild(id: string): DiscordGuildSummary {
  return {
    id,
    name: `Guild ${id}`,
    icon: null,
    owner: false,
    permissions: '0',
  };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { 'content-type': 'application/json' },
    status: 200,
  });
}

function message(id: string): DiscordMessage {
  return {
    id,
    channel_id: 'channel-1',
    content: `message ${id}`,
    timestamp: '2026-06-01T00:00:00.000Z',
    author: { id: 'user-1', username: 'user-1' },
    attachments: [],
  };
}

describe('Discord API helpers', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('loads known bots directly and searches bots without managed roles by name', async () => {
    vi.stubEnv('DRASIL_WEB_BOT_TOKEN', 'bot-token');
    vi.stubEnv('DISCORD_API_BASE_URL', 'https://discord.test/api/v10');
    const bot = { id: '123456789012345678', username: 'welcome-bot', bot: true, avatar: 'pfp' };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ roles: [], user: bot }))
      .mockResolvedValueOnce(
        jsonResponse([{ roles: [], user: bot }, { user: { id: 'human', username: 'human' } }])
      );
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      fetchGuildBots('234567890123456789', [
        {
          id: 'role',
          name: 'Bot',
          permissions: '0',
          position: 1,
          managed: true,
          tags: { bot_id: bot.id },
        },
      ])
    ).resolves.toEqual([bot]);
    await expect(searchGuildBots('234567890123456789', 'welcome')).resolves.toEqual([bot]);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/members/123456789012345678');
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('/members/search?query=welcome');
  });

  it('loads bot members sequentially instead of issuing a parallel burst', async () => {
    vi.stubEnv('DRASIL_WEB_BOT_TOKEN', 'bot-token');
    let finish = (response: Response): void => {
      void response;
    };
    const first = new Promise<Response>((resolve) => {
      finish = resolve;
    });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce(
        jsonResponse({ user: { id: '123456789012345679', username: 'second', bot: true } })
      );
    vi.stubGlobal('fetch', fetchMock);
    const role = { id: 'role', name: 'Bot', permissions: '0', position: 1, managed: true };
    const work = fetchGuildBots('234567890123456789', [
      { ...role, tags: { bot_id: '123456789012345678' } },
      { ...role, tags: { bot_id: '123456789012345679' } },
    ]);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    finish(jsonResponse({ user: { id: '123456789012345678', username: 'first', bot: true } }));
    expect(await work).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('caps the initial bot list and keeps the saved bot first', async () => {
    vi.stubEnv('DRASIL_WEB_BOT_TOKEN', 'bot-token');
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(async (url) =>
        jsonResponse({ user: { id: String(url).split('/').at(-1), username: 'bot', bot: true } })
      );
    vi.stubGlobal('fetch', fetchMock);
    const saved = '999999999999999999';
    const roles = Array.from({ length: 40 }, (_, index) => ({
      id: String(index),
      name: 'Bot',
      permissions: '0',
      position: 1,
      managed: true,
      tags: { bot_id: String(123456789012345678n + BigInt(index)) },
    }));
    expect(await fetchGuildBots('234567890123456789', roles, saved)).toHaveLength(
      WELCOME_BOT_LIST_LIMIT
    );
    expect(fetchMock).toHaveBeenCalledTimes(WELCOME_BOT_LIST_LIMIT);
    expect(String(fetchMock.mock.calls[0][0])).toContain(`/members/${saved}`);
  });

  it('preserves loaded bots and stops fanout when a later provider read is unavailable', async () => {
    vi.stubEnv('DRASIL_WEB_BOT_TOKEN', 'bot-token');
    const bot = { id: '123456789012345678', username: 'first', bot: true };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ user: bot }))
      .mockImplementation(async () => new Response('Unavailable', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);
    const roles = [bot.id, '123456789012345679', '123456789012345680'].map((id) => ({
      id,
      name: 'Bot',
      permissions: '0',
      position: 1,
      managed: true,
      tags: { bot_id: id },
    }));
    await expect(fetchGuildBots('234567890123456789', roles)).resolves.toEqual([bot]);
    expect(fetchMock.mock.calls.every(([url]) => !String(url).endsWith('123456789012345680'))).toBe(
      true
    );
  });

  it('returns the complete 200-server user directory without a second rate-limited request', async () => {
    vi.stubEnv('DISCORD_API_BASE_URL', 'https://discord.test/api/v10');
    const directory = Array.from({ length: 200 }, (_, index) => guild(String(index + 1)));
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(directory))
      .mockImplementation(async () => new Response('{"retry_after":0.001}', { status: 429 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchDiscordGuilds('access-token')).resolves.toEqual(directory);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('limit=200');
    expect(String(fetchMock.mock.calls[0]?.[0])).not.toContain('after=');
  });

  it.each([null, { error: 'unexpected' }, 'unexpected'])(
    'rejects a non-array user directory at the Discord read boundary (%j)',
    async (payload) => {
      vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(payload)));
      await expect(fetchDiscordGuilds('access-token')).rejects.toMatchObject({
        name: 'ReadDependencyUnavailableError',
      });
    }
  );

  it('paginates bot channel messages and returns oldest first', async () => {
    vi.stubEnv('DISCORD_API_BASE_URL', 'https://discord.test/api/v10');
    vi.stubEnv('DRASIL_WEB_BOT_TOKEN', 'bot-token');
    const firstPage = Array.from({ length: 100 }, (_, index) => message(String(200 - index)));
    const secondPage = [message('100'), message('99')];
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(firstPage))
      .mockResolvedValueOnce(jsonResponse(secondPage));
    vi.stubGlobal('fetch', fetchMock);

    const messages = await fetchBotChannelMessages('channel-1', 102);

    expect(messages.map((item) => item.id)).toEqual([
      '99',
      '100',
      ...firstPage.map((item) => item.id).reverse(),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      '/channels/channel-1/messages?limit=100'
    );
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('before=101');
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        headers: { authorization: 'Bot bot-token' },
      })
    );
  });

  it('deletes bot messages and treats missing messages as already gone', async () => {
    vi.stubEnv('DISCORD_API_BASE_URL', 'https://discord.test/api/v10');
    vi.stubEnv('DRASIL_WEB_BOT_TOKEN', 'bot-token');
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(deleteBotMessage('channel-1', 'message-1')).resolves.toBe(true);
    await expect(deleteBotMessage('channel-1', 'missing-message')).resolves.toBe(false);

    expect(fetchMock).toHaveBeenCalledWith(
      'https://discord.test/api/v10/channels/channel-1/messages/message-1',
      expect.objectContaining({
        method: 'DELETE',
        headers: { authorization: 'Bot bot-token' },
      })
    );
  });
});

describe('Discord GET recovery integration', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('leaves mutation and OAuth failures on their original single-attempt paths', async () => {
    vi.stubEnv('DRASIL_WEB_BOT_TOKEN', 'bot-token');
    vi.stubEnv('DISCORD_CLIENT_ID', 'test-client');
    vi.stubEnv('DISCORD_CLIENT_SECRET', 'test-secret');
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => new Response('{"retry_after":1}', { status: 429 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(deleteBotMessage('channel-1', 'message-1')).rejects.toThrow('429');
    await expect(
      exchangeDiscordCode({ code: 'test-code', redirectUri: 'https://app.test/callback' })
    ).rejects.toThrow('429');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(([, init]) => init?.method)).toEqual(['DELETE', 'POST']);
  });

  it('recovers standalone website user GETs with the same policy', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('{"retry_after":1}', { status: 429 }))
      .mockResolvedValueOnce(jsonResponse({ id: 'test-user', username: 'user' }));
    vi.stubGlobal('fetch', fetchMock);
    const result = fetchDiscordUser('access-token');
    const outcome = result.then(
      (value) => ({ value }),
      (error: unknown) => ({ error })
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(await outcome).toEqual({ value: { id: 'test-user', username: 'user' } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[1]?.cache).toBe('no-store');
  });

  it('recovers bot reads after a provider rate limit', async () => {
    vi.useFakeTimers();
    vi.stubEnv('DRASIL_WEB_BOT_TOKEN', 'bot-token');
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('{"retry_after":1}', { status: 429 }))
      .mockResolvedValueOnce(jsonResponse([message('1')]));
    vi.stubGlobal('fetch', fetchMock);
    const result = fetchBotChannelMessages('channel-1', 1);
    const outcome = result.then(
      (value) => ({ value }),
      (error: unknown) => ({ error })
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(await outcome).toEqual({ value: [message('1')] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('bounded source-centered pages', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });
  it.each(['around', 'before', 'after'] as const)(
    'sends one bounded %s request without changing snapshot semantics',
    async (kind) => {
      vi.stubEnv('DRASIL_WEB_BOT_TOKEN', 'test-token');
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse([]));
      vi.stubGlobal('fetch', fetchMock);
      const { fetchBotChannelMessagePage } = await import('./discordApi');
      await fetchBotChannelMessagePage({
        channelId: '100000000000000001',
        page: { kind, cursor: '100000000000000002' },
        limit: 50,
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const url = new URL(String(fetchMock.mock.calls[0][0]));
      expect(url.searchParams.get('limit')).toBe('50');
      expect(url.searchParams.get(kind)).toBe('100000000000000002');
    }
  );
  it('rejects invalid IDs and runtime page sizes before HTTP', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { fetchBotChannelMessagePage } = await import('./discordApi');
    await expect(
      fetchBotChannelMessagePage({
        channelId: '100000000000000001',
        page: { kind: 'before', cursor: 'https://evil.example' },
        limit: 50,
      })
    ).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
