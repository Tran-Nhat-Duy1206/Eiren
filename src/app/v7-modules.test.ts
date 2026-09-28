import { describe, expect, it, vi } from 'vitest';
import { buildRegistry, manifests } from './registry.js';
import { ModuleService } from '../services/module-service.js';

const repository = () => ({ getModuleState: vi.fn(async (_guild: string, key: string) => states.get(key)),
  setModuleState: vi.fn(async (_guild: string, key: string, enabled: boolean) => { states.set(key, enabled); }),
  listModuleStates: vi.fn(async () => []) });
const states = new Map<string, boolean>();

describe('V7 independent inactive module manifests', () => {
  it('has no handlers or dependencies and defaults both off', async () => {
    states.clear();
    const registry = buildRegistry(manifests);
    const service = new ModuleService(repository(), registry.definitions);
    for (const key of ['ai', 'automation']) {
      expect(registry.definitions.find(definition => definition.key === key)).toEqual({ key, defaultEnabled: false });
      expect(registry.commands.size && [...registry.commands.values()].some(command => command.moduleKey === key)).toBe(false);
      expect(registry.events.some(event => event.moduleKey === key)).toBe(false);
      expect([...registry.components.values(), ...registry.selects.values()].some(component => component.moduleKey === key)).toBe(false);
      expect(await service.isEnabled('guild', key)).toBe(false);
    }
  });
  it('toggles either module without changing the other', async () => {
    states.clear();
    const service = new ModuleService(repository(), buildRegistry(manifests).definitions);
    await service.setEnabled('guild', 'ai', true, 'actor');
    expect(await service.isEnabled('guild', 'ai')).toBe(true);
    expect(await service.isEnabled('guild', 'automation')).toBe(false);
    await service.setEnabled('guild', 'automation', true, 'actor');
    await service.setEnabled('guild', 'ai', false, 'actor');
    expect(await service.isEnabled('guild', 'automation')).toBe(true);
    expect(await service.isEnabled('guild', 'ai')).toBe(false);
    await service.setEnabled('guild', 'ai', true, 'actor');
    await service.setEnabled('guild', 'automation', false, 'actor');
    expect(await service.isEnabled('guild', 'ai')).toBe(true);
    expect(await service.isEnabled('guild', 'automation')).toBe(false);
  });
});
