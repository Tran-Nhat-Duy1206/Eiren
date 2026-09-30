import { randomUUID } from 'node:crypto';
import { and, eq, gte, lt, lte, sql } from 'drizzle-orm';
import type { Database } from '../../core/database/connection.js';
import { aiRequests, aiSettings, aiUsageDaily, guildModules } from '../../core/database/schema.js';
import type { AiModelCapability } from './contracts.js';
import { AI_DEFAULT_LIMITS, type AiAdmissionPolicy } from './limits.js';

export type AiIngressToken = Readonly<{ guildId: string; epoch: number }>;
export type AiAdmission = Readonly<{ id: string; guildId: string; userId: string; epoch: number;
  modelId: string; reservedInputTokens: number; reservedCostMicros: number; leaseUntil: Date }>;
export type AiAdmissionInput = Readonly<{ ingress: AiIngressToken; userId: string; requestKey: string;
  inputCharacters: number; estimatedInputTokens: number; maxOutputTokens: number;
  model: AiModelCapability; policy: AiAdmissionPolicy; globalDailyBudgetMicros: number;
  globalMonthlyBudgetMicros: number; now?: Date }>;
export type AiActualUsage = Readonly<{ inputTokens: number; outputTokens: number; costMicros: number }>;

const dayOf = (date: Date) => date.toISOString().slice(0, 10);
const monthOf = (day: string) => `${day.slice(0, 7)}-01`;
const MICROS_PER_USD = 1_000_000;
const ceiling = (value: number, upper: number) => Number.isSafeInteger(value) && value >= 0 && value <= upper;
const money = (usd: number) => Number.isFinite(usd) && usd > 0 && usd <= 1000
  ? Math.ceil(usd * MICROS_PER_USD) : NaN;

/** Pessimistic server-approved model pricing; never derive billing bounds from provider output. */
export function maximumCostMicros(model: AiModelCapability, inputTokens: number, outputTokens: number) {
  const inputPrice = money(model.inputUsdPerMillionTokens);
  const outputPrice = money(model.outputUsdPerMillionTokens);
  if (!Number.isSafeInteger(inputPrice) || !Number.isSafeInteger(outputPrice) ||
      !ceiling(inputTokens, AI_DEFAULT_LIMITS.maxEstimatedInputTokens) ||
      !ceiling(outputTokens, AI_DEFAULT_LIMITS.maxOutputTokens)) throw new Error('Invalid approved model pricing');
  const micros = (BigInt(inputPrice) * BigInt(inputTokens) + BigInt(outputPrice) * BigInt(outputTokens) +
    BigInt(MICROS_PER_USD - 1)) / BigInt(MICROS_PER_USD);
  if (micros > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Approved model price exceeds safe bounds');
  return Number(micros);
}

/** No transaction or database lock survives a future provider call. */
export class AiRepository {
  constructor(private readonly db: Database) {}

  async reserveIngress(guildId: string): Promise<AiIngressToken | null> {
    return this.db.transaction(async tx => {
      const [module] = await tx.select({ enabled: guildModules.enabled, epoch: guildModules.version })
        .from(guildModules).where(and(eq(guildModules.guildId, guildId), eq(guildModules.moduleKey, 'ai'))).for('update');
      return module?.enabled ? Object.freeze({ guildId, epoch: module.epoch }) : null;
    });
  }

  async admit(input: AiAdmissionInput): Promise<AiAdmission | null> {
    const { ingress, userId, requestKey, model, policy } = input;
    if (!/^\d{17,20}$/.test(userId) || !/^[A-Za-z0-9:_-]{1,128}$/.test(requestKey) ||
      model.providerId !== policy.providerId || model.modelId !== policy.modelId ||
      !ceiling(model.requestOverheadTokens, AI_DEFAULT_LIMITS.maxRequestOverheadTokens) ||
      (input.now !== undefined && !Number.isFinite(input.now.getTime())) ||
      !ceiling(input.inputCharacters, AI_DEFAULT_LIMITS.maxInputCharacters) ||
      !ceiling(input.estimatedInputTokens, Math.min(AI_DEFAULT_LIMITS.maxEstimatedInputTokens, policy.maxEstimatedInputTokens, model.maxInputTokens)) ||
      !ceiling(input.maxOutputTokens, Math.min(AI_DEFAULT_LIMITS.maxOutputTokens, policy.maxOutputTokens, model.maxOutputTokens)) ||
      input.maxOutputTokens === 0 || input.inputCharacters === 0 || input.estimatedInputTokens === 0 ||
      !ceiling(input.globalDailyBudgetMicros, Number.MAX_SAFE_INTEGER) ||
      !ceiling(input.globalMonthlyBudgetMicros, Number.MAX_SAFE_INTEGER)) return null;
    const cost = maximumCostMicros(model, input.estimatedInputTokens, input.maxOutputTokens);
    const budget = money(policy.monthlyBudgetUsd);
    if (!Number.isSafeInteger(budget) || cost > budget) return null;
    return this.db.transaction(async tx => {
      // One global budget lock, then the guild module row, then daily counters. No reverse-order path.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(0, hashtext('eiren-ai-budget'))`);
      const [module] = await tx.select({ enabled: guildModules.enabled, epoch: guildModules.version })
        .from(guildModules).where(and(eq(guildModules.guildId, ingress.guildId), eq(guildModules.moduleKey, 'ai'))).for('update');
      if (!module?.enabled || module.epoch !== ingress.epoch) return null;
      const [settings] = await tx.select().from(aiSettings).where(eq(aiSettings.guildId, ingress.guildId));
      if (!settings || settings.providerId !== model.providerId || settings.modelId !== model.modelId) return null;
      // Take the production clock after contested locks, not before waiting in their queues.
      const now = input.now ?? new Date();
      const day = dayOf(now), month = monthOf(day);
      const nextDay = new Date(new Date(`${day}T00:00:00.000Z`).getTime() + 86_400_000);
      const nextMonth = dayOf(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)));
      const dailyCap = Math.min(AI_DEFAULT_LIMITS.guildRequestsPerDay, policy.guildRequestsPerDay,
        settings.guildRequestsPerDay ?? Number.POSITIVE_INFINITY);
      const userCap = Math.min(AI_DEFAULT_LIMITS.userRequestsPerDay, policy.userRequestsPerDay,
        settings.userRequestsPerDay ?? Number.POSITIVE_INFINITY);
      const guildBudget = Math.min(AI_DEFAULT_LIMITS.monthlyBudgetUsd * MICROS_PER_USD, budget,
        settings.monthlyBudgetMicros ?? Number.POSITIVE_INFINITY);
      const concurrency = Math.min(AI_DEFAULT_LIMITS.guildConcurrency, policy.guildConcurrency);
      const globalConcurrency = Math.min(AI_DEFAULT_LIMITS.processConcurrency, policy.processConcurrency);
      if (![dailyCap, userCap, concurrency, globalConcurrency, guildBudget].every(value => Number.isSafeInteger(value) && value > 0) ||
        !ceiling(policy.userCooldownSeconds, 86400) ||
        input.inputCharacters > Math.min(AI_DEFAULT_LIMITS.maxInputCharacters, policy.maxInputCharacters)) return null;
      await tx.insert(aiUsageDaily).values({ guildId: ingress.guildId, utcDay: day }).onConflictDoNothing();
      const [usage] = await tx.select().from(aiUsageDaily).where(and(eq(aiUsageDaily.guildId, ingress.guildId), eq(aiUsageDaily.utcDay, day))).for('update');
      if (!usage) throw new Error('AI usage day could not be reserved');
      // Crash/timeout recovery is pessimistic: an expired request costs its entire reservation.
      const expired = await tx.select().from(aiRequests).where(and(eq(aiRequests.guildId, ingress.guildId),
        eq(aiRequests.status, 'RESERVED'), lte(aiRequests.leaseUntil, now))).for('update');
      for (const request of expired) {
        await tx.update(aiRequests).set({ status: 'EXPIRED', actualCostMicros: request.reservedCostMicros,
          settledAt: now }).where(eq(aiRequests.id, request.id));
        await tx.update(aiUsageDaily).set({
          reservedCostMicros: sql`${aiUsageDaily.reservedCostMicros} - ${request.reservedCostMicros}`,
          settledCostMicros: sql`${aiUsageDaily.settledCostMicros} + ${request.reservedCostMicros}`,
        }).where(and(eq(aiUsageDaily.guildId, ingress.guildId), eq(aiUsageDaily.utcDay, request.usageDay)));
      }
      const [existing] = await tx.select({ id: aiRequests.id }).from(aiRequests)
        .where(and(eq(aiRequests.guildId, ingress.guildId), eq(aiRequests.requestKey, requestKey)));
      if (existing) return null; // Replayed interactions never dispatch to a provider twice.
      const start = new Date(`${day}T00:00:00.000Z`);
      // A transaction owns one PostgreSQL client: query sequentially, never concurrently on that client.
      const userDay = await tx.select({ n: sql<number>`count(*)::int` }).from(aiRequests).where(and(
        eq(aiRequests.guildId, ingress.guildId), eq(aiRequests.userId, userId),
        gte(aiRequests.createdAt, start), lt(aiRequests.createdAt, nextDay)));
      const lastUser = await tx.select({ createdAt: aiRequests.createdAt }).from(aiRequests).where(and(
        eq(aiRequests.guildId, ingress.guildId), eq(aiRequests.userId, userId)))
        .orderBy(sql`${aiRequests.createdAt} DESC`).limit(1);
      const active = await tx.select({ n: sql<number>`count(*)::int` }).from(aiRequests).where(and(
        eq(aiRequests.guildId, ingress.guildId), eq(aiRequests.status, 'RESERVED'), sql`${aiRequests.leaseUntil} > ${now}`));
      const globalActive = await tx.select({ n: sql<number>`count(*)::int` }).from(aiRequests).where(and(
        eq(aiRequests.status, 'RESERVED'), sql`${aiRequests.leaseUntil} > ${now}`));
      const monthly = await tx.select({ n: sql<number>`coalesce(sum(${aiUsageDaily.reservedCostMicros} + ${aiUsageDaily.settledCostMicros}),0)::bigint` })
        .from(aiUsageDaily).where(and(eq(aiUsageDaily.guildId, ingress.guildId),
          gte(aiUsageDaily.utcDay, month), lt(aiUsageDaily.utcDay, nextMonth)));
      const globalDay = await tx.select({ n: sql<number>`coalesce(sum(${aiUsageDaily.reservedCostMicros} + ${aiUsageDaily.settledCostMicros}),0)::bigint` })
        .from(aiUsageDaily).where(eq(aiUsageDaily.utcDay, day));
      const globalMonth = await tx.select({ n: sql<number>`coalesce(sum(${aiUsageDaily.reservedCostMicros} + ${aiUsageDaily.settledCostMicros}),0)::bigint` })
        .from(aiUsageDaily).where(and(gte(aiUsageDaily.utcDay, month), lt(aiUsageDaily.utcDay, nextMonth)));
      const rejected = usage.requests >= dailyCap || Number(userDay[0]?.n ?? 0) >= userCap ||
        (lastUser[0] && now.getTime() - lastUser[0].createdAt.getTime() < policy.userCooldownSeconds * 1000) ||
        Number(active[0]?.n ?? 0) >= concurrency || Number(globalActive[0]?.n ?? 0) >= globalConcurrency ||
        Number(monthly[0]?.n ?? 0) + cost > guildBudget ||
        Number(globalDay[0]?.n ?? 0) + cost > input.globalDailyBudgetMicros ||
        Number(globalMonth[0]?.n ?? 0) + cost > input.globalMonthlyBudgetMicros;
      if (rejected) {
        await tx.update(aiUsageDaily).set({ rejected: sql`${aiUsageDaily.rejected} + 1` })
          .where(and(eq(aiUsageDaily.guildId, ingress.guildId), eq(aiUsageDaily.utcDay, day)));
        return null;
      }
      const id = randomUUID(), leaseUntil = new Date(now.getTime() + 60_000);
      await tx.insert(aiRequests).values({ id, guildId: ingress.guildId, userId, requestKey, usageDay: day,
        epoch: ingress.epoch, modelId: model.modelId, reservedInputTokens: input.estimatedInputTokens,
        reservedOutputTokens: input.maxOutputTokens, reservedCostMicros: cost, leaseUntil, createdAt: now });
      await tx.update(aiUsageDaily).set({ requests: sql`${aiUsageDaily.requests} + 1`,
        reservedCostMicros: sql`${aiUsageDaily.reservedCostMicros} + ${cost}` })
        .where(and(eq(aiUsageDaily.guildId, ingress.guildId), eq(aiUsageDaily.utcDay, day)));
      return Object.freeze({ id, guildId: ingress.guildId, userId, epoch: ingress.epoch,
        modelId: model.modelId, reservedInputTokens: input.estimatedInputTokens, reservedCostMicros: cost, leaseUntil });
    });
  }

  async settle(admission: AiAdmission, actual: AiActualUsage | null, at?: Date): Promise<boolean> {
    if ((at !== undefined && !Number.isFinite(at.getTime())) || (actual && (!ceiling(actual.inputTokens, AI_DEFAULT_LIMITS.maxEstimatedInputTokens) ||
      !ceiling(actual.outputTokens, AI_DEFAULT_LIMITS.maxOutputTokens) ||
      !ceiling(actual.costMicros, admission.reservedCostMicros)))) throw new Error('Invalid AI usage settlement');
    return this.db.transaction(async tx => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(0, hashtext('eiren-ai-budget'))`);
      const [module] = await tx.select({ enabled: guildModules.enabled, epoch: guildModules.version })
        .from(guildModules).where(and(eq(guildModules.guildId, admission.guildId), eq(guildModules.moduleKey, 'ai'))).for('update');
      const [request] = await tx.select().from(aiRequests).where(and(eq(aiRequests.guildId, admission.guildId),
        eq(aiRequests.id, admission.id))).for('update');
      if (!request || request.status !== 'RESERVED' || request.userId !== admission.userId ||
        request.epoch !== admission.epoch || request.modelId !== admission.modelId ||
        request.reservedCostMicros !== admission.reservedCostMicros) return false;
      // Re-evaluate the real lease only after obtaining both locks and the request row.
      const now = at ?? new Date();
      const withinLease = request.leaseUntil > now;
      const cost = withinLease && actual ? actual.costMicros : request.reservedCostMicros;
      if (actual && (actual.inputTokens > request.reservedInputTokens || actual.outputTokens > request.reservedOutputTokens))
        throw new Error('Provider usage exceeded reserved token limit');
      await tx.update(aiRequests).set({ status: withinLease ? 'SETTLED' : 'EXPIRED', settledAt: now,
        actualCostMicros: cost, actualInputTokens: withinLease ? actual?.inputTokens : null,
        actualOutputTokens: withinLease ? actual?.outputTokens : null }).where(eq(aiRequests.id, request.id));
      await tx.update(aiUsageDaily).set({
        reservedCostMicros: sql`${aiUsageDaily.reservedCostMicros} - ${request.reservedCostMicros}`,
        settledCostMicros: sql`${aiUsageDaily.settledCostMicros} + ${cost}`,
        inputTokens: sql`${aiUsageDaily.inputTokens} + ${withinLease ? actual?.inputTokens ?? 0 : 0}`,
        outputTokens: sql`${aiUsageDaily.outputTokens} + ${withinLease ? actual?.outputTokens ?? 0 : 0}`,
      }).where(and(eq(aiUsageDaily.guildId, admission.guildId), eq(aiUsageDaily.utcDay, request.usageDay)));
      // Billing metadata remains accurate even when an in-flight request crossed an opt-out.
      return withinLease && module?.enabled === true && module.epoch === admission.epoch;
    });
  }
}
