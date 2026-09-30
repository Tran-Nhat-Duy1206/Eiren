import { describe, expect, expectTypeOf, it } from 'vitest';
import type { AiProvider, AiRequest, AiResponse, AiServerConfig } from './contracts.js';
import { AI_DEFAULT_LIMITS } from './limits.js';

describe('provider-neutral AI boundary', () => {
  it('declares fixed protective defaults', () => {
    expect(AI_DEFAULT_LIMITS).toMatchObject({ maxInputCharacters: 4000, maxEstimatedInputTokens: 2048,
      maxOutputTokens: 512, timeoutMs: 15000, guildRequestsPerDay: 25,
      userRequestsPerDay: 10, userCooldownSeconds: 30, guildConcurrency: 1,
      processConcurrency: 4, monthlyBudgetUsd: 5 });
  });
  it('separates trusted instructions from untrusted input and supports cancellation', () => {
    expectTypeOf<AiRequest>().toHaveProperty('instructions');
    expectTypeOf<AiRequest>().toHaveProperty('userInput');
    expectTypeOf<AiRequest>().toHaveProperty('signal');
    expectTypeOf<AiResponse>().toHaveProperty('finishReason');
    expectTypeOf<AiProvider>().toHaveProperty('capabilities');
    expectTypeOf<AiServerConfig>().toHaveProperty('apiKey');
  });
});
