import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Client } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { GOVERNANCE_TABLES, MIGRATION_INVENTORY, verifyMigrationInventory, type MigrationQueryClient } from './migrations.js';

// Compile-time guarantee that the production pg Client needs no adapter.
type PgClientCompatible = Client extends MigrationQueryClient ? true : false;
const compatible: PgClientCompatible = true;

function fixture(variant: 2 | 3 = 2) {
  const migrations: Record<string, unknown>[] = MIGRATION_INVENTORY.map((entry, index) => ({
    id: index + 1, hash: entry[variant], created_at: entry[1],
  }));
  const tables: Record<string, unknown>[] = GOVERNANCE_TABLES.map((name) => ({ name, present: true }));
  const version: Record<string, unknown>[] = [{ server_version_num: '170009' }];
  const ledger: Record<string, unknown>[] = [{ present: true }];
  const query = vi.fn(async (text: string): Promise<{ rows: Record<string, unknown>[] }> => {
    if (text.includes('current_setting')) return { rows: version };
    if (text.includes("to_regclass('drizzle.")) return { rows: ledger };
    if (text.includes('FROM drizzle.__drizzle_migrations')) return { rows: migrations };
    if (text.includes('pg_catalog.pg_class')) return { rows: tables };
    throw new Error('Unexpected verifier query');
  });
  return { query, migrations, tables, version, ledger };
}

describe('verifyMigrationInventory', () => {
  it('independently matches every checked-in journal entry and exact approved SQL byte variant', async () => {
    // URL-based paths work on Windows and Linux, independently of process.cwd().
    const root = new URL('../../../', import.meta.url);
    const journal = JSON.parse(await readFile(new URL('drizzle/meta/_journal.json', root), 'utf8')) as {
      entries: { idx: number; tag: string; when: number }[];
    };
    expect(journal.entries).toHaveLength(21);
    expect(MIGRATION_INVENTORY).toHaveLength(journal.entries.length);
    const hash = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');
    for (const [index, entry] of journal.entries.entries()) {
      const approved = MIGRATION_INVENTORY[index]!;
      expect(entry.idx).toBe(index);
      expect(approved[0]).toBe(entry.tag);
      expect(approved[1]).toBe(String(entry.when));
      const bytes = await readFile(new URL(`drizzle/${entry.tag}.sql`, root));
      // Check raw bytes FIRST: modified/mixed-newline SQL is not silently approved.
      expect([approved[2], approved[3]]).toContain(hash(bytes));
      // Test-only derivation verifies both exact checked-in LF/CRLF constants.
      const lf = bytes.toString('utf8').replace(/\r\n/g, '\n');
      expect(lf).not.toContain('\r');
      expect(hash(lf)).toBe(approved[2]);
      expect(hash(lf.replace(/\n/g, '\r\n'))).toBe(approved[3]);
    }
  });

  it('requires the complete 17-table governance surface', () => {
    expect(GOVERNANCE_TABLES).toHaveLength(17);
    for (const name of ['retention_previews', 'subject_requests', 'subject_request_previews', 'subject_request_preview_counts', 'governance_audit_gaps']) {
      expect(GOVERNANCE_TABLES).toContain(name);
    }
  });

  it.each([2, 3] as const)('accepts exact approved hash variant %s for all 21 entries', async (variant) => {
    const client = fixture(variant);
    expect(compatible).toBe(true);
    expect(MIGRATION_INVENTORY).toHaveLength(21);
    expect(await verifyMigrationInventory(client)).toBe(true);
    expect(client.query).toHaveBeenCalledTimes(4);
    expect(client.query.mock.calls[2]?.[0]).toContain('ORDER BY id ASC');
    const catalogSql = client.query.mock.calls[3]?.[0];
    expect(catalogSql).toContain("pg_catalog.to_regclass('public.' || name)");
    for (const name of GOVERNANCE_TABLES) expect(catalogSql).toContain(`('${name}')`);
  });

  it('rejects a wrong early hash before inspecting governance tables', async () => {
    const client = fixture();
    client.migrations[0]!.hash = '0'.repeat(64);
    expect(await verifyMigrationInventory(client)).toBe(false);
    expect(client.query).toHaveBeenCalledTimes(3);
  });

  it.each([0, 10, 20])('rejects wrong timestamp at index %s', async (index) => {
    const client = fixture();
    client.migrations[index]!.created_at = '1791017773297';
    expect(await verifyMigrationInventory(client)).toBe(false);
    expect(client.query).toHaveBeenCalledTimes(3);
  });

  it.each(['missing', 'extra', 'duplicate'] as const)('rejects %s ledger entries', async (kind) => {
    const client = fixture();
    if (kind === 'missing') client.migrations.pop();
    if (kind === 'extra') client.migrations.push({ ...client.migrations[20]!, id: 22 });
    if (kind === 'duplicate') client.migrations[1] = { ...client.migrations[0]! };
    expect(await verifyMigrationInventory(client)).toBe(false);
  });

  it('rejects reordered history even when the latest migration matches', async () => {
    const client = fixture();
    [client.migrations[0], client.migrations[1]] = [client.migrations[1]!, client.migrations[0]!];
    expect(await verifyMigrationInventory(client)).toBe(false);
  });

  it.each(['160009', '180000', '17.9', '', null, '170009 trailing'])('rejects non-PG17/malformed actual version %s', async (version) => {
    const client = fixture();
    client.version[0]!.server_version_num = version;
    expect(await verifyMigrationInventory(client)).toBe(false);
    expect(client.query).toHaveBeenCalledTimes(1);
  });

  it('rejects a missing explicitly qualified migration ledger', async () => {
    const client = fixture();
    client.ledger[0]!.present = false;
    expect(await verifyMigrationInventory(client)).toBe(false);
    expect(client.query).toHaveBeenCalledTimes(2);
  });

  it.each(GOVERNANCE_TABLES)('rejects missing public.%s', async (name) => {
    const client = fixture();
    client.tables.find((row) => row.name === name)!.present = false;
    expect(await verifyMigrationInventory(client)).toBe(false);
  });

  it('rejects missing or duplicate catalog results', async () => {
    const missing = fixture();
    missing.tables.pop();
    expect(await verifyMigrationInventory(missing)).toBe(false);
    const duplicate = fixture();
    duplicate.tables[1] = { ...duplicate.tables[0]! };
    expect(await verifyMigrationInventory(duplicate)).toBe(false);
  });

  it('accepts exact number and bigint values without accepting lossy coercions', async () => {
    const client = fixture();
    client.migrations[0]!.created_at = Number(MIGRATION_INVENTORY[0][1]);
    client.migrations[1]!.created_at = BigInt(MIGRATION_INVENTORY[1][1]);
    expect(await verifyMigrationInventory(client)).toBe(true);
    client.migrations[0]!.created_at = ` ${MIGRATION_INVENTORY[0][1]}`;
    expect(await verifyMigrationInventory(client)).toBe(false);
  });

  it('propagates query failures to the caller safe-error wrapper without logging', async () => {
    const error = new Error('connection detail must never be shown to users');
    const client = { query: vi.fn().mockRejectedValue(error) };
    await expect(verifyMigrationInventory(client)).rejects.toBe(error);
  });
});
