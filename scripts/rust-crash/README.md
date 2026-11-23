# Rust crash cell

A real-process crash test for the Rust store. Writer processes write to a real
redb file through the built addon. The cell SIGKILLs each writer at a chosen
point, reopens the brain and compares it with a PGLite oracle.

```sh
bun run rust:build --crash-points
GBRAIN_RUST_ENGINE_ADDON=<the path it prints> bun scripts/rust-crash/run.ts
```

The cell needs an addon built with gbrain-store's `crash-points` cargo feature.
`--crash-points` builds one under `rust/target/addon-crash-points/`. The release
addon (`bun run rust:build`, under `rust/target/addon/`) is built without the
feature and has no crash points. The cell fails against it, because the
counting pass logs no page write or fsync events.

`rust-engine.yml` runs it on linux-x64-glibc and darwin-arm64 (the `crash-cell`
job), with a crash-points addon that the job builds.

## What it runs

Each seed is a sequence of the write paths a Rust brain serves at the swap
(`ops.ts`): `put_page`, `remember` (one fact, or a batch of two or three),
`forget`, and a `sync_brain` of a Git checkout after a commit of one or two files.
Each runs through its registered operation with a real local
`OperationContext`, on an unmanaged brain, the way the CLI runs it.

The default set is 8 fixed seeds (101 to 808) of 27 operations each (the source,
three pages, then 24 seeded operations). Per seed:

1. The oracle runs the sequence on PGLite and records a read projection after
   every operation: each page's title, type, body, timeline, tags and chunk text,
   its facts (claim, kind, visibility, expired or not, has an end date or not), and the sync
   source's last imported commit. Times and dates are folded out; Git commits are fixed.
2. A counting pass runs the sequence in a worker with no kill. Its brain must
   equal the oracle at the end. The pass records where the kill points fall.
3. Nine kills, each in its own worker on a fresh brain:

| Kill point | Where the process dies |
| --- | --- |
| `write:<n>` (2) | before the n-th page write of the record file: a commit has written some pages and not the rest |
| `sync:<n>` | before the n-th fsync: a commit's pages are written and not flushed |
| `synced:<n>` | after the n-th fsync returned: the commit is durable and its caller has no answer |
| `publication:before_commit`, `publication:after_commit`, `consumer:prepared` | the persistence fault points an unmanaged write reaches (`src/core/persistence/fault-points.ts`) |
| after an acknowledgement | between two operations |
| timer | at a seeded time, 50 to 1550 ms after the brain opens |

The first three are the store's crash points
(`rust/crates/gbrain-store/src/crash_points.rs`). They are compiled only with the
`crash-points` feature, and even then they are off unless
`GBRAIN_TEST_RUST_CRASH_LOG` is set when a brain opens. Then the record file opens
through a plain file backend that logs every page write and fsync, and freezes
at the event `GBRAIN_TEST_RUST_CRASH_AT` names. The driver sees the freeze line
and SIGKILLs the worker. Without the feature or the variable, the record file
opens through redb's own backend, as always.

Each kill class has a minimum: per seed, two mid-commit kills, one before and one
after an fsync, three at the persistence boundaries, one between operations and
one timed. A class below its minimum fails the cell. That includes a kill point
that the counting pass never logged, so a class that stopped happening cannot
pass as a smaller run.

## What it checks after a kill

The driver reopens the brain in a new process (its own) and:

- clears the dead worker's leases, as `sync --break-lock` clears a dead holder's;
- starts the persistence consumer and waits until every request the dead worker
  accepted ends committed or refused (bound 180 s: a request killed inside its
  publication is taken over when its claim lease ends, about 2 minutes with the
  60 s publication ceiling the worker sets);
- compares the brain with the oracle. It must equal the oracle after every
  acknowledged operation, with the operation in flight all there or not there at
  all. Two operations are several commits by design and may be part-applied: a
  sync (each file imports on its own) and a remember batch (each item commits on
  its own). Each must reach the oracle's state when run again (the batch with
  its original request id);
- runs the rest of the sequence on the reopened brain. The end must equal the
  oracle's end.

These are process-crash checks: a SIGKILL leaves the operating system's page
cache, so they do not simulate power loss. `gbrain-sim`'s fake disk
(`rust/crates/gbrain-store/tests/sim.rs`) covers torn writes and fsync lies.

## Fail-first

The cell must fail on a planted bug:

- `--plant=early-ack --expect-caught`: the worker acknowledges each operation
  before it runs it. CI runs this on 3 seeds on both targets.
- `plants/durability-none.patch`: the record store commits with
  `Durability::None`. CI builds a second Linux addon with the patch and runs
  `--seeds=101,202 --expect-caught`.

The `addon` job also runs `release-ignores.ts` against the release addon. It
sets the cell's variables to freeze at the first page write, then writes a page
in a child process. The write must finish and no log may appear. An addon with
crash points fails that check.

`--expect-caught` exits 0 only when at least one run reopened the killed brain and found it wrong (it differs from every
state the oracle allows, or the store refuses to open it). A worker that never started, a kill point that was never reached
or a drain that timed out is a failed run that does not count as a catch.

## Options

`--seeds=101,202` (whole numbers of 1 or more; `--seeds=` is a usage error),
`--ops=24`, `--jobs=<n>` (kills run in parallel, default the
CPU count less one, at most 6), `--engine=pglite` (the control arm: the workers
run on PGLite, without the store's own crash points), `--keep` (keep the scratch
directory).

Only a real SIGKILL counts toward a minimum. A worker that had already exited
when its kill point came (a timer past the end of the sequence) fails the run.

Open note: `log.ts` `readLog` has no unit test.
