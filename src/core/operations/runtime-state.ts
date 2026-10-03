import { safeFailureCategory, type FailureCategory } from './failures.js';
export type OperationsPhase = 'STARTING' | 'RUNNING' | 'STOPPING';
export type StartupProbeStatus = 'PENDING' | 'SUCCEEDED' | 'FAILED';
export type ReconciliationStatus = 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'NOT_APPLICABLE';
export type ReconciliationName = 'tempvoice' | 'analyticsVoice';
export interface ReconciliationSnapshot { readonly status: ReconciliationStatus; readonly startedAt: Date | null; readonly completedAt: Date | null; readonly failureCategory: FailureCategory | null }
export interface OperationsRuntimeSnapshot { readonly processStartedAt: Date; readonly uptimeMs: number; readonly phase: OperationsPhase; readonly startupProbe: StartupProbeStatus; readonly startupProbeCompletedAt: Date | null; readonly startupProbeFailureCategory: FailureCategory | null; readonly reconciliations: Readonly<Record<ReconciliationName, ReconciliationSnapshot>> }
export class OperationsRuntimeState {
  private readonly started: number;
  private phase: OperationsPhase = 'STARTING';
  private probe: StartupProbeStatus = 'PENDING';
  private probeAt: number | null = null;
  private probeFailure: FailureCategory | null = null;
  private readonly reconciliations: Record<ReconciliationName, { status: ReconciliationStatus; startedAt: number | null; completedAt: number | null; failureCategory: FailureCategory | null }> = {
    tempvoice: { status: 'PENDING', startedAt: null, completedAt: null, failureCategory: null }, analyticsVoice: { status: 'PENDING', startedAt: null, completedAt: null, failureCategory: null },
  };
  constructor(private readonly now: () => number = Date.now) { this.started = now(); }
  get processStartedAt(): Date { return new Date(this.started); }
  setPhase(phase: OperationsPhase) { this.phase = phase; }
  setStartupProbe(status: StartupProbeStatus, error?: unknown) { this.probe = status; this.probeAt = status === 'PENDING' ? null : this.now(); this.probeFailure = status === 'FAILED' ? safeFailureCategory(error) : null; }
  setReconciliation(name: ReconciliationName, status: ReconciliationStatus, error?: unknown) {
    const value = this.reconciliations[name]; value.status = status;
    if (status === 'PENDING') { value.startedAt = null; value.completedAt = null; }
    else if (status === 'RUNNING') { value.startedAt = this.now(); value.completedAt = null; }
    else value.completedAt = this.now();
    value.failureCategory = status === 'FAILED' ? safeFailureCategory(error) : null;
  }
  snapshot(): OperationsRuntimeSnapshot {
    const copy = (name: ReconciliationName): ReconciliationSnapshot => { const value = this.reconciliations[name]; return Object.freeze({ ...value, startedAt: value.startedAt === null ? null : new Date(value.startedAt), completedAt: value.completedAt === null ? null : new Date(value.completedAt) }); };
    return Object.freeze({ processStartedAt: this.processStartedAt, uptimeMs: Math.max(0, this.now() - this.started), phase: this.phase, startupProbe: this.probe, startupProbeCompletedAt: this.probeAt === null ? null : new Date(this.probeAt), startupProbeFailureCategory: this.probeFailure, reconciliations: Object.freeze({ tempvoice: copy('tempvoice'), analyticsVoice: copy('analyticsVoice') }) });
  }
}
