import { AppError } from '../../core/errors/errors.js';
import type { Actor, PermissionService } from '../../core/permissions/permission-service.js';
import type { ReportRepository } from './repository.js';
import type { GuildLogNotifier } from '../../services/log-notifier.js';

const snowflake = /^\d{17,20}$/;
function validId(id: number) {
  if (!Number.isSafeInteger(id) || id < 1) throw new AppError('VALIDATION', 'Invalid record ID.');
}
function text(value: string, max: number, name: string) {
  const normalized = value.trim();
  if (!normalized || normalized.length > max) throw new AppError('VALIDATION', `${name} must contain 1–${max} characters.`);
  return normalized;
}

export class ReportService {
  constructor(private readonly repository: ReportRepository, private readonly permissions: PermissionService,
    private readonly notify?: GuildLogNotifier) {}

  private async audit(guildId: string, title: string, id: number, status: string) {
    try {
      await this.notify?.(guildId, 'moderation', title, [{ name: 'ID', value: String(id) }, { name: 'Status', value: status }]);
    } catch {
      // Audit delivery is best-effort; a persisted submission or decision must still succeed.
    }
  }

  async submitReport(actor: Actor, input: { reportedUserId?: string | null; category: string; description: string; evidenceUrl?: string | null }) {
    if (input.reportedUserId && !snowflake.test(input.reportedUserId)) throw new AppError('VALIDATION', 'Invalid reported user.');
    const evidenceUrl = input.evidenceUrl?.trim() || null;
    if (evidenceUrl) {
      let url: URL;
      try { url = new URL(evidenceUrl); } catch { throw new AppError('VALIDATION', 'Provide a valid HTTPS evidence URL.'); }
      if (url.protocol !== 'https:' || evidenceUrl.length > 2000 || url.username || url.password) throw new AppError('VALIDATION', 'Provide a valid HTTPS evidence URL.');
    }
    const record = await this.repository.submitReport({ guildId: actor.guildId, reporterId: actor.userId,
      reportedUserId: input.reportedUserId ?? null, category: text(input.category, 80, 'Category'),
      description: text(input.description, 2000, 'Description'), evidenceUrl });
    await this.audit(actor.guildId, 'Report opened', record.id, 'OPEN');
    return record;
  }
  async submitAppeal(actor: Actor, input: { caseId?: number | null; reason: string }) {
    if (input.caseId != null) validId(input.caseId);
    const record = await this.repository.submitAppeal({ guildId: actor.guildId, appellantId: actor.userId,
      caseId: input.caseId ?? null, reason: text(input.reason, 2000, 'Reason') });
    await this.audit(actor.guildId, 'Appeal opened', record.id, 'PENDING');
    return record;
  }
  async listReports(actor: Actor) {
    await this.permissions.require(actor, 'MODERATOR');
    return this.repository.listReports(actor.guildId);
  }
  async getReport(actor: Actor, id: number) {
    await this.permissions.require(actor, 'MODERATOR'); validId(id);
    const record = await this.repository.getReport(actor.guildId, id);
    if (!record) throw new AppError('NOT_FOUND', 'Report not found.');
    return record;
  }
  async closeReport(actor: Actor, id: number, note: string) {
    await this.permissions.require(actor, 'SENIOR_MODERATOR'); validId(id);
    const record = await this.repository.closeReport(actor.guildId, id, actor.userId, text(note, 1000, 'Resolution note'));
    if (!record) throw new AppError('CONFLICT', 'Report not found or already closed.');
    await this.audit(actor.guildId, 'Report closed', record.id, 'CLOSED');
    return record;
  }
  async listAppeals(actor: Actor) {
    await this.permissions.require(actor, 'MODERATOR');
    return this.repository.listAppeals(actor.guildId);
  }
  async getAppeal(actor: Actor, id: number) {
    await this.permissions.require(actor, 'MODERATOR'); validId(id);
    const record = await this.repository.getAppeal(actor.guildId, id);
    if (!record) throw new AppError('NOT_FOUND', 'Appeal not found.');
    return record;
  }
  async reviewAppeal(actor: Actor, id: number, status: 'ACCEPTED' | 'REJECTED', note: string) {
    await this.permissions.require(actor, 'SENIOR_MODERATOR'); validId(id);
    if (!['ACCEPTED', 'REJECTED'].includes(status)) throw new AppError('VALIDATION', 'Invalid decision.');
    const record = await this.repository.reviewAppeal(actor.guildId, id, actor.userId, status, text(note, 1000, 'Review note'));
    if (!record) throw new AppError('CONFLICT', 'Appeal not found or already reviewed.');
    await this.audit(actor.guildId, 'Appeal reviewed', record.id, status);
    return record;
  }
}
