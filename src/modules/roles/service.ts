import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, PermissionFlagsBits, StringSelectMenuBuilder, type Client, type Guild, type TextChannel } from 'discord.js';
import { AppError } from '../../core/errors/errors.js';
import { boundedContent, safeMentions } from '../../core/presentation/index.js';
import type { GuildLogNotifier } from '../../services/log-notifier.js';
import type { RoleMenu, RoleMenuOption, RoleMenuRepository, RoleMenuTransaction } from './repository.js';

export const BUTTON_PREFIX = 'role-menu:button:';
export const SELECT_PREFIX = 'role-menu:select:';
const unsafe = PermissionFlagsBits.Administrator | PermissionFlagsBits.ManageGuild | PermissionFlagsBits.ManageRoles |
  PermissionFlagsBits.BanMembers | PermissionFlagsBits.KickMembers | PermissionFlagsBits.ModerateMembers |
  PermissionFlagsBits.ManageChannels | PermissionFlagsBits.ManageWebhooks | PermissionFlagsBits.ManageMessages |
  PermissionFlagsBits.ManageThreads | PermissionFlagsBits.ManageEvents | PermissionFlagsBits.ManageNicknames |
  PermissionFlagsBits.ViewAuditLog | PermissionFlagsBits.MentionEveryone;
const fail = (message: string): never => { throw new AppError('VALIDATION', message); };
export function parsePanelId(customId: string, prefix: string): { menuId: number; optionId?: number; action?: 'add' | 'remove' } {
  if (!customId.startsWith(prefix)) return fail('Unknown role menu control.');
  const parts = customId.slice(prefix.length).split(':');
  const button = prefix === BUTTON_PREFIX;
  if (parts.length !== (button ? 3 : 1) || !(button ? ['add', 'remove'].includes(parts[2]!) : true) ||
      !parts.slice(0, button ? 2 : 1).every(p => /^[1-9]\d*$/.test(p))) return fail('Invalid role menu control.');
  const menuId = Number(parts[0]); const optionId = button ? Number(parts[1]) : undefined;
  if (!Number.isSafeInteger(menuId) || (optionId !== undefined && !Number.isSafeInteger(optionId))) return fail('Invalid role menu control.');
  return { menuId, optionId, ...(button ? { action: parts[2] as 'add' | 'remove' } : {}) };
}
export function panel(menu: RoleMenu, options: RoleMenuOption[]) {
  if (!options.length || options.length > 25) return fail('A panel needs between 1 and 25 options.');
  if (menu.kind === 'BUTTON' && options.length > 12) return fail('Button menus support at most 12 options.');
  if (options.some(option => !option.label || option.label.length > (menu.kind === 'BUTTON' ? 78 : 80)))
    return fail('Option label exceeds Discord component limit.');
  const components = menu.kind === 'BUTTON'
    ? Array.from({ length: Math.ceil(options.length * 2 / 5) }, (_, index) => new ActionRowBuilder<ButtonBuilder>().addComponents(
      options.flatMap(option => [
        new ButtonBuilder().setCustomId(`${BUTTON_PREFIX}${menu.id}:${option.id}:add`).setLabel(`+ ${option.label}`).setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`${BUTTON_PREFIX}${menu.id}:${option.id}:remove`).setLabel(`− ${option.label}`).setStyle(ButtonStyle.Secondary),
      ]).slice(index * 5, index * 5 + 5)))
    : [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(new StringSelectMenuBuilder()
      .setCustomId(`${SELECT_PREFIX}${menu.id}`).setPlaceholder('Choose your roles').setMinValues(0)
      .setMaxValues(menu.exclusive ? 1 : Math.min(menu.maxValues, options.length))
      .addOptions(options.map(option => ({ label: option.label, value: String(option.id), ...(option.description ? { description: option.description } : {}) }))))];
  return { content: boundedContent(`**${menu.name}**\nChoose ${menu.exclusive ? 'at most one role' : `up to ${menu.maxValues} roles`}.`), components, allowedMentions: safeMentions };
}

export class RoleMenuService {
  constructor(private readonly repo: RoleMenuRepository, private readonly client: Client, private readonly notify?: GuildLogNotifier) {}
  private async guild(id: string) { return this.client.guilds.fetch(id); }
  private async safeRole(guild: Guild, roleId: string, tx?: RoleMenuTransaction) {
    const role = await guild.roles.fetch(roleId);
    if (!role || role.id === guild.id || role.managed || role.permissions.any(unsafe) || !role.editable || await this.repo.isPermissionRole(guild.id, roleId, tx)) {
      // Do not await a second database-using notifier while the member advisory-lock transaction holds a pool client.
      if (this.notify) void this.notify(guild.id, 'security', 'Unsafe role menu assignment rejected',
        [{ name: 'Role ID', value: roleId }]).catch(() => {});
      return fail('Role is missing, dangerous, managed, mapped to internal permissions, or above the bot.');
    }
    return role;
  }
  async create(guildId: string, actorId: string, name: string, kind: 'BUTTON' | 'SELECT', exclusive: boolean, maxValues: number) {
    if (!name.trim() || name.length > 100 || !Number.isInteger(maxValues) || maxValues < 1 || maxValues > 25 || (exclusive && maxValues !== 1)) return fail('Invalid menu settings.');
    const created = await this.repo.create({ guildId, createdBy: actorId, name: name.trim(), kind, exclusive, maxValues, enabled: true });
    try { await this.notify?.(guildId, 'general', 'Role menu created', [{ name: 'Menu', value: String(created.id) }]); } catch { /* Optional logging must not fail creation. */ }
    return created;
  }
  async get(guildId: string, id: number, tx?: RoleMenuTransaction) { return await this.repo.get(guildId, id, tx) ?? fail('Role menu not found.'); }
  list(guildId: string) { return this.repo.list(guildId); }
  async edit(guildId: string, id: number, patch: Partial<Pick<RoleMenu, 'name' | 'exclusive' | 'maxValues' | 'enabled'>>) {
    const updated = await this.repo.lockMenu(guildId, id, async (tx, previous) => {
      const exclusive = patch.exclusive ?? previous.exclusive;
      const max = patch.maxValues ?? previous.maxValues;
      if (patch.name !== undefined && (!patch.name.trim() || patch.name.length > 100)) return fail('Invalid menu name.');
      if (!Number.isInteger(max) || max < 1 || max > 25 || (exclusive && max !== 1)) return fail('Invalid maximum (exclusive menus require 1).');
      if (previous.messageId && ((patch.name !== undefined && patch.name.trim() !== previous.name) ||
          (patch.exclusive !== undefined && patch.exclusive !== previous.exclusive) ||
          (patch.maxValues !== undefined && patch.maxValues !== previous.maxValues)))
        return fail('Published panel settings cannot change. Delete and recreate the menu to republish.');
      if (patch.name !== undefined) patch.name = patch.name.trim();
      return this.repo.update(guildId, id, patch, tx);
    });
    if (updated) try { await this.notify?.(guildId, 'general', 'Role menu edited', [{ name: 'Menu', value: String(id) }]); } catch { /* Optional logging must not fail editing. */ }
    return updated;
  }
  async addOption(guildId: string, id: number, roleId: string, label: string, description: string | null, requiredRoleId: string | null, forbiddenRoleId: string | null) {
    const normalized = label.trim();
    if (!normalized || (description && description.length > 100)) return fail('Invalid option label or description.');
    return this.repo.lockMenu(guildId, id, async (tx, menu) => {
      if (menu.messageId) return fail('Edit published menus by deleting and recreating the panel.');
      if (normalized.length > (menu.kind === 'BUTTON' ? 78 : 80)) return fail(`Option label exceeds ${menu.kind === 'BUTTON' ? 78 : 80} characters.`);
      const guild = await this.guild(guildId);
      await this.safeRole(guild, roleId, tx);
      if (requiredRoleId) await guild.roles.fetch(requiredRoleId).then(role => role || fail('Required role does not exist.'));
      if (forbiddenRoleId) await guild.roles.fetch(forbiddenRoleId).then(role => role || fail('Forbidden role does not exist.'));
      const options = await this.repo.options(id, tx);
      if (options.length >= (menu.kind === 'BUTTON' ? 12 : 25) || options.some(option => option.roleId === roleId)) return fail('Menu full or role already added.');
      return this.repo.addOption({ menuId: id, roleId, label: normalized, description, requiredRoleId, forbiddenRoleId, position: options.length }, tx);
    });
  }
  async removeOption(guildId: string, id: number, optionId: number) {
    return this.repo.lockMenu(guildId, id, async (tx, menu) => {
      if (menu.messageId) return fail('Edit published menus by deleting and recreating the panel.');
      return await this.repo.removeOption(id, optionId, tx) ?? fail('Option not found.');
    });
  }
  async publish(guildId: string, id: number, channelId: string) {
    let sent: Awaited<ReturnType<TextChannel['send']>> | undefined;
    try {
      await this.repo.lockMenu(guildId, id, async (tx, menu) => {
        if (!menu.enabled || menu.messageId) return fail('Menu disabled or already published.');
        const guild = await this.guild(guildId);
        const channel = await guild.channels.fetch(channelId);
        if (!channel || channel.type !== ChannelType.GuildText) return fail('Choose a server text channel.');
        const me = await guild.members.fetchMe();
        if (!channel.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) return fail('Bot cannot post to this channel.');
        const options = await this.repo.options(id, tx);
        for (const option of options) await this.safeRole(guild, option.roleId, tx);
        sent = await (channel as TextChannel).send(panel(menu, options));
        const updated = await this.repo.update(guildId, id, { channelId, messageId: sent.id }, tx);
        if (!updated || updated.messageId !== sent.id) return fail('Menu changed while publishing.');
      });
    } catch (error) {
      if (sent) {
        try { await sent.delete(); }
        catch (cleanupError) {
          try { await this.notify?.(guildId, 'security', 'Role menu publish cleanup failed', [
            { name: 'Menu ID', value: String(id) }, { name: 'Channel ID', value: channelId },
            { name: 'Message ID', value: sent.id }, { name: 'Error type', value: cleanupError instanceof Error ? cleanupError.name : 'unknown' },
          ]); } catch { /* Original publish failure remains authoritative. */ }
        }
      }
      throw error;
    }
    try { await this.notify?.(guildId, 'general', 'Role menu published', [{ name: 'Menu', value: String(id) }]); }
    catch { /* Optional logging cannot undo a committed publication. */ }
    return sent!;
  }
  async delete(guildId: string, id: number) {
    const menu = await this.repo.lockMenu(guildId, id, async (tx, current) => {
      await this.repo.delete(guildId, id, tx);
      return current;
    });
    if (menu.channelId && menu.messageId) {
      const channel = await (await this.guild(guildId)).channels.fetch(menu.channelId).catch(() => null);
      if (channel?.isTextBased()) await channel.messages.fetch(menu.messageId).then(message => message.delete()).catch(() => {});
    }
    await this.notify?.(guildId, 'general', 'Role menu deleted', [{ name: 'Menu', value: String(id) }]);
  }
  async interact(guildId: string, menuId: number, userId: string, channelId: string, messageId: string, kind: 'BUTTON' | 'SELECT', optionIds: number[], action?: 'add' | 'remove') {
    const result = await this.repo.locked(guildId, menuId, userId, async tx => {
      const menu = await this.get(guildId, menuId, tx);
      if (!menu.enabled || menu.kind !== kind || !menu.messageId || menu.messageId !== messageId || menu.channelId !== channelId) return fail('This panel is stale or disabled.');
      const options = await this.repo.options(menuId, tx);
      const selected = options.filter(option => optionIds.includes(option.id));
      if (selected.length !== optionIds.length || selected.length > (menu.exclusive ? 1 : menu.maxValues) ||
          (kind === 'BUTTON' && (!action || selected.length !== 1)) || (kind === 'SELECT' && action)) return fail('Invalid role selection.');
      const guild = await this.guild(guildId);
      const member = await guild.members.fetch({ user: userId, force: true });
      for (const option of options) await this.safeRole(guild, option.roleId, tx);
      const current = new Set(member.roles.cache.keys());
      const desired = new Set(current);
      const chosen = new Set(selected.map(option => option.roleId));
      if (kind === 'BUTTON') {
        const roleId = selected[0]!.roleId;
        if (action === 'remove') desired.delete(roleId);
        else { if (menu.exclusive) for (const option of options) desired.delete(option.roleId); desired.add(roleId); }
      } else {
        for (const option of options) desired.delete(option.roleId);
        for (const roleId of chosen) desired.add(roleId);
      }
      if (!menu.exclusive && [...desired].filter(role => options.some(option => option.roleId === role)).length > menu.maxValues) return fail('Too many roles selected.');
      const remove = options.filter(option => current.has(option.roleId) && !desired.has(option.roleId));
      const add = options.filter(option => !current.has(option.roleId) && desired.has(option.roleId));
      for (const option of add) {
        if (option.requiredRoleId && !current.has(option.requiredRoleId)) return fail('You do not have a required role.');
        if (option.forbiddenRoleId && current.has(option.forbiddenRoleId)) return fail('A role you hold prevents this selection.');
      }
      // Reconcile against fresh Discord state under lock; retries after partial failure converge for SELECT.
      for (const option of remove) await member.roles.remove(option.roleId, 'Role menu selection');
      for (const option of add) await member.roles.add(option.roleId, 'Role menu selection');
      return { added: add.length, removed: remove.length };
    });
    if (result.added || result.removed) {
      try { await this.notify?.(guildId, 'general', 'Role menu selection', [{ name: 'Menu', value: String(menuId) }, { name: 'Member', value: userId }]); }
      catch { /* Optional logging never fails a successful mutation. */ }
    }
    return result;
  }
}
