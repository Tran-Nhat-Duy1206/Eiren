# V2 verification + anti-raid validation record

## Automated verified

- `pnpm typecheck`, `pnpm test` (**76 passing tests across 8 files**), `pnpm build` and `pnpm db:check` passed after the V2 integration fixes. Tests cover permission mappings, module dependencies and event/button dispatcher gating, verification join/approval/rejection/account-age/rules acknowledgement/role failures, duplicate button races, anti-raid burst and young-account scoring, emergency persistence, metadata-only spam/mention scoring, and V0/V1 regressions.
- Final PR review added regression coverage for emergency review arriving before/after a button click, concurrent join-handler ordering, duplicate joins after staff approval, revoking verified access on message suspicion, and rejecting anti-raid activation without a configured alert destination. These are automated checks, **not** new live Discord observations.
- Message Content intent is neither requested nor used. V2 records timestamps, mention counts and short signal names; no full message text or external-link text is stored.

## Real PostgreSQL verified

- The additive `drizzle/0002_complete_sasquatch.sql` migration applied to the configured PostgreSQL database; existing `0000`/`0001` files were not changed. `pnpm db:migrate` and `pnpm db:smoke` passed, including a rolled-back V0/V1/V2 insert and invalid verification status constraint check.
- An isolated real-PostgreSQL integration driver created a temporary guild, persisted verification configuration, pending and verified member states, anti-raid settings and SYSTEM emergency metadata. Fresh repository instances read all state; a later member join reset VERIFIED to PENDING while duplicate delivery left the new membership epoch unchanged. A duplicate anti-raid join inserted only once. Three concurrent joins serialized by per-guild PostgreSQL transaction advisory lock and activated emergency **once** at the configured threshold. Staff disable was not reversed by a fourth join in the same burst. A 31-day-old join was pruned while a current join remained. The driver removed its temporary guild and rows. This used synthetic Discord IDs and did **not** issue member-facing Discord actions.

## Live Discord verified

- Guild-scoped REST registration succeeded (`count: 6`); a separate Discord REST read-back returned `antiraid`, `config`, `mod`, `module`, `setup`, `verification` in the configured development guild. This proves command registration only, **not** a human invoking commands or receiving their responses.
- The **production V2 bot entry point** reached `Discord gateway ready` with `ENABLE_GUILD_MEMBERS_INTENT=true`, after probing V0/V1/V2 tables; no credential leak was detected in captured output. A separate real Discord gateway lifecycle connected with Guild Members Intent and closed the client and PostgreSQL pool. No 4014 disconnect occurred in these checks.
- In the configured real development guild, the bot created one private temporary text channel, posted and fetched a verification embed with the stable Verify button, sent and fetched a security-category embed through the existing `GuildLogService`, and deleted the temporary channel. These are real Discord API deliveries; they are **not** proof that a member clicked the button or that a real raid event triggered the alert.
- In the same guild, the bot created two zero-permission, non-mentionable temporary roles beneath its highest role. The production `DiscordVerificationGateway` checked role manageability, assigned the quarantine role to the **bot's own member**, granted the verified role and removed quarantine, confirmed the results from Discord, then deleted both roles. No community member was modified.

## Still unverified / operational limits

- No human invoked `/verification` or `/antiraid` in a Discord client, clicked a verification button, or observed its ephemeral response. Member join/leave, nickname/voice changes, staff approval/rejection and a real join-burst/anti-raid-triggered security alert were not observed; these require another account or human-triggered events and were not fabricated from bot REST calls.
- No destructive moderation of real community members is part of V2. No automatic permanent bans.
- Repeated external-link similarity cannot be scored without Message Content intent; V2 intentionally does not request that intent or retain message content.
- Channel permission overwrites granting restricted access must be configured by guild staff; assigning a quarantine role alone is insufficient if `@everyone` retains normal access.
- Discord role mutation and a PostgreSQL state transition are separate operations. In-process member actions are serialized and failures are logged for staff reconciliation, but an outage after a successful Discord role grant can leave a pending database row; a cross-process atomic commit with Discord is impossible. Anti-raid alert delivery depends on a configured, accessible security or explicit alert channel; a failed Discord delivery is logged internally but does not crash join handling. Message counters reset on process restart, whereas join history and emergency state persist.
