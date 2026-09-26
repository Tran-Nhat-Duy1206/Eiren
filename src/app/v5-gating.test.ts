import { describe, expect, it, vi } from 'vitest';
import { dispatchCommand } from '../core/commands/dispatcher.js';
import { dispatchButton } from '../core/components/component.js';
import { dispatchEvent } from '../core/events/event.js';
import type { Services } from './services.js';
import { buildRegistry, manifests } from './registry.js';

const v5 = ['events', 'giveaways', 'tempvoice', 'achievements'];
describe('independent optional V5 module gating', () => {
  it('registers four disabled-by-default modules without hard source dependencies', () => {
    const registry = buildRegistry(manifests);
    for (const key of v5) expect(registry.definitions.find(module => module.key === key))
      .toMatchObject({ key, defaultEnabled: false });
    for (const key of v5) expect(registry.definitions.find(module => module.key === key)?.dependencies).toBeUndefined();
    expect(registry.commands.get('event')?.moduleKey).toBe('events');
    expect(registry.commands.get('giveaway')?.moduleKey).toBe('giveaways');
    expect(registry.commands.get('tempvoice')?.moduleKey).toBe('tempvoice');
    expect(registry.commands.get('voice')?.moduleKey).toBe('tempvoice');
    expect(registry.commands.get('achievements')?.moduleKey).toBe('achievements');
    expect(registry.components.get('event:')?.moduleKey).toBe('events');
    expect(registry.components.get('giveaway:')?.moduleKey).toBe('giveaways');
  });
  it.each(['event', 'giveaway', 'tempvoice', 'voice', 'achievements'])('blocks disabled /%s before permissions', async name => {
    const services = { modules: { isEnabled: vi.fn(async () => false) }, permissions: { require: vi.fn() },
      logger: { warn: vi.fn(), error: vi.fn() } } as unknown as Services;
    const interaction = { commandName: name, guildId: 'guild', guild: { members: { fetch: vi.fn() } },
      user: { id: 'member' }, inGuild: () => true, deferred: true, replied: false,
      deferReply: vi.fn(async () => {}), editReply: vi.fn(async () => {}) };
    await dispatchCommand(interaction as never, buildRegistry(manifests).commands, services);
    expect(interaction.editReply).toHaveBeenCalledWith({ content: 'This module is disabled in this server.' });
    expect(services.permissions.require).not.toHaveBeenCalled();
    expect(interaction.guild.members.fetch).not.toHaveBeenCalled();
  });
  it.each(['event:join:42', 'giveaway:enter:42'])('blocks old disabled button %s before mutation', async customId => {
    const services = { modules: { isEnabled: vi.fn(async () => false) }, logger: { error: vi.fn(), warn: vi.fn() },
      events: { button: vi.fn() }, giveaways: { entry: vi.fn() } } as unknown as Services;
    const interaction = { customId, guildId: 'guild', guild: {}, user: { id: 'member' },
      inGuild: () => true, deferred: false, replied: false, reply: vi.fn(async () => {}) };
    await dispatchButton(interaction as never, buildRegistry(manifests).components, services);
    expect(interaction.reply).toHaveBeenCalled();
    expect(services.events.button).not.toHaveBeenCalled();
    expect(services.giveaways.entry).not.toHaveBeenCalled();
  });
  it('blocks voice events while tempvoice module disabled', async () => {
    const services = { modules: { isEnabled: vi.fn(async () => false) }, tempvoice: { voiceChanged: vi.fn() },
      logger: { error: vi.fn() } } as unknown as Services;
    const event = buildRegistry(manifests).events.find(item => item.moduleKey === 'tempvoice' && item.name === 'voiceStateUpdate')!;
    const state = { guild: { id: 'guild' }, id: 'member', channelId: 'lobby', member: { user: { bot: false } } };
    await dispatchEvent(event, services, { ...state, channelId: null }, state);
    expect(services.tempvoice.voiceChanged).not.toHaveBeenCalled();
  });
});
