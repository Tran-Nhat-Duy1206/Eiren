import { createHash } from 'node:crypto';
import { sql, type SQL } from 'drizzle-orm';
import type { Database } from '../../core/database/connection.js';
import { CATEGORIES, type Category, type InventoryContext, type InventoryEntry, type InventorySummary } from './contracts.js';

export type Executor = Pick<Database, 'execute'>;
type Scope = InventoryContext;
type Role = { name: string; expression: string; when?: string };
type Reference = {
  family: string; userFields: readonly string[]; identity: readonly string[]; state: readonly string[];
  category: Category; disposition: 'ERASE' | 'RETAIN'; from: string; scope: string; roles: readonly Role[];
  exclude?: 'REQUEST' | 'REQUEST_CHILD' | 'AUDIT'; event?: 'PARTICIPANT' | 'ATTENDANCE';
  uncertain?: boolean; uncertainExecution?: boolean;
};
const epoch = (column: string) => `extract(epoch from ${column.includes('.') ? column : `t.${column}`})::text`;
const columns = (...names: string[]) => names.map(name => `t.${name}`);
const numericId = ['t.id::text'];
function reference(family: string, userFields: string[], category: Category,
  identity: string[] = numericId, state: string[] = [], options: Partial<Reference> = {}): Reference {
  return { family, userFields, category, identity, state, disposition: 'RETAIN', from: `${family} t`, scope: 't.guild_id',
    roles: userFields.map(name => ({ name, expression: `t.${name}` })), ...options };
}
const eventFrom = (table: string) => `${table} t INNER JOIN community_events e ON e.id=t.event_id`;
const eventState = [ 'e.status', 'e.presentation_pending', epoch('e.presentation_retry_at'), epoch('e.updated_at'), epoch('e.start_at'), epoch('e.end_at') ];
const uncertain = "(t.status='UNCERTAIN' OR e.status='UNCERTAIN')";

// Every identifier/expression below is a static trusted contract, never supplied by a request.
const references: readonly Reference[] = [
  reference('guild_modules', ['updated_by'], 'CONFIGURATION_ACCOUNTABILITY', columns('guild_id','module_key'), [...columns('enabled','version'), epoch('updated_at')]),
  reference('moderation_cases', ['target_id','moderator_id'], 'MODERATION_ACCOUNTABILITY', numericId, [...columns('action','status'), epoch('created_at'), epoch('expires_at'), epoch('claimed_at')]),
  reference('verification_settings', ['updated_by'], 'CONFIGURATION_ACCOUNTABILITY', columns('guild_id'), [...columns('enabled','mode'), epoch('updated_at')]),
  reference('member_verifications', ['user_id','verified_by','rejected_by'], 'VERIFICATION_ACCESS_STATE', numericId, [...columns('status','method'), epoch('created_at'), epoch('updated_at'), epoch('verified_at'), epoch('rejected_at'), epoch('rules_acknowledged_at')]),
  reference('antiraid_settings', ['emergency_actor_id','updated_by'], 'ANTI_ABUSE_OR_REPLAY', columns('guild_id'), [...columns('emergency_mode'), epoch('emergency_activated_at'), epoch('updated_at')]),
  reference('join_history', ['user_id'], 'ANTI_ABUSE_OR_REPLAY', numericId, [epoch('joined_at'), epoch('account_created_at'), ...columns('risk_score')]),
  reference('moderator_notes', ['target_id','moderator_id'], 'MODERATION_ACCOUNTABILITY', numericId, [epoch('created_at')]),
  reference('role_menus', ['created_by'], 'CONFIGURATION_ACCOUNTABILITY', numericId, [...columns('kind','enabled'), epoch('created_at'), epoch('updated_at')]),
  reference('retention_policies', ['confirmed_by'], 'RETENTION_GOVERNANCE', columns('guild_id'), [...columns('enabled','version','ticket_retention_days','report_retention_days','appeal_retention_days'), epoch('confirmed_at'), epoch('updated_at')]),
  reference('retention_previews', ['requested_by'], 'RETENTION_GOVERNANCE', columns('id'), [...columns('base_version','ticket_days','report_days','appeal_days','eligible_ticket_count','eligible_report_count','eligible_appeal_count'), epoch('created_at'), epoch('expires_at'), epoch('consumed_at')]),
  reference('retention_receipts', ['policy_authorizer_id'], 'RETENTION_GOVERNANCE', ['t.guild_id','t.domain','t.record_id::text'], [...columns('policy_version'), epoch('redacted_at')]),
  reference('tickets', ['creator_id','assigned_staff_id','closed_by','retention_hold_by'], 'TICKET_ACCOUNTABILITY', numericId, [...columns('type','status','retention_hold','transcript_retention_policy_version'), epoch('created_at'), epoch('claimed_at'), epoch('closed_at'), epoch('transcript_generated_at'), epoch('transcript_redacted_at'), epoch('retention_hold_at')]),
  reference('ticket_participants', ['user_id','added_by'], 'TICKET_ACCOUNTABILITY', ['t.ticket_id::text','t.user_id'], [epoch('added_at')], { from: 'ticket_participants t INNER JOIN tickets p ON p.id=t.ticket_id', scope: 'p.guild_id' }),
  reference('reports', ['reporter_id','reported_user_id','assigned_staff_id','closed_by','retention_hold_by'], 'REPORT_APPEAL_EVIDENCE', numericId, [...columns('status','retention_hold','narrative_retention_policy_version'), epoch('created_at'), epoch('closed_at'), epoch('narrative_redacted_at'), epoch('retention_hold_at')]),
  reference('appeals', ['appellant_id','reviewer_id','retention_hold_by'], 'REPORT_APPEAL_EVIDENCE', numericId, ['t.case_id::text', ...columns('status','retention_hold','narrative_retention_policy_version'), epoch('created_at'), epoch('reviewed_at'), epoch('narrative_redacted_at'), epoch('retention_hold_at')]),
  reference('suggestions', ['author_id','reviewed_by'], 'SUGGESTION_HISTORY', numericId, [...columns('status'), epoch('created_at'), epoch('updated_at')]),
  reference('suggestion_votes', ['user_id'], 'SUGGESTION_HISTORY', ['t.suggestion_id::text','t.user_id'], [...columns('vote'), epoch('created_at'), epoch('updated_at')], { from: 'suggestion_votes t INNER JOIN suggestions p ON p.id=t.suggestion_id', scope: 'p.guild_id' }),
  reference('member_levels', ['user_id'], 'MEMBER_LEVEL_STATE', columns('guild_id','user_id'), ['t.xp::text', ...columns('message_count'), epoch('last_xp_at'), epoch('created_at'), epoch('updated_at')], { disposition: 'ERASE' }),
  reference('member_reputation', ['user_id'], 'MEMBER_REPUTATION_AGGREGATE', columns('guild_id','user_id'), [...columns('score'), epoch('updated_at')], { disposition: 'ERASE' }),
  reference('reputation_grants', ['giver_id','receiver_id'], 'REPUTATION_GRANT_HISTORY', numericId, [epoch('created_at')]),
  reference('starboard_messages', ['source_author_id'], 'STARBOARD_HISTORY', numericId, [...columns('status','star_count'), epoch('created_at'), epoch('updated_at')]),
  reference('community_events', ['creator_id'], 'EVENT_CREATOR_ACCOUNTABILITY', numericId, [...columns('status','presentation_pending'), epoch('start_at'), epoch('end_at'), epoch('presentation_retry_at'), epoch('created_at'), epoch('updated_at')]),
  reference('event_participants', ['user_id'], 'TERMINAL_EVENT_PARTICIPATION', ['t.event_id::text','t.user_id'], [...eventState, epoch('joined_at')], { from: eventFrom('event_participants'), scope: 'e.guild_id', event: 'PARTICIPANT' }),
  reference('event_attendance', ['user_id','marked_by'], 'TERMINAL_EVENT_ATTENDANCE', ['t.event_id::text','t.user_id'], [...eventState, epoch('marked_at')], { from: eventFrom('event_attendance'), scope: 'e.guild_id', event: 'ATTENDANCE' }),
  reference('giveaways', ['creator_id'], 'GIVEAWAY_HISTORY', numericId, [...columns('status','winner_count'), epoch('start_at'), epoch('end_at'), epoch('created_at'), epoch('updated_at')]),
  reference('giveaway_entries', ['user_id'], 'GIVEAWAY_HISTORY', ['t.giveaway_id::text','t.user_id'], [epoch('entered_at'), 'p.status', epoch('p.updated_at')], { from: 'giveaway_entries t INNER JOIN giveaways p ON p.id=t.giveaway_id', scope: 'p.guild_id' }),
  reference('giveaway_winners', ['user_id'], 'GIVEAWAY_HISTORY', ['t.draw_id::text','t.user_id'], ['t.giveaway_id::text', ...columns('ordinal'), 'p.status', epoch('p.updated_at')], { from: 'giveaway_winners t INNER JOIN giveaways p ON p.id=t.giveaway_id', scope: 'p.guild_id' }),
  reference('tempvoice_rooms', ['owner_id'], 'TEMPVOICE_OPERATIONAL_STATE', numericId, [...columns('status'), epoch('empty_since'), epoch('created_at'), epoch('updated_at')]),
  reference('member_achievements', ['user_id'], 'ACHIEVEMENT_AWARDS', columns('guild_id','user_id','achievement_id'), [epoch('awarded_at')], { disposition: 'ERASE' }),
  reference('analytics_member_state', ['user_id'], 'ANALYTICS_OPERATIONAL_STATE', columns('guild_id','user_id'), [...columns('present'), epoch('last_changed_at')]),
  reference('analytics_active_voice_sessions', ['user_id'], 'ANALYTICS_OPERATIONAL_STATE', columns('guild_id','user_id'), ['t.observation_seq::text', ...columns('observation_epoch','pending'), epoch('joined_at'), epoch('updated_at')]),
  reference('dashboard_sessions', ['user_id'], 'OUT_OF_SCOPE', ['t.user_id', epoch('created_at'), epoch('absolute_expires_at')], [], { scope: '', from: 'dashboard_sessions t' }),
  reference('dashboard_audit_log', ['actor_user_id','target_id'], 'GOVERNANCE_AUDIT', numericId, [...columns('action','target_type','success','request_id'), epoch('created_at')], { exclude: 'AUDIT', roles: [{ name: 'actor_user_id', expression: 't.actor_user_id' }, { name: 'target_id', expression: 't.target_id', when: "t.target_type='moderation-warn'" }] }),
  reference('ai_requests', ['user_id'], 'AI_ACCOUNTING', columns('id'), [...columns('usage_day','epoch','status'), 't.reserved_cost_micros::text','t.actual_cost_micros::text', ...columns('reserved_input_tokens','reserved_output_tokens','actual_input_tokens','actual_output_tokens'), epoch('created_at'), epoch('lease_until'), epoch('settled_at')]),
  reference('automations', ['authorized_by'], 'AUTOMATION_ACCOUNTABILITY', numericId, [...columns('enabled','config_version','trigger_key','trigger_version','approved_capability'), epoch('deleted_at'), epoch('created_at'), epoch('updated_at')]),
  reference('automation_action_runs', ['reconciled_by'], 'AUTOMATION_ACCOUNTABILITY', columns('execution_id','position').map(column => `${column}::text`), [...columns('status','attempts','reconciliation_result','safe_error_code'), epoch('reconciled_at'), epoch('updated_at'), 'e.status'], {
    from: 'automation_action_runs t INNER JOIN automation_executions e ON e.id=t.execution_id INNER JOIN automations a ON a.id=e.automation_id AND a.guild_id=e.guild_id', scope: 'e.guild_id', uncertain: true,
    roles: [{ name: 'reconciled_by', expression: 't.reconciled_by' }, { name: 'automations.authorized_by', expression: 'a.authorized_by', when: uncertain }],
  }),
  reference('automation_executions', [], 'AUTOMATION_UNCERTAIN', columns('id'), [...columns('status','module_epoch','config_version','attempts','safe_error_code'), epoch('created_at'), epoch('completed_at')], {
    from: 'automation_executions t INNER JOIN automations a ON a.id=t.automation_id AND a.guild_id=t.guild_id', uncertainExecution: true,
  }),
  reference('subject_requests', ['subject_user_id','previewed_by','confirmed_by','denied_by'], 'PRIVACY_GOVERNANCE', columns('id'), [...columns('status','version'), epoch('requested_at'), epoch('previewed_at'), epoch('confirmed_at'), epoch('denied_at'), epoch('terminal_at')], { exclude: 'REQUEST' }),
  reference('subject_request_previews', ['subject_user_id','reviewed_by'], 'PRIVACY_GOVERNANCE', columns('id'), [...columns('request_id','request_version'), epoch('created_at'), epoch('expires_at'), epoch('consumed_at')], { exclude: 'REQUEST_CHILD' }),
  reference('subject_execution_receipts', ['subject_user_id','confirmed_by','executed_by'], 'PRIVACY_GOVERNANCE', columns('request_id'), [...columns('request_version','outcome'), epoch('executed_at')], { exclude: 'REQUEST_CHILD' }),
  reference('governance_audit_gaps', ['actor_user_id'], 'GOVERNANCE_AUDIT', columns('id'), [...columns('action','target_type','request_id'), epoch('committed_at'), epoch('detected_at')], { exclude: 'AUDIT' }),
];
export const SUBJECT_REFERENCE_REGISTRY = Object.freeze(references.map(ref => Object.freeze({
  family: ref.family, userFields: Object.freeze([...ref.userFields]), category: ref.category,
  identity: Object.freeze([...ref.identity]), state: Object.freeze([...ref.state]),
})));
export const NO_DIRECT_SUBJECT_REFERENCE_TABLES = Object.freeze([
  'guilds','guild_settings','guild_permission_roles','role_menu_options','ticket_settings','suggestion_settings',
  'levels_settings','level_rewards','level_ignored_channels','reputation_settings','starboard_settings','starboard_ignored_channels',
  'event_reminders','giveaway_draws','tempvoice_settings','analytics_settings','analytics_guild_hourly','analytics_channel_hourly',
  'analytics_command_hourly','analytics_event_dedupe','ai_settings','ai_usage_daily','automation_actions','automation_execution_attempts',
  'automation_execution_actions','subject_request_preview_counts',
]);
const privacyActions = ['privacy-preview','privacy-confirm','privacy-execute','privacy-deny'] as const;
function ownAudit(context: InventoryContext): SQL {
  return sql`COALESCE((t.target_id=${context.requestId} AND t.action IN (${sql.join(privacyActions.map(action => sql`${action}`), sql`, `)}) AND t.target_type=t.action),false)`;
}
function roleMatch(role: Role, context: InventoryContext): SQL {
  return sql`(${sql.raw(role.expression)}=${context.subjectUserId}${role.when ? sql` AND ${sql.raw(role.when)}` : sql``})`;
}
export function inventoryQueries(context: InventoryContext): readonly { family: string; query: SQL }[] {
  return references.map(ref => {
    const roleConditions = ref.roles.map(role => ({ role, predicate: roleMatch(role, context) }));
    if (ref.uncertainExecution) {
      roleConditions.push({ role: { name: 'automations.authorized_by', expression: 'a.authorized_by' }, predicate: sql`a.authorized_by=${context.subjectUserId}` });
      roleConditions.push({ role: { name: 'automation_action_runs.reconciled_by', expression: '' }, predicate: sql`EXISTS (SELECT 1 FROM automation_action_runs r WHERE r.execution_id=t.id AND r.reconciled_by=${context.subjectUserId})` });
    }
    const scope = ref.family === 'dashboard_sessions'
      ? sql`t.oauth_guild_ids @> ${JSON.stringify([context.guildId])}::jsonb`
      : sql`${sql.raw(ref.scope)}=${context.guildId}`;
    const exclusion = ref.exclude === 'REQUEST' ? sql` AND t.id<>${context.requestId}::uuid`
      : ref.exclude === 'REQUEST_CHILD' ? sql` AND t.request_id<>${context.requestId}::uuid`
      : ref.exclude === 'AUDIT' ? sql` AND NOT ${ownAudit(context)}` : sql``;
    const unresolved = ref.uncertainExecution
      ? sql` AND (t.status='UNCERTAIN' OR EXISTS (SELECT 1 FROM automation_action_runs r WHERE r.execution_id=t.id AND r.status='UNCERTAIN'))` : sql``;
    const query = sql`SELECT jsonb_build_array(${sql.join(ref.identity.map(expression => sql.raw(expression)), sql`, `)}) AS identity,
      ARRAY_REMOVE(ARRAY[${sql.join(roleConditions.map(({role,predicate}) => sql`CASE WHEN ${predicate} THEN ${role.name} ELSE NULL END`), sql`, `)}]::text[],NULL) AS roles,
      jsonb_build_array(${sql.join(ref.state.map(expression => sql.raw(expression)), sql`, `)}) AS state
      FROM ${sql.raw(ref.from)} WHERE ${scope} AND (${sql.join(roleConditions.map(({predicate}) => predicate), sql` OR `)})${exclusion}${unresolved}`;
    return { family: ref.family, query };
  });
}
function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
function scalar(value: unknown): string | number | boolean | null {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value))) return value;
  throw new TypeError('Invalid inventory metadata scalar');
}
function fromRow(ref: Reference, row: Record<string, unknown>): InventoryEntry {
  if (!Array.isArray(row.identity) || !Array.isArray(row.roles) || !Array.isArray(row.state) || !row.roles.length ||
      row.identity.length !== ref.identity.length || row.state.length !== ref.state.length) throw new TypeError('Invalid inventory metadata row');
  const identity = row.identity.map(value => {
    if (typeof value !== 'string' || !value.length) throw new TypeError('Invalid inventory identity');
    return value;
  });
  const roles = row.roles.map(value => { if (typeof value !== 'string') throw new TypeError('Invalid inventory role'); return value; });
  const state = row.state.map(scalar);
  let category = ref.category, disposition = ref.disposition;
  if (ref.event) {
    if (ref.event === 'ATTENDANCE' && !roles.includes('user_id')) category = 'EVENT_STAFF_ACCOUNTABILITY';
    else if (!['COMPLETED','CANCELLED'].includes(String(state[0]))) category = 'ACTIVE_EVENT_STATE';
    else if (state[1] !== false || state[2] !== null) category = 'UNRESOLVED_EVENT_PRESENTATION';
    else { category = ref.event === 'PARTICIPANT' ? 'TERMINAL_EVENT_PARTICIPATION' : 'TERMINAL_EVENT_ATTENDANCE'; disposition = 'ERASE'; }
  }
  if (ref.uncertain && (state[0] === 'UNCERTAIN' || state[state.length-1] === 'UNCERTAIN')) category = 'AUTOMATION_UNCERTAIN';
  return { family: ref.family, identity, roles, state, category, disposition };
}
/** Deduplicate real records, merge role matches; global sessions intentionally remain a multiset. */
export function normalizeEntries(entries: readonly InventoryEntry[]): InventoryEntry[] {
  const unique = new Map<string, InventoryEntry>();
  const sessions: InventoryEntry[] = [];
  for (const source of entries) {
    if (!CATEGORIES.includes(source.category) || !['ERASE','RETAIN'].includes(source.disposition)) throw new TypeError('Invalid inventory classification');
    const entry: InventoryEntry = { family: source.family, identity: [...source.identity], roles: [...new Set(source.roles)].sort(compare), state: source.state.map(scalar), category: source.category, disposition: source.disposition };
    if (entry.family === 'dashboard_sessions') { sessions.push(entry); continue; }
    const key = JSON.stringify([entry.family,entry.identity]);
    const prior = unique.get(key);
    if (prior) {
      if (prior.category !== entry.category || prior.disposition !== entry.disposition || JSON.stringify(prior.state) !== JSON.stringify(entry.state)) throw new Error('Conflicting inventory record metadata');
      prior.roles = [...new Set([...prior.roles,...entry.roles])].sort(compare);
    } else unique.set(key, entry);
  }
  return [...unique.values(),...sessions].sort((a,b) => compare(JSON.stringify(a),JSON.stringify(b)));
}
export function hashInventory(entries: readonly InventoryEntry[], scope?: Scope): string {
  const canonical = normalizeEntries(entries).map(entry => [entry.family,entry.identity,entry.roles,entry.category,entry.disposition,entry.state]);
  return createHash('sha256').update(JSON.stringify([scope ? [scope.requestId,scope.guildId,scope.subjectUserId,scope.requestVersion] : null,canonical])).digest('hex');
}
export function summarizeInventory(entries: readonly InventoryEntry[], scope?: Scope): InventorySummary {
  const normalized = normalizeEntries(entries);
  const counts: InventorySummary['counts'] = [];
  for (const category of CATEGORIES) for (const disposition of ['ERASE','RETAIN'] as const) {
    const count = normalized.filter(entry => entry.category === category && entry.disposition === disposition).length;
    if (count) counts.push({ category, disposition, count });
  }
  return { counts, eligibleTotal: normalized.filter(entry => entry.disposition === 'ERASE').length,
    retainedTotal: normalized.filter(entry => entry.disposition === 'RETAIN').length, hash: hashInventory(normalized,scope) };
}
export async function collectInventory(db: Executor, context: InventoryContext): Promise<InventorySummary & { entries: InventoryEntry[] }> {
  const entries: InventoryEntry[] = [];
  const queries = inventoryQueries(context);
  // One transaction/client: do not queue concurrent pg execute operations.
  for (let index = 0; index < queries.length; index++) {
    const result = await db.execute(queries[index]!.query);
    for (const row of result.rows) entries.push(fromRow(references[index]!,row));
  }
  const normalized = normalizeEntries(entries);
  return { ...summarizeInventory(normalized,context), entries: normalized };
}
