import { describe, expect, it, vi } from 'vitest';
import { Events, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { PermissionService } from './permissions/permission-service.js';
import { ModuleService } from '../services/module-service.js';
import { GuildConfigService } from '../services/guild-config-service.js';
import { AppError, handleError } from './errors/errors.js';
import { dispatchCommand } from './commands/dispatcher.js';
import { dispatchEvent, type BotEvent } from './events/event.js';
import { buildRegistry, type ModuleManifest } from '../app/registry.js';
import { setupCommand, coreCommands } from '../modules/core/commands.js';
import type { GuildRepository } from '../repositories/guild-repository.js';
import type { Services } from '../app/services.js';

const owner = { userId: '12345678901234567', guildId: '22345678901234567', guildOwnerId: '12345678901234567', roleIds: [] };
const staff = { ...owner, userId: '32345678901234567', roleIds: ['42345678901234567'] };

function fixture() {
  const state = new Map<string, boolean>();
  const repository = {
    getModuleState: vi.fn(async (_guild: string, key: string) => state.get(key)),
    setModuleState: vi.fn(async (_guild: string, key: string, enabled: boolean) => { state.set(key, enabled); }),
    listModuleStates: vi.fn(async () => []),
    getRoleLevels: vi.fn(async (_guild: string, ids: string[]) => ids.length ? ['ADMIN'] : []),
  };
  const permissions = new PermissionService(repository);
  const modules = new ModuleService(repository, [
    { key: 'core', defaultEnabled: true }, { key: 'fixture', defaultEnabled: false, dependencies: ['core'] },
  ]);
  const logger = { error: vi.fn(), warn: vi.fn() };
  const services = { modules, permissions, logger } as unknown as Services;
  return { repository, permissions, modules, logger, services };
}

describe('permission isolation', () => {
  it('recognizes guild owner, mapped roles and refuses mapping delegation', async () => {
    const { permissions, repository } = fixture();
    expect(await permissions.resolve(owner)).toBe('GUILD_OWNER');
    expect(await permissions.resolve(staff)).toBe('ADMIN');
    await expect(permissions.setRole(staff, '52345678901234567', 'ADMIN', repository as unknown as GuildRepository)).rejects.toMatchObject({ code: 'PERMISSION' });
    await expect(permissions.setRole(owner, '52345678901234567', 'GUILD_OWNER', repository as unknown as GuildRepository)).rejects.toMatchObject({ code: 'VALIDATION' });
  });
  it('never promotes a role to owner even with invalid stored mapping', async () => {
    const permissions = new PermissionService({ getRoleLevels: async () => ['GUILD_OWNER'] });
    expect(await permissions.resolve(staff)).toBe('ADMIN');
  });
});

describe('guild configuration and modules', () => {
  it('rejects invalid settings and requires initial setup', async () => {
    const repo = { updateSettings: vi.fn(async () => undefined) };
    const config = new GuildConfigService(repo as unknown as GuildRepository);
    await expect(config.update(owner.guildId, 'timezone', 'not_a_timezone')).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(config.update(owner.guildId, 'log_channel', '123')).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(config.update(owner.guildId, 'language', 'en')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
  it('keeps core enabled and toggles fixture persistently', async () => {
    const { modules, repository } = fixture();
    expect(await modules.isEnabled(owner.guildId, 'core')).toBe(true);
    expect(await modules.isEnabled(owner.guildId, 'fixture')).toBe(false);
    await expect(modules.setEnabled(owner.guildId, 'core', false, owner.userId)).rejects.toMatchObject({ code: 'VALIDATION' });
    await modules.setEnabled(owner.guildId, 'fixture', true, owner.userId);
    expect(await modules.isEnabled(owner.guildId, 'fixture')).toBe(true);
    await modules.setEnabled(owner.guildId, 'fixture', false, owner.userId);
    expect(await modules.isEnabled(owner.guildId, 'fixture')).toBe(false);
    expect(repository.setModuleState).toHaveBeenCalledTimes(2);
  });
  it('does not activate optional modules when required gateway capability is unavailable', async () => {
    const { repository } = fixture();
    const modules = new ModuleService(repository, [{ key: 'core', defaultEnabled: true }, { key: 'logging', defaultEnabled: false }], new Set(['logging']));
    await expect(modules.setEnabled(owner.guildId, 'logging', true, owner.userId)).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(await modules.isEnabled(owner.guildId, 'logging')).toBe(false);
  });
  it('does not expose internal test modules to guild management', async () => {
    const { repository } = fixture();
    const modules = new ModuleService(repository, [{ key: 'core', defaultEnabled: true }, { key: 'test', defaultEnabled: false, internal: true }]);
    expect(modules.listAvailable()).toEqual([]);
    await expect(modules.setEnabled(owner.guildId, 'test', true, owner.userId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('slash registration payload', () => {
  it('serializes the V0 command builders without credentials or duplicate roots', () => {
    const payloads = coreCommands.map(command => command.data.toJSON());
    expect(payloads.map(payload => payload.name)).toEqual(['setup', 'config', 'module']);
    expect(new Set(payloads.map(payload => payload.name)).size).toBe(3);
    expect(JSON.stringify(payloads)).not.toContain('DISCORD_TOKEN');
  });
});

describe('setup command', () => {
  it('preserves already initialized settings on repeated calls', async () => {
    let settings: { language: string; timezone: string } | undefined;
    const guildConfig = {
      get: vi.fn(async () => settings),
      setup: vi.fn(async () => { settings ??= { language: 'en', timezone: 'UTC' }; return settings; }),
    };
    const editReply = vi.fn(async () => {});
    const interaction = { guildId: owner.guildId, editReply };
    await setupCommand.execute(interaction as never, { guildConfig } as unknown as Services);
    settings!.timezone = 'Asia/Tokyo';
    await setupCommand.execute(interaction as never, { guildConfig } as unknown as Services);
    expect(await guildConfig.get()).toMatchObject({ timezone: 'Asia/Tokyo' });
    expect(editReply).toHaveBeenLastCalledWith({ allowedMentions: { parse: [] }, content: expect.stringContaining('Already initialized') });
    expect(guildConfig.setup).toHaveBeenCalledTimes(2);
  });
});

describe('framework gating', () => {
  it('blocks disabled commands before executing or fetching member; permits after enabling', async () => {
    const { services, modules } = fixture();
    const execute = vi.fn(async () => {});
    const command = { moduleKey: 'fixture', requiredLevel: 'ADMIN' as const,
      data: new SlashCommandBuilder().setName('fixture').setDescription('Test-only fixture'), execute };
    const fetch = vi.fn(async () => ({ roles: { cache: new Map([[staff.roleIds[0], true]]) } }));
    const editReply = vi.fn(async () => {});
    const deferReply = vi.fn(async () => {});
    const interaction = {
      commandName: 'fixture', user: { id: staff.userId }, guildId: owner.guildId,
      guild: { ownerId: owner.guildOwnerId, members: { fetch } },
      inGuild: () => true, deferred: true, deferReply, editReply,
    };
    await dispatchCommand(interaction as never, new Map([['fixture', command]]), services);
    expect(deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    expect(execute).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(editReply).toHaveBeenCalledWith({ content: 'This module is disabled in this server.' });
    await modules.setEnabled(owner.guildId, 'fixture', true, owner.userId);
    await dispatchCommand(interaction as never, new Map([['fixture', command]]), services);
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it('blocks disabled events including guildless events', async () => {
    const { services, modules } = fixture();
    const handle = vi.fn(async () => {});
    const event: BotEvent = { moduleKey: 'fixture', name: Events.GuildCreate, guildId: () => owner.guildId, handle };
    await dispatchEvent(event, services);
    expect(handle).not.toHaveBeenCalled();
    await modules.setEnabled(owner.guildId, 'fixture', true, owner.userId);
    await dispatchEvent(event, services);
    expect(handle).toHaveBeenCalledTimes(1);
    await dispatchEvent({ ...event, guildId: () => null }, services);
    expect(handle).toHaveBeenCalledTimes(1);
  });
  it('rejects invalid manifests and supports test-only fixture composition', () => {
    const fixtureModule: ModuleManifest = { definition: { key: 'fixture', defaultEnabled: false }, commands: [], events: [] };
    expect(buildRegistry([{ definition: { key: 'core', defaultEnabled: true }, commands: [], events: [] }, fixtureModule]).definitions).toHaveLength(2);
    expect(() => buildRegistry([fixtureModule])).toThrow('Missing core module');
    const core: ModuleManifest = { definition: { key: 'core', defaultEnabled: true }, commands: [], events: [] };
    expect(() => buildRegistry([core, { ...fixtureModule, definition: { key: 'fixture', defaultEnabled: true, dependencies: ['fixture'] } }]))
      .toThrow('Cyclic module dependency');
    expect(() => buildRegistry([{ ...core, definition: { key: 'core', defaultEnabled: false } }])).toThrow('Core must be permanently enabled');
  });
});

describe('error boundary', () => {
  it('does not expose unexpected errors and emits a correlation ID', () => {
    const logger = { error: vi.fn(), warn: vi.fn() };
    const message = handleError(new Error('private diagnostic'), logger as never, { command: 'test' });
    expect(message).toMatch(/^Something went wrong\. Error ID: [0-9a-f-]{36}$/);
    expect(message).not.toContain('private diagnostic');
    expect(logger.error).toHaveBeenCalledOnce();
    expect(handleError(new AppError('PERMISSION', 'Denied'), logger as never, {})).toBe('Denied');
  });
});
