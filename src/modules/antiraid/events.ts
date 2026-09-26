import { Events, type GuildMember, type Message } from 'discord.js';
import type { BotEvent } from '../../core/events/event.js';

/** Anti-raid signals use metadata only: join timestamps, account age and message counts. */
export const antiraidEvents: BotEvent[] = [
  {
    name: Events.GuildMemberAdd,
    moduleKey: 'antiraid',
    guildId: value => {
      const member = value as GuildMember | undefined;
      return member && typeof member.guild?.id === 'string' ? member.guild.id : null;
    },
    async handle(services, value) {
      const member = value as GuildMember;
      if (!member?.guild || !member.user) return;
      await services.antiraid.handleJoin({
        guildId: member.guild.id, userId: member.id,
        joinedAt: member.joinedAt ?? new Date(), accountCreatedAt: member.user.createdAt ?? null,
      });
    },
  },
  {
    name: Events.MessageCreate,
    moduleKey: 'antiraid',
    guildId: value => {
      const message = value as Message | undefined;
      return typeof message?.guildId === 'string' ? message.guildId : null;
    },
    async handle(services, value) {
      const message = value as Message;
      if (!message?.guildId || !message.author || message.author.bot) return;
      // Counts only; message content is never read, stored, or logged.
      await services.antiraid.handleMessage({
        guildId: message.guildId, userId: message.author.id, messageId: message.id,
        at: message.createdTimestamp, mentionCount: message.mentions?.users?.size ?? 0,
      });
    },
  },
];
