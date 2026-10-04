import { ChannelType, DiscordAPIError, PermissionFlagsBits, type Client } from 'discord.js';

import { safeMentions } from '../../core/presentation/index.js';

export type AutomationDelivery = Readonly<{ kind: 'READY'; send(message: string): Promise<string> }>;
export type AutomationPreflight = AutomationDelivery | Readonly<{ kind: 'BLOCKED'; code: string }>;
export interface AutomationDiscordGateway {
  preflight(guildId: string, channelId: string): Promise<AutomationPreflight>;
}

const blocked = (code: string): AutomationPreflight => ({ kind: 'BLOCKED', code });
const validMessageId = /^[0-9]{17,20}$/;

/** Always fetch inside the requested guild; never consult the global channel cache. */
export function createAutomationDiscordGateway(client: Client): AutomationDiscordGateway {
  return {
    async preflight(guildId, channelId) {
      let guild;
      try { guild = await client.guilds.fetch({ guild: guildId, force: true }); }
      catch (error) { if (error instanceof DiscordAPIError && error.code === 10004) return blocked('GUILD_NOT_FOUND'); throw error; }
      if (guild.id !== guildId) return blocked('GUILD_MISMATCH');
      let channel;
      try { channel = await guild.channels.fetch(channelId, { force: true }); }
      catch (error) { if (error instanceof DiscordAPIError && error.code === 10003) return blocked('CHANNEL_NOT_FOUND'); throw error; }
      if (!channel) return blocked('CHANNEL_NOT_FOUND');
      if (channel.guildId !== guildId) return blocked('CHANNEL_GUILD_MISMATCH');
      if (channel.type !== ChannelType.GuildText) return blocked('UNSUPPORTED_CHANNEL');
      const botId = client.user?.id;
      if (!botId) return blocked('BOT_UNAVAILABLE');
      let member;
      try { member = await guild.members.fetch({ user: botId, force: true }); }
      catch (error) { if (error instanceof DiscordAPIError && error.code === 10007) return blocked('BOT_UNAVAILABLE'); throw error; }
      if (!member) return blocked('BOT_UNAVAILABLE');
      const permissions = channel.permissionsFor(member);
      if (!permissions?.has(PermissionFlagsBits.ViewChannel)) return blocked('MISSING_VIEW_CHANNEL');
      if (!permissions.has(PermissionFlagsBits.SendMessages)) return blocked('MISSING_SEND_MESSAGES');
      return {
        kind: 'READY',
        async send(message: string) {
          const result = await channel.send({ content: message, allowedMentions: safeMentions });
          if (typeof result?.id !== 'string' || !validMessageId.test(result.id))
            throw new Error('Ambiguous Discord send result: missing valid message snowflake');
          return result.id;
        },
      };
    },
  };
}
