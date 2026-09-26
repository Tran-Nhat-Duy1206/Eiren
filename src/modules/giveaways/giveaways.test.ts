import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { guildModules } from '../../core/database/schema.js';
import type { Database } from '../../core/database/connection.js';
import { chooseWinners, GiveawayService } from './service.js';
import { DiscordGiveawayGateway, giveawayContent } from './discord-gateway.js';
import type { Client } from 'discord.js';
import type { GiveawayRepository } from './repository.js';
import type { PermissionService } from '../../core/permissions/permission-service.js';
import type { ModuleService } from '../../services/module-service.js';
import type { Logger } from '../../core/logger/logger.js';

describe('giveaways', () => {
  it('filters disabled guilds in SQL before limiting all three scheduler queues', async () => {
    const joins: { table: unknown; sql: string; params: unknown[] }[] = [];
    const dialect = new PgDialect();
    const query = { from() { return this; }, innerJoin(table: unknown, condition: Parameters<PgDialect['sqlToQuery']>[0]) {
      const compiled = dialect.sqlToQuery(condition);
      joins.push({ table, sql: compiled.sql, params: compiled.params }); return this;
    }, where() { return this; }, orderBy() { return this; }, limit() { return Promise.resolve([]); } };
    const repository = new (await import('./repository.js')).GiveawayRepository({ select: () => query } as unknown as Database);
    await repository.due(new Date(), 20);
    await repository.pendingDrawNotices(20);
    await repository.missingPosts(20);
    expect(joins).toHaveLength(4); // Due and missing-post queries each join once; draw notices join giveaways first.
    const moduleJoins = joins.filter(join => join.table === guildModules);
    expect(moduleJoins).toHaveLength(3);
    for (const join of moduleJoins) {
      expect(join.sql).toContain('"guild_modules"."enabled"');
      expect(join.sql).toContain('"guild_modules"."module_key"');
      expect(join.params).toContain('giveaways');
      expect(join.params).toContain(true);
    }
  });
  it('posts bounded full giveaway requirements, count, creator and disabled buttons without pings', async () => {
    const row = { id: 19, guildId: 'g', channelId: 'c', messageId: 'm', creatorId: 'creator', prize: 'P'.repeat(256),
      endAt: new Date('2030-01-01'), status: 'ACTIVE', winnerCount: 3, requiredRoleId: 'required',
      minAccountAgeSeconds: 3600, minGuildAgeSeconds: 600, requireVerified: true, minLevel: 4 };
    const sent: { content: string; components: { components: { data: { disabled?: boolean } }[] }[]; allowedMentions: { parse: string[] } }[] = [];
    const channel = { type: 0, send: vi.fn(async (payload: typeof sent[number]) => { sent.push(payload); return { id: 'new' }; }),
      messages: { edit: vi.fn(async (_id: string, payload: typeof sent[number]) => { sent.push(payload); }) } };
    const guild = { channels: { fetch: vi.fn(async () => channel) } };
    const gateway = new DiscordGiveawayGateway({ guilds: { fetch: vi.fn(async () => guild) } } as unknown as Client, 'g');
    expect(await gateway.post(row as never, 12)).toBe('new');
    expect(sent[0]!.content).toContain('Created by: <@creator>');
    for (const requirement of ['Role: <@&required>', 'Account age: 3600s', 'Server age: 600s', 'Verified account', 'Level 4+', 'Entries: 12', 'Status: ACTIVE'])
      expect(sent[0]!.content).toContain(requirement);
    expect(sent[0]!.content.length).toBeLessThanOrEqual(2000);
    expect(sent[0]!.allowedMentions).toEqual({ parse: [] });
    expect(sent[0]!.components[0]!.components).toHaveLength(2);
    await gateway.refresh({ ...row, status: 'ENDED' } as never, 13);
    expect(sent[1]!.content).toContain('Entries: 13');
    expect(sent[1]!.components[0]!.components.every(component => component.data.disabled)).toBe(true);
    expect(() => giveawayContent({ ...row, prize: 'P'.repeat(2001) } as never, 0)).toThrow('limits');
  });
  it('reconciles missed entry-count refresh on a later scheduler tick', async () => {
    const row = { id: 20, guildId: 'g', status: 'ACTIVE', messageId: 'posted' };
    const repository = { due: vi.fn(async () => []), pendingDrawNotices: vi.fn(async () => []), missingPosts: vi.fn(async () => []),
      refreshCandidates: vi.fn(async () => [row]), entryCount: vi.fn(async () => 7), markRefreshAttempt: vi.fn(async () => {}) } as unknown as GiveawayRepository;
    const gateway = { refresh: vi.fn().mockRejectedValueOnce(new Error('transient')).mockResolvedValueOnce(undefined) };
    const service = new GiveawayService(repository, {} as PermissionService,
      { isEnabled: vi.fn(async () => true) } as unknown as ModuleService,
      async () => gateway as never, { warn: vi.fn() } as unknown as Logger);
    await service.runDue(); await service.runDue();
    expect(gateway.refresh).toHaveBeenCalledTimes(2);
    expect(gateway.refresh).toHaveBeenNthCalledWith(2, row, 7);
    expect(repository.markRefreshAttempt).toHaveBeenCalledTimes(2);
  });
  it('draws distinct winners without exceeding the available pool', () => {
    for (let i = 0; i < 100; i++) {
      const winners = chooseWinners(['a', 'b', 'a', 'c'], 20);
      expect(winners).toHaveLength(3);
      expect(new Set(winners).size).toBe(3);
      expect(winners.every(id => ['a', 'b', 'c'].includes(id))).toBe(true);
    }
  });
  it('rejects verification requirements while verification is disabled', async () => {
    const repository = { create: vi.fn() } as unknown as GiveawayRepository;
    const modules = { isEnabled: vi.fn(async (_guild: string, key: string) => key === 'giveaways') } as unknown as ModuleService;
    const permissions = { require: vi.fn(async () => {}) } as unknown as PermissionService;
    const service = new GiveawayService(repository, permissions, modules, async () => { throw new Error('gateway must not be called'); }, { warn: vi.fn() } as unknown as Logger);
    await expect(service.create({ guildId: 'g', userId: 'u', guildOwnerId: 'u', roleIds: [] }, {
      channelId: 'c', prize: 'Prize', endAt: new Date(Date.now() + 60000), winnerCount: 1, requireVerified: true,
    })).rejects.toThrow('Enable verification');
    expect(repository.create).not.toHaveBeenCalled();
  });
  it('recovers a committed draw after restart when its original post was deleted', async () => {
    const row = { id: 7, guildId: 'g', channelId: 'c', messageId: 'deleted', status: 'ENDED', prize: 'Prize' };
    const repository = { due: vi.fn(async () => []), pendingDrawNotices: vi.fn(async () => [{ row, draw: { id: 11, kind: 'ORIGINAL' } }]),
      missingPosts: vi.fn(async () => []), refreshCandidates: vi.fn(async () => []), claimDrawNotice: vi.fn(async () => new Date(1000)),
      drawWinners: vi.fn(async () => [{ userId: 'winner' }]), finishDrawNotice: vi.fn(async () => true),
      releaseDrawNotice: vi.fn(async () => {}) } as unknown as GiveawayRepository;
    const gateway = { findAnnouncement: vi.fn(async () => null), announce: vi.fn(async () => 'result'),
      refresh: vi.fn(async () => { throw new Error('deleted'); }) };
    const service = new GiveawayService(repository, {} as PermissionService,
      { isEnabled: vi.fn(async () => true) } as unknown as ModuleService,
      async () => gateway as never, { warn: vi.fn() } as unknown as Logger);
    expect(await service.runDue(2)).toBe(1);
    expect(gateway.announce).toHaveBeenCalledWith(row, ['winner'], 11);
    expect(repository.finishDrawNotice).toHaveBeenCalledWith(11, new Date(1000), 'result');
  });
  it('recovers persisted result ID without a duplicate notification', async () => {
    const row = { id: 7, guildId: 'g', status: 'ENDED' };
    const repository = { due: vi.fn(async () => []), pendingDrawNotices: vi.fn(async () => [{ row, draw: { id: 12, kind: 'REROLL' } }]), missingPosts: vi.fn(async () => []), refreshCandidates: vi.fn(async () => []),
      claimDrawNotice: vi.fn(async () => new Date(1000)), drawWinners: vi.fn(async () => []), finishDrawNotice: vi.fn(async () => true) } as unknown as GiveawayRepository;
    const gateway = { findAnnouncement: vi.fn(async () => 'existing-result'), announce: vi.fn(), refresh: vi.fn(async () => {}) };
    const service = new GiveawayService(repository, {} as PermissionService,
      { isEnabled: vi.fn(async () => true) } as unknown as ModuleService,
      async () => gateway as never, { warn: vi.fn() } as unknown as Logger);
    await service.runDue();
    expect(gateway.announce).not.toHaveBeenCalled();
    expect(repository.finishDrawNotice).toHaveBeenCalledWith(12, new Date(1000), 'existing-result');
  });
  it('retains a failed reroll notice for the next scheduler pass without redrawing', async () => {
    const row = { id: 9, guildId: 'g', status: 'ENDED', resultAnnouncementId: null };
    const repository = { due: vi.fn(async () => []), pendingDrawNotices: vi.fn(async () => [{ row, draw: { id: 42, kind: 'REROLL' } }]),
      missingPosts: vi.fn(async () => []), refreshCandidates: vi.fn(async () => []), claimDrawNotice: vi.fn(async () => new Date(1000)),
      drawWinners: vi.fn(async () => [{ userId: 'u' }]), releaseDrawNotice: vi.fn(async () => {}),
      finishDrawNotice: vi.fn(async () => true), draw: vi.fn() } as unknown as GiveawayRepository;
    const gateway = { findAnnouncement: vi.fn(async () => null), announce: vi.fn()
      .mockRejectedValueOnce(new Error('Discord unavailable')).mockResolvedValueOnce('sent'), refresh: vi.fn() };
    const service = new GiveawayService(repository, {} as PermissionService,
      { isEnabled: vi.fn(async () => true) } as unknown as ModuleService,
      async () => gateway as never, { warn: vi.fn() } as unknown as Logger);
    await service.runDue();
    expect(repository.releaseDrawNotice).toHaveBeenCalledWith(42, new Date(1000));
    await service.runDue();
    expect(repository.finishDrawNotice).toHaveBeenCalledWith(42, new Date(1000), 'sent');
    expect(repository.draw).not.toHaveBeenCalled();
  });
  it('checks role, both ages, verification, level and module state before entry', async () => {
    const now = Date.now();
    const row = { id: 1, guildId: 'g', channelId: 'c', messageId: 'm', status: 'ACTIVE',
      endAt: new Date(now + 60000), requiredRoleId: 'required', minAccountAgeSeconds: 3600,
      minGuildAgeSeconds: 600, requireVerified: true, minLevel: 2 };
    const member = { bot: false, roleIds: ['required'], createdAt: new Date(now - 3600001), joinedAt: new Date(now - 600001) };
    const repository = { get: vi.fn(async () => row), entryCount: vi.fn(async () => 0), draws: vi.fn(async () => []),
      entry: vi.fn(async () => true), verified: vi.fn(async () => true), level: vi.fn(async () => 400) } as unknown as GiveawayRepository;
    const gateway = { member: vi.fn(async () => member) };
    const disabled = new Set<string>();
    const modules = { isEnabled: vi.fn(async (_guild: string, key: string) => !disabled.has(key)) } as unknown as ModuleService;
    const service = new GiveawayService(repository, {} as PermissionService, modules, async () => gateway as never,
      { warn: vi.fn() } as unknown as Logger);
    const enter = () => service.entry('g', 1, 'u', 'enter', 'c', 'm', false);
    expect(await enter()).toBe(true);
    member.roleIds = []; await expect(enter()).rejects.toThrow('requirements'); member.roleIds = ['required'];
    member.createdAt = new Date(now - 1000); await expect(enter()).rejects.toThrow('requirements'); member.createdAt = new Date(now - 3600001);
    member.joinedAt = new Date(now - 1000); await expect(enter()).rejects.toThrow('requirements'); member.joinedAt = new Date(now - 600001);
    vi.mocked(repository.verified).mockResolvedValueOnce(false); await expect(enter()).rejects.toThrow('requirements');
    vi.mocked(repository.level).mockResolvedValueOnce(undefined); await expect(enter()).rejects.toThrow('requirements');
    disabled.add('verification'); await expect(enter()).rejects.toThrow('requirements'); disabled.clear();
    disabled.add('levels'); await expect(enter()).rejects.toThrow('requirements');
    expect(repository.entry).toHaveBeenCalledTimes(1);
  });
  it('rechecks eligibility inside draw, retries changed entry snapshots, and does not send until committed', async () => {
    const now = Date.now();
    const row = { id: 2, guildId: 'g', channelId: 'c', messageId: 'm', status: 'ACTIVE',
      endAt: new Date(now - 1000), requiredRoleId: 'r', requireVerified: true, minLevel: 1 };
    const gateway = { member: vi.fn(async () => ({ bot: false, roleIds: ['r'],
      createdAt: new Date(now - 86400000), joinedAt: new Date(now - 86400000) })),
      refresh: vi.fn(async () => {}), findAnnouncement: vi.fn(async () => null), announce: vi.fn(async () => 'm-result') };
    let attempt = 0;
    const repository = { get: vi.fn(async () => row), entryCount: vi.fn(async () => 1), draws: vi.fn(async () => []),
      entries: vi.fn(async () => [{ userId: 'u' }]), verified: vi.fn(async () => true), level: vi.fn(async () => 100),
      draw: vi.fn(async (_guild: string, _id: number, _kind: string, snapshot: string[], eligible: (id: string, tx: never) => Promise<boolean>) => {
        expect(snapshot).toEqual(['u']);
        expect(await eligible('u', {} as never)).toBe(true);
        return ++attempt === 1 ? { state: 'RETRY' } : { state: 'DRAWN', row: { ...row, status: 'ENDED' }, drawId: 51, winners: ['u'] };
      }), claimDrawNotice: vi.fn(async () => new Date(1000)), drawWinners: vi.fn(async () => [{ userId: 'u' }]),
      finishDrawNotice: vi.fn(async () => true) } as unknown as GiveawayRepository;
    const service = new GiveawayService(repository, {} as PermissionService,
      { isEnabled: vi.fn(async () => true) } as unknown as ModuleService,
      async () => gateway as never, { warn: vi.fn() } as unknown as Logger);
    expect((await service.draw('g', 2, 'ORIGINAL')).state).toBe('DRAWN');
    expect(repository.entries).toHaveBeenCalledTimes(2);
    expect(gateway.member).toHaveBeenCalledTimes(2); // Preflight, never inside the transaction callback.
    expect(gateway.announce).toHaveBeenCalledTimes(1);
  });
  it('rechecks changed verification and level at draw rather than trusting entry state', async () => {
    const now = Date.now();
    const row = { id: 4, guildId: 'g', channelId: 'c', messageId: 'm', status: 'ACTIVE',
      endAt: new Date(now - 1000), requireVerified: true, minLevel: 1, requiredRoleId: null };
    const repository = { get: vi.fn(async () => row), entryCount: vi.fn(async () => 1), draws: vi.fn(async () => []),
      entries: vi.fn(async () => [{ userId: 'u' }]), verified: vi.fn(async () => false), level: vi.fn(async () => 0),
      draw: vi.fn(async (_guild: string, _id: number, _kind: string, _ids: string[], eligible: (id: string, tx: never) => Promise<boolean>) => {
        expect(await eligible('u', {} as never)).toBe(false);
        return { state: 'DRAWN', row: { ...row, status: 'ENDED' }, drawId: 40, winners: [] };
      }), claimDrawNotice: vi.fn(async () => null) } as unknown as GiveawayRepository;
    const gateway = { member: vi.fn(async () => ({ bot: false, roleIds: [], createdAt: new Date(0), joinedAt: new Date(0) })),
      refresh: vi.fn(async () => {}) };
    const onWon = vi.fn();
    const service = new GiveawayService(repository, {} as PermissionService,
      { isEnabled: vi.fn(async () => true) } as unknown as ModuleService,
      async () => gateway as never, { warn: vi.fn() } as unknown as Logger, onWon);
    expect((await service.draw('g', 4, 'ORIGINAL')).state).toBe('DRAWN');
    expect(onWon).not.toHaveBeenCalled();
    vi.mocked(repository.verified).mockResolvedValue(true);
    const eligible = vi.mocked(repository.draw).mock.calls[0]![4];
    expect(await eligible('u', {} as never)).toBe(false); // The level changed too.
  });
  it('runs concurrent scheduler ticks without a second committed original draw', async () => {
    const row = { id: 5, guildId: 'g', channelId: 'c', messageId: 'm', status: 'ACTIVE',
      endAt: new Date(Date.now() - 1000), requireVerified: false, minLevel: null, requiredRoleId: null };
    let committed = false;
    const repository = { get: vi.fn(async () => row), entryCount: vi.fn(async () => 0), draws: vi.fn(async () => []),
      due: vi.fn(async () => [row]), entries: vi.fn(async () => []), pendingDrawNotices: vi.fn(async () => []), missingPosts: vi.fn(async () => []), refreshCandidates: vi.fn(async () => []),
      draw: vi.fn(async () => { if (committed) return { state: 'ALREADY', row: { ...row, status: 'ENDED' } };
        committed = true; return { state: 'DRAWN', row: { ...row, status: 'ENDED' }, drawId: 5, winners: [] }; }),
      claimDrawNotice: vi.fn(async () => null) } as unknown as GiveawayRepository;
    const gateway = { refresh: vi.fn(async () => {}), member: vi.fn() };
    const service = new GiveawayService(repository, {} as PermissionService,
      { isEnabled: vi.fn(async () => true) } as unknown as ModuleService,
      async () => gateway as never, { warn: vi.fn() } as unknown as Logger);
    await Promise.all([service.runDue(), service.runDue()]);
    expect(repository.draw).toHaveBeenCalledTimes(2);
    expect(gateway.refresh).toHaveBeenCalledTimes(1);
  });
  it('keeps entry idempotent, cancels once and reports closed follow-up', async () => {
    const row = { id: 3, guildId: 'g', channelId: 'c', messageId: 'm', status: 'ACTIVE', endAt: new Date(Date.now() + 60000),
      requiredRoleId: null, requireVerified: false, minLevel: null };
    const repository = { get: vi.fn(async () => row), entryCount: vi.fn(async () => 0), draws: vi.fn(async () => []),
      entry: vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false),
      cancel: vi.fn().mockResolvedValueOnce({ ...row, status: 'CANCELLED' }).mockResolvedValueOnce(null) } as unknown as GiveawayRepository;
    const gateway = { member: vi.fn(async () => ({ bot: false, roleIds: [], createdAt: new Date(0), joinedAt: new Date(0) })),
      refresh: vi.fn(async () => {}) };
    const service = new GiveawayService(repository, { require: vi.fn(async () => {}) } as unknown as PermissionService,
      { isEnabled: vi.fn(async () => true) } as unknown as ModuleService,
      async () => gateway as never, { warn: vi.fn() } as unknown as Logger);
    expect(await service.entry('g', 3, 'u', 'enter', 'c', 'm', false)).toBe(true);
    expect(await service.entry('g', 3, 'u', 'enter', 'c', 'm', false)).toBe(false);
    const actor = { guildId: 'g', userId: 'staff', guildOwnerId: 'owner', roleIds: [] };
    expect((await service.cancel(actor, 3)).status).toBe('CANCELLED');
    await expect(service.cancel(actor, 3)).rejects.toThrow('not active');
    expect(gateway.refresh).toHaveBeenCalledTimes(2); // Entry change and cancellation.
  });
  it('never mutates the candidate array', () => {
    const ids = Object.freeze(['a', 'b', 'c']);
    expect(chooseWinners(ids as unknown as string[], 2)).toHaveLength(2);
  });
});
