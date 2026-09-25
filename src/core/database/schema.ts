import { boolean, check, index, integer, jsonb, pgTable, primaryKey, bigserial, text, timestamp } from 'drizzle-orm/pg-core';
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
