# V1 moderation + logging validation record

## Automated checks completed

- `pnpm typecheck`, `pnpm test` (34 passing), `pnpm build`, `pnpm db:check`, `pnpm db:migrate`, `pnpm db:smoke`: passed in the final run after the fix below.
- `pnpm db:migrate` applied only the additive `0001_aberrant_wild_child.sql` migration against local PostgreSQL 17; the V0 migration was not changed.
- `pnpm db:smoke` inserted and read V0/V1 records, checked rejection of an invalid moderation status, and rolled back its transaction.
- Unit tests cover command authorization, role hierarchy and bot capabilities, case creation, staff-note visibility, test-fixture module gating, expiration idempotency, log channel routing, message edit/delete identifier-only logging, safe error responses, and (added during this validation) the ephemeral `MessageFlags` payload used by the dispatcher.

## Live Discord checks completed

All of the following were observed against the real development guild with the real bot process and privileged Server Members Intent enabled (`ENABLE_GUILD_MEMBERS_INTENT=true`). The owner's logged-in client invoked real slash commands.

- Gateway readiness: the production entry point logged `Discord gateway ready` on every start with the intent enabled; no gateway disconnect 4014/`disallowed intents` was observed. A lifecycle harness confirmed `client.destroy()` and PostgreSQL pool closure.
- Command registration: guild-scoped registration returned exactly `config`, `mod`, `module`, `setup` via Discord REST read-back.
- Real Discord-origin interactions (owner account), each with the visible ephemeral response:
  - `/setup` -> `Setup complete. Language: en; timezone: UTC.`; the guild row and settings row were persisted.
  - `/config set` for `log_channel`, `mod_log_channel`, `security_log_channel` -> `Updated ...`; `/config view` listed the stored channel IDs.
  - `/module enable moderation`, `/module enable logging` -> `... enabled.`; `/module list` -> `moderation: enabled`, `logging: enabled`. `/module disable`/`/module enable` were exercised live for both modules.
  - `/mod purge` -> `Case #15: PURGE COMPLETED; deleted 3 messages.` and `Case #16: PURGE COMPLETED; deleted 2 messages.`; the marked messages were really gone (`GET` returned `Unknown Message`).
  - `/mod note @Eiren` with text -> `Private staff note #7 saved.`; omitting text listed `#7 (…): note serialization probe`.
  - `/mod history @Eiren` -> `No cases for that user.`
  - `/mod case id:15`, `id:16`, `id:17` -> correct case detail lines (including `TIMEOUT (EXPIRED)`).
  - `/mod warn|timeout|kick|ban|tempban @Eiren` -> `The guild owner or bot cannot be moderated.` for all five subcommands.
  - `/mod warn @Castor` -> `You cannot moderate yourself or the server owner.`
  - `/mod unban <unknown-id>` -> safe `Something went wrong. Error ID: <uuid>` response; the real `DiscordAPIError` was contained and no case row was created because the preflight rejected it.
  - `/config role-set eiren-val-target MODERATOR` then `ADMIN` -> mapped; `/config roles` showed the mapping; `/config role-remove` removed it.
- Live guild logging (real gateway events, delivered to the configured channels):
  - `Channel created`, `Channel updated`, `Channel deleted` in the general log channel with correct IDs/names.
  - `Message edited`, `Message deleted` in the general log channel with channel/message/author IDs only; the unique message text never appeared in any embed.
  - `Member updated` in the moderation log channel for nickname set/clear and role IDs added/removed on the bot.
  - `Voice joined`, `Voice moved`, `Voice left` in the general log channel, triggered by real gateway voice-state updates for the bot (and, as observed, for the owner's client); both ended disconnected.
  - Moderation case embeds `Case #15: PURGE`, `Case #16: PURGE`, `Case #19: WARN` in the moderation log channel.
  - The security log channel stayed empty throughout: no security producer exists and there was no cross-category fallback.
  - Logging failure resilience: with `log_channel` pointed at a nonexistent ID a real channel-update event was dropped with a warning (`Unable to deliver guild log`), the bot stayed up, nothing leaked into other channels, and delivery resumed after the channel ID was restored.
  - Duplicate check: one rename and one message edit each produced exactly one embed; no duplicate records were observed.
- Real Discord API side effects: `purge` bulk deletion, unban failure handling, bot nickname updates, and temporary-role create/add/remove/delete on the bot were real. Real `kick`, `timeout`, `ban` (and `tempban`) success paths were **not** performed because the guild has no disposable member: Discord rejects bans for non-existent user IDs (`Unknown User`, code 10013), and the only members are the real owner and the bot, both protected by design.
- Restart / temporary punishment recovery: an `ACTIVE` TIMEOUT case due in 120 s and a leftover `PENDING` TIMEOUT case (already due) were inserted into real PostgreSQL; the bot was restarted before expiry. After restart the real scheduler claimed and expired both exactly once (statuses `EXPIRED`, no repeated transitions over 3 idle watch cycles), and a follow-up `expireDue` call returned 0. These cases target the bot and have no Discord-side punishment to clear, so Discord-side timeout clearing/unban was not exercised.
- Post-restart live checks: `/module list`, `/mod note` listing, and `/mod case 15`/`17` still returned the persisted state after further restarts; a real channel update was logged after restart.
- Fix applied and live-verified during this validation: interaction replies used the deprecated `ephemeral` option and emitted a startup/command warning; they now use `MessageFlags.Ephemeral`. After the fix a real command produced zero bytes on stderr and the regression assertion was added to the test suite.

## Real PostgreSQL verified

- `guilds` (1 row), `guild_settings` (1 row with all three log channel IDs), `guild_modules` (`moderation` and `logging` enabled, `updated_by` = the owner ID), `moderation_cases` (#15 PURGE COMPLETED `deletedCount: 3`, #16 PURGE COMPLETED `deletedCount: 2`, #17/#18 TIMEOUT EXPIRED with `expires_at`, #19 WARN COMPLETED), `moderator_notes` (#7 for the bot target).
- Case statuses, durations, expiry timestamps, `claimed_at` clearing after processing, and metadata were inspected directly with SQL.
- Module state, cases, and notes survived five separate bot process starts; pending work was recovered by the scheduler after restart.

## Not live-verified (validation stopped or no safe target)

- Successful live `kick`, `timeout`, `tempban` and `ban` on a member were not performed: there is no dedicated disposable test account in the guild, and Discord rejects bans of non-existent user IDs. Their positive paths remain covered by automated tests and by the live denial/hierarchy checks above.
- A live member join/leave event was not observed: the guild has no second member and no test account was available to invite or join.
- Discord-side clearing of a real timeout or unbaning a real temporary ban on expiry was not exercised; scheduler claim/expiry/restart recovery was verified with synthetic cases targeting the bot.
- Mapped-level behavior (`MODERATOR`, `ADMIN`) and ordinary-member denial were verified with the production permission service against real PostgreSQL role mappings, but not through a Discord interaction from a real non-owner staff member (no such account exists). Role-hierarchy comparison between two real member roles likewise could not be exercised live.
- All remaining live validation (further interaction loops, expiration waits, restarts) was intentionally stopped on instruction; no V2 work was started.

Validation artifacts intentionally left in the development guild: the three configured `Eiren Logs` channels plus `eiren-val-commands` test channel, the enabled `moderation`/`logging` module state, and cases #15-#19 with note #7 as evidence. The temporary validation role was deleted after the mapping tests.
