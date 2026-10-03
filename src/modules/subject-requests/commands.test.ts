import { describe, expect, it, vi } from 'vitest';
import { MessageFlags, type ChatInputCommandInteraction } from 'discord.js';
import { privacyCommand, ownRequestContent } from './commands.js';
import { SCOPE_WARNING, WORKFLOW_EVIDENCE_WARNING, type SubjectRequestView } from './contracts.js';
import type { Services } from '../../app/services.js';
import { buildRegistry, manifests } from '../../app/registry.js';
import { dispatchCommand } from '../../core/commands/dispatcher.js';
import { AppError } from '../../core/errors/errors.js';

const guildId = '990000000000000001', userId = '990000000000000002';
const request = { id: '123e4567-e89b-42d3-a456-426614174000', status: 'PENDING', denialCode: null,
  requestedAt: '2026-01-01T00:00:00.000Z', terminalAt: null,
  secretNarrative: 'DO_NOT_DISPLAY_PRIVATE_DATA' } as unknown as SubjectRequestView;
function fixture(action: string) {
  const interaction = { commandName: 'privacy', inGuild: () => true, guildId, user: { id: userId },
    guild: { id: guildId, ownerId: '990000000000000003', members: { fetch: vi.fn(async () => ({ roles: { cache: new Map() } })) } },
    options: { getSubcommand: () => action }, deferred: true, replied: false,
    deferReply: vi.fn(async () => undefined), editReply: vi.fn(async () => undefined),
  } as unknown as ChatInputCommandInteraction;
  const subjectRequests = { createSelfRequest: vi.fn(async () => request), ownStatus: vi.fn(async () => request) };
  const services = { subjectRequests, modules: { isEnabled: vi.fn() }, permissions: { require: vi.fn(async () => undefined) },
    analytics: { reserveIngestion: vi.fn(async () => null) }, logger: { warn: vi.fn(), error: vi.fn() },
  } as unknown as Services;
  return { interaction, services, subjectRequests };
}

describe('core self-only privacy command', () => {
  it('registers under always-available core with no target or free-text options', () => {
    expect(buildRegistry(manifests).commands.get('privacy')).toBe(privacyCommand);
    expect(privacyCommand.moduleKey).toBe('core'); expect(privacyCommand.requiredLevel).toBe('MEMBER');
    const options = privacyCommand.data.toJSON().options!;
    expect(options.map(option => option.name)).toEqual(['request', 'status']);
    for (const option of options) expect('options' in option ? option.options ?? [] : []).toEqual([]);
  });
  it('passes only authenticated interaction for self membership verification at creation', async () => {
    const f = fixture('request'); await privacyCommand.execute(f.interaction, f.services);
    expect(f.subjectRequests.createSelfRequest).toHaveBeenCalledExactlyOnceWith(f.interaction);
    expect(f.subjectRequests.ownStatus).not.toHaveBeenCalled();
    expect(f.interaction.editReply).toHaveBeenCalledWith({ content: ownRequestContent(request), allowedMentions: { parse: [] } });
  });
  it('reads own status bound to authenticated guild/user without fresh subject verification', async () => {
    const f = fixture('status'); await privacyCommand.execute(f.interaction, f.services);
    expect(f.subjectRequests.ownStatus).toHaveBeenCalledExactlyOnceWith({ guildId, userId });
    expect(f.subjectRequests.createSelfRequest).not.toHaveBeenCalled();
    expect(f.interaction.guild!.members.fetch).not.toHaveBeenCalled();
  });
  it('formats only whitelisted metadata and exact retained-copy/workflow warnings', () => {
    const text = ownRequestContent(request);
    expect(text).toContain(request.id); expect(text).toContain('PENDING'); expect(text).toContain(request.requestedAt); expect(text).not.toContain('DO_NOT_DISPLAY_PRIVATE_DATA');
    expect(ownRequestContent({...request,status:'DENIED',terminalAt:'2026-01-02T00:00:00.000Z',denialCode:'POLICY_RETAINED'})).toContain('Terminal: 2026-01-02T00:00:00.000Z');
    expect(text).toContain(SCOPE_WARNING); expect(text).toContain(WORKFLOW_EVIDENCE_WARNING); expect(text.length).toBeLessThanOrEqual(2000);
    expect(ownRequestContent(null)).toContain('No privacy request');
  });
  it('uses existing ephemeral dispatcher and bypasses disabled optional modules', async () => {
    const f = fixture('request'); await dispatchCommand(f.interaction, new Map([['privacy', privacyCommand]]), f.services);
    expect(f.interaction.deferReply).toHaveBeenCalledExactlyOnceWith({ flags: MessageFlags.Ephemeral });
    expect(f.services.modules.isEnabled).not.toHaveBeenCalled();
    expect(f.services.permissions.require).toHaveBeenCalledWith(expect.objectContaining({ guildId, userId }), 'MEMBER');
    expect(f.subjectRequests.createSelfRequest).toHaveBeenCalledExactlyOnceWith(f.interaction);
  });
  it('wraps raw backend failures at the sanitized dispatcher boundary without leaking details', async () => {
    for (const action of ['request', 'status']) {
      const f = fixture(action);
      const secret = 'PRIVATE_SQL_PASSWORD_AND_PAYLOAD';
      f.subjectRequests.createSelfRequest.mockRejectedValueOnce(new Error(secret));
      f.subjectRequests.ownStatus.mockRejectedValueOnce(new Error(secret));
      await dispatchCommand(f.interaction, new Map([['privacy', privacyCommand]]), f.services);
      expect(f.interaction.editReply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringMatching(/^Something went wrong\. Error ID: /) }));
      expect(JSON.stringify(vi.mocked(f.interaction.editReply).mock.calls)).not.toContain(secret);
      expect(JSON.stringify(vi.mocked(f.services.logger.error).mock.calls)).not.toContain(secret);
      expect(f.services.logger.error).toHaveBeenCalledWith(expect.objectContaining({ errorCode: 'DATABASE' }), 'Database request failed');
    }
  });
  it('preserves known static application rejections', async () => {
    const f = fixture('request'), denial = new AppError('PERMISSION', 'Verified current membership is required.');
    f.subjectRequests.createSelfRequest.mockRejectedValueOnce(denial);
    await expect(privacyCommand.execute(f.interaction, f.services)).rejects.toBe(denial);
  });
  it('rejects DM and unknown actions before backend access', async () => {
    const f = fixture('request'); f.interaction.inGuild = (() => false) as typeof f.interaction.inGuild;
    await expect(privacyCommand.execute(f.interaction, f.services)).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(f.subjectRequests.createSelfRequest).not.toHaveBeenCalled();
    const unknown = fixture('execute');
    await expect(privacyCommand.execute(unknown.interaction, unknown.services)).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(unknown.subjectRequests.createSelfRequest).not.toHaveBeenCalled(); expect(unknown.subjectRequests.ownStatus).not.toHaveBeenCalled();
  });
});
