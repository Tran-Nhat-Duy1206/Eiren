# V8.3 subject-inventory query plans

## Scope and method

Observed on PostgreSQL 17 in an explicitly owned, empty, isolated loopback database migrated through **0019**, before generating **0020_subject_request_governance**. No local `.env`, actual guild database or private fixtures were used. Each of the six child tables below contained **10,000 synthetic rows**, with corresponding synthetic parents. A subject matched ten `user_id` rows per family; ticket participants and event attendance also contained ten distinct actor-only matches (`added_by` / `marked_by`). Parent guild filtering was preserved.

Queries were the actual SQL objects returned by `inventoryQueries(context)` in `src/modules/subject-requests/inventory.ts`, including metadata identity/role/state projections, bound parameters and existing joins. Plans used **EXPLAIN (ANALYZE, BUFFERS)** after ANALYZE. No forced planner options, query simplification or added LIMIT was used. Existing parent-first primary keys and guild-prefixed indexes were present. Candidate indexes and all fixtures lived in one transaction that was deliberately rolled back; afterward all fixture guild/child counts and candidate-index counts were zero. Empty source tables were re-ANALYZEd.

These observations justify only **eight indexes over six joined child families**. They do not justify blanket actor indexes on direct guild-scoped families. Single-run elapsed times are observations, not performance guarantees or CI thresholds.

## Actual lookup shapes and accepted indexes

All predicates below use the same bound subject parameter in each actor arm; the parent guild is a separately bound parameter. The actual query also projects trusted metadata expressions.

| Family | Actual join and subject predicate | Indexes included in 0020 |
| --- | --- | --- |
| ticket_participants | `JOIN tickets p ON p.id=t.ticket_id WHERE p.guild_id=$guild AND (t.user_id=$subject OR t.added_by=$subject)` | `(user_id,ticket_id)`, `(added_by,ticket_id)` |
| suggestion_votes | `JOIN suggestions p ON p.id=t.suggestion_id WHERE p.guild_id=$guild AND t.user_id=$subject` | `(user_id,suggestion_id)` |
| event_participants | `JOIN community_events e ON e.id=t.event_id WHERE e.guild_id=$guild AND t.user_id=$subject` | `(user_id,event_id)` |
| event_attendance | `JOIN community_events e ON e.id=t.event_id WHERE e.guild_id=$guild AND (t.user_id=$subject OR t.marked_by=$subject)` | `(user_id,event_id)`, `(marked_by,event_id)` |
| giveaway_entries | `JOIN giveaways p ON p.id=t.giveaway_id WHERE p.guild_id=$guild AND t.user_id=$subject` | `(user_id,giveaway_id)` |
| giveaway_winners | `JOIN giveaways p ON p.id=t.giveaway_id WHERE p.guild_id=$guild AND t.user_id=$subject` | `(user_id,giveaway_id)` |

## Observed baseline versus candidate plans

| Family | Baseline child access / rejected rows | Candidate child access | Returned rows | Baseline → candidate total execution ms |
| --- | --- | --- | --- | --- |
| ticket_participants | Seq Scan / 9,980 | Bitmap Heap Scan + BitmapOr over both subject indexes | 20 | 6.169 → 0.257 |
| suggestion_votes | Seq Scan / 9,990 | Index Scan `suggestion_votes_subject_user_idx` | 10 | 1.560 → 0.155 |
| event_participants | Seq Scan / 9,990 | Index Scan `event_participants_subject_user_idx` | 10 | 1.139 → 0.165 |
| event_attendance | Seq Scan / 9,980 | Bitmap Heap Scan + BitmapOr over both subject indexes | 20 | 2.285 → 0.294 |
| giveaway_entries | Seq Scan / 9,990 | Index Scan `giveaway_entries_subject_user_idx` | 10 | 1.117 → 0.239 |
| giveaway_winners | Seq Scan / 9,990 | Index Scan `giveaway_winners_subject_user_idx` | 10 | 1.852 → 0.152 |

All final plans retained nested-loop parent PK lookup and the parent guild filter. Existing child keys start with the parent ID; that leading column did not support the selective subject-first lookup used by inventory. The new indexes supply the actually missing leading user/actor condition, without changing membership, erasure eligibility or actor-role classification.

### Why both OR-arm indexes are required

An intermediate measurement created **only** the `user_id` indexes. The actual ticket and attendance OR queries still selected sequential scans and rejected 9,980 rows. Ticket total execution was 4.282 ms and attendance 1.736 ms. Adding the actor-leading index enabled BitmapOr; one user index alone was not sufficient evidence for either complete OR lookup.

## Abridged actual plan nodes

Identifiers below are explicitly synthetic. Excerpts preserve the observed access path, predicate, row count and join/guild fence; omitted sections are planning/buffer details, not additional predicates.

### ticket_participants

Baseline and user-index-only both contained:

```text
Seq Scan on ticket_participants t (cost=0.00..254.00 rows=20 width=54)
  Filter: ((user_id = '990800000000000002'::text) OR (added_by = '990800000000000002'::text))
  Rows Removed by Filter: 9980
Index Scan using tickets_pkey on tickets p
  Index Cond: (id = t.ticket_id)
  Filter: (guild_id = '990800000000000001'::text)
```

After both indexes:

```text
Nested Loop (cost=9.02..203.27 rows=20 width=96) (actual time=0.110..0.216 rows=20 loops=1)
  Bitmap Heap Scan on ticket_participants t (actual time=0.082..0.096 rows=20 loops=1)
    Recheck Cond: ((user_id = '990800000000000002'::text) OR (added_by = '990800000000000002'::text))
    Heap Blocks: exact=11
    BitmapOr
      Bitmap Index Scan on ticket_participants_subject_user_idx (actual rows=10 loops=1)
        Index Cond: (user_id = '990800000000000002'::text)
      Bitmap Index Scan on ticket_participants_subject_added_by_idx (actual rows=10 loops=1)
        Index Cond: (added_by = '990800000000000002'::text)
  Index Scan using tickets_pkey on tickets p (actual rows=1 loops=20)
    Index Cond: (id = t.ticket_id)
    Filter: (guild_id = '990800000000000001'::text)
Execution Time: 0.257 ms
```

### event_attendance

Baseline and user-index-only both contained:

```text
Seq Scan on event_attendance t (cost=0.00..254.00 rows=20 width=54)
  Filter: ((user_id = '990800000000000002'::text) OR (marked_by = '990800000000000002'::text))
  Rows Removed by Filter: 9980
```

After both indexes:

```text
Nested Loop (cost=9.02..207.87 rows=20 width=96) (actual time=0.102..0.259 rows=20 loops=1)
  Bitmap Heap Scan on event_attendance t (actual time=0.078..0.096 rows=20 loops=1)
    Recheck Cond: ((user_id = '990800000000000002'::text) OR (marked_by = '990800000000000002'::text))
    Heap Blocks: exact=11
    BitmapOr
      Bitmap Index Scan on event_attendance_subject_user_idx (actual rows=10 loops=1)
        Index Cond: (user_id = '990800000000000002'::text)
      Bitmap Index Scan on event_attendance_subject_marked_by_idx (actual rows=10 loops=1)
        Index Cond: (marked_by = '990800000000000002'::text)
  Index Scan using community_events_pkey on community_events e (actual rows=1 loops=20)
    Index Cond: (id = t.event_id)
    Filter: (guild_id = '990800000000000001'::text)
Execution Time: 0.294 ms
```

### Single-user child lookups

Each baseline sequential scan rejected 9,990 rows. Candidate child and parent nodes were:

```text
Index Scan using suggestion_votes_subject_user_idx on suggestion_votes t (actual time=0.042..0.051 rows=10 loops=1)
  Index Cond: (user_id = '990800000000000002'::text)
Index Scan using suggestions_pkey on suggestions p (actual rows=1 loops=10)
  Index Cond: (id = t.suggestion_id)
  Filter: (guild_id = '990800000000000001'::text)
Execution Time: 0.155 ms

Index Scan using event_participants_subject_user_idx on event_participants t (actual time=0.041..0.050 rows=10 loops=1)
  Index Cond: (user_id = '990800000000000002'::text)
Index Scan using community_events_pkey on community_events e (actual rows=1 loops=10)
  Index Cond: (id = t.event_id)
  Filter: (guild_id = '990800000000000001'::text)
Execution Time: 0.165 ms

Index Scan using giveaway_entries_subject_user_idx on giveaway_entries t (actual time=0.059..0.071 rows=10 loops=1)
  Index Cond: (user_id = '990800000000000002'::text)
Index Scan using giveaways_pkey on giveaways p (actual rows=1 loops=10)
  Index Cond: (id = t.giveaway_id)
  Filter: (guild_id = '990800000000000001'::text)
Execution Time: 0.239 ms

Index Scan using giveaway_winners_subject_user_idx on giveaway_winners t (actual time=0.040..0.048 rows=10 loops=1)
  Index Cond: (user_id = '990800000000000002'::text)
Index Scan using giveaways_pkey on giveaways p (actual rows=1 loops=10)
  Index Cond: (id = t.giveaway_id)
  Filter: (guild_id = '990800000000000001'::text)
Execution Time: 0.152 ms
```

## Separate workflow indexes

The five new metadata tables also have only required workflow indexes: active-subject uniqueness, child composite FK support, guild-recent and subject-latest request lookups, terminal request expiry, preview request-recent/expiry/consumed lookups, receipt guild-recent/execution-time pruning, and governance gap guild-recent/**detected-at** pruning. The list service has no status filter, so no speculative guild/status list index was added. These indexes are not represented as an EXPLAIN experiment over tables that did not exist in the baseline source.

## Generated migration dependency verification

The request's `(guild_id,id,subject_user_id)` uniqueness is an **inline UNIQUE table constraint**, not a later CREATE INDEX statement: both preview and receipt composite foreign keys need it before their ALTER TABLE statements. Full generated SQL inspection caught the dependency ordering issue before any 0020 apply. PostgreSQL confirmed the source had only 20 journal rows through 0019 and none of the five new tables; only the unapplied 0020 artifacts/latest journal entry were regenerated with the same final tag. No 0000–0019 SQL or prior journal entry was rewritten.

Observed corrected checks:

- `pnpm db:check` passed; journal has 21 ordered entries, the original first 20 are identical, and the 0020 snapshot links to 0019 with 67 tables and the inline UNIQUE constraint.
- Actual cold application of all 0000–0020 SQL in an isolated schema on the owned EXPLAIN database passed: **21 migrations, 67 tables, one inline composite UNIQUE and two request/subject composite foreign keys**. The entire cold schema was rolled back; the public source remained empty at journal 20.
- Then `pnpm db:migrate` applied corrected 0020 to that disposable public source successfully: journal 21; guild and all five new workflow-table counts zero.
- Final 0020 contains **29 DDL statements: five CREATE TABLE, five FK additions and 19 explicit indexes** (eight measured child indexes plus 11 required workflow indexes). No migration-time payload mutation or request auto-execution is present.
