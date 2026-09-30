import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { Database } from '../../core/database/connection.js';
import { DashboardReadService } from './dashboard-read-service.js';

function fixture() {
  const queries: { fields: string[]; where: string; params: unknown[]; limit: number }[] = [];
  const dialect = new PgDialect();
  const db = { select(fields?: Record<string, unknown>) {
    const state = { fields: Object.keys(fields ?? {}), where: '', params: [] as unknown[], limit: 0 };
    const chain = {
      from: () => chain, innerJoin: () => chain, leftJoin: () => chain,
      where: (condition: Parameters<PgDialect['sqlToQuery']>[0]) => {
        const query = dialect.sqlToQuery(condition);
        state.where = query.sql; state.params = query.params;
        return chain;
      },
      orderBy: () => chain,
      limit: (value: number) => { state.limit = value; queries.push(state); return Promise.resolve([]); },
    };
    return chain;
  } } as unknown as Database;
  return { read: new DashboardReadService(db), queries };
}

describe('dashboard guild-scoped read projections', () => {
  it('binds guild identity and caps each general list to 50', async () => {
    const { read, queries } = fixture();
    await Promise.all([read.listCases('guild-A', 50), read.listReports('guild-B', 1), read.tickets('guild-A'), read.suggestions('guild-A'), read.events('guild-A'), read.giveaways('guild-A'), read.roles('guild-A'), read.levels('guild-A'), read.botSettings('guild-A'), read.overview('guild-A'), read.giveawayOutcomes('guild-A', 10), read.listRoleOptions('guild-A', 10)]);
    expect(queries.length).toBeGreaterThan(20);
    for (const query of queries) {
      expect(query.where).toContain('guild_id');
      expect(query.params).toContain(query.params.includes('guild-B') ? 'guild-B' : 'guild-A');
      expect(query.limit).toBeGreaterThan(0);
      expect(query.limit).toBeLessThanOrEqual(50);
    }
    expect(queries.find(query => query.params.includes('guild-B'))?.params).not.toContain('guild-A');
  });
  it('excludes private report text, case reasons, ticket transcripts and suggestion content', async () => {
    const { read, queries } = fixture();
    await read.listCases('guild-A'); await read.listReports('guild-A'); await read.tickets('guild-A'); await read.suggestions('guild-A');
    for (const query of queries) {
      expect(query.fields).not.toContain('description');
      expect(query.fields).not.toContain('reason');
      expect(query.fields).not.toContain('transcript');
      expect(query.fields).not.toContain('content');
      expect(query.fields).not.toContain('evidenceUrl');
      expect(query.fields).not.toContain('resolutionNote');
    }
  });
  it('rejects unbounded requests and does not query for an empty member lookup', async () => {
    const { read, queries } = fixture();
    expect(() => read.listCases('guild-A', 51)).toThrow(RangeError);
    expect(() => read.listReports('guild-A', 0)).toThrow(RangeError);
    expect(() => read.events('', 10)).toThrow(RangeError);
    await expect(read.memberLookup('guild-A', Array(51).fill('user'))).rejects.toThrow(RangeError);
    expect(await read.memberLookup('guild-A', [])).toEqual([]);
    expect(queries).toEqual([]);
  });
  it('looks up only Discord-supplied current member IDs within its guild', async () => {
    const { read, queries } = fixture();
    const members = await read.memberLookup('guild-A', ['member-1', 'member-1', 'member-2']);
    expect(members.map(member => member.userId)).toEqual(['member-1', 'member-2']);
    expect(queries).toHaveLength(2);
    for (const query of queries) {
      expect(query.params).toContain('guild-A');
      expect(query.params).toContain('member-1');
      expect(query.params).toContain('member-2');
      expect(query.limit).toBe(50);
    }
  });
});
