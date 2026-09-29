import { AppError } from '../../core/errors/errors.js';
import type { Actor, PermissionService } from '../../core/permissions/permission-service.js';
import type { AiModelCapability, AiServerConfig, AiUsage } from './contracts.js';
/** Admission logic receives no provider endpoint or API credential. */
export type AiAdmissionConfig = Readonly<Omit<AiServerConfig, 'endpoint' | 'apiKey'>>;
import { prepareAiRequest, type PreparedAiRequest } from './prepared-request.js';
import { AiRepository, maximumCostMicros, type AiAdmission, type AiIngressToken } from './repository.js';

export type AiAdmissionMetadata = Readonly<{ userId: string; requestKey: string;
  prepared: PreparedAiRequest }>;

/** Foundation only: no provider is injected, invoked, or imported here. */
export class AiService {
  constructor(readonly repository: AiRepository, private readonly permissions: PermissionService,
    private readonly server: AiAdmissionConfig | null) {
    if (server && server.providerId !== server.policy.providerId)
      throw new Error('Invalid approved AI provider configuration');
  }

  /** Server-approved, credential-free runtime metadata. No provider endpoint or key leaves the environment. */
  runtimeConfig(): Readonly<{ providerId: string; modelId: string; model: Readonly<AiModelCapability>;
    timeoutMs: number; maxOutputTokens: number;
    guildRequestsPerDay: number; userRequestsPerDay: number; monthlyBudgetUsd: number }> | null {
    if (!this.server) return null;
    const model = this.server.models.find(candidate => candidate.providerId === this.server?.policy.providerId &&
      candidate.modelId === this.server?.policy.modelId);
    if (!model) return null;
    return { providerId: this.server.policy.providerId, modelId: this.server.policy.modelId, model,
      timeoutMs: this.server.timeoutMs, maxOutputTokens: this.server.policy.maxOutputTokens,
      guildRequestsPerDay: this.server.policy.guildRequestsPerDay, userRequestsPerDay: this.server.policy.userRequestsPerDay,
      monthlyBudgetUsd: this.server.policy.monthlyBudgetUsd };
  }

  /** Future command handlers must reserve before unrelated async dispatcher work. */
  reserveIngress(guildId: string): Promise<AiIngressToken | null> {
    return this.server ? this.repository.reserveIngress(guildId) : Promise.resolve(null);
  }

  async admit(ingress: AiIngressToken | null, actor: Actor, input: AiAdmissionMetadata): Promise<AiAdmission | null> {
    if (!ingress || !this.server) return null;
    if (actor.guildId !== ingress.guildId || actor.userId !== input.userId)
      throw new AppError('PERMISSION', 'This request belongs to another guild or user.');
    const policy = this.server.policy;
    const model = this.server.models.find(candidate => candidate.providerId === policy.providerId && candidate.modelId === policy.modelId);
    if (!model) return null;
    // Recompute from the SAME prepared fields: a caller cannot forge a lower admission estimate.
    // Neither user text nor trusted instructions/context goes to PostgreSQL.
    const verified = prepareAiRequest(input.prepared, model);
    if (!verified || input.prepared.estimatedBillableInputTokens !== verified.estimatedBillableInputTokens ||
      verified.estimatedBillableInputTokens > policy.maxEstimatedInputTokens ||
      verified.maxOutputTokens > policy.maxOutputTokens)
      throw new AppError('VALIDATION', 'AI request exceeds configured limits.');
    await this.permissions.require(actor, 'MEMBER');
    return this.repository.admit({ ingress, userId: input.userId, requestKey: input.requestKey,
      inputCharacters: verified.userInput.length, estimatedInputTokens: verified.estimatedBillableInputTokens,
      maxOutputTokens: verified.maxOutputTokens, model, policy,
      globalDailyBudgetMicros: this.server.globalDailyBudgetMicros,
      globalMonthlyBudgetMicros: this.server.globalMonthlyBudgetMicros });
  }

  /** Settles metadata only; absent/untrustworthy provider usage consumes the entire reservation. */
  async settle(admission: AiAdmission, usage: AiUsage | null, now?: Date): Promise<boolean> {
    const model = this.server?.models.find(candidate => candidate.providerId === this.server?.providerId &&
      candidate.modelId === admission.modelId);
    if (!usage || !model) return this.repository.settle(admission, null, now);
    const costMicros = maximumCostMicros(model, usage.inputTokens, usage.outputTokens);
    return this.repository.settle(admission, { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, costMicros }, now);
  }
}
