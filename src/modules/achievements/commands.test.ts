import { describe, expect, it, vi } from 'vitest';
import type { ChatInputCommandInteraction } from 'discord.js';
import type { Services } from '../../app/services.js';
import { achievementsCommand } from './commands.js';

describe('read-only achievement command after erasure', () => {
  it('lists existing awards without evaluating retained historical sources', async () => {
    const listMember = vi.fn(async () => []), evaluateMember = vi.fn(async () => { throw new Error('must not rebuild awards'); });
    const interaction = { guildId: '990000000000000001', user: { id: '990000000000000002' },
      options: { getUser: () => null }, editReply: vi.fn(async () => undefined) } as unknown as ChatInputCommandInteraction;
    const services = { achievements: { listMember, evaluateMember } } as unknown as Services;
    await achievementsCommand.execute(interaction, services);
    expect(listMember).toHaveBeenCalledExactlyOnceWith(interaction.guildId, interaction.user.id);
    expect(evaluateMember).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith({ content: '<@990000000000000002> has no achievements yet.', allowedMentions: { parse: [] } });
  });
  it('uses the same read-only path for another member and displays only recorded awards', async () => {
    const listMember = vi.fn(async () => [{ name: 'Existing award', description: 'Recorded award' }]), evaluateMember = vi.fn();
    const interaction = { guildId: '990000000000000001', user: { id: '990000000000000002' },
      options: { getUser: () => ({ id: '990000000000000003' }) }, editReply: vi.fn(async () => undefined) } as unknown as ChatInputCommandInteraction;
    await achievementsCommand.execute(interaction, { achievements: { listMember, evaluateMember } } as unknown as Services);
    expect(listMember).toHaveBeenCalledExactlyOnceWith(interaction.guildId, '990000000000000003');
    expect(evaluateMember).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('Existing award — Recorded award') }));
  });
});
