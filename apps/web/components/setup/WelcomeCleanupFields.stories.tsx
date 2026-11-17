import type { Meta, StoryObj } from '@storybook/react-vite';
import { WelcomeCleanupFields } from './WelcomeCleanupFields';

const meta = {
  title: 'Setup/Welcome cleanup',
  component: WelcomeCleanupFields,
  decorators: [
    (Story) => (
      <form style={{ maxWidth: 800, padding: 24 }}>
        <Story />
      </form>
    ),
  ],
  args: {
    enabled: true,
    botId: null,
    channelId: null,
    bots: [
      {
        id: '123456789012345678',
        name: 'Welcome Bot',
        detail: '@welcome',
        avatarUrl: 'https://cdn.discordapp.com/embed/avatars/0.png',
      },
      {
        id: '123456789012345679',
        name: 'Community Helper',
        detail: '@helper',
        avatarUrl: 'https://cdn.discordapp.com/embed/avatars/1.png',
      },
    ],
    channels: [
      { id: '234567890123456789', name: '#welcome' },
      { id: '234567890123456780', name: '#introductions' },
    ],
  },
} satisfies Meta<typeof WelcomeCleanupFields>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Unconfigured: Story = {};
export const Configured: Story = {
  args: { botId: '123456789012345678', channelId: '234567890123456789' },
};
export const Unavailable: Story = {
  args: {
    botId: '123456789012345678',
    channelId: '234567890123456789',
    bots: [],
    botsUnavailable: true,
  },
};

export const BotSearch: Story = {
  args: {
    bots: [],
    searchBots: async (query) =>
      query.includes('other')
        ? [
            {
              id: '123456789012345670',
              name: 'Other Bot',
              detail: '@other',
              avatarUrl: 'https://cdn.discordapp.com/embed/avatars/2.png',
            },
          ]
        : [],
  },
};
