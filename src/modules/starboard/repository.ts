import { and, eq, sql } from 'drizzle-orm';
import type { Database } from '../../core/database/connection.js';
import { starboardSettings, starboardIgnoredChannels, starboardMessages } from '../../core/database/schema.js';

export type StarboardSettings = typeof starboardSettings.$inferSelect;
export type StarboardMessage = typeof starboardMessages.$inferSelect;
export type StarboardTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];

export class StarboardRepository {
  constructor(private readonly db: Database) {}
  async settings(guildId: string, tx?: StarboardTransaction) {
    const query = (tx ?? this.db).select().from(starboardSettings).where(eq(starboardSettings.guildId, guildId));
    const [row] = tx ? await query.for('share') : await query;
    return row;
  }
  async configure(guildId: string, changes: Partial<Omit<typeof starboardSettings.$inferInsert, 'guildId'>>) {
    const [row] = await this.db.insert(starboardSettings).values({ guildId, ...changes })
      .onConflictDoUpdate({ target: starboardSettings.guildId, set: { ...changes, updatedAt: new Date() } }).returning();
    return row!;
  }
  async ignored(guildId: string, channelId: string, tx?: StarboardTransaction) {
    const [row] = await (tx ?? this.db).select().from(starboardIgnoredChannels).where(and(eq(starboardIgnoredChannels.guildId, guildId), eq(starboardIgnoredChannels.channelId, channelId)));
    return !!row;
  }
  postsFrom(guildId: string, channelId?: string) {
    return this.db.select().from(starboardMessages).where(and(eq(starboardMessages.guildId, guildId),
      eq(starboardMessages.status, 'POSTED'), ...(channelId ? [eq(starboardMessages.sourceChannelId, channelId)] : [])));
  }
  private channelKey(guildId: string, channelId: string) { return `starboard-channel:${guildId}:${channelId}`; }
  private destinationKey(guildId: string) { return `starboard-destination:${guildId}`; }
  /** Shared locks permit parallel sources; destination changes and ignored sources acquire exclusive barriers. */
  async reconcileTransaction<T>(guildId: string, channelId: string, work: (tx: StarboardTransaction) => Promise<T>): Promise<T> {
    return this.db.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock_shared(hashtextextended(${this.destinationKey(guildId)}, 0))`);
      await tx.execute(sql`select pg_advisory_xact_lock_shared(hashtextextended(${this.channelKey(guildId, channelId)}, 0))`);
      return work(tx);
    });
  }
  /** Destination NSFW/privacy changes must wait for every in-flight source publication before scanning. */
  async postedAfterDestinationBarrier(guildId: string) {
    return this.db.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${this.destinationKey(guildId)}, 0))`);
      return tx.select().from(starboardMessages).where(and(eq(starboardMessages.guildId, guildId), eq(starboardMessages.status, 'POSTED')));
    });
  }
  /** Barrier for source-channel changes: wait for all in-flight first publications before scanning. */
  async postedAfterChannelBarrier(guildId: string, channelId: string) {
    return this.db.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${this.channelKey(guildId, channelId)}, 0))`);
      return tx.select().from(starboardMessages).where(and(eq(starboardMessages.guildId, guildId),
        eq(starboardMessages.sourceChannelId, channelId), eq(starboardMessages.status, 'POSTED')));
    });
  }
  async ignore(guildId: string, channelId: string) {
    await this.db.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${this.channelKey(guildId, channelId)}, 0))`);
      await tx.insert(starboardIgnoredChannels).values({ guildId, channelId }).onConflictDoNothing();
    });
  }
  async allow(guildId: string, channelId: string) {
    await this.db.delete(starboardIgnoredChannels).where(and(eq(starboardIgnoredChannels.guildId, guildId), eq(starboardIgnoredChannels.channelId, channelId)));
  }
  async transaction<T>(work: (tx: StarboardTransaction) => Promise<T>): Promise<T> { return this.db.transaction(work); }
  /** Insert first to give concurrent first-time deliveries one row to lock. All subsequent reads/writes use tx. */
  async lock(tx: StarboardTransaction, input: { guildId: string; sourceChannelId: string; sourceMessageId: string; sourceAuthorId: string }) {
    await tx.insert(starboardMessages).values({ ...input, status: 'PENDING' }).onConflictDoNothing({ target: [starboardMessages.guildId, starboardMessages.sourceMessageId] });
    const [row] = await tx.select().from(starboardMessages)
      .where(and(eq(starboardMessages.guildId, input.guildId), eq(starboardMessages.sourceMessageId, input.sourceMessageId))).for('update');
    if (!row) throw new Error('Starboard row unavailable after insertion');
    return row;
  }
  /** Bound lazy tombstone retention work per deletion; recent deletes remain durable against late events. */
  async pruneDeleted(tx: StarboardTransaction, guildId: string) {
    await tx.execute(sql`delete from starboard_messages where id in (
      select id from starboard_messages where guild_id = ${guildId} and status = 'DELETED'
      and updated_at < now() - interval '2 days' limit 32 for update skip locked
    )`);
  }
  async get(guildId: string, sourceMessageId: string) {
    const [row] = await this.db.select().from(starboardMessages).where(and(eq(starboardMessages.guildId, guildId), eq(starboardMessages.sourceMessageId, sourceMessageId)));
    return row;
  }
  async save(tx: StarboardTransaction, row: StarboardMessage, values: Partial<typeof starboardMessages.$inferInsert>) {
    await tx.update(starboardMessages).set({ ...values, updatedAt: new Date() }).where(eq(starboardMessages.id, row.id));
  }
}
