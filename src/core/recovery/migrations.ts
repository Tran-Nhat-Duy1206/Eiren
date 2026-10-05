/** A pg.Client-compatible, read-only subset; query failures reach the safe caller wrapper. */
export interface MigrationQueryClient {
  query(text: string): Promise<{ rows: Record<string, unknown>[] }>;
}

/** Approved HEAD SQL blob bytes and their exact LF-to-CRLF variants, not runtime files.
 * Preserve final-newline presence. 0011 and 0012 have no newline, so their hashes match.
 * A changed migration requires explicit review of this checked-in inventory.
 */
export const MIGRATION_INVENTORY = [
  ['0000_spotty_tomas', '1790362470102', 'aab59b4fcceddb666ff6c6f48be05fe29a969e2aa74bb89617b27482d230c56b', '24a26e631d7921335144a967b471e40ded735dbbe5ddf6447ba591053cad5d79'],
  ['0001_aberrant_wild_child', '1790364854809', '3dea41a90741a51bd56877c5988125aba9a7584f4a86dd76cfcdefd90155c9b1', 'bc9e38d8ea6d5c16225a5521f64ed7b30898af1caa218dea4bfb6af480de3e50'],
  ['0002_complete_sasquatch', '1790378891417', '43e7fa33310d9855592050d2b86b95771a7a195ce168a8a1a59aafdd63012b44', 'bbd1283d905235ff4582b238be4ab63363a8f5620cfdf129d5fbc7baf3a658ea'],
  ['0003_needy_praxagora', '1790403837591', '6ce064e86afdf2b7c7e9ce3f060dad9ebfe189b4adcf61101eb16326e7a7c169', 'f3bc565d4ba01339f40e0d3d92a4e6af5978b3094c508ecdca1e3626bbc5c708'],
  ['0004_silent_the_fallen', '1790428351571', 'a1ef84dadca135b6b881aee5d37d05243bdf23a8094ca1506121b582f8c457c4', '4f11b7fa6e613eef261183e1ab716f1c28851cef3475a72362c12236a2c95f3e'],
  ['0005_bumpy_forgotten_one', '1790444750192', 'b1ca35c6e73227c130d87dcc1d2ca8bd2e06b56e885f9b0277f302e66eaa7e0e', '85dce7ea71c80d54cc7064f15fe20cb5dae214da000fed48f72d331c4e0a1b56'],
  ['0006_shallow_excalibur', '1790446662105', '058ab4177d5850a6f4a3411a8404ab272a1deeeda8eedba387e186bde55ea6ce', '30584aa45be0bdf0ffe90f6a7daa463c7ae0b529a19920e8dfa4203930f5ebff'],
  ['0007_easy_maestro', '1790446912610', 'a771ed86b424e5875b8ff5a825adbb63066a63d4606c0bd54cead07a4b5c7661', 'faa07bac91fcf78142e9ca78fa5e1494751fc71630dfe5ae3b96fd8ef473b27e'],
  ['0008_blue_dreadnoughts', '1790462819186', '2dff0d1f51636f5da2eef855cd3abee34fc0a2b56582ee83e0cb85ea67c873fe', 'c9c2696b4ab6b126ee9c1c047a04a5f82561ebd5d8601418bbd46c2e2c89f838'],
  ['0009_lumpy_freak', '1790465238110', '31a8c0d80b30b6dd668a31bf3cff47ab445b185c05a646ba22823278d88c04af', '70611d3a9fe3336ad258c23ad9bd059639cf675e2d3de27944ac61916ac83139'],
  ['0010_silky_taskmaster', '1790497453057', '322b1c50d22465b78b1cb631fdafcfd32906349934589738bcdd2fa1fd288080', '8ec05fbbe67858073ed38cd2fb9ebf5292bb09e0d55597ba61de86a02d88dd34'],
  ['0011_fuzzy_skaar', '1790521366446', 'fd4b65919479648451419179545027ec227a12fe19adf51e4ec534412caaa3a3', 'fd4b65919479648451419179545027ec227a12fe19adf51e4ec534412caaa3a3'],
  ['0012_brainy_stick', '1790523332413', 'c69d1954cbff42d6e79571540ebec76fa4563849372296bfca6212178972d9f6', 'c69d1954cbff42d6e79571540ebec76fa4563849372296bfca6212178972d9f6'],
  ['0013_youthful_tony_stark', '1790536681622', 'bbeb82b4176282fd77f08f1b30f7620f5edc97a8e903028832cb702ac1acf5d9', 'fd7e3f3e90095fc3ce6321623175b196b9ffb7b6e02c34efd33a39aa6d354932'],
  ['0014_perpetual_luckman', '1790559222083', 'c268dfedccd84c719e6073792a6c14d89eb5e8f33eea43fa8f2369304546499a', '71a2beb0c8dc88043bdd43d72f44d7328c580987dafa08d1219a78924e03932e'],
  ['0015_previous_rocket_racer', '1790689690538', '67a6d4d0bb6edf814553a56c2b491e1b3b740f9a79fde4a62f0d3059552e1d9b', '421f1a204467356cb4d67b243b96f4e87cff652dfb5231884ce95d34c48f7e09'],
  ['0016_cynical_proudstar', '1790694822203', '134ae176a00dab2607e0bb34e013f67d6701ca51e2690f5e9da40911e8dae236', '6dc2417314685dc60959649844494a33def1e32b5dab8981dabf8bbaaa84e6a4'],
  ['0017_eager_genesis', '1790719879955', 'ffb7466b299a6082e9f1b87f335e3815509ea23b69b10fcc3dc9f3cafa3aa88e', '222d51a09b8370ff851b3a738ca08900d25c22e575d7d80764ab55de60405e14'],
  ['0018_neat_tarantula', '1790831540500', '4a7275d6fb5dd6666ec67e134e1e92e09a4d6384bdd643727c159da9ccdd5709', '21d8686c41f2eead82862f55889c5c789ebb1362f69e4db586872d6fcac45302'],
  ['0019_fast_molecule_man', '1790835170502', '6619d57aafdc253e783cb3107affaa6cef6bbbcfde05b825100d89dcb0bcecdf', '799b047444f6d2620a23dfc8b01515cb69297d8a5bc24d6a788ef79c15d8efdb'],
  ['0020_subject_request_governance', '1791017773296', 'a3ad775bb706c9e26a95cd5b2c00cd4abefe3b517f4cabd7cc337e58ae305331', 'a1bc9fe64e87d38cfaa2acff247e689ac85adc8c1a3417f0a34f9128ca52423f'],
] as const;

export const GOVERNANCE_TABLES = [
  'retention_receipts', 'retention_policies', 'tickets', 'reports', 'appeals',
  'subject_execution_receipts', 'member_levels', 'member_reputation',
  'member_achievements', 'community_events', 'event_participants', 'event_attendance',
  'retention_previews', 'subject_requests', 'subject_request_previews',
  'subject_request_preview_counts', 'governance_audit_gaps',
] as const;

function integerText(value: unknown): string | undefined {
  if (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value === 'bigint' && value >= 0n) return String(value);
  return undefined;
}

/** Call before any governance reads. Never executes migrations or inspects local SQL.
 * Inventory/schema mismatches return false without diagnostics; query errors propagate
 * only to the caller's fixed-safe-error boundary, never to user-facing output here.
 */
export async function verifyMigrationInventory(client: MigrationQueryClient): Promise<boolean> {
  const version = await client.query("SELECT pg_catalog.current_setting('server_version_num') AS server_version_num");
  if (version.rows.length !== 1) return false;
  const versionText = integerText(version.rows[0]?.server_version_num);
  if (!versionText || !/^17[0-9]{4}$/.test(versionText)) return false;

  const ledger = await client.query("SELECT pg_catalog.to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS present");
  if (ledger.rows.length !== 1 || ledger.rows[0]?.present !== true) return false;

  const migrations = await client.query('SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id ASC');
  if (migrations.rows.length !== MIGRATION_INVENTORY.length) return false;
  let previousId = 0n;
  for (const [index, expected] of MIGRATION_INVENTORY.entries()) {
    const row = migrations.rows[index];
    if (!row) return false;
    const id = integerText(row.id);
    if (!id || BigInt(id) <= previousId) return false;
    previousId = BigInt(id);
    if (integerText(row.created_at) !== expected[1]) return false;
    if (row.hash !== expected[2] && row.hash !== expected[3]) return false;
  }

  // Fixed literals, fully qualified catalog calls and public names ignore search_path.
  // Require actual ordinary/partitioned tables, not views or similarly named sequences.
  const tables = await client.query(`SELECT name, EXISTS (
    SELECT 1 FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = pg_catalog.to_regclass('public.' || name)
      AND relation.relkind IN ('r', 'p')
  ) AS present FROM (VALUES ${GOVERNANCE_TABLES.map((name) => `('${name}')`).join(', ')}) AS required(name)`);
  if (tables.rows.length !== GOVERNANCE_TABLES.length) return false;
  const seen = new Set<string>();
  for (const row of tables.rows) {
    if (typeof row.name !== 'string' || row.present !== true || seen.has(row.name)) return false;
    if (!GOVERNANCE_TABLES.some((name) => name === row.name)) return false;
    seen.add(row.name);
  }
  return seen.size === GOVERNANCE_TABLES.length;
}
