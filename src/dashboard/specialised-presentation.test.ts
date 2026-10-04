import { describe, expect, it } from 'vitest';
import { renderAutomationDashboard, type AutomationDashboardView } from './automation-ui.js';
import { renderRetentionDashboard, type RetentionView } from './retention-ui.js';
import { renderPrivacyDashboard, type PrivacyInspection } from './privacy-ui.js';
import { renderOperationsDashboard } from './operations-ui.js';
import { operationsFixture } from '../app/v84-operations-fixtures.js';

const guildId = '123456789012345678';
const now = '2026-09-01T00:00:00.000Z';
const automation: AutomationDashboardView = {
  moduleEnabled: false, channels: [{ id: 'channel', name: '<unsafe channel>' }], rules: [], executions: [],
  selectedExecution: { id: 'execution', automationId: 1, automationName: '<unsafe name>', triggerKey: 'SCHEDULED', status: 'UNCERTAIN', attempts: 1, createdAt: now, completedAt: null, safeErrorCode: null, configVersion: 1, moduleEpoch: 0,
    actions: [{ position: 0, actionKey: 'STATIC_MESSAGE', actionVersion: 1, status: 'UNCERTAIN', attempts: 1, discordMessageId: null, safeErrorCode: null, updatedAt: now, reconciliationResult: null, reconciledBy: null, reconciledAt: null }],
    reconciliation: [{ position: 0, allowSent: true, allowNotSent: false }] },
};
const retention: RetentionView = { policy: { enabled: false, ticketDays: 30, reportDays: 90, appealDays: 90, version: 1, confirmedBy: null, confirmedAt: null }, eligibleCounts: { ticket: 0, report: 1, appeal: 2 }, holdCounts: { ticket: 1, report: 0, appeal: 0 }, activeHolds: [], recentReceipts: [] };
const privacy: PrivacyInspection = {
  request: { id: 'request', guildId, subjectUserId: 'SYNTHETIC_SUBJECT_ID', status: 'PREVIEWED', version: 1, requestedAt: now, subjectVerifiedAt: now, verificationMethod: 'SELF_GUILD_MEMBER', previewedBy: null, previewedAt: null, confirmedBy: null, confirmedAt: null, confirmedPreviewId: null, executedAt: null, deniedBy: null, deniedAt: null, denialCode: null, terminalAt: null },
  inventory: { counts: [{ category: 'MEMBER_LEVEL_STATE', disposition: 'ERASE', count: 1 }, { category: 'MODERATION_ACCOUNTABILITY', disposition: 'RETAIN', count: 2 }], eligibleTotal: 1, retainedTotal: 2, hash: 'hash' },
  preview: { id: 'preview', requestId: 'request', guildId, subjectUserId: 'SYNTHETIC_SUBJECT_ID', reviewedBy: 'owner', requestVersion: 1, createdAt: now, expiresAt: now, consumedAt: null, counts: [], eligibleTotal: 0, retainedTotal: 0, hash: 'hash' },
  receipt: null, workflowEvidence: '<private unsafe evidence>', auditGaps: [{ id: 'gap', actorUserId: 'owner', action: 'privacy-confirm', targetType: 'request', targetId: 'request', committedAt: now, detectedAt: now }],
};
function accessible(html: string) {
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
  expect(new Set(ids).size).toBe(ids.length);
  for (const match of html.matchAll(/aria-describedby="([^"]+)"/g)) for (const id of match[1]!.split(' ')) expect(ids).toContain(id);
  for (const match of html.matchAll(/<(?:input|select|textarea)\b[^>]*>/g)) {
    const control = match[0];
    if (control.includes('type="hidden"')) continue;
    expect(control).toMatch(/\bid="[^"]+"/);
    expect(control).toMatch(/aria-describedby="[^"]+"/);
    const id = /\bid="([^"]+)"/.exec(control)![1];
    const before = html.slice(0, match.index);
    const wrappingLabel = before.lastIndexOf('<label>') > before.lastIndexOf('</label>');
    expect(html.includes(`for="${id}"`) || wrappingLabel).toBe(true);
  }
  for (const table of html.matchAll(/<div class="table-wrap"[^>]*><table>([^]*?)<\/table><\/div>/g)) {
    expect(table[0]).toContain('role="region"'); expect(table[0]).toContain('tabindex="0"');
    expect(table[0]).toContain('aria-label="'); expect(table[1]).toContain('<caption>');
    expect(table[1]).toContain('scope="col"');
  }
  expect(html).not.toMatch(/<script|javascript:|on(?:click|load|error)=/i);
}
describe('V8.5C specialised presentation safety', () => {
  it('Automation keeps scoped controls, constraints and guarded uncertainty reconciliation', () => {
    const html = renderAutomationDashboard({ guildId, csrfToken: 'csrf', data: automation }); accessible(html);
    expect(html).toMatch(/class="[^"]*\bstatus-warning\b[^"]*" data-status="UNCERTAIN"/);
    expect(html).toContain('The external side effect cannot be proven. Do not blindly retry; inspect and reconcile.');
    expect(html).toContain('notice-warning'); expect(html).not.toContain('role="alert"');
    expect(html).toContain('/action/automation-reconcile-sent'); expect(html).not.toContain('/action/automation-reconcile-not-sent');
    expect(html).toContain('maxlength="1000"'); expect(html).toContain('min="0" max="86400" step="1"');
    expect(html).toContain('name="confirm" value="yes" required'); expect(html).toContain('I confirm this action');
    expect(html).toContain('&lt;unsafe name&gt;'); expect(html).toContain('No automation rules yet.');
  });
  it('Retention separates eligible and held records and preserves owner-only forms', () => {
    const preview = { id: 'preview', guildId, requestedBy: 'owner', ticketDays: 30, reportDays: 90, appealDays: 90, eligibleCounts: retention.eligibleCounts, baseVersion: 1, createdAt: now, expiresAt: now };
    const html = renderRetentionDashboard(guildId, 'csrf', retention, preview, true); accessible(html);
    expect(html).toContain('DB-only retention'); for (const copy of ['Discord copies/messages', 'downloaded exports', 'screenshots', 'historical backups']) expect(html).toContain(copy);
    expect(html).toContain('Enabling or changing this policy may redact eligible database records.');
    expect(html).toContain('Hold counts — retained'); expect(html).toContain('Type ENABLE RETENTION');
    expect(html).toContain('name="phrase" maxlength="16" required'); expect(html).toContain('min="30" max="365"'); expect(html).toContain('min="90" max="730"');
    expect(html).toContain('/action/retention-hold-clear');
    expect(renderRetentionDashboard(guildId, 'csrf', retention, preview, false)).not.toContain('<form');
  });
  it('Privacy presents bounded eligible/retained categories, point-in-time scope and committed gap warnings', () => {
    const view = { requests: [privacy.request], receipts: [], selected: privacy };
    const html = renderPrivacyDashboard(guildId, 'csrf', view, true); accessible(html);
    expect(html).toContain('Erase eligible categories'); expect(html).toContain('Retained categories');
    expect(html).toContain('Point-in-time'); expect(html).toContain('Future activity can create new Eiren data again.');
    expect(html).toContain('The domain mutation committed'); expect(html).toContain('Do not repeat the mutation.');
    expect(html).toContain('&lt;private unsafe evidence&gt;'); expect(html).not.toContain('<private unsafe evidence>');
    expect(html).toContain('CONFIRM PRIVACY REQUEST'); expect(html).toContain('DENY PRIVACY REQUEST');
    expect(html).not.toContain('/action/privacy-execute');
    const nonowner = renderPrivacyDashboard(guildId, 'csrf', view, false);
    expect(nonowner).toContain('/action/privacy-preview'); expect(nonowner).not.toMatch(/\/action\/privacy-(?:confirm|execute|deny)/);
    const foreign = renderPrivacyDashboard(guildId, 'csrf', { requests: [{ ...privacy.request, guildId: 'other' }], receipts: [], selected: { ...privacy, request: { ...privacy.request, guildId: 'other' } } }, true);
    expect(foreign).not.toContain('SYNTHETIC_SUBJECT_ID'); expect(foreign).not.toContain('<form');
  });
  it('Operations remains read-only with accessible telemetry and all four unknown boundaries', () => {
    const html = renderOperationsDashboard(guildId, operationsFixture()); accessible(html);
    expect(html).not.toContain('<form'); expect(html).not.toContain('/action/'); expect(html).toContain('Since process restart');
    for (const key of ['backup_health', 'discord_orphans', 'tls_health', 'historical_failures']) expect(html).toContain(key);
    expect(html).toContain('NOT_TRACKED is unknown, not zero or healthy.'); expect(html).toContain('notice-warning');
    expect(html).toContain('Do not blindly retry; inspect and reconcile.'); expect(html).toContain('Do not repeat the mutation.');
  });
});
