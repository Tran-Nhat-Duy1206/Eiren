import { describe, expect, it, vi } from 'vitest';
import { AppError } from '../../core/errors/errors.js';
import type { Actor, PermissionService } from '../../core/permissions/permission-service.js';
import { ReportService } from './service.js';
import { reportCommands } from './commands.js';
import type { ReportRepository } from './repository.js';
import type { GuildLogNotifier } from '../../services/log-notifier.js';

const actor: Actor = { userId: '111111111111111111', guildId: '222222222222222222', guildOwnerId: '333333333333333333', roleIds: [] };
function setup(level: 'MEMBER' | 'MODERATOR' | 'SENIOR_MODERATOR' = 'MEMBER', notify?: GuildLogNotifier) {
  const ranks = ['MEMBER', 'MODERATOR', 'SENIOR_MODERATOR'];
  const permissions = { require: vi.fn(async (_actor: Actor, minimum: string) => {
    if (ranks.indexOf(level) < ranks.indexOf(minimum)) throw new AppError('PERMISSION', 'Not permitted.');
  }) } as unknown as PermissionService;
  const repository = { listReports: vi.fn(async () => []), getReport: vi.fn(async () => ({ id: 1, guildId: actor.guildId, description: 'private' })),
    closeReport: vi.fn(async () => ({ id: 1 })), listAppeals: vi.fn(async () => []), reviewAppeal: vi.fn(async () => ({ id: 1 })),
    submitReport: vi.fn(async () => ({ id: 1 })), submitAppeal: vi.fn(async () => ({ id: 1 })) };
  return { service: new ReportService(repository as unknown as ReportRepository, permissions, notify), repository };
}
describe('reports authorization and privacy', () => {
  it('allows member submissions but refuses staff reads and transitions', async () => {
    const { service, repository } = setup();
    await service.submitReport(actor, { category: 'Spam', description: 'Sensitive details' });
    await service.submitAppeal(actor, { reason: 'Please review' });
    await expect(service.listReports(actor)).rejects.toMatchObject({ code: 'PERMISSION' });
    await expect(service.getReport(actor, 1)).rejects.toMatchObject({ code: 'PERMISSION' });
    await expect(service.closeReport(actor, 1, 'done')).rejects.toMatchObject({ code: 'PERMISSION' });
    await expect(service.reviewAppeal(actor, 1, 'ACCEPTED', 'done')).rejects.toMatchObject({ code: 'PERMISSION' });
    expect(repository.getReport).not.toHaveBeenCalled();
    expect(repository.closeReport).not.toHaveBeenCalled();
  });
  it('requires senior moderator for decisions and does not perform punishment', async () => {
    const { service, repository } = setup('MODERATOR');
    await service.listReports(actor);
    await expect(service.closeReport(actor, 1, 'done')).rejects.toMatchObject({ code: 'PERMISSION' });
    expect(repository.closeReport).not.toHaveBeenCalled();
  });
  it('defines exactly two root commands with private submission responses', async () => {
    expect(reportCommands.map(c => c.data.name)).toEqual(['report', 'appeal']);
    const { service } = setup();
    const interaction = { guild: { id: actor.guildId, ownerId: actor.guildOwnerId, members: { fetch: async () => ({ roles: { cache: new Map() } }) } },
      user: { id: actor.userId }, options: { getSubcommand: () => 'submit', getString: (key: string) => key === 'category' ? 'Spam' : key === 'description' ? 'SECRET DESCRIPTION' : null, getUser: () => null }, editReply: vi.fn() };
    await reportCommands[0]!.execute(interaction as never, { reports: service } as never);
    expect(interaction.editReply).toHaveBeenCalledWith({ content: 'Private report #1 submitted for staff review.' });
    expect(JSON.stringify(interaction.editReply.mock.calls)).not.toContain('SECRET');
  });
  it('audits only IDs and statuses, and tolerates notifier failures', async () => {
    const notify = vi.fn(async () => { throw new Error('log delivery unavailable'); });
    const { service } = setup('SENIOR_MODERATOR', notify);
    await expect(service.submitReport(actor, { category: 'SECRET CATEGORY', description: 'SECRET DESCRIPTION', evidenceUrl: 'https://example.org/SECRET_EVIDENCE' })).resolves.toMatchObject({ id: 1 });
    await expect(service.closeReport(actor, 1, 'SECRET RESOLUTION')).resolves.toMatchObject({ id: 1 });
    await expect(service.submitAppeal(actor, { reason: 'SECRET REASON' })).resolves.toMatchObject({ id: 1 });
    await expect(service.reviewAppeal(actor, 1, 'REJECTED', 'SECRET REVIEW')).resolves.toMatchObject({ id: 1 });
    expect(notify.mock.calls).toEqual([
      [actor.guildId, 'moderation', 'Report opened', [{ name: 'ID', value: '1' }, { name: 'Status', value: 'OPEN' }]],
      [actor.guildId, 'moderation', 'Report closed', [{ name: 'ID', value: '1' }, { name: 'Status', value: 'CLOSED' }]],
      [actor.guildId, 'moderation', 'Appeal opened', [{ name: 'ID', value: '1' }, { name: 'Status', value: 'PENDING' }]],
      [actor.guildId, 'moderation', 'Appeal reviewed', [{ name: 'ID', value: '1' }, { name: 'Status', value: 'REJECTED' }]],
    ]);
    expect(JSON.stringify(notify.mock.calls)).not.toContain('SECRET');
  });
  it('forwards guild and appellant identity to transactional persistence', async () => {
    const { service, repository } = setup();
    await service.submitAppeal(actor, { caseId: 42, reason: 'review' });
    expect(repository.submitAppeal).toHaveBeenCalledWith({ guildId: actor.guildId, appellantId: actor.userId, caseId: 42, reason: 'review' });
  });
});
