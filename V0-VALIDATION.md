# V0 validation record

The checks below were performed in the development environment. No V1+ functionality was exercised.

## Completed

- `pnpm db:migrate`: succeeded against a local PostgreSQL 17 cluster.
- `pnpm db:smoke`: succeeded; read and rolled back records in all four V0 tables.
- `pnpm commands:register`: succeeded with guild scope. A subsequent Discord REST read-back returned exactly `config`, `module`, and `setup` for the configured development guild.
- Bot connected to the Discord gateway and emitted `Discord gateway ready`. A separate live lifecycle check confirmed `client.destroy()` and PostgreSQL pool closure after readiness.
- A real-PostgreSQL test driver called the production V0 command dispatcher with simulated guild interactions. It verified idempotent `/setup`, `/config` view/set and owner-only role mapping, role-based ADMIN authorization, fixture `/module enable` and `/module disable`, core protection, disabled command/event gating, unexpected-error correlation IDs, persisted configuration/module state across new service instances, and absence of credentials in captured internal error logs. The temporary guild and data were deleted after testing.
- The credential-redaction test, startup/shutdown race tests, and SQL migration consistency checks run in the regular automated suite.

The portable PostgreSQL 17 runtime and test scripts used for these checks live under ignored `.local/` and are **not** part of the shipped application. `compose.yaml` remains the documented development setup.

## Not independently verified

- A human did not invoke slash commands inside the Discord client. Discord REST registration was verified, but actual Discord-origin interaction delivery and visible ephemeral responses were not observed. Production dispatch was exercised with simulated interactions against real PostgreSQL instead.
- An OS-delivered Ctrl+C/SIGTERM handler was not verified end-to-end on Windows: a spawned child process terminated immediately when sent SIGINT. Graceful client/database cleanup was verified through the live lifecycle and automated shutdown-race tests.
- There are no optional production modules in V0; enable/disable behavior was exercised with a test-only fixture, not a public Discord module.
- The portable database is for validation only; Docker Compose startup itself could not be tested because Docker is not installed in this environment.
