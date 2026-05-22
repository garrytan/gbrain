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

To search across them explicitly on demand:

```bash
gbrain search "tech layoffs" --source yc-media,garrys-list
```

### 3. Mixed (wiki federated + sessions isolated)

Your main wiki is federated with a few trusted sources. Your session
transcripts (coming in v0.18) land in a separate isolated source so
they don't dominate every search result.

```bash
# Federated sources
gbrain sources add gstack --path ~/.gstack --federated

# Isolated source (future v0.18 — sessions use this shape today for ingest)
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
gbrain sources remove <id> [--yes] [--dry-run] [--keep-storage]
                               Cascade-delete a source (pages, chunks, timeline).
gbrain sources rename <id> <new-name>
                               Change display name only; id is immutable.
gbrain sources default <id>    Set the brain-level default.
gbrain sources attach <id>     Write .gbrain-source in CWD (like kubectl context).
gbrain sources detach          Remove .gbrain-source from CWD.
gbrain sources federate <id>
gbrain sources unfederate <id>
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

## Not in v0.18.0

- Session transcript ingest (`.jsonl`, raised size cap, session
  PageType) — v0.18.
- Per-source retention/TTL (`gbrain sources prune`) — v0.18.
- ACL enforcement via caller-identity — v0.17.1.
- `gbrain sources import-from-github <url>` one-shot bootstrap — patch
  release after the core plumbing stabilizes.

All of these build on the `sources` primitive shipped here.
