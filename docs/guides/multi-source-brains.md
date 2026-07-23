# Multi-source brains

**A single gbrain database can hold multiple knowledge repos.** Each one
is a `source`: a logical brain-within-the-brain with its own slug
namespace, its own sync state, and its own federation policy. The rest
of this guide walks the three canonical scenarios.

## The three scenarios

### 1. Unified knowledge recall (wiki + gstack)

You have a personal wiki and a `gstack` checkout. Both belong to you,
both are knowledge you want your agent to recall across. When you ask
"what did I learn about X?" you want the best hit whether it lives in
the wiki or in a gstack plan.

```bash
# Register the gstack source, federate so it joins cross-source search
gbrain sources add gstack --path ~/.gstack --federated

# Pin the directory so `gbrain sync` knows which source it's walking
cd ~/.gstack && gbrain sources attach gstack

# Initial sync
gbrain sync --source gstack

# Now `gbrain search "retry budgets"` returns hits from BOTH wiki and
# gstack. Each result includes source_id so the agent can cite properly.
```

Result: wiki pages and gstack plans are separate (different source_ids,
different slug namespaces) but share the search surface.

### 2. Purpose-separated brains (yc-media + garrys-list)

You run two completely different content pipelines on the same backend.
YC Media covers portfolio news and founder profiles. Garry's List is
personal writing. You explicitly DON'T want them mixed in search — YC
portfolio content leaking into essay searches is a bug, not a feature.

```bash
# Two sources, both isolated (federated=false)
gbrain sources add yc-media --path ~/yc-media --no-federated
gbrain sources add garrys-list --path ~/writing --no-federated

# Pin each checkout directory
(cd ~/yc-media && gbrain sources attach yc-media)
(cd ~/writing && gbrain sources attach garrys-list)

# Sync each independently
gbrain sync --source yc-media
gbrain sync --source garrys-list
```

Result: searching from neither directory returns the `default` source
(your main brain). Searching from inside `~/yc-media` returns only yc-
media hits. Searching from inside `~/writing` returns only garrys-list.
Federation is opt-in, not leaked.

To search one isolated source explicitly, choose one source context per
invocation:

```bash
gbrain search "tech layoffs" --source yc-media
gbrain search "tech layoffs" --source garrys-list
```

Do not pass a comma-separated source list to `--source`. Source ids are
single context keys; if you want both sources in default search, federate
them with `gbrain sources federate <id>`.

### 3. Mixed (wiki federated + sessions isolated)

Your main wiki is federated with a few trusted sources. Your session
transcripts or other high-volume capture streams can live in a separate
isolated source so they don't dominate every search result.

```bash
# Federated sources
gbrain sources add gstack --path ~/.gstack --federated

# Isolated source for session transcripts or another noisy stream
gbrain sources add sessions --path ~/.claude/sessions --no-federated
```

## Resolution priority

When any command needs to pick a source, gbrain walks this list (highest
first):

1. Explicit `--source <id>` flag.
2. `GBRAIN_SOURCE` environment variable.
3. `.gbrain-source` dotfile in CWD or any ancestor directory.
4. A registered source whose `local_path` contains the CWD (longest
   prefix wins for nested checkouts).
5. The brain-level default set via `gbrain sources default <id>`.
6. The seeded `default` source.

So inside `~/.gstack/plans/` on a brain that pinned `gstack` to
`~/.gstack` via `.gbrain-source`, `gbrain put-page` implicitly writes to
the `gstack` source. Outside any registered directory with no env/dotfile
set, it writes to the default.

## Federation flag

Every source row stores `config.federated: boolean` in its JSONB config.

| Value | Meaning |
|-------|---------|
| `true` | Source participates in unqualified `gbrain search "X"` results. |
| `false` (default for new sources) | Source only searched when explicitly named via `--source <id>` or qualified citation. |

The seeded `default` source is `federated=true` so pre-v0.17 brains
behave exactly as before — every page appears in search.

Flip later with `gbrain sources federate <id>` / `unfederate <id>`.

## Commands

Full subcommand reference:

```
gbrain sources add <id> --path <p> [--name <n>] [--federated|--no-federated] [--force]
                               Register a source. id: [a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?
                               --path must be a git repo (or a subdirectory of one) — see
                               "The git requirement for --path sources" below. --force
                               skips that check to register before git-init exists.
gbrain sources list [--json]   List all sources with page counts + federation state.
gbrain sources status [--json] Read-only per-source health: last sync,
                               staleness, page count, embedding coverage,
                               failures, and queue/backfill state.
gbrain sources current [--source <id>] [--json]
                               Show which source the resolver would target
                               and which tier won.
gbrain sources remove <id> [--confirm-destructive] [--dry-run]
                               Permanently delete a source and all its data
                               after impact preview.
gbrain sources archive <id>    Soft-delete a source while preserving data
                               for the configured grace window.
gbrain sources archived [--json]
                               List archived sources and expiry windows.
gbrain sources restore <id> [--no-federate]
                               Restore an archived source.
gbrain sources purge [<id>] [--confirm-destructive]
                               Permanently purge archived sources.
gbrain sources rename <id> <new-name>
                               Change display name only; id is immutable.
gbrain sources default <id>    Set the brain-level default.
gbrain sources attach <id>     Write .gbrain-source in CWD (like kubectl context).
gbrain sources detach          Remove .gbrain-source from CWD.
gbrain sources federate <id>
gbrain sources unfederate <id>
gbrain sources set-cr-mode <id> <none|title|per_chunk_synopsis>
                               Override contextual retrieval mode for one
                               source; pass "unset" or "default" to clear.
gbrain sources webhook <set|show|rotate|clear> <id> [...]
                               Manage per-source GitHub webhook metadata.
gbrain sources tracked-branch <id> [--set <branch>] [--detect]
                               Read or pin the branch used by source sync.
gbrain sources audit <id> [--json]
                               Dry-run content sanity scan before or after sync.
```

## The git requirement for --path sources

Every `--path` source must be a git repository (or live inside one — a
subdirectory of a git repo works too) with at least one committed, tracked
file under that path. `gbrain sources add` validates this at registration
time and refuses a directory that doesn't qualify — no `.git` at all, a
`git init` with no commit yet, or a commit made before `git add` — with an
actionable error instead of silently registering a source that will fail
(or worse, "succeed" while importing nothing) on its first `gbrain sync`.
Fix it with:

```bash
git -C <path> init
git -C <path> add -A
git -C <path> commit -m "initial import"
gbrain sources add <id> --path <path>
```

Two details that are easy to miss:

- **Files must actually be committed, not just present.** The sync walker
  reads files through git objects, so `git init` alone — even followed by an
  empty commit (`git commit --allow-empty`) — isn't enough. Registration
  checks for real tracked content (`git ls-tree HEAD` scoped to the path),
  not just a resolvable `HEAD`, so this footgun is caught immediately
  instead of surfacing later as a sync that imports nothing.
- **`--force` registers the source anyway**, skipping the check. Use this if
  you're registering a path before an automated pipeline gets around to
  `git init`-ing it. GBrain never auto-`git init`s a `--path` source for
  you — it's your directory, not a gbrain-managed clone (same consent
  boundary as sync-time self-heal, which also never mutates a `--path`
  source without an explicit ask).

**If sync ever reports a problem with the sync anchor** (`last_commit`) —
after a force-push, a history rewrite, or a from-scratch `git init` on a
directory that was synced before — you do not need to reset anything by
hand. `gbrain sync` detects an unreachable or non-ancestor anchor
automatically and recovers: either a full reimport (anchor object missing)
or a direct tree-to-tree diff against the orphaned bookmark (anchor present
but rewritten), advancing the anchor to the new HEAD when it completes.

## Citation format for agents

When agents receive multi-source results they MUST cite pages in
`[source-id:slug]` form. Example:

> You told me about the distillation protocol — see [wiki:topics/ai]
> and [gstack:plans/multi-repo] for where this came from.

The citation key is `sources.id` (immutable). Renaming a source via
`gbrain sources rename` changes the display name only; existing
citations keep working.

## Writing to a specific source

```bash
# Pass --source explicitly
gbrain put-page topics/ai ... --source wiki

# Or rely on the dotfile / env / CWD match
cd ~/.gstack && gbrain put-page plans/multi-repo ...
# → source auto-resolves to gstack
```

Reads span federated sources by default. Writes require a resolved
source (explicit, inferred, or default). The resolver never picks a
source silently when ambiguous — it errors with a clear fix.

## Durability: keep a brain repo in sync (auto-harden)

A long-lived agent that writes to a knowledge-wiki git repo needs three
things to never lose work: pull before it edits, push every write, and not
go stale while it sits idle. `gbrain sources harden` installs all of that,
idempotently. The moment you add a brain repo with a token, it runs
automatically:

```bash
# Clone + register a GitHub repo, then auto-harden it for durability.
# Use a fine-grained PAT scoped to just this repo.
gbrain sources add wiki --url https://github.com/you/brain-wiki.git --pat-file ~/.secrets/wiki-pat
#   → clones, then installs: local auto-push hook, scripts/brain-commit-push.sh,
#     always-on durability rules in AGENTS.md/RESOLVER.md, a 30-min pull cron,
#     and a repo-scoped credential. Verifies push works before declaring done.

# Run the same audit on an existing source any time (idempotent):
gbrain sources harden wiki --pat-file ~/.secrets/wiki-pat

# Pull on demand (the cron calls the --path form, which never opens the DB):
gbrain sources pull wiki

# Remove the durability scaffolding (also runs automatically on `sources remove`):
gbrain sources unharden wiki
```

What hardening guarantees:

- **Pull-first, conflict-safe.** Every pull is a divergence-safe rebase. A
  dirty working tree is skipped (your in-progress edits are never touched); a
  rebase conflict is aborted cleanly and flagged for attention, never left
  half-applied.
- **Push is never deferred.** `scripts/brain-commit-push.sh "<msg>" <path>`
  commits and pushes atomically and refuses to report success without a
  confirmed push. The post-commit hook is a best-effort background fallback;
  the helper is the guarantee.
- **No silent staleness.** A 30-minute background pull keeps an idle session
  current. It runs DB-free, so it never contends with a live brain for the
  PGLite single-writer lock.

Flags: `--no-cron` skips the scheduled pull, `--no-verify` skips the push
probe, `--dry-run` reports what would change, `--json` emits a machine
report, `--all` hardens every source with a remote (same-account only).
`--no-harden` on `sources add` opts out of auto-harden.

Security: the push automation is installed locally per machine (never
committed into the repo), the token is wired per-repo (an existing
credential helper is reused when present), and it never appears in the repo,
the remote URL, logs, or the JSON report. For a self-hosted git server
reachable only over a filesystem path, set `GBRAIN_GIT_ALLOW_FILE_TRANSPORT=1`
(default is HTTPS-only).

## Upgrading an existing brain

`gbrain upgrade` runs the v16 + v17 migrations automatically. Your
existing pages all move under `source_id='default'`. Behavior is
unchanged until you add a second source.

To add one:

```bash
gbrain sources add gstack --path ~/.gstack --federated
cd ~/.gstack && gbrain sources attach gstack && gbrain sync
```

Two commands. The existing default source is untouched.

## Current boundaries

Sources are current infrastructure, not a roadmap placeholder. The current
surface covers registration, attach/detach, default resolution,
federation/unfederation, current-source inspection, status dashboards,
soft-delete/restore/purge, source webhooks, tracked branches, contextual
retrieval overrides, and dry-run source audits.

Still do not assume a source id list works everywhere. The CLI resolver picks
one source context at a time through `--source`, `GBRAIN_SOURCE`,
`.gbrain-source`, local path, brain default, or the seeded `default` source.
Cross-source default search comes from federation; OAuth clients get their
read axis from `--federated-read`.

Deferred or separate surfaces remain separate: there is no
`gbrain sources prune` retention command in the current dispatcher, and there
is no `gbrain sources import-from-github <url>` one-shot bootstrap command in
the current dispatcher.
