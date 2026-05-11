---
id: vault-autocommit
name: Vault Auto-Commit
version: 0.1.0
description: >-
  Brain repos that receive files from external pipelines (iOS shortcuts
  exporting to iCloud Drive, Dropbox-sync from another machine, Obsidian
  mobile sync, etc.) need someone to run `git commit` on the host before
  `gbrain sync` can ingest them. This recipe installs a launchd job that
  every N minutes stages a configured subdirectory, commits any pending
  changes, and runs `gbrain sync` so new files land in the brain end-to-end
  without manual intervention.
category: sense
requires: []
secrets: []
health_checks:
  - type: command
    label: "Worker script installed and executable"
    command: "test -x $HOME/bin/gbrain-autocommit.sh && echo OK"
  - type: command
    label: "launchd job loaded"
    command: "launchctl list | grep -q com.gbrain.autocommit && echo OK"
---

## IMPORTANT: Instructions for the Agent

This recipe installs a Mac launchd job that bridges file-drop pipelines (iOS export to iCloud, etc.) into the gbrain sync path. The user cannot run `git commit` from iOS / mobile, so the Mac does it on a schedule.

**Before installing:**
1. Confirm the brain repo path with `gbrain config get sync.repo_path`.
2. Confirm a `gbrain` binary is on `PATH` (typically `~/.bun/bin/gbrain`).
3. Confirm the user is on macOS with launchd (this is macOS-only; for Linux see "Linux variant" at the bottom).
4. Pick the subdirectory(ies) to auto-commit. Default: stage everything in the brain repo. Common pattern: stage only an external-pipeline target like `v2md/Notes`.
5. Pick the cron interval. Default: 5 minutes (300s).

**Don't auto-commit if:**
- The brain repo's `origin` remote is shared with collaborators who would see noisy `auto:` commits. (You can still use this — just push policy stays manual.)
- The user manually edits files in the auto-committed subdirectory and wants every save reviewed before commit.

## What this does

- Every N minutes (default 5), a launchd-scheduled shell script:
  1. `cd`s into the brain repo.
  2. `git add`s the configured subdirectory (or everything).
  3. `git commit -m "auto: <subdir> (N file(s))"` if anything was staged.
  4. Runs `gbrain sync --no-pull` so the new files are ingested immediately.
- A `git diff --cached --quiet` guard makes the job a no-op when nothing changed.
- Logs to `~/.gbrain/logs/autocommit.log`.

End-to-end latency from "iOS exports file to iCloud" to "page is queryable in brain": typically 5–10 minutes (iCloud Drive sync 1–5 min + cron tick 0–5 min + gbrain sync 5–15s).

## Prerequisites

- macOS with launchd (`launchctl` available).
- `gbrain` installed and `gbrain doctor` reports `healthy`.
- `~/.zshrc` exports `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc. The worker sources `~/.zshrc`.
- A brain repo that is a git repo (the `sync.repo_path` directory has a `.git/` subdir).
- The subdirectory you want auto-committed exists on disk.
- For iCloud Drive vaults: the parent folder should be set to "Always Keep on this Mac" so files aren't in `.icloud` placeholder state. (Files in placeholder state are invisible to `git add` until iCloud downloads them; the next cron tick picks them up once that completes.)

## Step 1: Verify prerequisites

```bash
gbrain doctor --json | jq -r .status
gbrain config get sync.repo_path
test -d "$(gbrain config get sync.repo_path)/.git" && echo "git repo OK" || echo "MISSING .git"
which gbrain
```

If any check fails, fix it before continuing.

## Step 2: Pick parameters

Three knobs:

- **`STAGE_PATH`** — the subdirectory (relative to the brain repo) to auto-commit. Use `.` to stage everything. Default for iOS export workflows: `v2md/Notes`.
- **`INTERVAL_SECS`** — how often to run. Default 300 (5 minutes). Don't go below 60s; iCloud sync can take longer than that.
- **`LABEL`** — launchd job label. Default `com.gbrain.autocommit`. If installing multiple instances (e.g., one per pipeline subdir), use distinct labels: `com.gbrain.autocommit-v2md`, `com.gbrain.autocommit-screenshots`, etc.

## Step 3: Write the worker script

Write to `~/bin/gbrain-autocommit.sh`. (Create `~/bin/` if missing.) Replace `<STAGE_PATH>` with the user's chosen subdirectory.

**Critical:** use `git -C "$BRAIN"` rather than `cd "$BRAIN" && git`. macOS launchd sandboxes child processes such that `git`'s `getcwd()` returns `EPERM` on iCloud Drive paths (`~/Library/Mobile Documents/...`) even when Full Disk Access has been granted to the shell. The fatal error reads `fatal: Unable to read current working directory: Operation not permitted` and the script silently fails to commit. Passing the path explicitly to git as an argument avoids the cwd-read syscall entirely.

```bash
#!/bin/zsh
# gbrain vault auto-commit worker — bridges external file-drop pipelines
# (iOS iCloud export, Dropbox, etc.) into the gbrain sync path.
#
# IMPORTANT: source ~/.zshrc BEFORE `set -u` — oh-my-zsh boilerplate
# references unbound variables that would abort the script.
#
# Uses `git -C <path>` rather than `cd <path>` because macOS launchd
# sandboxes child processes such that getcwd() on iCloud Drive paths
# returns EPERM — even with Full Disk Access granted. Passing the path
# explicitly to git avoids the cwd-read syscall entirely.
set -eo pipefail
source "$HOME/.zshrc" 2>/dev/null || true
export PATH="$HOME/.bun/bin:$PATH"

BRAIN="$(gbrain config get sync.repo_path 2>/dev/null | grep -v '^\[ai\.gateway\]')"
STAGE_PATH="<STAGE_PATH>"   # e.g. v2md/Notes — or "." for whole repo
LOG="$HOME/.gbrain/logs/autocommit.log"
mkdir -p "$(dirname "$LOG")"

if [[ -z "$BRAIN" || ! -d "$BRAIN/.git" ]]; then
  echo "$(date -Iseconds) FATAL: brain repo not found at '$BRAIN'" >> "$LOG"
  exit 1
fi

# Stage. Use git -C to avoid cd-into-iCloud sandbox issues under launchd.
git -C "$BRAIN" add "$STAGE_PATH" 2>/dev/null || true

# Bail cleanly if nothing was staged. Write a heartbeat line so the cron
# is observable even when there is no work to do. Trim the log if it
# grows past 1MB so heartbeats don't bloat disk.
if git -C "$BRAIN" diff --cached --quiet; then
  echo "$(date -Iseconds) tick — no changes in $STAGE_PATH" >> "$LOG"
  if [[ $(wc -c < "$LOG") -gt 1048576 ]]; then
    tail -1000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
  fi
  exit 0
fi

COUNT=$(git -C "$BRAIN" diff --cached --name-only | wc -l | tr -d ' ')
echo "=== $(date -Iseconds) committing $COUNT file(s) in $STAGE_PATH ===" >> "$LOG"
git -C "$BRAIN" commit -m "auto: $STAGE_PATH ($COUNT file(s))" >> "$LOG" 2>&1
echo "=== $(date -Iseconds) running gbrain sync ===" >> "$LOG"
gbrain sync --no-pull >> "$LOG" 2>&1
echo "=== $(date -Iseconds) sync done ===" >> "$LOG"
```

Then make it executable: `chmod +x ~/bin/gbrain-autocommit.sh`.

## Step 4: Write the launchd plist

Write to `~/Library/LaunchAgents/<LABEL>.plist`. Replace `<LABEL>`, `<INTERVAL_SECS>`, `<USER_HOME>`, and the script path.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string><LABEL></string>
    <key>ProgramArguments</key>
    <array>
        <string><USER_HOME>/bin/gbrain-autocommit.sh</string>
    </array>
    <key>StartInterval</key>
    <integer><INTERVAL_SECS></integer>
    <key>RunAtLoad</key>
    <false/>
    <key>StandardOutPath</key>
    <string><USER_HOME>/.gbrain/logs/autocommit.launchd.log</string>
    <key>StandardErrorPath</key>
    <string><USER_HOME>/.gbrain/logs/autocommit.launchd.err</string>
    <key>WorkingDirectory</key>
    <string><USER_HOME></string>
    <key>ProcessType</key>
    <string>Background</string>
    <key>LowPriorityIO</key>
    <true/>
    <key>Nice</key>
    <integer>10</integer>
</dict>
</plist>
```

## Step 5: Register with launchctl

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/<LABEL>.plist
launchctl list | grep <LABEL>
```

Expected: one line with the label and `-` for both PID and exit code (means scheduled, not currently running).

## Step 6: Verify

Force one immediate run (skip the wait-for-interval):

```bash
~/bin/gbrain-autocommit.sh
tail -20 ~/.gbrain/logs/autocommit.log
```

If `STAGE_PATH` had pending changes, you should see a commit + sync log. If not, the script silently exits 0 — that's the no-op path, working as designed.

Confirm gbrain ingested the new files:

```bash
gbrain doctor --json | jq -r '.status, .health_score'
```

Should still report `healthy` / 100.

## Tuning

- **Multiple subdirectories with different policies.** Install multiple instances with distinct LABELs (e.g., `com.gbrain.autocommit-v2md` for transcripts, `com.gbrain.autocommit-screenshots` for image dumps). Each has its own plist and own STAGE_PATH.
- **Push to remote.** If your brain repo has an `origin` for backup (e.g., a private GitHub mirror), add `git push origin <branch>` after the commit. Skip if you're single-machine.
- **Synthesize-on-arrival.** This recipe ingests + embeds new files but does not fire `dream.synthesize` on them. Synthesis runs on the nightly 02:00 dream cycle. If you want a transcript synthesized into reflections within minutes of arrival rather than overnight, add `gbrain dream --input "$BRAIN/v2md/Notes/<new-file>" --json >> "$LOG" 2>&1` to the worker — but be aware each synth call costs ~$0.30 in Sonnet tokens.

## Troubleshooting

**`fatal: Unable to read current working directory: Operation not permitted` in `~/.gbrain/logs/autocommit.launchd.err`.** macOS launchd sandbox blocks `getcwd()` on iCloud Drive paths even when Full Disk Access is granted. The worker script in this recipe already avoids this with `git -C "$BRAIN"`, so you should never hit this — but if you've forked the script and replaced `git -C` with `cd && git`, this is the symptom. Switch back to `git -C`.

**"git pull failed" in logs.** Your dream wrapper does `git pull` but this worker doesn't, and shouldn't. The worker uses `--no-pull` on sync deliberately. Ignore.

**"Could not acquire PGLite lock" in sync output.** Another gbrain process (a `gbrain serve` MCP server or a long-running `gbrain dream` cycle) holds the brain. Sync retries internally; logs will show the retry. If it keeps failing, kill the holder: `pgrep -af 'gbrain serve' | head -1 | awk '{print $1}' | xargs kill` then restart it.

**Files in `.icloud` placeholder state.** macOS doesn't download iCloud files until accessed. Set the parent folder to "Always Keep on this Mac" via Finder right-click → Keep Downloaded. The next cron tick picks them up once downloaded.

**The cron isn't firing.** Check launchd: `launchctl list | grep autocommit`. If missing, re-run the bootstrap from Step 5. If present but never runs, check `~/.gbrain/logs/autocommit.launchd.err` for the failure.

**Auto-commit captured an in-progress edit you weren't ready to commit.** This is the intended behavior — anything in `STAGE_PATH` gets committed. If you regularly hand-edit files in that subdir, either narrow `STAGE_PATH` further, or unstage the recipe entirely (`launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/<LABEL>.plist`) and run manually.

## Uninstall

```bash
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/<LABEL>.plist
rm ~/Library/LaunchAgents/<LABEL>.plist
rm ~/bin/gbrain-autocommit.sh
```

The brain repo and existing auto-commits are left intact.

## Linux variant

Same script, scheduled via `systemd --user` timer or a cron entry:

```cron
*/5 * * * * /home/<user>/bin/gbrain-autocommit.sh
```

Or systemd user timer (`~/.config/systemd/user/gbrain-autocommit.timer` + `.service`). Same worker script; ship the same commit + sync semantics.

## Future upgrade path

Two natural extensions:

1. **fswatch-driven sub-second latency.** Trade the 5-min poll for an event-driven watcher (`fswatch`, `kqueue`, `inotify`). Cheaper on idle CPU and faster on file arrival. Tradeoff: iCloud Drive doesn't always emit clean FSEvents for files arriving from other devices; polling is more reliable for that specific source. Direct local edits (Obsidian on the Mac, screen capture) would benefit from event-driven.

2. **Auto-synthesize triggers.** When a new file's path matches a configured pattern (e.g., `v2md/Notes/`), automatically run `gbrain dream --input <file>` after the sync. Surfaces reflections within minutes of arrival instead of overnight. Per-call cost is the gate — recommend wiring this only for paths you trust to produce worth-synthesizing content.
