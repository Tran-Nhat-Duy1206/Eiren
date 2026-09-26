import { describe, expect, it } from 'vitest';
import { eventListContent, eventViewContent } from './commands.js';
import type { CommunityEvent } from './repository.js';

const event = { id: 42, title: 'A'.repeat(256), description: 'D'.repeat(2000),
  startAt: new Date('2030-06-01T18:00:00Z'), endAt: new Date('2030-06-01T20:00:00Z'),
  maxParticipants: 10000, status: 'SCHEDULED' } as CommunityEvent;

describe('bounded event command replies', () => {
  it('lists all twenty maximal-title records without cutting a record', () => {
    const rows = Array.from({ length: 20 }, (_, index) => ({ ...event, id: 900000000000000 + index }));
    const message = eventListContent(rows);
    expect(message.length).toBeLessThanOrEqual(2000);
    expect(message.split('\n')).toHaveLength(20);
    expect(message).toContain(`#${rows[19]!.id} `);
    expect(message).toContain('…');
  });
  it('keeps the event header and indicates description truncation', () => {
    const message = eventViewContent(event, 10000);
    expect(message.length).toBeLessThanOrEqual(2000);
    expect(message).toContain('Event #42');
    expect(message).toContain('10000/10000 attending');
    expect(message).toMatch(/…$/);
  });
});
