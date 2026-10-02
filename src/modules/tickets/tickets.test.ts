import { describe, expect, it, vi } from 'vitest';
import { AppError } from '../../core/errors/errors.js';
import { TicketService } from './service.js';

const actor = { userId: '12345678901234567', guildId: '22345678901234567', guildOwnerId: '32345678901234567', roleIds: [] };
const row = { id: 1, guildId: actor.guildId, creatorId: actor.userId, type: 'SUPPORT', channelId: '42345678901234567', status: 'OPEN', transcriptGeneratedAt: null };
function fixture() {
  const repo = { settings: vi.fn().mockResolvedValue({ setting: { staffRoleId: '52345678901234567', maxActiveTickets: 1 }, categoryId: '62345678901234567' }),
    reserve: vi.fn().mockResolvedValue({ ...row, channelId: null }), attach: vi.fn().mockResolvedValue(row), abandon: vi.fn(),
    get: vi.fn().mockResolvedValue(row), participants: vi.fn().mockResolvedValue([]), claim: vi.fn().mockResolvedValue(row), transfer: vi.fn(),
    archive: vi.fn(async (_guild: string, _id: number, _actor: string, _reason: string, fetch: (id: string) => Promise<string>) => {
      await fetch(row.channelId);
      return { row: { ...row, status: 'CLOSED' }, changed: true };
    }) };
  const gateway = { assertConfiguration: vi.fn(), create: vi.fn().mockResolvedValue(row.channelId), delete: vi.fn(),
    transcript: vi.fn().mockResolvedValue('private transcript'), setParticipant: vi.fn(), memberExists: vi.fn().mockResolvedValue(true), botId: vi.fn().mockReturnValue('82345678901234567'), memberRoleIds: vi.fn().mockResolvedValue([]) };
  const permissions = { require: vi.fn().mockRejectedValue(new AppError('PERMISSION', 'denied')) };
  const service = new TicketService(repo as never, permissions as never, { warn: vi.fn(), error: vi.fn() } as never, async () => gateway);
  return { repo, gateway, permissions, service };
}
describe('ticket privacy and state transitions', () => {
  it('grants direct access to a helper who claims without the staff Discord role', async () => {
    const { repo, gateway, permissions, service } = fixture();
    permissions.require.mockResolvedValue(undefined);
    const helper = { ...actor, userId: '72345678901234567' };
    repo.claim = vi.fn(async (_guild: string, _id: number, _user: string, grant: (ticket: typeof row, participant: boolean) => Promise<unknown>) => {
      await grant(row, false);
      return { ...row, status: 'CLAIMED', assignedStaffId: helper.userId };
    }) as never;
    await service.claim(helper, 1);
    expect(gateway.setParticipant).toHaveBeenCalledExactlyOnceWith(row.channelId, helper.userId, true);
  });
  it('does not overwrite existing participant access when claiming', async () => {
    const { repo, gateway, permissions, service } = fixture();
    permissions.require.mockResolvedValue(undefined);
    repo.claim = vi.fn(async (_guild: string, _id: number, _user: string, grant: (ticket: typeof row, participant: boolean) => Promise<unknown>) => {
      await grant(row, true);
      return row;
    }) as never;
    await service.claim({ ...actor, userId: '72345678901234567' }, 1);
    expect(gateway.setParticipant).not.toHaveBeenCalled();
  });
  it('does not create a channel when capacity reservation fails', async () => {
    const { repo, gateway, service } = fixture();
    repo.reserve.mockRejectedValueOnce(new AppError('CONFLICT', 'maximum reached'));
    await expect(service.open(actor, 'SUPPORT')).rejects.toThrow('maximum reached');
    expect(gateway.create).not.toHaveBeenCalled();
  });
  it('cleans placeholder and channel when database attachment fails', async () => {
    const { repo, gateway, service } = fixture();
    repo.attach.mockRejectedValueOnce(new Error('db unavailable'));
    await expect(service.open(actor, 'SUPPORT')).rejects.toThrow('db unavailable');
    expect(gateway.delete).toHaveBeenCalledWith(row.channelId);
    expect(repo.abandon).toHaveBeenCalled();
  });
  it('leaves ticket channel intact when transcript retrieval fails', async () => {
    const { repo, gateway, service } = fixture();
    gateway.transcript.mockRejectedValueOnce(new Error('fetch failed'));
    await expect(service.close(actor, 1)).rejects.toThrow('fetch failed');
    expect(repo.archive).toHaveBeenCalledOnce();
    expect(gateway.delete).not.toHaveBeenCalled();
  });
  it('never exposes transcript through status and denies other members', async () => {
    const { service, permissions } = fixture();
    await expect(service.status({ ...actor, userId: '72345678901234567' }, 1)).rejects.toThrow('denied');
    expect(permissions.require).toHaveBeenCalledWith(expect.anything(), 'HELPER');
  });
  it('requires moderator privilege for stored transcript even for creator', async () => {
    const { service, permissions } = fixture();
    await expect(service.transcript(actor, 1)).rejects.toThrow('denied');
    expect(permissions.require).toHaveBeenCalledWith(actor, 'MODERATOR');
  });
  it('reports a removed transcript as retention redaction without refetching Discord', async () => {
    const { service, repo, gateway, permissions } = fixture();
    permissions.require.mockResolvedValue(undefined);
    repo.get.mockResolvedValueOnce({ ...row, status: 'CLOSED', transcript: null,
      transcriptGeneratedAt: new Date(), transcriptRedactedAt: new Date(), transcriptRetentionPolicyVersion: 1 });
    await expect(service.transcript(actor, 1)).rejects.toThrow('removed under the guild retention policy');
    expect(gateway.transcript).not.toHaveBeenCalled();
  });
  it('refuses bot and everyone participant overwrites', async () => {
    const { service, gateway, permissions } = fixture();
    permissions.require.mockResolvedValue(undefined);
    await expect(service.participant(actor, 1, actor.guildId, true)).rejects.toThrow('Cannot change');
    await expect(service.participant(actor, 1, gateway.botId(), false)).rejects.toThrow('Cannot change');
    expect(gateway.setParticipant).not.toHaveBeenCalled();
  });
  it('rejects max-active values outside schema check', async () => {
    const { service, permissions } = fixture();
    permissions.require.mockResolvedValueOnce(undefined);
    await expect(service.configure(actor, { maxActiveTickets: 11 })).rejects.toThrow('1–10');
  });
  it('grants transferred helper access and revokes former assignee under transfer callback', async () => {
    const { repo, gateway, permissions, service } = fixture();
    permissions.require.mockResolvedValue(undefined);
    const former = '92345678901234567';
    const successor = '72345678901234567';
    repo.transfer = vi.fn(async (_guild: string, _id: number, _userId: string, reconcile: (ticket: typeof row & { assignedStaffId: string }, oldParticipant: boolean, newParticipant: boolean) => Promise<unknown>) => {
      await reconcile({ ...row, assignedStaffId: former }, false, false);
      return { ...row, assignedStaffId: successor };
    }) as never;
    await service.transfer(actor, 1, successor);
    expect(gateway.setParticipant).toHaveBeenNthCalledWith(1, row.channelId, successor, true);
    expect(gateway.setParticipant).toHaveBeenNthCalledWith(2, row.channelId, former, false);
  });
  it('preserves a former assignee who is also a participant', async () => {
    const { repo, gateway, permissions, service } = fixture();
    permissions.require.mockResolvedValue(undefined);
    const former = '92345678901234567';
    repo.transfer = vi.fn(async (_guild: string, _id: number, _userId: string, reconcile: (ticket: typeof row & { assignedStaffId: string }, oldParticipant: boolean, newParticipant: boolean) => Promise<unknown>) => {
      await reconcile({ ...row, assignedStaffId: former }, true, false);
      return row;
    }) as never;
    await service.transfer(actor, 1, '72345678901234567');
    expect(gateway.setParticipant).not.toHaveBeenCalledWith(row.channelId, former, false);
  });
  it('rejects transfer to a non-helper', async () => {
    const { repo, gateway, service } = fixture();
    await expect(service.transfer(actor, 1, '72345678901234567')).rejects.toThrow('denied');
    expect(repo.transfer).not.toHaveBeenCalled();
    expect(gateway.setParticipant).not.toHaveBeenCalled();
  });
  it('requires moderator privilege to force-close another creator ticket', async () => {
    const { service, gateway, permissions } = fixture();
    await expect(service.close({ ...actor, userId: '72345678901234567' }, 1)).rejects.toThrow('denied');
    expect(permissions.require).toHaveBeenCalledWith(expect.anything(), 'MODERATOR');
    expect(gateway.transcript).not.toHaveBeenCalled();
  });
});
