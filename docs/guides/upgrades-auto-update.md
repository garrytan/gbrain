# Upgrades and Auto-Update Notifications

## Goal

Users get notified of new GBrain features conversationally, and the agent walks them through upgrading with post-upgrade migrations that make the new version actually work.

## What the User Gets

Without this: GBrain ships updates but nobody knows. The user stays on an old
version with stale skills and missing features. Or worse, someone runs
`gbrain upgrade` but skips the post-upgrade steps, leaving new code with old
agent behavior.

With this: the agent checks for updates daily, sells the upgrade with punchy
benefit-focused bullets, waits for explicit permission, then runs the full
upgrade flow including re-reading skills, running migrations, and syncing
schema. The user gets new capabilities automatically.

## Self-upgrade modes

gbrain stays current the way gstack does: it rides invocation frequency. A
throttled, cache-read-only check runs at the start of every `gbrain` invocation
(CLI and MCP) and emits an `UPGRADE_AVAILABLE <old> <new>` marker on stderr,
once per 30 minutes per version under one GBRAIN_HOME (a newer version shows at
once). It is one line: when stderr is an interactive TTY a human sees only the
plain `gbrain X -> Y available` sentence instead of the machine token; set
`GBRAIN_FORCE_UPGRADE_MARKER=1` if an agent harness parses the token but runs
under a PTY. `<old>` is always the RUNNING binary's version, so a stale or
foreign-written cache never nags about an upgrade this binary already has. No
host cron required — every agent kind (Claude Code, Codex, OpenClaw, Hermes, the
`gbrain serve` host behind a Perplexity thin client) converges to current by
construction. The behavior is governed by one file-plane config key,
`self_upgrade.mode`:

| Mode | Behavior | Who it's for |
|------|----------|--------------|
| `notify` (default) | Emit the marker + a 4-option prompt; never apply without confirmation. | Interactive installs / anyone with a human in the loop. |
| `auto` (opt-in) | Apply silently, but ONLY during quiet hours, ONLY when the brain is idle, doctor-gated, never re-trying a known-bad version, and never installing a release the host's Bun cannot start ([Bun floor](#bun-floor)). | Headless / always-on installs (autopilot daemon, the `gbrain serve` host). |
| `off` | Never check. | Air-gapped / pinned installs. |

Enable hands-off upgrades on an always-on install with one line:

```bash
gbrain config set self_upgrade.mode auto
```

`auto` is deliberately NOT a default anywhere — it's an explicit autonomy grant,
because applying code from GitHub unattended is, by design, remote code
execution. The trust model is TLS + GitHub (same as `gbrain upgrade`);
signature verification is a tracked follow-up. Apply manually any time with
`gbrain self-upgrade`.

The `auto` quiet-hours window is configured via the
`self_upgrade.quiet_hours` config key
(`gbrain config set self_upgrade.quiet_hours '{"start":23,"end":8,"tz":"US/Pacific"}'`).
The quiet-hours *pattern* itself — gating any notification or background
action on the user's local sleep window — is owned by
[quiet-hours.md](quiet-hours.md); this doc only covers the self-upgrade
hook into it.

### Bun floor

**Say to your agent:** *"gbrain says the upgrade needs a newer Bun. Upgrade Bun
and finish the gbrain upgrade."* The agent runs `bun upgrade`, then
`gbrain upgrade`, then `gbrain doctor` to confirm `self_upgrade_health` is ok.

A source (bun-link) or package install runs the new release on the host's
Bun, and a release refuses to start on a Bun below its `engines.bun` floor.
So before swapping, `gbrain upgrade`, `gbrain self-upgrade` and the autopilot
channel read the target's floor and compare it with the lower of the `bun` on
PATH and the Bun the running process uses:

- **bun-link clone:** `git fetch`, then `package.json` at the fetched upstream
  commit; the swap fast-forwards to exactly that commit
  (`git merge --ff-only <sha>`), so a floor raised upstream after the check is
  not installed unchecked.
- **global package (`bun`) and ClawHub:** `package.json` at the ref the
  install's `github:` spec names (the default branch when unpinned) on
  raw.githubusercontent.com.
- **compiled binary:** exempt; it carries its own Bun.

When the floor is above the host's Bun, a manual upgrade refuses and changes
nothing (exit 78):

```
gbrain <target> requires Bun >=<floor>; bun on PATH (<path>) is <found>. Fix: bun upgrade, then gbrain upgrade. Docs: docs/guides/upgrades-auto-update.md#bun-floor
```

Run `bun upgrade`, then `gbrain upgrade` again. When the floor cannot be read
(offline, no upstream branch, or a floor not of the form `>=X.Y.Z`), the
refusal names the read that failed; after checking the target yourself,
`gbrain upgrade --no-bun-floor-check` (or `gbrain self-upgrade
--no-bun-floor-check`) upgrades without the check. The override is for manual
upgrades only; autopilot never passes it.

The autopilot channel holds instead of refusing: the tick records an
`unsupported_runtime` audit row, `gbrain doctor` reports
`Auto-upgrade to <target> held: …` under `self_upgrade_health` with the same
fix line, and the target is not marked known-bad, so the first quiet-hours
tick after `bun upgrade` applies it (an unreadable floor is retried on the
next tick). A swap that `gbrain upgrade` itself refuses for the floor (for
example, upstream raised it after the channel's check) is a hold too.

After the swap, `gbrain upgrade` runs `gbrain --help` (a command that passes
the startup Bun check, unlike `--version`). If the new release does not
start, the upgrade exits non-zero and prints recovery: `bun upgrade`, then
`gbrain post-upgrade`; or return to the previous release with
`git -C <clone> checkout <previous sha> && bun install` (bun-link) or
`git ls-remote --exit-code --tags https://github.com/garrytan/gbrain refs/tags/v<previous> && bun remove -g gbrain && bun add -g github:garrytan/gbrain#v<previous>` (package; an in-place tag swap fails or silently corrupts the global lock on current Bun, #5034). Nothing is
rolled back automatically, and the autopilot channel records that version as
failed.

Tag- or commit-pinned package installs (`github:garrytan/gbrain#v<x>`, `#<sha>`)
stay pinned through `bun update`, so `gbrain upgrade` replaces them itself when a
newer release tag is published (`bun remove -g gbrain`, then `bun add -g` the tag,
restoring the previous release if the add fails), and otherwise prints a
reinstall. Every printed
reinstall checks that the release tag exists before `bun remove -g gbrain`
runs, and ends with the line that restores the previous version if the add
fails. The target is the newest published release tag: master's `VERSION` is
stamped before the release checks pass and the tag is created, so a version
can be announced before its tag exists. When the requested version's tag is
missing, upgrade says `v<x> is not published yet`, removes nothing, and offers
the newest published release if it is newer than yours (#6662). Windows
PowerShell 5.1 has no `&&`, so on Windows the steps print one per line; run
them in order and stop if the tag check fails.

<a id="release-channel"></a>
### Which version counts as available

Every update surface (the startup marker, `gbrain check-update`,
`gbrain self-upgrade`, doctor's `self_upgrade_health` and the `auto` channel)
reads the `VERSION` file at the `latest-stable` tag: the release the canonical
install (`github:garrytan/gbrain#latest-stable`) gets from `bun update`, moved
only after the release checks pass and the assets publish. Master's `VERSION`
is never offered: the next PR stamps it before release.yml tags it, and a
superseded version never gets a tag (#6718, #6828).

<a id="stable-channel"></a>
**The stable channel.** A large or production brain can follow a slower line:
the newest release a maintainer promoted after the production-shaped soak
passed on that release's exact git tree. Promotion is weekly or manual, through
the maintainer-only `Promote stable` workflow
([RELEASING.md](../RELEASING.md#stable-channel-promotion)), which moves the
`stable` tag to the release commit and records the soak scoreboard link in the
tag message (`git show stable`).

```bash
gbrain upgrade --channel stable                 # one run on the stable channel
gbrain config set self_upgrade.channel stable   # make stable the default for this brain home
gbrain config set self_upgrade.channel latest   # back to every published release
```

With `self_upgrade.channel stable`, every update surface above reads `VERSION`
at the `stable` tag instead of `latest-stable`, so the marker, `check-update`,
`self-upgrade` and the `auto` channel only ever offer the stable release.
`gbrain upgrade` resolves it from `git ls-remote` (the `v<version>` tag on the
commit `stable` peels to) and installs exactly that release: a bun install is
reinstalled pinned to `#v<version>` (remove, then add; it restores the
previous release if the add fails), a bun-link clone fast-forwards to the
release commit (never backward or across a fork), and the binary install
downloads that release's asset. A build already at or above the stable release
changes nothing: the stable channel never downgrades. A ClawHub install follows
ClawHub's own line and is refused with the reinstall command. When no release
has been promoted yet, or the remote cannot be read, the upgrade stops with
`stable_channel_unresolved` and changes nothing.

A swap is a swap only when the version changed. When `gbrain upgrade` finds
the same version running after the install step (`bun update` on a tag whose
head is already installed), it prints `No newer version was installed`, keeps
`last_upgrade`, writes no `JUST_UPGRADED` breadcrumb and keeps the pending
marker. The `auto` channel then stays up instead of exiting for a relaunch,
clears its breadcrumb, records no known-bad version, audits the attempt as
`skipped` (`nothing newer was installed`) and tries again after 24 hours
(`self_upgrade.last_check_ts`). The channel confirms a swap from a receipt
`gbrain upgrade` writes, or from `gbrain --version` when there is none; a
swap that exits 0 with no newer version confirmed is held the same way, never
relaunched. It also checks the version the install would actually get (a
bun-link clone follows master, a moving tag can pass the checked version)
against the known-bad list before swapping. A version is recorded known-bad only when it
was installed and then failed (the post-swap `gbrain --help` smoke, or a
relaunch that did not come up on it), under the version actually installed.

<a id="known-bad-never-installed"></a>
### A known-bad version that was never installed

Releases before this fix could record a version known-bad that was never
installed: the swap installed nothing, reported `swapped`, the supervisor
relaunched the same version, and the relaunch recorded the attempted version
in `self_upgrade.failed_versions`, so `auto` skipped that release forever.
doctor's `self_upgrade_health` warns about each such entry and names the
preview as its fix:

```bash
gbrain self-upgrade --clear-never-installed            # preview: lists each entry and the swap that recorded it; writes nothing
gbrain self-upgrade --clear-never-installed --apply    # removes exactly the listed entries
gbrain doctor --only self_upgrade_health --json        # verify
```

An entry is listed only when it is proven never installed. The audit rows
alone are not proof, because a release that installed, crashed before its
first boot finished, and was rolled back by hand leaves the same rows. The proof
is the record the no-op swap wrote itself: `last_upgrade` in
`upgrade-state.json` with the same version as `from` and `to`, timestamped
inside that entry's swap (between its apply row and its `swapped` row), plus
exactly one recorded failure for the entry, a `crash-on-launch` row on the
version that ran the swap, and no audit row that ever ran the entry's version.
Each swap overwrites `last_upgrade`, so only the most recent no-op can be
proven; an older entry stays listed as kept, and you clear it by hand as below
once you have confirmed it. Anything else stays known-bad. Nothing is rewritten during an
upgrade. `gbrain config set self_upgrade.failed_versions '["<version>"]'` puts
an entry back. On a release that does not have this command, read the list
with `gbrain config get self_upgrade.failed_versions`, confirm the entry was
never installed (no `v<version>` tag existed when it was recorded, or the
audit shows the `swapped` row and the relaunch on the same version), then set
the list without it.

Recovery when autopilot is holding an upgrade:

```bash
gbrain doctor                 # self_upgrade_health: Auto-upgrade to <target> held: ...
bun upgrade                   # raise the host's Bun to the floor or above
gbrain upgrade                # apply now instead of waiting for quiet hours
gbrain doctor                 # self_upgrade_health ok
```

Restart `gbrain serve` and autopilot afterwards if a service manager does not
restart them for you, so they run on the new Bun. Hosts still running a
release from before this check do not run it, so a Bun floor raise reaches
them only after they have upgraded past this release.

<a id="restart"></a>
### Restart: one build on the host

A long-running gbrain process keeps the code it started with, so an upgrade
that restarts nothing leaves serve, the jobs supervisor and its worker,
autopilot and every MCP server on the old build while one-shot commands and job
children run the new one. `gbrain upgrade` therefore restarts every gbrain
process this brain runs on the host, or refuses before it installs anything:

1. **Before the swap** it lists the processes (`ps`, on Linux only processes
   whose `GBRAIN_HOME` is this brain's, with the build each one loaded from
   the consumer heartbeat rows on Postgres, the supervisor PID file and the
   worker registry; a record whose pid `ps` does not show as gbrain is stale
   and ignored) and checks that each one can be restarted: serve and autopilot
   through their installed services when the service's own process runs them,
   a process that starts from a separate Bun global copy (for example one the
   serve service points at, pinned to a commit) has that copy replaced first
   (`bun remove -g` then `bun add -g` the release tag under its `BUN_INSTALL`),
   and one that starts from another kind of install refuses with its commands;
   the supervisor with `gbrain jobs supervisor stop` then `start --detach` with
   the queue, concurrency and PID file it was launched with (its worker, under
   tini or not, restarts with it). A serve or worker started by hand, an
   autopilot without its service, a running `gbrain sync`, or an MCP server an agent
   harness started refuses the upgrade with `restart_refused` (exit 3), naming
   the exact step for each process; nothing is installed. For MCP servers the
   fix asks the user, then reruns with `--stop-mcp`: the upgrade stops them
   (each pid only while `ps` still shows the same MCP server) and
   each harness starts the new build when gbrain is reconnected (Claude Code:
   `/mcp`, then reconnect; other harnesses: a new session).
2. **After the swap and migrations** the new build runs
   `gbrain upgrade --restart-only`: serve first, then autopilot, then the
   supervisor, then the MCP servers `--stop-mcp` named. It then polls for up to
   three minutes until no old pid is alive, every process reports the installed
   build (a process that records no build must have started after the restart
   from an install that holds it; a compiled binary's build is inferred from
   its start time and listed as such), each restarted role and the supervisor's
   worker came back, and, when serve had a warm CLI socket, the
   socket accepts this build (a handshake-only probe). Anything short of that is
   `restart_unverified` with the processes still on another build.

```bash
gbrain upgrade --restart-only --dry-run --json   # read-only: every gbrain process, its build and how it restarts
gbrain upgrade --restart-only                    # restart onto the installed build and verify (doctor's runtime_build_skew fix)
gbrain upgrade --no-restart                      # install only; doctor fails runtime_build_skew until the restart runs
```

On an always-on host, start with `gbrain autopilot pause --reason "upgrade"`
and wait until `gbrain jobs list --status active --json` returns no jobs, so no
job runs half on each build; resume with `gbrain autopilot resume` once the
checks below pass ([the order](../../skills/gbrain-upgrade/SKILL.md#always-on-hosts-pause-drain-upgrade-verify-resume)).

The autopilot `--swap-only` channel exits for its own supervisor to relaunch.
Once the relaunched autopilot runs the new build, it checks the serve that the
installed serve service runs (`com.gbrain.serve` under launchd,
`gbrain-serve.service` under systemd). If that serve is on an older build, the
autopilot restarts it through the service and verifies that it came back on
the new build. It does this once per autopilot process, under the swap's own
auto-mode, quiet-hours and idle gates, and records it in the self-upgrade
audit as `restart_serve` (`applied`, or `skipped` with `manual` or
`unverified`). It leaves alone a serve that the service does not run (one
started by hand or from another install), the jobs supervisor and MCP
servers. For those, doctor's `runtime_build_skew` fails while two builds run,
and `gbrain upgrade --restart-only` is its fix.

<a id="restart-and-verify"></a>
### Restart and verify: a deploy ends with data movement

An upgrade is not finished when the new version starts: a managed brain whose
processes stay alive while no page commits reads healthy on `/health`, on the
pid and on `sync_running: true`. Both `upgrade` and `post-upgrade` end by
printing the supervisor's step, bare, so it inherits the default window:

```bash
# on the brain host, after the swap (gbrain upgrade has restarted every process; with --no-restart run:)
gbrain upgrade --restart-only            # every resident gbrain process onto the installed build, verified
gbrain sources writer movement           # waits one window (max(300 s, preparation budget + 60 s)); exit 0 only when pending work moved or nothing is pending
gbrain doctor --json                     # managed_sync_not_moving, two_consumers_on_host, consumers_without_heartbeat, host_identity_mismatch all ok
```

`writer movement [<source>] [--wait <dur>] [--warn-only] [--json]` snapshots
each active managed source (newest committed `managed_sync_*` receipt, the
head's step, the cursor and its holds), waits the window and judges: `moved` or
`current` exit 0; `held` exits 0 with the holds and their route
(`gbrain repair fences --source <id>` for fence holds, `gbrain sources writer
status --source <id> --json` then `gbrain sources retry-held <id>` for
`preparation_stalled`); `within_allowance` (a multi-wave group still preparing
with its step advancing) exits 0 with `retry_after_ms`; `not_moving` exits 1
with `managed_sync_not_moving` (`reason: movement_check`) and the writer-status
command as its fix; `unknown` carries the read failure's own code. `--warn-only`
prints the same envelopes and exits 0 for pipelines that cannot fail;
`--wait <dur>` takes sync's duration syntax. Restart every resident process, not
only `serve`: an older jobs worker or autopilot left running writes no
`persistence_consumers` heartbeat row and never defers to the resident
consumer (doctor `consumers_without_heartbeat`), and a worker started under a
different `HOME`/`GBRAIN_HOME` reads the binding as another host's (doctor
`host_identity_mismatch`). Runbook for a check that fails:
[the catch-up is parked](troubleshooting.md#managed-sync-not-moving).

`gbrain config set self_upgrade.<key>` writes `~/.gbrain/config.json` (the
file plane every self-upgrade reader uses) and refuses a value the readers
would ignore: an unknown key or mode, a quiet-hours window with an hour
outside 0-23, equal bounds, or an unknown timezone. Versions are stored in the
four-segment form (`0.57.1` becomes `0.57.1.0`). The keys are machine-local,
so they work on a thin client too. Older versions wrote these keys to the
database, where nothing reads them; the next `config set` or `config unset` of
the key removes that row.

## Implementation

### The Check (cron-initiated)

```
check_for_update():
  result = run("gbrain check-update --json")

  if not result.update_available:
    exit_silently()  // do NOT message the user

  // Sell the upgrade — lead with what they can DO, not what changed
  message = compose_upgrade_message(
    current: result.current_version,
    latest: result.latest_version,
    changelog: result.changelog
  )
  send_to_user(message, respect_quiet_hours=true)
```

### The Upgrade Message

Sell the upgrade. The user should feel "hell yeah, I want that." Lead with
what they can DO now that they couldn't before, not what files changed.

```
> **GBrain vX.Y.Z is available** (you're on vX.Y.W)
>
> What's new:
> - Your brain never falls behind. Live sync keeps the vector DB current
>   automatically, so edits show up in search within minutes
> - New verification runbook catches silent failures before they bite you
> - New installs set up live sync automatically. No more manual setup step
>
> Want me to upgrade? I'll update everything and refresh my playbook.
>
> (Reply **yes** to upgrade, **not now** to skip, **weekly** to check
> less often, or **stop** to turn off update checks)
```

### Handling Responses

| User says | Action |
|-----------|--------|
| yes / y / sure / ok / do it / upgrade | Run the full upgrade flow (below) |
| not now / later / skip / snooze | Acknowledge, check again next cycle |
| weekly | Store preference, switch cron to weekly |
| daily | Store preference, switch cron back to daily |
| stop / unsubscribe / no more | Disable the cron. Tell user how to resume |

**In `notify` mode (the default), never auto-upgrade — always wait for explicit
confirmation.** The `auto` mode (opt-in, see "Self-upgrade modes" above) is the
only path that applies without a prompt, and only under its conservative gates
(quiet hours + idle + doctor-gate). This per-cron-prompt flow is the `notify`
experience.

### The Full Upgrade Flow (after user says yes)

```
full_upgrade():
  // Step 1: Update the binary/package
  run("gbrain upgrade")

  // Step 2: Re-read all updated skills
  for skill in find("skills/*/SKILL.md"):
    read_and_internalize(skill)  // updated skills = better agent behavior

  // Step 3: Re-read production reference docs
  read("docs/GBRAIN_SKILLPACK.md")
  read("docs/GBRAIN_RECOMMENDED_SCHEMA.md")

  // Step 4: Check for version-specific migration directives
  for version in range(old_version, new_version):
    migration = find(f"skills/migrations/v{version}.md")
    if migration exists:
      read_and_execute(migration)  // in order, don't skip

  // Step 5: Schema sync — suggest new, respect declined
  state = read("~/.gbrain/upgrade-state.json")
  for recommendation in new_schema_recommendations:
    if recommendation not in state.declined:
      suggest_to_user(recommendation)
  update(state, new_choices)

  // Step 6: Report what changed
  summarize_to_user(actions_taken)
```

### Migration Files

Migration files live at `skills/migrations/vX.Y.Z.md`. They contain agent
instructions (not scripts) for post-upgrade actions that make the new version
work for existing users. Example: a migration that sets up live sync and
runs the verification runbook.

The agent reads migration files in version order and executes them step by
step. Without migrations, the agent has new code but the user's environment
hasn't changed.

### Cron Registration

```
Name: gbrain-update-check
Default schedule: 0 9 * * * (daily 9 AM)
Weekly schedule: 0 9 * * 1 (Monday 9 AM)
Prompt: "Run gbrain check-update --json. If update_available is true,
  summarize the changelog and message me asking if I'd like to upgrade.
  If false, stay silent."
```

### Frequency Preferences

Default: daily. Store in agent memory as `gbrain_update_frequency: daily|weekly|off`.
Also persist in `~/.gbrain/upgrade-state.json` so it survives agent context resets
(the runtime's own bookkeeping lives beside it as `~/.gbrain/last-update-check`
and `~/.gbrain/update-snoozed`).

### Standalone Skillpack Users

If you loaded this SKILLPACK directly (copied or read from GitHub) without
installing gbrain, you can still stay current. Both GBRAIN_SKILLPACK.md and
GBRAIN_RECOMMENDED_SCHEMA.md carry a `<!-- source: ... -->` header pointing
at their canonical copies, and GBRAIN_RECOMMENDED_SCHEMA.md also carries a
version marker:

```bash
curl -s https://raw.githubusercontent.com/garrytan/gbrain/master/docs/GBRAIN_RECOMMENDED_SCHEMA.md | head -1
# Returns: <!-- schema-version: X.Y.Z -->
```

If the remote version is newer (or the remote SKILLPACK content differs from
your local copy), fetch the full file and replace your local copy. Set up a
weekly cron to check automatically.

## Tricky Spots

1. **In `notify` mode, never auto-install.** The upgrade waits for the user's
   explicit "yes." Even if the check detects an update and the changelog looks
   great, the agent messages the user and waits. The `auto` mode (opt-in) exists
   for headless/always-on installs where there's no human to prompt — it applies
   only during quiet hours, only when idle, doctor-gated, never retrying a
   known-bad version. Don't enable `auto` on an interactive workstation; the
   prompt-first `notify` flow is the right default there.

2. **Migration files are agent instructions, not scripts.** They tell the agent
   what to do step by step in plain language. They are NOT bash scripts to
   execute blindly. The agent reads them, understands the context, and adapts
   to the user's specific environment (e.g., skip a step if the user already
   has live sync configured).

3. **check-update should run on a daily cron.** Don't rely on the user
   remembering to check for updates. The cron runs `gbrain check-update --json`
   daily at 9 AM (respecting quiet hours). If there's nothing new, it stays
   completely silent. The user only hears about updates when there IS something
   worth upgrading to.

## How to Verify

1. **Run check-update and verify detection.** Execute
   `gbrain check-update --json`. Verify it returns the current version and
   correctly reports whether an update is available. If `update_available`
   is false, verify the version matches the latest release on GitHub.

2. **Verify migration files are readable.** List `skills/migrations/` and
   check that each file follows the naming convention `vX.Y.Z.md`. Open one
   and verify it contains step-by-step agent instructions, not raw scripts.
   The agent should be able to read and execute each step.

3. **Test the full upgrade flow end-to-end.** If an update is available, say
   "yes" and watch the agent execute the full flow: upgrade, re-read skills,
   run migrations, sync schema, report. Verify each step completes and the
   agent reports what changed.

---

*Part of the [GBrain Skillpack](../GBRAIN_SKILLPACK.md).*
