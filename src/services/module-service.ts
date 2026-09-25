import { AppError } from '../core/errors/errors.js';
import type { GuildRepository } from '../repositories/guild-repository.js';

export type ModuleDefinition = { key: string; defaultEnabled: boolean; dependencies?: readonly string[]; internal?: boolean };
export class ModuleService {
  private readonly definitions: Map<string, ModuleDefinition>;
  constructor(private readonly repository: Pick<GuildRepository, 'getModuleState' | 'setModuleState' | 'listModuleStates'>,
    definitions: readonly ModuleDefinition[], private readonly unavailable: ReadonlySet<string> = new Set()) {
    this.definitions = new Map(definitions.map(definition => [definition.key, definition]));
    if (this.definitions.size !== definitions.length || !this.definitions.has('core')) throw new Error('Invalid module registry');
  }
  async isEnabled(guildId: string, key: string, seen = new Set<string>()): Promise<boolean> {
    if (key === 'core') return true;
    const definition = this.definitions.get(key);
    if (!definition || seen.has(key) || this.unavailable.has(key)) return false;
    seen.add(key);
    const override = await this.repository.getModuleState(guildId, key);
    if (!(override ?? definition.defaultEnabled)) return false;
    for (const dependency of definition.dependencies ?? []) {
      if (!await this.isEnabled(guildId, dependency, seen)) return false;
    }
    seen.delete(key);
    return true;
  }
  async setEnabled(guildId: string, key: string, enabled: boolean, actorId: string) {
    const definition = this.definitions.get(key);
    if (!definition || definition.internal) throw new AppError('NOT_FOUND', 'Unknown module.');
    if (key === 'core') throw new AppError('VALIDATION', 'Core cannot be disabled or changed.');
    if (enabled && this.unavailable.has(key))
      throw new AppError('VALIDATION', 'This module requires the Server Members Intent enabled in the Discord Developer Portal and ENABLE_GUILD_MEMBERS_INTENT=true.');
    if (enabled) {
      for (const dependency of definition.dependencies ?? []) {
        if (!await this.isEnabled(guildId, dependency)) throw new AppError('CONFLICT', `Enable dependency ${dependency} first.`);
      }
    } else {
      for (const other of this.definitions.values()) {
        if (other.dependencies?.includes(key) && await this.isEnabled(guildId, other.key))
          throw new AppError('CONFLICT', `Disable dependent module ${other.key} first.`);
      }
    }
    await this.repository.setModuleState(guildId, key, enabled, actorId);
  }
  listAvailable() { return [...this.definitions.values()].filter(definition => !definition.internal && definition.key !== 'core'); }
  async list(guildId: string) {
    return Promise.all(this.listAvailable().map(async definition => ({ key: definition.key, enabled: await this.isEnabled(guildId, definition.key) })));
  }
}
