import { bigint, boolean, check, index, integer, jsonb, pgTable, primaryKey, bigserial, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
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
}, table => [
  index('tickets_guild_creator_status_idx').on(table.guildId, table.creatorId, table.status),
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
  description: text('description').notNull(),
  evidenceUrl: text('evidence_url'),
  status: text('status').notNull().default('OPEN'),
  assignedStaffId: text('assigned_staff_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  closedAt: timestamp('closed_at', { withTimezone: true }),
  closedBy: text('closed_by'),
  resolutionNote: text('resolution_note'),
}, table => [
  index('reports_guild_status_created_idx').on(table.guildId, table.status, table.createdAt),
  index('reports_reporter_created_idx').on(table.guildId, table.reporterId, table.createdAt),
  check('reports_status_check', sql`${table.status} IN ('OPEN','UNDER_REVIEW','CLOSED')`),
]);

export const appeals = pgTable('appeals', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  guildId: text('guild_id').notNull().references(() => guilds.id, { onDelete: 'cascade' }),
  appellantId: text('appellant_id').notNull(),
  caseId: bigint('case_id', { mode: 'number' }).references(() => moderationCases.id, { onDelete: 'set null' }),
  reason: text('reason').notNull(),
  status: text('status').notNull().default('PENDING'),
  reviewerId: text('reviewer_id'),
  reviewNote: text('review_note'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
}, table => [
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
