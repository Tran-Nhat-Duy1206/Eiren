import type { QueryResultRow } from 'pg';
import { boundedOperationalRead, type Diagnostic, type OperationalDatabase, type OperationsDiagnostics } from '../core/operations/diagnostics.js';
import type { ModuleService } from './module-service.js';
export type ModuleOperationalRow = { key: string; enabled: boolean; version: number };
export type GuildOperationsView = { modules: ModuleOperationalRow[] | null; diagnostics: Diagnostic[] };
interface ModuleRow extends QueryResultRow { module_key: string; enabled: boolean; version: number }
/** Guild-only classification. Runtime/readiness composition belongs to the parent read model. */
export class OperationsService {
  constructor(private readonly diagnostics: Pick<OperationsDiagnostics, 'inspect'>,
    private readonly reader: Pick<OperationalDatabase, 'query'>,
    private readonly modules: Pick<ModuleService, 'describeOperationalStates'>) {}
  async view(guildId: string): Promise<GuildOperationsView> {
    const moduleRead = async (): Promise<ModuleOperationalRow[] | null> => {
      try {
        const keys = this.modules.describeOperationalStates([]).map(row => row.key);
        const { rows } = await boundedOperationalRead(() => this.reader.query<ModuleRow>(
          'SELECT module_key,enabled,version FROM guild_modules WHERE guild_id=$1 AND module_key=ANY($2::text[]) LIMIT $3', [guildId, keys, keys.length]));
        if (rows.some(row => !keys.includes(row.module_key) || typeof row.enabled !== 'boolean' || !Number.isSafeInteger(row.version) || row.version < 0)) return null;
        return this.modules.describeOperationalStates(rows.map(row => ({ moduleKey: row.module_key, enabled: row.enabled, version: row.version })));
      } catch { return null; }
    };
    const [modules, diagnostics] = await Promise.all([moduleRead(), this.diagnostics.inspect(guildId)]);
    return { modules, diagnostics };
  }
}
