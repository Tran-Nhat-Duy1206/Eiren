import { boolean, check, index, integer, jsonb, pgTable, primaryKey, bigserial, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
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
