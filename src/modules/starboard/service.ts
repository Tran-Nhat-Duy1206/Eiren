import { DiscordAPIError } from 'discord.js';
import { AppError } from '../../core/errors/errors.js';
import type { Logger } from '../../core/logger/logger.js';
import type { Actor, PermissionService } from '../../core/permissions/permission-service.js';
import type { StarboardGateway } from './discord-gateway.js';
import { StarboardRepository } from './repository.js';

export class StarboardService {
  constructor(private readonly repository: StarboardRepository, private readonly permissions: PermissionService,
    private readonly gateway: (guildId: string) => Promise<StarboardGateway>, private readonly logger: Logger) {}
  async settings(actor: Actor) { await this.permissions.require(actor, 'ADMIN'); return this.repository.settings(actor.guildId); }
  async configure(actor: Actor, changes: { enabled?: boolean; channelId?: string | null; threshold?: number; emoji?: string; allowSelf?: boolean }) {
    await this.permissions.require(actor, 'ADMIN');
    if (changes.channelId) await (await this.gateway(actor.guildId)).validateChannel(changes.channelId);
    if (changes.threshold !== undefined && (!Number.isInteger(changes.threshold) || changes.threshold < 1 || changes.threshold > 25))
      throw new AppError('VALIDATION', 'Threshold must be between 1 and 25.');
    if (changes.emoji !== undefined && (!changes.emoji.trim() || changes.emoji.length > 100))
      throw new AppError('VALIDATION', 'Invalid emoji.');
    if (changes.enabled) {
      const existing = await this.repository.settings(actor.guildId);
      if (!changes.channelId && !existing?.channelId) throw new AppError('VALIDATION', 'Configure a starboard channel first.');
      await (await this.gateway(actor.guildId)).validateChannel(changes.channelId ?? existing!.channelId!);
    }
    const before = await this.repository.settings(actor.guildId);
    const updated = await this.repository.configure(actor.guildId, changes);
    if (before && (before.channelId !== updated.channelId || before.enabled !== updated.enabled ||
      before.threshold !== updated.threshold || before.emoji !== updated.emoji || before.allowSelf !== updated.allowSelf)) {
      // Recheck every published mirror after the settings write; its FOR SHARE lock serializes in-flight publication.
      for (const row of await this.repository.postsFrom(actor.guildId)) {
        try { await this.reconcile(actor.guildId, row.sourceChannelId, row.sourceMessageId); }
        catch (error) { this.logger.error({ errorType: error instanceof Error ? error.name : 'unknown',
          guildId: actor.guildId, sourceMessageId: row.sourceMessageId }, 'Starboard configuration needs reconciliation'); throw error; }
      }
    }
    return updated;
  }
  async ignore(actor: Actor, channelId: string, ignored: boolean) {
    await this.permissions.require(actor, 'ADMIN');
    if (ignored) {
      await this.repository.ignore(actor.guildId, channelId);
      // A channel made ineligible must not leave its previously published messages on the board.
      for (const row of await this.repository.postsFrom(actor.guildId, channelId)) {
        await this.reconcile(actor.guildId, row.sourceChannelId, row.sourceMessageId);
      }
    } else await this.repository.allow(actor.guildId, channelId);
  }
  async sourceChannelUpdated(guildId: string, channelId: string) {
    const settings = await this.repository.settings(guildId);
    // An NSFW destination turned SFW must withdraw every incompatible source, even without reactions.
    // The destination barrier waits for in-flight publications before taking its POSTED snapshot.
    const rows = channelId === settings?.channelId
      ? await this.repository.postedAfterDestinationBarrier(guildId)
      : await this.repository.postedAfterChannelBarrier(guildId, channelId);
    for (const row of rows) await this.reconcile(guildId, row.sourceChannelId, row.sourceMessageId);
  }
  async sourceChannelDeleted(guildId: string, channelId: string) {
    // Wait for publications already in flight before scanning the now-deleted channel.
    for (const row of await this.repository.postedAfterChannelBarrier(guildId, channelId)) {
      try { await this.reconcile(guildId, channelId, row.sourceMessageId, true); }
      catch (error) { this.logger.error({ errorType: error instanceof Error ? error.name : 'unknown', guildId,
        channelId, sourceMessageId: row.sourceMessageId }, 'Deleted source channel needs starboard reconciliation'); }
    }
  }
  /** Re-fetch visibility, settings and the complete reaction user set while holding the source row lock. */
  async reconcile(guildId: string, channelId: string, messageId: string, deleted = false) {
    const initial = await this.repository.settings(guildId);
    if (!initial?.channelId) return;
    if (deleted) {
      const gateway = await this.gateway(guildId);
      await this.repository.reconcileTransaction(guildId, channelId, async tx => {
        const row = await this.repository.lock(tx, { guildId, sourceChannelId: channelId,
          sourceMessageId: messageId, sourceAuthorId: 'deleted' });
        if (row.starboardChannelId && row.starboardMessageId)
          await gateway.remove(row.starboardChannelId, row.starboardMessageId);
        await this.repository.save(tx, row, { status: 'DELETED', starCount: 0,
          starboardChannelId: null, starboardMessageId: null });
        await this.repository.pruneDeleted(tx, guildId);
      });
      return;
    }
    const excluded = channelId === initial.channelId || await this.repository.ignored(guildId, channelId);
    if (!initial.enabled && !excluded && !(await this.repository.get(guildId, messageId))) return;
    const gateway = await this.gateway(guildId);
    // Preflight avoids retaining a row for every unstarred message; it is NOT the authoritative privacy check.
    const preflight = initial.enabled && !excluded ? await gateway.source(channelId, messageId) : null;
    const preflightBlocked = preflight && ((preflight.bot && !initial.allowBotMessages) ||
      (preflight.nsfw && !await gateway.isNsfw(initial.channelId)) || !preflight.public);
    const candidate = preflightBlocked ? null : preflight;
    const existing = candidate ? null : await this.repository.get(guildId, messageId);
    if (!candidate && !existing) return;
    let orphan: { channelId: string; messageId: string } | null = null;
    try {
      await this.repository.reconcileTransaction(guildId, channelId, async tx => {
        const previous = candidate ?? existing;
        if (!previous) return;
        const row = await this.repository.lock(tx, { guildId, sourceChannelId: channelId, sourceMessageId: messageId,
          sourceAuthorId: candidate ? candidate.authorId : ('sourceAuthorId' in previous ? previous.sourceAuthorId : previous.authorId) });
        const settings = await this.repository.settings(guildId, tx); // FOR SHARE coordinates configuration changes.
        const ignored = await this.repository.ignored(guildId, channelId, tx);
        if (!settings?.channelId) return;
        const fresh = settings.enabled && !ignored && channelId !== settings.channelId ? await gateway.source(channelId, messageId) : null;
        const blocked = fresh && ((fresh.bot && !settings.allowBotMessages) ||
          (fresh.nsfw && !await gateway.isNsfw(settings.channelId)) || !fresh.public);
        const source = blocked ? null : fresh;
        if (row.status === 'DELETED' && !deleted) return; // Late reaction delivery cannot resurrect deleted messages.
        const count = source ? await gateway.count(channelId, messageId, settings.emoji, settings.allowSelf, source.authorId) : 0;
        if (!source || count < settings.threshold) {
          if (row.starboardChannelId && row.starboardMessageId) await gateway.remove(row.starboardChannelId, row.starboardMessageId);
          await this.repository.save(tx, row, { starCount: count, status: deleted ? 'DELETED' : 'REMOVED', starboardChannelId: null, starboardMessageId: null });
        } else if (row.starboardChannelId && row.starboardMessageId) {
          if (row.starboardChannelId !== settings.channelId) {
            const postedId = await gateway.post(settings.channelId, source, count, settings.emoji);
            orphan = { channelId: settings.channelId, messageId: postedId };
            await gateway.remove(row.starboardChannelId, row.starboardMessageId);
            await this.repository.save(tx, row, { starCount: count, status: 'POSTED', starboardChannelId: settings.channelId, starboardMessageId: postedId });
          } else {
            try {
              await gateway.update(row.starboardChannelId, row.starboardMessageId, source, count, settings.emoji);
              await this.repository.save(tx, row, { starCount: count, status: 'POSTED' });
            } catch (error) {
              if (!(error instanceof DiscordAPIError && Number(error.code) === 10008)) throw error;
              const postedId = await gateway.post(settings.channelId, source, count, settings.emoji);
              orphan = { channelId: settings.channelId, messageId: postedId };
              await this.repository.save(tx, row, { starCount: count, status: 'POSTED', starboardChannelId: settings.channelId, starboardMessageId: postedId });
            }
          }
        } else {
          const postedId = await gateway.post(settings.channelId, source, count, settings.emoji);
          orphan = { channelId: settings.channelId, messageId: postedId };
          await this.repository.save(tx, row, { starCount: count, status: 'POSTED', starboardChannelId: settings.channelId, starboardMessageId: postedId });
        }
      });
      orphan = null;
    } catch (error) {
      if (orphan) {
        const { channelId: postedChannelId, messageId: postedMessageId } = orphan;
        try { await gateway.remove(postedChannelId, postedMessageId); }
        catch (cleanupError) { this.logger.error({ errorType: cleanupError instanceof Error ? cleanupError.name : 'unknown',
          guildId, sourceMessageId: messageId, postedChannelId, postedMessageId }, 'Starboard orphan cleanup failed'); }
      }
      throw error;
    }
  }
}
