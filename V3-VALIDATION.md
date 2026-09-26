# V3 role menus, tickets, reports/appeals and suggestions — validation record

## Automated verified

- V3 modules are independently gated by the central command/button/select dispatchers. Core stays permanently enabled; no V3 module requires moderation, logging or another V3 module. The only existing dependency remains anti-raid → verification.
- `pnpm typecheck`, `pnpm test` (**115 passing tests across 15 files**), `pnpm build` and `pnpm db:check` passed after the final security review. The new tests include component gating, UTF-8-safe transcript chunking and all V0/V1/V2 regression tests.
- Tests target stable role controls, dangerous-permission rejection, idempotent actions and menu limits; private ticket access, claim/close/transcript failure and authorization paths; appeal/report cooldown and case ownership; atomic vote semantics, channel failures and suggestion review; module gating and all V0–V2 regressions. Service mocks do **not** prove Discord API delivery or PostgreSQL locking.
- V3 Drizzle migration: `drizzle/0003_needy_praxagora.sql`; older migration files were left untouched. The `db:smoke` driver adds V3 fixture writes, FK/unique/check constraint probes, and rolls back all data on success.

## Real PostgreSQL verified

- **Not yet verified in this session.** `pnpm db:migrate` failed because the configured PostgreSQL endpoint refused connections (`ECONNREFUSED`). A credential-free connection probe reproduced `ECONNREFUSED`; local port 5432 was closed and Docker CLI/PostgreSQL service were unavailable. `pnpm db:smoke` was attempted once and failed with the same connection error. Do not deploy V3 until the migration and smoke test succeed against a real configured PostgreSQL instance.

## Live Discord verified

- `pnpm commands:register` succeeded in the configured development guild with **12** slash commands. A separate REST read-back returned `antiraid`, `appeal`, `config`, `mod`, `module`, `report`, `role-menu`, `setup`, `suggest`, `suggestion`, `ticket`, `verification`. Registration does not prove any human invoked a command.
- A bounded **standalone Discord gateway transport check** connected successfully. It created a zero-permission, non-mentionable temporary staff role and a private temporary category, then used the V3 `DiscordTicketGateway` to create a private ticket text channel for the bot's own member. A real permissions readback showed `@everyone` lacked View Channel while the bot could view it. The bot fetched a ticket transcript containing the private opening header. A separate bot-only suggestions channel accepted a V3 embed post, update to `UNDER_REVIEW` and message deletion, confirmed by forced API reads (to bypass the Discord.js message cache). Ticket channel, suggestions channel, category and staff role were all deleted. These are transport checks, **not** database-backed ticket/suggestion workflows or real member interactions.
- The production bot entry point was attempted once but did not confirm readiness: the configured PostgreSQL endpoint was unavailable, and the bounded startup command was terminated after 30 seconds. No gateway readiness is claimed for that process.

## Still unverified / operational limits

- Staff/member slash-command executions, role-menu button/select clicks and resulting Discord role changes, ticket privacy overwrites and lifecycle, report/appeal human responses, suggestion voting, and enable/disable behavior in the actual Discord client are **not yet verified**. No human or second user account is being simulated.
- Ticket channels are dedicated private text channels; the bot fetches only the ticket channel at close, stores transcript text and attachment URLs in PostgreSQL, and makes archived transcripts downloadable through a staff-only ephemeral command. PostgreSQL backups retain this sensitive data until staff implement an explicit retention/delete policy; no global archive or automatic expiration exists.
- Report and appeal text, evidence URLs and staff review notes persist in PostgreSQL. Staff commands return ephemeral responses; only record IDs and statuses are emitted to moderation logs. Appeals never automatically reverse punishment. Suggestions are intentionally public in their configured channel; vote rows store user IDs and choices. No bot token/secret is stored.
- Discord writes cannot commit atomically with PostgreSQL. Pending suggestion posts, inaccessible role panels, orphaned ticket channels and failed post/cleanup requests need an operator to inspect the internal ID-only warnings and reconcile. No indefinitely waiting live event test was run.
