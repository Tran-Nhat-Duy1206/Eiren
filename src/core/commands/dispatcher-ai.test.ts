import { describe, expect, it, vi } from 'vitest';
import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import type { Services } from '../../app/services.js';
import type { Command } from './command.js';
import { aiCommands } from '../../modules/ai/commands.js';
import { dispatchCommand } from './dispatcher.js';

const guildId = '123456789012345678', userId = '223456789012345678';
function fixture(subcommand: 'ask' | 'summarize' | 'status' = 'ask') {
  const interaction = {
    id: 'interaction-123', commandName: 'ai', guildId, user: { id: userId },
    guild: { id: guildId, ownerId: userId,
      members: { fetch: vi.fn(async () => ({ roles: { cache: new Map() } })) } },
    inGuild: () => true, deferred: true, replied: false,
    options: { getSubcommand: vi.fn(() => subcommand), getString: vi.fn(() => 'explicit text @everyone') },
    deferReply: vi.fn(async () => undefined), editReply: vi.fn(async () => undefined),
  };
  const ai = { reserveIngress: vi.fn(async () => Object.freeze({ guildId, epoch: 7 })) };
  const aiRuntime = { status: vi.fn(() => ({ providerAvailable: false, config: null })),
    run: vi.fn(async (_request?: { ingress: { epoch: number } | null }) => ({ kind: 'ok' as const, text: 'safe @everyone' })) };
  const analytics = { reserveIngestion: vi.fn(async () => null), recordCommand: vi.fn(async () => true) };
  const modules = { isEnabled: vi.fn(async () => true) };
  const permissions = { require: vi.fn(async () => undefined) };
  const logger = { error: vi.fn(), warn: vi.fn() };
  const services = { ai, aiRuntime, analytics, modules, permissions, logger } as unknown as Services;
  return { interaction, ai, aiRuntime, analytics, modules, permissions, logger, services };
}

describe('explicit AI command dispatcher ingress', () => {
  it('captures the original epoch before optional analytics or reply awaits', async () => {
    const f = fixture();
    let reached!: () => void, release!: () => void;
    const paused = new Promise<void>(resolve => { reached = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    let currentEpoch = 7;
    const provider = vi.fn();
    const quota = vi.fn();
    f.analytics.reserveIngestion.mockImplementationOnce(async () => { reached(); await gate; return null; });
    f.aiRuntime.run.mockImplementationOnce(async request => {
      if (request?.ingress?.epoch !== currentEpoch) return { kind: 'disabled' } as never;
      quota(); provider(); return { kind: 'ok', text: 'unexpected' };
    });
    const pending = dispatchCommand(f.interaction as never, new Map([['ai', aiCommands[0]!]]), f.services);
    await paused;
    try {
      expect(f.ai.reserveIngress).toHaveBeenCalledExactlyOnceWith(guildId);
      expect(f.interaction.deferReply).not.toHaveBeenCalled();
    } finally { currentEpoch = 9; release(); await pending; }
    expect(f.aiRuntime.run).toHaveBeenCalledWith(expect.objectContaining({ ingress: { guildId, epoch: 7 } }));
    expect(provider).not.toHaveBeenCalled();
    expect(quota).not.toHaveBeenCalled();
    expect(f.interaction.editReply).toHaveBeenCalledWith({
      content: expect.stringContaining('before AI was re-enabled'), allowedMentions: { parse: [] },
    });
  });
  it('keeps output ephemeral and disables mentions even for mass-ping-shaped text', async () => {
    const f = fixture();
    await dispatchCommand(f.interaction as never, new Map([['ai', aiCommands[0]!]]), f.services);
    expect(f.interaction.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    expect(f.interaction.editReply).toHaveBeenCalledWith({ content: 'safe @everyone', allowedMentions: { parse: [] } });
    expect(f.interaction.options.getString).toHaveBeenCalledWith('prompt', true);
  });
  it('shows private status when AI is disabled without reserving or leaking credentials', async () => {
    const f = fixture('status');
    f.modules.isEnabled.mockResolvedValue(false);
    await dispatchCommand(f.interaction as never, new Map([['ai', aiCommands[0]!]]), f.services);
    expect(f.ai.reserveIngress).not.toHaveBeenCalled();
    expect(f.aiRuntime.run).not.toHaveBeenCalled();
    expect(f.interaction.editReply).toHaveBeenCalledWith({
      content: 'AI module disabled; provider unavailable.', allowedMentions: { parse: [] },
    });
  });
  it('AI disabled prevents admission and provider dispatch', async () => {
    const f = fixture();
    f.ai.reserveIngress.mockResolvedValue(null as never);
    f.modules.isEnabled.mockResolvedValue(false);
    await dispatchCommand(f.interaction as never, new Map([['ai', aiCommands[0]!]]), f.services);
    expect(f.aiRuntime.run).not.toHaveBeenCalled();
    expect(f.interaction.editReply).toHaveBeenCalledWith({
      content: 'This module is disabled in this server.', allowedMentions: { parse: [] },
    });
  });
  it('never logs a raw provider error or crashes a deferred AI command', async () => {
    const f = fixture();
    f.aiRuntime.run.mockRejectedValueOnce(new Error('raw provider credential and private text'));
    await dispatchCommand(f.interaction as never, new Map([['ai', aiCommands[0]!]]), f.services);
    expect(f.interaction.editReply).toHaveBeenCalledWith({
      content: 'AI is temporarily unavailable.', allowedMentions: { parse: [] },
    });
    expect(JSON.stringify(f.logger.warn.mock.calls)).not.toContain('private text');
    expect(JSON.stringify(f.logger.error.mock.calls)).not.toContain('credential');
  });
  it('does not reserve AI ingress for existing non-AI commands', async () => {
    const f = fixture();
    f.interaction.commandName = 'sample';
    const execute = vi.fn(async () => undefined);
    const sample: Command = { data: new SlashCommandBuilder().setName('sample').setDescription('sample'),
      moduleKey: 'core', requiredLevel: 'MEMBER', execute };
    await dispatchCommand(f.interaction as never, new Map([['sample', sample]]), f.services);
    expect(execute).toHaveBeenCalledOnce();
    expect(f.ai.reserveIngress).not.toHaveBeenCalled();
  });
});
