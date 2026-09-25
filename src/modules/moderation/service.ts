import { AppError } from '../../core/errors/errors.js';
import type { Actor, PermissionLevel, PermissionService } from '../../core/permissions/permission-service.js';
import type { Logger } from '../../core/logger/logger.js';
import type { ModerationAction, ModerationCase, ModerationRepository } from './repository.js';

export interface ModerationGateway {
  assertCan(action: ModerationAction, targetId: string): Promise<void>;
  apply(action: ModerationAction, targetId: string, reason: string, caseId: number, durationSeconds?: number, metadata?: Record<string, string | number | boolean | null>): Promise<Record<string, string | number | boolean | null>>;
  expire(record: ModerationCase): Promise<'EXPIRED' | 'SUPERSEDED'>;
}
export type ModerationRequest = {
  actor: Actor; targetId: string; action: ModerationAction; reason: string;
  durationSeconds?: number; metadata?: Record<string, string | number | boolean | null>;
};
const minimum: Record<ModerationAction, PermissionLevel> = {
  WARN: 'MODERATOR', TIMEOUT: 'MODERATOR', KICK: 'MODERATOR', BAN: 'SENIOR_MODERATOR',
  TEMPBAN: 'SENIOR_MODERATOR', UNBAN: 'SENIOR_MODERATOR', PURGE: 'MODERATOR',
};
const snowflake = /^\d{17,20}$/;

export class ModerationService {
  private readonly applying = new Set<number>();
  constructor(private readonly repository: ModerationRepository, private readonly permissions: PermissionService,
    private readonly logger: Logger,
    private readonly notify?: (record: ModerationCase) => Promise<void>) {}

  async perform(request: ModerationRequest, gateway: ModerationGateway) {
    const { actor, action, targetId, durationSeconds } = request;
    await this.permissions.require(actor, minimum[action]);
    if (!snowflake.test(targetId) || !request.reason.trim() || request.reason.length > 400)
      throw new AppError('VALIDATION', 'Provide a valid target and reason (up to 400 characters).');
    if (action !== 'PURGE' && (targetId === actor.userId || targetId === actor.guildOwnerId))
      throw new AppError('PERMISSION', 'You cannot moderate yourself or the server owner.');
    if (action === 'TIMEOUT' && (!Number.isInteger(durationSeconds) || durationSeconds! < 60 || durationSeconds! > 28 * 86_400))
      throw new AppError('VALIDATION', 'Timeout must last from 60 seconds to 28 days.');
    if (action === 'TEMPBAN' && (!Number.isInteger(durationSeconds) || durationSeconds! < 60 || durationSeconds! > 365 * 86_400))
      throw new AppError('VALIDATION', 'Temporary ban must last from 60 seconds to one year.');
    if (!['TIMEOUT', 'TEMPBAN'].includes(action) && durationSeconds !== undefined)
      throw new AppError('VALIDATION', 'Duration is only valid for temporary actions.');
    if (action === 'PURGE' && (typeof request.metadata?.channelId !== 'string' ||
      !snowflake.test(request.metadata.channelId) || typeof request.metadata?.count !== 'number' ||
      !Number.isInteger(request.metadata.count) || request.metadata.count < 1 || request.metadata.count > 100))
      throw new AppError('VALIDATION', 'Purge requires a channel and 1–100 messages.');
    await gateway.assertCan(action, targetId);
    const expiry = durationSeconds === undefined ? null : new Date(Date.now() + durationSeconds * 1000);
    const record = await this.repository.createCase({ guildId: actor.guildId, targetId, moderatorId: actor.userId,
      action, reason: request.reason.trim(), durationSeconds: durationSeconds ?? null, expiresAt: expiry,
      metadata: request.metadata ?? {} });
    this.applying.add(record.id);
    try {
      let metadata: Record<string, string | number | boolean | null>;
      try {
        metadata = await gateway.apply(action, targetId, record.reason, record.id, durationSeconds, request.metadata);
      } catch (error) {
        if (action === 'TEMPBAN' || action === 'TIMEOUT') {
          // Discord may accept an action then lose its response: retain an expirable case.
          await this.repository.complete(record.id, 'ACTIVE', { ...record.metadata, ambiguousApiResult: true });
        } else {
          await this.repository.setStatus(record.id, 'PENDING', 'FAILED');
        }
        throw error;
      }
      // Metadata holds non-sensitive references/action results, never message contents.
      const done = await this.repository.complete(record.id, action === 'TEMPBAN' || action === 'TIMEOUT' ? 'ACTIVE' : 'COMPLETED', metadata);
      if (!done) throw new AppError('CONFLICT', 'Case state changed during action. Review the case before retrying.');
      if (this.notify) {
        try { await this.notify(done); } catch (error) { this.logger.warn({ err: error, caseId: done.id }, 'Moderation notification failed'); }
      }
      return done;
    } finally {
      this.applying.delete(record.id);
    }
  }

  async addNote(actor: Actor, targetId: string, content: string) {
    await this.permissions.require(actor, 'MODERATOR');
    if (!snowflake.test(targetId) || !content.trim() || content.length > 2000) throw new AppError('VALIDATION', 'Provide a valid target and a note up to 2000 characters.');
    return this.repository.addNote(actor.guildId, targetId, actor.userId, content.trim());
  }
  async history(actor: Actor, targetId: string) {
    await this.permissions.require(actor, 'MODERATOR');
    if (!snowflake.test(targetId)) throw new AppError('VALIDATION', 'Invalid target.');
    return this.repository.history(actor.guildId, targetId);
  }
  async notes(actor: Actor, targetId: string) {
    await this.permissions.require(actor, 'MODERATOR');
    if (!snowflake.test(targetId)) throw new AppError('VALIDATION', 'Invalid target.');
    return this.repository.notes(actor.guildId, targetId);
  }
  async getCase(actor: Actor, id: number) {
    await this.permissions.require(actor, 'MODERATOR');
    if (!Number.isSafeInteger(id) || id < 1) throw new AppError('VALIDATION', 'Invalid case ID.');
    const record = await this.repository.getCase(actor.guildId, id);
    if (!record) throw new AppError('NOT_FOUND', 'Case not found.');
    return record;
  }
  async expireDue(gatewayForGuild: (guildId: string) => Promise<ModerationGateway>) {
    const due = await this.repository.claimDue(new Date(), 20, [...this.applying]);
    for (const record of due) {
      try {
        const gateway = await gatewayForGuild(record.guildId);
        const status = await gateway.expire(record);
        await this.repository.setStatus(record.id, 'PROCESSING', status);
      } catch (error) {
        this.logger.error({ err: error, guildId: record.guildId, caseId: record.id }, 'Temporary punishment expiration failed');
        await this.repository.setStatus(record.id, 'PROCESSING', 'ACTIVE');
      }
    }
    return due.length;
  }
}
