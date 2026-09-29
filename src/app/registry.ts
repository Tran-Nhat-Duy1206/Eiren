import type { Command } from '../core/commands/command.js';
import type { BotEvent } from '../core/events/event.js';
import type { ButtonHandler, SelectMenuHandler } from '../core/components/component.js';
import type { ModuleDefinition } from '../services/module-service.js';
import { coreCommands } from '../modules/core/commands.js';
import { coreEvents } from '../modules/core/events.js';
import { loggingEvents } from '../modules/logging/events.js';
import { moderationCommands } from '../modules/moderation/commands.js';
import { antiraidCommands } from '../modules/antiraid/commands.js';
import { antiraidEvents } from '../modules/antiraid/events.js';
import { verificationButtons } from '../modules/verification/components.js';
import { verificationCommands } from '../modules/verification/commands.js';
import { verificationEvents } from '../modules/verification/events.js';
import { roleMenuCommands } from '../modules/roles/commands.js';
import { roleMenuButtons, roleMenuSelects } from '../modules/roles/components.js';
import { ticketCommands } from '../modules/tickets/commands.js';
import { reportCommands } from '../modules/reports/commands.js';
import { suggestionCommands } from '../modules/suggestions/commands.js';
import { suggestionButtons } from '../modules/suggestions/components.js';
import { levelsCommands } from '../modules/levels/commands.js';
import { levelsEvents } from '../modules/levels/events.js';
import { reputationCommands } from '../modules/reputation/commands.js';
import { starboardCommands } from '../modules/starboard/commands.js';
import { starboardEvents } from '../modules/starboard/events.js';
import { profileCommands } from '../modules/profiles/commands.js';
import { eventCommands } from '../modules/events/commands.js';
import { eventButtons } from '../modules/events/components.js';
import { giveawayCommands } from '../modules/giveaways/commands.js';
import { giveawayButtons } from '../modules/giveaways/components.js';
import { tempvoiceCommands } from '../modules/tempvoice/commands.js';
import { tempvoiceEvents } from '../modules/tempvoice/events.js';
import { achievementsCommands } from '../modules/achievements/commands.js';
import { analyticsCommands } from '../modules/analytics/commands.js';
import { analyticsEvents } from '../modules/analytics/events.js';
import { aiCommands } from '../modules/ai/commands.js';

export interface ModuleManifest {
  definition: ModuleDefinition;
  commands: readonly Command[];
  events: readonly BotEvent[];
  components?: readonly ButtonHandler[];
  selectComponents?: readonly SelectMenuHandler[];
}

// New production modules contribute a manifest here; neither dispatcher needs editing.
export const manifests: readonly ModuleManifest[] = [
  { definition: { key: 'core', defaultEnabled: true }, commands: [...coreCommands, ...analyticsCommands], events: coreEvents },
  { definition: { key: 'moderation', defaultEnabled: false }, commands: moderationCommands, events: [] },
  { definition: { key: 'logging', defaultEnabled: false }, commands: [], events: loggingEvents },
  { definition: { key: 'verification', defaultEnabled: false }, commands: verificationCommands, events: verificationEvents, components: verificationButtons },
  { definition: { key: 'antiraid', defaultEnabled: false, dependencies: ['verification'] }, commands: antiraidCommands, events: antiraidEvents },
  { definition: { key: 'roles', defaultEnabled: false }, commands: roleMenuCommands, events: [], components: roleMenuButtons, selectComponents: roleMenuSelects },
  { definition: { key: 'tickets', defaultEnabled: false }, commands: ticketCommands, events: [] },
  { definition: { key: 'reports', defaultEnabled: false }, commands: reportCommands, events: [] },
  { definition: { key: 'suggestions', defaultEnabled: false }, commands: suggestionCommands, events: [], components: suggestionButtons },
  { definition: { key: 'levels', defaultEnabled: false }, commands: levelsCommands, events: levelsEvents },
  { definition: { key: 'reputation', defaultEnabled: false }, commands: reputationCommands, events: [] },
  { definition: { key: 'starboard', defaultEnabled: false }, commands: starboardCommands, events: starboardEvents },
  { definition: { key: 'profiles', defaultEnabled: false }, commands: profileCommands, events: [] },
  { definition: { key: 'events', defaultEnabled: false }, commands: eventCommands, events: [], components: eventButtons },
  { definition: { key: 'giveaways', defaultEnabled: false }, commands: giveawayCommands, events: [], components: giveawayButtons },
  { definition: { key: 'tempvoice', defaultEnabled: false }, commands: tempvoiceCommands, events: tempvoiceEvents },
  { definition: { key: 'achievements', defaultEnabled: false }, commands: achievementsCommands, events: [] },
  { definition: { key: 'analytics', defaultEnabled: false }, commands: [], events: analyticsEvents },
  { definition: { key: 'ai', defaultEnabled: false }, commands: aiCommands, events: [] },
  { definition: { key: 'automation', defaultEnabled: false }, commands: [], events: [] },
];

export function buildRegistry(modules: readonly ModuleManifest[]) {
  const commands = new Map<string, Command>();
  const components = new Map<string, ButtonHandler>();
  const selects = new Map<string, SelectMenuHandler>();
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
    for (const button of module.components ?? []) {
      if (button.moduleKey !== key || components.has(button.customId)) throw new Error(`Invalid or duplicate component: ${button.customId}`);
      components.set(button.customId, button);
    }
    for (const select of module.selectComponents ?? []) {
      if (select.moduleKey !== key || selects.has(select.customId) || components.has(select.customId))
        throw new Error(`Invalid or duplicate select component: ${select.customId}`);
      selects.set(select.customId, select);
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
  return { commands, events, components, selects, definitions: modules.map(module => module.definition) };
}
