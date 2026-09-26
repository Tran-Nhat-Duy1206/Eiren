export type AchievementCategory = 'levels' | 'reputation' | 'events' | 'giveaways';
export type Achievement = Readonly<{ id: string; name: string; description: string; category: AchievementCategory }>;
/** IDs are permanent persisted identifiers. Add new entries; never repurpose existing IDs. */
export const ACHIEVEMENTS_VERSION = 1;
export const ACHIEVEMENTS: readonly Achievement[] = Object.freeze([
  { id: 'first-message', name: 'First Steps', description: 'Earn XP from your first qualifying message.', category: 'levels' },
  { id: 'messages-100', name: 'Conversation Starter', description: 'Earn XP from 100 qualifying messages.', category: 'levels' },
  { id: 'level-5', name: 'Rising Star', description: 'Reach level 5.', category: 'levels' },
  { id: 'level-10', name: 'Veteran', description: 'Reach level 10.', category: 'levels' },
  { id: 'reputation-1', name: 'Appreciated', description: 'Receive your first reputation point.', category: 'reputation' },
  { id: 'reputation-10', name: 'Community Favorite', description: 'Receive 10 reputation points.', category: 'reputation' },
  { id: 'event-rsvp-1', name: 'Count Me In', description: 'RSVP to an event.', category: 'events' },
  { id: 'event-attendance-1', name: 'Showed Up', description: 'Be explicitly marked as attending an event.', category: 'events' },
  { id: 'giveaway-win-1', name: 'Lucky Winner', description: 'Win a giveaway.', category: 'giveaways' },
]);
