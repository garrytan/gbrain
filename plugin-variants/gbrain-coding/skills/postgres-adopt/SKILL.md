---
name: postgres-adopt
description: |
  Detect which gbrain engine is in use (PGLite vs Postgres), prefer Postgres
  for agent-harness installs, install/provision Postgres (Supabase discovery
  via SUPABASE_ACCESS_TOKEN, local Postgres, opt-in Docker), and move an
  existing PGLite brain to Postgres with its history (plan, ask, run).
  Detection is one engine-free command; the install ladder is one flag.
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
- Engine changes NEVER happen by editing config. A PGLite brain moves with
  `gbrain migrate --to postgres` (alias `--to supabase`), which graduates it:
  plan first (exit 3), run only with the user's `--yes --expect <plan_hash>`,
  verify every table, then flip routing. This skill wraps it; it never
  reimplements it.
- The target URL never appears in a command, transcript or output: it lives
  in `GBRAIN_TARGET_URL` and every command uses `--url-env GBRAIN_TARGET_URL`.
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
- The output has a `graduation` block whose `state` is not `none` (in progress,
  interrupted, graduated or split) → Step 4.

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

## Step 3 — Existing PGLite brain: plan, ask, run

Full reference: [Move a PGLite brain to Postgres](../../docs/guides/move-to-postgres.md).

1. **Target URL.** Ask the user to put the connection string in an
   environment variable without pasting it into the conversation
   (`read -rs GBRAIN_TARGET_URL && export GBRAIN_TARGET_URL`). On Supabase use
   the transaction pooler; on an IPv4-only host also set
   `GBRAIN_DIRECT_DATABASE_URL` to the session pooler.
2. **Plan.** This changes nothing and exits 3 with the
   `confirmation_required` document:
   ```bash
   gbrain migrate --to postgres --url-env GBRAIN_TARGET_URL --json
   ```
   Relay `user_message`, what moves, what stays on this computer, blockers
   and the estimate. Stop and wait for the user. A blocker with its own
   `fix` gets cleared first (ask when it says `ask_user`).
3. **Run, after the user agrees.** Use `fix.command` from the document:
   ```bash
   gbrain migrate --to postgres --url-env GBRAIN_TARGET_URL --yes --expect <plan_hash>
   ```
   `preview_changed` means the plan changed: go back to step 2. For thousands
   of pages run it in the background and poll `gbrain migrate --status --json`.
4. **Report.** Relay the target doctor verdict from the run's output, that
   existing tokens, OAuth clients and local writers stay valid, the
   `gbrain mcp expose` follow-up for other machines, and, if a serve handed
   the brain over, that the user restarts the MCP client.

- A `gbrain serve` holding the brain hands it over on its own; never ask the
  user to stop it first. `graduation_source_writer_held` names the process to
  stop when one does not.
- The old data dir is kept as `<path>.graduated-<run_id>` (doctor's
  `pglite_leftovers` reports it). Deleting it is the user's call:
  `gbrain migrate --discard-source --json` returns the plan and the question
  (exit 3); run its `fix.command` only after the user agrees. Afterwards a
  rollback to PGLite is no longer possible.
- `gbrain doctor`'s `pglite_scale` check warns at 1000+ pages and points at
  the plan command — that warning is this skill's cue.

## Step 4 — A move already underway

```bash
gbrain migrate --status --json
```

It is read-only and names the next command for the state. Exit 75 or a
run in progress → wait and poll. Interrupted → `gbrain migrate --resume`
(or `gbrain migrate --rollback-to-source` if the user wants to stay on
PGLite). Every refusal names its fix; the recovery table is in the guide.
A rollback that lists data loss runs only with the user's
`--rollback-to-source --yes --expect <hash>`.

## The tradeoff (say it when recommending)

Postgres wins on concurrency, multi-machine access, and scale. PGLite keeps
the per-turn bootstrap hook lane (hook injection is PGLite-only today —
`docs/guides/bootstrap.md`); on Postgres, ambient context rides
MCP-every-session and the pull protocol instead. Recommend Postgres when the
operator has concurrent agents, multiple machines, or a 1000+ page brain;
otherwise PGLite is genuinely fine.

## When it fails

Follow the [agent operator protocol](../../docs/protocol/AGENT_OPERATOR_v1.md) for any gbrain error `code`, exit code, `[AGENT]` block or notice block. Specific to this skill:

- `effective_engine: "postgres"` but the probe fails: this is an access problem; run `gbrain engine status --probe`, then the db-repair skill.
- Provisioning steps (Docker, installing Postgres) and the move itself need the user's explicit agreement; the docker rung needs `--allow-docker`, the move needs `--yes --expect <plan_hash>` after the user saw the plan.
- `gbrain config set engine …` is refused by design: switch engines through the migrate path, never by editing config.

## Anti-Patterns

- NEVER `gbrain config set engine ...` — it is refused by design; an engine
  flip without a data migration splits the brain across two stores.
- NEVER pick Postgres over a healthy PGLite brain without the migrate path.
- NEVER add `--yes` before the user has seen the plan, and never use
  `--force` unless the plan listed what it wipes and the user agreed.
- NEVER put the database URL or password in a command line; use
  `--url-env GBRAIN_TARGET_URL`.
- NEVER run the docker rung without the operator's explicit yes.
- NEVER paste or echo `SUPABASE_ACCESS_TOKEN` / passwords into output.

## Output Format

Detection reports in one line; changes report in 2-4:

```
Engine: <pglite|postgres> (source: <db_url_source>)   [probe: ok, 42ms]
Action: <none | init rung that won | migrate --to postgres result>
Next:   <upgrade note, or "healthy — nothing to do">
```

Quote `gbrain engine status` output as-is (it is already redacted); name the
winning ladder rung when an install ran; after a migration, include the
target's `gbrain doctor` verdict.
