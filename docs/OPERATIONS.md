# V8.4 — Health and Operations visibility

Operations observes existing evidence; it does not repair it. No migration, durable heartbeat/checkpoint, new dependency, extra process or Discord side effect is introduced. Migration inventory remains 0000–0020 (21). AI stays null-provider and Message Content stays OFF.

## Anonymous machine endpoints

Both endpoints exist only when the existing opt-in dashboard HTTP server exists. Startup order is unchanged: every existing connectivity/table probe must succeed before Discord login, and the dashboard starts in the existing login path. No second HTTP server or earlier-start promise is made.

- `GET /healthz`: liveness only, always the fixed HTTP 200 `{ "status": "ok" }` while the server is alive. No database, Discord, guild, session or scheduler probe/mutation.
- `GET /readyz`: HTTP 200 `status=ready` only when the process phase is RUNNING, PostgreSQL responds, migration metadata is current, `client.isReady()` is true and **both** V5 and moderation schedulers are fresh. Otherwise HTTP 503 `status=not_ready`. `checks` contains only fixed database/migrations/gateway/scheduler enums. No counts, IDs, timestamps, job names, hashes, exception names/messages or configuration.
- Both are `Cache-Control: no-store`; machine probes do not consume the dashboard action rate budget. Readiness is not a repair/restart/send/retention/privacy-execution trigger.

The same-process readiness reader has its own small pool, separate from both product writes and Operations diagnostic scans. Acquisition is bounded at 500ms, PostgreSQL statement timeout at 1500ms, each read at 2200ms and the **combined** readiness probe at 2200ms. Reads use READ ONLY transactions. Failed, timed-out and late-acquired clients are destroyed. The completed database result is cached for 2 seconds (failures too), concurrent probes collapse, and there is no cache refresh timer. Gateway, process phase and scheduler freshness are re-evaluated live even within this cache period.

`SELECT 1` establishes connectivity. Minimal `drizzle.__drizzle_migrations` metadata establishes schema compatibility: count 21, latest timestamp 1791017773296 and the exact 0020 SQL hash. The static descriptor accepts only the explicitly derived LF/CRLF byte representations of the same checked-in SQL, since Drizzle hashes raw checkout bytes; regression tests verify both, the ordered journal, count and latest tag `0020_subject_request_governance`. No migration SQL is read on a request. Reachable but wrong count/hash/timestamp is `mismatch`; an unreadable journal is `unavailable`. No automatic migration or journal write occurs.

## Runtime telemetry — since process restart

The tracker initializes before environment/database/login startup and records application process startup time. All phase/probe/reconciliation/scheduler timestamps and failures exist **only in memory**. Uptime is relative to tracker initialization. Phases are STARTING/RUNNING/STOPPING; shutdown fences readiness immediately, and a late login completion cannot reset STOPPING.

V5 retains the exact eight ordered jobs: events, giveaways, tempvoice, analytics, automation, ai-maintenance, data-retention, subject-request-maintenance. The separate moderation scheduler retains moderation-expiry. Timers remain 30-second wakeups; overlap returns the existing tick promise and stop drains it. PostgreSQL still owns all existing leases, limits and side-effect/retry semantics.

Freshness is `max(3 × interval, 90 seconds)`: STARTING before first completed tick, STALE after the start/last completion or an active tick exceeds the threshold, HEALTHY after a recent completion without a stale active tick, STOPPED after stop. A job failure remains isolated; later jobs still run and a fresh completed scheduler can remain readiness-ready. Job state can be DEGRADED independently. Last failure metadata remains visible even after recovery, without presenting the recovered job as degraded.

Categories are bounded DATABASE/DISCORD/TIMEOUT/CONFLICT/VALIDATION/PERMISSION/INTERNAL/UNKNOWN. Only allowlisted static stages are retained; no raw errors, arbitrary class names, messages, SQL, REST bodies or payloads. Tempvoice and analytics voice startup reconciliations record PENDING/RUNNING/SUCCEEDED/FAILED/NOT_APPLICABLE. These are top-level startup work states; existing per-guild deferral/handling remains authoritative, not a new claim that all guild reconciliation succeeded.

## Authenticated Operations

`/g/:guildId/operations` requires Eiren ADMIN+ through the existing fresh guild/member/roles authorization; OAuth discovery cache alone confers no permission. It uses the existing SSR HTML/CSS/CSP, no JavaScript UI or redesign. Normal GET refresh is sufficient; there are no Operations mutations or CSRF refresh forms. Existing authentication housekeeping (session idle-expiry renewal/expired-session cleanup and ordinary cookies) is unchanged; READ ONLY describes the Operations read model, not a claim that the entire authenticated request performs zero session DML.

- Global process/readiness and both scheduler panels are labeled **Since process restart**, with UTC timestamps and process-clock uptime.
- Guild modules use ModuleService effective unavailable/default/dependency semantics; core is always enabled, absent overrides have epoch 0. Epoch is a transition fence, not a semantic release version or provider-health claim.
- Nineteen static diagnostic aggregates bind the selected guild (or indexed parent join): Automation PENDING/RUNNING/UNCERTAIN plus action uncertainty; audit gaps; event pending presentation/due lifecycle/processing reminders; giveaway due lifecycle/unresolved presentation/results/draw notification; tempvoice CREATING/DELETING; unresolved ticket placeholders; retention enabled/holds and active subject requests.
- Counts/MIN timestamps/ages only, calculated with PostgreSQL time. No private narrative/configuration/IDs or large row lists are selected for diagnostics. All diagnostic reads have short statement/wall bounds; affected reads become UNAVAILABLE with null counts, not fabricated zero. Existing indexed query alternatives are verified by synthetic EXPLAIN; no index/migration was needed. Tiny-fixture forced-index plans are not production latency guarantees.
- Freshly due event/giveaway transitions are PENDING for a conservative 90-second cadence window; STALE is age evidence, **not** proof of failure or safe retry. Existing claim windows are retained: reminder 300s; giveaway post 300s/result 120s/draw 300s; tempvoice 60s. A ticket OPEN/CLAIMED placeholder with null channel uses a conservative 600-second warning window, not proof about external channel existence. Timestamp sources are existing update/claim/create/due fields, not invented durable failure times.
- Automation UNCERTAIN means the external side effect cannot be proven: do not blindly retry; inspect and reconcile. Only a link to the **existing guarded Automations workflow** is provided. A governance audit gap means the domain mutation committed but the normal dashboard audit write was not confirmed; do not repeat that mutation. Existing Data Retention/Privacy pages remain authoritative, with links only.

Explicit NOT_TRACKED boundaries: production backup health, actual Discord ticket-channel orphan state, external TLS/reverse-proxy health and scheduler failures before this process restart. Unknown is not zero, healthy or resolved. A synthetic restore proves mechanics, not production backup availability/RPO/RTO.

The authenticated page requires database-backed sessions/data and fresh Discord authorization; dependency outages can prevent it rendering. When the HTTP server remains alive, `/healthz`, `/readyz` and sanitized process logs are available without authentication. No out-of-band admin console or deployment/proxy monitoring is claimed. V8.5 redesign and V8.6 recovery/repair remain separate and unimplemented.
