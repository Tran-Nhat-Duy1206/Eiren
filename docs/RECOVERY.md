# V8.6 guided recovery and restore drill — operator runbook

**Scope and evidence.** This preserves the V8.1 backup/restore procedure and adds conservative V8.6 governance verification. Eiren is not a backup service. The bot uses one Node process and PostgreSQL; startup does **not** apply migrations. V8.2 redactions/holds/policies and V8.3 point-in-time erasures can be lost when an older backup is restored. V8.6 exports an independently held, metadata-only obligation manifest and verifies a quarantined target **read-only**; it does not restore production, automatically repair data or replay Discord. `/healthz` is liveness; V8.4 `/readyz` adds bounded dependency-aware readiness, not recovery authorization. Production RPO and RTO are **NOT CLAIMED**. V8.5 UI work is parked and intentionally excluded from this functional release.

## Ownership and preflight

- Assign named owners for database backup, encrypted off-host storage, access control, retention/expiry, restore authorization, incident communications and deletion/hold decisions. Backup expiry and transport are **external operator responsibilities**, not bot features. Record the target database identity and environment privately; never infer a target from a default URL.
- Use Node.js **24+**, the repository's pinned **pnpm 10.28.2** (`package.json`), and PostgreSQL **17** server/client tools for the rehearsal. Verify executable versions and that the selected `pg_dump`, `pg_restore` and `psql` are PG17 (use `PG17_BIN` where supported or the CI PG17 service/container). Use an isolated PostgreSQL 17 **UTF-8** instance for drills (current migrations contain Unicode literals), not a live guild database.
- Before any production migration, arrange a consistent, operator-owned **pre-deploy backup** and prove it is readable and durably encrypted off-host. Review additive migration SQL and forward compatibility, schedule a maintenance/deployment window as appropriate, identify a tested code-version rollback candidate, and record a fix-forward owner. Applied migrations must never be rewritten. Do not treat reinstalling old binaries as database rollback.
- Keep credentials in a secret manager/private execution environment, never command-line literals, repository files, shell history, CI artifacts or logs. Restrict backup file and secret access to the recovery role; use encrypted transport and encryption at rest with keys separately controlled. A dump can include private ticket transcripts, reports, appeals, notes, IDs and dashboard metadata. Limit access, audit retrieval, securely dispose of transient plaintext and enforce an externally owned expiration policy including replicas/exports.

## Migration-before-start deployment

1. Verify the intended `DATABASE_URL` points to the approved target without printing it. Stop/drain the running bot and suppress accidental concurrent startup/Discord dispatch; take and verify the pre-migration backup **before** changing schema.
2. With the approved credentials and versioned artifact, run `pnpm install --frozen-lockfile`, then `pnpm db:check` and **`pnpm db:migrate` before `pnpm start`** (or before `pnpm dev` locally). Record migration journal version and the migration command outcome. `db:check` checks migration consistency; it is not a backup or restore validation.
3. Run appropriate database validation against a disposable/synthetic database, including `pnpm db:smoke`; do not run synthetic database checks on a production target. Only then start new code, verify process/Discord login and bounded functional checks, and inspect sanitized errors and outstanding ambiguous work. Register production commands separately where required, using the correct guild/global registration procedure.
4. On migration or startup failure, halt rollout and preserve logs, journal and backup. Prefer a reviewed **fix-forward** migration/code change. Revert to old code **only if its compatibility with the migrated schema is explicitly verified**; otherwise isolate and restore a known backup through an approved incident procedure. Never assume a forward migration can be undone by starting an older binary.

Production deployment additionally needs an externally managed restart policy, monitored database/gateway health, TLS termination and carefully configured trusted proxy/cookies for an enabled dashboard, least-privilege runtime DB account (with migration DDL credentials limited to the deployment window where supported) and sanitized log retention. Local Compose, loopback dashboard checks and `pnpm dev` do not prove those controls in a hosted environment.

## Operator-owned backup and isolated restore

1. Privately select the source database, backup time, encryption key custody and an isolated disposable **target**. Authenticate with secret-manager injection or protected connection configuration; do not paste URLs or secrets into tickets/output. Stop guessing if any DB identity is uncertain. Use the PG17 `pg_dump` client against the approved source to create a consistent custom-format archive, for example `pg_dump --format=custom --file=<restricted-local-archive> --dbname=<approved-source-database-name>`. The angle-bracket fields are operator-supplied placeholders, **not runnable values**. Restrict the temporary file, encrypt immediately, transmit/store off-host over a secure channel, verify integrity and recovery access, then remove plaintext according to policy. Never have the bot hold database dump credentials or upload a dump.
2. Provision a fresh isolated PostgreSQL 17 target with no production Discord token/OAuth secrets, no live guild access or outbound Discord sends. Verify its identity and empty/disposable status independently. Retrieve/decrypt the selected archive into a restricted temporary location. Restore with PG17 `pg_restore` using explicit approved target settings; only a separately authorized, positively identified disposable target may be replaced. This runbook intentionally supplies **no destructive drop/clean command** against an unspecified database. Capture exit status and sanitized diagnostics without leaking URLs, SQL payloads or private rows.
3. The repository's `pnpm db:restore-rehearsal` invokes `scripts/restore-rehearsal.mjs`. Supply explicit `DATABASE_URL` = **migrated synthetic source named `eiren_v8_<suffix>`** (CI's `eiren` is allowed only under GitHub Actions), `RESTORE_DATABASE_URL` = **distinct nonexistent target named `eiren_restore_<suffix>`**, and `RESTORE_REHEARSAL_CONFIRM=isolated-synthetic-only`. Both URLs must use the same loopback endpoint/credentials and **every public source data table must be empty** before the script inserts its fake marker. Select local PostgreSQL 17 client tools through `PG17_BIN` (directory containing `pg_dump` and `pg_restore`) or PATH; CI uses the official PostgreSQL 17 service tools with `RESTORE_PG17_CONTAINER`. The command rejects an existing target rather than dropping it, checks 21 ordered migration timestamps and SQL hashes through additive V8.3 migration 0020, inserts/removes only its synthetic source marker, dumps, creates the new target, restores, checks tables/FK/marker/journal, runs rollback-only `db:smoke` against the restored URL, and removes its temporary archive and owned target. Never aim it at production, a populated local dev DB or a nondisposable target. The confirmation string is a guard, **not** proof of isolation; verify endpoints privately first.
4. Verify archive integrity and restore completion; compare expected schema objects and Drizzle migration journal (`drizzle.__drizzle_migrations`, if present) against the approved migration set and source snapshot, including version/count/checksum evidence where available. Check representative table counts and constraints using **aggregate metadata only**, with expected differences explained (no private row exports). On the isolated target, run `pnpm db:smoke` with `DATABASE_URL` explicitly redirected to that restored target; record result and any intentional test-data rollback. Check application startup probes using synthetic/no-network harness where available, never with production Discord credentials. Record backup timestamp, source/target identities in a private record, archive digest, tool versions, migration version, checks, elapsed times, failures, remediation and approver. Destroy or retain the disposable target only under the approved evidence/retention policy; erase plaintext temporary material.
5. A real recovery additionally requires validating external Discord permissions/configuration and resolving external-action ambiguity separately. PostgreSQL restore does not undo Discord messages, roles or channels. Inspect scheduled outcomes, ticket cleanup, giveaway/event notifications, tempvoice reservations and Automation `UNCERTAIN` evidence before deciding any repair; **never blindly replay a send**. A restored backup can **resurrect previously deleted personal data**. V8.2 policy versions, target redaction markers, holds and 730-day metadata receipts live **inside the database being backed up**: restoring an older snapshot can lose them and resurrect private payload or a prior enabled policy. V8.2 does **not** supply restore-time deletion/hold replay or a backup erasure guarantee. An operator must quarantine the restore, compare approved post-backup policy/hold/redaction obligations from independently kept records, reconcile them before exposing the database, and never assume the worker alone remedies revived copies. V8.3 subject-request decisions and receipts also live inside the snapshot. V8.6 uses the independent manifest below to detect regressions; it intentionally ships **no automatic replay**.

## Recovery roles and activation authority

The backup custodian owns creation, encryption/key custody, off-host storage, archive integrity, retention and access. The recovery operator owns isolated restore and versioned tooling. The governance owner reviews redactions, holds, policy and subject obligations with the actual guild owner where required. A named release approver authorizes activation separately. Eiren stores no cloud backup credential, encryption key or scheduled backup uploader and performs no production restore.

Before an incident, record approved artifact/migration inventory, backup selection/integrity evidence and private source/target identities. Use existing `/operations`, `/automations`, `/data-retention` and `/privacy` for current authorized metadata; these are not new recovery pages or backup evidence. Preserve incident evidence without copying private narratives into an incident ticket.

## Independent recovery obligation manifest

Export **from the authoritative newer source**, not the older restored snapshot, after approved governance changes and before their database metadata expires. Retention and terminal subject receipts are retained for 730 days; an export cannot reconstruct receipts already pruned. Operators must keep sufficiently current exports independently of each backup and protect their retention/access under their own policy. A missing, stale or untrusted manifest prevents an honest governance clearance; a valid empty manifest is not proof that no historical deletion occurred.

Inject `DATABASE_URL` into the private process environment explicitly. The exporter does not bootstrap the bot, load `.env`, log the URL or contact Discord. Supply a **new** operator-owned `RECOVERY_MANIFEST_PATH`, or `--output <new-restricted-local-path>`, then run:

```text
pnpm recovery:export
```

Format **version 1**, schema marker **`repo/eiren-v8.6`**, includes:

- `generatedAt` UTC, expected migration count 21, latest tag `0020_subject_request_governance`, and SHA-256 `digest` of the canonical payload excluding the digest.
- `retentionReceipts`: guild/domain/record IDs, policy version, policy authorizer ID and redaction time; never the removed content.
- `activeHolds`: guild/domain/record IDs, held-by actor and held-at time. Membership in this array means active hold; no free-text reason.
- `retentionPolicies`: guild ID, enabled state, version, three configured day windows and paired confirmation actor/time.
- `subjectExecutionReceipts`: request/guild/subject IDs, execution time, fixed outcome, request version, five deletion counts and retained total; no inventory narratives.

Keys and rows are deterministically ordered; UTC database timestamps preserve microseconds. Validation rejects unknown fields, invalid versions/enums/IDs/counts, impossible duplicate keys and digest mismatch. Exports are bounded and fail rather than truncate. New files are published without replacing an existing file, with mode 0600 where supported; restrict the containing directory/Windows ACL and verify access independently. Metadata identifiers are personal/accountability data, **not anonymous or public**. Do not commit real manifests or attach them to public CI artifacts.

A SHA-256 digest detects corruption, **not malicious replacement/authenticity**: a party able to replace both payload and digest can recompute it. Independently authenticate custody, source, export time and approved artifact. Encrypt/protect off-host manifests under operator control; do not treat the hash as a signature or deletion ledger with unlimited history.

## Quarantine and read-only recovery verification

Keep the restored target isolated from normal bot startup, schedulers, dashboard and Discord dispatch. Restore separately using the approved PG17 procedure above. Apply required approved migrations as a **separate deployment action before startup**; verification never migrates or drops a database.

The shipped verifier requires explicit environment inputs:

```text
RECOVERY_DATABASE_URL      private loopback URL for eiren_recovery_<suffix>
RECOVERY_MANIFEST_PATH     independently preserved manifest path
RECOVERY_VERIFY_CONFIRM    isolated-restored-target
RECOVERY_REPORT_PATH       optional new restricted JSON report path
```

Then run `pnpm recovery:verify`. If the source `DATABASE_URL` is known, keep it privately available for distinct-target checks. Positively identify both databases independently; different credentials or loopback aliases do not prove isolation. Automated CI/drills use only new disposable databases. A future real private-network recovery needs separate approved isolation procedures; do not bypass the shipped loopback/name guards or assume a confirmation phrase proves the target safe.

The tool first checks connectivity, PostgreSQL 17, all **21 ordered migration timestamps and checked-in SQL hashes** through `0020_subject_request_governance`, and required governance/eligible-state tables. Supported checkout newline hashes are explicit inventory variants, not acceptance of arbitrary SQL. Mismatch fails closed as `MIGRATION_MISMATCH`; do not repair the journal or auto-run migrations from verification. Use the approved artifact and migration-before-start procedure.

Observations run in a bounded `REPEATABLE READ READ ONLY` transaction, rolled back on every exit. No INSERT/UPDATE/DELETE, Discord I/O or repair command exists. Console and optional restricted report contain fixed categories/counts, manifest digest/time, verification time, migration result and safe stage—not offending payload, SQL, connection information, raw exception or stack trace. `PASS` means all exported obligations were ready **within this snapshot and these limits**; any non-ready result exits nonzero.

## Governance findings and reconciliation gates

| Fixed finding | Operator decision; no automatic action |
| --- | --- |
| `READY` | Exported obligation meets the limited metadata/predicate check; not authorization by itself. |
| `REDACTION_REPLAY_REQUIRED` | Quarantine. Locate the guild/domain/record privately using the manifest; approve a separately controlled remediation of already-required redaction. Do not expose restored payload. |
| `HOLD_REAPPLY_REQUIRED` | Quarantine. Reconcile exact active hold/actor/time with the governance owner before any retention worker can run. |
| `POLICY_STATE_MISMATCH` | Quarantine. Review restored enabled/disabled state, version, windows and confirmation metadata; never blindly enable/disable retention. |
| `SUBJECT_ERASURE_REPLAY_REQUIRED` | Quarantine. Review obvious resurrection of eligible aggregate/award state against the point-in-time execution obligation; no verifier deletion. |
| `AMBIGUOUS_REVIEW_REQUIRED` | Quarantine. Counts/time alone cannot determine exact historical disposition; obtain independent evidence and governance approval, not a blind erasure/replay. |
| `MIGRATION_MISMATCH` | Fail closed; reconcile approved migration artifact/deployment separately. |
| `MANIFEST_INVALID` | Fail closed; obtain the authentic supported manifest. Missing/tampered/invalid input is not an empty healthy manifest. |
| `UNAVAILABLE` | Fail closed; resolve guarded configuration/connectivity/observation failure privately, without publishing raw errors. |

For retention receipts, a missing parent is acceptable. Existing ticket payload must have NULL transcript plus redaction time/version; reports must have NULL description/evidence/resolution plus markers; appeals NULL reason/review note plus markers. Version must not regress below the exported receipt. Target receipts may be absent because they were created **after** the backup; the external manifest supplies that independent obligation. Verification never prints those payloads.

A missing parent does not require recreating it to reapply a hold. An existing parent must retain the exact exported active hold state. Preserve V8.2's approved owner authority and prohibition on placing a hold on already-redacted content; conflicting evidence needs review, not policy changes by this tool. Policy comparisons are exact metadata checks, including disabled state, not assumptions that an old policy will eventually catch up.

Subject erasure checks are limited to `member_levels`, `member_reputation`, `member_achievements`, and matching subject `user_id` in `event_participants`/`event_attendance`, with guild-scoped event parents. ACTIVE/SCHEDULED children remain retained; unresolved terminal presentation is not automatically erasable. `marked_by`-only attendance is retained accountability and reputation grants remain outside erasure. No narrative inventory or cross-guild record-ID-only matching is used.

**Point-in-time limitation:** future legitimate activity can recreate personal state. Receipt deletion counts do not identify every erased event/award or reconstruct historical event transitions. Post-execution/recreated or otherwise indeterminate eligible state is `AMBIGUOUS_REVIEW_REQUIRED`, not silently HEALTHY. In particular, surviving terminal event rows cannot be proved erased by aggregate receipt counts alone; they require review even when current presentation is settled. Clear replay and ambiguity can coexist. This is not permanent suppression, universal erasure or a backup deletion guarantee.

**Do not start normal schedulers while any redaction, hold, policy, subject-erasure or ambiguous finding remains unresolved.** The normal retention worker is not a recovery replay mechanism and may apply an older restored policy before lost holds are reinstated. Keep an independently authorized remediation/evidence record and rerun verification; the release approver must still review manifest completeness and external ambiguity. There is no `fix-all`, generic retry, continue-anyway button or automatic UNCERTAIN resolution.

## Ticket ambiguity decision tree

1. Inspect durable guild-scoped ticket ID, status, `channel_id`, creation/closure state and authorized transcript/accountability metadata. The database alone cannot prove a Discord channel exists.
2. For unknown creation outcome, manually inspect the correct guild/category/channel ownership and compare durable identity. A reservation or absent `channel_id` does **not** authorize another channel create. An observed matching channel still needs an authorized domain-specific decision; do not silently patch IDs.
3. For a closed ticket still referencing a channel, inspect that exact Discord channel manually and verify ownership/current occupants/history and existing transcript/redaction obligations. Closure is not authorization to blindly close/delete again or regenerate redacted content.
4. If Discord existence, identity or prior outcome cannot be proven, classify the incident ambiguous and preserve accountability. Do not create, close or delete automatically. V8.6 adds no ticket mutation.

## Giveaway ambiguity decision tree

1. Inspect guild-scoped giveaway status, durable original/reroll draw, winners, announcement/result IDs and per-draw notification claim. Preserve draw/winner history; an uncertain notification is **never** a reason to reroll.
2. `PENDING:` post/announcement tokens are claims, not Discord message IDs or proof of delivery. Per-draw notification timestamps/claims fence database ownership, not exactly-once external sends. Compare durable draw identity with Discord manually; a missed response may follow a successful send.
3. Existing result reconciliation uses a stored result ID or `findAnnouncement` for that draw before announcing; finish/release is claim-fenced. Existing active-post replacement remains best effort, not a no-duplicate proof. Do not blindly resend a result or invoke reconciliation to bypass unresolved external evidence.
4. Use the existing scheduler/reconciliation only after its already-established identity/lookup predicates prove the particular path safe and activation is approved. Otherwise keep ambiguity for manual review. No new draw, reroll, repair or notification replay action is supplied.

## Tempvoice ambiguity decision tree

- **CREATING:** a reservation is not permission for duplicate channel creation. Inspect exact guild/owner/reservation markers across voice channels; category configuration may have changed. Existing reconciliation attaches only one proven reservation match; zero/multiple matches remain unresolved rather than prove absence.
- **ACTIVE:** durable state does not prove Discord existence. Inspect exact `channel_id`, guild, ownership and occupants externally. Existing startup reconciliation handles a proven missing channel through its established path; do not create a substitute merely because an old backup says ACTIVE.
- **DELETING:** never delete an arbitrary or newly reused channel. Prove ownership/ID, inspect occupants and permissions. Existing cleanup row-locks/rechecks state, seals and checks occupants; Discord joins remain an external race, not a two-instance exactly-once guarantee.
- If identity/outcome cannot be proven, preserve ambiguity. Existing safe startup reconciliation remains authoritative; V8.6 adds no mass repair.

## Automation UNCERTAIN and existing concurrency fences

Use the existing `/automations` authorized **inspect/reconcile** workflow and the [existing Automation guidance](../README.md#v74v75-scheduled-automation-and-dashboard), not a second recovery flow. External side effect unproven means **do not blindly retry**. An UNCERTAIN classification is not automatically changed by restore verification; preserve its evidence and existing actor/claim guards.

No production repair command exists, so **two-instance repair locking is not applicable to V8.6 mutation behavior**. Reviewed existing paths are unchanged: giveaway conditional `PENDING:`/per-draw claims and draw history; tempvoice reservations/row-locked cleanup; Automation PostgreSQL guild/row locks, SKIP LOCKED claims, token/lease fencing and explicit UNCERTAIN reconciliation. Those mechanisms do not make unknown Discord sends generally replay-safe. No independently proven new universal no-replay-safe repair primitive was selected; this release is intentionally observational/guided.

## Activation checklist — named operator confirmation required

- [ ] Approved backup selected; archive integrity/custody verified privately.
- [ ] PostgreSQL 17 isolated restore succeeded; source and target independently identified.
- [ ] Approved migration journal/count/timestamps/hashes match; required migrations applied **before start**.
- [ ] Independently authenticated, sufficiently current recovery manifest verified.
- [ ] No unresolved redaction replay or hold/policy mismatch.
- [ ] No unresolved subject-erasure resurrection or ambiguous governance classification.
- [ ] Ticket, giveaway and tempvoice unknown Discord outcomes reviewed externally.
- [ ] Existing Automation UNCERTAIN workflow/evidence reviewed without blind retry.
- [ ] Incident-required secrets rotated and runtime access/dispatch approved.
- [ ] Release approver records authorization; only then start normally.
- [ ] `/readyz` healthy after startup, with gateway/scheduler/dependency checks reviewed.

This checklist is not a programmatic bypass. A green `/readyz` or verifier alone does not authorize activation or certify backup completeness/privacy compliance.

## V8.6 disposable recovery drill and measurement limits

`pnpm recovery:drill` is separate from the preserved `pnpm db:restore-rehearsal`. Set `RECOVERY_DRILL_CONFIRM=isolated-synthetic-only` and explicit `RECOVERY_DRILL_DATABASE_URL` for the approved synthetic loopback PG17 admin endpoint (synthetic `eiren_v8_<suffix>`, or CI `eiren` only under GitHub Actions). Use `PG17_BIN` for native PG17 tools; CI uses its official PG17 service via `RECOVERY_PG17_CONTAINER`.

The drill creates only new uniquely owned databases/files: seed synthetic Guild A/B and private/subject sentinel fixtures at T0 → real custom-format synthetic backup → apply approved V8.2 redactions/hold/policy and execute a synthetic V8.3 request at T1 → export independent manifest → restore T0 into a distinct target → **BLOCKED** → known fixture corrections inside the test harness only → **READY**. It also probes tamper/migration/ambiguity/availability guards and unchanged target snapshots. The controlled correction SQL is not an operator API or shipped fix-all. No live Discord transport/login is used: **zero Discord sends/replay**. Owned databases/archives/manifests are cleaned even on failure; preexisting/unowned targets are never replaced.

Elapsed restore/verification measurements are **synthetic drill measurements only**, not production objectives. Production backup restore: **NOT PERFORMED**. Production RPO/RTO: **NOT CLAIMED**. Real guild/user mutation: **NONE**.

## CI and evidence boundaries

CI should use synthetic credentials and isolated PostgreSQL 17, pin Node 24/pnpm 10.28.2, migrate before database checks, and run `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm db:check`, `pnpm db:smoke`, `pnpm db:v4`, `pnpm db:v5`, `pnpm db:v6`, `pnpm db:v7`, `pnpm db:v8` on a strictly empty disposable V8 source plus a distinct owned upgrade database, and `pnpm dashboard:check` where configured. Separate disposable databases/test fixtures and check for real secrets, real guild IDs or outbound Discord actions. A green CI restore rehearsal proves only a disposable synthetic dump/restore and checks; it is **not** evidence of an encrypted off-host production backup, hosted restart/TLS monitoring, live Discord/human OAuth workflows, a production restore or measured RPO/RTO. Enable required-check branch protection only after CI is implemented and stable. Record each production expectation separately from evidence actually observed, and rerun/record periodic restore drills under operator ownership.
