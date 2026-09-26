import type { Logger } from '../core/logger/logger.js';
import type { GuildRepository } from '../repositories/guild-repository.js';
import type { GuildConfigService } from '../services/guild-config-service.js';
import type { PermissionService } from '../core/permissions/permission-service.js';
import type { ModuleService } from '../services/module-service.js';
import type { ModerationService } from '../modules/moderation/service.js';
import type { GuildLogService } from '../modules/logging/guild-log-service.js';
import type { VerificationService } from '../modules/verification/service.js';
import type { AntiRaidService } from '../modules/antiraid/service.js';
import type { RoleMenuService } from '../modules/roles/service.js';
import type { TicketService } from '../modules/tickets/service.js';
import type { ReportService } from '../modules/reports/service.js';
import type { SuggestionService } from '../modules/suggestions/service.js';

export interface Services {
  logger: Logger;
  repository: GuildRepository;
  guildConfig: GuildConfigService;
  permissions: PermissionService;
  modules: ModuleService;
  moderation: ModerationService;
  guildLogs: GuildLogService;
  verification: VerificationService;
  antiraid: AntiRaidService;
  roles: RoleMenuService;
  tickets: TicketService;
  reports: ReportService;
  suggestions: SuggestionService;
}
