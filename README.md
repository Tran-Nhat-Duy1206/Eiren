# Eiren — Discord bot (V2 Verification + Anti-Raid)

A modular-monolith Discord bot. V0 provides guild configuration, permissions, module gating, and PostgreSQL; V1 adds persistent moderation and guild-facing logging. V2 adds optional verification and deterministic anti-raid protection. See [V0-VALIDATION.md](V0-VALIDATION.md), [V1-VALIDATION.md](V1-VALIDATION.md), and [V2-VALIDATION.md](V2-VALIDATION.md) for validation evidence.

## Requirements

Node.js 24+, pnpm 10+, Docker with Compose, and a Discord application/bot. Invite it with `bot` and `applications.commands` scopes. To activate `logging`, `verification`, or `antiraid`, **enable the privileged Server Members Intent** (`GuildMembers`) in the Discord Developer Portal, set `ENABLE_GUILD_MEMBERS_INTENT=true` in `.env`, and restart the bot. Without both, V0 and moderation still start; modules needing member events cannot be enabled rather than silently missing joins. The bot also requests Guilds, GuildMessages, GuildVoiceStates, and GuildModeration intents. Message Content intent is not requested; edits/deletes log IDs, not message text. Grant the bot View Channel, Send Messages, Embed Links in configured log/verification channels; Manage Roles and a highest bot role above both verification roles; and Moderate Members, Kick Members, Ban Members, Manage Messages, Read Message History as required for moderation. Place its highest role above intended targets; Discord role hierarchy still applies. Without the privileged intent enabled, the Discord gateway may reject login.

## Local start (from project root)

1. `pnpm install`
2. Copy `.env.example` to `.env`. Set your Discord token, application ID, private development guild ID, and a local database password. Use that same password in `POSTGRES_DEV_PASSWORD` (Docker Compose) and `DATABASE_URL` (URL-encode reserved characters). Do not commit `.env`.
3. `docker compose up -d postgres`
4. `pnpm db:migrate`
5. `pnpm db:smoke` verifies V0/V1/V2 tables, moderation and verification constraints, and rollback without retaining test data.
6. `pnpm commands:register` (guild-scoped registration takes effect quickly when `DISCORD_DEV_GUILD_ID` is set).
7. `pnpm dev` (or `pnpm build && pnpm start`). Stop with Ctrl+C for graceful cleanup.

Production command registration: omit `DISCORD_DEV_GUILD_ID`, run `pnpm commands:register`, then start the bot. Global command propagation can take time. **Do not switch a development guild to global registration without clearing its old guild-scoped commands**, or duplicate-looking commands may remain. Run migrations explicitly before deploying new code; the bot checks that its tables exist rather than applying migrations on startup. Keep the database URL and bot token secret.

## Commands and permissions

- `/setup`: guild owner only; transactional, idempotent creation of guild and settings; repeated calls preserve changes.
- `/config view`, `/config set`: mapped ADMIN or higher. `language` is `en` in V0; `timezone` accepts IANA names. For channel/role settings, pass a Discord ID or `clear`.
- `/config role-set`, `/config role-remove`, `/config roles`: guild owner only. Assign HELPER, MODERATOR, SENIOR_MODERATOR, or ADMIN to roles. GUILD_OWNER cannot be delegated.
- `/module enable`, `/module disable`, `/module list`: mapped ADMIN or higher; require setup. Core is permanently enabled. `moderation`, `logging`, `verification`, and `antiraid` are optional production modules, disabled by default. Enable `verification` before `antiraid` (the manifest enforces their dependency); disable `antiraid` before `verification`. Enable `logging` and set `security_log_channel` to receive security alerts. Disabled commands/events are blocked at dispatch.

The guild owner retains owner authority regardless of mappings. Discord Administrator alone is **not** an implicit bot ADMIN. Permission mapping changes are restricted to the actual guild owner. Responses are ephemeral. A disabled module is blocked by command/event dispatchers; its registered slash command can still appear in Discord.

## V1 moderation

Enable `moderation` after `/setup`. The guild owner maps staff roles with `/config role-set`; bot permissions are *not* inferred from Discord Administrator. `/mod warn`, `/mod timeout`, `/mod kick`, `/mod purge`, `/mod note`, `/mod history`, and `/mod case` require MODERATOR. `/mod ban`, `/mod tempban`, and `/mod unban` require SENIOR_MODERATOR. The actor's Discord role must outrank a member target (unless the actor owns the guild), and the bot needs its own action permission and a higher role. Neither owner nor self can be moderated. `/mod purge` accepts 1–100 recent messages in the current text channel; Discord excludes messages older than 14 days. `/mod timeout` and `/mod tempban` accept durations such as `30m`, `2h`, or `1d`; timeout is capped at 28 days and tempban at one year. Every action creates a case; use `/mod history @user` or `/mod case id` to inspect it. `/mod note @user text` creates a private note, while omitting text lists notes to authorized staff only.

Temporary punishment cases and expiry claims are stored in PostgreSQL. A scheduler scans due cases after startup and every 30 seconds, with stale-claim recovery. Discord expires timeouts automatically; the bot avoids cancelling a subsequent manual extension. Tempban refuses to replace an already-existing ban and expiry unbans only a ban whose audit reason still contains that case ID, avoiding an unrelated later ban. Discord has no atomic conditional-ban API, so an external ban created between the final preflight and Discord's ban request remains a narrow concurrency limitation. Expiration continues even if the moderation module is disabled after a case was created. Run `pnpm db:migrate` before deploying new V1 code: migration `drizzle/0001_aberrant_wild_child.sql` is additive; never edit the applied V0 migration.

## V1 guild logging

After enabling the portal intent and setting `ENABLE_GUILD_MEMBERS_INTENT=true`, enable `logging` and set destination IDs via `/config set log_channel`, `/config set mod_log_channel`, and `/config set security_log_channel`. General logs include joins/leaves, message edits/deletes (IDs only), channel changes, and voice join/leave/move. Member nickname/role updates and bot moderation actions route to the moderation channel. The security channel is reserved for security-category entries; no security-alert producer exists in V1. Categories never fall back to another channel. Missing or inaccessible channels are skipped with internal warnings. No message content, credentials, or private staff notes are included in guild logs.

## V2 verification

With Server Members Intent enabled, configure two **distinct, bot-manageable** roles: a restrictive quarantine role and a verified role. Configure server channel/role permission overwrites so quarantined members cannot reach normal channels; assigning a role alone **does not** restrict access. Run `/setup`, `/module enable verification`, `/verification verified-role`, `/verification quarantine-role`, `/verification channel`, then `/verification enable` and `/verification panel`. The bot must outrank both roles and have Manage Roles. Use `/verification mode` for `BUTTON`, `MANUAL`, or `BUTTON_AND_ACCOUNT_AGE`; set `/verification min-account-age` (e.g. `7d`) **before** selecting the age-gated mode, or switch to another mode before clearing the age requirement. `/verification rules-ack` configures acknowledgement before button verification. `/verification status` inspects settings; `/verification status target:<user>` inspects a member. MODERATOR or higher can use `/verification approve` and `/verification reject`; rejection leaves the member restricted and **never** bans automatically. Configuration/panel commands require internal ADMIN. A posted panel uses persistent button IDs and PostgreSQL member state; only the current configured panel is accepted. A young/unknown-age account remains pending for staff review when age gating is enabled. Staff can approve it explicitly.

## V2 anti-raid

First enable `verification` as a module and configure its quarantine role. Set `/config set security_log_channel` and enable `logging`, or set `/antiraid config field:alert_channel value:<channel-id>` to a dedicated channel; at least one configured destination is required before `/antiraid enable`. Then run `/module enable antiraid` and `/antiraid enable`. `/antiraid status` shows state; `/antiraid config` inspects/updates `join_window_seconds`, `join_threshold`, `young_account_age`, `young_account_weight`, message spam counts/window, `mention_threshold`, `auto_quarantine`, and `alert_channel`. ADMIN manages configuration. SENIOR_MODERATOR or higher uses `/antiraid emergency action:enable|disable` with an optional reason. Manual or automatic emergency mode persists until a staff member explicitly disables it; all new joins require manual verification review and are quarantined where configured. Join bursts, young-account weight, message-frequency and mass-mention metadata are deterministic signals. A single young account alone does not start emergency mode. Responses restrict/quarantine and alert staff for review, never automatically mass-ban or permanently ban. Message content is not requested, stored or scored; repeated links cannot be detected without Message Content intent. Join audit rows retain only IDs, timestamps, age and short signals and are pruned after 30 days (on subsequent joins and hourly maintenance). Message counters are process-local and reset on restart. Configure a dedicated alert channel or the existing security log channel and verify the bot can send embeds. If Discord roles, permissions, logging destinations or API calls fail, review the internal warnings and fix server configuration promptly.

## Development checks

`pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm db:check`. With PostgreSQL running, run `pnpm db:migrate` and `pnpm db:smoke`. `pnpm db:generate` creates a migration after schema changes; commit its SQL and Drizzle journal/snapshot. V0, V1 and additive V2 migrations are under `drizzle/`; never edit applied migrations.

## Layout

- `src/app`: startup, registration, migration entry points, dependency assembly, module registry
- `src/core`: environment, database, logger, errors, permission, command/event dispatch
- `src/modules/core`, `src/modules/moderation`, `src/modules/logging`, `src/modules/verification`, `src/modules/antiraid`: independent feature definitions and services
- `src/services`: reusable guild configuration and module behavior
- `src/repositories`: Drizzle-backed persistence
- `drizzle`: versioned SQL migration and migration metadata

## Current limitations

No V3+ features, dashboard, Redis, or multi-language responses. Message logs contain identifiers, not contents. Staff notes are stored in PostgreSQL and visible only to authorized moderation commands. There is no Discord-client user-account automation in this repository; human-operated live slash-command results must be verified separately. See the validation documents for environment-specific gaps.
