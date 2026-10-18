# Ubicloud fan-out (`ci:ubicloud`)

`scripts/ci-ubicloud.ts` runs the `ci:local` gate on ephemeral Ubicloud VMs
instead of one Docker host. It packs the working tree once (tracked files,
untracked files that are not ignored, and `.git`) and streams it to every VM, so
uncommitted edits are tested. `scripts/ubicloud/ubi-runner.sh` creates and
destroys the VMs.

## Ownership and teardown

Every VM is named `ubirun-<owner>-<epoch>-<suffix>`. The owner is `UBI_OWNER`
(lowercased, letters and digits only, at most 12 characters, starting with a
letter) or a random per-machine id kept in the runner's state directory. Set
`UBI_OWNER` to your thread code (`UBI_OWNER=gbra41 bun run ci:ubicloud`) so
everyone can see whose VMs hold the quota. Ubicloud names allow 63 characters
of `[a-z0-9-]`, so a full name stays under 40.

Each name is recorded before its create request is sent: the runner writes
the VM's state directory first, and `ci-ubicloud.ts` appends the name to
`.context/ci-ubicloud/<run>/vms.txt`. On every exit, including Ctrl-C,
SIGTERM, SIGQUIT and SIGHUP (a dropped terminal or a cancelled background
operation), an `up` still talking to the API finishes the request and destroys
its own VM; further signals are ignored until teardown ends. Then every recorded name gets `down`, which destroys the VM and polls
until it is confirmed gone. A create whose answer never arrived is waited out
for `UBI_CREATE_GRACE` seconds (default 180) before the VM counts as never
created. `down` gives up after `UBI_DOWN_TIMEOUT` seconds (default 900) and
prints the command to rerun.

Nothing sweeps stale VMs unless you ask. With `UBI_GC_HOURS` set to a positive
number, each `up` first destroys the caller's own VMs older than that many
hours. An operator runs the same sweep with `ubi-runner.sh gc HOURS`. Neither
ever destroys another owner's VM, an untagged legacy `ubirun-<epoch>-*` VM, or a
VM the runner did not name. Use `down NAME` for those after checking who owns
them.

A machine that goes to sleep kills the run outright, with no signal, so
teardown can't run: on Capy, run `ci:ubicloud` as a watched background
operation so the machine stays awake. After any interrupted run, check
`list --mine` and reap leftovers with `down NAME` (or `gc HOURS`, which only
destroys your own VMs older than HOURS).

`ubi-runner.sh list --mine` lists your VMs. `ubi-runner.sh usage` prints VMs
and vCPUs per owner across the project, which shows who holds the shared quota.

Each VM runs `scripts/ubicloud/setup-ci-vm.sh`: the pinned Bun from
`docker-compose.ci.yml`, the runner container's test prerequisites plus Node
and a C compiler, frozen dependencies, both PGLite snapshot fixtures, and one
`pgvector/pgvector:pg16` server fronted by a transaction-mode PgBouncer per
slot. Every slot's schema is bootstrapped with `setupLegacyEmbeddingDB()`, the
same step nightly full-corpus E2E workers run, so no E2E file depends on which
file reaches a database first.

Setup takes 60-80 seconds, including VM boot (about 25 seconds). The
orchestrator packs the checkout while the VMs boot, then streams the setup
script over SSH as soon as a VM answers, so apt, the Bun and gitleaks
downloads and the image pulls run while the checkout is still uploading; the
script waits for a marker file before the steps that need the checkout. apt
skips fsync, man-db, needrestart and the translation, AppStream and
command-not-found indexes. Database containers start only after apt finishes,
because a package's systemd reload during `docker run` fails the container.
The tarball carries a slim `.git` holding only what `HEAD` and `origin/master`
reach, plus the branch, index and config, so a checkout that fetched many
branches uploads about 80 MB instead of 250 MB. The critical path is now apt's
package installs (about 23 seconds of dpkg work); downloads take two seconds.

`scripts/ubicloud/build-ci-image.sh` builds the `gbrain-ci` machine image
(apt packages and both database images baked in), and `--image
gbrain-ci@latest` or `UBI_CI_IMAGE` boots it, which cuts the setup script from
about 40 seconds to 18. It is opt-in until image boots prove as reliable as
stock ones: on its first full gate five of eight VMs sat in `waiting for
capacity`. Stock VMs hit the same wait later (six of ten in one burst), so
`eu-central-h1` capacity, not just the quota, can shrink a fleet; the run
then continues on the VMs that did start, and it ends once every item has a
result rather than waiting for a VM that never came up. Rebuild the image when the package
list or images change; setup still pulls the floating image tags, so a stale
image costs time, not correctness.

Scheduling is dynamic. Every unit, serial, slow and E2E file is one item in a
global queue ordered by weight, heaviest first. Each idle slot on any VM takes
the next item, so a slow VM or a mis-weighted file delays only the slot holding
it. Light items leave in same-lane batches to amortize SSH round trips, and the
batch target shrinks as the queue drains. Items of 60 seconds or more are the
run's long poles, so they spread one per VM before any VM takes a second one;
the VM running the machine-level items below counts only once it joins the
pool.
The first VM to finish setup runs the
machine-level work first: gitleaks, `verify`, then the serial lane's
machine-exclusive files and the slow lane's latency contracts
(`run-slow-tests.sh --dry-run-list-exclusive`, the files GitHub CI runs on a
dedicated perf runner) one at a time with nothing else on that VM. After that
it joins the pool. Before `verify`, it uploads the incremental typecheck state
(`node_modules/.cache/gbrain-typecheck.tsbuildinfo`, which the checkout
tarball never carries). The orchestrator builds that state with
`bun run typecheck` on the local checkout while the VMs boot
(`scripts/ubicloud/typecheck-state.ts`). Cold, verify's typecheck took 81-84 s
on a 16-vCPU VM and crossed the 120 s per-check cap on a loaded host; warm, it
takes 16-19 s. tsc revalidates every file by content hash, so the state never
changes the result. When the local checkout's `node_modules` is a symlink (a
worktree sharing another checkout's install), tsc records node_modules files by
their real path outside the checkout; the uploaded copy
(`<run>/typecheck.tsbuildinfo`) re-roots them under the checkout's own
`node_modules`, or the state would not apply on the VM and its typecheck would run
cold. The run log says whether verify's typecheck ran warm or cold, and the local
build's output is in `logs/local-typecheck.log`. Items run through the `ci:local` wrappers
(`scripts/ubicloud/ci-item.sh`): `run-unit-shard.sh`, `run-serial-tests.sh` and
`run-slow-tests.sh` accept explicit file arguments for this purpose, and
`run-e2e.sh` runs each E2E file against its slot's own server and pooler. The
unit, serial and slow lanes run with database URLs unset. The `pg-arms` lane
runs every file in `test/postgres-unit-arms.txt` the way persistence-validation's
`unit-postgres-arms` step does (`bun --no-env-file test --timeout=120000`,
`GBRAIN_TEST_ALLOW_DATABASE_URL=1`, no timeout multiplier) against the slot's
own empty `gbrain_arms_test` database. The summary sums its measured durations over
that job's `ARM_SHARDS` partition (14 shards), and a shard over the step's 20-minute timeout
fails the run, since GitHub would cut that shard off mid-list. The committed
weights must also fit each shard twice over with a minute to spare
(`ARM_SHARD_BUDGET_MS`, 570 s), because a slow runner ran the files 1.3-2x
their mined weights. Tests run natively as
a non-root user on Ubuntu 24.04, the same OS as the CI runners, instead of as
root in the `oven/bun` container.

Weights come from, in order: `.context/ci-ubicloud/weights.json` (merged after
every run), the committed `scripts/ubicloud/weights.json` (refresh it with
`--record-weights` on a green full run), then the lane weight files mined from
GitHub CI. Unknown files get their lane's p75. Per-item logs, failure logs and
`summary.json` land in `.context/ci-ubicloud/<run>/`. The exit status is non-zero
when any item fails, an item never produces a result, or no VM becomes ready.
An item whose SSH batch dies without a result is retried once on any slot, and a
VM with three such infrastructure errors is retired.

The fleet is sized from the quota. Without `--vms`, the run reads
`ubi-runner.sh usage` and takes as many `standard-16` VMs as fit under 448 of
the project's 512 vCPUs, between the default of four (64 vCPUs) and the burst
maximum of ten (160 vCPUs), and never more than the work can use (each slot
needs at least two minutes of weighted work, so `--lanes gitleaks` gets one
VM). The decision is logged (`fleet: project VMs hold 192 vCPUs, ceiling 448:
10 VM(s) × 16 vCPUs (burst maximum 10)`). The 64 vCPUs above the ceiling are
headroom for the managed GitHub runners `usage` can't see. When usage can't
be read, or the project is busy, the run takes the default. Slots default to
one per two vCPUs (`--slots`); `--size` and `--location` pick the VM shape. In
a multi-lane wave, each lane runs `ci:ubicloud:diff` or its targeted suites,
and only the integrator runs the full gate. A VM that the quota refuses fails
to provision and the run continues on the VMs that did start, so a busy
project shrinks the fleet instead of failing. The runner prints the refusal
(needed, used and maximum vCPUs) with the project's VMs and vCPUs per owner;
used vCPUs beyond that table are other usage, such as managed GitHub runners. Slow-lane items run `test/export-scale.slow.test.ts`
at the pull-request scale (`GBRAIN_TEST_EXPORT_SCALE_PAGES=10001`). `--lanes` runs a
subset, `--keep` leaves the VMs up for debugging, and `--diff` follows
`ci:local:diff` (a doc-only diff runs the doc checks and gitleaks alone).

A full gate is about 16,000 seconds of test compute at 8 slots per VM, and
the heaviest-first queue keeps every slot busy almost to the end, so wall
time is setup plus compute divided by slots. No single file runs much past
three minutes: the former long poles are split into files of about two
minutes (`graduation-cli*`, `graduation-crash-*`, `graduation-clients*`,
`reconcile-crash-*.slow`, `write-attribution-timeline-10k-postgres`), and the
longest single test left is the 1k-page graduation round trip (about 150
seconds). More slots per VM do not help: on eight VMs, 12 slots raised
compute 27% (unit 27%, E2E 25%, serial 31%) and finished in 353 seconds
against 359 at 8 slots, and 16 slots raised it 52% and took 444 seconds.
Neither produced a failure, but the extra contention buys no wall time, so 8
slots (one per two vCPUs) stays the default and bursts add VMs instead.
