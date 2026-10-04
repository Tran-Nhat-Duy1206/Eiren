import { describe, expect, it, vi } from 'vitest';
import { MessageFlags, type ChatInputCommandInteraction } from 'discord.js';
import type { Services } from '../../app/services.js';
import { dispatchCommand } from '../../core/commands/dispatcher.js';
import { presentationColor } from '../../core/presentation/index.js';
import { modCommand } from './commands.js';
import { profileCommands } from '../profiles/commands.js';
import { analyticsCommands } from '../analytics/commands.js';
import { starboardPost } from '../starboard/discord-gateway.js';

function interaction(commandName: string, sub = 'case') {
  return { commandName, inGuild: () => true, guildId: 'g', guild: { id: 'g', ownerId: 'owner', members: { fetch: vi.fn(async () => ({ roles: { cache: new Map() }, displayName: 'Member', joinedAt: new Date(1999) })) } },
    user: { id: 'member' }, options: { getSubcommand: () => sub, getInteger: () => 1, getUser: () => null, getString: (name: string) => name === 'range' ? '24h' : null },
    deferReply: vi.fn(async () => {}), editReply: vi.fn(async () => {}), deferred: true, replied: false,
  } as unknown as ChatInputCommandInteraction;
}
function services(extra: object) {
  return { modules: { isEnabled: vi.fn(async () => true) }, permissions: { require: vi.fn(async () => {}) },
    analytics: { reserveIngestion: vi.fn(async () => null) }, logger: { error: vi.fn(), warn: vi.fn() }, ...extra } as unknown as Services;
}
describe('owned module Discord presentation compatibility', () => {
  it('keeps authorized moderation reasons intact and case responses private with source timestamps', async () => {
    const reason = 'Original reason: @everyone <@123> `literal`';
    const f = interaction('mod');
    const getCase = vi.fn(async () => ({ id: 1, action: 'WARN', status: 'ACTIVE', targetId: 'target', moderatorId: 'staff', reason, createdAt: new Date(1999), expiresAt: new Date(2999) }));
    await dispatchCommand(f, new Map([['mod', modCommand]]), services({ moderation: { getCase } }));
    expect(f.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    expect(f.editReply).toHaveBeenCalledWith({ content: `Case #1 — WARN (ACTIVE)\nTarget: target\nModerator: staff\nReason: ${reason}\nCreated: <t:1:F>\nExpires: <t:2:F>`, allowedMentions: { parse: [] } });
  });
  it('keeps profile visibility under the existing dispatcher and omits disabled sources', async () => {
    const command = profileCommands[0]!;
    const f = interaction('profile');
    await dispatchCommand(f, new Map([['profile', command]]), services({ profiles: { get: vi.fn(async () => ({})) } }));
    expect(f.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    expect(f.editReply).toHaveBeenCalledWith({ embeds: [expect.objectContaining({ title: 'Community profile', color: presentationColor('DISABLED'), description: expect.stringContaining('Levels and reputation are disabled') })], allowedMentions: { parse: [] } });
    const payload = vi.mocked(f.editReply).mock.calls[0]![0] as unknown as { embeds: Array<{ description: string }> };
    expect(payload.embeds[0]!.description).toContain('Joined: <t:1:F>');
  });
  it('bounds generated analytics summaries and labels rather than shifts timezone', async () => {
    const f = interaction('analytics', 'summary');
    await analyticsCommands[0]!.execute(f, services({ analytics: { status: async () => ({ enabled: true }), summaryFor: async () => ({ range: '24h', timezone: 'UTC', totals: { messages: 1, joins: 2, leaves: 1, net: 1, voiceSeconds: 3 }, channels: [{ channelId: 'x'.repeat(3000), messages: 1 }], commands: [], business: {} }) } }));
    const payload = vi.mocked(f.editReply).mock.calls[0]![0] as unknown as { embeds: Array<{ description: string; fields: Array<{ value: string }> }>; allowedMentions: object };
    expect(payload.embeds[0]!.description).toContain('Timezone label: UTC');
    expect(payload.embeds[0]!.fields[0]!.value.length).toBeLessThanOrEqual(1024);
    expect(payload.allowedMentions).toEqual({ parse: [] });
  });
  it('retains public starboard narrative, links and timestamp without introducing a ping', () => {
    const content = 'Original @everyone <@123> `narrative`';
    const payload = starboardPost({ guildId: 'g', channelId: 'c', messageId: 'm', authorId: 'a', createdAt: new Date(1999), nsfw: false, public: true, content }, 3, '⭐');
    const embed = payload.embeds[0]!.toJSON();
    expect(embed.fields?.find(field => field.name === 'Message')?.value).toBe(content);
    expect(embed.description).toBe('[Jump to message](https://discord.com/channels/g/c/m)');
    expect(embed.timestamp).toBe(new Date(1999).toISOString());
    expect(embed.color).toBe(presentationColor('INFO'));
    expect(payload.allowedMentions).toEqual({ parse: [] });
  });
});
