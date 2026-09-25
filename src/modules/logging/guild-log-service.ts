import { EmbedBuilder, type Client, type MessageCreateOptions } from 'discord.js';
import type { Logger } from '../../core/logger/logger.js';
import type { GuildConfigService } from '../../services/guild-config-service.js';

export type LogCategory = 'general' | 'moderation' | 'security';
export interface LogField { name: string; value: string; inline?: boolean }
export interface LogMetadata { actorId?: string; targetId?: string; occurredAt?: Date }

/** The only gateway from guild events to guild-facing log channels. */
export class GuildLogService {
  constructor(
    private readonly client: Client,
    private readonly guildConfig: GuildConfigService,
    private readonly logger: Logger,
  ) {}

  async send(guildId: string, category: LogCategory, title: string, fields: readonly LogField[] = [], metadata: LogMetadata = {}): Promise<void> {
    try {
      const settings = await this.guildConfig.get(guildId);
      // No cross-category fallback: a security/moderation log must not leak into a general channel.
      const channelId = category === 'security' ? settings?.securityLogChannelId
        : category === 'moderation' ? settings?.modLogChannelId : settings?.logChannelId;
      if (!channelId) return;
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || !('guildId' in channel) || channel.guildId !== guildId ||
          !channel.isTextBased() || !('send' in channel) || typeof channel.send !== 'function') {
        this.logger.warn({ guildId, category, channelId }, 'Guild log channel is unavailable or not sendable');
        return;
      }
      const embed = new EmbedBuilder()
        .setTitle(title.slice(0, 256))
        .setColor(category === 'security' ? 0xd9534f : category === 'moderation' ? 0xf0ad4e : 0x5865f2)
        .setTimestamp(metadata.occurredAt ?? new Date());
      const safeFields = fields.slice(0, 23).map(field => ({
        name: field.name.slice(0, 256) || 'Detail',
        value: field.value.slice(0, 1024) || '—',
        inline: field.inline ?? false,
      }));
      if (metadata.actorId) safeFields.push({ name: 'Actor ID', value: metadata.actorId.slice(0, 1024), inline: true });
      if (metadata.targetId) safeFields.push({ name: 'Target ID', value: metadata.targetId.slice(0, 1024), inline: true });
      if (safeFields.length) embed.addFields(safeFields);
      // Explicitly disable mentions, including user-provided channel names/nicknames.
      const payload: MessageCreateOptions = { embeds: [embed], allowedMentions: { parse: [] } };
      await channel.send(payload);
    } catch {
      // Fetch, permissions, stale settings and network errors are non-fatal to event handling.
      this.logger.warn({ guildId, category }, 'Unable to deliver guild log');
    }
  }
}
