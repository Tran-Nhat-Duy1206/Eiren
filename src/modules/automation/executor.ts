import { AUTOMATION_ACTIONS, type AutomationActionDefinition } from './contracts.js';
import type { AutomationDiscordGateway, AutomationPreflight } from './discord-gateway.js';

export type AutomationActionPreflight =
  | Readonly<{ kind: 'READY'; send(): Promise<string> }>
  | Extract<AutomationPreflight, { kind: 'BLOCKED' }>;

export interface AutomationActionHandler {
  readonly definition: AutomationActionDefinition;
  preflight(guildId: string, config: unknown): Promise<AutomationActionPreflight>;
}

/** Registry contains only the two versioned, executable static-message actions. */
export function createAutomationActionHandlerRegistry(gateway: AutomationDiscordGateway): ReadonlyMap<string, AutomationActionHandler> {
  const handlers = new Map<string, AutomationActionHandler>();
  for (const definition of AUTOMATION_ACTIONS) {
    if (!definition.runnable || !['STATIC_MESSAGE', 'STAFF_LOG'].includes(definition.id) || definition.version !== 1) continue;
    handlers.set(`${definition.id}:${definition.version}`, {
      definition,
      async preflight(guildId, config) {
        const parsed = definition.configSchema.parse(config);
        const result = await gateway.preflight(guildId, parsed.channelId as string);
        return result.kind === 'BLOCKED' ? result : { kind: 'READY' as const, send: () => result.send(parsed.message as string) };
      },
    });
  }
  return handlers;
}

export function resolveAutomationActionHandler(
  key: string, version: number, registry: ReadonlyMap<string, AutomationActionHandler>,
): AutomationActionHandler | undefined {
  return registry.get(`${key}:${version}`);
}
