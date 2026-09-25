import type { Logger } from '../core/logger/logger.js';
import type { GuildRepository } from '../repositories/guild-repository.js';
import type { GuildConfigService } from '../services/guild-config-service.js';
import type { PermissionService } from '../core/permissions/permission-service.js';
import type { ModuleService } from '../services/module-service.js';

export interface Services {
  logger: Logger;
  repository: GuildRepository;
  guildConfig: GuildConfigService;
  permissions: PermissionService;
  modules: ModuleService;
}
