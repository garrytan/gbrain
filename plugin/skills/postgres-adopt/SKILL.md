---
name: postgres-adopt
description: |
  Detect which gbrain engine is in use (PGLite vs Postgres), prefer Postgres
  for agent-harness installs, install/provision Postgres (Supabase discovery
  via SUPABASE_ACCESS_TOKEN, local Postgres, opt-in Docker), and move an
  existing PGLite brain with the guarded engine migration. Detection is one
  engine-free command; the install ladder is one flag.
triggers:
  - "which gbrain engine"
  - "pglite or postgres"
  - "gbrain engine status"
  - "upgrade to postgres"
  - "switch gbrain to postgres"
  - "install postgres for gbrain"
  - "move my brain to supabase"
  - "set up postgres for the brain"
tools:
  - exec
mutating: true
brain_first: exempt
---

# Postgres Adopt

> The engine is the brain's foundation: PGLite is the zero-config floor,
> Postgres is where concurrency, multi-machine access, and 1000+ pages live.
> This skill answers "which one am I on?", prefers Postgres when the
> operator wants it, and moves data safely — never by flipping config.

## Contract

This skill guarantees:
- Detection is engine-free and read-only: `gbrain engine status --json`
  answers with the database down (that is the point of the command).
- Engine changes NEVER happen by editing config. Moving data uses
  `gbrain migrate --to <supabase|pglite>` — which brings its own guardrails
  (quiesce mutex, resume manifest, non-empty-target guard, and a config flip
  only on a fully clean run). This skill wraps it; it never reimplements it.
- Provisioning consent is explicit: the docker rung needs `--allow-docker`,
  creating a database on a local server needs `--allow-create-db`. Headless
  mutation of infrastructure the operator didn't opt into never happens.

## Step 1 — Detect

```bash
gbrain engine status --json
```

Branch on the output:
- `effective_engine: "postgres"` and (optionally) `--probe` says ok →
  report healthy, done.
- `effective_engine: "postgres"` but the probe fails → this is an ACCESS
  problem, not an adoption problem: route to [db-repair](../db-repair/SKILL.md).
- `config_file_engine` differs from `effective_engine` → an env URL is
  overriding the config file; tell the operator which one wins — the signal
  is `db_url_source` (`env:GBRAIN_DATABASE_URL` / `env:DATABASE_URL` means
  env wins; `env.note` additionally fires when both env URLs are set or the
  cwd-.env shadow guard excluded one).
- `thin_client: true` → the brain lives on a remote server; engine choices
  belong to that host. Stop.
- `effective_engine: null` (no brain) → Step 2.
- `effective_engine: "pglite"` with data → Step 3.

## Step 2 — Fresh install, Postgres-first

```bash
gbrain init --prefer-postgres
```

The ladder tries, in order: an env URL → Supabase Management-API discovery
(`SUPABASE_ACCESS_TOKEN`, plus `SUPABASE_PROJECT_REF` on multi-project
accounts and `SUPABASE_DB_PASSWORD` for the connection string) → a local
Postgres (only when `PGHOST`/`PGPORT`/`PGUSER`/`PGPASSWORD` are set or
`--local-postgres` is passed) → docker → PGLite. Each unusable rung prints a
one-line note and falls through; nothing is silent.

- Ask the operator BEFORE adding `--allow-docker` (it creates and owns a
  `gbrain-postgres` container that survives reboots) or `--allow-create-db`
  (it runs CREATE DATABASE on their local server).
- `--json` reports `{engine, ladder_rung, url_source}` — relay which rung won.
- If the ladder lands on PGLite, that is a fine outcome: say so, and note the
  upgrade path below is available whenever they want it.

## Step 3 — Existing PGLite brain: migrate, don't flip

Confirm with the operator first (this copies every page/fact into the target
and, only on a fully clean run, flips the config). Then:

```bash
gbrain migrate --to supabase --url <postgres-connection-string>
```

- A partial run leaves you on PGLite and exits non-zero; re-running the same
  command resumes from its manifest. Never "fix" a partial by editing config.
- After a clean run: `gbrain doctor` on the new engine; the old
  `brain.pglite/` dir is preserved (doctor's `pglite_leftovers` tracks it).
- `gbrain doctor`'s `pglite_scale` check warns at 1000+ pages — that warning
  is this skill's cue.

## The tradeoff (say it when recommending)

Postgres wins on concurrency, multi-machine access, and scale. PGLite keeps
the per-turn bootstrap hook lane (hook injection is PGLite-only today —
`docs/guides/bootstrap.md`); on Postgres, ambient context rides
MCP-every-session and the pull protocol instead. Recommend Postgres when the
operator has concurrent agents, multiple machines, or a 1000+ page brain;
otherwise PGLite is genuinely fine.

## Anti-Patterns

- NEVER `gbrain config set engine ...` — it is refused by design; an engine
  flip without a data migration splits the brain across two stores.
- NEVER pick Postgres over a healthy PGLite brain without the migrate path.
- NEVER run the docker rung without the operator's explicit yes.
- NEVER paste or echo `SUPABASE_ACCESS_TOKEN` / passwords into output.

## Output Format

Detection reports in one line; changes report in 2-4:

```
Engine: <pglite|postgres> (source: <db_url_source>)   [probe: ok, 42ms]
Action: <none | init rung that won | migrate --to supabase result>
Next:   <upgrade note, or "healthy — nothing to do">
```

Quote `gbrain engine status` output as-is (it is already redacted); name the
winning ladder rung when an install ran; after a migration, include the
target's `gbrain doctor` verdict.
