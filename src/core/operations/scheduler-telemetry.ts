import { safeFailureCategory, safeErrorStage, type FailureCategory, type ScheduledStage } from './failures.js';
export type SchedulerState = 'STARTING' | 'HEALTHY' | 'STALE' | 'STOPPED';
export type JobTelemetryState = 'STARTING' | 'RUNNING' | 'HEALTHY' | 'DEGRADED';
export interface JobTelemetrySnapshot {
  readonly state: JobTelemetryState;
  readonly name: string; readonly lastAttemptAt: Date | null; readonly lastSuccessAt: Date | null;
  readonly lastFailureAt: Date | null; readonly lastDurationMs: number | null;
  readonly currentRunningSince: Date | null; readonly lastFailureCategory: FailureCategory | null;
  readonly stage: ScheduledStage | null;
}
export interface SchedulerTelemetrySnapshot {
  readonly state: SchedulerState; readonly intervalMs: number; readonly startedAt: Date | null; readonly stoppedAt: Date | null;
  readonly tickCount: number; readonly lastTickStartedAt: Date | null; readonly lastTickCompletedAt: Date | null;
  readonly activeTickStartedAt: Date | null; readonly running: boolean; readonly jobs: readonly JobTelemetrySnapshot[];
}
type Job = { state: JobTelemetryState; name: string; lastAttemptAt: number | null; lastSuccessAt: number | null; lastFailureAt: number | null; lastDurationMs: number | null; currentRunningSince: number | null; lastFailureCategory: FailureCategory | null; stage: ScheduledStage | null };
const date = (value: number | null) => value === null ? null : new Date(value);
export class SchedulerTelemetry {
  private startedAt: number | null = null;
  private stoppedAt: number | null = null;
  private tickCount = 0;
  private lastTickStartedAt: number | null = null;
  private lastTickCompletedAt: number | null = null;
  private activeTickStartedAt: number | null = null;
  private readonly jobs: Job[];
  constructor(jobNames: readonly string[], readonly intervalMs = 30_000, private readonly now: () => number = Date.now) {
    this.jobs = jobNames.map(name => ({ state: 'STARTING', name, lastAttemptAt: null, lastSuccessAt: null, lastFailureAt: null, lastDurationMs: null, currentRunningSince: null, lastFailureCategory: null, stage: null }));
  }
  start() { if (this.startedAt === null || this.stoppedAt !== null) { this.startedAt = this.now(); this.stoppedAt = null; this.lastTickCompletedAt = null; } }
  stop() { this.stoppedAt = this.now(); }
  tickStarted() { if (this.startedAt === null) this.start(); this.lastTickStartedAt = this.activeTickStartedAt = this.now(); this.tickCount++; }
  tickCompleted() { this.lastTickCompletedAt = this.now(); this.activeTickStartedAt = null; }
  jobStarted(index: number) { const job = this.jobs[index]!; job.state = 'RUNNING'; job.lastAttemptAt = job.currentRunningSince = this.now(); }
  jobCompleted(index: number, outcome: { error: unknown } | null = null) {
    const job = this.jobs[index]!; const now = this.now();
    job.lastDurationMs = Math.max(0, now - (job.currentRunningSince ?? now)); job.currentRunningSince = null;
    if (outcome) { job.state = 'DEGRADED'; job.lastFailureAt = now; job.lastFailureCategory = safeFailureCategory(outcome.error); job.stage = safeErrorStage(outcome.error) ?? null; }
    else { job.state = 'HEALTHY'; job.lastSuccessAt = now; }
  }
  snapshot(): SchedulerTelemetrySnapshot {
    const now = this.now(); const threshold = Math.max(3 * this.intervalMs, 90_000);
    const stale = (value: number | null) => value !== null && now - value > threshold;
    const state: SchedulerState = this.stoppedAt !== null ? 'STOPPED' : stale(this.activeTickStartedAt) || stale(this.lastTickCompletedAt ?? this.startedAt) ? 'STALE' : this.lastTickCompletedAt === null ? 'STARTING' : 'HEALTHY';
    return Object.freeze({ state, intervalMs: this.intervalMs, startedAt: date(this.startedAt), stoppedAt: date(this.stoppedAt), tickCount: this.tickCount, lastTickStartedAt: date(this.lastTickStartedAt), lastTickCompletedAt: date(this.lastTickCompletedAt), activeTickStartedAt: date(this.activeTickStartedAt), running: this.activeTickStartedAt !== null,
      jobs: Object.freeze(this.jobs.map(job => Object.freeze({ ...job, lastAttemptAt: date(job.lastAttemptAt), lastSuccessAt: date(job.lastSuccessAt), lastFailureAt: date(job.lastFailureAt), currentRunningSince: date(job.currentRunningSince) }))) });
  }
}
