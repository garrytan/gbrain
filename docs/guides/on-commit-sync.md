# On-commit sync

A resident gbrain process can sync a source as soon as a commit lands in its
checkout, instead of waiting for the next scheduled sync. Watching commits is
off by default; turn it on with:

```bash
gbrain config set sync.on_commit true
```

Residents read the flag every 30 seconds, so no restart is needed in either
direction. Requests you make explicitly (gbrain sync trigger, a GitHub push
webhook, a delegated sync that found another sync running) are recorded and
synced whether or not the flag is on.

## Residents

Four processes are residents: gbrain serve, gbrain serve --http, gbrain jobs
work and the autopilot daemon. Each one starts the commit notifier; one of them
owns it per host (a lease in the database on Postgres; on PGLite the process
that holds the brain owns it). The others forward what they see to the owner.
When the owner stops cleanly the next resident takes over at its next heartbeat
(10 s, GBRAIN_NOTIFIER_HEARTBEAT_MS); when it dies without releasing, the next
resident takes over once its lease (two heartbeats) has expired.

A resident never waits for the notifier when it starts: the first pass runs in
the background, so an MCP handshake or a worker's first job is not delayed by
git or a catch-up sync. Commits made while no resident ran are synced by that
first pass.

The notifier watches:

- every managed source whose worktree this host owns;
- every classic source last synced on this host (recorded when a sync advances
  its last_commit), or bound to this host with
  GBRAIN_NOTIFIER_CLASSIC_SOURCES=<id>,<id>. A classic source last synced on
  another host is skipped with that reason; that host's resident syncs it.

It never pulls: it syncs the commit your checkout already has.

## Detection and expected latency

The notifier resolves each checkout's git directories (linked worktrees
included), watches them, and reads HEAD with git rev-parse every 3 seconds
(GBRAIN_NOTIFIER_POLL_MS, alias GBRAIN_SERVE_HEAD_POLL_MS). The poll is the
source of truth; the watch only brings the next read forward. When a watch
cannot be set up the source falls back to poll mode, and
GBRAIN_NOTIFIER_DETECTION=poll forces it. sync status and search results name
the mode.

A moved HEAD starts a sync at once when the checkout is quiet (no rebase, merge
or cherry-pick in progress and no index.lock); commits that keep arriving during
a run get one more sync after a 400 ms quiet window (GBRAIN_NOTIFIER_QUIET_MS,
alias GBRAIN_SERVE_HEAD_DEBOUNCE_MS, which used to be a fixed 3 s debounce).

For a small page, expect a commit to be searchable within a few seconds in
watch mode, and within the 3 s poll plus the sync in poll mode.

A sync that is already running, here or in another process, is never doubled:
the commit waits and gets one more sync when that one ends. A start that fails,
is refused, or ends with an error stays due and is retried after 5 s, 15 s,
1 min and then every 5 min; a run that stops resumable is resumed for as long as
it makes progress. Nothing is written into the checkout or .git, and an idle
poll costs one git call per checkout.

The managed sync writes queue an embedding publication effect, so a small page
is embedded about a second after it is searchable, under the same consent and
spend gates as any managed write. A sync run with --no-embed, or one whose cost
gate deferred embedding, queues no such effect.

## Requests that are never dropped

Every request to sync a source is recorded as a wanted marker (one per source
and intent: freshness, pull or full) before anything runs. Whoever syncs the
source re-checks the markers when it finishes and clears only the ones it
satisfied and nobody re-recorded meanwhile; anything left gets one more run.
Residents also scan the markers every 15 seconds, so a request that lands while
a sync is finishing is still served.

- gbrain sync trigger --source <id> [--json] records the request and answers
  queued (a job was queued; stdout keeps job_id=N), coalesced (a job for the
  source is already waiting or running), nudged (a running gbrain serve on
  PGLite took it and its notifier starts the sync); exit 0. When no resident
  watches the source the answer also carries resident: null and the notice
  no_resident with its fix.
- A GitHub push for a classic source queues one sync per source; a second push
  while that job waits joins it and the newer commit is kept.
- gbrain sync while a serve on the same PGLite brain is already syncing records
  the request with that serve instead of failing (except --dry-run, which stays
  read-only).

## Kill switches and knobs

| Setting | Effect |
|---|---|
| sync.on_commit (config, default false) | Watch commits on this brain's sources |
| sync.on_commit.sources (config) | Comma-separated source ids never watched for commits |
| GBRAIN_NOTIFIER=0 | No notifier in this process |
| GBRAIN_NOTIFIER_DETECTION=poll | Never use file watches |
| GBRAIN_NOTIFIER_POLL_MS | HEAD poll interval (default 3000) |
| GBRAIN_NOTIFIER_QUIET_MS | Trailing quiet window (default 400) |
| GBRAIN_NOTIFIER_HEARTBEAT_MS | Lease heartbeat (default 10000) |
| GBRAIN_NOTIFIER_CLASSIC_SOURCES | Classic source ids this host syncs without a recorded run |

## Autopilot and the jobs worker

The autopilot daemon reads every checkout's HEAD at each tick and queues a
sync when it differs from the commit the source last synced, once per HEAD,
never in the middle of a rebase or merge; a source whose last sync is older
than `--interval` is still synced as a backstop. With `sync.on_commit` on, the
daemon also reads HEADs between ticks (every 3 s, git only;
`GBRAIN_AUTOPILOT_HEAD_PROBE_MS`, 1 to 30 s), so a commit is queued within
seconds instead of at the next tick (150 to 600 s).

A `gbrain jobs work` worker picks up a queued sync job at once: it LISTENs for
queued sync jobs when its database URL is a direct session, and reads the sync
queue every second (`GBRAIN_WORKER_SYNC_WAKE_POLL_MS`, 250 ms to 5 s) behind a
transaction pooler (port 6543 or `?prepare=false`), where LISTEN does not
work. Its startup line names the mode (`sync-queue wake: listen (direct_session)`
or `sync-queue wake: poll every 1000 ms (transaction_pooler)`);
`GBRAIN_WORKER_SYNC_WAKE=0` turns the wake off and leaves the 5 s idle poll.

On Postgres an idle worker also starts its persistence consumer at boot (#7002).
With `persistence.single_consumer` off, a worker beside a `serve` runs its own
full consumer, as every resident process does, and doctor lists the pair as
`two_consumers_on_host`.

`gbrain autopilot --status` grades the daemon from its own next tick, written
to `autopilot.heartbeat.json` beside the lock (#7003); `--status --json`
names the source of the threshold in `stale_after_source` (`daemon`, or `flag`
when the sidecar is missing or from an older daemon, which falls back to
6 x `--interval`).

## Check it

```bash
gbrain config get sync.on_commit
gbrain sync status --source <id> --json
gbrain sync trigger --source <id> --json
gbrain doctor --only commit_notifier --json
```

sync status prints a `notifier for <id>:` line (the `notifier` object in
`--json`): the resident that syncs the source and its detection mode, or none
running with the fix, plus the notifier state, retry schedule and pending
requests. Doctor `commit_notifier` reads the same record: with sync.on_commit on
it warns for a source no resident watches or a stalled notifier, and with it off
it warns only when a recorded request waits with no resident.

Once sync.on_commit is on, or a resident has observed a source, search and
query responses carry a freshness entry per source (current, behind,
syncing, unknown or not_monitored, with the observed HEAD, when it was observed,
the detection mode and the held-file count). not_monitored means no resident is
watching the source: nothing will sync a new commit until one starts.

<a id="no-resident"></a>
## no_resident

A notice, not an error: gbrain sync trigger recorded the request (and queued a
job, or the serve took it) and exits 0, but no resident watches the source, so
the recorded request waits. Run gbrain sync --source <id> --no-pull now, or
start gbrain serve (or gbrain jobs work, or the autopilot daemon); the first
resident that starts drains the recorded request. No service is installed for
you.

<a id="notifier-stalled"></a>
## notifier_stalled

The notifier kept retrying a source for more than five minutes without progress.
sync status names the last error and the trace file
(<gbrain home>/notifier/<source>.jsonl, local callers only). Run
gbrain sync --source <id> --no-pull to see the error in the foreground, fix it,
and the notifier resumes on its next retry.

A run that committed pages counts as progress even before the source's last
synced commit moves. When the last error is drain_holder_stalled, another
process holds the source's drain lease and has made no commit or cursor save
for five minutes; the notifier does not wait on it silently. sync status names
the holder: stop it if it is wedged, then run the foreground sync, which follows
the holder and takes the source over when its lease lapses.

<a id="refresh-required"></a>
## refresh_required

A GitHub push arrived for a managed source. A managed source never pulls, so the
push's commit is recorded as wanted and the webhook answers 409 refresh_required
instead of queueing a sync that cannot import it. Run
gbrain sources refresh <id> on the brain host; the resident notifier then syncs
the refreshed checkout.

## Freshness numbers

Each managed source's freshness over the last 24 hours shows in gbrain sync
status --source <id> (the freshness block in --json) and in gbrain status: p50
and p95 of commit to searchable (from the commit's committer time to the page
write's completed_at) and commit to embedded. A first sync and working-tree
entries are not counted, and a run that spans several commits is dated by its
newest. Doctor managed_sync_latency warns when p95 commit to searchable is over
sync.freshness_target_seconds (default 300) and fails over one hour; it grades
only a brain with sync.on_commit on or a target set, and otherwise reports the
numbers. gbrain doctor --source <id> grades only that source.

The check also grades the commit that is still waiting, so a stalled source
does not read ok for lack of samples. A source is behind when its checkout
HEAD differs from the last synced commit (an uncommitted edit does not count).
The wait runs from the reflog entry that moved HEAD (when the commit landed in
the checkout), or from the commit notifier's recorded first_due_at when there
is no usable reflog, and is graded with the same target and one-hour limit.
When neither can date it (no reflog, or history rewritten so the synced commit
is no longer an ancestor of HEAD), the wait reads unknown and warns. Classic
sources are graded the same way. Each source reports keyword-visible and
embedded freshness separately (details.freshness_by_source in --json); the
embedding backlog is reported, not graded, and reads disabled on a keyless
brain. gbrain sources status dates a source's lag the same way. A stopped run
is reported by doctor managed_sync_blocked and managed_sync_not_moving.

The rest of managed sync (backlogs, holds, the drain) is in
[live sync](live-sync.md).
