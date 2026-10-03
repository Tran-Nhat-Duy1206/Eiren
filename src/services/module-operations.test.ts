import { describe, expect, it } from 'vitest';
import { ModuleService } from './module-service.js';

describe('pure operational module availability matches ModuleService', () => {
  it('shows core, defaults, unavailable prerequisites and persisted epochs truthfully', async () => {
    const states = [{ moduleKey: 'core', enabled: false, version: 7 }, { moduleKey: 'logging', enabled: true, version: 3 },
      { moduleKey: 'automation', enabled: true, version: 5 }, { moduleKey: 'unused-unknown', enabled: true, version: 1 }];
    const service = new ModuleService({ getModuleState: async (_guild, key) => states.find(r => r.moduleKey === key)?.enabled,
      listModuleStates: async () => [], setModuleState: async () => undefined },
    [{ key: 'core', defaultEnabled: true }, { key: 'logging', defaultEnabled: true }, { key: 'automation', defaultEnabled: false, dependencies: ['logging'] },
      { key: 'analytics', defaultEnabled: true }, { key: 'internal', defaultEnabled: true, internal: true }], new Set(['logging']));
    const rows = service.describeOperationalStates(states);
    expect(rows).toEqual([{ key: 'core', enabled: true, version: 7 }, { key: 'logging', enabled: false, version: 3 },
      { key: 'automation', enabled: false, version: 5 }, { key: 'analytics', enabled: true, version: 0 }]);
    for (const row of rows) expect(row.enabled).toBe(await service.isEnabled('123456789012345678', row.key));
    expect(rows.some(r => r.key === 'unused-unknown' || r.key === 'internal')).toBe(false);
  });
  it('fails dependency cycles closed with default/no-override epoch 0', async () => {
    const service = new ModuleService({ getModuleState: async () => undefined, listModuleStates: async () => [], setModuleState: async () => undefined },
      [{ key: 'core', defaultEnabled: true }, { key: 'a', defaultEnabled: true, dependencies: ['b'] }, { key: 'b', defaultEnabled: true, dependencies: ['a'] }]);
    const rows = service.describeOperationalStates([]);
    for (const row of rows) { expect(row.version).toBe(0); expect(row.enabled).toBe(await service.isEnabled('123456789012345678', row.key)); }
  });
});
