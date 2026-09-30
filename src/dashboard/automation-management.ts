import { ChannelType, PermissionFlagsBits, type Client } from 'discord.js';
import { z } from 'zod';
import { AppError } from '../core/errors/errors.js';
import { createAutomationDiscordGateway } from '../modules/automation/discord-gateway.js';
import type { AutomationRuleDraft } from '../modules/automation/service.js';

const channelId = z.string().regex(/^\d{17,20}$/);
const actionKind = z.enum(['STATIC_MESSAGE', 'STAFF_LOG']);
const safeText = z.string().min(1).max(1_000);
const draftForm = z.object({
  csrfToken: z.string().max(500),
  automationId: z.string().regex(/^[1-9]\d{0,15}$/).optional(),
  name: z.string().min(1).max(80),
  scheduleKind: z.enum(['daily', 'once']),
  dailyTime: z.string().max(5).optional(),
  onceAt: z.string().max(40).optional(),
  timezone: z.string().min(1).max(64),
  cooldownSeconds: z.coerce.number().int().min(0).max(86_400),
  enabled: z.enum(['true', 'false']),
  action0Type: actionKind,
  action0ChannelId: channelId,
  action0Message: safeText,
  action1Type: z.enum(['NONE', 'STATIC_MESSAGE', 'STAFF_LOG']).default('NONE'),
  action1ChannelId: z.string().max(20).optional(),
  action1Message: z.string().max(1_000).optional(),
}).strict();

/** Form parsing bounds fields; AutomationService remains the authoritative schedule/config validator. */
export function parseAutomationDraft(body: Record<string, string>): AutomationRuleDraft {
  const form = draftForm.parse(body);
  const trigger = form.scheduleKind === 'daily'
    ? { kind: 'daily' as const, time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).parse(form.dailyTime), timezone: form.timezone }
    : { kind: 'once' as const, at: z.string().datetime({ offset: false }).regex(/Z$/).parse(form.onceAt) };
  const actions: { id: 'STATIC_MESSAGE' | 'STAFF_LOG'; version: 1; config: { channelId: string; message: string } }[] = [
    { id: form.action0Type, version: 1, config: { channelId: form.action0ChannelId, message: form.action0Message } },
  ];
  if (form.action1Type !== 'NONE') actions.push({ id: form.action1Type, version: 1,
    config: { channelId: channelId.parse(form.action1ChannelId), message: safeText.parse(form.action1Message) } });
  return { name: form.name, timezone: form.timezone, cooldownSeconds: form.cooldownSeconds,
    config: { schemaVersion: 1, enabled: form.enabled === 'true',
      trigger: { id: 'SCHEDULED', version: 1, config: trigger }, actions } };
}

/** Configuration-time UX check; V7.4 repeats bot/guild/permissions preflight before every real send. */
export async function assertAutomationTargets(client: Client, guildId: string, draft: AutomationRuleDraft): Promise<void> {
  const gateway = createAutomationDiscordGateway(client);
  const channels = new Set(draft.config.actions.map(action => channelId.parse((action.config as { channelId: unknown }).channelId)));
  for (const id of channels) {
    const result = await gateway.preflight(guildId, id);
    if (result.kind !== 'READY') throw new AppError('VALIDATION', 'Select a same-guild text channel with bot view and send permission.');
    // Deliberately NEVER invoke result.send(). Configuration cannot create a Discord message.
  }
}

/** Guild-manager-only REST lookup. The option set is advisory; POST always revalidates. */
export async function eligibleAutomationChannels(client: Client, guildId: string): Promise<{ id: string; name: string }[]> {
  const guild = await client.guilds.fetch({ guild: guildId, force: true });
  if (guild.id !== guildId || !client.user?.id) return [];
  const bot = await guild.members.fetch({ user: client.user.id, force: true });
  const channels = await guild.channels.fetch();
  return [...channels.values()].filter(channel => channel?.guildId === guildId && channel.type === ChannelType.GuildText &&
    channel.permissionsFor(bot)?.has(PermissionFlagsBits.ViewChannel) &&
    channel.permissionsFor(bot)?.has(PermissionFlagsBits.SendMessages))
    .map(channel => ({ id: channel!.id, name: channel!.name })).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)).slice(0, 500);
}
