import { describe, expect, it, vi } from 'vitest';
import { eventPost } from './discord-gateway.js';
import { parseEventTime, EventService } from './service.js';
import type { CommunityEvent, EventRepository } from './repository.js';
const actor = { guildId: 'g', userId: 'owner', guildOwnerId: 'owner', roleIds: [] };
const row = { id: 2, guildId: 'g', creatorId: 'owner', title: 'Meetup', description: 'Welcome',
  startAt: new Date('2030-01-02T00:00:00Z'), endAt: null, channelId: 'c', announcementMessageId: 'm',
  maxParticipants: 1, status: 'SCHEDULED', createdAt: new Date(0), updatedAt: new Date(0) } as CommunityEvent;
function setup() {
  const repository = { get: vi.fn(async () => row), count: vi.fn(async () => 0), list: vi.fn(async () => [row]),
    create: vi.fn(async () => row), edit: vi.fn(async () => row), transition: vi.fn(async () => ({ ...row, status: 'COMPLETED' })),
    join: vi.fn(async () => true), leave: vi.fn(async () => false), attend: vi.fn(async () => true),
    transitionDue: vi.fn(async () => []), cancelExpiredReminders: vi.fn(async () => 0),
    claimPendingPresentations: vi.fn(async () => []), deferPresentation: vi.fn(async () => {}),
    claimDue: vi.fn(async () => []), deliverReminder: vi.fn(async () => false),
    syncAnnouncement: vi.fn(async (_guild: string, _id: number, publish: (r: CommunityEvent, count: number) => Promise<unknown>) => publish(row, 0)),
    attach: vi.fn(async () => row) };
  const gateway = { validateChannel: vi.fn(), post: vi.fn(async () => 'm2'), update: vi.fn(), remove: vi.fn(),
    remind: vi.fn(async () => 'reminder'), isMissing: vi.fn(() => false) };
  const hooks = { onJoined: vi.fn(async () => {}), onAttended: vi.fn(async () => {}) };
  const service = new EventService(repository as unknown as EventRepository, { require: vi.fn(), resolve: vi.fn(async () => 'HELPER') } as never,
    async () => gateway, { warn: vi.fn() } as never, hooks);
  return { repository, gateway, hooks, service };
}
describe('community events', () => {
  it('requires an explicit timezone and renders Discord timestamps with safe components', () => {
    expect(() => parseEventTime('2030-01-01T12:00:00')).toThrow();
    expect(parseEventTime('2030-01-01T12:00:00+02:00').toISOString()).toBe('2030-01-01T10:00:00.000Z');
    const payload = eventPost(row, 1);
    expect(JSON.stringify(payload)).toContain('<t:');
    expect(JSON.stringify(payload)).toContain('event:join:2');
    expect(payload.embeds[0]?.toJSON().fields).toContainEqual({ name: 'Organizer', value: '<@owner>' });
    expect(payload.allowedMentions).toEqual({ parse: [] });
    expect(JSON.stringify(payload)).not.toContain('allowedMentions: everyone');
  });
  it('calls hooks only after successful changed writes and excludes bots', async () => {
    const { service, repository, hooks } = setup();
    await expect(service.join('g', 2, 'bot', true)).rejects.toThrow();
    expect(repository.join).not.toHaveBeenCalled();
    await service.join('g', 2, 'human');
    expect(hooks.onJoined).toHaveBeenCalledTimes(1);
    await service.attend({ guildId: 'g', userId: 'owner', guildOwnerId: 'owner', roleIds: [] }, 2, 'human');
    expect(hooks.onAttended).toHaveBeenCalledTimes(1);
  });
  it('rejects stale buttons and recovers a deleted original announcement', async () => {
    const { service, gateway, repository } = setup();
    await expect(service.button('g', 2, 'human', false, 'join', 'c', 'deleted')).rejects.toThrow();
    gateway.update.mockRejectedValue({ code: 10008 }); gateway.isMissing.mockReturnValue(true);
    await service.join('g', 2, 'human');
    expect(gateway.post).toHaveBeenCalledTimes(1);
    expect(repository.syncAnnouncement).toHaveBeenCalledWith('g', 2, expect.any(Function));
  });
  it('refreshes using the locked current row and participant count, not stale caller snapshot', async () => {
    const { service, repository, gateway } = setup();
    const updated = { ...row, status: 'CANCELLED', title: 'Updated title' } as CommunityEvent;
    repository.syncAnnouncement.mockImplementation(async (_guild, _id, publish) => publish(updated, 5));
    await service.join('g', 2, 'human');
    expect(gateway.update).toHaveBeenCalledWith('c', 'm', updated, 5);
  });
  it('rejects schema-exceeding description and capacity before persistence', async () => {
    const { service, repository } = setup();
    const actor = { guildId: 'g', userId: 'owner', guildOwnerId: 'owner', roleIds: [] };
    await expect(service.create(actor, { title: 'Title', description: 'x'.repeat(2001), startAt: row.startAt,
      endAt: null, channelId: 'c', maxParticipants: null })).rejects.toThrow();
    await expect(service.create(actor, { title: 'Title', description: '', startAt: row.startAt,
      endAt: null, channelId: 'c', maxParticipants: 10001 })).rejects.toThrow();
    expect(repository.get).not.toHaveBeenCalled();
  });
  it('validates future start and optional end ordering against the current clock', async () => {
    const { service, repository } = setup();
    const future = new Date(Date.now() + 3_600_000);
    const input = { title: 'Future', description: '', startAt: future, endAt: null, channelId: 'c', maxParticipants: 3 };
    await expect(service.create(actor, { ...input, startAt: new Date(Date.now() - 1_000) })).rejects.toThrow();
    await expect(service.create(actor, { ...input, endAt: future })).rejects.toThrow();
    await expect(service.create(actor, { ...input, endAt: new Date(future.getTime() + 60_000) })).resolves.toBeDefined();
    expect(repository.create).toHaveBeenCalledTimes(1);
  });
  it('sends edits through a locked repository reschedule and rejects past or inverted edits', async () => {
    const { service, repository } = setup();
    const startAt = new Date(Date.now() + 7_200_000);
    const endAt = new Date(startAt.getTime() + 3_600_000);
    await service.edit(actor, 2, { startAt, endAt, title: 'Rescheduled' });
    expect(repository.edit).toHaveBeenCalledWith('g', 2, { startAt, endAt, title: 'Rescheduled' });
    await expect(service.edit(actor, 2, { startAt: new Date(Date.now() - 1_000) })).rejects.toThrow();
    await expect(service.edit(actor, 2, { startAt, endAt: new Date(startAt.getTime() - 1_000) })).rejects.toThrow();
    expect(repository.edit).toHaveBeenCalledTimes(1);
  });
  it('observes idempotent join and leave writes without repeating achievement hooks', async () => {
    const { service, repository, hooks } = setup();
    repository.join.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    repository.leave.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect(await service.join('g', 2, 'human')).toBe(true);
    expect(await service.join('g', 2, 'human')).toBe(false);
    expect(await service.leave('g', 2, 'human')).toBe(true);
    expect(await service.leave('g', 2, 'human')).toBe(false);
    expect(hooks.onJoined).toHaveBeenCalledTimes(1);
    expect(repository.syncAnnouncement).toHaveBeenCalledTimes(2);
  });
  it('rejects cancelled RSVP in repository and closes only a started event', async () => {
    const { service, repository } = setup();
    repository.join.mockRejectedValueOnce(new Error('RSVPs are closed.'));
    await expect(service.join('g', 2, 'human')).rejects.toThrow('RSVPs are closed.');
    expect(await service.transition(actor, 2, 'close')).toMatchObject({ status: 'COMPLETED' });
    expect(repository.transition).toHaveBeenCalledWith('g', 2, 'ACTIVE', 'COMPLETED');
  });
  it('moves due events before reminders, refreshes posts and supports restart recovery', async () => {
    const { service, repository, gateway } = setup();
    repository.transitionDue.mockResolvedValue([{ ...row, status: 'ACTIVE' }] as never);
    const now = new Date('2030-01-02T00:01:00Z');
    await service.runDue(now);
    expect(repository.transitionDue).toHaveBeenCalledWith(now, 20, expect.any(Function));
    expect(repository.cancelExpiredReminders).toHaveBeenCalledWith(now);
    expect(gateway.update).toHaveBeenCalledTimes(1);
    expect(repository.cancelExpiredReminders.mock.invocationCallOrder[0]).toBeLessThan(repository.claimDue.mock.invocationCallOrder[0]!);
    repository.transitionDue.mockResolvedValue([]);
    await service.runDue(now);
    expect(gateway.update).toHaveBeenCalledTimes(1);
  });
  it('recovers a long-future announcement after a failed initial post', async () => {
    const { service, repository, gateway } = setup();
    repository.syncAnnouncement.mockImplementation(async (_g, _id, publish) => publish({ ...row, announcementMessageId: null }, 0));
    gateway.post.mockRejectedValueOnce(new Error('Discord unavailable'));
    await service.create(actor, { title: row.title, description: row.description, startAt: row.startAt,
      endAt: null, channelId: row.channelId, maxParticipants: null });
    expect(repository.deferPresentation).toHaveBeenCalledWith('g', 2);
    repository.claimPendingPresentations.mockResolvedValueOnce([row] as never);
    await service.runDue(new Date('2029-01-01T00:00:00Z'));
    expect(gateway.post).toHaveBeenCalledTimes(2);
    expect(repository.claimPendingPresentations).toHaveBeenCalledWith(new Date('2029-01-01T00:00:00Z'));
  });
  it('recovers stale terminal event buttons after edit delivery fails', async () => {
    const { service, repository, gateway } = setup();
    repository.claimPendingPresentations.mockResolvedValueOnce([{ ...row, status: 'CANCELLED' }] as never);
    repository.syncAnnouncement.mockImplementation(async (_g, _id, publish) => publish({ ...row, status: 'CANCELLED' }, 3));
    await service.runDue(new Date('2029-01-01T00:00:00Z'));
    expect(gateway.update).toHaveBeenCalledWith('c', 'm', expect.objectContaining({ status: 'CANCELLED' }), 3);
  });
  it('does not deliver a claimed reminder cancelled before send', async () => {
    const { service, repository, gateway } = setup();
    const claimedAt = new Date('2030-01-01T23:55:00Z');
    repository.claimDue.mockResolvedValue([{ event: row, reminder: { offsetSeconds: 600, claimedAt } }] as never);
    await service.runDue(claimedAt);
    expect(repository.deliverReminder).toHaveBeenCalledWith('g', 2, 600, claimedAt, claimedAt, expect.any(Function), expect.any(Function), row.startAt);
    expect(gateway.remind).not.toHaveBeenCalled();
  });
});
