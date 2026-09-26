# V5 validation — events, giveaways, temporary voice and achievements

## Final automated checks

- `pnpm typecheck`, `pnpm test` (**212/212 tests, 26/26 files**), `pnpm build` and `pnpm db:check`: **passed** on `feature/v5-events-giveaways-tempvoice-achievements` after the final V5 code changes.
- Deterministic tests cover strict offset parsing; event lifecycle, RSVP capacity and presentation retries; giveaway eligibility, draw/reroll/notification retry and disabled-guild scheduling; voice reservations, owner controls, marker recovery and deleted channels; achievement thresholds, duplicate suppression and disabled sources; centralized V5 command/button/event gating and nonoverlapping scheduler wakeups. Existing V0–V4 tests also pass.
- V0–V4 migration SQL remains unchanged. V5-only additive migrations are `drizzle/0006_shallow_excalibur.sql`, `drizzle/0007_easy_maestro.sql` and `drizzle/0008_blue_dreadnoughts.sql` (including durable event announcement retries).

## Real PostgreSQL checks

- `pnpm db:migrate`, `pnpm db:smoke` and dedicated `pnpm db:v5`: **passed**. The migration journal has at least nine entries (through 0008); V0–V5 constraints and rollback smoke passed.
- `db:v5` reported **26 successful assertions**, including synthetic-data removal. Two independent PostgreSQL pools checked simultaneous final-capacity event RSVPs, one reminder claim, cancellation/claim interaction, announcement claim/recovery, exactly one original giveaway draw, entry uniqueness, persisted reroll history, competing per-draw notification claims and retry, unique voice ownership/transfer/cleanup, unique achievement awards and public synthetic achievement rendering. An isolated synthetic guild toggled `events` off/on and verified the other three V5 modules remained enabled. No real guild configuration was changed by the database test.

## Bounded live Discord checks

- `pnpm commands:register` registered **24 guild-scoped development commands**; REST readback confirmed `/event`, `/giveaway`, `/tempvoice`, `/voice` and `/achievements`.
- A single bounded bot Gateway session in the configured development guild used private disposable channels: event post/edit/delete, giveaway post/end/result readback/delete, and temporary voice category/lobby/room create, rename, limit, lock/unlock, marker readback and delete. All checks passed and temporary channels were cleaned up. No staff notes, reports, unrelated members or production guild settings were touched. An initial attempt exposed Discord `10003` on an already-deleted voice channel; that gateway handling was corrected and the final live check passed.
- The live check exercised direct bot transport, **not** a human-triggered slash interaction or a live award. Award presentation and optional-module toggles were checked using synthetic PostgreSQL state and dispatcher tests instead.

## Limits and operational follow-up

- Actual human RSVP/button responses, giveaway entry/role changes, voice joins/transfers and live achievement progression require people and were **not** impersonated or claimed as tested. No multi-hour reminder or end-time wait was performed; due work was tested with synthetic clocks and database records.
- PostgreSQL commits and Discord sends are not atomic. A crash after a reminder or result send but before its receipt is persisted may leave an ambiguous duplicate. Giveaway result reconciliation searches the latest 100 bot messages by stable draw marker; a message that falls outside that window could be reposted. Event sends hold a row lock through delivery but cannot guarantee exactly-once external transport or prevent a slow request from crossing its nominal scheduled instant.
- Giveaway Discord membership/role eligibility is fetched immediately before its bounded draw transaction; Discord state can change before commit. Permission overwrites cannot make voice occupancy checks and deletion atomic; privileged/explicitly allowed users may enter during the final window. `/voice lock` blocks default joins, not individually permitted members or Administrators. A crashed room creation whose Discord outcome cannot be resolved from the marker remains logged as an unresolved reservation for staff inspection instead of silently deleting the DB record. Monitor reconciliation failures and review guild role/channel permissions.
- No voice-duration tracking, V6 analytics/dashboard, V7 AI or automation engine was implemented. This PR must remain **unmerged** until explicitly approved.
