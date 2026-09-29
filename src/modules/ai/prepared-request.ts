import type { AiModelCapability, AiRequest } from './contracts.js';
import { AI_DEFAULT_LIMITS } from './limits.js';

/** One bounded request description is shared by admission and provider dispatch. */
export type PreparedAiRequest = Readonly<Pick<AiRequest,
  'modelId' | 'instructions' | 'userInput' | 'context' | 'maxOutputTokens'> & {
  estimatedBillableInputTokens: number;
}>;
export type AiRequestContent = Readonly<Pick<AiRequest,
  'modelId' | 'instructions' | 'userInput' | 'context' | 'maxOutputTokens'>>;

/**
 * Intentionally pessimistic for byte-based token vocabularies. A real adapter must prove
 * its complete serialized input fits this estimate and its operator-approved framing
 * allowance before it can be wired; no generic tokenizer equivalence is claimed.
 */
export function prepareAiRequest(content: AiRequestContent,
  model: Pick<AiModelCapability, 'modelId' | 'maxInputTokens' | 'maxOutputTokens' | 'requestOverheadTokens'>,
): PreparedAiRequest | null {
  const { modelId, instructions, userInput, context, maxOutputTokens } = content;
  if (modelId !== model.modelId || typeof instructions !== 'string' || !instructions ||
    typeof userInput !== 'string' || !userInput.trim() ||
    userInput.length > AI_DEFAULT_LIMITS.maxInputCharacters ||
    (context !== undefined && typeof context !== 'string') ||
    !Number.isSafeInteger(model.maxInputTokens) || model.maxInputTokens < 1 ||
    model.maxInputTokens > AI_DEFAULT_LIMITS.maxEstimatedInputTokens ||
    !Number.isSafeInteger(model.maxOutputTokens) || model.maxOutputTokens < 1 ||
    model.maxOutputTokens > AI_DEFAULT_LIMITS.maxOutputTokens ||
    !Number.isSafeInteger(model.requestOverheadTokens) || model.requestOverheadTokens < 0 ||
    model.requestOverheadTokens > AI_DEFAULT_LIMITS.maxRequestOverheadTokens ||
    !Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1 ||
    maxOutputTokens > Math.min(model.maxOutputTokens, AI_DEFAULT_LIMITS.maxOutputTokens)) return null;

  const estimatedBillableInputTokens = Buffer.byteLength(instructions, 'utf8') +
    Buffer.byteLength(userInput, 'utf8') + Buffer.byteLength(context ?? '', 'utf8') + model.requestOverheadTokens;
  if (!Number.isSafeInteger(estimatedBillableInputTokens) || estimatedBillableInputTokens < 1 ||
    estimatedBillableInputTokens > Math.min(AI_DEFAULT_LIMITS.maxEstimatedInputTokens, model.maxInputTokens)) return null;
  return Object.freeze({ modelId, instructions, userInput, ...(context === undefined ? {} : { context }),
    maxOutputTokens, estimatedBillableInputTokens });
}
