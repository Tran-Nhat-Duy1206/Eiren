import { describe, expect, it, vi } from 'vitest';
import { dispatchButton, dispatchSelect, type ButtonHandler, type SelectMenuHandler } from './component.js';
import type { Services } from '../../app/services.js';

function fixture(enabled: boolean) {
  const handle = vi.fn(async () => {});
  const services = { modules: { isEnabled: vi.fn(async () => enabled) }, logger: { warn: vi.fn(), error: vi.fn() } } as unknown as Services;
  const interaction = { customId: 'v3:menu:42', guildId: 'guild', user: { id: 'user' }, guild: {}, inGuild: () => true,
    reply: vi.fn(async () => {}), deferred: false, replied: false };
  return { handle, services, interaction };
}

describe('persistent V3 component routing', () => {
  it('gates a dynamic role button before executing the handler', async () => {
    const { handle, services, interaction } = fixture(false);
    const handler: ButtonHandler = { customId: 'v3:menu:', moduleKey: 'roles', matches: id => id.startsWith('v3:menu:'), handle };
    await dispatchButton(interaction as never, new Map([[handler.customId, handler]]), services);
    expect(handle).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith({ content: 'This module is disabled in this server.', flags: expect.any(Number) });
  });
  it('routes a dynamic select only when its module is enabled', async () => {
    const { handle, services, interaction } = fixture(true);
    const handler: SelectMenuHandler = { customId: 'v3:menu:', moduleKey: 'roles', matches: id => id.startsWith('v3:menu:'), handle };
    await dispatchSelect(interaction as never, new Map([[handler.customId, handler]]), services);
    expect(handle).toHaveBeenCalledOnce();
    expect(services.modules.isEnabled).toHaveBeenCalledWith('guild', 'roles');
  });
  it('rejects disabled suggestion votes before recording them', async () => {
    const { handle, services, interaction } = fixture(false);
    const handler: ButtonHandler = { customId: 'v3:menu:', moduleKey: 'suggestions', matches: id => id.startsWith('v3:menu:'), handle };
    await dispatchButton(interaction as never, new Map([[handler.customId, handler]]), services);
    expect(handle).not.toHaveBeenCalled();
  });
});
