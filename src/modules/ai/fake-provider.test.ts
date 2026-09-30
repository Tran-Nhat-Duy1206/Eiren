import { describe, expect, it } from 'vitest';
import type { AiRequest } from './contracts.js';
import { FakeAiProvider, fakeGate, type FakeScenario } from './fake-provider.js';

function request(signal = new AbortController().signal): AiRequest {
  return { modelId: 'test-model', instructions: 'test', userInput: 'hello', maxOutputTokens: 4,
    timeoutMs: 100, signal };
}

describe('local fake AI provider', () => {
  it('returns queued success responses in order and records requests', async () => {
    const provider = new FakeAiProvider([
      { kind: 'success' }, { kind: 'success', response: { text: 'second' } },
    ]);
    const first = request();
    expect(await provider.generate(first)).toMatchObject({ text: 'Fake response', modelId: first.modelId,
      usage: { inputTokens: 1, outputTokens: 1 } });
    expect((await provider.generate(request())).text).toBe('second');
    expect(provider.requests[0]).toBe(first);
    await expect(provider.generate(request())).rejects.toThrow('no scenario queued');
  });

  it('delays until an explicit gate opens', async () => {
    const gate = fakeGate();
    const provider = new FakeAiProvider([{ kind: 'delay', gate: gate.promise }]);
    let settled = false;
    const pending = provider.generate(request()).then((result) => { settled = true; return result; });
    await Promise.resolve();
    expect(settled).toBe(false);
    gate.release();
    expect((await pending).text).toBe('Fake response');
  });

  it('aborts deterministically without releasing a gate', async () => {
    const controller = new AbortController();
    const provider = new FakeAiProvider([{ kind: 'abort' }]);
    const pending = provider.generate(request(controller.signal));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await expect(provider.generate(request(controller.signal))).rejects.toThrow('no scenario queued');
    const preAborted = new AbortController();
    preAborted.abort();
    await expect(new FakeAiProvider([{ kind: 'success' }]).generate(request(preAborted.signal)))
      .rejects.toMatchObject({ name: 'AbortError' });
  });

  it('simulates timeout on an explicit gate and permits cancellation while waiting', async () => {
    const gate = fakeGate();
    const provider = new FakeAiProvider([{ kind: 'timeout', gate: gate.promise }]);
    const pending = provider.generate(request());
    gate.release();
    await expect(pending).rejects.toMatchObject({ name: 'TimeoutError' });
    const held = fakeGate();
    const controller = new AbortController();
    const waiting = new FakeAiProvider([{ kind: 'timeout', gate: held.promise }])
      .generate(request(controller.signal));
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('throws the configured provider error unchanged', async () => {
    const error = new Error('provider failed');
    await expect(new FakeAiProvider([{ kind: 'throws', error }]).generate(request())).rejects.toBe(error);
  });

  it.each([
    ['missing-usage', (value: unknown) => expect(value).toBeUndefined()],
    ['invalid-usage', (value: unknown) => expect(value).toEqual({ inputTokens: -1, outputTokens: NaN })],
    ['usage-above-reservation', (value: unknown) => expect(value).toEqual({
      inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: Number.MAX_SAFE_INTEGER,
    })],
  ] as const)('provides %s for boundary validation', async (kind, check) => {
    const response = await new FakeAiProvider([{ kind }]).generate(request());
    check(response.usage);
  });

  it.each(['oversized-output', 'empty-output', 'model-mismatch'] as const)(
    'provides %s for boundary validation', async (kind) => {
      const response = await new FakeAiProvider([{ kind } satisfies FakeScenario]).generate(request());
      if (kind === 'oversized-output') expect(response.text.length).toBe(100_000);
      if (kind === 'empty-output') expect(response.text).toBe('');
      if (kind === 'model-mismatch') expect(response.modelId).not.toBe('test-model');
    },
  );
});
