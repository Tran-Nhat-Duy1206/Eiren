# V1 moderation + logging validation record

## Completed in this environment

- `pnpm typecheck`, `pnpm test` (34 passing), `pnpm build`, `pnpm db:check`: passed in the final pre-commit run.
- `pnpm db:migrate`: applied the additive `0001_aberrant_wild_child.sql` migration against local PostgreSQL 17; the existing V0 migration was not changed.
- `pnpm db:smoke`: inserted and read V0/V1 records, checked rejection of an invalid moderation status, and rolled back the test transaction.
- A real-PostgreSQL integration driver exercised warning and temporary-ban case creation through the production service with a simulated Discord gateway, persisted private notes, fresh service-instance reload, staff authorization denial, due-case expiration, idempotent subsequent scan, exclusion of an in-flight case from expiration claims, and recovery of a PENDING temporary case left behind by a previous process. It removed its temporary guild afterward. This does **not** represent actual Discord bans or timeouts.
- Development-guild slash commands were registered via Discord REST; read-back returned `config`, `mod`, `module`, and `setup`.
- With the privileged Server Members Intent **not requested** (the `.env` flag defaults to false), the production bot entry point emitted `Discord gateway ready` with no detected credential leakage. A separate live lifecycle check closed the client and PostgreSQL pool.
- Unit tests cover command authorization, role hierarchy and bot capabilities, case creation, staff-note visibility, test-fixture module gating, expiration idempotency, log channel routing, message edit/delete identifier-only logging, and safe error responses.

The local PostgreSQL runtime used here is under ignored `.local/` and is not distributed with the project. Docker Compose itself could not be tested because Docker is not installed in this environment.

## Not verified live / environmental limitation

- The Discord application currently rejects a login requesting the privileged Server Members Intent with gateway disconnect **4014, `Used disallowed intents`**. Enable that intent in the Discord Developer Portal, set `ENABLE_GUILD_MEMBERS_INTENT=true` in `.env`, restart, then enable `logging` per guild. Until then, enabling logging is rejected; member joins/leaves and nickname/role logs cannot be verified live.
- No human invoked V1 slash commands inside the Discord client, and no safe disposable target account was supplied for real warn/timeout/kick/ban/tempban/unban/purge tests. Slash registration and service logic were verified, not actual moderation API side effects or visible ephemeral responses.
- Log delivery into configured Discord channels, including channel permissions and actual member/message/voice events, was not observed in a development guild. Routing and privacy were verified with tests.
- OS-delivered Ctrl+C/SIGTERM handling was not verified end-to-end on Windows; live lifecycle shutdown and automated startup/shutdown-race tests passed.
