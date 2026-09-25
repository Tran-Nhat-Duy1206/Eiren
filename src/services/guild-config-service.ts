import { AppError } from '../core/errors/errors.js';
import type { GuildRepository, SettingChanges } from '../repositories/guild-repository.js';

const snowflake = /^\d{17,20}$/;
export const configurableFields = {
  language: 'language', timezone: 'timezone',
  log_channel: 'logChannelId', mod_log_channel: 'modLogChannelId', security_log_channel: 'securityLogChannelId',
  welcome_channel: 'welcomeChannelId', ticket_category: 'ticketCategoryId',
  verified_role: 'verifiedRoleId', quarantine_role: 'quarantineRoleId',
} as const;
export type ConfigField = keyof typeof configurableFields;

export class GuildConfigService {
  constructor(private readonly repository: GuildRepository) {}
  setup(guildId: string) { return this.repository.setup(guildId); }
  get(guildId: string) { return this.repository.getSettings(guildId); }
  async update(guildId: string, field: ConfigField, value: string | null) {
    const key = configurableFields[field];
    if (!key) throw new AppError('VALIDATION', 'Unknown setting.');
    if (field === 'language' && (value !== 'en')) throw new AppError('VALIDATION', 'Only en is currently supported.');
    if (field === 'timezone') {
      if (!value) throw new AppError('VALIDATION', 'Timezone cannot be cleared.');
      try { new Intl.DateTimeFormat('en', { timeZone: value }); }
      catch { throw new AppError('VALIDATION', 'Enter a valid IANA timezone.'); }
    }
    if (field !== 'language' && field !== 'timezone' && value !== null && !snowflake.test(value)) {
      throw new AppError('VALIDATION', 'Expected a Discord channel or role ID.');
    }
    const changes = { [key]: value } as SettingChanges;
    const updated = await this.repository.updateSettings(guildId, changes);
    if (!updated) throw new AppError('NOT_FOUND', 'Run /setup first.');
    return updated;
  }
}
