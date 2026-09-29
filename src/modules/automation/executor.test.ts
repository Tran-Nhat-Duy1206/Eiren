import { describe, expect, it, vi } from 'vitest';
import { createAutomationActionHandlerRegistry, resolveAutomationActionHandler } from './executor.js';
import type { AutomationDiscordGateway } from './discord-gateway.js';

const channelId = '223456789012345678';
describe('typed versioned automation action handlers', () => {
  it('supports only the two v1 static actions and binds validated message', async () => {
    const send = vi.fn().mockResolvedValue('323456789012345678');
    const preflight = vi.fn().mockResolvedValue({ kind: 'READY', send });
    const registry = createAutomationActionHandlerRegistry({ preflight } satisfies AutomationDiscordGateway);
    expect(registry.size).toBe(2);
    for (const key of ['STATIC_MESSAGE', 'STAFF_LOG']) {
      const handler = resolveAutomationActionHandler(key, 1, registry);
      expect(handler).toBeDefined();
      const ready = await handler!.preflight('123456789012345678', { channelId, message: 'literal' });
      expect(preflight).toHaveBeenCalledWith('123456789012345678', channelId);
      if (ready.kind !== 'READY') throw new Error('Expected ready');
      expect(await ready.send()).toBe('323456789012345678');
      expect(send).toHaveBeenCalledWith('literal');
    }
    expect(resolveAutomationActionHandler('LEGACY_INERT', 1, registry)).toBeUndefined();
    expect(resolveAutomationActionHandler('STATIC_MESSAGE', 2, registry)).toBeUndefined();
  });
  it('rejects unknown fields and messages longer than 1000 before preflight', async () => {
    const preflight = vi.fn();
    const registry = createAutomationActionHandlerRegistry({ preflight });
    const handler = resolveAutomationActionHandler('STATIC_MESSAGE', 1, registry)!;
    await expect(handler.preflight('123456789012345678', { channelId, message: 'x', extra: true })).rejects.toThrow();
    await expect(handler.preflight('123456789012345678', { channelId, message: 'x'.repeat(1001) })).rejects.toThrow();
    expect(preflight).not.toHaveBeenCalled();
  });
});
