import type { OperationalDatabase } from './operational-database.js';
import { MIGRATION_DESCRIPTOR as expected } from './migration-descriptor.js';

export interface DatabaseProbeResult {
  database: 'ready' | 'unavailable';
  migrations: 'ready' | 'mismatch' | 'unavailable';
  observedCount?: number;
  observedTag?: string;
}
export type SchedulerReadiness = 'ready' | 'starting' | 'stale' | 'stopped';
export interface ReadinessSnapshot extends DatabaseProbeResult {
  ready: boolean;
  checkedAt: number;
  expectedCount: number;
  expectedTag: string;
  gateway: 'ready' | 'not_ready';
  scheduler: SchedulerReadiness;
}
export interface PublicReadiness {
  status: 'ready' | 'not_ready';
  checks: {
    database: DatabaseProbeResult['database'];
    migrations: DatabaseProbeResult['migrations'];
    gateway: ReadinessSnapshot['gateway'];
    scheduler: SchedulerReadiness;
  };
}
const unavailable: DatabaseProbeResult = { database: 'unavailable', migrations: 'unavailable' };

export async function probeDatabase(reader: Pick<OperationalDatabase, 'query'>): Promise<DatabaseProbeResult> {
  try { await reader.query('SELECT 1'); } catch { return { ...unavailable }; }
  try {
    const { rows } = await reader.query<{ count: string | number; hash: string | null; created_at: string | number | null }>(
      'SELECT (SELECT count(*) FROM drizzle.__drizzle_migrations) AS count, hash, created_at FROM (SELECT 1) AS seed LEFT JOIN LATERAL (SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at DESC, id DESC LIMIT 1) AS latest ON true',
    );
    const row = rows[0];
    const count = Number(row?.count);
    if (!row || !Number.isSafeInteger(count) || count < 0) return { database: 'ready', migrations: 'unavailable' };
    const matches = count === expected.count && Number(row.created_at) === expected.timestamp &&
      (row.hash === expected.hash || row.hash === expected.approvedCrlfHash);
    return { database: 'ready', migrations: matches ? 'ready' : 'mismatch', observedCount: count,
      ...(matches ? { observedTag: expected.tag } : {}) };
  } catch {
    // Includes 42P01: successful SELECT 1 proves database connectivity, not migration readiness.
    return { database: 'ready', migrations: 'unavailable' };
  }
}

function schedulerState(v5: string, moderation: string): SchedulerReadiness {
  if (v5 === 'HEALTHY' && moderation === 'HEALTHY') return 'ready';
  if (v5 === 'STOPPED' || moderation === 'STOPPED') return 'stopped';
  if (v5 === 'STALE' || moderation === 'STALE') return 'stale';
  return 'starting';
}

export class ReadinessService {
  private cached: { result: DatabaseProbeResult; completedAt: number } | undefined;
  private pending: Promise<DatabaseProbeResult> | undefined;
  constructor(
    private readonly probe: () => Promise<DatabaseProbeResult>,
    private readonly gatewayReady: () => boolean,
    private readonly runtimeProvider: () => string,
    private readonly schedulersProvider: () => { v5: string; moderation: string },
    private readonly now: () => number = Date.now,
  ) {}

  private database(): Promise<DatabaseProbeResult> {
    if (this.cached && this.now() - this.cached.completedAt < 2000) return Promise.resolve(this.cached.result);
    if (this.pending) return this.pending;
    const run = async (): Promise<DatabaseProbeResult> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let result: DatabaseProbeResult;
      try {
        result = await Promise.race([Promise.resolve().then(this.probe), new Promise<DatabaseProbeResult>((resolve) => {
          timer = setTimeout(() => resolve({ ...unavailable }), 2200);
          timer.unref();
        })]);
        // Keep dependency details/errors out of both internal and public snapshots.
        result = {
          database: result.database === 'ready' ? 'ready' : 'unavailable',
          migrations: ['ready', 'mismatch', 'unavailable'].includes(result.migrations) ? result.migrations : 'unavailable',
          ...(Number.isSafeInteger(result.observedCount) ? { observedCount: result.observedCount } : {}),
          ...(result.migrations === 'ready' && result.observedTag === expected.tag ? { observedTag: expected.tag } : {}),
        };
      } catch { result = { ...unavailable }; }
      finally { clearTimeout(timer); }
      this.cached = { result, completedAt: this.now() };
      return result;
    };
    this.pending = run().finally(() => { this.pending = undefined; });
    return this.pending;
  }

  async check(): Promise<ReadinessSnapshot> {
    const database = await this.database();
    let gateway: ReadinessSnapshot['gateway'] = 'not_ready';
    let scheduler: SchedulerReadiness = 'starting';
    let running = false;
    try { gateway = this.gatewayReady() ? 'ready' : 'not_ready'; } catch { /* fail closed */ }
    try { running = this.runtimeProvider() === 'RUNNING'; } catch { /* fail closed */ }
    try { const state = this.schedulersProvider(); scheduler = schedulerState(state.v5, state.moderation); } catch { /* fail closed */ }
    return { ...database, gateway, scheduler, checkedAt: this.now(), expectedCount: expected.count,
      expectedTag: expected.tag, ready: running && database.database === 'ready' && database.migrations === 'ready' && gateway === 'ready' && scheduler === 'ready' };
  }
}

export function toPublicReadiness(snapshot: ReadinessSnapshot): PublicReadiness {
  return { status: snapshot.ready ? 'ready' : 'not_ready', checks: { database: snapshot.database,
    migrations: snapshot.migrations, gateway: snapshot.gateway, scheduler: snapshot.scheduler } };
}
