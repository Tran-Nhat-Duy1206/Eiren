import type { Client } from 'discord.js';
import { AppError } from '../../core/errors/errors.js';
import type { Actor, PermissionService } from '../../core/permissions/permission-service.js';
import { defaultReputationConfig, type ReputationConfig, type ReputationRepository } from './repository.js';

export class ReputationService {
  constructor(private readonly repository: ReputationRepository, private readonly permissions: PermissionService,
    private readonly client: Client, private readonly minAccountAgeSeconds = 3600) {}
  async settings(actor: Actor) {
    await this.permissions.require(actor, 'ADMIN');
    return this.repository.settings(actor.guildId);
  }
  async configure(actor: Actor, config: ReputationConfig) {
    await this.permissions.require(actor, 'ADMIN');
    if (!Number.isSafeInteger(config.globalCooldownSeconds) || config.globalCooldownSeconds < 60 || config.globalCooldownSeconds > 604800 ||
      !Number.isSafeInteger(config.sameTargetCooldownSeconds) || config.sameTargetCooldownSeconds < config.globalCooldownSeconds ||
      config.sameTargetCooldownSeconds > 2592000)
      throw new AppError('VALIDATION', 'Global cooldown must be 60–604800 seconds; same-target cooldown must be at least global and at most 2592000 seconds.');
    return this.repository.configure(actor.guildId, config);
  }
  async score(guildId: string, userId: string) { return this.repository.score(guildId, userId); }
  async grant(actor: Actor, receiverId: string, giverIsBot = false, interactionId?: string) {
    await this.permissions.require(actor, 'MEMBER');
    if (giverIsBot || this.client.user?.id === actor.userId) throw new AppError('VALIDATION', 'Bots cannot grant reputation.');
    if (receiverId === actor.userId) throw new AppError('VALIDATION', 'You cannot give reputation to yourself.');
    const guild = await this.client.guilds.fetch(actor.guildId);
    let member, giver;
    try { [giver, member] = await Promise.all([guild.members.fetch(actor.userId), guild.members.fetch(receiverId)]); }
    catch { throw new AppError('NOT_FOUND', 'Both members must be in this server.'); }
    if (!giver || giver.user.bot) throw new AppError('VALIDATION', 'Bots cannot grant reputation.');
    if (!member || member.user.bot) throw new AppError('VALIDATION', 'Choose a human member of this server.');
    if (this.minAccountAgeSeconds > 0 && [giver, member].some(value =>
      Date.now() - value.user.createdAt.getTime() < this.minAccountAgeSeconds * 1000))
      throw new AppError('VALIDATION', 'Both accounts must be at least one hour old to grant reputation.');
    return this.repository.grant(actor.guildId, actor.userId, receiverId, interactionId);
  }
}
export { defaultReputationConfig };
