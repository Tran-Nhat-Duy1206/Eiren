import type { Actor as PermissionActor } from '../../core/permissions/permission-service.js';

export type Actor = Pick<PermissionActor, 'userId' | 'guildId' | 'guildOwnerId'>;
export type RetentionDomain = 'TICKET' | 'REPORT' | 'APPEAL';
export type RetentionWindows = { ticketDays: number; reportDays: number; appealDays: number };
export type RetentionCounts = { ticket: number; report: number; appeal: number };
export type RetentionPolicyView = RetentionWindows & { enabled: boolean; version: number; confirmedBy: string | null; confirmedAt: Date | null };
export type RetentionPreviewView = RetentionWindows & { id: string; guildId: string; requestedBy: string; eligibleCounts: RetentionCounts; baseVersion: number; createdAt: Date; expiresAt: Date };
export type RetentionStatus = { policy: RetentionPolicyView; eligibleCounts: RetentionCounts; holdCounts: RetentionCounts; recentReceipts: { guildId: string; domain: RetentionDomain; recordId: number; policyVersion: number; redactedAt: Date }[] };
export type RetentionHoldView = { domain: RetentionDomain; recordId: number; retentionHold: boolean; retentionHoldBy: string | null; retentionHoldAt: Date | null };
export const DEFAULT_WINDOWS: RetentionWindows = { ticketDays: 90, reportDays: 365, appealDays: 365 };

export function validateWindows(value: RetentionWindows): void {
  for (const [name, days, min, max] of [['ticketDays', value.ticketDays, 30, 365], ['reportDays', value.reportDays, 90, 730], ['appealDays', value.appealDays, 90, 730]] as const) {
    if (!Number.isSafeInteger(days) || days < min || days > max) throw new Error(`Invalid ${name}: expected an integer between ${min} and ${max}.`);
  }
}
export function assertOwner(actor: Actor): void {
  if (!actor.guildId || !actor.userId || actor.userId !== actor.guildOwnerId) throw new Error('Only the guild owner can manage retention.');
}
export function assertRecord(domain: RetentionDomain, recordId: number): void {
  if (!['TICKET', 'REPORT', 'APPEAL'].includes(domain) || !Number.isSafeInteger(recordId) || recordId <= 0) throw new Error('Invalid retention record.');
}
