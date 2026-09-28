import type { Database } from '../../core/database/connection.js';
import { dashboardAuditLog } from '../../core/database/schema.js';

export type DashboardAuditEntry = Readonly<{
  guildId: string;
  actorUserId: string;
  action: string;
  targetType: string;
  targetId?: string | null;
  success: boolean;
  requestId: string;
  createdAt?: Date;
}>;

/** Persist only explicitly selected audit columns; no request object or payload is accepted. */
export class DashboardAudit {
  constructor(private readonly db: Pick<Database, 'insert'>) {}

  async record(entry: DashboardAuditEntry): Promise<void> {
    const snowflake = /^\d{17,20}$/;
    const label = /^[a-zA-Z][a-zA-Z0-9_.:-]{0,79}$/;
    const identifier = /^[a-zA-Z0-9_-]{1,128}$/;
    if (!snowflake.test(entry.guildId) || !snowflake.test(entry.actorUserId)
      || !label.test(entry.action) || !label.test(entry.targetType)
      || (entry.targetId != null && !identifier.test(entry.targetId))
      || !identifier.test(entry.requestId) || typeof entry.success !== 'boolean'
      || (entry.createdAt !== undefined && (!(entry.createdAt instanceof Date) || !Number.isFinite(entry.createdAt.getTime())))) {
      throw new TypeError('Invalid dashboard audit metadata');
    }
    await this.db.insert(dashboardAuditLog).values({
      guildId: entry.guildId,
      actorUserId: entry.actorUserId,
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId ?? null,
      success: entry.success,
      requestId: entry.requestId,
      createdAt: entry.createdAt ?? new Date(),
    });
  }
}
