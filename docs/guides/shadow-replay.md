# Shadow replay: replay your brain's real engine calls on private copies each night

Shadow mode compares a sample of live reads on the Rust engine. Shadow replay goes further: it records every call
your brain makes to its storage engine, reads and writes, and each night replays that recording on private copies of
the brain, one on PGLite and one on Rust. It compares what the copies
return and writes a report. Everything stays on the brain's own machine. The recording itself is
[shadow capture](shadow-capture.md): what it records, its kill switch and how a purge deletes it are there.

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
Hashes are keyed with a per-brain secret in `capture/key`, so a short value cannot be guessed from its hash. The key is written whole or not at all, and a run refuses a key that is not 64 hex characters.

## Turn it on

```bash
gbrain engine shadow capture on --yes
gbrain engine shadow replay            # the first run only seeds the copies; recording starts now
```

Then restart long-running gbrain processes (`gbrain serve`, an MCP server): only engines opened after capture is on
record. `gbrain engine shadow capture status` lists how many processes are recording.

Each later `gbrain engine shadow replay` replays the recording since the last run, deletes that recording and its
copies, and seeds fresh copies for the next one. Run it once a night. It needs the Rust engine addon installed.

The seed opens the brain itself. A PGLite brain can be open in only one process, so on a PGLite brain stop resident
gbrain processes (`gbrain serve`, an MCP server) for the few minutes of the nightly run and start them again after. If
the brain cannot be opened, the run stops with `shadow_replay_seed_failed` before it retires anything, and the
recording waits for the next run. A Postgres brain needs no window.

The copies are PGLite and Rust. A difference shows that the two engines disagree, not which one is wrong. The copies
get the brain's own embedding layout. A Postgres replay copy is not in this release: setting
`GBRAIN_SHADOW_REPLAY_POSTGRES_URL` stops the run with `shadow_replay_postgres_unavailable` ("postgres replay arm not
in this release") before anything runs.

## What the replay does and does not do

- The arms are compared with each other, never with the live brain. They start from the same snapshot.
- Ids (UUIDs) the seed copied, including ones inside JSON and lists, are compared as stored values; only ids and times the replay itself produced are
  matched one to one between arms.
- Two replays of one brain cannot run at once; a lock a crashed replay left behind is never taken over
  automatically, and the error names the file to remove.
- Calls that finished before the snapshot are skipped (`pre_cut`); calls that overlap it are skipped (`boundary`).
- Committed transactions replay as one group; rolled-back ones are skipped.
- Only engine calls are recorded. Each call belongs to the recording that was current when it started, so a call
  caught by a purge never lands in the next recording.
- The nightly run seals the recording before it replays it: every recording process writes out its calls of that
  recording and acknowledges, and the next recording starts at the same moment. The run waits up to 10 seconds.
- Raw SQL, reserved connections and calls with a function argument are not replayable and count as `gaps`.
- After the replay, every page a replayed write named is read back on each arm (`sweep:` rows), so a write that one
  engine dropped is caught even when it returned the right answer.
- Timestamps the replay itself produced and ids first created during the replay are matched one to one between arms.
  A wrong stored id or a wrong date is still a difference.
- When the seed could not copy everything into the Rust store, Rust differences are labeled `*_seed_loss`.
- A call that succeeded on the live brain but fails the same way on every copy is labeled `replay_diverged`, never a
  match. The usual cause is a conditional write whose expected revision was created after the snapshot: the replay
  passes the recorded revision as is, so such calls prove nothing either way.
- Read-back sweeps read each written page in the source the write named, whether the source is an option or a plain
  argument. Batch writes are read back for every page their rows
  name, and chunk writes are read back with their chunks and embeddings,
  sealed or not. The sweep reads up to 5,000 pages; past that the report says `incomplete` and counts `sweep_skipped`. A page
  write whose page the replay cannot tell is counted as `writes_not_swept` and also makes the report `incomplete`.
  Alias writes, page version writes (`createVersion`, `revertToVersion`) and chunk seals (`sealChunks`,
  `setChunkerVersion`, whose seal stamp is not compared) are not read back yet and count there too. A rename is read
  back at both its old and new slug. Pages are read back with their soft-delete tombstones, so a hard delete behind a
  soft-delete answer differs. A timeline is read back up to 10,000 rows; a longer one counts as `sweep_truncated`. A
  read-back that fails on every copy, even the same way, verifies nothing and counts as `sweep_failed`. Each of these
  makes the report `incomplete`.
- A replay loads at most 512 MiB of recording; records past that count as `records_over_memory` and make the report
  `incomplete`.
- Times the seed copied that lie in the future (an expiry date, say) are compared as stored values, in any spelling,
  like the ids it copied.
- A recording process that did not acknowledge the seal in time, acknowledged with capture off or over its disk
  budget, or died without writing out its last calls may have calls missing; the report counts each one as
  `recorders_alive_at_seal` and says `incomplete`. So does a recording that began right after such a death.
- Known limit: each copy numbers new rows (sequence positions) on its own, so a row number the replay created can
  differ between the copies. That shows as a false difference, never as a false match.
- A replay that fails for any reason other than a purge keeps its recording and copies for one retry the next night;
  a second failed attempt retires them. The sealed recording is recorded as owed a replay before the seal, so a run
  that dies after its seal keeps it under the same rule, and recordings that nothing names any more are deleted at the
  next run. A purge always deletes them.
- Recording stays bounded on the brain's own calls: an argument over 1 MiB is recorded as a `gaps` entry before it is
  copied, and a result over 1 MiB is not hashed past that size.
- The replay runs in a child process with a throwaway home, its own empty working directory and no API keys. It never
  reads a `.env`, `.env.local` or `bunfig.toml` from the directory the nightly run started in. It cannot open network
  connections and opens only its copies, never the brain.

## Purge

When you purge a page or fact, gbrain writes a line to its purge log. Any new purge-log line, or a purge log that
cannot be read, deletes the whole current recording and its copies (and any recording kept for a retry). It also deletes recordings and copies a crashed nightly run left behind. The process doing the purge does this at once, whether capture is on, off or turned off with
`GBRAIN_SHADOW_CAPTURE=off`, as long as the brain has a capture directory. Other processes and the nightly run check
before they write. A running replay is stopped within seconds. Nothing purged is replayed. The next nightly run seeds new copies from
the purged brain. Every purge path runs the same full cleanup, and `capture delete` and `engine shadow stop --delete` share one delete
path that refuses while a replay runs. Reports and summaries hold no content, so a purge has nothing to remove there.

## Stop and delete

```bash
gbrain engine shadow capture off                 # stops every recording process at its next write; deletes nothing
GBRAIN_SHADOW_CAPTURE=off gbrain serve           # off for any process started with this variable
gbrain engine shadow capture delete --yes        # deletes recordings, copies and reports (refused while a replay runs)
gbrain engine shadow stop --delete               # deletes all shadow state, through the same locked path
```

## Nightly run on the brain's host (for an operator agent)

Nothing here needs the brain's owner. Run these on the brain's host only.

1. Check: `gbrain engine shadow capture status --json` must succeed, and `gbrain doctor --json` must not report a
   Rust addon problem.
2. First time only: `gbrain engine shadow capture on --yes`, then `gbrain engine shadow replay --json`, then restart
   the host's resident gbrain processes.
3. Schedule once a night, through the brain's gbrain wrapper: on a PGLite brain, stop the resident gbrain
   processes, run `gbrain engine shadow replay --json`, start them again; on a Postgres brain, run the command alone. Use the wrapper (the one that sets
   `GBRAIN_HOME`; see [cron-schedule.md](cron-schedule.md#calling-gbrain-unattended)). Keep stderr in the local log.
4. After each run, read the JSON on stdout. `status` is `replayed`, `seeded_only`, `purged` or `off`; on an error it
   is `error` with a `code` from the table below.
5. Send off the host only `summary.json` (its path is in `summary`). Never send `report.json` paths with run names,
   the recording, the copies, stderr or the log.
6. Stop with `gbrain engine shadow capture off`; delete with `gbrain engine shadow capture delete --yes`.

## Errors

| Code | Meaning | Fix | Retry |
|---|---|---|---|
| `shadow_replay_busy` | another replay is running, or a crashed one left a stale lock | wait; for a stale lock, remove the file the message names | after fix |
| `shadow_replay_purged` | the purge log changed or cannot be read, or a purge's deletion is not finished; the recording was deleted | nothing (an unreadable log: make it readable; an unfinished deletion: rerun) | safe |
| `shadow_replay_seed_failed` | the brain could not be opened for the seed (nothing retired), or seeding failed (partial copies deleted) | on PGLite stop resident processes; else read stderr, fix, rerun | after fix |
| `shadow_replay_addon_unavailable` | no Rust addon for this release | install it | after fix |
| `shadow_replay_postgres_unavailable` | postgres replay arm not in this release | unset `GBRAIN_SHADOW_REPLAY_POSTGRES_URL` | after fix |
| `shadow_replay_key_invalid` | the per-brain hash key `capture/key` is empty, short or not hex; nothing was written | delete `capture/key` (a new one is written; earlier summaries become incomparable) | after fix |
| `shadow_replay_budget` | the run passed `--budget-minutes` (default 120) | raise the budget | safe |

The registry with every field is `src/shadow/replay-errors.ts`.
