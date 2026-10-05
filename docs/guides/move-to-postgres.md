# Move a PGLite brain to Postgres

`gbrain migrate --to postgres` moves a PGLite brain on this computer to a
Postgres database, history included: pages, facts, takes, versions, write
requests, withdrawals, tokens and OAuth clients all carry over with their IDs
unchanged. The move is a verified graduation: gbrain drains pending writes,
copies every table into a fenced target, checks every row against the source,
runs `gbrain doctor` on the target, and only then switches the brain over. At
every instant exactly one engine accepts writes, including across crashes.

The move takes one command and one confirmation. The first command prints the
plan and exits 3 without changing anything; the second runs it after the user
agrees.

**Say to your agent:** *"Upgrade my brain to Postgres. Show me the plan first."*

**Say to your agent:** *"Move my brain to Supabase, then tell me what still
depends on this computer."*

**Say to your agent:** *"The brain move to Postgres stopped. Where is it, and
what do I do next?"*

The [postgres-adopt skill](../../skills/postgres-adopt/SKILL.md) walks the
same flow for an agent.

## Before you start

- **A PGLite brain on this computer.** `gbrain engine status --json` reports
  `effective_engine: "pglite"`. Graduation is CLI-only and runs on the brain
  host; a thin client gets a refusal.
- **An empty Postgres database.** Empty means no gbrain tables, or a gbrain
  schema holding only the rows a fresh `gbrain init` writes. A database with
  other data refuses with `graduation_target_not_empty`.
- **The `vector` extension with `halfvec` support** (pgvector 0.7 or newer),
  a server version gbrain supports, and the `CREATE` privilege on the
  database. The plan checks each one and names the fix.
- **Linux or macOS.** On Windows, a brain with write history stays on PGLite
  (see [Platforms](#platforms)).
- **No other client pointed at the target yet.** The target refuses writes
  from anything but the graduation run until cutover; point other machines at
  it afterwards.

A running `gbrain serve` or autopilot on this brain does not need to be
stopped: a stdio serve hands the brain over and exits, and autopilot pauses.

## Put the target URL in an environment variable

Keep the connection string out of shell history, process listings and agent
transcripts:

```bash
read -rs GBRAIN_TARGET_URL && export GBRAIN_TARGET_URL   # paste the URL, press Enter
```

Every graduation command takes `--url-env GBRAIN_TARGET_URL`, and every
command gbrain prints shows `--url-env GBRAIN_TARGET_URL` or the redacted host,
never the URL or password. Two alternatives exist: `--url -` reads the URL from
stdin, and `--url <url>` takes it as an argument (visible in `ps` and shell
history).

The run records the full URL in `~/.gbrain/graduation-manifest.json`
(mode 0600, like `config.json`), so `--status`, `--resume` and
`--rollback-to-source` work in a fresh shell without the variable.

### Supabase connection topology

Use the **transaction pooler** string (port 6543) as the target URL. gbrain
runs schema changes and locks on a separate direct connection, which it derives
as `db.<project>.supabase.co:5432`; that host is IPv6-only. On an IPv4-only
machine, set the direct connection to the **session pooler** before planning:

```bash
read -rs GBRAIN_DIRECT_DATABASE_URL && export GBRAIN_DIRECT_DATABASE_URL   # session pooler, port 5432
```

The plan probes both routes and proves they reach the same database before any
DDL. Background: [personal-brain tutorial, steps 7b and 7c](../tutorials/personal-brain.md#7b-get-the-transaction-pooler-connection-string-not-the-direct-one).

## Move the brain

### 1. Plan and ask

```bash
gbrain migrate --to postgres --url-env GBRAIN_TARGET_URL --json
```

Without `--yes` this changes nothing. It prints the plan as a
`confirmation_required` document and exits 3. It never prompts on stdin.

#### What you'll be asked

The document (abridged) looks like this:

```json
{
  "code": "confirmation_required",
  "effects": ["egress", "destructive"],
  "user_message": "Move this brain to Postgres at db.example.com?",
  "plan_hash": "9f3c…",
  "preview": { "command": "gbrain migrate --to postgres --url-env GBRAIN_TARGET_URL --plan --json" },
  "fix": {
    "next": "ask_user",
    "command": "gbrain migrate --to postgres --url-env GBRAIN_TARGET_URL --yes --expect 9f3c…"
  }
}
```

The full document also lists what moves and what stays on this computer (see
[What moves and what stays](#what-moves-and-what-stays)), the tables and row
counts, blockers with their fixes, and the estimated time. The agent relays
`user_message` and those two lists to the user and stops.

`--plan` (alias `--dry-run`) prints the same plan read-only and exits 0. It
runs no schema migration on either side and no DDL on the target.

### 2. Run, after the user agrees

```bash
gbrain migrate --to postgres --url-env GBRAIN_TARGET_URL --yes --expect <plan_hash>
```

`--expect` binds the run to the plan the user saw. If anything the plan
depends on changed since then (blockers, target contents, versions), the run
refuses with `preview_changed`; go back to step 1. `--yes` without `--expect`
re-plans and returns `confirmation_required` with a fresh hash.

The run drains pending writes, copies, verifies, cuts over and ends with the
target's `gbrain doctor` result. Its output names:

- the multi-machine next step, `gbrain mcp expose` ([remote MCP](remote-mcp.md));
- that existing access tokens, OAuth clients and local writer credentials stay
  valid (see [Credentials](#credentials-after-the-move));
- when a `gbrain serve` handed the brain over, that the MCP client needs a
  restart (see [Restart the MCP client](#restart-the-mcp-client)).

`--to supabase` is an alias of `--to postgres`; every command gbrain prints
echoes the spelling you typed.

### Large brains

A brain with thousands of pages takes a while to move. Run it in the
background and poll:

```bash
gbrain migrate --to postgres --url-env GBRAIN_TARGET_URL --yes --expect <plan_hash> --json > graduation.json &
gbrain migrate --status --json
```

With `--json`, stdout carries one result document and progress goes to stderr
as described in [progress events](../progress-events.md).

### Exit codes

| Exit | Meaning | What the agent does |
|---|---|---|
| 0 | graduated, or the plan was shown with `--plan` | continue |
| 3 | `confirmation_required`: nothing changed | relay `user_message`; run `fix.command` only after the user agrees |
| 1 | refused | follow the refusal's `fix` ([recovery by code](#recovery-by-code)) |
| 2 | usage error | correct the command (`gbrain migrate --help`) |
| 11 | resumable stop: `--drain-timeout` ran out while blockers still progress | run `resume_command` from the JSON |
| 75 | `graduation_in_progress`: another run holds the migration | wait, then poll `gbrain migrate --status --json` |
| 130 | interrupted (SIGINT); the run stopped at the next batch boundary | ask the user, then `gbrain migrate --resume` |

## Check, resume or roll back

These commands act on the run recorded in the manifest, so they need no
`--to` or `--url`; passing a `--to` or `--url` that contradicts the run
refuses.

```bash
gbrain migrate --status --json      # read-only: state, tables, receipt, next command
gbrain migrate --resume             # continue from the first incomplete step
gbrain migrate --rollback-to-source # discard the target; the PGLite brain stays authoritative
```

`--status` changes nothing, on either side, in any state.

Rollback before cutover always succeeds and loses nothing. After cutover,
rollback first fences the target, then checks for writes made on Postgres since
the move:

- With no new writes, the PGLite brain is restored and the target is
  abandoned.
- With new user data (pages, facts, takes and similar), rollback refuses with
  `graduation_rollback_writes_lost` and lists what would be lost. After the
  user agrees to that loss:
  `gbrain migrate --rollback-to-source --yes --expect <hash>`.
- With a fact withdrawal, or a token, OAuth or local-writer revocation or
  credential change on the target, rollback refuses finally (`fix.next:
  report`) and the target stays authoritative. Recover forward on Postgres.

Rollback never writes anything back to the PGLite brain. A refused, declined
or interrupted rollback returns the target to service. Once the retained copy
is gone ([discarded](#discard-the-retained-copy) or deleted by hand), rollback
refuses with `not_found` and the target stays authoritative.

## What moves and what stays

| Moves to the database | Stays on this computer |
|---|---|
| pages, facts, takes, versions, links, timeline | file storage object bytes (the storage backend's files) |
| embeddings, transcripts and paid caches | git worktrees and their host bindings |
| write request history and withdrawals | the MCP endpoint and OAuth issuer URL |
| access token and OAuth rows (hashes, not secrets) | the retained `<path>.graduated-<run_id>` copy, until you discard it |

The database side is everything another machine needs to query and write the
brain. The host side is bound to this computer: worktrees owned by another host
refuse the move (`graduation_foreign_host_binding`), and an MCP endpoint served
from this machine keeps its URL.

The `gbrain.graduation_run` setting and the `GBRAIN_GRADUATION_RUN` variable
are safety interlocks that keep stray clients out during the move. They are
not security boundaries.

## After the move

**The PGLite copy is retained.** The data dir is renamed to
`<path>.graduated-<run_id>`. It still holds private memory and token hashes.
`gbrain doctor` reports it under `pglite_leftovers` with its size; deleting it
is the user's call ([discard the retained copy](#discard-the-retained-copy)).

**The old path is a tombstone.** A small file sits where the data dir was. Any
gbrain client pointed at it gets `engine_graduated` with a one-step fix
([below](#graduated-datastore)); an older release fails to open it rather than
creating an empty brain there.

**Long-running processes follow.** Autopilot restarts onto Postgres. A
`gbrain serve` started while the move runs exits with `graduation_in_progress`
(exit 75); a stdio serve that held the brain hands it over through the intent
marker `<path>.gbrain-graduation.json` and exits; a serve in status-only or
degraded mode exits for relaunch when the engine changes.

`gbrain engine status --json` reports the graduation state (intent marker,
manifest state, tombstone, redacted target).

### Credentials after the move

Existing access tokens, OAuth clients and local writer credentials stay valid
on Postgres. To issue fresh ones anyway:

```bash
gbrain auth revoke <name> && gbrain auth create <name>              # access token
gbrain auth revoke-client <client_id> && gbrain auth register-client <name>   # OAuth client
gbrain auth local-writer register stdio --replace                   # local writer (or: cli)
```

### Restart the MCP client

When a serve handed the brain over, restart the MCP client so it launches a
fresh `gbrain serve` on Postgres. Some desktop hosts stop relaunching a server
that exited repeatedly.

| Harness | Step |
|---|---|
| Claude Code | run `/mcp` and reconnect `gbrain`, or start a new session |
| Claude Desktop | quit the app completely and reopen it |
| Codex | start a new Codex session |
| Cursor | turn the `gbrain` server off and on in the MCP settings |
| OpenCode | restart opencode or start a new session |
| OpenClaw, Hermes and other agents | restart the agent process |

### Other machines

To share the brain, run `gbrain mcp expose` on this host and connect other
machines over MCP. A machine with its own config pointing at the old path gets
`engine_graduated`; follow its fix.

### Discard the retained copy

Once the brain works on Postgres and nobody needs a rollback, delete the
retained PGLite copy: it still holds private memory and access-token hashes.

**Say to your agent:** *"My brain runs on Postgres now. Delete the old local
copy, but show me what goes first."*

```bash
gbrain migrate --discard-source --dry-run                  # read-only: what it deletes, sizes, plan_hash
gbrain migrate --discard-source                            # asks: prints the plan, exits 3, deletes nothing
gbrain migrate --discard-source --yes --expect <plan_hash> # after the user agrees
```

It deletes what the recorded run left on this computer: the retained copy
`<path>.graduated-<run_id>`, the tombstone at the old path and the intent
marker `<path>.gbrain-graduation.json`. The graduation manifest stays;
`gbrain migrate --status --json` reports `sourceDiscardedAt`.

It refuses and deletes nothing unless all of these hold:

- The recorded run is `graduated`. An unfinished move or a pending rollback
  refuses with `graduation_interrupted` (`graduation_in_progress` while its
  process runs); a rolled-back run refuses with `not_found`.
- The Postgres target confirms, in a read-only session, that it is
  authoritative for this run. A rollback that already fenced it refuses with
  `graduation_in_progress`; an unreachable target with `database_error`.
- Only the run's own files sit at those paths (`local_conflict` otherwise).
- `--expect` matches the current plan (`preview_changed` otherwise).

Afterwards `gbrain migrate --rollback-to-source` refuses: there is nothing left
to restore. The old path is free again, so a gbrain client still configured for
it creates a new, empty brain there instead of getting `engine_graduated`.
`gbrain doctor` names this command in the `pglite_leftovers` fix.

## Recovery by code

Each refusal carries `why`, `fix` and a read-only `fix.verify`; follow `fix.next`
per the [agent operator protocol](../protocol/AGENT_OPERATOR_v1.md). Unless a
row says otherwise, the PGLite brain stays authoritative and writable.

<a id="inventory"></a>
### `graduation_unclassified_table`

A table exists that this gbrain release does not know how to move. If the
target was created by a newer gbrain, upgrade this binary. If the table comes
from this release's own schema, it is a bug: report it. `--force` never
overrides this. Verify: `gbrain migrate --plan --json`.

<a id="embeddings"></a>
### `graduation_embedding_dimension_mismatch`

The target already holds embeddings of a different dimension. An empty target
is sized from the source automatically, so this only happens with a non-empty
target. Use an empty database, or `--force --expect <plan_hash>` after the
plan lists what it wipes (ask the user).

<a id="drain"></a>
### `graduation_drain_timeout`

Pending writes did not finish within `--drain-timeout` (default 60 seconds).
When every blocker is still progressing the run exits 11; run the
`resume_command`, for example `gbrain migrate --resume --drain-timeout 120`.
A blocker that needs a person (a stuck recovery, a writer admin lock) carries
its own command. Verify: `gbrain migrate --status --json`.

<a id="target-not-empty"></a>
### `graduation_target_not_empty`

The target holds data that is not a fresh gbrain schema. Pick an empty
database, or, after the user has seen `--plan` list what it deletes, rerun
with `--force --expect <plan_hash>`. `--force` never bypasses the inventory
check, a held writer or the fenced cutover.

<a id="hosts"></a>
### `graduation_foreign_host_binding`

A worktree or pending write is bound to another host. Check it with
`gbrain sources writer status <id>` and transfer ownership to this host first
(`gbrain sources writer transfer prepare <source>` on the owner, then
`transfer accept` here). The user runs this on both hosts.

<a id="verify"></a>
### `graduation_verify_failed`

The target did not match the source (row counts, digests, foreign keys,
sequences, the replay probe, or a doctor check that fails only on the target).
The refusal names the table and first differing row. `gbrain migrate --resume`
re-copies the mismatched tables once; a repeated mismatch is a bug to report,
and `gbrain migrate --rollback-to-source` is the safe exit.

<a id="resume"></a>
### `graduation_interrupted`

A run stopped (crash, SIGKILL, reboot) before finishing. `gbrain doctor`
reports it as failing. Run `gbrain migrate --resume`, or
`gbrain migrate --rollback-to-source`. Verify: `gbrain migrate --status --json`.

<a id="in-progress"></a>
### `graduation_in_progress`

Another graduation run holds the brain (exit 75). Also returned to a
`gbrain serve` started during the move, and to any client that reaches the
target before cutover. Wait for the run and poll `gbrain migrate --status --json`.

<a id="graduated-datastore"></a>
### `engine_graduated`

The client opened the old PGLite path after the brain moved. On the host that
ran the move, `gbrain migrate --resume` finishes any remaining routing step.
On any other machine, the user points the config at the target and restarts
the MCP client:

```bash
gbrain config set database_url "$GBRAIN_TARGET_URL"
```

<a id="credentials"></a>
### `graduation_target_auth_failed`

The target rejected the recorded credentials, usually after a password change.
Put the new URL for the same database in a variable and rerun with
`--url-env <VAR>` (for example `gbrain migrate --resume --url-env GBRAIN_TARGET_URL`).
A URL naming a different database is refused.

<a id="ddl-connection"></a>
### `graduation_target_ddl_unreachable`

The direct connection gbrain uses for schema changes and locks is unreachable,
or does not reach the same database as the main URL. On Supabase, set
`GBRAIN_DIRECT_DATABASE_URL` to the session pooler
([topology](#supabase-connection-topology)) and rerun the plan.

<a id="target-requirements"></a>
### `graduation_target_unsupported`

The target misses a prerequisite: the server version, the `vector` extension
with `halfvec`, the `CREATE` privilege, or a column whose type differs from
the source. The refusal names which one and the fix. Verify:
`gbrain migrate --plan --json`.

<a id="platforms"></a>
### `graduation_unsupported_platform`

Windows, brain with write history. Keep the brain on PGLite and share it with
`gbrain mcp expose`. A Windows brain without history moves with the legacy
copier.

<a id="rollback"></a>
### `graduation_rollback_writes_lost`

A rollback after cutover would drop writes made on Postgres. The refusal lists
them by table and count. For user data, rerun
`gbrain migrate --rollback-to-source --yes --expect <hash>` only after the user
agrees to that loss. For withdrawals, revocations and credential changes the
refusal is final; recover forward on Postgres.

<a id="split-brain"></a>
### `graduation_split_brain`

A different brain appeared at the old PGLite path during the move, so the
target is withheld from authority. `gbrain migrate --status --json` shows both
paths with row counts and newest write times. Ask the user which to keep:
move the stray brain aside and resume forward, or roll back.

<a id="writer-held"></a>
### `graduation_source_writer_held`

A process holding the brain did not hand it over within 30 seconds (an HTTP
serve, a daemon, or another command). The user stops the named process, then
the agent reruns the command. Details:
[ENGINES.md](../ENGINES.md#graduation-writer-held).

## Options

| Flag | Effect |
|---|---|
| `--url-env <VAR>`, `--url <url>`, `--url -` | the target URL (variable, argument or stdin) |
| `--plan`, `--dry-run` | read-only plan, exit 0 |
| `--yes --expect <plan_hash>` | run the plan the user approved |
| `--drain-timeout <seconds>` | how long to wait for pending writes (default 60) |
| `--trigger-bypass replica\|disable-trigger` | force the copy's trigger-bypass mechanism (part of the plan hash) |
| `--batch-size <n>` | override the measured copy batch size (part of the plan hash) |
| `--force` | wipe a non-empty target the plan listed; requires `--expect` |
| `--json` | one result document on stdout; progress on stderr |
| `--status`, `--resume`, `--rollback-to-source` | act on the recorded run |
| `--discard-source [--dry-run]` | delete the recorded run's retained copy, tombstone and marker once it is `graduated` ([details](#discard-the-retained-copy)) |

## Other directions and the legacy copier

- `gbrain config set migrate.graduation false` sends PGLite to Postgres
  moves through the legacy copier, which refuses brains with write history.
- Postgres to PGLite (`gbrain migrate --to pglite`) always uses the legacy
  copier and refuses brains with history.
- Postgres to Postgres moves use `pg_dump` or the provider's tooling.

## Known limits

If the process is SIGKILLed in the instant between renaming the data dir and
writing the tombstone, and an older gbrain release then opens the old path
before this release does, that release can create an empty stray brain there.
The next graduation command detects it and refuses with
`graduation_split_brain`; the target is not made authoritative until the user
decides.
