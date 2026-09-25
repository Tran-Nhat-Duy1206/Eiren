# Eiren — Discord bot (V1 Moderation + Logging)

A modular-monolith Discord bot. V0 provides guild configuration, permissions, module gating, and the PostgreSQL foundation. V1 adds persistent moderation cases, private staff notes, restart-safe temporary punishment expiration, and optional guild-facing logging. See [V0-VALIDATION.md](V0-VALIDATION.md) and [V1-VALIDATION.md](V1-VALIDATION.md) for exact validation evidence.

## Requirements

Node.js 24+, pnpm 10+, Docker with Compose, and a Discord application/bot. Invite it with `bot` and `applications.commands` scopes. To activate the optional `logging` module, **enable the privileged Server Members Intent** (`GuildMembers`) in the Discord Developer Portal, set `ENABLE_GUILD_MEMBERS_INTENT=true` in `.env`, and restart the bot. Without both, V0 and moderation still start, but `/module enable logging` is rejected rather than silently missing member join/leave or role/nickname events. The bot also requests Guilds, GuildMessages, GuildVoiceStates, and GuildModeration intents. Message Content intent is not requested; edits/deletes log IDs, not message text. Grant the bot View Channel, Send Messages, Embed Links in configured log channels and Moderate Members, Kick Members, Ban Members, Manage Messages, Read Message History as required for actions. Place its highest role above intended targets; Discord role hierarchy still applies. Without the privileged intent enabled, the Discord gateway may reject login.

## Local start (from project root)

1. `pnpm install`
2. Copy `.env.example` to `.env`. Set your Discord token, application ID, private development guild ID, and a local database password. Use that same password in `POSTGRES_DEV_PASSWORD` (Docker Compose) and `DATABASE_URL` (URL-encode reserved characters). Do not commit `.env`.
3. `docker compose up -d postgres`
4. `pnpm db:migrate`
5. `pnpm db:smoke` verifies V0/V1 tables, a moderation status constraint, and rollback without retaining test data.
6. `pnpm commands:register` (guild-scoped registration takes effect quickly when `DISCORD_DEV_GUILD_ID` is set).
7. `pnpm dev` (or `pnpm build && pnpm start`). Stop with Ctrl+C for graceful cleanup.

Production command registration: omit `DISCORD_DEV_GUILD_ID`, run `pnpm commands:register`, then start the bot. Global command propagation can take time. **Do not switch a development guild to global registration without clearing its old guild-scoped commands**, or duplicate-looking commands may remain. Run migrations explicitly before deploying new code; the bot checks that its tables exist rather than applying migrations on startup. Keep the database URL and bot token secret.

## Commands and permissions

- `/setup`: guild owner only; transactional, idempotent creation of guild and settings; repeated calls preserve changes.
- `/config view`, `/config set`: mapped ADMIN or higher. `language` is `en` in V0; `timezone` accepts IANA names. For channel/role settings, pass a Discord ID or `clear`.
- `/config role-set`, `/config role-remove`, `/config roles`: guild owner only. Assign HELPER, MODERATOR, SENIOR_MODERATOR, or ADMIN to roles. GUILD_OWNER cannot be delegated.
- `/module enable`, `/module disable`, `/module list`: mapped ADMIN or higher; require setup. Core is permanently enabled. `moderation` and `logging` are optional production modules, disabled by default. Run `/module enable moderation` and `/module enable logging` after setup; disable either independently. Disabled commands/events are blocked at dispatch.

The guild owner retains owner authority regardless of mappings. Discord Administrator alone is **not** an implicit bot ADMIN. Permission mapping changes are restricted to the actual guild owner. Responses are ephemeral. A disabled module is blocked by command/event dispatchers; its registered slash command can still appear in Discord.

## V1 moderation

Enable `moderation` after `/setup`. The guild owner maps staff roles with `/config role-set`; bot permissions are *not* inferred from Discord Administrator. `/mod warn`, `/mod timeout`, `/mod kick`, `/mod purge`, `/mod note`, `/mod history`, and `/mod case` require MODERATOR. `/mod ban`, `/mod tempban`, and `/mod unban` require SENIOR_MODERATOR. The actor's Discord role must outrank a member target (unless the actor owns the guild), and the bot needs its own action permission and a higher role. Neither owner nor self can be moderated. `/mod purge` accepts 1–100 recent messages in the current text channel; Discord excludes messages older than 14 days. `/mod timeout` and `/mod tempban` accept durations such as `30m`, `2h`, or `1d`; timeout is capped at 28 days and tempban at one year. Every action creates a case; use `/mod history @user` or `/mod case id` to inspect it. `/mod note @user text` creates a private note, while omitting text lists notes to authorized staff only.

Temporary punishment cases and expiry claims are stored in PostgreSQL. A scheduler scans due cases after startup and every 30 seconds, with stale-claim recovery. Discord expires timeouts automatically; the bot avoids cancelling a subsequent manual extension. Tempban refuses to replace an already-existing ban and expiry unbans only a ban whose audit reason still contains that case ID, avoiding an unrelated later ban. Discord has no atomic conditional-ban API, so an external ban created between the final preflight and Discord's ban request remains a narrow concurrency limitation. Expiration continues even if the moderation module is disabled after a case was created. Run `pnpm db:migrate` before deploying new V1 code: migration `drizzle/0001_aberrant_wild_child.sql` is additive; never edit the applied V0 migration.

## V1 guild logging

After enabling the portal intent and setting `ENABLE_GUILD_MEMBERS_INTENT=true`, enable `logging` and set destination IDs via `/config set log_channel`, `/config set mod_log_channel`, and `/config set security_log_channel`. General logs include joins/leaves, message edits/deletes (IDs only), channel changes, and voice join/leave/move. Member nickname/role updates and bot moderation actions route to the moderation channel. The security channel is reserved for security-category entries; no security-alert producer exists in V1. Categories never fall back to another channel. Missing or inaccessible channels are skipped with internal warnings. No message content, credentials, or private staff notes are included in guild logs.

## Development checks

`pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm db:check`. With PostgreSQL running, run `pnpm db:migrate` and `pnpm db:smoke`. `pnpm db:generate` creates a migration after schema changes; commit its SQL and Drizzle journal/snapshot. V0 and additive V1 migrations are under `drizzle/`.

## Layout

- `src/app`: startup, registration, migration entry points, dependency assembly, module registry
- `src/core`: environment, database, logger, errors, permission, command/event dispatch
- `src/modules/core`, `src/modules/moderation`, `src/modules/logging`: independent feature definitions and services
- `src/services`: reusable guild configuration and module behavior
- `src/repositories`: Drizzle-backed persistence
- `drizzle`: versioned SQL migration and migration metadata

## Current limitations

No V2+ features, dashboard, Redis, or multi-language responses. Message logs contain identifiers, not contents. Staff notes are stored in PostgreSQL and visible only to authorized moderation commands. There is no Discord-client user-account automation in this repository; human-operated live slash-command results must be verified separately. See the validation documents for environment-specific gaps.
