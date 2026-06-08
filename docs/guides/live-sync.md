# Live Sync: Keep the Index Current

## Goal

Every markdown change in the brain repo is searchable within minutes, automatically, with no manual intervention.

## What the User Gets

Without this: you correct a hallucination in a brain page, but the vector DB
keeps serving the old text because nobody ran `gbrain sync`. Stale search
results erode trust. The brain becomes unreliable.

With this: edits show up in search within minutes. The vector DB stays current
with the brain repo automatically. You never have to remember to run sync.

## Implementation

### Prerequisite: a reachable direct connection

GBrain is tuned for the Supabase **Transaction pooler** (port 6543): it
auto-disables prepared statements there and routes `engine.transaction()`
(migrations, DDL, sync imports) to a derived **direct** connection
(`db.<ref>.supabase.co:5432`). That direct host is IPv6-only, so on an
IPv4-only host, reads work but sync **silently skips most pages**. This is the
number one cause of "sync ran but nothing happened."

Fix: make the direct connection reachable over IPv4. Either set
`GBRAIN_DIRECT_DATABASE_URL` to the **Session pooler** string (port 5432 on the
`pooler.supabase.com` host, IPv4), or enable Supabase's IPv4 add-on. Verify by
running `gbrain sync` and checking that the page count in `gbrain stats` matches
the syncable file count in the repo.

### The Primitives

Always chain sync + embed:

```bash
gbrain sync --repo /path/to/brain && gbrain embed --stale
```

- `gbrain sync --repo <path>` -- one-shot incremental sync. Detects changes via
  `git diff`, imports only what changed. For small changesets (<= 100 files),
  embeddings are generated inline during import.
- `gbrain embed --stale` -- backfill embeddings for any chunks that don't have
  them. Safety net for large syncs (>100 files) or prior `--no-embed` runs.
- `gbrain sync --watch --repo <path>` -- foreground polling loop, every 60s
  (configurable with `--interval N`). Embeds inline for small changesets. Exits
  after 5 consecutive failures, so run under a process manager or pair with a
  cron fallback.

### Approach 1: Cron Job (recommended)

Run every 5-30 minutes. Works with any cron scheduler.

```bash
gbrain sync --repo /data/brain && gbrain embed --stale
```

**OpenClaw:**
```
Name: gbrain-auto-sync
Schedule: */15 * * * *
Prompt: "Run: gbrain sync --repo /data/brain && gbrain embed --stale
  Log the result. If sync errors mention an unreachable host or timeout,
  the direct connection isn't reachable over IPv4 (set
  GBRAIN_DIRECT_DATABASE_URL to the Session pooler, or enable the IPv4 add-on)."
```

**Hermes:**
```
/cron add "*/15 * * * *" "Run gbrain sync --repo /data/brain &&
  gbrain embed --stale. Log the result." --name "gbrain-auto-sync"
```

### Approach 2: Long-Lived Watcher

For near-instant sync (60s polling). Run under a process manager that
auto-restarts on exit. Pair with a cron fallback since `--watch` exits
on repeated failures.

```bash
gbrain sync --watch --repo /data/brain
```

### Approach 3: Git Hook / Webhook

Triggers sync on push events for instant sync (<5s).

- **GitHub webhook:** Set up the webhook to call
  `gbrain sync --repo /data/brain && gbrain embed --stale`.
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

1. **Always chain sync + embed.** Running `gbrain sync` without
   `gbrain embed --stale` leaves new chunks without embeddings. They exist
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

4. **A single un-parseable file can't wedge all indexing.** When a file fails
   to import (malformed YAML frontmatter, an unquoted colon, etc.), sync holds
   the bookmark and tells you exactly which file broke — a *fresh* failure
   fails closed so nothing is silently dropped. But a file that fails the same
   way `GBRAIN_SYNC_AUTOSKIP_AFTER` consecutive syncs (default 3, set `0` to
   disable) is auto-skipped so the rest of the brain keeps indexing past it.
   Skipped files don't disappear: `gbrain doctor` keeps warning until you fix
   or delete them, and fixing the file clears it on the next sync. A repository
   history rewrite still hard-blocks even with `--skip-failed`. Run
   `gbrain sync --skip-failed` to acknowledge a known-bad set yourself.

## How to Verify

1. **Edit a file and search for the change.** Edit a brain markdown file,
   commit, and push. Wait for the next sync cycle (cron interval or `--watch`
   poll). Run `gbrain search "<text from the edit>"`. The updated content
   should appear in results. If it returns old content, sync failed.

2. **Compare page count to file count.** Run `gbrain stats` and count the
   syncable markdown files in the brain repo. The page count in the database
   should match. If they diverge, files are being silently skipped (likely an
   unreachable direct connection on IPv4 — see the prerequisite above).

3. **Check embedded chunk count.** In `gbrain stats`, the embedded chunk
   count should be close to the total chunk count. A large gap means
   `gbrain embed --stale` isn't running after sync, leaving chunks invisible
   to vector search.

---

*Part of the [GBrain Skillpack](../GBRAIN_SKILLPACK.md).*
