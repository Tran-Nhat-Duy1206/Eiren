import { describe, expect, it } from 'vitest';
import { DEFAULT_WINDOWS, assertOwner, assertRecord, validateWindows } from './contracts.js';

describe('retention contracts', () => {
  it('validates defaults and window bounds', () => {
    expect(DEFAULT_WINDOWS).toEqual({ ticketDays: 90, reportDays: 365, appealDays: 365 });
    expect(() => validateWindows({ ticketDays: 30, reportDays: 90, appealDays: 730 })).not.toThrow();
    expect(() => validateWindows({ ticketDays: 365, reportDays: 730, appealDays: 90 })).not.toThrow();
    for (const invalid of [0, 29, 365.5, NaN, Infinity]) expect(() => validateWindows({ ...DEFAULT_WINDOWS, ticketDays: invalid })).toThrow();
    expect(() => validateWindows({ ...DEFAULT_WINDOWS, reportDays: 731 })).toThrow();
    expect(() => validateWindows({ ...DEFAULT_WINDOWS, appealDays: 89 })).toThrow();
  });
  it('requires the exact guild owner identity', () => {
    expect(() => assertOwner({ userId: 'owner', guildOwnerId: 'owner', guildId: 'guild' })).not.toThrow();
    expect(() => assertOwner({ userId: 'other', guildOwnerId: 'owner', guildId: 'guild' })).toThrow();
    expect(() => assertOwner({ userId: '', guildOwnerId: '', guildId: 'guild' })).toThrow();
  });
  it('requires a positive safe integer record ID', () => {
    expect(() => assertRecord('REPORT', 1)).not.toThrow();
    expect(() => assertRecord('TICKET', 0)).toThrow();
    expect(() => assertRecord('APPEAL', 1.5)).toThrow();
    expect(() => assertRecord('OTHER' as 'TICKET', 3)).toThrow();
  });
});
