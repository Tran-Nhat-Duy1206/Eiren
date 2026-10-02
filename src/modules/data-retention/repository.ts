import { sql } from 'drizzle-orm';
import type { Database } from '../../core/database/connection.js';
import { appeals, reports, tickets } from '../../core/database/schema.js';
import type { RetentionCounts, RetentionWindows } from './contracts.js';

export type RetentionTx = Parameters<Parameters<Database['transaction']>[0]>[0];
export type Executor = Database | RetentionTx;
export const clock = sql`clock_timestamp()`;
// Stable database statement time permits the terminal-time index range bound.
const cutoff = (days: number) => sql`statement_timestamp() - (${days} * interval '1 day')`;

export function eligible(domain: 'TICKET' | 'REPORT' | 'APPEAL', days: number) {
  switch (domain) {
    case 'TICKET': return sql`${tickets.status} = 'CLOSED' AND ${tickets.closedAt} <= ${cutoff(days)} AND ${tickets.transcript} IS NOT NULL AND ${tickets.transcriptRedactedAt} IS NULL AND ${tickets.retentionHold} = false`;
    case 'REPORT': return sql`${reports.status} = 'CLOSED' AND ${reports.closedAt} <= ${cutoff(days)} AND ${reports.description} IS NOT NULL AND ${reports.narrativeRedactedAt} IS NULL AND ${reports.retentionHold} = false`;
    case 'APPEAL': return sql`${appeals.status} IN ('ACCEPTED','REJECTED') AND ${appeals.reviewedAt} <= ${cutoff(days)} AND ${appeals.reason} IS NOT NULL AND ${appeals.narrativeRedactedAt} IS NULL AND ${appeals.retentionHold} = false`;
  }
}

export async function eligibleCounts(db: Executor, guildId: string, windows: RetentionWindows): Promise<RetentionCounts> {
  // A transaction uses one PostgreSQL client; await each query rather than queueing
  // concurrent client.query calls (pg@9 removes that behavior).
  const ticket = await db.execute(sql`SELECT count(*)::int AS count FROM tickets WHERE guild_id = ${guildId} AND ${eligible('TICKET', windows.ticketDays)}`);
  const report = await db.execute(sql`SELECT count(*)::int AS count FROM reports WHERE guild_id = ${guildId} AND ${eligible('REPORT', windows.reportDays)}`);
  const appeal = await db.execute(sql`SELECT count(*)::int AS count FROM appeals WHERE guild_id = ${guildId} AND ${eligible('APPEAL', windows.appealDays)}`);
  return { ticket: Number(ticket.rows[0]?.count ?? 0), report: Number(report.rows[0]?.count ?? 0), appeal: Number(appeal.rows[0]?.count ?? 0) };
}

export async function holdCounts(db: Executor, guildId: string): Promise<RetentionCounts> {
  const [ticket, report, appeal] = await Promise.all([
    db.execute(sql`SELECT count(*)::int AS count FROM tickets WHERE guild_id = ${guildId} AND retention_hold`),
    db.execute(sql`SELECT count(*)::int AS count FROM reports WHERE guild_id = ${guildId} AND retention_hold`),
    db.execute(sql`SELECT count(*)::int AS count FROM appeals WHERE guild_id = ${guildId} AND retention_hold`),
  ]);
  return { ticket: Number(ticket.rows[0]?.count ?? 0), report: Number(report.rows[0]?.count ?? 0), appeal: Number(appeal.rows[0]?.count ?? 0) };
}
