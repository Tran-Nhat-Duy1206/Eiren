import { randomUUID } from 'node:crypto';
import { link, open, unlink, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { canonicalJson, RecoveryError } from './manifest.js';
export const MAX_MANIFEST_BYTES = 32 * 1024 * 1024;
/** Publish a fully synced private file with an atomic no-replace hard link. Existing files/symlinks are never touched. */
export async function writePrivateJsonFile(path: string, value: unknown): Promise<void> {
  let temporary: string | undefined;
  let created = false;
  try {
    if (typeof path !== 'string' || !path) throw new RecoveryError('UNAVAILABLE');
    const destination = resolve(path);
    temporary = join(dirname(destination), `.${basename(destination)}.${randomUUID()}.tmp`);
    const text = canonicalJson(value) + '\n';
    if (Buffer.byteLength(text, 'utf8') > MAX_MANIFEST_BYTES) throw new RecoveryError('UNAVAILABLE');
    const handle = await open(temporary, 'wx', 0o600); created = true;
    try { await handle.writeFile(text, 'utf8'); await handle.sync(); } finally { await handle.close(); }
    await link(temporary, destination); // Atomic and fails for *any* existing destination, including symlinks.
  } catch { throw new RecoveryError('UNAVAILABLE'); }
  finally { if (created && temporary) await unlink(temporary).catch(() => undefined); }
}
export async function readPrivateManifestFile(path: string): Promise<string> {
  try {
    const entry = await lstat(path);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.size > MAX_MANIFEST_BYTES) throw new Error();
    // Reject special files before open. NONBLOCK also prevents a replaced FIFO from
    // hanging between lstat and open; fstat below still requires a regular file.
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile() || metadata.size > MAX_MANIFEST_BYTES) throw new Error();
      const bytes = Buffer.alloc(MAX_MANIFEST_BYTES + 1);
      let length = 0;
      while (length < bytes.length) {
        const { bytesRead } = await handle.read(bytes, length, bytes.length - length, null);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > MAX_MANIFEST_BYTES) throw new Error();
      return bytes.subarray(0, length).toString('utf8');
    } finally { await handle.close(); }
  } catch { throw new RecoveryError('MANIFEST_INVALID'); }
}
