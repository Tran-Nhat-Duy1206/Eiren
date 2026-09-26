import { and, eq } from 'drizzle-orm';
import type { Database } from '../../core/database/connection.js';
import { memberAchievements } from '../../core/database/schema.js';

export type MemberAchievement = typeof memberAchievements.$inferSelect;
export class AchievementRepository {
  constructor(private readonly db: Database) {}

  list(guildId: string, userId: string): Promise<MemberAchievement[]> {
    return this.db.select().from(memberAchievements).where(and(eq(memberAchievements.guildId, guildId), eq(memberAchievements.userId, userId)));
  }

  /** The composite primary key and conflict handling make simultaneous hooks idempotent. */
  async award(guildId: string, userId: string, achievementId: string): Promise<boolean> {
    const rows = await this.db.insert(memberAchievements).values({ guildId, userId, achievementId })
      .onConflictDoNothing().returning({ achievementId: memberAchievements.achievementId });
    return rows.length !== 0;
  }
}
