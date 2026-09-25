# Eiren — Discord bot (V0 Core)

A modular-monolith Discord bot. V0 includes persistent guild configuration, centralized permissions, module gating, slash commands/events, structured logging, and PostgreSQL. No V1+ features are installed. See [V0-VALIDATION.md](V0-VALIDATION.md) for completed live checks and remaining gaps.

## Requirements

Node.js 24+, pnpm 10+, Docker with Compose, and a Discord application/bot. Invite the bot with the `bot` and `applications.commands` scopes; it needs to be present in the guild. Only the `Guilds` gateway intent is used; privileged member intent is **not** required. The bot fetches the invoking member for authorization.

## Local start (from project root)

1. `pnpm install`
2. Copy `.env.example` to `.env`. Set your Discord token, application ID, private development guild ID, and a local database password. Use that same password in `POSTGRES_DEV_PASSWORD` (Docker Compose) and `DATABASE_URL` (URL-encode reserved characters). Do not commit `.env`.
3. `docker compose up -d postgres`
4. `pnpm db:migrate`
5. `pnpm db:smoke` verifies all V0 tables and a rollback against real PostgreSQL without retaining test data.
6. `pnpm commands:register` (guild-scoped registration takes effect quickly when `DISCORD_DEV_GUILD_ID` is set).
7. `pnpm dev` (or `pnpm build && pnpm start`). Stop with Ctrl+C for graceful cleanup.

Production command registration: omit `DISCORD_DEV_GUILD_ID`, run `pnpm commands:register`, then start the bot. Global command propagation can take time. **Do not switch a development guild to global registration without clearing its old guild-scoped commands**, or duplicate-looking commands may remain. Run migrations explicitly before deploying new code; the bot checks that its tables exist rather than applying migrations on startup. Keep the database URL and bot token secret.

## Commands and permissions

- `/setup`: guild owner only; transactional, idempotent creation of guild and settings; repeated calls preserve changes.
- `/config view`, `/config set`: mapped ADMIN or higher. `language` is `en` in V0; `timezone` accepts IANA names. For channel/role settings, pass a Discord ID or `clear`.
- `/config role-set`, `/config role-remove`, `/config roles`: guild owner only. Assign HELPER, MODERATOR, SENIOR_MODERATOR, or ADMIN to roles. GUILD_OWNER cannot be delegated.
- `/module enable`, `/module disable`, `/module list`: mapped ADMIN or higher; require setup. Core is permanently enabled. There are no optional **production** modules in V0, so list is empty and enable/disable reject unknown modules; test fixtures verify behavior without shipping an unrelated feature.

The guild owner retains owner authority regardless of mappings. Discord Administrator alone is **not** an implicit bot ADMIN. Permission mapping changes are restricted to the actual guild owner. Responses are ephemeral. A disabled module is blocked by the command and event dispatchers; already registered slash commands can still appear in the Discord UI.

## Development checks

`pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm db:check`. With a configured, migrated PostgreSQL database, also run `pnpm db:smoke`. `pnpm db:generate` creates a migration after schema changes; commit both the SQL and Drizzle journal/snapshot. The initial migration is under `drizzle/`.

## Layout

- `src/app`: startup, registration, migration entry points, dependency assembly, module registry
- `src/core`: environment, database, logger, errors, permission, command/event dispatch
- `src/modules/core`: V0 command/event definitions
- `src/services`: reusable guild configuration and module behavior
- `src/repositories`: Drizzle-backed persistence
- `drizzle`: versioned SQL migration and migration metadata

## V0 limitations

No optional production feature modules exist yet; V0 toggling is exercised using a test-only module fixture. No multi-language response translations, dashboard, Redis, or V1+ feature tables. Logs go to structured stdout rather than a guild-facing activity log. For an end-to-end Discord/database smoke test, credentials and a running PostgreSQL instance are required.
