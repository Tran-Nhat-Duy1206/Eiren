import type { AiAdmissionPolicy } from './limits.js';

/** Prices are USD per million tokens, supplied by the operator rather than model output. */
export type AiModelCapability = {
  providerId: string;
  modelId: string;
  inputUsdPerMillionTokens: number;
  outputUsdPerMillionTokens: number;
  maxInputTokens: number;
  maxOutputTokens: number;
};

/** Trusted, server-only configuration. Never send endpoint or credentials to a client. */
export type AiServerConfig = {
  providerId: string;
  endpoint: string;
  apiKey: string;
  models: readonly AiModelCapability[];
  timeoutMs: number;
  policy: AiAdmissionPolicy;
  globalDailyBudgetMicros: number;
  globalMonthlyBudgetMicros: number;
};

/** Instructions are trusted server policy; user input and context are untrusted. */
export type AiRequest = {
  modelId: string;
  instructions: string;
  userInput: string;
  context?: string;
  maxOutputTokens: number;
  timeoutMs: number;
  signal: AbortSignal;
};

/** Text, usage and provider identifiers returned by a remote provider are untrusted. */
export type AiUsage = {
  inputTokens: number;
  outputTokens: number;
};
export type AiResponse = {
  text: string;
  usage: AiUsage;
  modelId: string;
  finishReason: 'stop' | 'length' | 'other';
  providerRequestId?: string;
};
export interface AiProvider {
  readonly capabilities: readonly AiModelCapability[];
  generate(request: AiRequest): Promise<AiResponse>;
}
