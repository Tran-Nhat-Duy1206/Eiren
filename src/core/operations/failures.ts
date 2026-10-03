export type FailureCategory = 'DATABASE' | 'DISCORD' | 'TIMEOUT' | 'CONFLICT' | 'VALIDATION' | 'PERMISSION' | 'INTERNAL' | 'UNKNOWN';
const stages = ['subject-request.metadata-cleanup', 'analytics.runDue', 'dashboardAuth.cleanupExpired', 'analytics.moduleCheck', 'analytics.voiceBoundary', 'analytics.observedHumanVoice', 'analytics.reconcileVoice', 'analytics.heartbeat', 'automation.generate', 'automation.recover', 'automation.claim', 'automation.rule', 'automation.defer', 'automation.finalize', 'automation.prune', 'automation.worker', 'analytics.runDue.analytics_event_dedupe', 'analytics.runDue.analytics_guild_hourly', 'analytics.runDue.analytics_channel_hourly', 'analytics.runDue.analytics_command_hourly', 'analytics.runDue.analytics_member_state', 'analytics.runDue.analytics_active_voice_sessions'] as const;
export type ScheduledStage = typeof stages[number];
export function safeScheduledStage(stage: string): ScheduledStage | undefined { return stages.find(value => value === stage); }
export class ScheduledStageError extends Error {
  readonly stage: ScheduledStage | undefined;
  constructor(stage: string, cause: unknown) { super('Scheduled stage failed', { cause }); this.stage = safeScheduledStage(stage); }
}
export function safeErrorStage(error: unknown): ScheduledStage | undefined {
  try { return error instanceof ScheduledStageError ? safeScheduledStage(error.stage ?? '') : undefined; }
  catch { return undefined; }
}
/** Classify only bounded codes/names; never return exception text or arbitrary names. */
export function safeFailureCategory(error: unknown): FailureCategory {
  try {
  const seen = new Set<unknown>();
  for (let depth = 0; depth < 5 && error && typeof error === 'object' && !seen.has(error); depth++) {
    seen.add(error);
    const value = error as { code?: unknown; name?: unknown; cause?: unknown };
    const code = value.code;
    if (code === 'DATABASE' || code === 'CONFLICT' || code === 'VALIDATION' || code === 'PERMISSION') return code;
    if (code === 'ETIMEDOUT' || value.name === 'TimeoutError' || value.name === 'AbortError') return 'TIMEOUT';
    if (code === '23505' || code === '40001' || code === '40P01') return 'CONFLICT';
    if (code === '42501' || code === 50013 || code === 50001 || code === 'EACCES') return 'PERMISSION';
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) && /^(08|22|23|28|42|53|57|58|XX)/.test(code)) return 'DATABASE';
    if (value.name === 'DiscordAPIError' || value.name === 'HTTPError') return 'DISCORD';
    if (value.name === 'ZodError' || value.name === 'ValidationError') return 'VALIDATION';
    if (value.cause !== undefined) { error = value.cause; continue; }
    if (value.name === 'TypeError' || value.name === 'RangeError' || value.name === 'ReferenceError' || value.name === 'SyntaxError') return 'INTERNAL';
    break;
  }
  return 'UNKNOWN';
  } catch { return 'UNKNOWN'; } // A hostile getter/proxy must not break later-job isolation.
}
