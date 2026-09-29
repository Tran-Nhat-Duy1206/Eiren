export const AI_DEFAULT_LIMITS = {
  maxInputCharacters: 4000,
  // Complete billable input: trusted instructions + explicit input/context + request framing.
  maxEstimatedInputTokens: 2048,
  maxRequestOverheadTokens: 512,
  maxOutputTokens: 512,
  timeoutMs: 15_000,
  guildRequestsPerDay: 25,
  userRequestsPerDay: 10,
  userCooldownSeconds: 30,
  guildConcurrency: 1,
  processConcurrency: 4,
  monthlyBudgetUsd: 5,
} as const;

export type AiAdmissionPolicy = {
  providerId: string;
  modelId: string;
  maxInputCharacters: number;
  maxEstimatedInputTokens: number;
  maxOutputTokens: number;
  guildRequestsPerDay: number;
  userRequestsPerDay: number;
  userCooldownSeconds: number;
  guildConcurrency: number;
  processConcurrency: number;
  monthlyBudgetUsd: number;
};
