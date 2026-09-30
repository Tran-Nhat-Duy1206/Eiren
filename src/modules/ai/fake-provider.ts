import type { AiModelCapability, AiProvider, AiRequest, AiResponse } from './contracts.js';

/** A manually released gate: no wall-clock sleeps or external I/O. */
export function fakeGate(): { promise: Promise<void>; release(): void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

export type FakeScenario =
  | { kind: 'success'; response?: Partial<AiResponse> }
  | { kind: 'delay'; gate: Promise<void>; response?: Partial<AiResponse> }
  | { kind: 'abort'; gate?: Promise<void> }
  | { kind: 'timeout'; gate?: Promise<void> }
  | { kind: 'throws'; error: unknown }
  | { kind: 'missing-usage' }
  | { kind: 'invalid-usage' }
  | { kind: 'usage-above-reservation' }
  | { kind: 'oversized-output' }
  | { kind: 'empty-output' }
  | { kind: 'model-mismatch' };

/** Test/dev-only provider. Import explicitly in tests; never register in production. */
export class FakeAiProvider implements AiProvider {
  readonly capabilities: readonly AiModelCapability[];
  readonly requests: AiRequest[] = [];
  private readonly scenarios: FakeScenario[];

  constructor(scenarios: readonly FakeScenario[], capabilities: readonly AiModelCapability[] = []) {
    this.scenarios = [...scenarios];
    this.capabilities = capabilities;
  }

  async generate(request: AiRequest): Promise<AiResponse> {
    this.requests.push(request);
    const scenario = this.scenarios.shift();
    if (!scenario) throw new Error('FakeAiProvider: no scenario queued');
    if (request.signal.aborted) throw abortError();

    const response: AiResponse = {
      text: 'Fake response', usage: { inputTokens: 1, outputTokens: 1 },
      modelId: request.modelId, finishReason: 'stop', providerRequestId: 'fake-request',
    };
    switch (scenario.kind) {
      case 'success':
        return cancellable(Promise.resolve({ ...response, ...scenario.response }), request.signal);
      case 'delay':
        return cancellable(scenario.gate.then(() => ({ ...response, ...scenario.response })), request.signal);
      case 'abort':
        return cancellable(scenario.gate ?? new Promise<void>(() => {}), request.signal)
          .then(() => response);
      case 'timeout':
        if (scenario.gate) await cancellable(scenario.gate, request.signal);
        throw Object.assign(new Error('Fake provider timeout'), { name: 'TimeoutError' });
      case 'throws': throw scenario.error;
      case 'missing-usage':
        // Intentionally violate the static contract to exercise boundary validation.
        return { ...response, usage: undefined } as unknown as AiResponse;
      case 'invalid-usage': return { ...response, usage: { inputTokens: -1, outputTokens: Number.NaN } };
      case 'usage-above-reservation':
        return { ...response, usage: { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: Number.MAX_SAFE_INTEGER } };
      case 'oversized-output': return { ...response, text: 'x'.repeat(100_000) };
      case 'empty-output': return { ...response, text: '' };
      case 'model-mismatch': return { ...response, modelId: `${request.modelId}-unexpected` };
    }
  }
}

function abortError(): Error {
  return Object.assign(new Error('Fake provider aborted'), { name: 'AbortError' });
}

function cancellable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(abortError());
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener('abort', abort); resolve(value); },
      (error: unknown) => { signal.removeEventListener('abort', abort); reject(error); },
    );
  });
}
