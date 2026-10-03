import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { InventoryContext, InventoryEntry } from './contracts.js';
import { collectInventory, hashInventory, inventoryQueries, normalizeEntries, summarizeInventory,
  SUBJECT_REFERENCE_REGISTRY as registry, NO_DIRECT_SUBJECT_REFERENCE_TABLES, type Executor } from './inventory.js';

const dialect = new PgDialect();
const context: InventoryContext = { requestId: '123e4567-e89b-42d3-a456-426614174000', guildId: '123456789012345678', subjectUserId: '234567890123456789', requestVersion: 2 };
const query = (family: string, ctx = context) => dialect.sqlToQuery(inventoryQueries(ctx).find(item => item.family === family)!.query);
function metadataRow(family: string, changes: Record<string, unknown> = {}) {
  const ref = registry.find(item => item.family === family)!;
  return { identity: ref.identity.map((_,index) => `${index+1}`), roles: [ref.userFields[0] ?? 'automations.authorized_by'],
    state: ref.state.map(() => null), ...changes };
}
async function collect(rows: Record<string, Record<string, unknown>[]>, ctx = context) {
  let cursor = 0, active = 0, maximumActive = 0;
  const queries = inventoryQueries(ctx);
  const execute = vi.fn(async (_statement: SQL) => {
    active++; maximumActive = Math.max(maximumActive,active);
    await Promise.resolve();
    const family = queries[cursor++]!.family;
    active--; return { rows: rows[family] ?? [] };
  });
  const result = await collectInventory({ execute } as unknown as Executor,ctx);
  return { result, execute, maximumActive };
}
const entry = (changes: Partial<InventoryEntry> = {}): InventoryEntry => ({ family: 'moderation_cases',
  identity: ['9007199254740993'], roles: ['target_id'], state: ['COMPLETED','1790000000.000000'],
  category: 'MODERATION_ACCOUNTABILITY', disposition: 'RETAIN', ...changes });

const nonUserTextColumns = new Set([
  'achievement_id','action','action_key','alert_channel_id','announcement_message_id','approved_capability','category','category_id','channel_id','close_reason','command_name','content','denial_code','description','discord_message_id','display_name','disposition','domain','emergency_reason','emoji','event_key','evidence_url','forbidden_role_id','guild_id','id','interaction_id','inventory_hash','kind','label','language','last_fingerprint','last_message_id','level','level_up_channel_id','lobby_channel_id','log_channel_id','message_id','method','mod_log_channel_id','mode','model_id','module_key','name','outcome','panel_message_id','prize','provider_id','quarantine_role_id','reason','reconciliation_result','request_id','request_key','required_role_id','resolution_note','result_announcement_id','review_note','role_id','safe_error_code','security_log_channel_id','source_channel_id','source_message_id','staff_response','staff_role_id','starboard_channel_id','starboard_message_id','status','target_type','ticket_category_id','timezone','title','token_hash','transcript','transcript_channel_id','trigger_key','type','verification_channel_id','verification_method','verification_status','verified_role_id','welcome_channel_id',
]);
const nonUserJsonPaths = new Set(['moderation_cases.metadata','member_verifications.metadata','join_history.signals','dashboard_sessions.oauth_guild_ids','automations.trigger_config','automation_actions.config','automation_execution_actions.config']);
function assertSchemaCoverage(schema: string) {
  const blocks = [...schema.matchAll(/export const (\w+) = pgTable\('([^']+)', \{([\s\S]*?)(?=\nexport const |$)/g)];
  const knownTables = new Set([...registry.map(ref => ref.family),...NO_DIRECT_SUBJECT_REFERENCE_TABLES]);
  const actualTables = new Set(blocks.map(block => block[2]!));
  for (const table of actualTables) if (!knownTables.has(table)) throw new Error(`Unclassified schema table: ${table}`);
  for (const table of knownTables) if (!actualTables.has(table)) throw new Error(`Stale registry table: ${table}`);
  for (const block of blocks) {
    const table = block[2]!, direct = registry.find(ref => ref.family === table)?.userFields ?? [];
    for (const field of block[3]!.matchAll(/\s+(\w+): (text|jsonb)\('([^']+)'\)/g)) {
      const column = field[3]!;
      if (field[2] === 'jsonb') {
        if (!nonUserJsonPaths.has(`${table}.${column}`)) throw new Error(`Unaudited structured JSON contract: ${table}.${column}`);
      } else if (!direct.includes(column) && !nonUserTextColumns.has(column) && !(table === 'governance_audit_gaps' && column === 'target_id')) {
        throw new Error(`Unclassified structured text field: ${table}.${column}`);
      }
    }
  }
}

describe('subject inventory complete static reference registry', () => {
  it('mechanically accounts for EVERY schema table and text/JSON identity contract', () => {
    const schema = readFileSync(new URL('../../core/database/schema.ts',import.meta.url),'utf8');
    expect(() => assertSchemaCoverage(schema)).not.toThrow();
    expect(() => assertSchemaCoverage(`${schema}\nexport const unknown = pgTable('unknown_table', {\n id: text('id'),\n});`)).toThrow('Unclassified schema table');
    expect(() => assertSchemaCoverage(schema.replace("moduleKey: text('module_key')", "newActorId: text('new_actor_id'),\n  moduleKey: text('module_key')"))).toThrow('Unclassified structured text field');
    expect(() => assertSchemaCoverage(schema.replace("moduleKey: text('module_key')", "authorizationSnapshot: jsonb('authorization_snapshot'),\n  moduleKey: text('module_key')"))).toThrow('Unaudited structured JSON contract');
  });
  it('covers every current structured schema user/actor field with the qualified audit-target exception', () => {
    const schema = readFileSync(new URL('../../core/database/schema.ts',import.meta.url),'utf8');
    const fields = /^(userId|subjectUserId|targetId|moderatorId|updatedBy|verifiedBy|rejectedBy|emergencyActorId|createdBy|confirmedBy|requestedBy|policyAuthorizerId|creatorId|assignedStaffId|closedBy|retentionHoldBy|addedBy|reporterId|reportedUserId|appellantId|reviewerId|authorId|reviewedBy|giverId|receiverId|sourceAuthorId|markedBy|ownerId|actorUserId|authorizedBy|reconciledBy|previewedBy|deniedBy|executedBy)$/;
    const blocks = [...schema.matchAll(/export const (\w+) = pgTable\('([^']+)', \{([\s\S]*?)(?=\nexport const |$)/g)];
    for (const block of blocks) {
      const table = block[2]!;
      const expected = [...block[3]!.matchAll(/\s+(\w+): text\('([^']+)'\)/g)].filter(match => fields.test(match[1]!))
        .map(match => match[2]!).filter(column => !(table === 'governance_audit_gaps' && column === 'target_id'));
      const actual = registry.find(ref => ref.family === table)?.userFields ?? [];
      expect([...actual].sort(),table).toEqual(expected.sort());
    }
    expect(registry.find(ref => ref.family === 'automation_action_runs')!.userFields).toEqual(['reconciled_by']);
  });
  it('contains all original 55 references and all ten new explicit governance references', () => {
    const newTables = new Set(['subject_requests','subject_request_previews','subject_execution_receipts','governance_audit_gaps']);
    expect(registry.filter(ref => !newTables.has(ref.family)).reduce((sum,ref) => sum+ref.userFields.length,0)).toBe(55);
    expect(registry.filter(ref => newTables.has(ref.family)).reduce((sum,ref) => sum+ref.userFields.length,0)).toBe(10);
    expect(new Set(registry.map(ref => ref.family)).size).toBe(registry.length);
    expect(NO_DIRECT_SUBJECT_REFERENCE_TABLES).toContain('subject_request_preview_counts');
    expect(NO_DIRECT_SUBJECT_REFERENCE_TABLES).toContain('analytics_event_dedupe');
  });
  it('has exact deletion identities only for approved community profiles and event children', () => {
    for (const family of ['member_levels','member_reputation']) expect(registry.find(ref => ref.family === family)!.identity).toEqual(['t.guild_id','t.user_id']);
    expect(registry.find(ref => ref.family === 'member_achievements')!.identity).toEqual(['t.guild_id','t.user_id','t.achievement_id']);
    for (const family of ['event_participants','event_attendance']) expect(registry.find(ref => ref.family === family)!.identity).toEqual(['t.event_id::text','t.user_id']);
  });
  it('uses safe explicit scalar projections, never private payload, opaque JSON or a secret-derived session key', () => {
    const forbidden = ['transcript','description','reason','review_note','close_reason','content','staff_response','evidence_url','resolution_note','name','last_fingerprint','token_hash','display_name','trigger_config','config','metadata','signals'];
    for (const {family,query: statement} of inventoryQueries(context)) {
      const text = dialect.sqlToQuery(statement).sql;
      expect(text,family).not.toMatch(/SELECT\s+(?:\w+\.)?\*/i);
      for (const column of forbidden) expect(text,`${family}.${column}`).not.toMatch(new RegExp(`\\b\\w+\\.${column}\\b`));
    }
    expect(registry.find(ref => ref.family === 'reports')!.state).not.toContain('t.category');
  });
  it('binds all identifiers as parameters instead of concatenating caller values', () => {
    const hostile = "x'); DROP TABLE guilds; --";
    const changed = { ...context, requestId: hostile, guildId: hostile, subjectUserId: hostile };
    for (const {query: statement} of inventoryQueries(changed)) {
      const text = dialect.sqlToQuery(statement);
      expect(text.sql).not.toContain(hostile);
      expect(text.params).toContain(hostile);
    }
  });
  it('has explicit guild joins for every child and direct scope for other rows', () => {
    const parent = { ticket_participants: 'p.guild_id', suggestion_votes: 'p.guild_id', event_participants: 'e.guild_id', event_attendance: 'e.guild_id', giveaway_entries: 'p.guild_id', giveaway_winners: 'p.guild_id', automation_action_runs: 'e.guild_id' };
    for (const [family,scope] of Object.entries(parent)) { expect(query(family).sql).toContain('INNER JOIN'); expect(query(family).sql).toContain(`${scope}=`); }
    expect(query('giveaway_winners').sql).toContain('p.id=t.giveaway_id');
    expect(query('giveaway_winners').sql).not.toContain('giveaway_draws');
    expect(query('automation_action_runs').sql).toContain('a.guild_id=e.guild_id');
    for (const {family,query: statement} of inventoryQueries(context)) expect(dialect.sqlToQuery(statement).params,family).toContain(family === 'dashboard_sessions' ? JSON.stringify([context.guildId]) : context.guildId);
  });
  it('scopes global sessions by typed membership and projects ONLY approved non-secret fields', () => {
    const text = query('dashboard_sessions').sql;
    expect(text).toContain('t.oauth_guild_ids @>');
    expect(text).toContain('t.user_id=');
    expect(text).not.toContain('token_hash'); expect(text).not.toContain('display_name');
    expect(text).not.toContain('last_seen_at'); expect(text).not.toContain('t.expires_at');
    expect(text).toContain('t.created_at'); expect(text).toContain('t.absolute_expires_at');
    expect(text.slice(0,text.indexOf('FROM'))).not.toContain('oauth_guild_ids');
  });
  it('qualifies polymorphic audit target IDs by the exact user-target contract', () => {
    expect(query('dashboard_audit_log').sql).toContain("t.target_type='moderation-warn'");
    expect(registry.find(ref => ref.family === 'governance_audit_gaps')!.userFields).toEqual(['actor_user_id']);
  });
  it('excludes only the current request and its FK-linked previews/receipt', () => {
    expect(query('subject_requests').sql).toMatch(/t\.id<>\$\d+::uuid/);
    for (const family of ['subject_request_previews','subject_execution_receipts']) expect(query(family).sql).toMatch(/t\.request_id<>\$\d+::uuid/);
    for (const family of ['retention_previews','retention_receipts','retention_policies']) expect(query(family).params).not.toContain(context.requestId);
  });
  it('excludes ONLY exactly-correlated privacy audit actions, with NULL-safe retention of other rows', () => {
    for (const family of ['dashboard_audit_log','governance_audit_gaps']) {
      const item = query(family);
      expect(item.sql).toContain('AND NOT COALESCE'); expect(item.sql).toContain('t.target_type=t.action');
      expect(item.sql).toMatch(/t\.target_id=\$\d+/);
      for (const action of ['privacy-preview','privacy-confirm','privacy-execute','privacy-deny']) expect(item.params).toContain(action);
      expect(item.params).not.toContain('retention-confirm'); expect(item.sql).not.toContain('LIKE');
    }
  });
  it('captures uncertainty via approved exact rule/execution/reconciliation joins, not arbitrary ancestry', () => {
    const item = query('automation_executions');
    expect(item.sql).toContain('a.guild_id=t.guild_id');
    expect(item.sql).toContain("t.status='UNCERTAIN'");
    expect(item.sql).toContain('r.execution_id=t.id AND r.reconciled_by=');
    expect(item.sql).toContain("r.execution_id=t.id AND r.status='UNCERTAIN'");
    expect(query('automation_action_runs').sql).toContain("(t.status='UNCERTAIN' OR e.status='UNCERTAIN')");
  });
});

describe('subject inventory classifications and privacy', () => {
  it.each(['COMPLETED','CANCELLED'])('erases both child row owners only when %s and presentation is settled', async status => {
    const state = [status,false,null,'1','2','3','4'];
    const {result, maximumActive} = await collect({ event_participants: [metadataRow('event_participants',{ roles: ['user_id'],state })], event_attendance: [metadataRow('event_attendance',{ roles: ['user_id','marked_by'],state })] });
    expect(result.eligibleTotal).toBe(2); expect(result.retainedTotal).toBe(0); expect(maximumActive).toBe(1);
    expect(result.entries.map(row => row.category).sort()).toEqual(['TERMINAL_EVENT_ATTENDANCE','TERMINAL_EVENT_PARTICIPATION']);
  });
  it.each(['SCHEDULED','ACTIVE'])('retains participation and own attendance for %s events', async status => {
    const state = [status,false,null,'1','2','3','4'];
    const {result} = await collect({ event_participants: [metadataRow('event_participants',{state})], event_attendance: [metadataRow('event_attendance',{roles:['user_id'],state})] });
    expect(result.eligibleTotal).toBe(0); expect(result.entries.every(row => row.category === 'ACTIVE_EVENT_STATE')).toBe(true);
  });
  it.each([[true,null],[false,'1790000000.000000']])('retains unresolved terminal presentation pending=%s retry=%s', async (pending,retry) => {
    const state = ['COMPLETED',pending,retry,'1','2','3','4'];
    const {result} = await collect({ event_participants: [metadataRow('event_participants',{state})], event_attendance: [metadataRow('event_attendance',{roles:['user_id'],state})] });
    expect(result.eligibleTotal).toBe(0); expect(result.entries.every(row => row.category === 'UNRESOLVED_EVENT_PRESENTATION')).toBe(true);
  });
  it('retains another attendee row when the subject matches solely marked_by', async () => {
    const {result} = await collect({ event_attendance: [metadataRow('event_attendance',{ roles:['marked_by'],state:['COMPLETED',false,null,'1','2','3','4'] })] });
    expect(result.entries[0]).toMatchObject({ category:'EVENT_STAFF_ACCOUNTABILITY',disposition:'RETAIN' });
  });
  it('allows only three profile families plus the terminal-safe owner children to erase', async () => {
    const rows: Record<string, Record<string, unknown>[]> = {};
    for (const ref of registry) if (!ref.family.startsWith('event_')) rows[ref.family] = [metadataRow(ref.family)];
    const {result} = await collect(rows);
    expect(result.entries.filter(row => row.disposition === 'ERASE').map(row => row.family).sort()).toEqual(['member_achievements','member_levels','member_reputation']);
  });
  it.each(['UNCERTAIN','SUCCEEDED'])('uses the explicit action uncertainty category for %s', async status => {
    const {result} = await collect({ automation_action_runs: [metadataRow('automation_action_runs',{ roles:['reconciled_by'],state:[status,1,null,null,null,'1','SUCCEEDED'] })] });
    expect(result.entries[0]!.category).toBe(status === 'UNCERTAIN' ? 'AUTOMATION_UNCERTAIN' : 'AUTOMATION_ACCOUNTABILITY');
  });
  it('also categorizes a reconciled action in an uncertain parent execution as uncertain', async () => {
    const {result} = await collect({ automation_action_runs: [metadataRow('automation_action_runs',{state:['SUCCEEDED',1,null,null,null,'1','UNCERTAIN']})] });
    expect(result.entries[0]!.category).toBe('AUTOMATION_UNCERTAIN');
  });
  it('never passes incidental private fields from a database row into entries or digest', async () => {
    const base = metadataRow('moderation_cases');
    const {result} = await collect({ moderation_cases: [{...base, reason:'PRIVATE_NARRATIVE',metadata:{secret:'PRIVATE_NARRATIVE'},token_hash:'CREDENTIAL_DERIVED'}] });
    const clean = await collect({ moderation_cases:[base] });
    expect(JSON.stringify(result)).not.toContain('PRIVATE_NARRATIVE'); expect(JSON.stringify(result)).not.toContain('CREDENTIAL_DERIVED');
    expect(result.hash).toBe(clean.result.hash);
  });
  it('fails closed on incomplete metadata projection or rounded/non-text record identities', async () => {
    await expect(collect({ tickets:[metadataRow('tickets',{state:[]})] })).rejects.toThrow('Invalid inventory metadata row');
    await expect(collect({ moderation_cases:[metadataRow('moderation_cases',{identity:[9007199254740992]})] })).rejects.toThrow('Invalid inventory identity');
  });
});

describe('canonical subject inventory counts and hash', () => {
  it('merges multiple matching roles into one record and remains order independent', () => {
    const first = entry({ roles:['target_id'] }), second = entry({ roles:['moderator_id'] });
    const whole = entry({roles:['target_id','moderator_id']});
    expect(summarizeInventory([first,second],context).retainedTotal).toBe(1);
    expect(hashInventory([first,second],context)).toBe(hashInventory([whole],context));
    expect(hashInventory([second,first],context)).toBe(hashInventory([first,second],context));
  });
  it('changes for identity, state or matching-role changes even at equal counts', () => {
    const original = hashInventory([entry()],context);
    for (const changed of [entry({identity:['9007199254740994']}),entry({state:['ACTIVE','1790000000.000000']}),entry({roles:['moderator_id']})]) {
      expect(summarizeInventory([changed]).retainedTotal).toBe(1); expect(hashInventory([changed],context)).not.toBe(original);
    }
  });
  it.each(['requestId','guildId','subjectUserId','requestVersion'] as const)('binds the fixed %s context independently of excluded mutable workflow rows', key => {
    const changed = { ...context, [key]: key === 'requestVersion' ? 3 : 'different' } as InventoryContext;
    expect(hashInventory([entry()],changed)).not.toBe(hashInventory([entry()],context));
  });
  it('preserves identical global-session tuple multiplicity without token identities', () => {
    const session = entry({family:'dashboard_sessions',identity:[context.subjectUserId,'1','2'],roles:['user_id'],state:[],category:'OUT_OF_SCOPE'});
    expect(normalizeEntries([session,session])).toHaveLength(2);
    expect(summarizeInventory([session,session]).retainedTotal).toBe(2);
    expect(hashInventory([session,session])).not.toBe(hashInventory([session]));
  });
  it('fails closed for contradictory duplicate records rather than retaining an erase-capable choice', () => {
    expect(() => normalizeEntries([entry(),entry({state:['ACTIVE']})])).toThrow('Conflicting inventory record metadata');
    expect(() => normalizeEntries([entry(),entry({disposition:'ERASE'})])).toThrow('Conflicting inventory record metadata');
  });
  it('rejects non-scalar metadata and unsafe integer values', () => {
    expect(() => hashInventory([entry({state:[9007199254740992]})])).toThrow('Invalid inventory metadata scalar');
    expect(() => hashInventory([entry({state:[Number.NaN]})])).toThrow('Invalid inventory metadata scalar');
  });
});
