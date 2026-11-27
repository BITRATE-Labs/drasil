import { MessageScamShadow } from '../../services/MessageScamShadow';
import type { UserProfileData } from '../../services/GPTService';
import { recordObservation, withObservation } from '../../observability/langfuse';

jest.mock('../../observability/langfuse', () => ({
  withObservation: jest.fn((_name: string, _kind: string, operation: () => Promise<unknown>) =>
    operation()
  ),
  recordObservation: jest.fn(),
}));

beforeEach(() => {
  jest.mocked(withObservation).mockImplementation(async (_name, _kind, operation) => operation());
});

const profile: UserProfileData = {
  username: 'excluded-name',
  accountCreatedAt: new Date(0),
  joinedServerAt: new Date(0),
  recentMessages: ['old context', 'recent 1', 'recent 2', 'recent 3', 'recent 4', 'recent 5'],
  channelContext: ['excluded bystander'],
};

it('starts both providers on identical evidence and caps the opted-in guild', async () => {
  const priorEnv = process.env;
  process.env = {
    ...priorEnv,
    DRASIL_MESSAGE_SCAM_SHADOW_GUILD_ID: 'guild',
    DRASIL_MESSAGE_SCAM_SHADOW_HOURLY_LIMIT: '1',
    TYPESAFE_API_KEY: 'test',
    OPENAI_API_KEY: 'test',
  };
  let release = (): void => {
    throw new Error('Jev response not initialized');
  };
  const jevResponse = new Promise<Response>((resolve) => {
    release = () =>
      resolve(new Response(JSON.stringify({ answers: { verdict: { choice: 'clear' } } })));
  });
  const fetchSpy = jest
    .spyOn(global, 'fetch')
    .mockReturnValueOnce(jevResponse)
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          answers: [{ name: 'verdict', choice: 'scam' }],
        })
      )
    );
  try {
    const shadow = new MessageScamShadow();
    shadow.observe('other-guild', 'other', 'ignored', profile);
    shadow.observe('guild', 'first', 'current message', profile);
    shadow.observe('guild', 'second', 'over the cap', profile);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(recordObservation).toHaveBeenCalledWith('span', {
      metadata: { cost_source: 'unknown' },
    });
    expect(jest.mocked(recordObservation).mock.invocationCallOrder[0]).toBeLessThan(
      fetchSpy.mock.invocationCallOrder[0]
    );
    const jev = JSON.parse(String(fetchSpy.mock.calls[0][1]?.body));
    const luna = JSON.parse(String(fetchSpy.mock.calls[1][1]?.body));
    expect(luna.input).toBe(JSON.stringify(jev.state));
    expect(luna.input).toContain('current message');
    expect(luna.input).not.toContain('excluded');
    expect(jev.state.sender_context).toEqual(profile.recentMessages.slice(1));
    expect(fetchSpy.mock.calls[0][1]?.signal).toBe(fetchSpy.mock.calls[1][1]?.signal);
    release();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(recordObservation).toHaveBeenCalledWith('span', {
      metadata: expect.objectContaining({
        outcome: 'compared',
        jev_verdict: 'clear',
        luna_verdict: 'scam',
      }),
    });
    expect(recordObservation).toHaveBeenCalledWith('span', {
      metadata: expect.objectContaining({
        outcome: 'budget',
      }),
    });
  } finally {
    process.env = priorEnv;
    fetchSpy.mockRestore();
  }
});

it('distinguishes provider HTTP and response validation failures', async () => {
  const priorEnv = process.env;
  process.env = {
    ...priorEnv,
    DRASIL_MESSAGE_SCAM_SHADOW_GUILD_ID: 'guild',
    DRASIL_MESSAGE_SCAM_SHADOW_HOURLY_LIMIT: '1',
    TYPESAFE_API_KEY: 'test',
    OPENAI_API_KEY: 'test',
  };
  const fetchSpy = jest
    .spyOn(global, 'fetch')
    .mockResolvedValueOnce(new Response(null, { status: 403 }))
    .mockResolvedValueOnce(new Response('{}'));
  try {
    const recentMessages = [...profile.recentMessages];
    jest
      .mocked(withObservation)
      .mockImplementationOnce(async (_name, _kind, operation) => Promise.resolve().then(operation));
    new MessageScamShadow().observe('guild', 'first', 'current message', {
      ...profile,
      recentMessages,
    });
    recentMessages.push('late mutation');
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(fetchSpy.mock.calls[0][1]?.body).not.toContain('late mutation');
    expect(fetchSpy.mock.calls[1][1]?.body).not.toContain('late mutation');
    expect(recordObservation).toHaveBeenCalledWith('span', {
      metadata: expect.objectContaining({
        outcome: 'compared',
        jev_verdict: 'unavailable',
        jev_http_status: 403,
        jev_failure: 'http_error',
        luna_verdict: 'unavailable',
        luna_http_status: 200,
        luna_failure: 'invalid_response',
      }),
    });
  } finally {
    fetchSpy.mockRestore();
    process.env = priorEnv;
  }
});
