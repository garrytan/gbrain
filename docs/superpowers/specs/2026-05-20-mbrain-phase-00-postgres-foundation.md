# Phase 00: Postgres Foundation

Date: 2026-05-20
Status: Detailed phase spec
Depends on: none

## Goal

Rebase MBrain's target architecture on local Postgres. This phase removes
SQLite/PGLite parity from the new design target and creates a reliable local
Postgres foundation for every later runtime, source, assertion, and projection
feature.

## Design Decisions

- Target backend is Postgres-only.
- Local Postgres is the default install path.
- SQLite/PGLite are legacy or migration surfaces only.
- Postgres provisioning is hybrid:
  - user-provided DSN is always supported
  - macOS Homebrew profile is supported when available
  - Linux system package or container profile is supported when available
  - core engine is independent of provisioning profile
- pgvector and text search are first-class.
- New runtime features may rely on Postgres features without SQLite fallback.

## In Scope

- Postgres engine as default engine.
- Config key for target Postgres DSN.
- Local setup profile abstraction.
- Postgres readiness checks.
- Schema migration baseline for target runtime.
- pgvector readiness and extension checks.
- tsvector/FTS readiness checks.
- Backup and restore command design.
- Doctor checks for Postgres health.
- Test harness that uses Postgres.
- Documentation update that explains Postgres-only target.

## Out Of Scope

- Source registry.
- Runtime job queue.
- Autopilot daemon.
- Assertion extraction.
- Canonical write policy.
- Personal data connectors.
- Full SQLite data migration automation, except a documented manual path.

## Required Schema Foundations

This phase does not need to create every later table, but it must create the
schema migration surface that later phases extend.

Minimum foundational tables:

- `schema_migrations`
- `config`
- `operation_log`
- `engine_capabilities`
- `doctor_events`

Minimum required extensions:

- `pgcrypto`, if UUID/hash helpers require it
- `vector`, for embeddings

Expected indexes:

- config key unique index
- operation log timestamp index
- migration version unique index

## CLI / Setup Surface

Commands should be designed around:

```text
mbrain init
mbrain init --dsn <postgres-url>
mbrain init --profile homebrew-postgres
mbrain init --profile linux-system-postgres
mbrain init --profile container-postgres
mbrain doctor
mbrain db status
mbrain db migrate
mbrain db backup
mbrain db restore
```

Exact command names can follow existing CLI style, but the capability must
exist.

## Doctor Checks

Doctor must verify:

- Postgres reachable
- DB name/user/host match active config
- schema version current
- pgvector extension installed
- embedding dimensions configured
- tsvector indexes available
- migration lock not stuck
- autopilot, MCP server, and CLI point at the same DB
- backup path writable
- local credential storage available for later connector phases

## Migration Policy

Existing SQLite data can be moved manually or by a one-shot migration. The
target spec does not require ongoing semantic parity.

Migration documentation must explain:

- how to export current Markdown brain
- how to initialize Postgres
- how to sync/import Markdown into Postgres
- what legacy DB-only state may be lost or needs manual review
- how to verify counts and hashes after migration

## Safety

- Never silently initialize a remote database unless the user explicitly passes
  that DSN.
- Refuse destructive schema reset without explicit confirmation.
- Store credentials only through approved credential handling.
- Do not log full DSNs with passwords.
- Use connection pool settings appropriate for local daemon + MCP + CLI.

## Tests

Required tests:

- fresh init creates schema
- migrations are idempotent
- missing pgvector reports actionable doctor failure
- config hides DSN secrets in logs
- backup command creates a restorable artifact or dry-run manifest
- CLI/MCP/daemon config resolution points to same DB
- SQLite target features are not required for new runtime tests

## Acceptance Criteria

- A new MBrain environment initializes against local Postgres.
- `mbrain doctor` reports a healthy Postgres target.
- Existing docs no longer describe SQLite as the target default.
- Tests can run against Postgres without SQLite parity requirements.
- Later phases can add source, assertion, job, and projection tables through the
  migration surface.
