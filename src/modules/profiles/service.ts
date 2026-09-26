import type { ModuleService } from '../../services/module-service.js';

/** Profiles are a read-only facade, not a second copy of social state. */
export interface ProfileLevel {
  xp: number;
  level: number;
  progress: number;
  nextLevelXp: number;
  rank: number | null;
  messageCount: number;
}
export interface MemberProfile {
  guildId: string;
  userId: string;
  levels?: ProfileLevel | null;
  reputation?: number;
}
export class ProfileService {
  constructor(private readonly modules: Pick<ModuleService, 'isEnabled'>,
    private readonly rankFor: (guildId: string, userId: string) => Promise<ProfileLevel | null>,
    private readonly scoreFor: (guildId: string, userId: string) => Promise<number>) {}

  async get(guildId: string, userId: string): Promise<MemberProfile> {
    const profile: MemberProfile = { guildId, userId };
    if (await this.modules.isEnabled(guildId, 'levels')) profile.levels = await this.rankFor(guildId, userId);
    if (await this.modules.isEnabled(guildId, 'reputation')) profile.reputation = await this.scoreFor(guildId, userId);
    return profile;
  }
}
