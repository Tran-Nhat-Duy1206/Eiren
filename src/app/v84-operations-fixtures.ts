import { OperationsRuntimeState } from '../core/operations/runtime-state.js';
import { SchedulerTelemetry } from '../core/operations/scheduler-telemetry.js';
import { EXPECTED_MIGRATION_COUNT, EXPECTED_LATEST_MIGRATION_TAG } from '../core/operations/migration-descriptor.js';
import type { OperationsDashboardView } from '../services/operations-view.js';

/** Synthetic in-process UI/smoke fixture only; never imported by the production entry point. */
export function operationsFixture(): OperationsDashboardView {
  const now = () => Date.UTC(2026, 9, 1);
  const runtime = new OperationsRuntimeState(now);
  runtime.setPhase('RUNNING'); runtime.setStartupProbe('SUCCEEDED');
  runtime.setReconciliation('tempvoice', 'SUCCEEDED'); runtime.setReconciliation('analyticsVoice', 'SUCCEEDED');
  const v5 = new SchedulerTelemetry(['events', 'giveaways', 'tempvoice', 'analytics', 'automation', 'ai-maintenance', 'data-retention', 'subject-request-maintenance'], 30_000, now);
  const moderation = new SchedulerTelemetry(['moderation-expiry'], 30_000, now);
  for (const telemetry of [v5, moderation]) {
    telemetry.start(); telemetry.tickStarted();
    for (let i = 0; i < telemetry.snapshot().jobs.length; i++) { telemetry.jobStarted(i); telemetry.jobCompleted(i); }
    telemetry.tickCompleted();
  }
  // An isolated job failure degrades that job, not scheduler dependency freshness.
  v5.tickStarted(); v5.jobStarted(0); v5.jobCompleted(0, { error: Object.assign(new Error('synthetic fixture'), { code: '08006' }) }); v5.tickCompleted();
  return { process: runtime.snapshot(), readiness: { ready: true, checkedAt: now(), expectedCount: EXPECTED_MIGRATION_COUNT,
    expectedTag: EXPECTED_LATEST_MIGRATION_TAG, database: 'ready', migrations: 'ready', observedCount: EXPECTED_MIGRATION_COUNT,
    observedTag: EXPECTED_LATEST_MIGRATION_TAG, gateway: 'ready', scheduler: 'ready' },
    schedulers: { v5: v5.snapshot(), moderation: moderation.snapshot() },
    guild: { modules: [{ key: 'core', enabled: true, version: 0 }, { key: 'automation', enabled: false, version: 2 }],
      diagnostics: [
        { key: 'automation_uncertain', status: 'ACTIONABLE', count: 1, oldestAt: new Date(now()), ageSeconds: 0 },
        { key: 'audit_gaps', status: 'ACTIONABLE', count: 1, oldestAt: new Date(now()), ageSeconds: 0 },
        ...(['discord_orphans', 'backup_health', 'tls_health', 'historical_failures'] as const).map(key => ({ key, status: 'NOT_TRACKED' as const, count: null, oldestAt: null, ageSeconds: null })),
      ] } };
}
