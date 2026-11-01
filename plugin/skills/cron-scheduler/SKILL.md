---
name: cron-scheduler
version: 1.0.0
description: |
  Schedule management with staggering, quiet hours, and wake-up override.
  Validates schedules, prevents collisions, and gates delivery during quiet hours.
triggers:
  - "schedule a job"
  - "cron"
  - "quiet hours"
  - "what jobs are running"
tools:
  - search
  - get_page
  - put_page
mutating: true
when_to_use: "Use when the user asks: \"schedule a job\", \"cron\", \"quiet hours\", \"what jobs are running\"."
---

# Cron Scheduler

> **Convention:** See `skills/conventions/test-before-bulk.md` — test every cron job on 3-5 items first.

## Contract

This skill guarantees:
- Schedule staggering: max 1 job per 5-minute slot, no collisions
- Quiet hours gating: timezone-aware, with user-awake override
- Thin job prompts: jobs say "Read skills/X/SKILL.md and run it" (no inline 3000-word prompts)
- Idempotency: jobs can run twice without duplicate side effects
- Results saved as reports: `reports/{job-name}/{YYYY-MM-DD-HHMM}.md`
- One entry point: every job, workspace script and hook calls gbrain through
  one wrapper that sets `GBRAIN_HOME` and keeps stderr and the exit code
  ([the wrapper](https://github.com/garrytan/gbrain/blob/master/docs/guides/cron-schedule.md#calling-gbrain-unattended))

## Phases

1. **Define job.** Name, schedule (cron expression), skill to run, timeout.
2. **Validate schedule.** Check no collision with existing jobs (5-minute offset rule).
   - Slots: :05, :10, :15, :20, :25, :30, :35, :40, :45, :50
   - If collision detected, suggest the next available slot
3. **Check quiet hours.** Default: 11 PM - 8 AM local time.
   - Override: user-awake flag (if user is active, quiet hours suspended)
   - During quiet hours: save output to held queue
   - Morning contact releases the backlog
4. **Register with host scheduler.** OpenClaw cron, Railway cron, crontab, or process manager. **Each registered entry should execute via Minions, not `agentTurn`.** See `skills/conventions/cron-via-minions.md` for the rewrite pattern (PGLite uses `--follow`, Postgres uses fire-and-forget + `--idempotency-key` on the cycle slot). GBrain's v0.11.0 migration auto-rewrites entries for built-in handlers; host-specific handlers need a code-level registration per `docs/guides/plugin-handlers.md`.
5. **Write thin prompt.** Job prompt is one line: "Read skills/{name}/SKILL.md and run it."
6. **Call gbrain through the wrapper.** Cron runs with another `HOME` and
   environment than your shell, so a bare `gbrain` (or `bun run src/cli.ts`)
   can find no database (every lookup silently empty) or act as a second host
   (`refresh_not_owner`). Register `gbrain-run <args>`, the wrapper in
   [cron-schedule.md](https://github.com/garrytan/gbrain/blob/master/docs/guides/cron-schedule.md#calling-gbrain-unattended):
   it sets `GBRAIN_HOME` (never `HOME`), loads the brain's env file and runs
   the installed binary. Log stderr to a file, check the exit code, keep hook
   output off stdout, and give each call a timeout of at least 10 s.
   The lines below write `gbrain-run`; doctor prints the bare command.
   `gbrain doctor --only cron_gbrain_home` warns about any crontab line or
   script that runs `src/cli.ts` directly or calls gbrain without the brain's
   `GBRAIN_HOME`.

## Idempotency Requirement

Every cron job MUST be idempotent:
- Running the same job twice produces the same result (no duplicate pages, no duplicate timeline entries)
- Use checkpoint state files to track progress and resume interrupted runs
- Check for existing output before creating new output

## Output Format

Job configuration saved. Report: "Job '{name}' scheduled at {cron expression}. Next run: {time}."

## Multi-source brains: use `sync --all`, not per-source entries

When the brain has 2+ active sources (anything `gbrain sources list` shows
with a non-null `local_path` that isn't archived), use one consolidated
cron line instead of N per-source entries.

**Preferred (multi-source)**:

```cron
*/5 * * * * gbrain-run sync --all --parallel 4 --workers 4 --skip-failed >> /tmp/gbrain-cron.log 2>&1
```

This replaces N per-source lines AND auto-picks-up future sources without
a crontab edit. Concurrency budget: `parallel × workers × 2 ≈ 32`
connections during the wave (each per-file worker opens its own
2-connection pool). Stay under your Postgres `max_connections` setting.

**Avoid (legacy)**: separate `gbrain sync --source default` and
`gbrain sync --source zion-brain` entries staggered by 5 minutes. They
require manual deconfliction every time a new source is added, and a
slow source can race a fast source on the legacy global `gbrain-sync`
lock (v0.40.3.0+ uses per-source `gbrain-sync:<sourceId>` locks but the
per-source cron pattern doesn't benefit from the parallelism that
`--all --parallel` actually delivers).

`gbrain doctor` surfaces the recommended line as a `sync_consolidation`
check whenever it detects 2+ active sources. Paste-ready from there.

### Managed brain

A managed brain refuses the line above: managed sync needs `--no-pull` and
rejects `--skip-failed` (`writer_coordinator_required`). Check the mode first:
`gbrain sources writer status --json` reports `"mode": "managed"` or
`"mode": "classic"`, and its `bindings` name each source's owner host.

On a managed brain, install this line instead, on the host that owns the
sources:

```cron
*/15 * * * * gbrain-run sources refresh <id> >> /tmp/gbrain-cron.log 2>&1; gbrain-run sync --all --no-pull --hard-deadline 13m >> /tmp/gbrain-cron.log 2>&1
```

- `gbrain sources refresh <id>` is the only way a managed checkout takes
  upstream commits (a fetch and `git merge --ff-only`, then a managed sync of
  the sources on that checkout). Add one refresh per checkout that tracks a
  remote, with its real source id; drop it for checkouts with no remote. The
  `;` is deliberate: the sync still runs when a refresh refuses.
- `refresh_diverged`: the checkout has commits its upstream lacks, so
  something commits outside gbrain (usually a script that writes files and
  runs `git commit` in the checkout). Fix that writer so it commits with
  `gbrain git commit-push -- <paths>`, then reconcile as the refusal says
  (`gbrain git commit-push --push-only --keep-checkout`, after the user
  agrees); never force the checkout
  ([scripts and the managed checkout](https://github.com/garrytan/gbrain/blob/master/docs/guides/shared-checkout-git.md#scripts-and-the-managed-checkout)).
- `--hard-deadline 13m` stays under the 15-minute interval. Managed sync takes
  no per-source lock, so a run that outlives the interval would overlap the
  next tick. A run stopped at its deadline ends `resumable` and the next tick
  continues it. Sources drain one at a time, so `--parallel` does not apply.
- `owner_unavailable` for a source: read its `detail`. `unbound_source` on a
  classic Postgres brain is normal and does not stop classic sync; keep the
  sync line. Any other detail means another host owns the source: install a
  per-source line on that host (`gbrain sync --source <id> --no-pull
  --hard-deadline 13m`, plus its refresh) instead of claiming it here.
- Failed files: after fixing the files and committing them, rerun the plain
  `gbrain sync --source <id> --no-pull …` with the failed run's options; the
  next sync retries what the last one recorded. Never add `--skip-failed`
  (`--retry-failed` is a deprecated alias of the plain sync on a managed
  brain).

`gbrain doctor` prints this managed line in `sync_consolidation` on a managed
brain with 2+ active sources.

## When it fails

Follow the [agent operator protocol](../conventions/agent-operator-protocol.md) for any gbrain error `code`, exit code, `[AGENT]` block or notice block. Specific to this skill:

- A scheduled `gbrain sync` hits `sync_in_progress` / `lock_busy`: an earlier tick still runs. Widen the interval or stagger the job; never add a second overlapping schedule.
- Doctor reports a stale source after the cron change: check `gbrain sources status <id>` for held items or errors before changing the schedule again.
- `checkpoint_validation_timeout` in a sync log: run the retry command the error prints; do not cancel the request.
- `writer_coordinator_required` from a scheduled sync: the brain is managed. Replace the line with the [managed brain](#managed-brain) recipe; never retry with `--skip-failed` or without `--no-pull`.
- `sync_in_progress` from `gbrain sources refresh`: a managed sync cursor is unfinished, and the refresh never waits on it. Run the `gbrain sync --source <id> --no-pull …` command the refusal prints; the next tick's refresh then runs.
- `worktree_refreshing` from a sync: a refresh is draining or merging that checkout. Leave it; the next tick syncs it.
- A job's lookups all come back empty, or its log shows `no_brain` or `GBRAIN_DB_ACCESS no_url`: the job runs without the brain's config. Call gbrain through the wrapper; an empty result from a job whose stderr went to `/dev/null` is not evidence of "no notes".
- `refresh_not_owner` from cron while the same refresh works by hand: the job resolves another gbrain home, so it is another host. The refusal names the identity file, `HOME` and `GBRAIN_HOME` it read; set the owner's `GBRAIN_HOME` in the wrapper. Never copy or delete a `host.json`.
- A `--json` caller fails to parse gbrain's output: something the wrapper runs prints to stdout. Send that hook's output to a log file.
- Calls time out in the job but finish by hand: a cold start takes seconds. Raise the timeout to at least 10 s in both the shell and the runtime that spawns it, and use the [warm CLI socket](https://github.com/garrytan/gbrain/blob/master/docs/guides/cli-socket.md).
- Exit 10 from a scheduled write: it was accepted and is still pending, not lost or "not found". Poll `gbrain write-request <request_id>` before retrying or reporting it.

## Anti-Patterns

- Scheduling jobs at the same minute (:00 for everything)
- Inline 3000-word prompts in cron jobs (use skill file references)
- Running cron jobs without testing on 3-5 items first
- Jobs that produce different output on re-run (not idempotent)
- Sending notifications during quiet hours (save to held queue instead)
- A bare `gbrain` or `bun run src/cli.ts` in a cron line, script or hook
  instead of the wrapper; a wrapper that sets `HOME` instead of `GBRAIN_HOME`
- `2>/dev/null` on a gbrain call, or ignoring its exit code
- A script that writes files and runs plain `git commit` in a managed checkout
  instead of `gbrain git commit-push -- <paths>`
- Printing `env` or a process environment into a log or transcript while
  debugging (it holds the database URL and keys)
- Separate per-source `gbrain sync --source <id>` cron entries when
  `gbrain sync --all --parallel N --workers N` would replace them with
  one line that auto-picks-up future sources.
