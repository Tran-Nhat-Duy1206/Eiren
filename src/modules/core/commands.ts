import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import type { Command } from '../../core/commands/command.js';
import type { Actor, PermissionLevel } from '../../core/permissions/permission-service.js';
import { AppError } from '../../core/errors/errors.js';
import { boundedContent, safeMentions } from '../../core/presentation/index.js';
import { configurableFields, type ConfigField } from '../../services/guild-config-service.js';

function guildId(interaction: ChatInputCommandInteraction): string {
  if (!interaction.guildId) throw new AppError('VALIDATION', 'Use this in a server.');
  return interaction.guildId;
}
async function actorFor(interaction: ChatInputCommandInteraction): Promise<Actor> {
  if (!interaction.guild) throw new AppError('VALIDATION', 'Use this in a server.');
  const member = await interaction.guild.members.fetch(interaction.user.id);
  return { guildId: interaction.guild.id, guildOwnerId: interaction.guild.ownerId,
    userId: interaction.user.id, roleIds: [...member.roles.cache.keys()] };
}
const configChoices = Object.keys(configurableFields).map(name => ({ name, value: name }));

export const setupCommand: Command = {
  moduleKey: 'core', requiredLevel: 'GUILD_OWNER',
  data: new SlashCommandBuilder().setName('setup').setDescription('Initialize this server with safe defaults'),
  async execute(interaction, services) {
    const before = await services.guildConfig.get(guildId(interaction));
    const settings = await services.guildConfig.setup(guildId(interaction));
    await interaction.editReply({ allowedMentions: safeMentions, content: `${before ? 'Already initialized' : 'Setup complete'}. Language: ${settings.language}; timezone: ${settings.timezone}. Use /config to manage settings.` });
  },
};

export const configCommand: Command = {
  moduleKey: 'core',
  requiredLevel: interaction => ['role-set', 'role-remove', 'roles'].includes(interaction.options.getSubcommand()) ? 'GUILD_OWNER' : 'ADMIN',
  data: new SlashCommandBuilder().setName('config').setDescription('Manage this server configuration')
    .addSubcommand(sub => sub.setName('view').setDescription('Show current settings'))
    .addSubcommand(sub => sub.setName('set').setDescription('Update a server setting')
      .addStringOption(opt => opt.setName('field').setDescription('Setting').setRequired(true).addChoices(...configChoices))
      .addStringOption(opt => opt.setName('value').setDescription('Value: en, timezone, or Discord ID; clear to unset').setRequired(true)))
    .addSubcommand(sub => sub.setName('role-set').setDescription('Guild owner: map a role to a bot permission level')
      .addRoleOption(opt => opt.setName('role').setDescription('Role to map').setRequired(true))
      .addStringOption(opt => opt.setName('level').setDescription('Permission level').setRequired(true)
        .addChoices(...(['HELPER', 'MODERATOR', 'SENIOR_MODERATOR', 'ADMIN'] as const).map(level => ({ name: level, value: level })))))
    .addSubcommand(sub => sub.setName('role-remove').setDescription('Guild owner: remove a role mapping')
      .addRoleOption(opt => opt.setName('role').setDescription('Mapped role').setRequired(true)))
    .addSubcommand(sub => sub.setName('roles').setDescription('Guild owner: view permission mappings')),
  async execute(interaction, services) {
    const id = guildId(interaction);
    if (!await services.guildConfig.get(id)) throw new AppError('NOT_FOUND', 'Run /setup first.');
    const action = interaction.options.getSubcommand();
    if (action === 'view') {
      const settings = await services.guildConfig.get(id);
      if (!settings) throw new AppError('NOT_FOUND', 'Run /setup first.');
      const fields = Object.entries(configurableFields).map(([label, key]) => `${label}: ${settings[key] ?? 'not set'}`);
      await interaction.editReply({ allowedMentions: safeMentions, content: boundedContent(fields.join('\n')) });
    } else if (action === 'set') {
      const field = interaction.options.getString('field', true) as ConfigField;
      const input = interaction.options.getString('value', true).trim();
      const value = input.toLowerCase() === 'clear' ? null : input;
      await services.guildConfig.update(id, field, value);
      await interaction.editReply({ allowedMentions: safeMentions, content: `Updated ${field}.` });
    } else if (action === 'roles') {
      const mappings = await services.repository.getRoleMappings(id);
      await interaction.editReply({ allowedMentions: safeMentions, content: boundedContent(mappings.length ? mappings.map(mapping => `${mapping.roleId}: ${mapping.level}`).join('\n') : 'No role mappings configured.') });
    } else if (action === 'role-set') {
      const role = interaction.options.getRole('role', true);
      const level = interaction.options.getString('level', true) as PermissionLevel;
      await services.permissions.setRole(await actorFor(interaction), role.id, level, services.repository);
      await interaction.editReply({ allowedMentions: safeMentions, content: `Mapped ${role.name} to ${level}.` });
    } else if (action === 'role-remove') {
      const role = interaction.options.getRole('role', true);
      await services.permissions.removeRole(await actorFor(interaction), role.id, services.repository);
      await interaction.editReply({ allowedMentions: safeMentions, content: `Removed mapping for ${role.name}.` });
    }
  },
};

export const moduleCommand: Command = {
  moduleKey: 'core', requiredLevel: 'ADMIN',
  data: new SlashCommandBuilder().setName('module').setDescription('Manage optional modules')
    .addSubcommand(sub => sub.setName('enable').setDescription('Enable a module')
      .addStringOption(opt => opt.setName('name').setDescription('Registered module key').setRequired(true)))
    .addSubcommand(sub => sub.setName('disable').setDescription('Disable a module')
      .addStringOption(opt => opt.setName('name').setDescription('Registered module key').setRequired(true)))
    .addSubcommand(sub => sub.setName('list').setDescription('Show available modules')),
  async execute(interaction, services) {
    const id = guildId(interaction);
    if (!await services.guildConfig.get(id)) throw new AppError('NOT_FOUND', 'Run /setup first.');
    const action = interaction.options.getSubcommand();
    if (action === 'list') {
      const modules = await services.modules.list(id);
      await interaction.editReply({ allowedMentions: safeMentions, content: boundedContent(modules.length ? modules.map(module => `${module.key}: ${module.enabled ? 'enabled' : 'disabled'}`).join('\n') : 'No optional production modules are installed in V0.') });
      return;
    }
    const name = interaction.options.getString('name', true).trim();
    await services.modules.setEnabled(id, name, action === 'enable', interaction.user.id);
    await interaction.editReply({ allowedMentions: safeMentions, content: `${name} ${action === 'enable' ? 'enabled' : 'disabled'}.` });
  },
};

export const coreCommands = [setupCommand, configCommand, moduleCommand];
