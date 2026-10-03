import { describe, expect, it } from 'vitest';
import { OperationsRuntimeState } from './runtime-state.js';
import { SchedulerTelemetry } from './scheduler-telemetry.js';
import { safeFailureCategory, ScheduledStageError } from './failures.js';

describe('safe operations state', () => {
  it('tracks lifecycle and reconciliation timestamps without retaining errors', () => {
    let clock = 100; const runtime = new OperationsRuntimeState(() => clock);
    expect(runtime.snapshot()).toMatchObject({ phase: 'STARTING', startupProbe: 'PENDING', processStartedAt: new Date(100), uptimeMs: 0 });
    runtime.setStartupProbe('FAILED', Object.assign(new Error('PRIVATE'), { code: '08006' }));
    runtime.setReconciliation('tempvoice', 'RUNNING'); clock = 120;
    runtime.setReconciliation('tempvoice', 'FAILED', Object.assign(new Error('PRIVATE'), { code: 50013 }));
    runtime.setReconciliation('analyticsVoice', 'NOT_APPLICABLE'); runtime.setPhase('STOPPING');
    const snapshot = runtime.snapshot();
    expect(snapshot).toMatchObject({ phase: 'STOPPING', uptimeMs: 20, startupProbeFailureCategory: 'DATABASE', reconciliations: { tempvoice: { status: 'FAILED', startedAt: new Date(100), completedAt: new Date(120), failureCategory: 'PERMISSION' }, analyticsVoice: { status: 'NOT_APPLICABLE' } } });
    snapshot.processStartedAt.setTime(0); expect(runtime.processStartedAt.getTime()).toBe(100);
    expect(Object.isFrozen(snapshot.reconciliations.tempvoice)).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain('PRIVATE');
  });
  it('bounds categories and stage labels, traverses causes and cycles', () => {
    expect(safeFailureCategory(new ScheduledStageError('PRIVATE_STAGE', Object.assign(new Error('SECRET'), { code: '23505' })))).toBe('CONFLICT');
    expect(new ScheduledStageError('PRIVATE_STAGE', null).stage).toBeUndefined();
    expect(safeFailureCategory({ name: 'SECRET' })).toBe('UNKNOWN');
    const cycle: { cause?: unknown } = {}; cycle.cause = cycle; expect(safeFailureCategory(cycle)).toBe('UNKNOWN');
    for (const [error, category] of [[{ code: 'ETIMEDOUT' }, 'TIMEOUT'], [{ name: 'DiscordAPIError' }, 'DISCORD'], [{ name: 'ZodError' }, 'VALIDATION'], [new TypeError('secret'), 'INTERNAL']] as const) expect(safeFailureCategory(error)).toBe(category);
  });
  it('uses explicit job outcomes at equal timestamps and preserves last-failure metadata after recovery', () => {
    const telemetry = new SchedulerTelemetry(['analytics'], 30_000, () => 42);
    expect(telemetry.snapshot().jobs[0]!.state).toBe('STARTING');
    telemetry.tickStarted(); telemetry.jobStarted(0);
    expect(telemetry.snapshot().jobs[0]!.state).toBe('RUNNING');
    telemetry.jobCompleted(0, { error: new ScheduledStageError('analytics.runDue', { code: '08006' }) });
    expect(telemetry.snapshot().jobs[0]!.state).toBe('DEGRADED');
    telemetry.tickCompleted(); telemetry.tickStarted(); telemetry.jobStarted(0); telemetry.jobCompleted(0); telemetry.tickCompleted();
    expect(telemetry.snapshot().jobs[0]).toMatchObject({ state: 'HEALTHY', lastAttemptAt: new Date(42), lastSuccessAt: new Date(42), lastFailureAt: new Date(42), lastFailureCategory: 'DATABASE', stage: 'analytics.runDue' });
  });
  it('is stale before first completion and returns detached frozen snapshot metadata', () => {
    let clock = 0; const telemetry = new SchedulerTelemetry(['events'], 30_000, () => clock);
    telemetry.start(); clock = 90_001; expect(telemetry.snapshot().state).toBe('STALE');
    telemetry.tickStarted(); telemetry.jobStarted(0); clock++; telemetry.jobCompleted(0); telemetry.tickCompleted();
    const snapshot = telemetry.snapshot(); expect(snapshot.state).toBe('HEALTHY');
    snapshot.jobs[0]!.lastSuccessAt!.setTime(0); expect(telemetry.snapshot().jobs[0]!.lastSuccessAt!.getTime()).toBe(clock);
    expect(Object.isFrozen(snapshot.jobs)).toBe(true); expect(Object.isFrozen(snapshot.jobs[0])).toBe(true);
  });
});
