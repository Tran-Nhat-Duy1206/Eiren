import { describe, expect, it, vi } from 'vitest';
import { SuggestionService } from './service.js';
import { SuggestionRepository } from './repository.js';

const row = { id: 3, guildId: 'guild', authorId: 'author', content: 'An idea', status: 'PENDING',
  channelId: 'channel', messageId: 'message', staffResponse: null, reviewedBy: null,
  createdAt: new Date(0), updatedAt: new Date(0) } as const;
function setup() {
  const votes = new Map<string, number>();
  const repository = {
    get: vi.fn(async () => row), totals: vi.fn(async () => ({ up: [...votes.values()].filter(v => v === 1).length,
      down: [...votes.values()].filter(v => v === -1).length })),
    vote: vi.fn(async (_id: number, user: string, choice: number) => {
      const previous = votes.get(user); if (previous === choice) return false;
      votes.set(user, choice); return true;
    }),
    setStatus: vi.fn(async (_guild: string, _id: number, status: string, reviewedBy: string) => ({ ...row, status, reviewedBy })),
    respond: vi.fn(async (_guild: string, _id: number, staffResponse: string, reviewedBy: string) => ({ ...row, staffResponse, reviewedBy })),
    settings: vi.fn(async () => ({ channelId: 'channel' })),
    create: vi.fn(async (_guild: string, _author: string, _content: string, channelId: string) => ({ ...row, channelId, messageId: null })),
    attach: vi.fn(async () => ({ ...row })),
    configure: vi.fn(async () => ({ channelId: 'channel' })),
  };
  const gateway = { post: vi.fn(async () => 'message'), update: vi.fn(), remove: vi.fn(async () => {}), validateChannel: vi.fn(async () => {}) };
  const logger = { warn: vi.fn() };
  const permissions = { require: vi.fn(async () => {}) };
  const guildLogs = { send: vi.fn(async () => {}) };
  const service = new SuggestionService(repository as unknown as SuggestionRepository, permissions as never,
    async () => gateway as never, logger as never, guildLogs);
  return { service, repository, gateway, logger, permissions, guildLogs };
}
const actor = { guildId: 'guild', userId: 'staff', guildOwnerId: 'owner', roleIds: [] };
describe('suggestion voting and review', () => {
  it('retains intended channel and reports pending when posting fails', async () => {
    const { service, gateway, repository, logger } = setup();
    gateway.post.mockRejectedValue(new Error('offline'));
    expect((await service.create('guild', 'author', 'An idea')).posted).toBe(false);
    expect(repository.create).toHaveBeenCalledWith('guild', 'author', 'An idea', 'channel');
    expect(repository.attach).not.toHaveBeenCalled();
    expect(logger.warn.mock.calls[0]?.[0]).toEqual({ guildId: 'guild', suggestionId: 3, channelId: 'channel' });
  });
  it('removes orphan posts when attachment fails and rejects inaccessible config channels', async () => {
    const { service, gateway, repository } = setup();
    repository.attach.mockRejectedValue(new Error('database unavailable'));
    expect((await service.create('guild', 'author', 'An idea')).posted).toBe(false);
    expect(gateway.remove).toHaveBeenCalledWith('channel', 'message');
    gateway.validateChannel.mockRejectedValue(new Error('stale channel'));
    await expect(service.configure(actor, 'stale')).rejects.toThrow('stale channel');
    expect(repository.configure).not.toHaveBeenCalled();
  });
  it('persists choices idempotently under duplicate and concurrent requests and permits switching', async () => {
    const { service, repository } = setup();
    expect(await Promise.all([service.vote('guild', 3, 'user', 1, 'channel', 'message', false),
      service.vote('guild', 3, 'user', 1, 'channel', 'message', false)])).toEqual([true, false]);
    expect(await service.vote('guild', 3, 'user', -1, 'channel', 'message', false)).toBe(true);
    expect(await repository.totals()).toEqual({ up: 0, down: 1 });
  });
  it('rejects bots and stale post IDs without writing votes', async () => {
    const { service, repository } = setup();
    await expect(service.vote('guild', 3, 'bot', 1, 'channel', 'message', true)).rejects.toThrow();
    await expect(service.vote('guild', 3, 'user', 1, 'old', 'message', false)).rejects.toThrow();
    await expect(service.vote('guild', 3, 'user', 1, 'channel', 'old', false)).rejects.toThrow();
    expect(repository.vote).not.toHaveBeenCalled();
  });
  it('keeps review successful if audit delivery fails and never audits content', async () => {
    const { service, guildLogs, logger } = setup();
    guildLogs.send.mockRejectedValue(new Error('log unavailable'));
    await service.status(actor, 3, 'IMPLEMENTED');
    await service.respond(actor, 3, 'Private response');
    expect(guildLogs.send).toHaveBeenCalledTimes(2);
    expect(guildLogs.send.mock.calls[0]?.slice(0, 4)).toEqual(['guild', 'general', 'Suggestion status',
      [{ name: 'Suggestion ID', value: '3' }, { name: 'Status', value: 'IMPLEMENTED' }]]);
    expect(JSON.stringify(guildLogs.send.mock.calls)).not.toContain('Private response');
    expect(JSON.stringify(guildLogs.send.mock.calls)).not.toContain('An idea');
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });
  it('authorizes staff status and response and retains DB result when Discord edit fails', async () => {
    const { service, repository, gateway, logger, permissions } = setup();
    gateway.update.mockRejectedValue(new Error('Discord unavailable'));
    expect((await service.status(actor, 3, 'ACCEPTED')).status).toBe('ACCEPTED');
    expect((await service.respond(actor, 3, 'Thanks')).staffResponse).toBe('Thanks');
    expect(permissions.require).toHaveBeenCalledWith(actor, 'MODERATOR');
    expect(repository.setStatus).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.warn.mock.calls[0]?.[0]).toEqual({ guildId: 'guild', suggestionId: 3, status: 'ACCEPTED' });
    await expect(service.status(actor, 3, 'INVALID')).rejects.toThrow();
  });
});
