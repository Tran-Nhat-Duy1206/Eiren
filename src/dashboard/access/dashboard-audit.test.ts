import { describe, expect, it, vi } from 'vitest';
import { dashboardAuditLog } from '../../core/database/schema.js';
import { DashboardAudit } from './dashboard-audit.js';

const guildId = '222222222222222222';
const actorUserId = '111111111111111111';

describe('DashboardAudit', () => {
  it('inserts only whitelisted metadata and never a request body or secret', async () => {
    const values = vi.fn(async (_value: Record<string, unknown>) => undefined);
    const insert = vi.fn(() => ({ values }));
    const audit = new DashboardAudit({ insert } as never);
    const entry = { guildId, actorUserId, action: 'guild.update', targetType: 'guild', targetId: guildId,
      success: false, requestId: 'req_42', body: { secret: 'do-not-store' }, accessToken: 'do-not-store' };
    await audit.record(entry);
    expect(insert).toHaveBeenCalledWith(dashboardAuditLog);
    expect(values).toHaveBeenCalledWith(expect.objectContaining({ guildId, actorUserId, action: 'guild.update', success: false }));
    expect(JSON.stringify(values.mock.calls)).not.toContain('do-not-store');
    expect(Object.keys(values.mock.calls[0]![0] as object).sort()).toEqual([
      'action', 'actorUserId', 'createdAt', 'guildId', 'requestId', 'success', 'targetId', 'targetType',
    ]);
  });
  it('rejects payload-looking metadata', async () => {
    const insert = vi.fn();
    const audit = new DashboardAudit({ insert } as never);
    await expect(audit.record({ guildId, actorUserId, action: '{"password":"abc"}', targetType: 'guild', success: true, requestId: 'req_42' }))
      .rejects.toThrow('Invalid dashboard audit metadata');
    expect(insert).not.toHaveBeenCalled();
  });
});
