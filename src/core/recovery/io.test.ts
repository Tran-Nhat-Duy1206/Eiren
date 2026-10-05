import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_MANIFEST_BYTES, readPrivateManifestFile, writePrivateJsonFile } from './io.js';
import { RecoveryError } from './manifest.js';

let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'eiren-recovery-test-')); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
async function safeFailure(promise: Promise<unknown>, code: string) {
  try { await promise; throw new Error('Expected rejection'); }
  catch (error) {
    expect(error).toBeInstanceOf(RecoveryError);
    expect((error as Error).message).toBe(code);
    expect(String(error)).not.toContain(directory);
    expect(String(error)).not.toContain('DO_NOT_LEAK');
  }
}

describe('private recovery file IO', () => {
  it('publishes canonical JSON to a new destination and cleans temporary files', async () => {
    const path = join(directory, 'manifest.json');
    await writePrivateJsonFile(path, { z: { b: 2, a: 1 }, a: 0 });
    expect(await readPrivateManifestFile(path)).toBe('{"a":0,"z":{"a":1,"b":2}}\n');
    expect(await readdir(directory)).toEqual(['manifest.json']);
  });
  it('never overwrites an existing destination and removes temporary staging files', async () => {
    const path = join(directory, 'manifest.json');
    await writeFile(path, 'DO_NOT_LEAK existing bytes');
    await safeFailure(writePrivateJsonFile(path, { replacement: true }), 'UNAVAILABLE');
    expect(await readFile(path, 'utf8')).toBe('DO_NOT_LEAK existing bytes');
    expect(await readdir(directory)).toEqual(['manifest.json']);
  });
  it('atomically publishes exactly one competing writer without replacing it', async () => {
    const path = join(directory, 'manifest.json');
    const results = await Promise.allSettled([writePrivateJsonFile(path, { winner: 1 }), writePrivateJsonFile(path, { winner: 2 })]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const failed = results.find((result) => result.status === 'rejected');
    expect(failed?.status === 'rejected' && failed.reason).toBeInstanceOf(RecoveryError);
    expect(['{"winner":1}\n', '{"winner":2}\n']).toContain(await readFile(path, 'utf8'));
    expect(await readdir(directory)).toEqual(['manifest.json']);
  });
  it.skipIf(process.platform === 'win32')('creates Unix private files with mode 0600', async () => {
    const path = join(directory, 'manifest.json');
    await writePrivateJsonFile(path, {});
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });
  it.skipIf(process.platform === 'win32')('rejects existing and dangling symlink destinations without touching targets', async () => {
    const target = join(directory, 'target.json');
    const path = join(directory, 'manifest.json');
    await writeFile(target, 'DO_NOT_LEAK target');
    await symlink(target, path);
    await safeFailure(writePrivateJsonFile(path, {}), 'UNAVAILABLE');
    await safeFailure(readPrivateManifestFile(path), 'MANIFEST_INVALID');
    expect(await readFile(target, 'utf8')).toBe('DO_NOT_LEAK target');
    const dangling = join(directory, 'dangling.json');
    await symlink(join(directory, 'absent.json'), dangling);
    await safeFailure(writePrivateJsonFile(dangling, {}), 'UNAVAILABLE');
    await safeFailure(readPrivateManifestFile(dangling), 'MANIFEST_INVALID');
  });
  it.skipIf(process.platform === 'win32')('rejects a real Unix FIFO without opening or hanging', async () => {
    const fifo = join(directory, 'manifest-fifo');
    const result = spawnSync('mkfifo', [fifo], { stdio: 'ignore', timeout: 5000 });
    expect(result.status).toBe(0);
    await safeFailure(readPrivateManifestFile(fifo), 'MANIFEST_INVALID');
  }, 1000);
  it('returns fixed safe errors for invalid paths and directories', async () => {
    for (const path of [join(directory, 'missing', 'DO_NOT_LEAK.json'), join(directory, '\0DO_NOT_LEAK')]) {
      await safeFailure(writePrivateJsonFile(path, {}), 'UNAVAILABLE');
      await safeFailure(readPrivateManifestFile(path), 'MANIFEST_INVALID');
    }
    await safeFailure(writePrivateJsonFile(directory, {}), 'UNAVAILABLE');
    await safeFailure(readPrivateManifestFile(directory), 'MANIFEST_INVALID');
    expect(await readdir(directory)).toEqual([]);
  });
  it('bounds writes before publishing and hides serialization failures', async () => {
    const path = join(directory, 'manifest.json');
    await safeFailure(writePrivateJsonFile(path, { secret: 'DO_NOT_LEAK' + 'x'.repeat(MAX_MANIFEST_BYTES) }), 'UNAVAILABLE');
    const circular: Record<string, unknown> = { secret: 'DO_NOT_LEAK' }; circular.self = circular;
    await safeFailure(writePrivateJsonFile(path, circular), 'UNAVAILABLE');
    expect(await readdir(directory)).toEqual([]);
  });
  it('rejects oversized files without returning file contents', async () => {
    const path = join(directory, 'manifest.json');
    const handle = await open(path, 'wx');
    try { await handle.writeFile('DO_NOT_LEAK'); await handle.truncate(MAX_MANIFEST_BYTES + 1); }
    finally { await handle.close(); }
    await safeFailure(readPrivateManifestFile(path), 'MANIFEST_INVALID');
  });
  it('permits reading exactly the documented byte bound', async () => {
    const path = join(directory, 'manifest.json');
    const handle = await open(path, 'wx');
    try { await handle.truncate(MAX_MANIFEST_BYTES); } finally { await handle.close(); }
    expect(Buffer.byteLength(await readPrivateManifestFile(path))).toBe(MAX_MANIFEST_BYTES);
  });
});
