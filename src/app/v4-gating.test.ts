import { describe, expect, it, vi } from 'vitest';
import { dispatchCommand } from '../core/commands/dispatcher.js';
import { dispatchEvent } from '../core/events/event.js';
import type { Services } from './services.js';
import { buildRegistry, manifests } from './registry.js';

const v4 = ['levels', 'reputation', 'starboard', 'profiles'];
describe('independent optional V4 module routing', () => {
  it('registers four disabled-by-default modules with no dependencies', () => {
    const registry = buildRegistry(manifests);
    for (const key of v4) {
      const module = registry.definitions.find(value => value.key === key);
      expect(module).toMatchObject({ key, defaultEnabled: false });
      expect(module?.dependencies).toBeUndefined();
    }
    expect(registry.commands.get('rank')?.moduleKey).toBe('levels');
    expect(registry.commands.get('rep')?.moduleKey).toBe('reputation');
    expect(registry.commands.get('starboard')?.moduleKey).toBe('starboard');
    expect(registry.commands.get('profile')?.moduleKey).toBe('profiles');
  });
  it.each(['rank', 'rep', 'starboard', 'profile'])('blocks disabled /%s before permission or service calls', async name => {
    const services = { modules: { isEnabled: vi.fn(async () => false) }, permissions: { require: vi.fn() },
      logger: { warn: vi.fn(), error: vi.fn() } } as unknown as Services;
    const interaction = { commandName: name, guildId: 'guild', guild: { members: { fetch: vi.fn() } },
      user: { id: 'user' }, inGuild: () => true, deferred: true, replied: false,
      deferReply: vi.fn(async () => {}), editReply: vi.fn(async () => {}) };
    await dispatchCommand(interaction as never, buildRegistry(manifests).commands, services);
    expect(interaction.editReply).toHaveBeenCalledWith({ content: 'This module is disabled in this server.' });
    expect(services.permissions.require).not.toHaveBeenCalled();
    expect(interaction.guild.members.fetch).not.toHaveBeenCalled();
  });
  it('blocks XP and reaction event handlers when their modules are disabled', async () => {
    const services = { modules: { isEnabled: vi.fn(async () => false) },
      levels: { handleMessage: vi.fn() }, starboard: { reconcile: vi.fn() }, logger: { error: vi.fn() } } as unknown as Services;
    const events = buildRegistry(manifests).events;
    const xp = events.find(value => value.moduleKey === 'levels' && value.name === 'messageCreate')!;
    const reaction = events.find(value => value.moduleKey === 'starboard' && value.name === 'messageReactionAdd')!;
    await dispatchEvent(xp, services, { guildId: 'guild', author: { id: 'user', bot: false } });
    await dispatchEvent(reaction, services, { message: { guildId: 'guild', channelId: 'channel', id: 'message' } });
    expect(services.levels.handleMessage).not.toHaveBeenCalled();
    expect(services.starboard.reconcile).not.toHaveBeenCalled();
  });
});
