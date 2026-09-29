import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../core/logger/logger.js';
import { PermissionService, type Actor } from '../../core/permissions/permission-service.js';
import { AutomationService, type AutomationRuleDraft } from './service.js';
import type { AutomationRepository } from './repository.js';

const guildId = '12345678901234567', owner = '22345678901234567';
const actor: Actor = { guildId, userId: owner, guildOwnerId: owner, roleIds: [] };
const at = new Date('2026-06-01T00:00:00.000Z');
function draft(enabled = true): AutomationRuleDraft {
  return { name: 'Reminder', timezone: 'America/New_York', cooldownSeconds: 30,
    config: { schemaVersion: 1, enabled,
      trigger: { id: 'SCHEDULED', version: 1, config: { kind: 'daily', time: '09:30', timezone: 'America/New_York' } },
      actions: [{ id: 'STATIC_MESSAGE', version: 1, config: { channelId: guildId, message: 'Configured only' } }] } };
}
function fixture(currentActor: (guildId: string, userId: string) => Promise<Actor | null> = async () => actor) {
  const repository = {
    create: vi.fn(async (_guild?: string, _authorizer?: string, input?: unknown) => input),
    get: vi.fn(async (_guild?: string, _id?: number) => ({ guildId, id: 1, enabled: true, authorizedBy: owner, deletedAt: null })),
    list: vi.fn(async () => []), update: vi.fn(async (_guild?: string, _id?: number, _authorizer?: string, input?: unknown) => input),
    setEnabled: vi.fn(async (_guild?: string, _id?: number, enabled?: boolean) => enabled),
    softDelete: vi.fn(async () => true), createExecution: vi.fn(async () => ({ id: 'execution' })),
    generateDue: vi.fn(async () => []), recoverExpired: vi.fn(async () => 0),
    claimDue: vi.fn(async () => [] as { id: string; guildId: string; automationId: number; claimToken: string }[]),
    finalizeClaim: vi.fn(async () => true), deferClaim: vi.fn(async () => true),
    prune: vi.fn(async () => ({ attempts: 0, executions: 0 })),
  };
  const permissions = new PermissionService({ getRoleLevels: vi.fn(async () => []) });
  const logger = { debug: vi.fn() } as unknown as Logger;
  const service = new AutomationService(repository as unknown as AutomationRepository, permissions, currentActor, logger);
  return { service, repository, logger };
}

describe('V7.3 inert Automation service', () => {
  it('requires Eiren ADMIN even if a nonowner holds Discord Administrator', async () => {
    const f = fixture();
    const discordAdminOnly: Actor = { ...actor, userId: '32345678901234567', roleIds: ['42345678901234567'] };
    await expect(f.service.create(discordAdminOnly, draft(), at)).rejects.toMatchObject({ code: 'PERMISSION' });
    await expect(f.service.list(discordAdminOnly)).rejects.toMatchObject({ code: 'PERMISSION' });
    await expect(f.service.inspect(discordAdminOnly, 1)).rejects.toMatchObject({ code: 'PERMISSION' });
    await expect(f.service.setEnabled(discordAdminOnly, 1, true)).rejects.toMatchObject({ code: 'PERMISSION' });
    await expect(f.service.delete(discordAdminOnly, 1)).rejects.toMatchObject({ code: 'PERMISSION' });
    expect(f.repository.create).not.toHaveBeenCalled();
  });
  it('derives approved capability from registered actions and computes only future UTC due times', async () => {
    const f = fixture();
    await f.service.create(actor, draft(), at);
    expect(f.repository.create).toHaveBeenCalledWith(guildId, owner, expect.objectContaining({
      approvedCapability: 'SEND_MESSAGE', enabled: true, timezone: 'America/New_York',
      nextRunAt: new Date('2026-06-01T13:30:00.000Z'), actions: [expect.objectContaining({ id: 'STATIC_MESSAGE' })],
    }));
    const staff = { ...draft(), config: { ...draft().config,
      actions: [{ id: 'STAFF_LOG', version: 1, config: { channelId: guildId, message: 'Configured only' } }] } };
    await f.service.create(actor, staff, at);
    expect(f.repository.create).toHaveBeenLastCalledWith(guildId, owner,
      expect.objectContaining({ approvedCapability: 'STAFF_LOG' }));
  });
  it('blocks invalid schedules, timezone drift, unsafe action config, name and cooldown', async () => {
    const f = fixture();
    const bad = [
      { ...draft(), timezone: 'No/Such_Zone' },
      { ...draft(), timezone: 'UTC' },
      { ...draft(), name: 'x'.repeat(81) },
      { ...draft(), cooldownSeconds: 86_401 },
      { ...draft(), config: { ...draft().config,
        actions: [{ id: 'STATIC_MESSAGE', version: 1, config: { channelId: guildId, message: 'x'.repeat(1001) } }] } },
      { ...draft(), config: { ...draft().config,
        actions: [{ id: 'HTTP_REQUEST', version: 1, config: { endpoint: 'https://example.com' } }] } },
    ];
    for (const input of bad) await expect(f.service.create(actor, input as AutomationRuleDraft, at))
      .rejects.toMatchObject({ code: 'VALIDATION' });
    expect(f.repository.create).not.toHaveBeenCalled();
  });
  it('restricts all rule reads/mutations and execution creation to the actor guild', async () => {
    const f = fixture();
    await f.service.inspect(actor, 1);
    await f.service.list(actor);
    await f.service.update(actor, 1, draft(), at);
    await f.service.setEnabled(actor, 1, false);
    await f.service.delete(actor, 1);
    await f.service.createExecution(actor, 1, 'trigger:test', at);
    expect(f.repository.get).toHaveBeenCalledWith(guildId, 1);
    expect(f.repository.update).toHaveBeenCalledWith(guildId, 1, owner, expect.anything());
    expect(f.repository.setEnabled).toHaveBeenCalledWith(guildId, 1, false);
    expect(f.repository.softDelete).toHaveBeenCalledWith(guildId, 1);
    expect(f.repository.createExecution).toHaveBeenCalledWith(guildId, 1, 'trigger:test', at, undefined, 0);
    await expect(f.service.createExecution(actor, 1, 'trigger:test', at, undefined, 3))
      .rejects.toMatchObject({ code: 'VALIDATION' });
  });
  it('does not infer current authority from the original configuring actor', async () => {
    const f = fixture(async () => null);
    f.repository.claimDue.mockResolvedValueOnce([{ id: 'claimed', guildId, automationId: 1, claimToken: 'lease' }]);
    await f.service.runDue(at);
    expect(f.repository.finalizeClaim).toHaveBeenCalledWith(guildId, 'claimed', 'lease', false, at);
  });
  it('rechecks fresh Eiren permission after lookup and never trusts Discord Administrator', async () => {
    const f = fixture(async () => ({ ...actor, guildOwnerId: '32345678901234567', roleIds: ['42345678901234567'] }));
    f.repository.claimDue.mockResolvedValueOnce([{ id: 'claimed', guildId, automationId: 1, claimToken: 'lease' }]);
    await f.service.runDue(at);
    expect(f.repository.finalizeClaim).toHaveBeenCalledWith(guildId, 'claimed', 'lease', false, at);
  });
  it('defers on uncertain external membership lookup rather than authorizing effects', async () => {
    const f = fixture(async () => { throw new Error('private Discord error'); });
    f.repository.claimDue.mockResolvedValueOnce([{ id: 'claimed', guildId, automationId: 1, claimToken: 'lease' }]);
    const result = await f.service.runDue(at);
    expect(result.deferred).toBe(1);
    expect(f.repository.deferClaim).toHaveBeenCalledWith(guildId, 'claimed', 'lease', at);
    expect(f.repository.finalizeClaim).not.toHaveBeenCalled();
    expect(JSON.stringify((f.logger.debug as ReturnType<typeof vi.fn>).mock.calls)).not.toContain('private Discord error');
  });
  it('finalizes authorized core work as inert metadata without Discord actions', async () => {
    const f = fixture();
    f.repository.claimDue.mockResolvedValueOnce([{ id: 'claimed', guildId, automationId: 1, claimToken: 'lease' }]);
    const result = await f.service.runDue(at);
    expect(result.finalized).toBe(1);
    expect(f.repository.finalizeClaim).toHaveBeenCalledWith(guildId, 'claimed', 'lease', true, at);
    expect(f.logger.debug).toHaveBeenCalledWith(expect.objectContaining({ job: 'automation', claimed: 1,
      generated: 0, finalized: 1 }), expect.any(String));
  });
});
