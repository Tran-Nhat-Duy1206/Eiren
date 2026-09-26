import { Events, type GuildMember } from 'discord.js';
import type { BotEvent } from '../../core/events/event.js';

export const verificationEvents: BotEvent[] = [{
  name: Events.GuildMemberAdd,
  moduleKey: 'verification',
  guildId: value => {
    const member = value as GuildMember | undefined;
    return member && typeof member.guild?.id === 'string' ? member.guild.id : null;
  },
  async handle(services, value) {
    const member = value as GuildMember;
    if (!member?.guild || !member.user) return;
    try {
      await services.verification.handleJoin({
        guildId: member.guild.id,
        userId: member.id,
        accountCreatedAt: member.user.createdAt ?? null,
        joinedAt: member.joinedAt ?? new Date(),
      });
    } catch (error) {
      // Join handling must never crash the event loop; the service already reports step failures.
      services.logger.warn({ err: error, guildId: member.guild.id, userId: member.id }, 'Verification join handling failed');
    }
  },
}];
