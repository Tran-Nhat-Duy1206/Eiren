import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../core/logger/logger.js';
import { PermissionService, type Actor } from '../../core/permissions/permission-service.js';
import type { AutomationRepository } from './repository.js';
import { AutomationService } from './service.js';
import type { AutomationDiscordGateway } from './discord-gateway.js';

const guildId = '123456789012345678', owner = '223456789012345678', channelId = '323456789012345678';
const firstMessageId = '423456789012345678', secondMessageId = '523456789012345678';
const actor: Actor = { guildId, userId: owner, guildOwnerId: owner, roleIds: [] };
const time = new Date('2031-01-01T00:00:00.000Z');
const action = (position: number, actionKey: 'STATIC_MESSAGE' | 'STAFF_LOG' = 'STATIC_MESSAGE') =>
  ({ position, actionKey, actionVersion: 1, config: { channelId, message: `literal-${position}` } });
function fixture(options: { actions?: ReturnType<typeof action>[]; currentActor?: (guildId: string, userId: string) => Promise<Actor | null>;
  send?: (message: string) => Promise<string>; preflight?: (guildId: string, channelId: string) => Promise<unknown> } = {}) {
  const actions = options.actions ?? [action(0)];
  const order: string[] = [];
  const send = vi.fn(options.send ?? (async (message: string) => {
    order.push(`send:${message}`);
    return message.endsWith('0') ? firstMessageId : secondMessageId;
  }));
  const preflight = vi.fn(options.preflight ?? (async () => ({ kind: 'READY' as const, send })));
  const repository = {
    generateDue: vi.fn(async () => []), recoverExpired: vi.fn(async () => 0),
    claimDue: vi.fn(async () => [{ guildId, id: 'execution', automationId: 1, claimToken: 'claim' }]),
    getClaimActions: vi.fn(async () => ({ automationId: 1, actions })),
    get: vi.fn(async () => ({ guildId, id: 1, enabled: true, deletedAt: null, authorizedBy: owner })),
    deferClaim: vi.fn(async () => true), stopBeforeDispatch: vi.fn(async () => { order.push('preflight-stop'); return true; }),
    prepareAction: vi.fn(async (_guild: string, _id: string, _token: string, position: number) => {
      order.push(`durable-running:${position}`);
      return { kind: 'READY' as const, snapshot: actions[position]!, dispatchToken: `dispatch-${position}` };
    }),
    confirmAction: vi.fn(async (_guild: string, _id: string, _token: string, position: number) => {
      order.push(`receipt:${position}`);
      return true;
    }),
    markAmbiguous: vi.fn(async () => { order.push('uncertain'); return true; }),
    reconcileUncertain: vi.fn(async () => true),
    prune: vi.fn(async () => ({ attempts: 0, executions: 0 })),
  };
  const gateway: AutomationDiscordGateway = { preflight } as unknown as AutomationDiscordGateway;
  const permissions = new PermissionService({ getRoleLevels: vi.fn(async () => []) });
  const logger = { debug: vi.fn(), error: vi.fn() } as unknown as Logger;
  const currentActor = vi.fn(options.currentActor ?? (async () => actor));
  const service = new AutomationService(repository as unknown as AutomationRepository, permissions, currentActor, logger, gateway);
  return { service, repository, currentActor, preflight, send, order, logger };
}

describe('V7.4 bounded real-action orchestration with a network-free gateway', () => {
  it.each(['STATIC_MESSAGE', 'STAFF_LOG'] as const)('%s sends one exact static message after durable intent, then receipt', async kind => {
    const f = fixture({ actions: [action(0, kind)] });
    const result = await f.service.runDue(time);
    expect(result).toMatchObject({ generated: 0, claimed: 1, finalized: 1, failures: 0 });
    expect(f.repository.claimDue).toHaveBeenCalledWith(time, 4);
    expect(f.order).toEqual(['durable-running:0', 'send:literal-0', 'receipt:0']);
    expect(f.send).toHaveBeenCalledExactlyOnceWith('literal-0');
    expect(f.repository.confirmAction).toHaveBeenCalledWith(guildId, 'execution', 'claim', 0,
      firstMessageId, time, 'dispatch-0');
    expect(f.currentActor).toHaveBeenCalledWith(guildId, owner);
  });
  it('runs two actions strictly in order with fresh human authority before each', async () => {
    const f = fixture({ actions: [action(0), action(1, 'STAFF_LOG')] });
    await f.service.runDue(time);
    expect(f.order).toEqual(['durable-running:0', 'send:literal-0', 'receipt:0',
      'durable-running:1', 'send:literal-1', 'receipt:1']);
    expect(f.currentActor).toHaveBeenCalledTimes(2);
    expect(f.send).toHaveBeenCalledTimes(2);
  });
  it('does not dispatch after role revocation between actions; retains first receipt', async () => {
    let reads = 0;
    const f = fixture({ actions: [action(0), action(1, 'STAFF_LOG')], currentActor: async () => ++reads === 1 ? actor : null });
    await f.service.runDue(time);
    expect(f.send).toHaveBeenCalledOnce();
    expect(f.repository.stopBeforeDispatch).toHaveBeenCalledWith(guildId, 'execution', 'claim', 1, 'AUTH_REVOKED', time);
    expect(f.repository.deferClaim).not.toHaveBeenCalled();
  });
  it('blocks stale epoch/config at final DB fence after successful external preflight', async () => {
    const f = fixture();
    f.repository.prepareAction.mockResolvedValueOnce({ kind: 'BLOCKED', code: 'STALE_CONFIG' } as never);
    await f.service.runDue(time);
    expect(f.preflight).toHaveBeenCalledOnce();
    expect(f.send).not.toHaveBeenCalled();
  });
  it('preflight wrong-guild channel is a permanent no-effect stop', async () => {
    const f = fixture({ preflight: async () => ({ kind: 'BLOCKED', code: 'CHANNEL_GUILD_MISMATCH' }) });
    await f.service.runDue(time);
    expect(f.repository.prepareAction).not.toHaveBeenCalled();
    expect(f.repository.stopBeforeDispatch).toHaveBeenCalledWith(guildId, 'execution', 'claim', 0, 'CHANNEL_GUILD_MISMATCH', time);
    expect(f.send).not.toHaveBeenCalled();
  });
  it('a send timeout is UNCERTAIN even when a late response succeeds; late promises are observed', async () => {
    vi.useFakeTimers();
    try {
      let finishSend!: (value: string) => void;
      const f = fixture({ send: () => new Promise<string>(resolve => { finishSend = resolve; }) });
      const running = f.service.runDue(time);
      for (let index = 0; index < 200 && !finishSend; index++) await Promise.resolve();
      expect(finishSend).toBeTypeOf('function');
      await vi.advanceTimersByTimeAsync(20_001);
      expect((await running).uncertain).toBe(1);
      expect(f.repository.markAmbiguous).toHaveBeenCalledOnce();
      finishSend(firstMessageId); // A late response cannot authorize a new action.
      await Promise.resolve();
      expect(f.repository.confirmAction).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
  it('send rejection is UNCERTAIN and never automatically retried', async () => {
    const f = fixture({ send: async () => { throw new Error('private REST failure'); } });
    const result = await f.service.runDue(time);
    expect(result.uncertain).toBe(1);
    expect(f.repository.markAmbiguous).toHaveBeenCalledWith(guildId, 'execution', 'claim', 0, time, 'dispatch-0');
    expect(f.repository.confirmAction).not.toHaveBeenCalled();
    expect(f.repository.deferClaim).not.toHaveBeenCalled();
    expect(JSON.stringify((f.logger.debug as ReturnType<typeof vi.fn>).mock.calls)).not.toContain('private REST failure');
  });
  it('a confirmed send followed by receipt DB failure remains unretryable RUNNING evidence', async () => {
    const f = fixture({ actions: [action(0), action(1)] });
    f.repository.confirmAction.mockRejectedValueOnce(new Error('database unavailable'));
    const result = await f.service.runDue(time);
    expect(result.uncertain).toBe(1);
    expect(f.send).toHaveBeenCalledOnce();
    expect(f.repository.markAmbiguous).not.toHaveBeenCalled();
    expect(f.repository.deferClaim).not.toHaveBeenCalled();
  });
  it('unknown legacy action has no handler and cannot reach a send', async () => {
    const f = fixture({ actions: [{ ...action(0), actionKey: 'LEGACY_INERT' as 'STATIC_MESSAGE' }] });
    await f.service.runDue(time);
    expect(f.preflight).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
    expect(f.repository.stopBeforeDispatch).toHaveBeenCalledWith(guildId, 'execution', 'claim', 0, 'UNKNOWN_ACTION', time);
  });
  it('bounds worker concurrency at four even if the claim source returns extra work', async () => {
    let active = 0, maximum = 0;
    const pending: (() => void)[] = [];
    const f = fixture({ send: async () => {
      active++;
      maximum = Math.max(maximum, active);
      await new Promise<void>(resolve => pending.push(resolve));
      active--;
      return firstMessageId;
    } });
    f.repository.claimDue.mockResolvedValueOnce(Array.from({ length: 8 }, (_, index) =>
      ({ guildId, id: `execution-${index}`, automationId: 1, claimToken: `claim-${index}` })));
    const running = f.service.runDue(time);
    for (let index = 0; index < 400 && pending.length !== 4; index++) await Promise.resolve();
    expect(pending).toHaveLength(4);
    expect(maximum).toBe(4);
    pending.splice(0).forEach(resolve => resolve());
    for (let index = 0; index < 400 && pending.length !== 4; index++) await Promise.resolve();
    expect(pending).toHaveLength(4);
    pending.splice(0).forEach(resolve => resolve());
    expect((await running).finalized).toBe(8);
    expect(maximum).toBe(4);
  });
  it('isolates one claim database failure without cancelling a separate claim', async () => {
    const f = fixture();
    f.repository.claimDue.mockResolvedValueOnce([
      { guildId, id: 'bad', automationId: 1, claimToken: 'bad-claim' },
      { guildId, id: 'good', automationId: 1, claimToken: 'good-claim' },
    ]);
    f.repository.getClaimActions.mockRejectedValueOnce(new Error('database unavailable'));
    expect(await f.service.runDue(time)).toMatchObject({ finalized: 1, failures: 1 });
    expect(f.send).toHaveBeenCalledOnce();
    expect(f.logger.error).toHaveBeenCalledOnce();
  });
  it('requires Eiren ADMIN to reconcile and scopes the executor guild', async () => {
    const f = fixture();
    await expect(f.service.reconcile({ ...actor, userId: channelId }, 'execution', 0, 'CONFIRMED_SENT'))
      .rejects.toMatchObject({ code: 'PERMISSION' });
    await f.service.reconcile(actor, 'execution', 0, 'CONFIRMED_NOT_SENT', time);
    expect(f.repository.reconcileUncertain).toHaveBeenCalledWith(guildId, 'execution', 0, owner, 'CONFIRMED_NOT_SENT', time);
    const departed = fixture({ currentActor: async () => null });
    await expect(departed.service.reconcile(actor, 'execution', 0, 'CONFIRMED_SENT'))
      .rejects.toMatchObject({ code: 'PERMISSION' });
    expect(departed.repository.reconcileUncertain).not.toHaveBeenCalled();
  });
});
