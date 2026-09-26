import { and, eq, asc, sql } from 'drizzle-orm';
import type { Database } from '../../core/database/connection.js';
import { roleMenus, roleMenuOptions, guildPermissionRoles } from '../../core/database/schema.js';

export type RoleMenu = typeof roleMenus.$inferSelect;
export type RoleMenuOption = typeof roleMenuOptions.$inferSelect;
export type RoleMenuTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];
export class RoleMenuRepository {
  constructor(private readonly db: Database) {}
  async create(values: typeof roleMenus.$inferInsert) {
    const [menu] = await this.db.insert(roleMenus).values(values).returning();
    return menu!;
  }
  async get(guildId: string, id: number, tx?: RoleMenuTransaction) {
    const [menu] = await (tx ?? this.db).select().from(roleMenus).where(and(eq(roleMenus.guildId, guildId), eq(roleMenus.id, id)));
    return menu;
  }
  list(guildId: string) { return this.db.select().from(roleMenus).where(eq(roleMenus.guildId, guildId)).orderBy(asc(roleMenus.id)); }
  options(id: number, tx?: RoleMenuTransaction) { return (tx ?? this.db).select().from(roleMenuOptions).where(eq(roleMenuOptions.menuId, id)).orderBy(asc(roleMenuOptions.position), asc(roleMenuOptions.id)); }
  async update(guildId: string, id: number, patch: Partial<typeof roleMenus.$inferInsert>) {
    const [menu] = await this.db.update(roleMenus).set({ ...patch, updatedAt: new Date() })
      .where(and(eq(roleMenus.guildId, guildId), eq(roleMenus.id, id))).returning();
    return menu;
  }
  async delete(guildId: string, id: number) {
    const [menu] = await this.db.delete(roleMenus).where(and(eq(roleMenus.guildId, guildId), eq(roleMenus.id, id))).returning();
    return menu;
  }
  async addOption(values: typeof roleMenuOptions.$inferInsert) {
    const [option] = await this.db.insert(roleMenuOptions).values(values).returning();
    return option!;
  }
  async removeOption(menuId: number, id: number) {
    const [option] = await this.db.delete(roleMenuOptions).where(and(eq(roleMenuOptions.menuId, menuId), eq(roleMenuOptions.id, id))).returning();
    return option;
  }
  async isPermissionRole(guildId: string, roleId: string, tx?: RoleMenuTransaction) {
    const [mapping] = await (tx ?? this.db).select({ roleId: guildPermissionRoles.roleId }).from(guildPermissionRoles)
      .where(and(eq(guildPermissionRoles.guildId, guildId), eq(guildPermissionRoles.roleId, roleId)));
    return !!mapping;
  }
  /** Use the SAME connection for reads and the advisory lock: the pool must not starve under concurrent clicks. */
  async locked<T>(guildId: string, menuId: number, userId: string, work: (tx: RoleMenuTransaction) => Promise<T>): Promise<T> {
    return this.db.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`roles:${guildId}:${menuId}:${userId}`}, 0))`);
      return work(tx);
    });
  }
}
