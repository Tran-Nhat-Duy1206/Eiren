import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { createRecoveryManifest } from './manifest.js';
const calls = vi.hoisted(() => ({ export: vi.fn(), verify: vi.fn(), read: vi.fn(), write: vi.fn() }));
vi.mock('./io.js', () => ({ readPrivateManifestFile: calls.read, writePrivateJsonFile: calls.write }));
vi.mock('./verify.js', async importOriginal => ({ ...await importOriginal<typeof import('./verify.js')>(), exportRecoveryManifest: calls.export, verifyRecovery: calls.verify }));
import { blockedRecoveryReport } from './verify.js';
import { runRecoveryExport } from '../../app/recovery-obligations-export.js';
import { runRecoveryVerify } from '../../app/recovery-verify.js';
const manifest = createRecoveryManifest({ version: 1, generatedAt: '2026-08-01T00:00:00.000Z', migrationCount: 21, latestMigrationTag: '0020_subject_request_governance', schemaMarker: 'repo/eiren-v8.6', retentionReceipts: [], activeHolds: [], retentionPolicies: [], subjectExecutionReceipts: [] });
let log: ReturnType<typeof vi.spyOn>;
beforeEach(() => { vi.clearAllMocks(); log = vi.spyOn(console, 'log').mockImplementation(() => undefined); calls.export.mockResolvedValue(manifest); calls.read.mockResolvedValue(JSON.stringify(manifest)); calls.write.mockResolvedValue(undefined); calls.verify.mockResolvedValue({ ...blockedRecoveryReport('UNAVAILABLE'), status: 'PASS', counts: { READY: 0 } }); });
const output = () => log.mock.calls.map((call: unknown[]) => call[0]).join('\n');
describe('explicit environment CLI without bot startup', () => {
  it('missing manifest reports exactly fixed invalid and never connects', async () => { expect(await runRecoveryVerify([], {})).toBe(1); expect(calls.verify).not.toHaveBeenCalled(); expect(output()).toContain('MANIFEST_INVALID'); });
  it('missing/nonreadable or malformed manifest is safe without paths/exceptions', async () => {
    calls.read.mockRejectedValue(new Error('SECRET private transcript postgres://password'));
    expect(await runRecoveryVerify([], { RECOVERY_MANIFEST_PATH: '/secret/private.json' })).toBe(1); expect(calls.verify).not.toHaveBeenCalled(); expect(output()).not.toMatch(/SECRET|private|postgres|password/);
    calls.read.mockResolvedValue('{"privateNarrative":"SECRET"}');
    expect(await runRecoveryVerify([], { RECOVERY_MANIFEST_PATH: '/secret/private.json' })).toBe(1); expect(calls.verify).not.toHaveBeenCalled();
  });
  it('passes only explicitly supplied source/target guard variables', async () => {
    const env = { RECOVERY_MANIFEST_PATH: '/operator/manifest.json', RECOVERY_DATABASE_URL: 'postgres://target:secret@127.0.0.1/eiren_recovery_unit', RECOVERY_VERIFY_CONFIRM: 'isolated-restored-target', DATABASE_URL: 'postgres://source:secret@127.0.0.1/eiren_source' };
    expect(await runRecoveryVerify([], env)).toBe(0); expect(calls.verify).toHaveBeenCalledWith(env.RECOVERY_DATABASE_URL, manifest, { confirmation: env.RECOVERY_VERIFY_CONFIRM, sourceDatabaseUrl: env.DATABASE_URL }); expect(output()).not.toContain('secret');
  });
  it('blocked/nonready report exits one', async () => { calls.verify.mockResolvedValue(blockedRecoveryReport('MIGRATION_MISMATCH', 'schema')); expect(await runRecoveryVerify([], { RECOVERY_MANIFEST_PATH: 'fixture' })).toBe(1); });
  it('optional report uses private writer and failures never leak paths/errors', async () => {
    const env = { RECOVERY_MANIFEST_PATH: 'fixture', RECOVERY_REPORT_PATH: 'secret-report' }; calls.write.mockRejectedValue(new Error('secret-report password'));
    expect(await runRecoveryVerify([], env)).toBe(1); expect(calls.write).toHaveBeenCalledWith('secret-report', expect.any(Object)); expect(output()).not.toMatch(/secret-report|password/); expect(output()).toContain('UNAVAILABLE');
  });
  it('export requires explicit URL/output and never falls back to dotenv', async () => {
    expect(await runRecoveryExport([], {})).toBe(1); expect(calls.export).not.toHaveBeenCalled();
    expect(await runRecoveryExport([], { DATABASE_URL: 'explicit-source' })).toBe(1); expect(calls.export).not.toHaveBeenCalled();
  });
  it('exports new restricted manifest to environment path or --output precedence', async () => {
    expect(await runRecoveryExport([], { DATABASE_URL: 'explicit-source', RECOVERY_MANIFEST_PATH: 'new-operator-file' })).toBe(0); expect(calls.export).toHaveBeenCalledWith('explicit-source'); expect(calls.write).toHaveBeenCalledWith('new-operator-file', manifest);
    expect(await runRecoveryExport(['--output', 'chosen-path'], { DATABASE_URL: 'explicit-source', RECOVERY_MANIFEST_PATH: 'ignored-path' })).toBe(0); expect(calls.write).toHaveBeenLastCalledWith('chosen-path', manifest); expect(output()).not.toMatch(/explicit-source|chosen-path|ignored-path/);
  });
  it('export catches errors with fixed code/stage only', async () => {
    calls.export.mockRejectedValue(new Error('SQL private-content postgres://user:password'));
    expect(await runRecoveryExport([], { DATABASE_URL: 'source', RECOVERY_MANIFEST_PATH: 'new-file' })).toBe(1); expect(output()).toContain('UNAVAILABLE'); expect(output()).not.toMatch(/SQL|private-content|postgres|password/);
  });
  it('rejects unknown arguments rather than accepting repair or switches', async () => { expect(await runRecoveryExport(['--repair'], {})).toBe(1); expect(await runRecoveryVerify(['--repair'], {})).toBe(1); expect(calls.export).not.toHaveBeenCalled(); expect(calls.verify).not.toHaveBeenCalled(); });
  it('entrypoint import lists contain no dotenv/config/bot/Discord/migration runner', async () => {
    for (const path of ['../../app/recovery-obligations-export.ts', '../../app/recovery-verify.ts', './verify.ts', './manifest.ts', './io.ts', './migrations.ts']) {
      const text = await readFile(new URL(path, import.meta.url), 'utf8'); const imports = text.split('\n').filter(line => line.startsWith('import ')).join('\n');
      expect(imports).not.toMatch(/dotenv|discord|app\/main|config\/env|database\/connection|migrate\.js/);
    }
  });
});
