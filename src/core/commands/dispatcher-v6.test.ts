import { describe, expect, it, vi } from 'vitest';
import { SlashCommandBuilder } from 'discord.js';
import { AppError } from '../errors/errors.js';
import type { Services } from '../../app/services.js';
import type { Command } from './command.js';
import { dispatchCommand } from './dispatcher.js';

function fixture(execute = vi.fn(async () => undefined)) {
  const interaction = {
    commandName: 'sample', id: 'interaction-123', guildId: '123456789012345678',
    guild: { id: '123456789012345678', ownerId: '999999999999999999', members: { fetch: vi.fn(async () => ({ roles: { cache: new Map() } })) } },
    user: { id: '111111111111111111' }, deferReply: vi.fn(async () => undefined), editReply: vi.fn(async () => undefined),
    inGuild: () => true, deferred: true, replied: false,
  };
  const analytics = { recordCommand: vi.fn(async () => true) };
  const modules = { isEnabled: vi.fn(async (_guild: string, module: string) => module === 'analytics') };
  const permissions = { require: vi.fn(async () => undefined) };
  const logger = { error: vi.fn(), warn: vi.fn() };
  const services = { analytics, modules, permissions, logger } as unknown as Services;
  const command = { data: new SlashCommandBuilder().setName('sample').setDescription('Test command'),
    moduleKey: 'core', requiredLevel: 'HELPER', execute } as Command;
  return { interaction, analytics, modules, permissions, logger, services, command, execute };
}
describe('central dispatcher analytics instrumentation', () => {
  it('records one successful invocation with duration but no argument or user ID', async () => {
    const f = fixture();
    await dispatchCommand(f.interaction as never, new Map([['sample', f.command]]), f.services);
    expect(f.execute).toHaveBeenCalledOnce();
    expect(f.analytics.recordCommand).toHaveBeenCalledWith(f.interaction.guildId, f.interaction.id, 'sample', false,
      expect.any(Number), expect.any(Date));
    expect(JSON.stringify(f.analytics.recordCommand.mock.calls)).not.toContain(f.interaction.user.id);
  });
  it('counts failed commands and does not replace a safe error reply if telemetry fails', async () => {
    const f = fixture(vi.fn(async () => { throw new AppError('VALIDATION', 'Invalid command.'); }));
    f.analytics.recordCommand.mockRejectedValueOnce(new Error('analytics database unavailable'));
    await dispatchCommand(f.interaction as never, new Map([['sample', f.command]]), f.services);
    expect(f.analytics.recordCommand).toHaveBeenCalledWith(f.interaction.guildId, f.interaction.id, 'sample', true,
      expect.any(Number), expect.any(Date));
    expect(f.interaction.editReply).toHaveBeenCalledWith({ content: 'Invalid command.' });
    expect(f.logger.warn).toHaveBeenCalled();
  });
  it('does not collect while analytics is disabled', async () => {
    const f = fixture(); f.modules.isEnabled.mockResolvedValue(false);
    await dispatchCommand(f.interaction as never, new Map([['sample', f.command]]), f.services);
    expect(f.analytics.recordCommand).not.toHaveBeenCalled();
  });
});
