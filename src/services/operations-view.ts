import type { OperationsRuntimeState, OperationsRuntimeSnapshot } from '../core/operations/runtime-state.js';
import type { ReadinessService, ReadinessSnapshot } from '../core/operations/readiness.js';
import type { SchedulerTelemetry, SchedulerTelemetrySnapshot } from '../core/operations/scheduler-telemetry.js';
import type { OperationsService, GuildOperationsView } from './operations-service.js';

export interface OperationsDashboardView {
  process: OperationsRuntimeSnapshot;
  readiness: ReadinessSnapshot;
  schedulers: { v5: SchedulerTelemetrySnapshot; moderation: SchedulerTelemetrySnapshot };
  guild: GuildOperationsView;
}
/** Read-only composition: no lifecycle, scheduler, governance or Discord mutation capability. */
export class OperationsViewService {
  constructor(private readonly runtime: Pick<OperationsRuntimeState, 'snapshot'>,
    private readonly readiness: Pick<ReadinessService, 'check'>,
    private readonly schedulers: { v5: Pick<SchedulerTelemetry, 'snapshot'>; moderation: Pick<SchedulerTelemetry, 'snapshot'> },
    private readonly guildOperations: Pick<OperationsService, 'view'>) {}
  async inspect(guildId: string): Promise<OperationsDashboardView> {
    const [readiness, guild] = await Promise.all([this.readiness.check(), this.guildOperations.view(guildId)]);
    return { process: this.runtime.snapshot(), readiness,
      schedulers: { v5: this.schedulers.v5.snapshot(), moderation: this.schedulers.moderation.snapshot() }, guild };
  }
}
