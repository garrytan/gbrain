---
name: dream-wrap
purpose: Nightly `gbrain dream` runner with archived JSON CycleReports
trigger: launchd `com.jarvis.dream-cycle` (daily 03:11 local) | manual via `bun run`
---

# dream-wrap — nightly maintenance cycle archiver

Step 2.3 of the filesystem-canonical track (see
`docs/STEP-2-BRAIN-DIR-DESIGN.md §4`). Wraps `gbrain dream --json` with:

1. Brain-dir resolution from `gbrain config get sync.repo_path` (set
   by Step 2.2 / `gbrain init --pglite --repo ~/brain`).
2. Defensive JSON extraction (some phases leak human-readable text to
   stdout before the report; we slice from the first `{` to the last
   `}`).
3. Archive to `~/brain/.agent/dream-cycles/<ISO>.json` and atomic
   `latest.json` symlink swap. Future `/status` revisions can read
   `latest.json` for one-round-trip cycle health.
4. Exit code translation:
   - `clean | ok | partial | skipped` → exit 0 (not page-worthy)
   - `failed` → exit 1 (cycle aborted; surface to launchd)
   - wrapper-level errors (binary missing, archive write failed) → exit 2

`partial` is the common case here today: lint flags 144 issues on
73 disk-resident pages (historic notion-poller pages from before the
2026-05-17 retire omit `title:` and `type:`; KOS uses `kind:`), and
orphans flags ~1800/1930 (legacy v1 wiki was imported flat). Both are
tracked as P1 follow-ups.

## Files

- `run.ts` — the wrapper itself
- `dream.stdout.log` / `dream.stderr.log` — launchd stream captures
  (forwarded gbrain progress lines, wrapper meta lines)
- archive landing: `~/brain/.agent/dream-cycles/<ISO>.json`
  (gitignored per `~/brain/.gitignore`)

## Manual invocation

```bash
# Full cycle
bun run skills/kos-jarvis/dream-wrap/run.ts

# Preview only (no writes; lint goes read-only, embed shows planned work)
bun run skills/kos-jarvis/dream-wrap/run.ts --dry-run

# Single phase (handy for debugging)
bun run skills/kos-jarvis/dream-wrap/run.ts --phase lint
bun run skills/kos-jarvis/dream-wrap/run.ts --phase orphans
```

Flags after `run.ts` are passed through to `gbrain dream` verbatim.

## Reading the archive

```bash
# Latest report
cat ~/brain/.agent/dream-cycles/latest.json | jq .

# Phase summaries only
cat ~/brain/.agent/dream-cycles/latest.json \
  | jq '.phases | map({phase, status, summary})'

# History
ls -lt ~/brain/.agent/dream-cycles/ | head -10
```

## launchd

Plist: `scripts/launchd/com.jarvis.dream-cycle.plist.template`. The
generated `.plist` is gitignored (it's identical to the template; we
keep the duplication so secrets-bearing services stay out of git).

```bash
# Install / refresh
cp scripts/launchd/com.jarvis.dream-cycle.plist.template \
   scripts/launchd/com.jarvis.dream-cycle.plist
cp scripts/launchd/com.jarvis.dream-cycle.plist \
   ~/Library/LaunchAgents/com.jarvis.dream-cycle.plist
launchctl bootout gui/$UID ~/Library/LaunchAgents/com.jarvis.dream-cycle.plist 2>/dev/null
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.jarvis.dream-cycle.plist

# Manual fire (skips schedule)
launchctl kickstart -k gui/$UID/com.jarvis.dream-cycle

# Status
launchctl list | grep dream-cycle
# "PID  EXIT  Label" — PID `-` between fires is normal; EXIT 0 is healthy
```

## Rollback

```bash
launchctl bootout gui/$UID ~/Library/LaunchAgents/com.jarvis.dream-cycle.plist
rm ~/Library/LaunchAgents/com.jarvis.dream-cycle.plist
# Archive dir kept for audit; safe to remove if desired:
# rm -rf ~/brain/.agent/dream-cycles/
```
