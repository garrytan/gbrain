# The monthly backup-coverage check

gbrain checks local backup configuration on an interval and uses bounded remote
readback to verify committed repository HEADs. It warns through the harness you
use when recovery evidence is missing. This is a point-in-time Git check, not
proof that a whole brain could be restored.

## What is covered

| Asset | How it's checked | Warn condition |
|---|---|---|
| Source repos (every non-archived source with a `local_path`) | Local Git discovery, deduped by root and capped at 500 roots/run; trusted local read-only `git ls-remote` verifies clean HEAD against the remote | No configured origin, dirty/unpushed work, missing/mismatched remote HEAD, stale/unknown evidence, or failed push without newer matching readback cannot count as verified recovery. |
| Bootstrap workspace (skills/, memory/, brain/, identity) | file plane: the install receipt's `repo_url` + the per-root push-status files | receipt without `repo_url` → warn; a failing background push → flagged row only (the push-failure banner owns that alarm) |
| DB-only brain (pages exist, nothing git-backed) | page count + absence of any git-backed asset | warn on PGLite (local disk loss risks these pages); info on Postgres (database placement and external backup are unverified) |
| `db_only` storage-tier pages | `gbrain.yml` per source | info row — dump with `gbrain export --dir <backup-dir>` to somewhere OUTSIDE the gitignored dirs (`--restore-only` is the wrong direction for a backup) |
| Harness-native skill dirs (e.g. the agent's installed skills) | skillpack bridge state | info only — these are installed COPIES; the originals live in repos |

`configured_repos` records configuration; the legacy `recoverable_repos` field
counts only clean HEADs with fresh matching remote readback. A newer matching
readback can supersede a recorded push failure without erasing that history.
An offline, unavailable, mismatched or not-yet-probed remote is **unknown**, not
green. Git evidence covers committed files only: DB-only pages, facts,
configuration and credentials need a separate backup and restore drill. Managed
Postgres placement alone is not proof of a remote database backup.

**Not covered by Git evidence:** the DB file itself (`~/.gbrain` is
deliberately gitignored — only Git-backed content rebuilds via `gbrain sync`);
mounted brains (the verdict cache is host-brain-scoped —
computes against a mounted brain are never persisted); pure-HTTP thin-client
installs (no local CLI on the brain host — nothing there can probe git);
proof that a remote can accept a future push; DB pages that belong to no source on an
install that HAS a workspace repo (whether the workspace write-through covers
them is not verified — the `undeclared_db_only_pages` doctor check is the
page-level audit). The OpenClaw context line is bounded per process (once per
24h); an install that restarts its serve constantly and never fires any
recording channel can see it more often than the recorded-notice cap.

## Where the warning reaches you

One compute, one cached verdict (`~/.gbrain/backup-status.json`), five render
channels — all bounded by the shared nag budget:

1. **Claude Code banner** (`gbrain hook user-prompt` → `systemMessage`, shown
   directly to you; a pending push-failure banner outranks it).
2. **Claude Code session-start digest** (model-visible note).
3. **MCP tool responses** (one aggregate extra content block per stdio serve
   process — counts only, never paths; reaches Codex, OpenClaw, and
   plugin-only installs, which all register stdio serves). HTTP serves attach
   no notice: a remote thin client's token scope doesn't grant the host's
   backup posture, and a remote-triggered display must not spend the local
   notice budget.
4. **CLI stderr** on most `gbrain <cmd>` invocations (serve/hook/jobs/call,
   the upgrade surfaces (`upgrade`/`post-upgrade`/`check-update`/`self-upgrade`),
   and the check's own surfaces are excluded; `--quiet` and
   `GBRAIN_SKIP_STARTUP_HOOKS` silence it). The machine marker
   `BACKUP_LOCAL_ONLY <n>` prints on non-TTY stderr for agents, plus a one-line
   human sentence.
5. **OpenClaw context engine** (one ⚠ line, read-only against the budget).

Two more surfaces spend the same budget without being passive nags: `gbrain
backup status` records an impression when it prints a warn verdict (you just
saw the full table — the passive channels go quiet for 24h), and the advisor
collector records one when it emits backup findings.

Nag budget: at most one impression per 24h across channels, at most 3 per
channel per month **per verdict** (a changed verdict — a repo fixed or a new
one gone local-only — re-arms the per-channel count mid-month), at most 3
recorded impressions per month TOTAL. Fixing the repo (or a new month) re-arms
it; ignoring it goes quiet until next month.

## Commands

```
gbrain backup status [--json]   # verdict + per-asset table + recovery scope; may reuse a recent warning
gbrain backup check  [--json]   # force the next bounded readback sweep
```

For the **local host PGLite installation**, use a separate full archive when
you need DB-only pages, facts and installer-managed state, not merely Git
coverage. Quiesce file writers, choose a private durable destination outside
the source tree and get the owner's consent before copying this sensitive
archive off-machine. Restore only into a **new, absent** root on a scratch
installation; reconnect excluded credentials/services and verify saved memory
before treating it as recovery evidence:

```bash
gbrain backup create --output /absolute/private/archive.gbrain-backup
gbrain backup restore /absolute/private/archive.gbrain-backup --into /absolute/new-root
```

The restore quarantines unfinished jobs and does not start automation. It
does not overwrite an existing root. This local archive path is not a hosted
Postgres backup procedure; arrange and test a separate Postgres backup there.

Exit codes: 0 ok / 1 warn / 2 usage error. Two forced-0 paths: the global
`--quiet` flag (the detached-spawn mode) always exits 0, and a disabled check
(`backup.check_enabled=false` / `GBRAIN_BACKUP_CHECK=0`) exits 0 even on a
cached warn — automation reading exit codes sees the off switch as all-clear,
never a stale failure. `status` answers from the cache when it's ok,
recomputes when stale, but may reuse a recent warning. Missing or locked-engine
evidence never becomes an enabled CLI all-clear. Failed refreshes leave the
durable cache untouched and return a degraded non-green view. The `--json`
payload includes `configured_repos`, per-asset `configured_remote` and
`verification`, `remote_check_at`, and a bounded `recovery_scope`.

Trusted local, non-quiet backup CLI and doctor may perform read-only remote
probes: at most eight refs per sweep, within a shared eight-second probe budget
and two-second subprocess timeouts, without prompts, pushes or fetches. Pending
and oldest evidence is rotated first rather than probing the same roots each
time. Evidence expires after one hour even if the configured coverage interval
is longer. Reuse retains its original timestamp and requires unchanged source
identity, physical Git directory, HEAD, branch, origin, push-status identity and
a clean tree. Roots beyond the budget report `budget_exhausted`; successive
sweeps can cover them. Background and stdio refreshes use local probes only;
remote MCP doctor reads aggregate cache only, with no engine or Git access.

When does the compute actually run? On any of: `gbrain backup check`, a stale
cache at `backup status`/doctor/advisor time, `gbrain sync` completion, the
serve process (stdio only) when the cache is stale or a warn verdict is >24h
old, and a detached spawn from the session-end hook. Automatic triggers
self-throttle to once per `backup.check_interval_days`. The monthly recompute
can add a few seconds to one local advisor/doctor run (the 500-root probe cap
bounds it).

## Config + kill switches

```
gbrain config set backup.check_enabled false        # off (file plane)
gbrain config set backup.check_interval_days 30     # default 30; set rejects values < 1
GBRAIN_BACKUP_CHECK=0                               # env kill switch (everything)
GBRAIN_BACKUP_CHECK_DAYS=<n>                        # env interval override (wins over config)
```

Interval values below 1 or non-numeric (env or a hand-edited config file) fall
back to the 30-day default — `DAYS=0` never means "recompute every dispatch".
Disabling silences compute AND every render channel, including a stale warn
cache, and forces `backup status` to exit 0. `GBRAIN_HOOKS=0` already silences the hook channels;
`GBRAIN_SKIP_STARTUP_HOOKS` silences the CLI rail.

## State files (machine-owned, under `~/.gbrain/`)

- `backup-status.json` — the cached verdict. Written only by a successful
  probed compute; deleted automatically when a fix lands (`bootstrap repo`,
  `sources harden`, `sources push` success). A compute that couldn't read the
  brain database returns a `degraded: true` verdict (shown as "verdict is
  partial (not cached)" in `backup status`, and as a `degraded` field in
  `--json`) — it is never persisted and never replaces a probed cache. Old,
  future-dated or inconsistent remote evidence cannot produce verified counts.
- `backup-nag-state.json` — the bounded-nag ledger (per-channel counts, the
  24h dampener, the monthly global cap, the spawn debounce).

Both are fail-open: corrupt or missing files never break a session.

## Privacy

Remote/MCP surfaces render **aggregate counts only** — never a local path or
source id. Full per-asset detail (which repo, which fix) is local-only:
`gbrain backup status` on the brain host.

## Fix recipes

- Workspace with no repo: `gbrain bootstrap repo` (creates a private repo,
  verifies privacy, pushes).
- A source repo with no remote:
  `git remote add origin git@github.com:you/your-brain-repo.git && git push -u origin main`,
  then `gbrain sources harden <source-id>` for auto-push durability.
- Unpushed workspace work: `gbrain sources push --path <workspace>`.
- db_only pages: `gbrain export --dir <backup-dir>` (store the dump outside
  the gitignored dirs — another disk, another repo, anywhere durable).

## Recovery drill (prove the answer is real)

An unverified recovery path is as fake as an unverified backup. Once a
quarter, on a scratch machine or empty directory:

1. `git clone git@github.com:you/your-brain-repo.git && cd your-brain-repo`
2. `gbrain bootstrap attach` — the body travels; identity, memory, and skills
   come back from the repo.
3. Re-add any extra sources: `gbrain sources add <id> --path ../your-wiki`
   (or `--url` for managed clones).
4. `gbrain sync && gbrain embed` — the brain database rebuilds from the repos.
5. `gbrain doctor` — inspect findings; a green Git check alone does not prove
   database facts, configuration or credentials were restored. Test those from
   a separate backup on an isolated destination.

Windows directory-descriptor fsync portability is covered by Linux fault
injection and restore drills, not a native Windows full backup/restore test. A
separate Windows PGLite `dumpDataDir` failure remains unresolved; do not infer
full Windows restore support from the Git check.

If a drill fails, fix the gap while the original disk still works. This check
does not itself certify the database or full agent recovery.
