import type { Actor } from '../../core/permissions/permission-service.js';
export type { Actor };
export const STATUSES = ['PENDING','PREVIEWED','CONFIRMED','EXECUTING','COMPLETED','PARTIAL','DENIED'] as const;
export type RequestStatus = typeof STATUSES[number];
export const DENIAL_CODES = ['NO_ELIGIBLE_DATA','ACCOUNTABILITY_REQUIRED','ACTIVE_OR_UNRESOLVED_STATE','OUT_OF_SCOPE','POLICY_RETAINED'] as const;
export type DenialCode = typeof DENIAL_CODES[number];
export const CATEGORIES = ['MEMBER_LEVEL_STATE','MEMBER_REPUTATION_AGGREGATE','ACHIEVEMENT_AWARDS','TERMINAL_EVENT_PARTICIPATION','TERMINAL_EVENT_ATTENDANCE','MODERATION_ACCOUNTABILITY','REPORT_APPEAL_EVIDENCE','TICKET_ACCOUNTABILITY','VERIFICATION_ACCESS_STATE','ANTI_ABUSE_OR_REPLAY','REPUTATION_GRANT_HISTORY','SUGGESTION_HISTORY','STARBOARD_HISTORY','EVENT_CREATOR_ACCOUNTABILITY','EVENT_STAFF_ACCOUNTABILITY','ACTIVE_EVENT_STATE','UNRESOLVED_EVENT_PRESENTATION','GIVEAWAY_HISTORY','TEMPVOICE_OPERATIONAL_STATE','ANALYTICS_OPERATIONAL_STATE','GOVERNANCE_AUDIT','RETENTION_GOVERNANCE','AI_ACCOUNTING','AUTOMATION_ACCOUNTABILITY','AUTOMATION_UNCERTAIN','CONFIGURATION_ACCOUNTABILITY','OUT_OF_SCOPE','PRIVACY_GOVERNANCE'] as const;
export type Category = typeof CATEGORIES[number];
export type Disposition = 'ERASE' | 'RETAIN';
export type InventoryCount = { category: Category; disposition: Disposition; count: number };
export type InventorySummary = { counts: InventoryCount[]; eligibleTotal: number; retainedTotal: number; hash: string };
/** Internal only: never returned by dashboard/commands. Metadata whitelist, no content or credential-derived identity. */
export type InventoryEntry = { family: string; category: Category; disposition: Disposition; identity: string[]; roles: string[]; state: (string | number | boolean | null)[] };
export type InventoryContext = { requestId: string; guildId: string; subjectUserId: string; requestVersion: number };
export type SubjectRequestView = { id: string; guildId: string; subjectUserId: string; status: RequestStatus; version: number; requestedAt: string; subjectVerifiedAt: string; verificationMethod: 'SELF_GUILD_MEMBER'; previewedBy: string | null; previewedAt: string | null; confirmedBy: string | null; confirmedAt: string | null; confirmedPreviewId: string | null; executedAt: string | null; deniedBy: string | null; deniedAt: string | null; denialCode: DenialCode | null; terminalAt: string | null };
export type PreviewView = InventorySummary & { id: string; requestId: string; guildId: string; subjectUserId: string; reviewedBy: string; requestVersion: number; createdAt: string; expiresAt: string; consumedAt: string | null };
export type DeletedCounts = { memberLevels: number; memberReputation: number; achievements: number; eventParticipants: number; eventAttendance: number };
export type ReceiptView = { requestId: string; guildId: string; subjectUserId: string; confirmedBy: string; executedBy: string; inventoryHash: string; executedAt: string; outcome: 'COMPLETED' | 'PARTIAL'; requestVersion: number; deleted: DeletedCounts; retainedTotal: number };
export const GOVERNANCE_ACTIONS = ['privacy-preview','privacy-confirm','privacy-execute','privacy-deny','retention-confirm','retention-disable','retention-hold-set','retention-hold-clear'] as const;
export type GovernanceAction = typeof GOVERNANCE_ACTIONS[number];
export type AuditGapInput = { guildId: string; actorUserId: string; action: GovernanceAction; targetType: string; targetId?: string; requestId: string };
export type AuditGapView = { id: string; actorUserId: string; action: GovernanceAction; targetType: string; targetId: string | null; committedAt: string; detectedAt: string };
export const SCOPE_WARNING = 'This reviewed request concerns Eiren-controlled PostgreSQL data for this guild only, not universal deletion. Discord messages, copies and assigned roles, screenshots, exports, downloaded files and historical backups may remain. Future activity can create new Eiren data again.';
export const WORKFLOW_EVIDENCE_WARNING = 'This request’s own identity, verification, previews, receipt and exactly correlated governance audits remain retained separately for their metadata lifecycle (terminal request/receipt/gap: 730 days). They are excluded only from this request’s primary-data inventory digest and COMPLETED/PARTIAL calculation. Other governance history remains inventoried and retained.';
/** Only the authenticated guild interaction is accepted: there is deliberately no subject-ID argument. */
export type SelfInteraction = { inGuild(): boolean; guildId: string | null; user: { id: string }; guild: { id: string; members: { fetch(options: { user: string; force: true }): Promise<{ id: string; guild: { id: string } }> } } | null };
