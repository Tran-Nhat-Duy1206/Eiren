import type { Command } from '../core/commands/command.js';
import type { BotEvent } from '../core/events/event.js';
import type { ModuleDefinition } from '../services/module-service.js';
import { coreCommands } from '../modules/core/commands.js';
import { coreEvents } from '../modules/core/events.js';

export interface ModuleManifest {
  definition: ModuleDefinition;
  commands: readonly Command[];
  events: readonly BotEvent[];
}

// New production modules contribute a manifest here; neither dispatcher needs editing.
export const manifests: readonly ModuleManifest[] = [{
  definition: { key: 'core', defaultEnabled: true }, commands: coreCommands, events: coreEvents,
}];

export function buildRegistry(modules: readonly ModuleManifest[]) {
  const commands = new Map<string, Command>();
  const events: BotEvent[] = [];
  const keys = new Set<string>();
  for (const module of modules) {
    const key = module.definition.key;
    if (keys.has(key)) throw new Error(`Duplicate module key: ${key}`);
    keys.add(key);
    for (const command of module.commands) {
      if (command.moduleKey !== key || commands.has(command.data.name)) throw new Error(`Invalid or duplicate command: ${command.data.name}`);
      commands.set(command.data.name, command);
    }
    for (const event of module.events) {
      if (event.moduleKey !== key) throw new Error(`Invalid event module: ${event.name}`);
      events.push(event);
    }
  }
  const definitions = new Map(modules.map(module => [module.definition.key, module.definition]));
  if (!definitions.has('core')) throw new Error('Missing core module');
  if (definitions.get('core')?.defaultEnabled !== true || definitions.get('core')?.dependencies?.length)
    throw new Error('Core must be permanently enabled and dependency-free');
  const visited = new Set<string>();
  const visiting = new Set<string>();
  function validate(key: string) {
    if (visiting.has(key)) throw new Error(`Cyclic module dependency: ${key}`);
    if (visited.has(key)) return;
    const definition = definitions.get(key);
    if (!definition) throw new Error(`Unknown module dependency: ${key}`);
    visiting.add(key);
    for (const dependency of definition.dependencies ?? []) validate(dependency);
    visiting.delete(key);
    visited.add(key);
  }
  for (const key of definitions.keys()) validate(key);
  return { commands, events, definitions: modules.map(module => module.definition) };
}
