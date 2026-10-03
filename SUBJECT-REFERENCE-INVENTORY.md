# V8.3 structured subject-reference inventory

## Contract and completeness

The registry in `src/modules/subject-requests/inventory.ts` covers all **67 schema tables**: **40 direct-reference tables / 65 qualified user-reference columns**, one explicitly related uncertain-execution family, and 26 no-direct-reference tables. The original V8.2 schema contributes 36 tables / 55 qualified fields; V8.3 governance adds four direct-reference tables / ten fields. `dashboard_audit_log.target_id` is a user reference **only for the exact `moderation-warn` target contract**, not for arbitrary decimal-looking object IDs.

Inventory is internal metadata, not a payload export. Discord snowflakes are exact text. Bot-owned bigint/bigserial IDs use exact decimal strings, UUIDs remain strings, and identities are canonical tuples. A row matching several actor/subject roles is counted once with all matching role labels. There is no blind text/JSON search, recursive ancestry scan, Discord I/O or discovery-based deletion.

Only `member_levels`, `member_reputation`, `member_achievements`, and subject-owned terminal-safe event participation/attendance can be erased. Every other family is retained with a static policy category. Event attendance matched solely through `marked_by` is another member's accountability record and is never eligible for erasure.

## Complete direct-reference registry

`G` means explicit `guild_id = request guild`. Parent joins are required where the child has no guild column. All numeric identity components below are read as decimal text, not JavaScript numbers.

| Family / SQL table | All qualified user-reference SQL columns | Canonical identity and guild scope | Policy category |
| --- | --- | --- | --- |
| `guild_modules` | `updated_by` | `[G,module_key]` | RETAIN `CONFIGURATION_ACCOUNTABILITY` |
| `moderation_cases` | `target_id`, `moderator_id` | `[id]`, G | RETAIN `MODERATION_ACCOUNTABILITY` |
| `verification_settings` | `updated_by` | `[G]` | RETAIN `CONFIGURATION_ACCOUNTABILITY` |
| `member_verifications` | `user_id`, `verified_by`, `rejected_by` | `[id]`, G; also unique `[G,user_id]` | RETAIN `VERIFICATION_ACCESS_STATE` |
| `antiraid_settings` | `emergency_actor_id`, `updated_by` | `[G]` | RETAIN `ANTI_ABUSE_OR_REPLAY` |
| `join_history` | `user_id` | `[id]`, G | RETAIN `ANTI_ABUSE_OR_REPLAY` |
| `moderator_notes` | `target_id`, `moderator_id` | `[id]`, G | RETAIN `MODERATION_ACCOUNTABILITY` |
| `role_menus` | `created_by` | `[id]`, G | RETAIN `CONFIGURATION_ACCOUNTABILITY` |
| `retention_policies` | `confirmed_by` | `[G]` | RETAIN `RETENTION_GOVERNANCE` |
| `retention_previews` | `requested_by` | `[id UUID]`, G | RETAIN `RETENTION_GOVERNANCE` |
| `retention_receipts` | `policy_authorizer_id` | Unique `[G,domain,record_id]`; no PK | RETAIN `RETENTION_GOVERNANCE` |
| `tickets` | `creator_id`, `assigned_staff_id`, `closed_by`, `retention_hold_by` | `[id]`, G | RETAIN `TICKET_ACCOUNTABILITY` |
| `ticket_participants` | `user_id`, `added_by` | `[ticket_id,user_id]`; join `tickets.id=ticket_id`, scope `tickets.guild_id` | RETAIN `TICKET_ACCOUNTABILITY` |
| `reports` | `reporter_id`, `reported_user_id`, `assigned_staff_id`, `closed_by`, `retention_hold_by` | `[id]`, G | RETAIN `REPORT_APPEAL_EVIDENCE` |
| `appeals` | `appellant_id`, `reviewer_id`, `retention_hold_by` | `[id]`, G | RETAIN `REPORT_APPEAL_EVIDENCE` |
| `suggestions` | `author_id`, `reviewed_by` | `[id]`, G | RETAIN `SUGGESTION_HISTORY` |
| `suggestion_votes` | `user_id` | `[suggestion_id,user_id]`; join `suggestions.id=suggestion_id`, scope its guild | RETAIN `SUGGESTION_HISTORY` |
| `member_levels` | `user_id` | `[G,user_id]` | ERASE `MEMBER_LEVEL_STATE` |
| `member_reputation` | `user_id` | `[G,user_id]` | ERASE `MEMBER_REPUTATION_AGGREGATE` |
| `reputation_grants` | `giver_id`, `receiver_id` | `[id]`, G | RETAIN `REPUTATION_GRANT_HISTORY` |
| `starboard_messages` | `source_author_id` | `[id]`, G | RETAIN `STARBOARD_HISTORY` |
| `community_events` | `creator_id` | `[id]`, G | RETAIN `EVENT_CREATOR_ACCOUNTABILITY` |
| `event_participants` | `user_id` | `[event_id,user_id]`; join `community_events.id=event_id`, scope its guild | ERASE `TERMINAL_EVENT_PARTICIPATION` only for safe terminal parent; otherwise RETAIN event-state category |
| `event_attendance` | `user_id`, `marked_by` | `[event_id,user_id]`; same event parent/guild join | Subject-owned safe terminal row: ERASE `TERMINAL_EVENT_ATTENDANCE`; staff-only match: RETAIN `EVENT_STAFF_ACCOUNTABILITY`; other own rows RETAIN event-state category |
| `giveaways` | `creator_id` | `[id]`, G | RETAIN `GIVEAWAY_HISTORY` |
| `giveaway_entries` | `user_id` | `[giveaway_id,user_id]`; join `giveaways.id=giveaway_id`, scope its guild | RETAIN `GIVEAWAY_HISTORY` |
| `giveaway_winners` | `user_id` | `[draw_id,user_id]`; scope through **winners.giveaway_id -> giveaways.id/guild_id** | RETAIN `GIVEAWAY_HISTORY` |
| `tempvoice_rooms` | `owner_id` | `[id]`, G | RETAIN `TEMPVOICE_OPERATIONAL_STATE` |
| `member_achievements` | `user_id` | `[G,user_id,achievement_id]` | ERASE `ACHIEVEMENT_AWARDS` |
| `analytics_member_state` | `user_id` | `[G,user_id]` | RETAIN `ANALYTICS_OPERATIONAL_STATE` |
| `analytics_active_voice_sessions` | `user_id` | `[G,user_id]` | RETAIN `ANALYTICS_OPERATIONAL_STATE` |
| `dashboard_sessions` | `user_id` | Global physical PK `token_hash` is **not selected**. Match user AND typed `oauth_guild_ids` contains G; inventory identity `[user_id,created_at epoch,absolute_expires_at epoch]`, preserving multiset multiplicity | RETAIN `OUT_OF_SCOPE` |
| `dashboard_audit_log` | `actor_user_id`; `target_id` only when `target_type='moderation-warn'` | `[id]`, G | RETAIN `GOVERNANCE_AUDIT` |
| `ai_requests` | `user_id` | `[id UUID]`, G | RETAIN `AI_ACCOUNTING` |
| `automations` | `authorized_by` | `[id]`, G | RETAIN `AUTOMATION_ACCOUNTABILITY` |
| `automation_action_runs` | `reconciled_by` | `[execution_id UUID,position]`; join execution, scope `execution.guild_id`; rule join also requires rule/execution guild equality | RETAIN `AUTOMATION_ACCOUNTABILITY`, or `AUTOMATION_UNCERTAIN` for uncertain run/parent |
| `subject_requests` | `subject_user_id`, `previewed_by`, `confirmed_by`, `denied_by` | `[id UUID]`, G | RETAIN `PRIVACY_GOVERNANCE` except current-workflow evidence excluded from primary digest/outcome |
| `subject_request_previews` | `subject_user_id`, `reviewed_by` | `[id UUID]`, G; FK binds request/guild/subject | RETAIN `PRIVACY_GOVERNANCE` except previews linked to current request |
| `subject_execution_receipts` | `subject_user_id`, `confirmed_by`, `executed_by` | `[request_id UUID]`, G; FK binds request/guild/subject | RETAIN `PRIVACY_GOVERNANCE` except current request receipt |
| `governance_audit_gaps` | `actor_user_id` | `[id UUID]`, G | RETAIN `GOVERNANCE_AUDIT` except exactly correlated current privacy-action evidence |

### Terminal event safety

For both subject-owned child families, eligibility requires parent status `COMPLETED` or `CANCELLED`, **`presentation_pending = false`**, and **`presentation_retry_at IS NULL`**. `SCHEDULED`/`ACTIVE` parents produce `ACTIVE_EVENT_STATE`; terminal parents with unresolved presentation produce `UNRESOLVED_EVENT_PRESENTATION`. Subject membership in `event_attendance.marked_by` alone never authorizes deleting another attendee's row. Execution must recheck under the parent-first lock order used by existing event writers.

### Explicit uncertain-automation relationships

`automation_executions` has no direct actor column. It is the single approved derived inventory family: only unresolved executions (execution status `UNCERTAIN` or an uncertain action run) with a subject-authorized rule or a subject reconciliation actor are included, as retained `AUTOMATION_UNCERTAIN`. Joins require matching execution/rule guilds. Uncertain action-run rows similarly expose only the direct reconciliation match and/or the subject's rule authorization match, with exact family/identity deduplication. No action config or message is inspected.

### Current-workflow evidence boundary

The current request, its FK-linked previews/receipt, and audits/gaps with **all** of: `target_id = current request UUID`, action in the exact `privacy-preview|privacy-confirm|privacy-execute|privacy-deny` set, and `target_type = action`, remain retained and displayed separately. They are excluded from the primary inventory digest and `COMPLETED/PARTIAL` calculation. SQL exclusion is NULL-safe: historical rows with NULL targets are retained. Other actions, target types, request IDs and historical governance are not excluded.

The hash **does bind the fixed context** `[requestId,guildId,subjectUserId,requestVersion]`. Parent confirmation/execution supplies the same preview version N; changing current request workflow rows or incrementing its operational version to N+1 is not hashed as primary data. Request/preview authorization and version fencing remain separate checks.

## No-direct-reference tables

The following 26 tables have no direct user field and no independent subject scan. Their underlying state is retained:

`guilds`, `guild_settings`, `guild_permission_roles`, `role_menu_options`, `ticket_settings`, `suggestion_settings`, `levels_settings`, `level_rewards`, `level_ignored_channels`, `reputation_settings`, `starboard_settings`, `starboard_ignored_channels`, `event_reminders`, `giveaway_draws`, `tempvoice_settings`, `analytics_settings`, `analytics_guild_hourly`, `analytics_channel_hourly`, `analytics_command_hourly`, `analytics_event_dedupe`, `ai_settings`, `ai_usage_daily`, `automation_actions`, `automation_execution_attempts`, `automation_execution_actions`, `subject_request_preview_counts`.

`subject_request_preview_counts` is FK-owned aggregate governance metadata, not an independent subject reference. `retention_receipts.record_id` identifies a bot-owned target, not a Discord subject; this registry matches its explicit authorizer only, never expands arbitrary target ancestry. `ai_requests.request_key` and analytics dedupe keys refer to interactions/messages, not users.

## Metadata hash whitelist

`SUBJECT_REFERENCE_REGISTRY` exposes the exact identity and state expressions used by SQL. Every projection selects only `identity`, static matching-role labels and an explicit scalar `state` array. No `SELECT *` or raw row serialization is used. Timestamps are UTC-independent epoch strings; bigint IDs/counters are decimal strings. Hashing sorts canonical entries and merged roles deterministically, binds the fixed request context, preserves session multiplicity, and fails closed on conflicting duplicate metadata or invalid/rounded identity values.

Selected state consists only of:

- Community profile XP/message counts and activity/update timestamps; reputation score/update timestamp; achievement award timestamp.
- Event parent fixed status/presentation pending/retry/update/start/end metadata plus child join/mark timestamp.
- Retained record fixed statuses/type/action/method, boolean hold/module state, numeric counters/versions, authorization/terminal/update timestamps, fixed accountability identifiers.
- Privacy governance fixed status/version/window/count/time metadata; audit action/type/success/request correlation/time; gap commit/detection time.
- AI admission/settlement status, epoch/day, token/cost counters and lease/settlement times.
- Automation capability/config versions, fixed status/error/reconciliation metadata and timestamps, never rule names/configuration messages.
- Global session **only** user ID, creation time and absolute expiry. Token hashes, display names, sliding expiry/last-seen values and extra OAuth guild IDs are neither selected nor hashed. A global session lacking the request guild is outside this guild inventory and is never deleted.

Never hash or export: transcript; description/reason/review/resolution/close text; moderator notes; suggestion content/staff response; evidence URL; configured messages; arbitrary names; opaque JSON; `member_levels.last_fingerprint`; credential-derived session identity. **`reports.category` is arbitrary user-provided text, not an enum**, and is excluded as well.

## Structured JSON review

The only current JSON contracts are:

| Table.column | Explicit contract / subject treatment |
| --- | --- |
| `moderation_cases.metadata` | Generic metadata; current purge contract contains channel/count, no typed user path. No scan. |
| `member_verifications.metadata` | Generic verification flags/reasons, no typed user path. No scan. |
| `join_history.signals` | Short labels, not user identities. No scan. |
| `dashboard_sessions.oauth_guild_ids` | Typed guild-ID membership, used only as a guild filter. Never return/hash other guild IDs. |
| `automations.trigger_config` | Strict scheduled kind/time/timezone/at configuration; no actor snapshot. No scan. |
| `automation_actions.config` | Strict channel/message configuration, no typed actor snapshot. No scan. |
| `automation_execution_actions.config` | Captured channel/message configuration; legacy inert opaque blobs do not grant scan permission. No scan. |

Future typed actor/authorization snapshots require an explicit path contract and registry amendment; they are retained accountability metadata, not blind JSON discovery.

## Existing index coverage — not speculative migrations

This inventory change adds no indexes. The list below documents current leading-column coverage; it is not a new EXPLAIN claim. Keep existing V8.2 cutoff-query evidence unchanged. Measure actual inventory plans before proposing any additional index.

| Query family / role | Existing usable leading columns |
| --- | --- |
| Levels/reputation/achievements | Composite PK `(guild_id,user_id,...)`; achievement member-awarded index also starts guild/user |
| Member verification/join history | Unique `(guild_id,user_id,...)` |
| Analytics member/voice state | PK `(guild_id,user_id)` |
| AI requests | `ai_requests_user_created_idx(guild_id,user_id,created_at)` |
| Moderation/notes target | Guild-target-created indexes; moderator lookup uses guild prefix with residual actor predicate |
| Tickets creator | `tickets_guild_creator_status_idx`; other actor roles use guild-created prefix |
| Reports reporter / appeals appellant | Reporter/appellant-created indexes; other roles use guild-status-created prefix |
| Reputation grants | Guild-giver-recent and guild-receiver indexes; `(guild,giver,receiver,...)` does not support receiver alone without giver |
| Singleton configs / module actors | Guild PK; modules PK starts guild |
| Role menus/suggestions/starboard/events/giveaways | Existing guild-leading indexes; actor identity is residual when not a leading field |
| Retention receipts | Unique `(guild_id,domain,record_id)` supplies guild prefix, not authorizer-specific lookup |
| Audits/gaps | Guild-created / guild-committed indexes, actor residual |
| Automations | Guild-enabled / guild-id indexes, authorizer residual |
| Tempvoice | Guild-channel unique covers all states. Active-owner unique is partial and **not sufficient for CLOSED rows**. |
| Ticket/suggestion/event/giveaway children | Guild-filtered parent indexes plus child parent-leading PKs; exact parent/user probes |
| Giveaway winners | `(giveaway_id,user_id)` supports the chosen guild join. Draw/user PK alone is not a guild boundary. |
| Automation run / uncertain execution | Execution `(guild_id,id)` index and run `(execution_id,position)` PK; actor predicates are explicit residuals |
| Historical subject requests | Guild-subject-latest index supports subject; other actor roles use guild-recent prefix |
| Subject previews / execution receipts | Guild-request-recent / guild-executed-recent prefix; subject/reviewer/authorizer residual |
| Retention previews / global sessions | **No existing relevant guild/subject-leading index**; expiry indexes do not supply this coverage |

## Guarantees and explicit non-guarantees

This is reviewed one-time deletion of approved guild-scoped community rows, not a permanent opt-out, account purge, pseudonymization of accountability records, removal of Discord copies or historical backup erasure. Future legitimate activity/hooks can create community data again. Viewing achievements is intended to be read-only in V8.3; this registry does not implement suppression or cooldown policy. Retained giveaway/event evidence remains retained even where a future legitimate hook may award an achievement.

Inventory collects whole matched metadata state in a fixed sequential query set; the parent service is responsible for consistent serializable snapshots, applicable locks, preview freshness/version fences, authorization and exact-target deletion. No private payload is needed to decide eligibility or construct the digest.

## Mechanical regression guard

`inventory.test.ts` requires the schema table set to equal registry plus explicit no-reference tables, checks every structured user/actor field, and classifies every TEXT column and every JSON contract. A future unknown table, unclassified identity-like string field, or new JSON snapshot fails rather than being silently omitted. Tests additionally cover parameter binding, all child guild joins, qualified audit targets, NULL-safe exact current-workflow exclusions, same-count state/identity digest changes, request-context binding, multi-role deduplication, session multiset behavior, every event eligibility boundary, approved erase families, uncertain automation evidence, and private-field non-propagation.
