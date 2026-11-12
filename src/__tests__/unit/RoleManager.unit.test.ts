import {
  Collection,
  GuildMember,
  PermissionFlagsBits,
  PermissionsBitField,
  Role,
} from 'discord.js';
import { IConfigService } from '../../config/ConfigService';
import { RoleManager } from '../../services/RoleManager';

function fixture() {
  const role = {
    id: 'case-role',
    managed: false,
    editable: true,
    permissions: new PermissionsBitField(),
  };
  const channels = new Collection<string, unknown>();
  const member = {
    guild: {
      id: 'guild',
      roles: { fetch: jest.fn().mockResolvedValue(role) },
      members: { me: {} as unknown, fetchMe: jest.fn(), resolve: jest.fn() },
      channels: { fetch: jest.fn().mockResolvedValue(channels) },
    },
    roles: {
      add: jest.fn().mockResolvedValue(undefined),
      remove: jest.fn().mockResolvedValue(undefined),
    },
  };
  const manager = new RoleManager({
    getCaseRole: jest.fn().mockResolvedValue(role),
  } as unknown as IConfigService);
  return { manager, member, role, channels };
}

describe('RoleManager grant safety', () => {
  it.each([
    'missing',
    'everyone',
    'managed',
    'unassignable',
    'guild permissions',
    ...[
      'Administrator',
      'ManageGuild',
      'ManageChannels',
      'ManageRoles',
      'ManageMessages',
      'ManageThreads',
      'ManageWebhooks',
      'ModerateMembers',
      'KickMembers',
      'BanMembers',
      'MuteMembers',
      'DeafenMembers',
      'MoveMembers',
    ],
  ])('rejects unsafe case roles before role mutation', async (unsafe) => {
    const { manager, member, role, channels } = fixture();
    if (unsafe === 'missing') member.guild.roles.fetch.mockResolvedValue(null);
    else if (unsafe === 'everyone') role.id = 'guild';
    else if (unsafe === 'managed') role.managed = true;
    else if (unsafe === 'unassignable') role.editable = false;
    else if (unsafe === 'guild permissions') role.permissions.add(PermissionFlagsBits.ViewChannel);
    else
      channels.set('channel', {
        permissionOverwrites: {
          cache: new Collection([
            [
              'case-role',
              {
                allow: new PermissionsBitField([
                  PermissionFlagsBits[unsafe as keyof typeof PermissionFlagsBits],
                ]),
              },
            ],
          ]),
        },
      });

    await expect(
      manager.assignCaseRole(member as unknown as GuildMember, 'case-role')
    ).rejects.toThrow();
    expect(member.roles.add).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    'allows verification media permissions without setup gating',
    async (explicit) => {
      const { manager, member, channels } = fixture();
      channels.set('verification-channel', {
        permissionOverwrites: {
          cache: new Collection([
            [
              'case-role',
              {
                allow: new PermissionsBitField([
                  PermissionFlagsBits.AttachFiles,
                  PermissionFlagsBits.EmbedLinks,
                  PermissionFlagsBits.AddReactions,
                  PermissionFlagsBits.UseExternalEmojis,
                  PermissionFlagsBits.UseExternalStickers,
                ]),
              },
            ],
          ]),
        },
      });
      await expect(
        manager.assignCaseRole(member as unknown as GuildMember, explicit ? 'case-role' : undefined)
      ).resolves.toBe(true);
      expect(member.roles.add).toHaveBeenCalledWith('case-role');
    }
  );

  it('revalidates fresh role and channel data at assignment after a successful preflight', async () => {
    const { manager, member, channels } = fixture();
    await manager.assertSafeCaseRole(member as unknown as GuildMember, 'case-role');
    channels.set('changed-channel', {
      permissionOverwrites: {
        cache: new Collection([
          [
            'case-role',
            {
              allow: new PermissionsBitField([PermissionFlagsBits.ManageMessages]),
            },
          ],
        ]),
      },
    });
    await expect(manager.assignCaseRole(member as unknown as GuildMember)).rejects.toThrow();
    expect(member.guild.roles.fetch).toHaveBeenNthCalledWith(2, 'case-role', { force: true });
    expect(member.guild.channels.fetch).toHaveBeenCalledTimes(2);
    expect(member.roles.add).not.toHaveBeenCalled();
  });

  it('loads an uncached bot member before evaluating Discord role editability', async () => {
    const { manager, member, role } = fixture();
    member.guild.members.me = null;
    member.guild.members.resolve.mockImplementation(() => member.guild.members.me);
    member.guild.members.fetchMe.mockImplementation(async () => {
      const bot = {
        permissions: new PermissionsBitField(PermissionFlagsBits.ManageRoles),
        roles: { highest: { comparePositionTo: () => 1 } },
      };
      member.guild.members.me = bot;
      return bot;
    });
    const editable = Object.getOwnPropertyDescriptor(Role.prototype, 'editable')!.get!;
    Object.defineProperty(role, 'editable', {
      get: () =>
        editable.call({ managed: false, guild: member.guild, client: { user: { id: 'bot' } } }),
    });
    await expect(
      manager.assignCaseRole(member as unknown as GuildMember, 'case-role')
    ).resolves.toBe(true);
    expect(member.guild.members.fetchMe).toHaveBeenCalledTimes(1);
    expect(member.roles.add).toHaveBeenCalledWith('case-role');
  });

  it('does not mutate roles when the uncached bot member cannot be loaded', async () => {
    const { manager, member } = fixture();
    member.guild.members.me = null;
    const error = new Error('PRIVATE_PROVIDER_SENTINEL');
    member.guild.members.fetchMe.mockRejectedValueOnce(error);
    await expect(
      manager.assignCaseRole(member as unknown as GuildMember, 'case-role')
    ).rejects.toBe(error);
    expect(member.roles.add).not.toHaveBeenCalled();
  });

  it('still removes an invalid case role', async () => {
    const { manager, member, role } = fixture();
    role.managed = true;
    await expect(
      manager.removeCaseRole(member as unknown as GuildMember, 'case-role')
    ).resolves.toBe(true);
    expect(member.roles.remove).toHaveBeenCalledWith('case-role');
  });
});
