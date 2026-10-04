import { describe, expect, it, vi } from 'vitest';
import { configCommand, coreCommands, moduleCommand, setupCommand } from '../../modules/core/commands.js';

describe('core generated replies', () => {
  it('keeps registration and access levels stable', () => {
    expect(coreCommands.map(command => command.data.toJSON().name)).toEqual(['setup', 'config', 'module']);
    expect(configCommand.data.toJSON().options!.map(option => option.name)).toEqual(['view', 'set', 'role-set', 'role-remove', 'roles']);
    expect(setupCommand.requiredLevel).toBe('GUILD_OWNER');
    expect(moduleCommand.requiredLevel).toBe('ADMIN');
  });
  it('suppresses generated name mentions without overriding reply visibility or mutation', async () => {
    const editReply = vi.fn();
    const setEnabled = vi.fn();
    await moduleCommand.execute({ guildId: 'guild', user: { id: 'actor' }, editReply,
      options: { getSubcommand: () => 'disable', getString: () => '@everyone' } } as never,
    { guildConfig: { get: async () => ({}) }, modules: { setEnabled } } as never);
    expect(setEnabled).toHaveBeenCalledWith('guild', '@everyone', false, 'actor');
    expect(editReply).toHaveBeenCalledWith({ allowedMentions: { parse: [] }, content: '@everyone disabled.' });
    expect(editReply.mock.calls[0]![0]).not.toHaveProperty('flags');
    expect(editReply.mock.calls[0]![0]).not.toHaveProperty('ephemeral');
  });
});
