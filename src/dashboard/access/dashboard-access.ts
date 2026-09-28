import type { Client } from 'discord.js';
import { AppError } from '../../core/errors/errors.js';
import type { Actor, PermissionLevel, PermissionService } from '../../core/permissions/permission-service.js';

export type DashboardSession = Readonly<{ userId: string; oauthGuildIds: readonly string[] }>;
export type AccessibleGuild = { id: string; name: string; owner: string; memberCount?: number };

/** OAuth is a discovery snapshot, never a source of permissions. */
export class DashboardAccess {
  constructor(private readonly client: Client, private readonly permissions: PermissionService) {}

  async authorize(guildId: string, session: DashboardSession, level: PermissionLevel): Promise<Actor> {
    if (!this.validSession(session) || !session.oauthGuildIds.includes(guildId)) throw denied();
    try {
      // force=true bypasses discord.js guild and member caches. Never authorize from cached state.
      const guild = await this.client.guilds.fetch({ guild: guildId, force: true });
      if (!guild || guild.id !== guildId) throw denied();
      const member = await guild.members.fetch({ user: session.userId, force: true });
      if (!member || member.id !== session.userId || member.guild.id !== guildId) throw denied();
      // A role lookup failure or incomplete role cache must not confer an internal level.
      await guild.roles.fetch();
      const actor: Actor = {
        userId: session.userId,
        guildId,
        guildOwnerId: guild.ownerId,
        roleIds: [...member.roles.cache.keys()].filter(id => id !== guildId),
      };
      await this.permissions.require(actor, level);
      return actor;
    } catch {
      throw denied();
    }
  }

  async listAccessible(session: DashboardSession, minLevel: PermissionLevel = 'HELPER'): Promise<AccessibleGuild[]> {
    if (!this.validSession(session)) return [];
    const result: AccessibleGuild[] = [];
    for (const guildId of new Set(session.oauthGuildIds.slice(0, 200))) {
      try {
        const actor = await this.authorize(guildId, session, minLevel);
        // Metadata is read from the same freshly fetched guild, not OAuth bitfields.
        // Re-fetch rather than relying on an uncertain cache after authorization.
        const guild = await this.client.guilds.fetch({ guild: actor.guildId, force: true });
        if (guild?.id !== guildId) continue;
        result.push({ id: guild.id, name: guild.name, owner: guild.ownerId, ...(guild.memberCount == null ? {} : { memberCount: guild.memberCount }) });
      } catch { /* Fail closed for each guild without hiding the remaining accessible guilds. */ }
    }
    return result;
  }

  private validSession(session: DashboardSession): boolean {
    return !!session && typeof session.userId === 'string' && /^\d{17,20}$/.test(session.userId)
      && Array.isArray(session.oauthGuildIds) && session.oauthGuildIds.length <= 200
      && session.oauthGuildIds.every(id => typeof id === 'string' && /^\d{17,20}$/.test(id));
  }
}

function denied(): AppError { return new AppError('PERMISSION', 'You do not have permission to access this guild.'); }
