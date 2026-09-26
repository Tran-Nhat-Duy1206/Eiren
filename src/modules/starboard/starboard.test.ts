import { describe, expect, it, vi } from 'vitest';
import { DiscordStarboardGateway, starboardPost, type StarSource, type StarboardGateway } from './discord-gateway.js';
import { StarboardService } from './service.js';

const source: StarSource = { guildId: 'g', channelId: 'source', messageId: 'm', authorId: 'a', createdAt: new Date(0), nsfw: false, public: true };
function harness() {
  const row = { id: 1, guildId: 'g', sourceChannelId: 'source', sourceMessageId: 'm', sourceAuthorId: 'a', starboardChannelId: null as string | null, starboardMessageId: null as string | null, starCount: 0, status: 'PENDING', createdAt: new Date(), updatedAt: new Date() };
  const gateway = { source: vi.fn(async () => source), count: vi.fn(async () => 5), isNsfw: vi.fn(async () => false), post: vi.fn(async () => 'posted'), update: vi.fn(async () => {}), remove: vi.fn(async () => {}) };
  const settings = { enabled: true, channelId: 'board', threshold: 5, emoji: '⭐', allowSelf: false };
  const repository = { settings: vi.fn(async () => settings), ignored: vi.fn(async () => false), get: vi.fn(async (): Promise<typeof row | undefined> => row),
    reconcileTransaction: async (_guild: string, _channel: string, fn: (tx: object) => Promise<unknown>) => fn({}), lock: vi.fn(async () => row),
    pruneDeleted: vi.fn(async () => {}), postsFrom: vi.fn(async (_guild: string, channel?: string) => row.status === 'POSTED' && (!channel || channel === row.sourceChannelId) ? [row] : []),
    postedAfterChannelBarrier: vi.fn(async (_guild: string, channel: string) => row.status === 'POSTED' && channel === row.sourceChannelId ? [row] : []),
    postedAfterDestinationBarrier: vi.fn(async () => row.status === 'POSTED' ? [row] : []),
    save: vi.fn(async (_tx: unknown, _row: unknown, values: Partial<typeof row>) => { Object.assign(row, values); }) };
  const permissions = { require: vi.fn(async () => {}) };
  const service = new StarboardService(repository as never, permissions as never, async () => gateway as unknown as StarboardGateway, { error: vi.fn() } as never);
  return { service, gateway, repository, row, settings, permissions };
}
describe('starboard reconciliation', () => {
  it('persists a delete before any committed mapping, rejecting a late reaction', async () => {
    const { service, gateway, row, repository } = harness();
    repository.get.mockResolvedValueOnce(undefined);
    await service.reconcile('g', 'source', 'm', true);
    expect(row.status).toBe('DELETED');
    expect(repository.lock).toHaveBeenCalledTimes(1);
    await service.reconcile('g', 'source', 'm');
    expect(gateway.post).not.toHaveBeenCalled();
  });
  it('rechecks only published source-channel rows on channel updates', async () => {
    const { service, gateway, row } = harness();
    await service.reconcile('g', 'source', 'm');
    gateway.source.mockResolvedValue({ ...source, public: false });
    await service.sourceChannelUpdated('g', 'other');
    expect(gateway.remove).not.toHaveBeenCalled();
    await service.sourceChannelUpdated('g', 'source');
    expect(gateway.remove).toHaveBeenCalledWith('board', 'posted');
    expect(row.status).toBe('REMOVED');
  });
  it('withdraws NSFW sources when the configured destination turns SFW', async () => {
    const { service, gateway, repository, row } = harness();
    gateway.source.mockResolvedValue({ ...source, nsfw: true });
    gateway.isNsfw.mockResolvedValueOnce(true).mockResolvedValueOnce(true);
    await service.reconcile('g', 'source', 'm');
    expect(row.status).toBe('POSTED');
    gateway.isNsfw.mockResolvedValue(false);
    await service.sourceChannelUpdated('g', 'board');
    expect(repository.postedAfterDestinationBarrier).toHaveBeenCalledWith('g');
    expect(gateway.remove).toHaveBeenCalledWith('board', 'posted');
    expect(row.status).toBe('REMOVED');
  });
  it('withdraws published mirrors on disable and threshold increases', async () => {
    const { service, gateway, row, repository, settings } = harness();
    await service.reconcile('g', 'source', 'm');
    repository.settings.mockImplementation(async () => ({ ...settings }));
    Object.assign(repository, { configure: vi.fn(async (_guild: string, changes: object) => Object.assign(settings, changes)) });
    const actor = { guildId: 'g', userId: 'admin', guildOwnerId: 'admin', roleIds: [] };
    await service.configure(actor, { threshold: 6 });
    expect(row.status).toBe('REMOVED');
    expect(gateway.remove).toHaveBeenCalledTimes(1);
    gateway.count.mockResolvedValue(7);
    await service.reconcile('g', 'source', 'm');
    await service.configure(actor, { enabled: false });
    expect(row.status).toBe('REMOVED');
    expect(gateway.remove).toHaveBeenCalledTimes(2);
    await service.reconcile('g', 'source', 'm');
    expect(gateway.post).toHaveBeenCalledTimes(2);
  });
  it('posts once at threshold and updates existing post after restart', async () => {
    const { service, gateway } = harness();
    await service.reconcile('g', 'source', 'm');
    await service.reconcile('g', 'source', 'm');
    expect(gateway.post).toHaveBeenCalledTimes(1);
    expect(gateway.update).toHaveBeenCalledTimes(1);
  });
  it('removes when the full unique voter count falls below threshold', async () => {
    const { service, gateway, row } = harness();
    await service.reconcile('g', 'source', 'm');
    gateway.count.mockResolvedValue(4);
    await service.reconcile('g', 'source', 'm');
    expect(gateway.remove).toHaveBeenCalledWith('board', 'posted');
    expect(row.status).toBe('REMOVED');
  });
  it('removes posts for deleted sources', async () => {
    const { service, gateway } = harness();
    await service.reconcile('g', 'source', 'm');
    await service.reconcile('g', 'source', 'm', true);
    expect(gateway.remove).toHaveBeenCalledTimes(1);
  });
  it('withdraws published posts when their entire source channel is deleted', async () => {
    const { service, gateway, repository, row } = harness();
    await service.reconcile('g', 'source', 'm');
    await service.sourceChannelDeleted('g', 'source');
    expect(repository.postedAfterChannelBarrier).toHaveBeenCalledWith('g', 'source');
    expect(gateway.remove).toHaveBeenCalledWith('board', 'posted');
    expect(row.status).toBe('DELETED');
  });
  it('gates disabled, ignored, private, and nsfw-to-sfw sources', async () => {
    const { service, gateway, repository, settings } = harness();
    settings.enabled = false;
    await service.reconcile('g', 'source', 'm');
    expect(gateway.source).not.toHaveBeenCalled();
    settings.enabled = true;
    repository.ignored.mockResolvedValue(true);
    await service.reconcile('g', 'source', 'm');
    repository.ignored.mockResolvedValue(false);
    gateway.source.mockResolvedValue({ ...source, nsfw: true });
    await service.reconcile('g', 'source', 'm');
    gateway.source.mockResolvedValue({ ...source, public: false });
    await service.reconcile('g', 'source', 'm');
    expect(gateway.post).not.toHaveBeenCalled();
  });
  it('withdraws an existing mirror when the source becomes NSFW or private', async () => {
    const { service, gateway, row } = harness();
    await service.reconcile('g', 'source', 'm');
    gateway.source.mockResolvedValue({ ...source, nsfw: true });
    await service.reconcile('g', 'source', 'm');
    expect(gateway.remove).toHaveBeenCalledWith('board', 'posted');
    expect(row.status).toBe('REMOVED');
  });
  it('does not resurrect a deleted source on late reaction delivery', async () => {
    const { service, gateway, row } = harness();
    await service.reconcile('g', 'source', 'm');
    await service.reconcile('g', 'source', 'm', true);
    expect(row.status).toBe('DELETED');
    await service.reconcile('g', 'source', 'm');
    expect(gateway.post).toHaveBeenCalledTimes(1);
  });
  it('withdraws an existing mirror when a channel becomes ignored', async () => {
    const { service, gateway, row, repository } = harness();
    await service.reconcile('g', 'source', 'm');
    repository.ignored.mockResolvedValue(true);
    await service.reconcile('g', 'source', 'm');
    expect(gateway.remove).toHaveBeenCalledWith('board', 'posted');
    expect(row.status).toBe('REMOVED');
  });
  it('removes all published posts from a newly ignored channel before returning', async () => {
    const { service, gateway, repository, row } = harness();
    await service.reconcile('g', 'source', 'm');
    Object.assign(repository, { ignore: vi.fn(async () => { repository.ignored.mockResolvedValue(true); }),
      postsFrom: vi.fn(async () => [row]) });
    await service.ignore({ guildId: 'g', userId: 'admin', guildOwnerId: 'admin', roleIds: [] }, 'source', true);
    expect(gateway.remove).toHaveBeenCalledWith('board', 'posted');
    expect(row.status).toBe('REMOVED');
  });
  it('rechecks privacy after locking rather than posting a stale public preflight', async () => {
    const { service, gateway, row } = harness();
    gateway.source.mockResolvedValueOnce(source).mockResolvedValueOnce({ ...source, public: false });
    await service.reconcile('g', 'source', 'm');
    expect(gateway.post).not.toHaveBeenCalled();
    expect(row.status).toBe('REMOVED');
  });
  it('treats an already deleted destination channel as safely removed', async () => {
    const gateway = new DiscordStarboardGateway({ channels: { fetch: vi.fn(async () => null) } } as never);
    await expect(gateway.remove('deleted-channel', 'deleted-message')).resolves.toBeUndefined();
  });
  it('cleans up an orphan on database write failure', async () => {
    const { service, gateway, repository } = harness();
    repository.save.mockRejectedValueOnce(new Error('rollback'));
    await expect(service.reconcile('g', 'source', 'm')).rejects.toThrow('rollback');
    expect(gateway.remove).toHaveBeenCalledWith('board', 'posted');
  });
  it('creates an embed without content when content is unavailable', () => {
    const post = starboardPost(source, 5, '⭐');
    expect(post.embeds[0]?.data.fields).toHaveLength(2);
  });
});
