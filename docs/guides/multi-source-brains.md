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
gbrain sources add <id> --path <p> [--name <n>] [--federated|--no-federated]
                               Register a source. id: [a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?
gbrain sources list [--json]   List all sources with page counts + federation state.
gbrain sources status [--json] Read-only per-source health: last sync,
                               staleness, active sync holder, page count,
                               embedding coverage, failures, and
                               queue/backfill state.
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
