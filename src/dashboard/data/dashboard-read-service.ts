import { and, desc, eq, sql } from 'drizzle-orm';
import type { Database } from '../../core/database/connection.js';
import * as s from '../../core/database/schema.js';
import { levelForXp } from '../../modules/levels/formula.js';

/** All methods require the calling route to authorize access to guildId first. */
export class DashboardReadService {
  constructor(private readonly db: Database, readonly services: ReadServices = {}) {}

  private limit(value = 20): number {
    if (!Number.isSafeInteger(value) || value < 1 || value > 50) throw new RangeError('limit must be an integer from 1 to 50');
    return value;
  }
  private guild(guildId: string): string {
    if (!guildId?.trim()) throw new RangeError('guildId is required');
    return guildId;
  }
  private id(id: number): number {
    if (!Number.isSafeInteger(id) || id < 1) throw new RangeError('id must be a positive safe integer');
    return id;
  }

  async overview(guildId: string) {
    this.guild(guildId);
    const [settings, modules, cases, reports, tickets, suggestions, events, giveaways] = await Promise.all([
      this.db.select({ language: s.guildSettings.language, timezone: s.guildSettings.timezone, setupCompletedAt: s.guildSettings.setupCompletedAt }).from(s.guildSettings).where(eq(s.guildSettings.guildId, guildId)).limit(1),
      this.db.select({ moduleKey: s.guildModules.moduleKey, enabled: s.guildModules.enabled }).from(s.guildModules).where(eq(s.guildModules.guildId, guildId)).orderBy(s.guildModules.moduleKey).limit(50),
      this.db.select({ count: sql<number>`count(*)::int` }).from(s.moderationCases).where(and(eq(s.moderationCases.guildId, guildId), eq(s.moderationCases.status, 'ACTIVE'))).limit(1),
      this.db.select({ count: sql<number>`count(*)::int` }).from(s.reports).where(and(eq(s.reports.guildId, guildId), eq(s.reports.status, 'OPEN'))).limit(1),
      this.db.select({ count: sql<number>`count(*)::int` }).from(s.tickets).where(and(eq(s.tickets.guildId, guildId), eq(s.tickets.status, 'OPEN'))).limit(1),
      this.db.select({ count: sql<number>`count(*)::int` }).from(s.suggestions).where(and(eq(s.suggestions.guildId, guildId), eq(s.suggestions.status, 'PENDING'))).limit(1),
      this.db.select({ count: sql<number>`count(*)::int` }).from(s.communityEvents).where(and(eq(s.communityEvents.guildId, guildId), eq(s.communityEvents.status, 'SCHEDULED'))).limit(1),
      this.db.select({ count: sql<number>`count(*)::int` }).from(s.giveaways).where(and(eq(s.giveaways.guildId, guildId), eq(s.giveaways.status, 'ACTIVE'))).limit(1),
    ]);
    return { settings: settings[0] ?? null, modules, counts: { activeCases: cases[0]?.count ?? 0, openReports: reports[0]?.count ?? 0, openTickets: tickets[0]?.count ?? 0, pendingSuggestions: suggestions[0]?.count ?? 0, scheduledEvents: events[0]?.count ?? 0, activeGiveaways: giveaways[0]?.count ?? 0 } };
  }

  listCases(guildId: string, limit = 20) {
    return this.db.select({ id: s.moderationCases.id, targetId: s.moderationCases.targetId, moderatorId: s.moderationCases.moderatorId, action: s.moderationCases.action, status: s.moderationCases.status, createdAt: s.moderationCases.createdAt, expiresAt: s.moderationCases.expiresAt }).from(s.moderationCases).where(eq(s.moderationCases.guildId, this.guild(guildId))).orderBy(desc(s.moderationCases.id)).limit(this.limit(limit));
  }
  listReports(guildId: string, limit = 20) {
    return this.db.select({ id: s.reports.id, category: s.reports.category, status: s.reports.status, assignedStaffId: s.reports.assignedStaffId, createdAt: s.reports.createdAt, closedAt: s.reports.closedAt }).from(s.reports).where(eq(s.reports.guildId, this.guild(guildId))).orderBy(desc(s.reports.id)).limit(this.limit(limit));
  }
  /** Caller obtains current members from Discord REST (not cache) and passes their IDs here. */
  async memberLookup(guildId: string, currentMemberIds: readonly string[]) {
    this.guild(guildId);
    if (currentMemberIds.length > 50) throw new RangeError('at most 50 current member IDs');
    const ids = [...new Set(currentMemberIds.filter(Boolean))];
    if (!ids.length) return [];
    const { inArray } = await import('drizzle-orm');
    const [levels, verifications] = await Promise.all([
      this.db.select({ userId: s.memberLevels.userId, xp: s.memberLevels.xp, messageCount: s.memberLevels.messageCount }).from(s.memberLevels).where(and(eq(s.memberLevels.guildId, guildId), inArray(s.memberLevels.userId, ids))).limit(50),
      this.db.select({ userId: s.memberVerifications.userId, status: s.memberVerifications.status }).from(s.memberVerifications).where(and(eq(s.memberVerifications.guildId, guildId), inArray(s.memberVerifications.userId, ids))).limit(50),
    ]);
    return ids.map(userId => { const level = levels.find(row => row.userId === userId); return { userId, xp: level?.xp ?? 0, level: levelForXp(level?.xp ?? 0), messageCount: level?.messageCount ?? 0, verificationStatus: verifications.find(row => row.userId === userId)?.status ?? null }; });
  }
  async roles(guildId: string, limit = 20) {
    this.guild(guildId);
    const [menus, permissionRoles] = await Promise.all([
      this.db.select({ id: s.roleMenus.id, name: s.roleMenus.name, kind: s.roleMenus.kind, enabled: s.roleMenus.enabled, exclusive: s.roleMenus.exclusive, maxValues: s.roleMenus.maxValues, channelId: s.roleMenus.channelId, messageId: s.roleMenus.messageId }).from(s.roleMenus).where(eq(s.roleMenus.guildId, guildId)).orderBy(desc(s.roleMenus.id)).limit(this.limit(limit)),
      this.db.select({ roleId: s.guildPermissionRoles.roleId, level: s.guildPermissionRoles.level }).from(s.guildPermissionRoles).where(eq(s.guildPermissionRoles.guildId, guildId)).orderBy(s.guildPermissionRoles.roleId).limit(50),
    ]);
    return { menus, permissionRoles };
  }
  listRoleOptions(guildId: string, menuId: number) {
    return this.db.select({ id: s.roleMenuOptions.id, roleId: s.roleMenuOptions.roleId, label: s.roleMenuOptions.label, description: s.roleMenuOptions.description, position: s.roleMenuOptions.position }).from(s.roleMenuOptions).innerJoin(s.roleMenus, eq(s.roleMenuOptions.menuId, s.roleMenus.id)).where(and(eq(s.roleMenus.guildId, this.guild(guildId)), eq(s.roleMenus.id, this.id(menuId)))).orderBy(s.roleMenuOptions.position).limit(25);
  }
  async tickets(guildId: string, limit = 20) {
    this.guild(guildId);
    const [settings, items] = await Promise.all([
      this.db.select().from(s.ticketSettings).where(eq(s.ticketSettings.guildId, guildId)).limit(1),
      this.db.select({ id: s.tickets.id, creatorId: s.tickets.creatorId, type: s.tickets.type, channelId: s.tickets.channelId, assignedStaffId: s.tickets.assignedStaffId, status: s.tickets.status, createdAt: s.tickets.createdAt, closedAt: s.tickets.closedAt, hasTranscript: sql<boolean>`${s.tickets.transcript} IS NOT NULL` }).from(s.tickets).where(eq(s.tickets.guildId, guildId)).orderBy(desc(s.tickets.id)).limit(this.limit(limit)),
    ]);
    return { settings: settings[0] ?? null, items };
  }
  async suggestions(guildId: string, limit = 20) {
    this.guild(guildId);
    const items = await this.db.select({ id: s.suggestions.id, authorId: s.suggestions.authorId, status: s.suggestions.status, createdAt: s.suggestions.createdAt, messageId: s.suggestions.messageId, upvotes: sql<number>`(SELECT count(*)::int FROM suggestion_votes v WHERE v.suggestion_id = ${s.suggestions.id} AND v.vote = 1)`, downvotes: sql<number>`(SELECT count(*)::int FROM suggestion_votes v WHERE v.suggestion_id = ${s.suggestions.id} AND v.vote = -1)` }).from(s.suggestions).where(eq(s.suggestions.guildId, guildId)).orderBy(desc(s.suggestions.id)).limit(this.limit(limit));
    return items;
  }
  async levels(guildId: string, limit = 20) {
    this.guild(guildId);
    const [settings, rewards, leaderboard] = await Promise.all([
      this.db.select().from(s.levelsSettings).where(eq(s.levelsSettings.guildId, guildId)).limit(1),
      this.db.select({ level: s.levelRewards.level, roleId: s.levelRewards.roleId }).from(s.levelRewards).where(eq(s.levelRewards.guildId, guildId)).orderBy(s.levelRewards.level).limit(50),
      this.db.select({ userId: s.memberLevels.userId, xp: s.memberLevels.xp, messageCount: s.memberLevels.messageCount }).from(s.memberLevels).where(eq(s.memberLevels.guildId, guildId)).orderBy(desc(s.memberLevels.xp), s.memberLevels.userId).limit(this.limit(limit)),
    ]);
    return { settings: settings[0] ?? null, rewards, leaderboard: leaderboard.map((row, index) => ({ ...row, rank: index + 1, level: levelForXp(row.xp) })) };
  }
  events(guildId: string, limit = 20) {
    return this.db.select({ id: s.communityEvents.id, creatorId: s.communityEvents.creatorId, title: s.communityEvents.title, status: s.communityEvents.status, startAt: s.communityEvents.startAt, endAt: s.communityEvents.endAt, channelId: s.communityEvents.channelId, maxParticipants: s.communityEvents.maxParticipants }).from(s.communityEvents).where(eq(s.communityEvents.guildId, this.guild(guildId))).orderBy(desc(s.communityEvents.startAt), desc(s.communityEvents.id)).limit(this.limit(limit));
  }
  giveaways(guildId: string, limit = 20) {
    return this.db.select({ id: s.giveaways.id, prize: s.giveaways.prize, status: s.giveaways.status, startAt: s.giveaways.startAt, endAt: s.giveaways.endAt, winnerCount: s.giveaways.winnerCount, resultAnnouncementId: s.giveaways.resultAnnouncementId }).from(s.giveaways).where(eq(s.giveaways.guildId, this.guild(guildId))).orderBy(desc(s.giveaways.id)).limit(this.limit(limit));
  }
  giveawayOutcomes(guildId: string, giveawayId: number) {
    return this.db.select({ drawId: s.giveawayDraws.id, kind: s.giveawayDraws.kind, createdAt: s.giveawayDraws.createdAt, winnerId: s.giveawayWinners.userId, ordinal: s.giveawayWinners.ordinal }).from(s.giveawayDraws).innerJoin(s.giveaways, eq(s.giveawayDraws.giveawayId, s.giveaways.id)).leftJoin(s.giveawayWinners, eq(s.giveawayWinners.drawId, s.giveawayDraws.id)).where(and(eq(s.giveaways.guildId, this.guild(guildId)), eq(s.giveaways.id, this.id(giveawayId)))).orderBy(desc(s.giveawayDraws.id), s.giveawayWinners.ordinal).limit(50);
  }
  async botSettings(guildId: string) {
    this.guild(guildId);
    const [settings, verification, antiraid, analytics, suggestion, ticket] = await Promise.all([
      this.db.select().from(s.guildSettings).where(eq(s.guildSettings.guildId, guildId)).limit(1),
      this.db.select({ enabled: s.verificationSettings.enabled, mode: s.verificationSettings.mode, verificationChannelId: s.verificationSettings.verificationChannelId, verifiedRoleId: s.verificationSettings.verifiedRoleId }).from(s.verificationSettings).where(eq(s.verificationSettings.guildId, guildId)).limit(1),
      this.db.select({ enabled: s.antiraidSettings.enabled, emergencyMode: s.antiraidSettings.emergencyMode, alertChannelId: s.antiraidSettings.alertChannelId }).from(s.antiraidSettings).where(eq(s.antiraidSettings.guildId, guildId)).limit(1),
      this.db.select({ retentionDays: s.analyticsSettings.retentionDays }).from(s.analyticsSettings).where(eq(s.analyticsSettings.guildId, guildId)).limit(1),
      this.db.select().from(s.suggestionSettings).where(eq(s.suggestionSettings.guildId, guildId)).limit(1),
      this.db.select().from(s.ticketSettings).where(eq(s.ticketSettings.guildId, guildId)).limit(1),
    ]);
    return { settings: settings[0] ?? null, verification: verification[0] ?? null, antiraid: antiraid[0] ?? null, analytics: analytics[0] ?? null, suggestion: suggestion[0] ?? null, ticket: ticket[0] ?? null };
  }
}

/** Optional domain read dependencies reserved for route composition; no mutating service method is invoked. */
export type ReadServices = Record<string, unknown>;
