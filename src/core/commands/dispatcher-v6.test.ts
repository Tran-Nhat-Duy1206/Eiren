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
  const analytics = { recordCommand: vi.fn(async (_token?: { epoch: number }) => true),
    reserveIngestion: vi.fn(async (guildId: string): Promise<{ guildId: string; epoch: number } | null> => ({ guildId, epoch: 7 })) };
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
    expect(f.analytics.recordCommand).toHaveBeenCalledWith({ guildId: f.interaction.guildId, epoch: 7 },
      f.interaction.id, 'sample', false,
      expect.any(Number), expect.any(Date));
    expect(JSON.stringify(f.analytics.recordCommand.mock.calls)).not.toContain(f.interaction.user.id);
  });
  it('counts failed commands and does not replace a safe error reply if telemetry fails', async () => {
    const f = fixture(vi.fn(async () => { throw new AppError('VALIDATION', 'Invalid command.'); }));
    f.analytics.recordCommand.mockRejectedValueOnce(new Error('analytics database unavailable'));
    await dispatchCommand(f.interaction as never, new Map([['sample', f.command]]), f.services);
    expect(f.analytics.recordCommand).toHaveBeenCalledWith({ guildId: f.interaction.guildId, epoch: 7 },
      f.interaction.id, 'sample', true,
      expect.any(Number), expect.any(Date));
    expect(f.interaction.editReply).toHaveBeenCalledWith({ content: 'Invalid command.' });
    expect(f.logger.warn).toHaveBeenCalled();
  });
  it('captures command telemetry ingress before the first deferred reply await', async () => {
    const f = fixture();
    let signal!: () => void;
    let release!: () => void;
    const reachedDefer = new Promise<void>(resolve => { signal = resolve; });
    const deferred = new Promise<void>(resolve => { release = resolve; });
    let currentEpoch = 7;
    const accepted: boolean[] = [];
    f.analytics.recordCommand.mockImplementationOnce(async token => { accepted.push(token?.epoch === currentEpoch); return true; });
    f.interaction.deferReply.mockImplementationOnce(() => { signal(); return deferred.then(() => undefined); });
    const dispatch = dispatchCommand(f.interaction as never, new Map([['sample', f.command]]), f.services);
    await reachedDefer;
    try { expect(f.analytics.reserveIngestion).toHaveBeenCalledExactlyOnceWith(f.interaction.guildId); }
    finally { currentEpoch = 9; release(); await dispatch; }
    expect(accepted).toEqual([false]);
    expect(f.analytics.recordCommand).toHaveBeenCalledWith({ guildId: f.interaction.guildId, epoch: 7 },
      f.interaction.id, 'sample', false, expect.any(Number), expect.any(Date));
  });
  it('continues the user command when optional analytics reservation fails', async () => {
    const f = fixture();
    f.analytics.reserveIngestion.mockRejectedValueOnce(new Error('database unavailable'));
    await dispatchCommand(f.interaction as never, new Map([['sample', f.command]]), f.services);
    expect(f.execute).toHaveBeenCalledOnce();
    expect(f.analytics.recordCommand).not.toHaveBeenCalled();
    expect(f.logger.warn).toHaveBeenCalledWith({ command: 'sample', errorType: 'Error' },
      'Optional command analytics ingress failed');
  });
  it('does not collect while analytics is disabled', async () => {
    const f = fixture(); f.analytics.reserveIngestion.mockResolvedValueOnce(null);
    await dispatchCommand(f.interaction as never, new Map([['sample', f.command]]), f.services);
    expect(f.execute).toHaveBeenCalledOnce();
    expect(f.analytics.recordCommand).not.toHaveBeenCalled();
  });
});
