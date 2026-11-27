import { MessageScamShadow } from '../../services/MessageScamShadow';
import type { UserProfileData } from '../../services/GPTService';
import { recordObservation } from '../../observability/langfuse';

jest.mock('../../observability/langfuse', () => ({
  withObservation: (_name: string, _kind: string, operation: () => Promise<unknown>) => operation(),
  recordObservation: jest.fn(),
}));

const profile: UserProfileData = {
  username: 'excluded-name',
  accountCreatedAt: new Date(0),
  joinedServerAt: new Date(0),
  recentMessages: ['sender context'],
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
    const jev = JSON.parse(String(fetchSpy.mock.calls[0][1]?.body));
    const luna = JSON.parse(String(fetchSpy.mock.calls[1][1]?.body));
    expect(jev.state).toBe(luna.input);
    expect(jev.state).toContain('current message');
    expect(jev.state).not.toContain('excluded');
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
