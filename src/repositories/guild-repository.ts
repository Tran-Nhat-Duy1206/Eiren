import { and, eq, sql } from 'drizzle-orm';
import type { Database } from '../core/database/connection.js';
import { guilds, guildSettings, guildModules, guildPermissionRoles } from '../core/database/schema.js';

export type SettingChanges = Partial<Pick<typeof guildSettings.$inferInsert,
  'language' | 'timezone' | 'logChannelId' | 'modLogChannelId' | 'securityLogChannelId' | 'welcomeChannelId' | 'ticketCategoryId' | 'verifiedRoleId' | 'quarantineRoleId'>>;

export class GuildRepository {
  constructor(private readonly db: Database) {}

  async setup(guildId: string) {
    return this.db.transaction(async tx => {
      await tx.insert(guilds).values({ id: guildId }).onConflictDoNothing();
      await tx.insert(guildSettings).values({ guildId, setupCompletedAt: new Date() }).onConflictDoNothing();
      const [settings] = await tx.select().from(guildSettings).where(eq(guildSettings.guildId, guildId));
      return settings!;
    });
  }
  async getSettings(guildId: string) {
    const [settings] = await this.db.select().from(guildSettings).where(eq(guildSettings.guildId, guildId));
    return settings;
  }
  async updateSettings(guildId: string, changes: SettingChanges) {
    const [settings] = await this.db.update(guildSettings).set({ ...changes, updatedAt: new Date() })
      .where(eq(guildSettings.guildId, guildId)).returning();
    return settings;
  }
  async getRoleLevels(guildId: string, roleIds: string[]) {
    if (!roleIds.length) return [];
    const roles = await this.db.select().from(guildPermissionRoles).where(eq(guildPermissionRoles.guildId, guildId));
    return roles.filter(role => roleIds.includes(role.roleId)).map(role => role.level);
  }
  async getRoleMappings(guildId: string) {
    return this.db.select().from(guildPermissionRoles).where(eq(guildPermissionRoles.guildId, guildId));
  }
  async setRoleLevel(guildId: string, roleId: string, level: string) {
    await this.db.insert(guildPermissionRoles).values({ guildId, roleId, level })
      .onConflictDoUpdate({ target: [guildPermissionRoles.guildId, guildPermissionRoles.roleId], set: { level } });
  }
  async removeRoleLevel(guildId: string, roleId: string) {
    await this.db.delete(guildPermissionRoles).where(and(eq(guildPermissionRoles.guildId, guildId), eq(guildPermissionRoles.roleId, roleId)));
  }
  async getModuleState(guildId: string, moduleKey: string) {
    const [state] = await this.db.select().from(guildModules).where(and(eq(guildModules.guildId, guildId), eq(guildModules.moduleKey, moduleKey)));
    return state?.enabled;
  }
  async getModuleEpoch(guildId: string, moduleKey: string) {
    const [state] = await this.db.select({ version: guildModules.version }).from(guildModules)
      .where(and(eq(guildModules.guildId, guildId), eq(guildModules.moduleKey, moduleKey)));
    return state?.version ?? 0;
  }
  async setModuleState(guildId: string, moduleKey: string, enabled: boolean, updatedBy: string) {
    const write = async (db: Database) => db.insert(guildModules).values({ guildId, moduleKey, enabled, updatedBy, version: 1 })
      .onConflictDoUpdate({ target: [guildModules.guildId, guildModules.moduleKey],
        set: { enabled, updatedBy, updatedAt: new Date(), version: sql`${guildModules.version} + 1` } });
    if (moduleKey !== 'analytics') { await write(this.db); return; }
    // Toggle and all voice writers share a guild advisory lock; a voice transaction rechecks this row.
    await this.db.transaction(async tx => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${guildId}), 0)`);
      await write(tx as unknown as Database);
    });
  }
  async listModuleStates(guildId: string) {
    return this.db.select().from(guildModules).where(eq(guildModules.guildId, guildId));
  }
}
