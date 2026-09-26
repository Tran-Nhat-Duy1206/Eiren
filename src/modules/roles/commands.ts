import { MessageFlags, SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import type { Command } from '../../core/commands/command.js';
import { AppError } from '../../core/errors/errors.js';
import type { Services } from '../../app/services.js';

const data = new SlashCommandBuilder().setName('role-menu').setDescription('Configure self-assignable role menus')
  .addSubcommand(s => s.setName('create').setDescription('Create a role menu')
    .addStringOption(o => o.setName('name').setDescription('Menu title').setRequired(true))
    .addStringOption(o => o.setName('kind').setDescription('Control style').setRequired(true).addChoices({ name: 'Buttons', value: 'BUTTON' }, { name: 'Select', value: 'SELECT' }))
    .addBooleanOption(o => o.setName('exclusive').setDescription('Only one role at a time').setRequired(true))
    .addIntegerOption(o => o.setName('max').setDescription('Maximum selected roles (1 for exclusive)').setMinValue(1).setMaxValue(25)))
  .addSubcommand(s => s.setName('edit').setDescription('Edit menu settings')
    .addIntegerOption(o => o.setName('id').setDescription('Menu ID').setRequired(true))
    .addStringOption(o => o.setName('name').setDescription('New title'))
    .addBooleanOption(o => o.setName('exclusive').setDescription('Only one role'))
    .addIntegerOption(o => o.setName('max').setDescription('Maximum roles').setMinValue(1).setMaxValue(25))
    .addBooleanOption(o => o.setName('enabled').setDescription('Allow selections')))
  .addSubcommand(s => s.setName('add-option').setDescription('Add a role to an unpublished menu')
    .addIntegerOption(o => o.setName('id').setDescription('Menu ID').setRequired(true))
    .addRoleOption(o => o.setName('role').setDescription('Self-assignable role').setRequired(true))
    .addStringOption(o => o.setName('label').setDescription('Button/select label').setRequired(true))
    .addStringOption(o => o.setName('description').setDescription('Select description'))
    .addRoleOption(o => o.setName('required-role').setDescription('Member must have this role'))
    .addRoleOption(o => o.setName('forbidden-role').setDescription('Member must not have this role')))
  .addSubcommand(s => s.setName('remove-option').setDescription('Remove an option from an unpublished menu')
    .addIntegerOption(o => o.setName('id').setDescription('Menu ID').setRequired(true))
    .addIntegerOption(o => o.setName('option-id').setDescription('Option ID').setRequired(true)))
  .addSubcommand(s => s.setName('delete').setDescription('Delete a menu and its posted panel')
    .addIntegerOption(o => o.setName('id').setDescription('Menu ID').setRequired(true)))
  .addSubcommand(s => s.setName('list').setDescription('List menus'))
  .addSubcommand(s => s.setName('publish').setDescription('Post a menu in a channel')
    .addIntegerOption(o => o.setName('id').setDescription('Menu ID').setRequired(true))
    .addChannelOption(o => o.setName('channel').setDescription('Server text channel').setRequired(true)));

export const roleMenuCommand: Command = {
  data, moduleKey: 'roles', requiredLevel: 'ADMIN',
  async execute(interaction: ChatInputCommandInteraction, services: Services) {
    if (!interaction.guildId) throw new AppError('VALIDATION', 'Use this command in a server.');
    const guildId = interaction.guildId;
    const o = interaction.options;
    const sub = o.getSubcommand();
    const id = o.getInteger('id');
    const roles = services.roles;
    let text: string;
    if (sub === 'create') {
      const menu = await roles.create(guildId, interaction.user.id, o.getString('name', true), o.getString('kind', true) as 'BUTTON' | 'SELECT', o.getBoolean('exclusive', true), o.getInteger('max') ?? 1);
      text = `Created role menu #${menu.id}. Add options, then publish.`;
    } else if (sub === 'list') {
      const menus = await roles.list(guildId);
      text = menus.length ? menus.map(m => `#${m.id} ${m.name} (${m.kind}, ${m.enabled ? 'enabled' : 'disabled'}, ${m.messageId ? 'published' : 'draft'})`).join('\n').slice(0, 1900) : 'No role menus yet.';
    } else {
      if (!id || id < 1) throw new AppError('VALIDATION', 'Invalid menu ID.');
      if (sub === 'edit') {
        const patch = { ...(o.getString('name') !== null ? { name: o.getString('name')! } : {}), ...(o.getBoolean('exclusive') !== null ? { exclusive: o.getBoolean('exclusive')! } : {}), ...(o.getInteger('max') !== null ? { maxValues: o.getInteger('max')! } : {}), ...(o.getBoolean('enabled') !== null ? { enabled: o.getBoolean('enabled')! } : {}) };
        await roles.edit(guildId, id, patch); text = `Updated role menu #${id}.`;
      } else if (sub === 'add-option') {
        const option = await roles.addOption(guildId, id, o.getRole('role', true).id, o.getString('label', true), o.getString('description'), o.getRole('required-role')?.id ?? null, o.getRole('forbidden-role')?.id ?? null);
        text = `Added option #${option.id}.`;
      } else if (sub === 'remove-option') {
        await roles.removeOption(guildId, id, o.getInteger('option-id', true)); text = 'Option removed.';
      } else if (sub === 'delete') {
        await roles.delete(guildId, id); text = `Deleted role menu #${id}.`;
      } else if (sub === 'publish') {
        const message = await roles.publish(guildId, id, o.getChannel('channel', true).id); text = `Published role menu #${id} (message ${message.id}).`;
      } else throw new AppError('VALIDATION', 'Unknown role menu action.');
    }
    if (interaction.deferred) await interaction.editReply({ content: text });
    else await interaction.reply({ content: text, flags: MessageFlags.Ephemeral });
  },
};
export const roleMenuCommands: Command[] = [roleMenuCommand];
