import { describe, expect, it, vi } from 'vitest';
import { ChannelType, PermissionFlagsBits, type Guild } from 'discord.js';
import { DiscordTicketGateway } from './discord-gateway.js';

function fixture(roleId: string, administrator = false) {
  const guildId = '12345678901234567';
  const guild = { id: guildId, channels: { fetch: vi.fn(async () => ({ type: ChannelType.GuildCategory, guildId })) },
    roles: { fetch: vi.fn(async () => ({ id: roleId, permissions: { has: (flag: bigint) => administrator && flag === PermissionFlagsBits.Administrator } })) },
    members: { fetchMe: vi.fn(async () => ({ permissions: { has: () => true } })) } } as unknown as Guild;
  return { guildId, guild, gateway: new DiscordTicketGateway(guild) };
}

describe('private ticket destination preflight', () => {
  it('rejects @everyone as staff role before any channel is created', async () => {
    const { guildId, guild, gateway } = fixture('12345678901234567');
    await expect(gateway.assertConfiguration(guildId, guildId)).rejects.toThrow('not @everyone');
    expect(guild.roles.fetch).not.toHaveBeenCalled();
  });
  it('rejects a staff role with Administrator', async () => {
    const { guildId, gateway } = fixture('22345678901234567', true);
    await expect(gateway.assertConfiguration(guildId, '22345678901234567')).rejects.toThrow('without Administrator');
  });
});
