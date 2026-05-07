# Live Sync: Keep the Index Current

## Goal

Every markdown change in the brain repo is searchable within minutes, automatically, with no manual intervention.

## What the User Gets

Without this: you correct a hallucination in a brain page, but the vector DB
keeps serving the old text because nobody ran `mbrain sync`. Stale search
results erode trust. The brain becomes unreliable.

With this: edits show up in search within minutes. The vector DB stays current
with the brain repo automatically. You never have to remember to run sync.

## Implementation

### Prerequisite: Session Mode Pooler

Sync uses `engine.transaction()` on every import. If `DATABASE_URL` points to
Supabase's **Transaction mode** pooler, sync will throw `.begin() is not a
function` and **silently skip most pages**. This is the number one cause of
"sync ran but nothing happened."

Fix: use the **Session mode** pooler string (port 6543, Session mode) or the
direct connection (port 5432, IPv6-only). Verify by running `mbrain sync` and
checking that the page count in `mbrain stats` matches the syncable file count
in the repo.

### The Primitives

Always chain sync + embed:

```bash
mbrain sync --repo /path/to/brain && mbrain embed --stale
```

- `mbrain sync --repo <path>` -- one-shot incremental sync. Detects changes via
  `git diff`, imports only what changed, and leaves embedding backfill to
  `mbrain embed --stale`.
- `mbrain sync --all-subbrains` -- one-shot sync for every registered
  git-backed sub-brain. Use this when `/path/to/brain` is a non-git container
  with child repos such as `personal/` and `office/`.
- `mbrain embed --stale` -- backfill embeddings for any chunks that don't have
  them. Safety net for large syncs (>100 files) or prior `--no-embed` runs.
- `mbrain sync --watch --repo <path>` -- foreground polling loop, every 60s
  (configurable with `--interval N`). Exits after 5 consecutive failures, so
  run under a process manager or pair with a cron fallback that also runs
  `mbrain embed --stale`.
- `mbrain sync --watch --all-subbrains` -- polling loop over every registered
  sub-brain.

For a sub-brain layout:

```bash
mbrain subbrain add personal /data/brain/personal --prefix personal --default
mbrain subbrain add office /data/brain/office --prefix office
mbrain sync --all-subbrains && mbrain embed --stale
```

### Approach 1: Cron Job (recommended)

Run every 5-30 minutes. Works with any cron scheduler.

```bash
mbrain sync --repo /data/brain && mbrain embed --stale
```

For registered sub-brains:

```bash
mbrain sync --all-subbrains && mbrain embed --stale
```

**OpenClaw:**
```
Name: mbrain-auto-sync
Schedule: */15 * * * *
Prompt: "Run: mbrain sync --repo /data/brain && mbrain embed --stale
  Log the result. If sync fails with .begin() is not a function,
  the DATABASE_URL is using Transaction mode pooler."
```

**Hermes:**
```
/cron add "*/15 * * * *" "Run mbrain sync --repo /data/brain &&
  mbrain embed --stale. Log the result." --name "mbrain-auto-sync"
```

### Approach 2: Long-Lived Watcher

For near-instant sync (60s polling). Run under a process manager that
auto-restarts on exit. Pair with a cron fallback since `--watch` exits
on repeated failures.

```bash
mbrain sync --watch --repo /data/brain
```

### Approach 3: Git Hook / Webhook

Triggers sync on push events for instant sync (<5s).

- **GitHub webhook:** Set up the webhook to call
  `mbrain sync --repo /data/brain && mbrain embed --stale`.
  Verify `X-Hub-Signature-256` against a shared secret.
- **Git post-receive hook:** If the brain repo is on the same machine.

### What Gets Synced

Sync only indexes "syncable" markdown files. These are excluded by design:
- Hidden paths (`.git/`, `.raw/`, etc.)
- The `ops/` directory
- Meta files: `README.md`, `index.md`, `schema.md`, `log.md`

### Sync is Idempotent

Concurrent runs are safe. Two syncs on the same commit no-op because content
hashes match. If both a cron and `--watch` fire simultaneously, no conflict.

## Tricky Spots

1. **Always chain sync + embed.** Running `mbrain sync` without
   `mbrain embed --stale` leaves new chunks without embeddings. They exist
   in the database but are invisible to vector search. Always run both
   commands together. The `&&` ensures embed only runs if sync succeeds.

2. **--watch polls, it doesn't stream.** The `--watch` flag polls every 60s
   (configurable). It is not a filesystem watcher or git hook. It exits after
   5 consecutive failures, so it needs a process manager (systemd, pm2) or a
   cron fallback to stay alive. Don't assume it runs forever.

3. **Webhook needs the server running.** If you use a GitHub webhook for
   instant sync, the receiving server must be running and reachable. If the
   server is down when a push happens, that sync is missed. Pair webhooks
   with a cron fallback that catches anything the webhook missed.

## How to Verify

1. **Edit a file and search for the change.** Edit a brain markdown file,
   commit, and push. Wait for the next sync cycle (cron interval or `--watch`
   poll). Run `mbrain search "<text from the edit>"`. The updated content
   should appear in results. If it returns old content, sync failed.

2. **Compare page count to file count.** Run `mbrain stats` and count the
   syncable markdown files in the brain repo. The page count in the database
   should match. If they diverge, files are being silently skipped (likely
   a Transaction mode pooler issue).

3. **Check embedded chunk count.** In `mbrain stats`, the embedded chunk
   count should be close to the total chunk count. A large gap means
   `mbrain embed --stale` isn't running after sync, leaving chunks invisible
   to vector search.

---

*Part of the [MBrain Skillpack](../MBRAIN_SKILLPACK.md).*
