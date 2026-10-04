/** Fixed SSR PRG notices, never user text or session flash state. Strict V7/V8 query contracts stay unchanged. */
const entries = {
  'module-updated': ['settings', 'Module availability updated. Historical data is not deleted.'],
  'timezone-updated': ['settings', 'Server timezone updated.'],
  'warning-recorded': ['moderation', 'Warning action completed. Review the current case metadata.'],
  'ticket-closed': ['tickets', 'Ticket action completed. Review the current ticket status.'],
  'suggestion-updated': ['suggestions', 'Suggestion status updated.'],
  'levels-updated': ['levels', 'Level configuration updated.'],
  'event-cancelled': ['events', 'Event action completed. Review the current event status.'],
  'giveaway-ended': ['giveaways', 'Giveaway action completed. Review its current status and result evidence.'],
  'analytics-updated': ['analytics', 'Analytics configuration updated.'],
  'role-updated': ['roles', 'Permission mapping updated. Server-side authorization remains authoritative.'],
} as const;
const actionKeys: Readonly<Record<string, keyof typeof entries>> = {
  'module-toggle':'module-updated', 'guild-timezone':'timezone-updated', 'moderation-warn':'warning-recorded',
  'ticket-close':'ticket-closed', 'suggestion-status':'suggestion-updated', 'levels-config':'levels-updated',
  'event-cancel':'event-cancelled', 'giveaway-end':'giveaway-ended', 'analytics-toggle':'analytics-updated',
  'analytics-retention':'analytics-updated', 'role-set':'role-updated', 'role-remove':'role-updated',
};
export function noticeForPage(page: string, key: unknown): string | undefined {
  if (typeof key !== 'string' || !Object.hasOwn(entries, key)) return undefined;
  const entry = entries[key as keyof typeof entries]; return entry[0] === page ? entry[1] : undefined;
}
export const noticeKeyForAction = (action: string): string | undefined => Object.hasOwn(actionKeys, action) ? actionKeys[action] : undefined;
