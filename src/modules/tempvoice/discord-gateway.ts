import { ChannelType, DiscordAPIError, PermissionFlagsBits, type Guild, type PermissionOverwrites, type VoiceChannel } from 'discord.js';
import { AppError } from '../../core/errors/errors.js';

function overwritePermissions(overwrite: PermissionOverwrites) {
  return Object.fromEntries(Object.entries(PermissionFlagsBits).map(([name, bit]) => [name, overwrite.allow.has(bit) ? true : overwrite.deny.has(bit) ? false : null])) as Parameters<VoiceChannel['permissionOverwrites']['edit']>[1];
}
export interface TempvoiceGateway {
  validate(lobbyId: string, categoryId: string): Promise<void>;
  member(id: string): Promise<boolean>;
  humanMember(id: string): Promise<boolean>;
  findReservation(roomId: number, ownerId: string): Promise<string[]>;
  seal(channelId: string): Promise<() => Promise<void>>;
  inChannel(id: string, channelId: string): Promise<boolean>;
  create(categoryId: string, ownerId: string, roomId: number, name: string, limit: number, privateRoom: boolean): Promise<string>;
  move(id: string, channelId: string): Promise<void>;
  exists(channelId: string): Promise<boolean>;
  occupants(channelId: string): Promise<string[]>;
  delete(channelId: string): Promise<void>;
  rename(channelId: string, name: string): Promise<void>;
  limit(channelId: string, limit: number): Promise<void>;
  lock(channelId: string, locked: boolean): Promise<void>;
  access(channelId: string, id: string, allowed: boolean): Promise<void>;
  kick(channelId: string, id: string): Promise<void>;
  transfer(channelId: string, oldOwner: string, newOwner: string): Promise<() => Promise<void>>;
}
export class DiscordTempvoiceGateway implements TempvoiceGateway {
  constructor(private readonly guild: Guild) {}
  private async voice(id: string): Promise<VoiceChannel> {
    let channel;
    try { channel = await this.guild.channels.fetch(id); }
    catch (error) {
      if (error instanceof DiscordAPIError && error.code === 10003) throw new AppError('NOT_FOUND', 'Voice channel is unavailable.');
      throw error;
    }
    if (!channel || channel.guildId !== this.guild.id || channel.type !== ChannelType.GuildVoice) throw new AppError('NOT_FOUND', 'Voice channel is unavailable.');
    return channel;
  }
  async validate(lobbyId: string, categoryId: string) {
    await this.voice(lobbyId);
    const category = await this.guild.channels.fetch(categoryId);
    if (!category || category.guildId !== this.guild.id || category.type !== ChannelType.GuildCategory) throw new AppError('VALIDATION', 'Choose a category in this server.');
    const me = await this.guild.members.fetchMe();
    if (!me.permissions.has(PermissionFlagsBits.ManageChannels) || !me.permissions.has(PermissionFlagsBits.MoveMembers) || !me.permissions.has(PermissionFlagsBits.ManageRoles))
      throw new AppError('PERMISSION', 'Bot needs Manage Channels, Move Members and Manage Roles.');
  }
  async member(id: string) { try { return !!await this.guild.members.fetch(id); } catch { return false; } }
  async humanMember(id: string) { try { const member = await this.guild.members.fetch(id); return !member.user.bot; } catch { return false; } }
  async findReservation(roomId: number, ownerId: string) {
    const channels = await this.guild.channels.fetch();
    const marker = `temp-${roomId}-`;
    return [...channels.values()].filter(channel => channel?.guildId === this.guild.id && channel.type === ChannelType.GuildVoice && channel.name.startsWith(marker) && !!channel.permissionOverwrites.cache.get(ownerId)?.allow.has(PermissionFlagsBits.Connect) && !!channel.permissionOverwrites.cache.get(this.guild.client.user!.id)?.allow.has(PermissionFlagsBits.ManageChannels)).map(channel => channel!.id);
  }
  /** Best-effort barrier against fresh joins; Discord does not offer atomic check-and-delete. */
  async seal(id: string) {
    const channel = await this.voice(id);
    const original = channel.permissionOverwrites.cache.get(this.guild.id);
    await channel.permissionOverwrites.edit(this.guild.id, { Connect: false });
    return async () => {
      if (original) await channel.permissionOverwrites.edit(this.guild.id, overwritePermissions(original));
      else await channel.permissionOverwrites.delete(this.guild.id);
    };
  }
  async inChannel(id: string, channelId: string) { try { return (await this.guild.members.fetch(id)).voice.channelId === channelId; } catch { return false; } }
  async create(categoryId: string, ownerId: string, roomId: number, name: string, limit: number, privateRoom: boolean) {
    const botId = this.guild.client.user?.id;
    if (!botId) throw new AppError('VALIDATION', 'Bot identity unavailable.');
    const channel = await this.guild.channels.create({ type: ChannelType.GuildVoice, name: `temp-${roomId}-${name}`.slice(0, 100), parent: categoryId, userLimit: limit,
      permissionOverwrites: [
        { id: this.guild.id, deny: privateRoom ? [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect] : [], allow: privateRoom ? [] : [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect] },
        { id: ownerId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect] },
        { id: botId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.MoveMembers] },
      ], reason: `Eiren temporary voice room for ${ownerId}` });
    return channel.id;
  }
  async move(id: string, channelId: string) { await (await this.guild.members.fetch(id)).voice.setChannel(await this.voice(channelId)); }
  async exists(id: string) { try { await this.voice(id); return true; } catch (error) { if (error instanceof AppError && error.code === 'NOT_FOUND') return false; throw error; } }
  async occupants(id: string) { const channel = await this.voice(id); await this.guild.members.fetch(); return [...channel.members.keys()]; }
  async delete(id: string) { try { await (await this.voice(id)).delete('Temporary voice room empty'); } catch (error) { if (error instanceof AppError && error.code === 'NOT_FOUND') return; if (error instanceof DiscordAPIError && error.code === 10003) return; throw error; } }
  async rename(id: string, name: string) { const channel = await this.voice(id); const marker = channel.name.match(/^temp-\d+-/); if (!marker) throw new AppError('CONFLICT', 'Room reservation marker is missing.'); await channel.setName(`${marker[0]}${name}`.slice(0, 100)); }
  async limit(id: string, limit: number) { await (await this.voice(id)).setUserLimit(limit); }
  async lock(id: string, locked: boolean) { await (await this.voice(id)).permissionOverwrites.edit(this.guild.id, { Connect: locked ? false : true }); }
  async access(id: string, userId: string, allowed: boolean) {
    const channel = await this.voice(id);
    if (allowed) await channel.permissionOverwrites.edit(userId, { ViewChannel: true, Connect: true });
    else await channel.permissionOverwrites.edit(userId, { ViewChannel: false, Connect: false });
  }
  async kick(id: string, userId: string) { if (!await this.inChannel(userId, id)) throw new AppError('NOT_FOUND', 'Member is not in your room.'); await (await this.guild.members.fetch(userId)).voice.disconnect('Removed from temporary voice room'); }
  async transfer(id: string, oldOwner: string, newOwner: string) {
    const channel = await this.voice(id);
    const old = channel.permissionOverwrites.cache.get(oldOwner);
    const next = channel.permissionOverwrites.cache.get(newOwner);
    const restore = async () => {
      if (old) await channel.permissionOverwrites.edit(oldOwner, overwritePermissions(old));
      else await channel.permissionOverwrites.delete(oldOwner);
      if (next) await channel.permissionOverwrites.edit(newOwner, overwritePermissions(next));
      else await channel.permissionOverwrites.delete(newOwner);
    };
    try {
      await channel.permissionOverwrites.edit(newOwner, { ViewChannel: true, Connect: true });
      if (old) await channel.permissionOverwrites.delete(oldOwner);
    } catch (error) { await restore(); throw error; }
    return restore;
  }
}
