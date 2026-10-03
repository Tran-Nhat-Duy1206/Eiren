import type { OperationsRuntimeState, ReconciliationName } from './runtime-state.js';

/** Preserve the caller's startup failure; telemetry must never make failed startup succeed. */
export async function trackStartupProbe(runtime: OperationsRuntimeState, work: () => Promise<void>): Promise<void> {
  runtime.setStartupProbe('PENDING');
  try { await work(); runtime.setStartupProbe('SUCCEEDED'); }
  catch (error) { runtime.setStartupProbe('FAILED', error); throw error; }
}
export async function trackStartupReconciliation(runtime: OperationsRuntimeState, name: ReconciliationName,
  work: () => Promise<unknown>): Promise<void> {
  runtime.setReconciliation(name, 'RUNNING');
  try { await work(); runtime.setReconciliation(name, 'SUCCEEDED'); }
  catch (error) { runtime.setReconciliation(name, 'FAILED', error); throw error; }
}
