import { beforeEach, describe, expect, it, vi } from 'vitest';
import { constants } from 'node:fs';
const fake = vi.hoisted(() => ({ lstat: vi.fn(), open: vi.fn(), close: vi.fn(), stat: vi.fn(), read: vi.fn() }));
vi.mock('node:fs/promises', async importOriginal => ({ ...await importOriginal<typeof import('node:fs/promises')>(), lstat: fake.lstat, open: fake.open }));
import { readPrivateManifestFile } from './io.js';
beforeEach(() => { vi.clearAllMocks(); fake.close.mockResolvedValue(undefined); });
describe('bounded recovery input special-file guards', () => {
  it.each(['FIFO', 'socket', 'directory', 'device', 'symlink'])('rejects %s before opening with fixed safe error', async kind => {
    fake.lstat.mockResolvedValue({ isFile: () => false, isSymbolicLink: () => kind === 'symlink', size: 0 });
    await expect(readPrivateManifestFile('operator-private-path')).rejects.toThrow('MANIFEST_INVALID');
    expect(fake.open).not.toHaveBeenCalled();
  });
  it('opens with available nonblocking/no-follow flags and rejects a raced special fd', async () => {
    fake.lstat.mockResolvedValue({ isFile: () => true, isSymbolicLink: () => false, size: 0 });
    fake.stat.mockResolvedValue({ isFile: () => false, size: 0 });
    fake.open.mockResolvedValue({ stat: fake.stat, close: fake.close, read: fake.read });
    await expect(readPrivateManifestFile('operator-private-path')).rejects.toThrow('MANIFEST_INVALID');
    const flags = fake.open.mock.calls[0]![1] as number;
    expect(flags).toBe(constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
    expect(fake.read).not.toHaveBeenCalled(); expect(fake.close).toHaveBeenCalledOnce();
  });
});
