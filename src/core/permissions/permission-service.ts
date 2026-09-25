import { AppError } from '../errors/errors.js';
import type { GuildRepository } from '../../repositories/guild-repository.js';

export const levels = ['MEMBER', 'HELPER', 'MODERATOR', 'SENIOR_MODERATOR', 'ADMIN', 'GUILD_OWNER', 'BOT_OWNER'] as const;
export type PermissionLevel = typeof levels[number];
export type Actor = { userId: string; guildId: string; guildOwnerId: string; roleIds: string[] };

export class PermissionService {
  constructor(private readonly repository: Pick<GuildRepository, 'getRoleLevels'>, private readonly botOwners: ReadonlySet<string> = new Set()) {}
  async resolve(actor: Actor): Promise<PermissionLevel> {
    if (this.botOwners.has(actor.userId)) return 'BOT_OWNER';
    if (actor.userId === actor.guildOwnerId) return 'GUILD_OWNER';
    const mappings = await this.repository.getRoleLevels(actor.guildId, actor.roleIds);
    // Never honor a stale, manually inserted owner mapping: guild ownership is not delegable.
    return levels[Math.max(0, ...mappings.map(level => {
      const index = levels.indexOf(level as PermissionLevel);
      return Math.min(index, levels.indexOf('ADMIN'));
    }))] ?? 'MEMBER';
  }
  async require(actor: Actor, minimum: PermissionLevel): Promise<void> {
    const actual = await this.resolve(actor);
    if (levels.indexOf(actual) < levels.indexOf(minimum)) throw new AppError('PERMISSION', 'You do not have permission to do that.');
  }
  async setRole(actor: Actor, roleId: string, level: PermissionLevel, repository: GuildRepository) {
    await this.require(actor, 'GUILD_OWNER');
    if (!/^\d{17,20}$/.test(roleId) || !['HELPER', 'MODERATOR', 'SENIOR_MODERATOR', 'ADMIN'].includes(level))
      throw new AppError('VALIDATION', 'Choose a valid role and delegable level.');
    await repository.setRoleLevel(actor.guildId, roleId, level);
  }
  async removeRole(actor: Actor, roleId: string, repository: GuildRepository) {
    await this.require(actor, 'GUILD_OWNER');
    await repository.removeRoleLevel(actor.guildId, roleId);
  }
}
