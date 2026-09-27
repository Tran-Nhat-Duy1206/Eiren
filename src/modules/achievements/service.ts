import type { ModuleService } from '../../services/module-service.js';
import type { LevelsRepository } from '../levels/repository.js';
import { levelForXp } from '../levels/formula.js';
import type { ReputationRepository } from '../reputation/repository.js';
import { ACHIEVEMENTS } from './registry.js';
import type { AchievementRepository } from './repository.js';

export type AchievementSources = {
  level?: Pick<LevelsRepository, 'member'>;
  reputation?: Pick<ReputationRepository, 'score'>;
  /** Each optional source must query durable, guild-scoped state; no event is inferred from RSVP. */
  eventJoin?: (guildId: string, userId: string) => Promise<boolean>;
  eventAttend?: (guildId: string, userId: string) => Promise<boolean>;
  giveawayWin?: (guildId: string, userId: string) => Promise<boolean>;
};
export class AchievementsService {
  constructor(private readonly repo: AchievementRepository, private readonly modules: Pick<ModuleService, 'isEnabled'>,
    private readonly sources: AchievementSources = {}) {}

  private async award(guildId: string, userId: string, source: 'levels' | 'reputation' | 'events' | 'giveaways', ids: readonly string[]) {
    if (!await this.modules.isEnabled(guildId, 'achievements') || !await this.modules.isEnabled(guildId, source)) return [];
    const awarded: string[] = [];
    for (const id of ids) if (await this.repo.award(guildId, userId, id)) awarded.push(id);
    return awarded;
  }
  onLevel(guildId: string, userId: string, level: number, messageCount: number) {
    return this.award(guildId, userId, 'levels', [
      ...(messageCount >= 1 ? ['first-message'] : []), ...(messageCount >= 100 ? ['messages-100'] : []),
      ...(level >= 5 ? ['level-5'] : []), ...(level >= 10 ? ['level-10'] : []),
    ]);
  }
  onReputation(guildId: string, userId: string, score: number) {
    return this.award(guildId, userId, 'reputation', [
      ...(score >= 1 ? ['reputation-1'] : []), ...(score >= 10 ? ['reputation-10'] : []),
    ]);
  }
  onEventJoin(guildId: string, userId: string) { return this.award(guildId, userId, 'events', ['event-rsvp-1']); }
  onEventAttend(guildId: string, userId: string) { return this.award(guildId, userId, 'events', ['event-attendance-1']); }
  onGiveawayWin(guildId: string, userId: string) { return this.award(guildId, userId, 'giveaways', ['giveaway-win-1']); }

  /** Read-only view for web GETs: unlike evaluation, it never awards achievements. */
  async listMember(guildId: string, userId: string) {
    if (!await this.modules.isEnabled(guildId, 'achievements')) return [];
    const rows = await this.repo.list(guildId, userId);
    const awarded = new Map(rows.map(row => [row.achievementId, row.awardedAt]));
    const enabled = new Map(await Promise.all((['levels', 'reputation', 'events', 'giveaways'] as const)
      .map(async source => [source, await this.modules.isEnabled(guildId, source)] as const)));
    return ACHIEVEMENTS.filter(item => awarded.has(item.id) && enabled.get(item.category))
      .map(item => ({ ...item, awardedAt: awarded.get(item.id)! }));
  }

  /** Only checks the requested member, and never reads a disabled module's source table. */
  async evaluateMember(guildId: string, userId: string) {
    if (!await this.modules.isEnabled(guildId, 'achievements')) return [];
    if (this.sources.level && await this.modules.isEnabled(guildId, 'levels')) {
      const member = await this.sources.level.member(guildId, userId);
      if (member) await this.onLevel(guildId, userId, levelForXp(member.xp), member.messageCount);
    }
    if (this.sources.reputation && await this.modules.isEnabled(guildId, 'reputation'))
      await this.onReputation(guildId, userId, await this.sources.reputation.score(guildId, userId));
    if (await this.modules.isEnabled(guildId, 'events')) {
      if (this.sources.eventJoin && await this.sources.eventJoin(guildId, userId)) await this.onEventJoin(guildId, userId);
      if (this.sources.eventAttend && await this.sources.eventAttend(guildId, userId)) await this.onEventAttend(guildId, userId);
    }
    if (this.sources.giveawayWin && await this.modules.isEnabled(guildId, 'giveaways') && await this.sources.giveawayWin(guildId, userId))
      await this.onGiveawayWin(guildId, userId);
    return this.listMember(guildId, userId);
  }
}
