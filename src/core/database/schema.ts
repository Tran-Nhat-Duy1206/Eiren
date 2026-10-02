import { bigint, boolean, check, date, foreignKey, index, integer, jsonb, pgTable, primaryKey, bigserial, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const guilds = pgTable('guilds', {
  id: text('id').primaryKey(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const guildSettings = pgTable('guild_settings', {
  guildId: text('guild_id').primaryKey().references(() => guilds.id, { onDelete: 'cascade' }),
  language: text('language').notNull().default('en'),
  timezone: text('timezone').notNull().default('UTC'),
  logChannelId: text('log_channel_id'),
  modLogChannelId: text('mod_log_channel_id'),
  securityLogChannelId: text('security_log_channel_id'),
  welcomeChannelId: text('welcome_channel_id'),
  ticketCategoryId: text('ticket_category_id'),
  verifiedRoleId: text('verified_role_id'),
  quarantineRoleId: text('quarantine_role_id'),
  setupCompletedAt: timestamp('setup_completed_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const guildModules = pgTable('guild_modules', {
  guildId: text('guild_id').notNull().references(() => guilds.id, { onDelete: 'cascade' }),
  moduleKey: text('module_key').notNull(),
  enabled: boolean('enabled').notNull(),
  updatedBy: text('updated_by').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  // Monotonic epoch separates rapid disable/re-enable transitions even within one millisecond.
  version: integer('version').notNull().default(0),
  // The analytics row serializes gateway observations and pre-snapshot boundaries.
  voiceSequence: bigint('voice_sequence', { mode: 'number' }).notNull().default(0),
}, table => [primaryKey({ columns: [table.guildId, table.moduleKey] })]);

export const guildPermissionRoles = pgTable('guild_permission_roles', {
  guildId: text('guild_id').notNull().references(() => guilds.id, { onDelete: 'cascade' }),
  roleId: text('role_id').notNull(),
  level: text('level').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [primaryKey({ columns: [table.guildId, table.roleId] })]);

// Only V1 moderation data. Discord identifiers are always text; the numeric case ID is bot-owned.
export const moderationCases = pgTable('moderation_cases', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  guildId: text('guild_id').notNull().references(() => guilds.id, { onDelete: 'cascade' }),
  targetId: text('target_id').notNull(),
  moderatorId: text('moderator_id').notNull(),
  action: text('action').notNull(),
  reason: text('reason').notNull(),
  durationSeconds: integer('duration_seconds'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  status: text('status').notNull().default('PENDING'),
  claimedAt: timestamp('claimed_at', { withTimezone: true }),
  metadata: jsonb('metadata').$type<Record<string, string | number | boolean | null>>().notNull().default({}),
}, table => [
  index('moderation_cases_guild_target_created_idx').on(table.guildId, table.targetId, table.createdAt),
  index('moderation_cases_guild_created_v6_idx').on(table.guildId, table.createdAt),
  index('moderation_cases_due_idx').on(table.status, table.expiresAt),
  check('moderation_cases_action_check', sql`${table.action} IN ('WARN','TIMEOUT','KICK','BAN','TEMPBAN','UNBAN','PURGE')`),
  check('moderation_cases_status_check', sql`${table.status} IN ('PENDING','ACTIVE','COMPLETED','PROCESSING','EXPIRED','SUPERSEDED','FAILED')`),
  check('moderation_cases_duration_check', sql`${table.durationSeconds} IS NULL OR ${table.durationSeconds} > 0`),
  check('moderation_cases_expiry_check', sql`${table.action} NOT IN ('TEMPBAN','TIMEOUT') OR (${table.expiresAt} IS NOT NULL AND ${table.durationSeconds} IS NOT NULL)`),
]);

// V2 verification. Discord identifiers are text; state is always reloaded from PostgreSQL.
export const verificationSettings = pgTable('verification_settings', {
  guildId: text('guild_id').primaryKey().references(() => guilds.id, { onDelete: 'cascade' }),
  enabled: boolean('enabled').notNull().default(false),
  mode: text('mode').notNull().default('BUTTON'),
  verificationChannelId: text('verification_channel_id'),
  verifiedRoleId: text('verified_role_id'),
  quarantineRoleId: text('quarantine_role_id'),
  minAccountAgeSeconds: integer('min_account_age_seconds'),
  requireRulesAck: boolean('require_rules_ack').notNull().default(false),
  panelMessageId: text('panel_message_id'),
  updatedBy: text('updated_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  check('verification_settings_mode_check', sql`${table.mode} IN ('BUTTON','MANUAL','BUTTON_AND_ACCOUNT_AGE')`),
  check('verification_settings_min_age_check', sql`${table.minAccountAgeSeconds} IS NULL OR ${table.minAccountAgeSeconds} > 0`),
]);

export const memberVerifications = pgTable('member_verifications', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  guildId: text('guild_id').notNull().references(() => guilds.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull(),
  status: text('status').notNull().default('PENDING'),
  method: text('method'),
  reason: text('reason'),
  accountCreatedAt: timestamp('account_created_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  verifiedAt: timestamp('verified_at', { withTimezone: true }),
  verifiedBy: text('verified_by'),
  rejectedAt: timestamp('rejected_at', { withTimezone: true }),
  rejectedBy: text('rejected_by'),
  rulesAcknowledgedAt: timestamp('rules_acknowledged_at', { withTimezone: true }),
  metadata: jsonb('metadata').$type<Record<string, string | number | boolean | null>>().notNull().default({}),
}, table => [
  uniqueIndex('member_verifications_guild_user_unique').on(table.guildId, table.userId),
  index('member_verifications_guild_status_idx').on(table.guildId, table.status),
  check('member_verifications_status_check', sql`${table.status} IN ('PENDING','VERIFIED','REJECTED','BYPASSED')`),
  check('member_verifications_method_check', sql`${table.method} IS NULL OR ${table.method} IN ('BUTTON','MANUAL','AUTO')`),
]);

// V2 anti-raid. Signals are stored as short labels, never message content.
export const antiraidSettings = pgTable('antiraid_settings', {
  guildId: text('guild_id').primaryKey().references(() => guilds.id, { onDelete: 'cascade' }),
  enabled: boolean('enabled').notNull().default(false),
  joinWindowSeconds: integer('join_window_seconds').notNull().default(60),
  joinThreshold: integer('join_threshold').notNull().default(5),
  youngAccountAgeSeconds: integer('young_account_age_seconds').notNull().default(604800),
  youngAccountWeight: integer('young_account_weight').notNull().default(25),
  messageSpamThreshold: integer('message_spam_threshold').notNull().default(10),
  messageSpamWindowSeconds: integer('message_spam_window_seconds').notNull().default(30),
  mentionThreshold: integer('mention_threshold').notNull().default(5),
  autoQuarantine: boolean('auto_quarantine').notNull().default(true),
  alertChannelId: text('alert_channel_id'),
  emergencyMode: boolean('emergency_mode').notNull().default(false),
  emergencyActivatedAt: timestamp('emergency_activated_at', { withTimezone: true }),
  emergencyReason: text('emergency_reason'),
  emergencyActorId: text('emergency_actor_id'),
  emergencyJoinCount: integer('emergency_join_count'),
  emergencyWindowSeconds: integer('emergency_window_seconds'),
  updatedBy: text('updated_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  check('antiraid_settings_window_check', sql`${table.joinWindowSeconds} > 0 AND ${table.messageSpamWindowSeconds} > 0`),
  check('antiraid_settings_threshold_check', sql`${table.joinThreshold} > 0 AND ${table.messageSpamThreshold} > 0`),
  check('antiraid_settings_age_check', sql`${table.youngAccountAgeSeconds} >= 0 AND ${table.youngAccountWeight} >= 0 AND ${table.mentionThreshold} >= 0`),
]);

export const joinHistory = pgTable('join_history', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  guildId: text('guild_id').notNull().references(() => guilds.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull(),
  joinedAt: timestamp('joined_at', { withTimezone: true }).notNull(),
  accountCreatedAt: timestamp('account_created_at', { withTimezone: true }),
  accountAgeSeconds: integer('account_age_seconds'),
  verificationStatus: text('verification_status'),
  riskScore: integer('risk_score').notNull().default(0),
  signals: jsonb('signals').$type<string[]>().notNull().default([]),
}, table => [
  uniqueIndex('join_history_guild_user_joined_unique').on(table.guildId, table.userId, table.joinedAt),
  index('join_history_guild_joined_idx').on(table.guildId, table.joinedAt),
  check('join_history_risk_score_check', sql`${table.riskScore} >= 0`),
]);

export const moderatorNotes = pgTable('moderator_notes', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  guildId: text('guild_id').notNull().references(() => guilds.id, { onDelete: 'cascade' }),
  targetId: text('target_id').notNull(),
  moderatorId: text('moderator_id').notNull(),
  content: text('content').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  index('moderator_notes_guild_target_created_idx').on(table.guildId, table.targetId, table.createdAt),
  check('moderator_notes_content_check', sql`length(trim(${table.content})) > 0`),
]);

// V3 community workflows. Discord IDs remain text; numeric IDs belong to the bot.
export const roleMenus = pgTable('role_menus', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  guildId: text('guild_id').notNull().references(() => guilds.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  kind: text('kind').notNull().default('BUTTON'),
  exclusive: boolean('exclusive').notNull().default(false),
  maxValues: integer('max_values').notNull().default(1),
  enabled: boolean('enabled').notNull().default(true),
  channelId: text('channel_id'),
  messageId: text('message_id'),
  createdBy: text('created_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  index('role_menus_guild_idx').on(table.guildId),
  uniqueIndex('role_menus_guild_message_unique').on(table.guildId, table.messageId),
  check('role_menus_kind_check', sql`${table.kind} IN ('BUTTON','SELECT')`),
  check('role_menus_max_check', sql`${table.maxValues} BETWEEN 1 AND 25`),
]);

export const roleMenuOptions = pgTable('role_menu_options', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  menuId: bigint('menu_id', { mode: 'number' }).notNull().references(() => roleMenus.id, { onDelete: 'cascade' }),
  roleId: text('role_id').notNull(),
  label: text('label').notNull(),
  description: text('description'),
  requiredRoleId: text('required_role_id'),
  forbiddenRoleId: text('forbidden_role_id'),
  position: integer('position').notNull().default(0),
}, table => [
  uniqueIndex('role_menu_options_menu_role_unique').on(table.menuId, table.roleId),
  index('role_menu_options_menu_position_idx').on(table.menuId, table.position),
]);

export const ticketSettings = pgTable('ticket_settings', {
  guildId: text('guild_id').primaryKey().references(() => guilds.id, { onDelete: 'cascade' }),
  staffRoleId: text('staff_role_id'),
  transcriptChannelId: text('transcript_channel_id'),
  maxActiveTickets: integer('max_active_tickets').notNull().default(1),
}, table => [check('ticket_settings_max_active_check', sql`${table.maxActiveTickets} BETWEEN 1 AND 10`)]);

// V8.2 private-content lifecycle is opt-in and never changes existing payloads on migration.
export const retentionPolicies = pgTable('retention_policies', {
  guildId: text('guild_id').primaryKey().references(() => guilds.id, { onDelete: 'cascade' }),
  enabled: boolean('enabled').notNull().default(false),
  ticketRetentionDays: integer('ticket_retention_days').notNull().default(90),
  reportRetentionDays: integer('report_retention_days').notNull().default(365),
  appealRetentionDays: integer('appeal_retention_days').notNull().default(365),
  version: integer('version').notNull().default(0),
  confirmedBy: text('confirmed_by'),
  confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  index('retention_policies_enabled_idx').on(table.guildId).where(sql`${table.enabled}`),
  check('retention_policies_days_check', sql`${table.ticketRetentionDays} BETWEEN 30 AND 365 AND ${table.reportRetentionDays} BETWEEN 90 AND 730 AND ${table.appealRetentionDays} BETWEEN 90 AND 730`),
  check('retention_policies_version_check', sql`${table.version} >= 0`),
  check('retention_policies_confirmation_check', sql`(${table.confirmedBy} IS NULL) = (${table.confirmedAt} IS NULL) AND (NOT ${table.enabled} OR ${table.confirmedBy} IS NOT NULL)`),
]);

export const retentionPreviews = pgTable('retention_previews', {
  id: uuid('id').primaryKey(),
  guildId: text('guild_id').notNull().references(() => guilds.id, { onDelete: 'cascade' }),
  requestedBy: text('requested_by').notNull(),
  ticketDays: integer('ticket_days').notNull(),
  reportDays: integer('report_days').notNull(),
  appealDays: integer('appeal_days').notNull(),
  eligibleTicketCount: integer('eligible_ticket_count').notNull(),
  eligibleReportCount: integer('eligible_report_count').notNull(),
  eligibleAppealCount: integer('eligible_appeal_count').notNull(),
  baseVersion: integer('base_version').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
}, table => [
  index('retention_previews_expiry_idx').on(table.expiresAt),
  index('retention_previews_consumed_idx').on(table.consumedAt).where(sql`${table.consumedAt} IS NOT NULL`),
  check('retention_previews_days_check', sql`${table.ticketDays} BETWEEN 30 AND 365 AND ${table.reportDays} BETWEEN 90 AND 730 AND ${table.appealDays} BETWEEN 90 AND 730`),
  check('retention_previews_counts_check', sql`${table.eligibleTicketCount} >= 0 AND ${table.eligibleReportCount} >= 0 AND ${table.eligibleAppealCount} >= 0`),
  check('retention_previews_version_check', sql`${table.baseVersion} >= 0`),
  check('retention_previews_expiry_check', sql`${table.expiresAt} > ${table.createdAt} AND (${table.consumedAt} IS NULL OR ${table.consumedAt} >= ${table.createdAt})`),
]);

// Receipts contain only identifiers and policy authorization metadata, never private narratives.
export const retentionReceipts = pgTable('retention_receipts', {
  guildId: text('guild_id').notNull().references(() => guilds.id, { onDelete: 'cascade' }),
  domain: text('domain').notNull(),
  recordId: bigint('record_id', { mode: 'number' }).notNull(),
  policyVersion: integer('policy_version').notNull(),
  policyAuthorizerId: text('policy_authorizer_id').notNull(),
  redactedAt: timestamp('redacted_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  uniqueIndex('retention_receipts_record_unique').on(table.guildId, table.domain, table.recordId),
  index('retention_receipts_expiry_idx').on(table.redactedAt),
  check('retention_receipts_domain_check', sql`${table.domain} IN ('TICKET','REPORT','APPEAL')`),
  check('retention_receipts_version_check', sql`${table.policyVersion} >= 0`),
]);

export const tickets = pgTable('tickets', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  guildId: text('guild_id').notNull().references(() => guilds.id, { onDelete: 'cascade' }),
  creatorId: text('creator_id').notNull(),
  type: text('type').notNull(),
  channelId: text('channel_id'),
  assignedStaffId: text('assigned_staff_id'),
  status: text('status').notNull().default('OPEN'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  claimedAt: timestamp('claimed_at', { withTimezone: true }),
  closedAt: timestamp('closed_at', { withTimezone: true }),
  closedBy: text('closed_by'),
  closeReason: text('close_reason'),
  transcript: text('transcript'),
  transcriptGeneratedAt: timestamp('transcript_generated_at', { withTimezone: true }),
  transcriptRedactedAt: timestamp('transcript_redacted_at', { withTimezone: true }),
  transcriptRetentionPolicyVersion: integer('transcript_retention_policy_version'),
  retentionHold: boolean('retention_hold').notNull().default(false),
  retentionHoldBy: text('retention_hold_by'),
  retentionHoldAt: timestamp('retention_hold_at', { withTimezone: true }),
}, table => [
  index('tickets_retention_eligible_idx').on(table.guildId, table.closedAt).where(sql`${table.status} = 'CLOSED' AND ${table.transcript} IS NOT NULL AND ${table.transcriptRedactedAt} IS NULL AND NOT ${table.retentionHold}`),
  check('tickets_retention_hold_check', sql`(NOT ${table.retentionHold} AND ${table.retentionHoldBy} IS NULL AND ${table.retentionHoldAt} IS NULL) OR (${table.retentionHold} AND ${table.retentionHoldBy} IS NOT NULL AND ${table.retentionHoldAt} IS NOT NULL)`),
  check('tickets_retention_redaction_check', sql`(${table.transcriptRedactedAt} IS NULL AND ${table.transcriptRetentionPolicyVersion} IS NULL) OR (${table.transcriptRedactedAt} IS NOT NULL AND ${table.transcriptRetentionPolicyVersion} >= 0 AND ${table.transcript} IS NULL)`),
  check('tickets_retention_redacted_version_check', sql`${table.transcriptRedactedAt} IS NULL OR ${table.transcriptRetentionPolicyVersion} IS NOT NULL`),
  check('tickets_retention_redacted_hold_check', sql`${table.transcriptRedactedAt} IS NULL OR NOT ${table.retentionHold}`),
  index('tickets_guild_creator_status_idx').on(table.guildId, table.creatorId, table.status),
  index('tickets_guild_created_v6_idx').on(table.guildId, table.createdAt),
  index('tickets_guild_closed_v6_idx').on(table.guildId, table.closedAt),
  uniqueIndex('tickets_guild_channel_unique').on(table.guildId, table.channelId),
  check('tickets_type_check', sql`${table.type} IN ('SUPPORT','REPORT','APPEAL','PARTNERSHIP','BUG_REPORT','OTHER')`),
  check('tickets_status_check', sql`${table.status} IN ('OPEN','CLAIMED','CLOSED')`),
]);

export const ticketParticipants = pgTable('ticket_participants', {
  ticketId: bigint('ticket_id', { mode: 'number' }).notNull().references(() => tickets.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull(),
  addedBy: text('added_by').notNull(),
  addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [primaryKey({ columns: [table.ticketId, table.userId] })]);

export const reports = pgTable('reports', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  guildId: text('guild_id').notNull().references(() => guilds.id, { onDelete: 'cascade' }),
  reporterId: text('reporter_id').notNull(),
  reportedUserId: text('reported_user_id'),
  category: text('category').notNull(),
  description: text('description'),
  evidenceUrl: text('evidence_url'),
  narrativeRedactedAt: timestamp('narrative_redacted_at', { withTimezone: true }),
  narrativeRetentionPolicyVersion: integer('narrative_retention_policy_version'),
  retentionHold: boolean('retention_hold').notNull().default(false),
  retentionHoldBy: text('retention_hold_by'),
  retentionHoldAt: timestamp('retention_hold_at', { withTimezone: true }),
  status: text('status').notNull().default('OPEN'),
  assignedStaffId: text('assigned_staff_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  closedAt: timestamp('closed_at', { withTimezone: true }),
  closedBy: text('closed_by'),
  resolutionNote: text('resolution_note'),
}, table => [
  index('reports_retention_eligible_idx').on(table.guildId, table.closedAt).where(sql`${table.status} = 'CLOSED' AND ${table.description} IS NOT NULL AND ${table.narrativeRedactedAt} IS NULL AND NOT ${table.retentionHold}`),
  check('reports_retention_hold_check', sql`(NOT ${table.retentionHold} AND ${table.retentionHoldBy} IS NULL AND ${table.retentionHoldAt} IS NULL) OR (${table.retentionHold} AND ${table.retentionHoldBy} IS NOT NULL AND ${table.retentionHoldAt} IS NOT NULL)`),
  check('reports_retention_narrative_check', sql`(${table.narrativeRedactedAt} IS NULL AND ${table.narrativeRetentionPolicyVersion} IS NULL AND ${table.description} IS NOT NULL) OR (${table.narrativeRedactedAt} IS NOT NULL AND ${table.narrativeRetentionPolicyVersion} >= 0 AND ${table.description} IS NULL)`),
  check('reports_retention_redacted_payload_check', sql`${table.narrativeRedactedAt} IS NULL OR (${table.evidenceUrl} IS NULL AND ${table.resolutionNote} IS NULL)`),
  check('reports_retention_redacted_version_check', sql`${table.narrativeRedactedAt} IS NULL OR ${table.narrativeRetentionPolicyVersion} IS NOT NULL`),
  check('reports_retention_redacted_hold_check', sql`${table.narrativeRedactedAt} IS NULL OR NOT ${table.retentionHold}`),
  index('reports_guild_status_created_idx').on(table.guildId, table.status, table.createdAt),
  index('reports_reporter_created_idx').on(table.guildId, table.reporterId, table.createdAt),
  check('reports_status_check', sql`${table.status} IN ('OPEN','UNDER_REVIEW','CLOSED')`),
]);

export const appeals = pgTable('appeals', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  guildId: text('guild_id').notNull().references(() => guilds.id, { onDelete: 'cascade' }),
  appellantId: text('appellant_id').notNull(),
  caseId: bigint('case_id', { mode: 'number' }).references(() => moderationCases.id, { onDelete: 'set null' }),
  reason: text('reason'),
  narrativeRedactedAt: timestamp('narrative_redacted_at', { withTimezone: true }),
  narrativeRetentionPolicyVersion: integer('narrative_retention_policy_version'),
  retentionHold: boolean('retention_hold').notNull().default(false),
  retentionHoldBy: text('retention_hold_by'),
  retentionHoldAt: timestamp('retention_hold_at', { withTimezone: true }),
  status: text('status').notNull().default('PENDING'),
  reviewerId: text('reviewer_id'),
  reviewNote: text('review_note'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
}, table => [
  index('appeals_retention_eligible_idx').on(table.guildId, table.reviewedAt).where(sql`${table.status} IN ('ACCEPTED','REJECTED') AND ${table.reason} IS NOT NULL AND ${table.narrativeRedactedAt} IS NULL AND NOT ${table.retentionHold}`),
  check('appeals_retention_hold_check', sql`(NOT ${table.retentionHold} AND ${table.retentionHoldBy} IS NULL AND ${table.retentionHoldAt} IS NULL) OR (${table.retentionHold} AND ${table.retentionHoldBy} IS NOT NULL AND ${table.retentionHoldAt} IS NOT NULL)`),
  check('appeals_retention_narrative_check', sql`(${table.narrativeRedactedAt} IS NULL AND ${table.narrativeRetentionPolicyVersion} IS NULL AND ${table.reason} IS NOT NULL) OR (${table.narrativeRedactedAt} IS NOT NULL AND ${table.narrativeRetentionPolicyVersion} >= 0 AND ${table.reason} IS NULL)`),
  check('appeals_retention_redacted_payload_check', sql`${table.narrativeRedactedAt} IS NULL OR ${table.reviewNote} IS NULL`),
  check('appeals_retention_redacted_version_check', sql`${table.narrativeRedactedAt} IS NULL OR ${table.narrativeRetentionPolicyVersion} IS NOT NULL`),
  check('appeals_retention_redacted_hold_check', sql`${table.narrativeRedactedAt} IS NULL OR NOT ${table.retentionHold}`),
  index('appeals_guild_status_created_idx').on(table.guildId, table.status, table.createdAt),
  index('appeals_appellant_created_idx').on(table.guildId, table.appellantId, table.createdAt),
  uniqueIndex('appeals_pending_case_unique').on(table.guildId, table.appellantId, table.caseId)
    .where(sql`${table.status} = 'PENDING' AND ${table.caseId} IS NOT NULL`),
  check('appeals_status_check', sql`${table.status} IN ('PENDING','ACCEPTED','REJECTED')`),
]);

export const suggestionSettings = pgTable('suggestion_settings', {
  guildId: text('guild_id').primaryKey().references(() => guilds.id, { onDelete: 'cascade' }),
  channelId: text('channel_id'),
});

export const suggestions = pgTable('suggestions', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  guildId: text('guild_id').notNull().references(() => guilds.id, { onDelete: 'cascade' }),
  authorId: text('author_id').notNull(),
  content: text('content').notNull(),
  status: text('status').notNull().default('PENDING'),
  channelId: text('channel_id'),
  messageId: text('message_id'),
  staffResponse: text('staff_response'),
  reviewedBy: text('reviewed_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  index('suggestions_guild_status_created_idx').on(table.guildId, table.status, table.createdAt),
  index('suggestions_guild_created_v6_idx').on(table.guildId, table.createdAt),
  uniqueIndex('suggestions_guild_message_unique').on(table.guildId, table.messageId),
  check('suggestions_status_check', sql`${table.status} IN ('PENDING','UNDER_REVIEW','ACCEPTED','REJECTED','IMPLEMENTED')`),
]);

export const suggestionVotes = pgTable('suggestion_votes', {
  suggestionId: bigint('suggestion_id', { mode: 'number' }).notNull().references(() => suggestions.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull(),
  vote: integer('vote').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  primaryKey({ columns: [table.suggestionId, table.userId] }),
  check('suggestion_votes_value_check', sql`${table.vote} IN (-1, 1)`),
]);

// V4 social features. Aggregates are guild-scoped; no full message content is stored.
export const levelsSettings = pgTable('levels_settings', {
  guildId: text('guild_id').primaryKey().references(() => guilds.id, { onDelete: 'cascade' }),
  cooldownSeconds: integer('cooldown_seconds').notNull().default(60),
  xpPerMessage: integer('xp_per_message').notNull().default(10),
  minLength: integer('min_length').notNull().default(12),
  levelUpChannelId: text('level_up_channel_id'),
}, table => [
  check('levels_settings_cooldown_check', sql`${table.cooldownSeconds} BETWEEN 5 AND 3600`),
  check('levels_settings_xp_check', sql`${table.xpPerMessage} BETWEEN 1 AND 100`),
  check('levels_settings_min_length_check', sql`${table.minLength} BETWEEN 0 AND 1000`),
]);

export const memberLevels = pgTable('member_levels', {
  guildId: text('guild_id').notNull().references(() => guilds.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull(),
  xp: bigint('xp', { mode: 'number' }).notNull().default(0),
  messageCount: integer('message_count').notNull().default(0),
  lastXpAt: timestamp('last_xp_at', { withTimezone: true }),
  lastMessageId: text('last_message_id'),
  lastFingerprint: text('last_fingerprint'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  primaryKey({ columns: [table.guildId, table.userId] }),
  index('member_levels_leaderboard_idx').on(table.guildId, table.xp.desc(), table.userId),
  check('member_levels_xp_check', sql`${table.xp} >= 0`),
  check('member_levels_message_count_check', sql`${table.messageCount} >= 0`),
]);

export const levelRewards = pgTable('level_rewards', {
  guildId: text('guild_id').notNull().references(() => guilds.id, { onDelete: 'cascade' }),
  level: integer('level').notNull(),
  roleId: text('role_id').notNull(),
}, table => [
  primaryKey({ columns: [table.guildId, table.level, table.roleId] }),
  check('level_rewards_level_check', sql`${table.level} BETWEEN 1 AND 10000`),
]);

export const levelIgnoredChannels = pgTable('level_ignored_channels', {
  guildId: text('guild_id').notNull().references(() => guilds.id, { onDelete: 'cascade' }),
  channelId: text('channel_id').notNull(),
}, table => [primaryKey({ columns: [table.guildId, table.channelId] })]);

export const reputationSettings = pgTable('reputation_settings', {
  guildId: text('guild_id').primaryKey().references(() => guilds.id, { onDelete: 'cascade' }),
  globalCooldownSeconds: integer('global_cooldown_seconds').notNull().default(86400),
  sameTargetCooldownSeconds: integer('same_target_cooldown_seconds').notNull().default(604800),
}, table => [
  check('reputation_global_cooldown_check', sql`${table.globalCooldownSeconds} BETWEEN 60 AND 604800`),
  check('reputation_target_cooldown_check', sql`${table.sameTargetCooldownSeconds} BETWEEN ${table.globalCooldownSeconds} AND 2592000`),
]);

export const memberReputation = pgTable('member_reputation', {
  guildId: text('guild_id').notNull().references(() => guilds.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull(),
  score: integer('score').notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  primaryKey({ columns: [table.guildId, table.userId] }),
  index('member_reputation_guild_score_idx').on(table.guildId, table.score.desc(), table.userId),
  check('member_reputation_score_check', sql`${table.score} >= 0`),
]);

export const reputationGrants = pgTable('reputation_grants', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  guildId: text('guild_id').notNull().references(() => guilds.id, { onDelete: 'cascade' }),
  giverId: text('giver_id').notNull(),
  receiverId: text('receiver_id').notNull(),
  interactionId: text('interaction_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  uniqueIndex('reputation_grants_guild_interaction_unique').on(table.guildId, table.interactionId),
  index('reputation_grants_giver_recent_idx').on(table.guildId, table.giverId, table.createdAt.desc()),
  index('reputation_grants_target_recent_idx').on(table.guildId, table.giverId, table.receiverId, table.createdAt.desc()),
  index('reputation_grants_receiver_idx').on(table.guildId, table.receiverId),
  check('reputation_grants_no_self_check', sql`${table.giverId} <> ${table.receiverId}`),
]);

export const starboardSettings = pgTable('starboard_settings', {
  guildId: text('guild_id').primaryKey().references(() => guilds.id, { onDelete: 'cascade' }),
  enabled: boolean('enabled').notNull().default(false),
  channelId: text('channel_id'),
  emoji: text('emoji').notNull().default('⭐'),
  threshold: integer('threshold').notNull().default(5),
  allowSelf: boolean('allow_self').notNull().default(false),
  allowBotMessages: boolean('allow_bot_messages').notNull().default(false),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  check('starboard_settings_threshold_check', sql`${table.threshold} BETWEEN 1 AND 25`),
  check('starboard_settings_emoji_check', sql`length(trim(${table.emoji})) BETWEEN 1 AND 100`),
]);

export const starboardIgnoredChannels = pgTable('starboard_ignored_channels', {
  guildId: text('guild_id').notNull().references(() => guilds.id, { onDelete: 'cascade' }),
  channelId: text('channel_id').notNull(),
}, table => [primaryKey({ columns: [table.guildId, table.channelId] })]);

export const starboardMessages = pgTable('starboard_messages', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  guildId: text('guild_id').notNull().references(() => guilds.id, { onDelete: 'cascade' }),
  sourceChannelId: text('source_channel_id').notNull(),
  sourceMessageId: text('source_message_id').notNull(),
  sourceAuthorId: text('source_author_id').notNull(),
  starboardChannelId: text('starboard_channel_id'),
  starboardMessageId: text('starboard_message_id'),
  starCount: integer('star_count').notNull().default(0),
  status: text('status').notNull().default('PENDING'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  uniqueIndex('starboard_messages_source_unique').on(table.guildId, table.sourceMessageId),
  uniqueIndex('starboard_messages_post_unique').on(table.guildId, table.starboardMessageId),
  index('starboard_messages_guild_status_idx').on(table.guildId, table.status),
  check('starboard_messages_status_check', sql`${table.status} IN ('PENDING','POSTED','REMOVED','DELETED')`),
  check('starboard_messages_count_check', sql`${table.starCount} >= 0`),
]);

// V5 optional community events. All scheduled times are absolute timestamptz values.
export const communityEvents = pgTable('community_events', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  guildId: text('guild_id').notNull().references(() => guilds.id, { onDelete: 'cascade' }),
  creatorId: text('creator_id').notNull(),
  title: text('title').notNull(),
  description: text('description').notNull(),
  startAt: timestamp('start_at', { withTimezone: true }).notNull(),
  endAt: timestamp('end_at', { withTimezone: true }),
  channelId: text('channel_id').notNull(),
  announcementMessageId: text('announcement_message_id'),
  presentationPending: boolean('presentation_pending').notNull().default(true),
  presentationRetryAt: timestamp('presentation_retry_at', { withTimezone: true }),
  maxParticipants: integer('max_participants'),
  status: text('status').notNull().default('SCHEDULED'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  index('community_events_guild_start_idx').on(table.guildId, table.startAt),
  index('community_events_guild_created_v6_idx').on(table.guildId, table.createdAt),
  index('community_events_due_idx').on(table.status, table.startAt, table.endAt),
  index('community_events_presentation_due_idx').on(table.presentationPending, table.presentationRetryAt),
  check('community_events_status_check', sql`${table.status} IN ('SCHEDULED','ACTIVE','COMPLETED','CANCELLED')`),
  check('community_events_time_check', sql`${table.endAt} IS NULL OR ${table.endAt} > ${table.startAt}`),
  check('community_events_capacity_check', sql`${table.maxParticipants} IS NULL OR ${table.maxParticipants} BETWEEN 1 AND 10000`),
  check('community_events_title_check', sql`length(trim(${table.title})) BETWEEN 1 AND 256`),
  check('community_events_description_check', sql`length(${table.description}) <= 2000`),
]);

export const eventParticipants = pgTable('event_participants', {
  eventId: bigint('event_id', { mode: 'number' }).notNull().references(() => communityEvents.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull(),
  joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [primaryKey({ columns: [table.eventId, table.userId] })]);

// Confirmed attendance is distinct from RSVP and only staff/organizer may record it.
export const eventAttendance = pgTable('event_attendance', {
  eventId: bigint('event_id', { mode: 'number' }).notNull().references(() => communityEvents.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull(),
  markedBy: text('marked_by').notNull(),
  markedAt: timestamp('marked_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [primaryKey({ columns: [table.eventId, table.userId] })]);

export const eventReminders = pgTable('event_reminders', {
  eventId: bigint('event_id', { mode: 'number' }).notNull().references(() => communityEvents.id, { onDelete: 'cascade' }),
  offsetSeconds: integer('offset_seconds').notNull(),
  status: text('status').notNull().default('PENDING'),
  claimedAt: timestamp('claimed_at', { withTimezone: true }),
  deliveredAt: timestamp('delivered_at', { withTimezone: true }),
  messageId: text('message_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  primaryKey({ columns: [table.eventId, table.offsetSeconds] }),
  index('event_reminders_status_claim_idx').on(table.status, table.claimedAt),
  check('event_reminders_offset_check', sql`${table.offsetSeconds} IN (600,3600,86400)`),
  check('event_reminders_status_check', sql`${table.status} IN ('PENDING','PROCESSING','DELIVERED','CANCELLED')`),
]);

// V5 giveaways. Entrants, draws and historical winners are authoritative, not Discord reactions.
export const giveaways = pgTable('giveaways', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  guildId: text('guild_id').notNull().references(() => guilds.id, { onDelete: 'cascade' }),
  creatorId: text('creator_id').notNull(),
  channelId: text('channel_id').notNull(),
  messageId: text('message_id'),
  prize: text('prize').notNull(),
  startAt: timestamp('start_at', { withTimezone: true }).notNull().defaultNow(),
  endAt: timestamp('end_at', { withTimezone: true }).notNull(),
  winnerCount: integer('winner_count').notNull(),
  status: text('status').notNull().default('ACTIVE'),
  requiredRoleId: text('required_role_id'),
  minAccountAgeSeconds: integer('min_account_age_seconds'),
  minGuildAgeSeconds: integer('min_guild_age_seconds'),
  requireVerified: boolean('require_verified').notNull().default(false),
  minLevel: integer('min_level'),
  resultAnnouncementId: text('result_announcement_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  index('giveaways_guild_status_idx').on(table.guildId, table.status),
  index('giveaways_guild_created_v6_idx').on(table.guildId, table.createdAt),
  index('giveaways_due_idx').on(table.status, table.endAt),
  check('giveaways_prize_check', sql`length(trim(${table.prize})) BETWEEN 1 AND 256`),
  check('giveaways_time_check', sql`${table.endAt} > ${table.startAt}`),
  check('giveaways_winners_check', sql`${table.winnerCount} BETWEEN 1 AND 20`),
  check('giveaways_status_check', sql`${table.status} IN ('ACTIVE','ENDED','CANCELLED')`),
  check('giveaways_account_age_check', sql`${table.minAccountAgeSeconds} IS NULL OR ${table.minAccountAgeSeconds} >= 0`),
  check('giveaways_guild_age_check', sql`${table.minGuildAgeSeconds} IS NULL OR ${table.minGuildAgeSeconds} >= 0`),
  check('giveaways_min_level_check', sql`${table.minLevel} IS NULL OR ${table.minLevel} BETWEEN 0 AND 10000`),
]);

export const giveawayEntries = pgTable('giveaway_entries', {
  giveawayId: bigint('giveaway_id', { mode: 'number' }).notNull().references(() => giveaways.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull(),
  enteredAt: timestamp('entered_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [primaryKey({ columns: [table.giveawayId, table.userId] })]);

export const giveawayDraws = pgTable('giveaway_draws', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  giveawayId: bigint('giveaway_id', { mode: 'number' }).notNull().references(() => giveaways.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull(),
  resultAnnouncementId: text('result_announcement_id'),
  notificationClaimedAt: timestamp('notification_claimed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  index('giveaway_draws_notice_due_idx').on(table.resultAnnouncementId, table.notificationClaimedAt),
  uniqueIndex('giveaway_draws_original_unique').on(table.giveawayId).where(sql`${table.kind} = 'ORIGINAL'`),
  index('giveaway_draws_giveaway_idx').on(table.giveawayId),
  check('giveaway_draws_kind_check', sql`${table.kind} IN ('ORIGINAL','REROLL')`),
]);

export const giveawayWinners = pgTable('giveaway_winners', {
  drawId: bigint('draw_id', { mode: 'number' }).notNull().references(() => giveawayDraws.id, { onDelete: 'cascade' }),
  giveawayId: bigint('giveaway_id', { mode: 'number' }).notNull().references(() => giveaways.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull(),
  ordinal: integer('ordinal').notNull(),
}, table => [
  primaryKey({ columns: [table.drawId, table.userId] }),
  uniqueIndex('giveaway_winners_draw_ordinal_unique').on(table.drawId, table.ordinal),
  index('giveaway_winners_giveaway_idx').on(table.giveawayId, table.userId),
  check('giveaway_winners_ordinal_check', sql`${table.ordinal} BETWEEN 1 AND 20`),
]);

export const tempvoiceSettings = pgTable('tempvoice_settings', {
  guildId: text('guild_id').primaryKey().references(() => guilds.id, { onDelete: 'cascade' }),
  enabled: boolean('enabled').notNull().default(false),
  lobbyChannelId: text('lobby_channel_id'),
  categoryId: text('category_id'),
  userLimit: integer('user_limit').notNull().default(0),
  defaultPrivate: boolean('default_private').notNull().default(true),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  check('tempvoice_settings_limit_check', sql`${table.userLimit} BETWEEN 0 AND 99`),
  check('tempvoice_settings_lobby_check', sql`NOT ${table.enabled} OR ${table.lobbyChannelId} IS NOT NULL`),
]);

export const tempvoiceRooms = pgTable('tempvoice_rooms', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  guildId: text('guild_id').notNull().references(() => guilds.id, { onDelete: 'cascade' }),
  ownerId: text('owner_id').notNull(),
  channelId: text('channel_id'),
  status: text('status').notNull().default('CREATING'),
  emptySince: timestamp('empty_since', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  uniqueIndex('tempvoice_rooms_active_owner_unique').on(table.guildId, table.ownerId).where(sql`${table.status} IN ('CREATING','ACTIVE','DELETING')`),
  uniqueIndex('tempvoice_rooms_guild_channel_unique').on(table.guildId, table.channelId),
  index('tempvoice_rooms_empty_due_idx').on(table.status, table.emptySince),
  check('tempvoice_rooms_status_check', sql`${table.status} IN ('CREATING','ACTIVE','DELETING','CLOSED')`),
  check('tempvoice_rooms_active_channel_check', sql`${table.status} NOT IN ('ACTIVE','DELETING') OR ${table.channelId} IS NOT NULL`),
]);

// Static versioned registry lives in code; only earned public community IDs are persisted.
export const memberAchievements = pgTable('member_achievements', {
  guildId: text('guild_id').notNull().references(() => guilds.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull(),
  achievementId: text('achievement_id').notNull(),
  awardedAt: timestamp('awarded_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  primaryKey({ columns: [table.guildId, table.userId, table.achievementId] }),
  index('member_achievements_member_awarded_idx').on(table.guildId, table.userId, table.awardedAt),
  index('member_achievements_guild_awarded_v6_idx').on(table.guildId, table.awardedAt),
]);

// V6 analytics stores short-lived idempotency state and UTC-hour aggregates, never content.
export const analyticsSettings = pgTable('analytics_settings', {
  guildId: text('guild_id').primaryKey().references(() => guilds.id, { onDelete: 'cascade' }),
  retentionDays: integer('retention_days').notNull().default(180),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [check('analytics_settings_retention_check', sql`${table.retentionDays} BETWEEN 30 AND 730`)]);

export const analyticsGuildHourly = pgTable('analytics_guild_hourly', {
  guildId: text('guild_id').notNull().references(() => guilds.id, { onDelete: 'cascade' }),
  bucketStart: timestamp('bucket_start', { withTimezone: true }).notNull(),
  messages: bigint('messages', { mode: 'number' }).notNull().default(0),
  joins: bigint('joins', { mode: 'number' }).notNull().default(0),
  leaves: bigint('leaves', { mode: 'number' }).notNull().default(0),
  voiceSeconds: bigint('voice_seconds', { mode: 'number' }).notNull().default(0),
}, table => [primaryKey({ columns: [table.guildId, table.bucketStart] }),
  index('analytics_guild_hourly_bucket_idx').on(table.bucketStart),
  check('analytics_guild_hourly_nonnegative_check', sql`${table.messages} >= 0 AND ${table.joins} >= 0 AND ${table.leaves} >= 0 AND ${table.voiceSeconds} >= 0`)]);

export const analyticsChannelHourly = pgTable('analytics_channel_hourly', {
  guildId: text('guild_id').notNull().references(() => guilds.id, { onDelete: 'cascade' }),
  channelId: text('channel_id').notNull(),
  bucketStart: timestamp('bucket_start', { withTimezone: true }).notNull(),
  messages: bigint('messages', { mode: 'number' }).notNull().default(0),
  voiceSeconds: bigint('voice_seconds', { mode: 'number' }).notNull().default(0),
}, table => [primaryKey({ columns: [table.guildId, table.channelId, table.bucketStart] }),
  index('analytics_channel_hourly_bucket_idx').on(table.bucketStart),
  check('analytics_channel_hourly_nonnegative_check', sql`${table.messages} >= 0 AND ${table.voiceSeconds} >= 0`)]);

export const analyticsCommandHourly = pgTable('analytics_command_hourly', {
  guildId: text('guild_id').notNull().references(() => guilds.id, { onDelete: 'cascade' }),
  commandName: text('command_name').notNull(),
  bucketStart: timestamp('bucket_start', { withTimezone: true }).notNull(),
  invocations: bigint('invocations', { mode: 'number' }).notNull().default(0),
  errors: bigint('errors', { mode: 'number' }).notNull().default(0),
  totalDurationMs: bigint('total_duration_ms', { mode: 'number' }).notNull().default(0),
}, table => [primaryKey({ columns: [table.guildId, table.commandName, table.bucketStart] }),
  index('analytics_command_hourly_bucket_idx').on(table.bucketStart),
  check('analytics_command_hourly_nonnegative_check', sql`${table.invocations} >= 0 AND ${table.errors} >= 0 AND ${table.totalDurationMs} >= 0`)]);

export const analyticsEventDedupe = pgTable('analytics_event_dedupe', {
  guildId: text('guild_id').notNull().references(() => guilds.id, { onDelete: 'cascade' }),
  eventKey: text('event_key').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [primaryKey({ columns: [table.guildId, table.eventKey] }),
  index('analytics_event_dedupe_created_idx').on(table.createdAt),
  check('analytics_event_dedupe_key_check', sql`length(${table.eventKey}) BETWEEN 1 AND 100`)]);

export const analyticsMemberState = pgTable('analytics_member_state', {
  guildId: text('guild_id').notNull().references(() => guilds.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull(),
  present: boolean('present').notNull(),
  lastChangedAt: timestamp('last_changed_at', { withTimezone: true }).notNull(),
}, table => [primaryKey({ columns: [table.guildId, table.userId] }),
  index('analytics_member_state_changed_idx').on(table.lastChangedAt)]);

export const analyticsActiveVoiceSessions = pgTable('analytics_active_voice_sessions', {
  guildId: text('guild_id').notNull().references(() => guilds.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull(),
  // Null is a bounded disconnect tombstone: stale snapshots must not resurrect a newer leave.
  channelId: text('channel_id'),
  joinedAt: timestamp('joined_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  observationSeq: bigint('observation_seq', { mode: 'number' }).notNull().default(0),
  observationEpoch: integer('observation_epoch').notNull().default(0),
  // Pending ingress prevents credit immediately; classification/finalization happens later.
  pending: boolean('pending').notNull().default(false),
}, table => [primaryKey({ columns: [table.guildId, table.userId] }),
  index('analytics_active_voice_updated_idx').on(table.updatedAt)]);

// Dashboard sessions contain only hashes of opaque browser tokens, never OAuth credentials.
export const dashboardSessions = pgTable('dashboard_sessions', {
  tokenHash: text('token_hash').primaryKey(),
  userId: text('user_id').notNull(),
  oauthGuildIds: jsonb('oauth_guild_ids').$type<string[]>().notNull().default([]),
  displayName: text('display_name'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  absoluteExpiresAt: timestamp('absolute_expires_at', { withTimezone: true }).notNull(),
}, table => [index('dashboard_sessions_expiry_idx').on(table.expiresAt),
  index('dashboard_sessions_absolute_idx').on(table.absoluteExpiresAt),
  check('dashboard_sessions_expiry_check', sql`${table.expiresAt} <= ${table.absoluteExpiresAt}`)]);

export const dashboardAuditLog = pgTable('dashboard_audit_log', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  guildId: text('guild_id').notNull().references(() => guilds.id, { onDelete: 'cascade' }),
  actorUserId: text('actor_user_id').notNull(),
  action: text('action').notNull(),
  targetType: text('target_type').notNull(),
  targetId: text('target_id'),
  success: boolean('success').notNull(),
  requestId: text('request_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [index('dashboard_audit_guild_created_idx').on(table.guildId, table.createdAt),
  check('dashboard_audit_action_check', sql`length(${table.action}) BETWEEN 1 AND 80`)]);

// V7.1 foundations: metadata-only, server-approved AI admission; no prompts, responses or credentials.
export const aiSettings = pgTable('ai_settings', {
  guildId: text('guild_id').primaryKey().references(() => guilds.id, { onDelete: 'cascade' }),
  providerId: text('provider_id').notNull(),
  modelId: text('model_id').notNull(),
  guildRequestsPerDay: integer('guild_requests_per_day'),
  userRequestsPerDay: integer('user_requests_per_day'),
  monthlyBudgetMicros: bigint('monthly_budget_micros', { mode: 'number' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  check('ai_settings_provider_check', sql`length(${table.providerId}) BETWEEN 1 AND 64 AND ${table.providerId} ~ '^[a-z0-9_-]+$'`),
  check('ai_settings_model_check', sql`length(${table.modelId}) BETWEEN 1 AND 100 AND ${table.modelId} ~ '^[A-Za-z0-9._:/-]+$'`),
  check('ai_settings_caps_check', sql`(${table.guildRequestsPerDay} IS NULL OR ${table.guildRequestsPerDay} BETWEEN 1 AND 25) AND
    (${table.userRequestsPerDay} IS NULL OR ${table.userRequestsPerDay} BETWEEN 1 AND 10) AND
    (${table.monthlyBudgetMicros} IS NULL OR ${table.monthlyBudgetMicros} BETWEEN 1 AND 5000000)`),
]);

export const aiUsageDaily = pgTable('ai_usage_daily', {
  guildId: text('guild_id').notNull().references(() => guilds.id, { onDelete: 'cascade' }),
  utcDay: date('utc_day', { mode: 'string' }).notNull(),
  requests: integer('requests').notNull().default(0),
  rejected: integer('rejected').notNull().default(0),
  reservedCostMicros: bigint('reserved_cost_micros', { mode: 'number' }).notNull().default(0),
  settledCostMicros: bigint('settled_cost_micros', { mode: 'number' }).notNull().default(0),
  inputTokens: bigint('input_tokens', { mode: 'number' }).notNull().default(0),
  outputTokens: bigint('output_tokens', { mode: 'number' }).notNull().default(0),
}, table => [
  primaryKey({ columns: [table.guildId, table.utcDay] }),
  index('ai_usage_day_idx').on(table.utcDay),
  check('ai_usage_nonnegative_check', sql`${table.requests} >= 0 AND ${table.rejected} >= 0 AND
    ${table.reservedCostMicros} >= 0 AND ${table.settledCostMicros} >= 0 AND
    ${table.inputTokens} >= 0 AND ${table.outputTokens} >= 0`),
]);

export const aiRequests = pgTable('ai_requests', {
  id: uuid('id').primaryKey(),
  guildId: text('guild_id').notNull().references(() => guilds.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull(),
  requestKey: text('request_key').notNull(),
  usageDay: date('usage_day', { mode: 'string' }).notNull(),
  epoch: integer('epoch').notNull(),
  status: text('status').notNull().default('RESERVED'),
  modelId: text('model_id').notNull(),
  reservedInputTokens: integer('reserved_input_tokens').notNull(),
  reservedOutputTokens: integer('reserved_output_tokens').notNull(),
  reservedCostMicros: bigint('reserved_cost_micros', { mode: 'number' }).notNull(),
  actualInputTokens: integer('actual_input_tokens'),
  actualOutputTokens: integer('actual_output_tokens'),
  actualCostMicros: bigint('actual_cost_micros', { mode: 'number' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  leaseUntil: timestamp('lease_until', { withTimezone: true }).notNull(),
  settledAt: timestamp('settled_at', { withTimezone: true }),
}, table => [
  uniqueIndex('ai_requests_guild_key_unique').on(table.guildId, table.requestKey),
  index('ai_requests_user_created_idx').on(table.guildId, table.userId, table.createdAt),
  index('ai_requests_live_idx').on(table.guildId, table.status, table.leaseUntil),
  index('ai_requests_retention_idx').on(table.createdAt),
  foreignKey({ columns: [table.guildId, table.usageDay], foreignColumns: [aiUsageDaily.guildId, aiUsageDaily.utcDay], name: 'ai_requests_usage_day_fk' }).onDelete('cascade'),
  check('ai_requests_user_check', sql`${table.userId} ~ '^[0-9]{17,20}$'`),
  check('ai_requests_key_check', sql`length(${table.requestKey}) BETWEEN 1 AND 128`),
  check('ai_requests_status_check', sql`${table.status} IN ('RESERVED','SETTLED','EXPIRED')`),
  check('ai_requests_epoch_check', sql`${table.epoch} >= 0`),
  check('ai_requests_amount_check', sql`${table.reservedInputTokens} BETWEEN 0 AND 2048 AND
    ${table.reservedOutputTokens} BETWEEN 1 AND 512 AND ${table.reservedCostMicros} >= 0 AND
    (${table.actualInputTokens} IS NULL OR ${table.actualInputTokens} BETWEEN 0 AND 2048) AND
    (${table.actualOutputTokens} IS NULL OR ${table.actualOutputTokens} BETWEEN 0 AND 512) AND
    (${table.actualCostMicros} IS NULL OR ${table.actualCostMicros} BETWEEN 0 AND ${table.reservedCostMicros})`),
  check('ai_requests_settlement_check', sql`(${table.status} = 'RESERVED' AND ${table.settledAt} IS NULL AND ${table.actualCostMicros} IS NULL) OR
    (${table.status} <> 'RESERVED' AND ${table.settledAt} IS NOT NULL AND ${table.actualCostMicros} IS NOT NULL)`),
]);

// No V7.1 action executor is registered. JSON is bounded and validated again by typed registries.
export const automations = pgTable('automations', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  guildId: text('guild_id').notNull().references(() => guilds.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  enabled: boolean('enabled').notNull().default(false),
  triggerKey: text('trigger_key').notNull(),
  triggerVersion: integer('trigger_version').notNull(),
  triggerConfig: jsonb('trigger_config').$type<Record<string, unknown>>().notNull().default({}),
  configVersion: integer('config_version').notNull().default(1),
  authorizedBy: text('authorized_by').notNull(),
  approvedCapability: text('approved_capability').notNull(),
  timezone: text('timezone').notNull().default('UTC'),
  nextRunAt: timestamp('next_run_at', { withTimezone: true }),
  cooldownSeconds: integer('cooldown_seconds').notNull().default(60),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, table => [
  uniqueIndex('automations_guild_id_unique').on(table.guildId, table.id),
  index('automations_due_idx').on(table.enabled, table.nextRunAt, table.id),
  index('automations_guild_enabled_idx').on(table.guildId, table.enabled),
  check('automations_name_check', sql`length(${table.name}) BETWEEN 1 AND 80`),
  check('automations_trigger_check', sql`${table.triggerKey} IN ('SCHEDULED') AND ${table.triggerVersion} BETWEEN 1 AND 100`),
  check('automations_config_check', sql`jsonb_typeof(${table.triggerConfig}) = 'object' AND octet_length(${table.triggerConfig}::text) <= 2048`),
  check('automations_version_check', sql`${table.configVersion} BETWEEN 1 AND 2147483647`),
  check('automations_authorizer_check', sql`${table.authorizedBy} ~ '^[0-9]{17,20}$'`),
  check('automations_capability_check', sql`${table.approvedCapability} IN ('SEND_MESSAGE','STAFF_LOG')`),
  check('automations_timezone_check', sql`length(${table.timezone}) BETWEEN 1 AND 64`),
  check('automations_cooldown_check', sql`${table.cooldownSeconds} BETWEEN 0 AND 86400`),
]);

export const automationActions = pgTable('automation_actions', {
  automationId: bigint('automation_id', { mode: 'number' }).notNull().references(() => automations.id, { onDelete: 'cascade' }),
  position: integer('position').notNull(),
  actionKey: text('action_key').notNull(),
  actionVersion: integer('action_version').notNull(),
  config: jsonb('config').$type<Record<string, unknown>>().notNull().default({}),
}, table => [
  primaryKey({ columns: [table.automationId, table.position] }),
  check('automation_actions_position_check', sql`${table.position} BETWEEN 0 AND 1`),
  check('automation_actions_kind_check', sql`${table.actionKey} IN ('STATIC_MESSAGE','STAFF_LOG') AND ${table.actionVersion} BETWEEN 1 AND 100`),
  check('automation_actions_config_check', sql`jsonb_typeof(${table.config}) = 'object' AND octet_length(${table.config}::text) <= 2048 AND
    (${table.actionKey} <> 'STATIC_MESSAGE' OR length(coalesce(${table.config}->>'text', '')) <= 1000)`),
]);

export const automationExecutions = pgTable('automation_executions', {
  id: uuid('id').primaryKey(),
  guildId: text('guild_id').notNull().references(() => guilds.id, { onDelete: 'cascade' }),
  automationId: bigint('automation_id', { mode: 'number' }).notNull(),
  triggerKey: text('trigger_key').notNull(),
  status: text('status').notNull().default('PENDING'),
  moduleEpoch: integer('module_epoch').notNull(),
  configVersion: integer('config_version').notNull(),
  causationId: uuid('causation_id'),
  chainDepth: integer('chain_depth').notNull().default(0),
  attempts: integer('attempts').notNull().default(0),
  claimToken: uuid('claim_token'),
  leaseUntil: timestamp('lease_until', { withTimezone: true }),
  nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
  safeErrorCode: text('safe_error_code'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
}, table => [
  foreignKey({ columns: [table.guildId, table.automationId], foreignColumns: [automations.guildId, automations.id], name: 'automation_executions_guild_automation_fk' }).onDelete('cascade'),
  uniqueIndex('automation_executions_trigger_unique').on(table.guildId, table.automationId, table.triggerKey),
  uniqueIndex('automation_executions_guild_id_unique').on(table.guildId, table.id),
  index('automation_executions_due_idx').on(table.status, table.nextAttemptAt),
  index('automation_executions_retention_idx').on(table.createdAt),
  check('automation_executions_trigger_check', sql`length(${table.triggerKey}) BETWEEN 1 AND 128`),
  check('automation_executions_status_check', sql`${table.status} IN ('PENDING','RUNNING','SUCCEEDED','SKIPPED','FAILED','UNCERTAIN')`),
  check('automation_executions_bounds_check', sql`${table.moduleEpoch} >= 0 AND ${table.configVersion} > 0 AND
    ${table.chainDepth} BETWEEN 0 AND 2 AND ${table.attempts} BETWEEN 0 AND 5`),
  check('automation_executions_error_check', sql`${table.safeErrorCode} IS NULL OR ${table.safeErrorCode} ~ '^[A-Z_]{1,40}$'`),
]);

// Attempts are persisted independently of worker state for atomic, cross-worker rate limiting.
export const automationExecutionAttempts = pgTable('automation_execution_attempts', {
  id: uuid('id').primaryKey(),
  guildId: text('guild_id').notNull().references(() => guilds.id, { onDelete: 'cascade' }),
  executionId: uuid('execution_id').notNull().references(() => automationExecutions.id, { onDelete: 'cascade' }),
  attemptedAt: timestamp('attempted_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  index('automation_execution_attempts_guild_time_idx').on(table.guildId, table.attemptedAt),
  index('automation_execution_attempts_time_idx').on(table.attemptedAt),
  foreignKey({ columns: [table.guildId, table.executionId], foreignColumns: [automationExecutions.guildId, automationExecutions.id], name: 'automation_execution_attempts_guild_execution_fk' }).onDelete('cascade'),
]);

// Execution-owned action definitions are captured when queued, never read from live automation_actions during dispatch.
export const automationExecutionActions = pgTable('automation_execution_actions', {
  executionId: uuid('execution_id').notNull().references(() => automationExecutions.id, { onDelete: 'cascade' }),
  position: integer('position').notNull(),
  actionKey: text('action_key').notNull(),
  actionVersion: integer('action_version').notNull(),
  config: jsonb('config').$type<Record<string, unknown>>().notNull().default({}),
}, table => [
  primaryKey({ columns: [table.executionId, table.position] }),
  check('automation_execution_actions_position_check', sql`${table.position} BETWEEN 0 AND 1`),
  check('automation_execution_actions_kind_check', sql`${table.actionKey} IN ('STATIC_MESSAGE','STAFF_LOG','LEGACY_INERT') AND ${table.actionVersion} BETWEEN 1 AND 100`),
  check('automation_execution_actions_config_check', sql`jsonb_typeof(${table.config}) = 'object' AND octet_length(${table.config}::text) <= 2048 AND
    (${table.actionKey} <> 'STATIC_MESSAGE' OR length(coalesce(${table.config}->>'text', '')) <= 1000)`),
]);

export const automationActionRuns = pgTable('automation_action_runs', {
  executionId: uuid('execution_id').notNull().references(() => automationExecutions.id, { onDelete: 'cascade' }),
  position: integer('position').notNull(),
  status: text('status').notNull().default('PENDING'),
  attempts: integer('attempts').notNull().default(0),
  discordMessageId: text('discord_message_id'),
  dispatchToken: uuid('dispatch_token'),
  reconciliationResult: text('reconciliation_result'),
  reconciledBy: text('reconciled_by'),
  reconciledAt: timestamp('reconciled_at', { withTimezone: true }),
  safeErrorCode: text('safe_error_code'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  primaryKey({ columns: [table.executionId, table.position] }),
  foreignKey({ columns: [table.executionId, table.position], foreignColumns: [automationExecutionActions.executionId, automationExecutionActions.position], name: 'automation_action_runs_snapshot_fk' }).onDelete('cascade'),
  check('automation_action_runs_position_check', sql`${table.position} BETWEEN 0 AND 1`),
  check('automation_action_runs_status_check', sql`${table.status} IN ('PENDING','RUNNING','SUCCEEDED','SKIPPED','FAILED','UNCERTAIN')`),
  check('automation_action_runs_attempt_check', sql`${table.attempts} BETWEEN 0 AND 5`),
  check('automation_action_runs_message_check', sql`${table.discordMessageId} IS NULL OR ${table.discordMessageId} ~ '^[0-9]{17,20}$'`),
  check('automation_action_runs_error_check', sql`${table.safeErrorCode} IS NULL OR ${table.safeErrorCode} ~ '^[A-Z_]{1,40}$'`),
  check('automation_action_runs_reconciliation_check', sql`(${table.reconciliationResult} IS NULL AND ${table.reconciledBy} IS NULL AND ${table.reconciledAt} IS NULL) OR
    (${table.reconciliationResult} IN ('CONFIRMED_SENT','CONFIRMED_NOT_SENT') AND ${table.reconciledBy} ~ '^[0-9]{17,20}$' AND ${table.reconciledAt} IS NOT NULL)`),
]);
