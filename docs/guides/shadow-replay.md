# Shadow replay: replay your brain's real engine calls on private copies each night

Shadow mode compares a sample of live reads on the Rust engine. Shadow replay goes further: it records every call
your brain makes to its storage engine, reads and writes, and each night replays that recording on private copies of
the brain, one on PGLite, one on Rust and, if you have a local Postgres, one on Postgres. It compares what the copies
return and writes a report. Everything stays on the brain's own machine.

**Say to your agent:** *"Turn on shadow replay for my brain and run it every night."*

**Say to your agent:** *"Show me last night's shadow replay summary."*

**Say to your agent:** *"Stop shadow replay capture."*

## What it keeps, and where

Everything lives under `<gbrain home>/shadow/<brain>/` in owner-only files (mode 0600, folders 0700):

| Path | What it holds | Content? |
|---|---|---|
| `capture/epoch-<id>/*.jsonl` | the recording: each engine call with its arguments, the time, and a SHA-256 of the result | yes, private |
| `capture/bases/<id>/` | the copies seeded when the recording began (a Rust store and a PGLite brain) | yes, private |
| `replay/<run>/out/report.json`, `report.md` | the local report: operation, field path, class, keyed hashes, counts | no |
| `replay/<run>/out/summary.json` | the only file meant to leave the machine: operation, field path, keyed hash and counts | no |

Field names outside a fixed list of schema fields (a frontmatter key, for example) appear only as a keyed hash.
Hashes are keyed with a per-brain secret in `capture/key`, so a short value cannot be guessed from its hash.

## Turn it on

```bash
gbrain engine shadow capture on --yes
gbrain engine shadow replay            # the first run only seeds the copies; recording starts now
```

Then restart long-running gbrain processes (`gbrain serve`, an MCP server): only engines opened after capture is on
record. `gbrain engine shadow capture status` lists how many processes are recording.

Each later `gbrain engine shadow replay` replays the recording since the last run, deletes that recording and its
copies, and seeds fresh copies for the next one. Run it once a night. It needs the Rust engine addon installed.

Optional third arm: set `GBRAIN_SHADOW_REPLAY_POSTGRES_URL` to an empty Postgres database on this machine
(`localhost` or a Unix socket). Any other host is refused before a row is sent. The seed records the URL in
`capture/scratch-postgres.json` (owner-only) so that a purge in any process can drop the copy. With three arms a difference reads as
"Rust differs" (PGLite and Postgres agree) or "the TypeScript engines disagree" (`ts_disagree`). With two arms a
difference only shows that PGLite and Rust disagree.

## What the replay does and does not do

- The arms are compared with each other, never with the live brain. They start from the same snapshot.
- Calls that finished before the snapshot are skipped (`pre_cut`); calls that overlap it are skipped (`boundary`).
- Committed transactions replay as one group; rolled-back ones are skipped.
- Raw SQL, reserved connections and calls with a function argument are not replayable and count as `gaps`.
- After the replay, every page a replayed write named is read back on each arm (`sweep:` rows), so a write that one
  engine dropped is caught even when it returned the right answer.
- Timestamps the replay itself produced and ids first created during the replay are matched one to one between arms.
  A wrong stored id or a wrong date is still a difference.
- When the seed could not copy everything into the Rust store, Rust differences are labeled `*_seed_loss`.
- The replay runs in a child process with a throwaway home and no API keys. It cannot open network connections (only
  the local scratch Postgres) and opens only its copies, never the brain.

## Purge

When you purge a page or fact, gbrain writes a line to its purge log. Any new purge-log line, or a purge log that
cannot be read, deletes the whole current recording and its copies, and drops the local Postgres scratch copy's
schema. The process doing the purge does this at once, whether capture is on, off or turned off with
`GBRAIN_SHADOW_CAPTURE=off`, as long as the brain has a capture directory. Other processes and the nightly run check
before they write. A running replay is stopped within seconds. If the scratch database cannot be reached at that
moment, a pending marker stays, and every later replay, status and seed refuses to go on until the drop succeeds
(`capture status` shows `scratch_drop_pending`). Nothing purged is replayed. The next nightly run seeds new copies from
the purged brain. Reports and summaries hold no content, so a purge has nothing to remove there.

## Stop and delete

```bash
gbrain engine shadow capture off                 # stops every recording process at its next write; deletes nothing
GBRAIN_SHADOW_CAPTURE=off gbrain serve           # off for any process started with this variable
gbrain engine shadow capture delete --yes        # drops the scratch copy, deletes recordings, copies and reports
```

## Nightly run on the brain's host (for an operator agent)

Nothing here needs the brain's owner. Run these on the brain's host only.

1. Check the addon: `gbrain engine shadow capture status --json` must succeed, and `gbrain doctor --json` must not
   report a Rust addon problem.
2. First time only: `gbrain engine shadow capture on --yes`, then `gbrain engine shadow replay --json`, then restart
   the host's resident gbrain processes.
3. Schedule `gbrain engine shadow replay --json` once a night through the brain's gbrain wrapper (the one that sets
   `GBRAIN_HOME`; see [cron-schedule.md](cron-schedule.md#calling-gbrain-unattended)). Keep stderr in the local log.
4. After each run, read the JSON on stdout. `status` is `replayed`, `seeded_only`, `purged` or `off`; on an error it
   is `error` with a `code` from the table below.
5. Send off the host only `summary.json` (its path is in `summary`). Never send `report.json` paths with run names,
   the recording, the copies, stderr or the log.
6. Stop with `gbrain engine shadow capture off`; delete with `gbrain engine shadow capture delete --yes`.

## Errors

| Code | Meaning | Fix | Retry |
|---|---|---|---|
| `shadow_replay_busy` | another replay is running | wait | safe |
| `shadow_replay_purged` | the purge log changed or cannot be read; the recording was deleted | nothing (an unreadable log: make it readable) | safe |
| `shadow_replay_seed_failed` | seeding the copies failed; partial copies were deleted | read stderr, fix, rerun | after fix |
| `shadow_replay_addon_unavailable` | no Rust addon for this release | install it | after fix |
| `shadow_replay_postgres_not_local` | the scratch URL could leave the machine | point it at a local database or unset it | after fix |
| `shadow_replay_postgres_not_owned` | the scratch database is not empty or is the brain | use an empty database | after fix |
| `shadow_replay_postgres_privilege` | the scratch role cannot reset its database | give it ownership of that database | after fix |
| `shadow_replay_budget` | the run passed `--budget-minutes` (default 120) | raise the budget | safe |

The registry with every field is `src/shadow/replay-errors.ts`.
