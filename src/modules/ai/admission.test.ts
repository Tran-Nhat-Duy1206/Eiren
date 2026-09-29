import { describe, expect, it, vi } from 'vitest';
import type { Actor, PermissionService } from '../../core/permissions/permission-service.js';
import type { AiServerConfig } from './contracts.js';
import { AI_DEFAULT_LIMITS } from './limits.js';
import { AiRepository, maximumCostMicros } from './repository.js';
import { AiService } from './service.js';

const guildId = '12345678901234567', userId = '22345678901234567';
const actor: Actor = { guildId, userId, guildOwnerId: userId, roleIds: [] };
const model = { providerId: 'approved', modelId: 'small', inputUsdPerMillionTokens: 2,
  outputUsdPerMillionTokens: 4, maxInputTokens: 2048, maxOutputTokens: 512 };
const server: AiServerConfig = { providerId: 'approved', endpoint: 'https://provider.example/ai', apiKey: 'secret-not-logged',
  models: [model], timeoutMs: AI_DEFAULT_LIMITS.timeoutMs, globalDailyBudgetMicros: 5_000_000,
  globalMonthlyBudgetMicros: 50_000_000,
  policy: { providerId: 'approved', modelId: 'small', maxInputCharacters: 4000,
    maxEstimatedInputTokens: 2048, maxOutputTokens: 512, guildRequestsPerDay: 25,
    userRequestsPerDay: 10, userCooldownSeconds: 30, guildConcurrency: 1,
    processConcurrency: 4, monthlyBudgetUsd: 5 } };
const metadata = { userId, requestKey: 'interaction-1', inputText: 'private prompt never persisted',
  estimatedInputTokens: 100, maxOutputTokens: 128, now: new Date('2000-01-01T00:00:00.000Z') };
const permission = { require: vi.fn(async () => {}) } as unknown as PermissionService;

describe('V7.1 metadata-only AI admission boundary', () => {
  it('does not reserve without server-side AI infrastructure', async () => {
    const reserveIngress = vi.fn(), admit = vi.fn();
    const service = new AiService({ reserveIngress, admit } as unknown as AiRepository, permission, null);
    expect(await service.reserveIngress(guildId)).toBeNull();
    expect(await service.admit({ guildId, epoch: 1 }, actor, metadata)).toBeNull();
    expect(reserveIngress).not.toHaveBeenCalled();
    expect(admit).not.toHaveBeenCalled();
  });
  it('passes only usage metadata and the original epoch to the repository', async () => {
    const reserveIngress = vi.fn(async () => Object.freeze({ guildId, epoch: 4 }));
    const admit = vi.fn(async () => null);
    const service = new AiService({ reserveIngress, admit } as unknown as AiRepository, permission, server);
    const token = await service.reserveIngress(guildId);
    expect(token).toEqual({ guildId, epoch: 4 });
    expect(await service.admit(token, actor, metadata)).toBeNull();
    expect(admit).toHaveBeenCalledWith(expect.objectContaining({ ingress: token, userId,
      inputCharacters: metadata.inputText.length, estimatedInputTokens: 100, model }));
    const persistedInput = JSON.stringify(admit.mock.calls);
    expect(persistedInput).not.toContain(metadata.inputText);
    expect(persistedInput).not.toContain(server.apiKey);
    expect(persistedInput).not.toContain('"now"');
    expect(permission.require).toHaveBeenCalledWith(actor, 'MEMBER');
  });
  it('rejects mismatched guild/user and oversized requests before writing', async () => {
    const admit = vi.fn();
    const service = new AiService({ admit } as unknown as AiRepository, permission, server);
    const ingress = { guildId, epoch: 4 };
    await expect(service.admit(ingress, { ...actor, guildId: '32345678901234567' }, metadata))
      .rejects.toMatchObject({ code: 'PERMISSION' });
    await expect(service.admit(ingress, actor, { ...metadata, inputText: 'x'.repeat(4001) }))
      .rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(service.admit(ingress, actor, { ...metadata, estimatedInputTokens: 2049 }))
      .rejects.toMatchObject({ code: 'VALIDATION' });
    expect(admit).not.toHaveBeenCalled();
  });
  it('computes conservative micro-unit prices without assuming a provider SDK', () => {
    expect(maximumCostMicros(model, 100, 128)).toBe(712);
    expect(maximumCostMicros({ ...model, inputUsdPerMillionTokens: 0.0000001 }, 1, 1)).toBe(5);
    expect(() => maximumCostMicros({ ...model, inputUsdPerMillionTokens: Number.NaN }, 1, 1)).toThrow();
    expect(() => maximumCostMicros({ ...model, inputUsdPerMillionTokens: 0 }, 1, 1)).toThrow();
    expect(() => maximumCostMicros({ ...model, outputUsdPerMillionTokens: 0 }, 1, 1)).toThrow();
    expect(() => maximumCostMicros({ ...model, inputUsdPerMillionTokens: -1 }, 1, 1)).toThrow();
    expect(() => maximumCostMicros({ ...model, inputUsdPerMillionTokens: Number.POSITIVE_INFINITY }, 1, 1)).toThrow();
    expect(() => maximumCostMicros(model, Number.MAX_SAFE_INTEGER, 1)).toThrow();
    expect(() => maximumCostMicros({ ...model, outputUsdPerMillionTokens: 1001 }, 1, 1)).toThrow();
  });
  it('rejects divergent approved provider identity before any admission or billing', () => {
    expect(() => new AiService({} as AiRepository, permission,
      { ...server, providerId: 'other-approved-provider' })).toThrow('Invalid approved AI provider configuration');
  });
  it('does not invent actual usage when a provider result is absent', async () => {
    const settle = vi.fn(async () => false);
    const service = new AiService({ settle } as unknown as AiRepository, permission, server);
    const admission = { id: '123', guildId, userId, epoch: 4, modelId: 'small', reservedCostMicros: 712,
      leaseUntil: new Date() };
    expect(await service.settle(admission, null)).toBe(false);
    expect(settle).toHaveBeenCalledWith(admission, null, undefined);
    expect(await service.settle(admission, { inputTokens: 50, outputTokens: 20 })).toBe(false);
    expect(settle).toHaveBeenLastCalledWith(admission, { inputTokens: 50, outputTokens: 20, costMicros: 180 }, undefined);
  });
});
