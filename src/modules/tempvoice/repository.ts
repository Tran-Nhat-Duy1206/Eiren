import { and, eq, inArray, isNotNull, isNull, lte, sql } from 'drizzle-orm';
import type { Database } from '../../core/database/connection.js';
import { tempvoiceRooms, tempvoiceSettings } from '../../core/database/schema.js';
import { AppError } from '../../core/errors/errors.js';

export type TempvoiceRoom = typeof tempvoiceRooms.$inferSelect;
export type TempvoiceSettings = typeof tempvoiceSettings.$inferSelect;
const live = ['CREATING', 'ACTIVE', 'DELETING'];
export class TempvoiceRepository {
  constructor(private readonly db: Database) {}
  async settings(guildId: string) { const [row] = await this.db.select().from(tempvoiceSettings).where(eq(tempvoiceSettings.guildId, guildId)); return row; }
  async configure(guildId: string, patch: Partial<Pick<TempvoiceSettings, 'enabled' | 'lobbyChannelId' | 'categoryId' | 'userLimit' | 'defaultPrivate'>>) {
    const [row] = await this.db.insert(tempvoiceSettings).values({ guildId, lobbyChannelId: patch.lobbyChannelId ?? null, ...patch, updatedAt: new Date() }).onConflictDoUpdate({ target: tempvoiceSettings.guildId, set: { ...patch, updatedAt: new Date() } }).returning(); return row!;
  }
  async byOwner(guildId: string, ownerId: string) { const [row] = await this.db.select().from(tempvoiceRooms).where(and(eq(tempvoiceRooms.guildId, guildId), eq(tempvoiceRooms.ownerId, ownerId), inArray(tempvoiceRooms.status, live))); return row; }
  async byChannel(guildId: string, channelId: string) { const [row] = await this.db.select().from(tempvoiceRooms).where(and(eq(tempvoiceRooms.guildId, guildId), eq(tempvoiceRooms.channelId, channelId), inArray(tempvoiceRooms.status, live))); return row; }
  async reserve(guildId: string, ownerId: string) {
    return this.db.transaction(async tx => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${guildId + ':' + ownerId}, 0))`);
      const [existing] = await tx.select().from(tempvoiceRooms).where(and(eq(tempvoiceRooms.guildId, guildId), eq(tempvoiceRooms.ownerId, ownerId), inArray(tempvoiceRooms.status, live)));
      if (existing) return { row: existing, created: false };
      const [row] = await tx.insert(tempvoiceRooms).values({ guildId, ownerId, channelId: null, status: 'CREATING' }).returning();
      return { row: row!, created: true };
    });
  }
  async rejoin(guildId: string, ownerId: string, channelId: string, move: () => Promise<void>) {
    return this.db.transaction(async tx => {
      const [row] = await tx.select().from(tempvoiceRooms).where(and(eq(tempvoiceRooms.guildId, guildId), eq(tempvoiceRooms.channelId, channelId))).for('update');
      if (!row || row.ownerId !== ownerId || row.status !== 'ACTIVE') return false;
      await move();
      await tx.update(tempvoiceRooms).set({ emptySince: null, updatedAt: new Date() }).where(eq(tempvoiceRooms.id, row.id));
      return true;
    });
  }
  async attach(id: number, channelId: string) { const [row] = await this.db.update(tempvoiceRooms).set({ channelId, updatedAt: new Date() }).where(and(eq(tempvoiceRooms.id, id), eq(tempvoiceRooms.status, 'CREATING'), isNull(tempvoiceRooms.channelId))).returning(); return row; }
  async activate(id: number) { const [row] = await this.db.update(tempvoiceRooms).set({ status: 'ACTIVE', updatedAt: new Date() }).where(and(eq(tempvoiceRooms.id, id), eq(tempvoiceRooms.status, 'CREATING'), isNotNull(tempvoiceRooms.channelId))).returning(); return row; }
  async close(id: number) { await this.db.update(tempvoiceRooms).set({ status: 'CLOSED', emptySince: null, updatedAt: new Date() }).where(eq(tempvoiceRooms.id, id)); }
  async markEmpty(guildId: string, channelId: string, empty: boolean) {
    await this.db.update(tempvoiceRooms).set({ emptySince: empty ? new Date() : null, updatedAt: new Date() }).where(and(eq(tempvoiceRooms.guildId, guildId), eq(tempvoiceRooms.channelId, channelId), eq(tempvoiceRooms.status, 'ACTIVE'), empty ? isNull(tempvoiceRooms.emptySince) : isNotNull(tempvoiceRooms.emptySince)));
  }
  async pending(now: Date, graceMs: number) { return this.db.select().from(tempvoiceRooms).where(and(eq(tempvoiceRooms.status, 'ACTIVE'), isNotNull(tempvoiceRooms.emptySince), lte(tempvoiceRooms.emptySince, new Date(now.getTime() - graceMs)))); }
  async outstanding() { return this.db.select().from(tempvoiceRooms).where(inArray(tempvoiceRooms.status, live)); }
  /** Row lock serializes bot DB operations; Discord members can still join externally during cleanup. */
  async cleanup(id: number, eligible: (room: TempvoiceRoom) => boolean, remove: (room: TempvoiceRoom) => Promise<boolean | 'occupied'>) {
    return this.db.transaction(async tx => {
      const [room] = await tx.select().from(tempvoiceRooms).where(eq(tempvoiceRooms.id, id)).for('update');
      if (!room || !eligible(room)) return false;
      if (room.channelId) {
        const result = await remove(room);
        if (result === 'occupied') {
          await tx.update(tempvoiceRooms).set({ emptySince: null, status: room.status === 'CREATING' ? 'ACTIVE' : room.status, updatedAt: new Date() }).where(eq(tempvoiceRooms.id, id)); return false;
        }
        if (!result) { await tx.update(tempvoiceRooms).set({ status: 'DELETING', updatedAt: new Date() }).where(eq(tempvoiceRooms.id, id)); return false; }
      }
      await tx.update(tempvoiceRooms).set({ status: 'CLOSED', emptySince: null, updatedAt: new Date() }).where(eq(tempvoiceRooms.id, id)); return true;
    });
  }
  async withActive<T>(guildId: string, channelId: string, actorId: string, action: (room: TempvoiceRoom) => Promise<T>) {
    return this.db.transaction(async tx => {
      const [room] = await tx.select().from(tempvoiceRooms).where(and(eq(tempvoiceRooms.guildId, guildId), eq(tempvoiceRooms.channelId, channelId))).for('update');
      if (!room || room.status !== 'ACTIVE' || room.ownerId !== actorId) throw new AppError('PERMISSION', 'You must own an active temporary room to use this command.');
      return action(room);
    });
  }
  async transfer(guildId: string, channelId: string, ownerId: string, newOwnerId: string, apply: (room: TempvoiceRoom) => Promise<() => Promise<void>>) {
    let undo: (() => Promise<void>) | undefined;
    try { return await this.db.transaction(async tx => {
      // Serialize competing reservations for target owner as well as row operations.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${guildId + ':' + newOwnerId}, 0))`);
      const [room] = await tx.select().from(tempvoiceRooms).where(and(eq(tempvoiceRooms.guildId, guildId), eq(tempvoiceRooms.channelId, channelId))).for('update');
      if (!room || room.status !== 'ACTIVE' || room.ownerId !== ownerId) throw new AppError('PERMISSION', 'You must own an active temporary room.');
      const [other] = await tx.select().from(tempvoiceRooms).where(and(eq(tempvoiceRooms.guildId, guildId), eq(tempvoiceRooms.ownerId, newOwnerId), inArray(tempvoiceRooms.status, live)));
      if (other) throw new AppError('CONFLICT', 'That member already owns or is creating a room.');
      undo = await apply(room);
      const [updated] = await tx.update(tempvoiceRooms).set({ ownerId: newOwnerId, updatedAt: new Date() }).where(eq(tempvoiceRooms.id, room.id)).returning(); return updated!;
    }); } catch (error) {
      if (undo) { try { await undo(); } catch (restoreError) { throw new AppError('CONFLICT', `Owner transfer compensation failed for room ${channelId}; reconciliation required.`); } }
      throw error;
    }
  }
}
