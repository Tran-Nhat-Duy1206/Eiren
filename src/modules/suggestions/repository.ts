import { and, eq, sql } from 'drizzle-orm';
import type { Database } from '../../core/database/connection.js';
import { suggestionSettings, suggestions, suggestionVotes } from '../../core/database/schema.js';

export const statuses = ['PENDING', 'UNDER_REVIEW', 'ACCEPTED', 'REJECTED', 'IMPLEMENTED'] as const;
export type SuggestionStatus = typeof statuses[number];
export type Suggestion = typeof suggestions.$inferSelect;

export class SuggestionRepository {
  constructor(private readonly db: Database) {}
  async settings(guildId: string) {
    const [row] = await this.db.select().from(suggestionSettings).where(eq(suggestionSettings.guildId, guildId));
    return row;
  }
  async configure(guildId: string, channelId: string | null) {
    const [row] = await this.db.insert(suggestionSettings).values({ guildId, channelId })
      .onConflictDoUpdate({ target: suggestionSettings.guildId, set: { channelId } }).returning();
    return row!;
  }
  async create(guildId: string, authorId: string, content: string, channelId: string) {
    const [row] = await this.db.insert(suggestions).values({ guildId, authorId, content, channelId, status: 'PENDING' }).returning();
    return row!;
  }
  async get(guildId: string, id: number) {
    const [row] = await this.db.select().from(suggestions).where(and(eq(suggestions.guildId, guildId), eq(suggestions.id, id)));
    return row;
  }
  async attach(guildId: string, id: number, channelId: string, messageId: string) {
    const [row] = await this.db.update(suggestions).set({ channelId, messageId, updatedAt: new Date() })
      .where(and(eq(suggestions.guildId, guildId), eq(suggestions.id, id), sql`${suggestions.messageId} IS NULL`)).returning();
    return row;
  }
  async setStatus(guildId: string, id: number, status: SuggestionStatus, reviewedBy: string) {
    const [row] = await this.db.update(suggestions).set({ status, reviewedBy, updatedAt: new Date() })
      .where(and(eq(suggestions.guildId, guildId), eq(suggestions.id, id))).returning();
    return row;
  }
  async respond(guildId: string, id: number, staffResponse: string, reviewedBy: string) {
    const [row] = await this.db.update(suggestions).set({ staffResponse, reviewedBy, updatedAt: new Date() })
      .where(and(eq(suggestions.guildId, guildId), eq(suggestions.id, id))).returning();
    return row;
  }
  /** Upsert is atomic on the composite PK. A repeated button delivery is a no-op, not a second toggle. */
  async vote(suggestionId: number, userId: string, vote: 1 | -1) {
    const [row] = await this.db.insert(suggestionVotes).values({ suggestionId, userId, vote })
      .onConflictDoUpdate({ target: [suggestionVotes.suggestionId, suggestionVotes.userId],
        set: { vote, updatedAt: new Date() }, setWhere: sql`${suggestionVotes.vote} <> ${vote}` }).returning();
    return row !== undefined;
  }
  async totals(suggestionId: number) {
    const [row] = await this.db.select({ up: sql<number>`count(*) FILTER (WHERE ${suggestionVotes.vote} = 1)::integer`,
      down: sql<number>`count(*) FILTER (WHERE ${suggestionVotes.vote} = -1)::integer` })
      .from(suggestionVotes).where(eq(suggestionVotes.suggestionId, suggestionId));
    return { up: row?.up ?? 0, down: row?.down ?? 0 };
  }
}
