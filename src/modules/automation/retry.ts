export const AUTOMATION_EXECUTION_TTL_MS = 86_400_000;
export const AUTOMATION_LEASE_MS = 60_000;

/** Pure deterministic retry delay; only short-lived, pre-effect work may use it. */
export function automationRetryDelayMs(attempts: number): number {
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 5)
    throw new Error('Invalid automation retry attempt');
  return Math.min(600_000, 30_000 * 2 ** (attempts - 1));
}
export function automationExecutionExpired(createdAt: Date, now: Date): boolean {
  if (!Number.isFinite(createdAt.getTime()) || !Number.isFinite(now.getTime()))
    throw new Error('Invalid automation execution time');
  return now.getTime() - createdAt.getTime() >= AUTOMATION_EXECUTION_TTL_MS;
}
