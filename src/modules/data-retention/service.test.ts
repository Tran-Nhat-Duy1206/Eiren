import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { DataRetentionService } from './service.js';

const actor = { guildId: '123456789012345678', userId: '234567890123456789', guildOwnerId: '234567890123456789' };
const dialect = new PgDialect();
describe('retention service boundaries', () => {
  it('rejects malformed UUIDs explicitly before any database access', async () => {
    const db = { execute: vi.fn(), transaction: vi.fn() };
    const service = new DataRetentionService(db as never);
    for (const id of ['', 'not-a-uuid', '123e4567-e89b-42d3-a456-426614174000-extra']) {
      await expect(service.getPreview(actor, id)).rejects.toMatchObject({ code: 'VALIDATION' });
      await expect(service.confirm(actor, id)).rejects.toMatchObject({ code: 'VALIDATION' });
    }
    expect(db.execute).not.toHaveBeenCalled(); expect(db.transaction).not.toHaveBeenCalled();
  });
  it('uses a UUID key with guild and requester predicates', async () => {
    const execute = vi.fn(async (_statement: Parameters<PgDialect['sqlToQuery']>[0]) => ({ rows: [] }));
    const service = new DataRetentionService({ execute } as never);
    await expect(service.getPreview(actor, '123e4567-e89b-42d3-a456-426614174000')).resolves.toBeNull();
    const query = dialect.sqlToQuery(execute.mock.calls[0]![0] as never);
    expect(query.sql).toContain('WHERE id ='); expect(query.sql).not.toContain('id::text');
    expect(query.params).toContain(actor.guildId); expect(query.params).toContain(actor.userId);
  });
  it('lists bounded metadata-only holds across all guild-scoped domains while preserving counts', async () => {
    const queries: ReturnType<PgDialect['sqlToQuery']>[] = [];
    const execute = vi.fn(async (statement: Parameters<PgDialect['sqlToQuery']>[0]) => {
      const query = dialect.sqlToQuery(statement); queries.push(query);
      if (query.sql.includes('AS holds')) return { rows: [{ domain: 'APPEAL', record_id: 7, held_by: actor.userId, held_at: new Date(0), reason: 'PRIVATE' }] };
      if (query.sql.includes('count(*)')) return { rows: [{ count: 12 }] };
      return { rows: [] };
    });
    const status = await new DataRetentionService({ execute } as never).status(actor.guildId);
    expect(status.holdCounts).toEqual({ ticket: 12, report: 12, appeal: 12 });
    expect(status.activeHolds).toEqual([{ domain: 'APPEAL', recordId: 7, heldBy: actor.userId, heldAt: new Date(0) }]);
    expect(JSON.stringify(status)).not.toContain('PRIVATE');
    const query = queries.find(q => q.sql.includes('AS holds'))!;
    expect(query.params).toEqual([actor.guildId, actor.guildId, actor.guildId]);
    for (const table of ['tickets', 'reports', 'appeals']) expect(query.sql).toContain(`FROM ${table} WHERE guild_id =`);
    expect(query.sql).toContain('LIMIT 50'); expect(query.sql).not.toContain('SELECT *');
  });
});
