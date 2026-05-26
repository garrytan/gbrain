# Sync Filtering: What Gets Indexed (and What Doesn't)

When `gbrain sync` (or the autopilot cycle, or `/sync-gbrain`) walks a repo,
it does NOT index every file. Two filters run in series:

1. **Strategy filter** — markdown only? code only? both? Configurable.
2. **Meta-file + directory skip list** — hard-coded. Even with the right
   strategy, four filenames and a handful of directory names are always
   excluded.

This guide explains both, with the design rationale for the hard-coded skip
list — because that rationale optimizes for personal knowledge vaults and
has sharp edges for code repos.

## TL;DR

| Question | Answer |
|---|---|
| What's the default strategy? | `markdown` — only `.md` / `.mdx` files |
| Will my `README.md` get indexed? | **No.** Hard-skipped at every depth, regardless of strategy. |
| Will my `src/foo.ts` get indexed? | Only if you pass `--strategy code` or `--strategy auto`. |
| Will autopilot sync code? | No. `runPhaseSync` calls `performSync` without a strategy, so it defaults to `markdown`. |
| Will autopilot sync markdown from a registered code repo? | Only if that repo is autopilot's `--repo` target. Other registered sources are NOT iterated by the daemon. |

## The strategy axis

Defined in `src/core/sync.ts:175-184`. Three values:

| Strategy | Picks up | Use when |
|---|---|---|
| `markdown` | `.md`, `.mdx` | Personal wiki / knowledge vault (the original gbrain use case) |
| `code` | 35+ code extensions via `detectCodeLanguage` | You only want code, never docs |
| `auto` | markdown + code (+ images if `GBRAIN_EMBEDDING_MULTIMODAL=true`) | Mixed-content repos: docs alongside source |

How it gets set:

- **CLI flag**: `gbrain sync --strategy auto`. Overrides everything else for that one run.
- **Per-source persistent**: `sources.config.strategy` JSONB field. Read by `sync --all` at `src/commands/sync.ts:1346`. There is **no CLI** to set this today — you write it via raw SQL:
  ```sql
  UPDATE sources
     SET config = config || '{"strategy":"auto"}'::jsonb
   WHERE id = '<source-id>';
  ```
- **Default**: when neither is set, `isSyncable` falls through to `'markdown'`. The autopilot cycle's sync phase (`src/core/cycle.ts:629`) does NOT pass a strategy, so autopilot defaults to markdown.

### Why the default is `markdown`, not `auto`

Three reasons, in order of weight:

1. **Embedding cost.** Code repos can hit 5-50× the chunk count of a
   knowledge vault. Defaulting to `auto` would silently 10× the OpenAI
   embedding bill for everyone who registered a `~/src/...` source for code
   search and didn't realize sync also walked it.
2. **Historical.** GBrain started as a Karpathy-style personal wiki. Code
   indexing arrived in v0.20+ as a separate layer (the "code surface"). The
   default never moved, to avoid changing behavior for existing users.
3. **Retrieval quality.** A knowledge-vault retrieval that also returns
   code snippets is noisier than one that doesn't. Users who want both opt
   in explicitly.

## The hard-coded skip list

`src/core/sync.ts:299`:

```ts
const skipFiles = ['schema.md', 'index.md', 'log.md', 'README.md'];
```

basename match at **every depth**. So `people/README.md`, `companies/acme/README.md`, `src/README.md` all get skipped. This applies regardless of strategy — even `--strategy auto` cannot rescue these files.

### Why these four are skipped

The rationale lives in `docs/GBRAIN_RECOMMENDED_SCHEMA.md`, not in the code comments. In gbrain's knowledge-vault world view, each filename has a designated **structural** role, not a knowledge role:

| File | Role in the vault | Why indexing it would hurt |
|---|---|---|
| `README.md` | Per-directory **resolver** — answers "what goes here, what doesn't" (see `docs/GBRAIN_RECOMMENDED_SCHEMA.md:27`) | A query for "people" would always return `people/README.md` (the routing rule) before any real person page |
| `schema.md` | The brain's own schema definition | Metadata about the brain, not knowledge inside it |
| `index.md` | Hand-maintained directory index — mostly links | Indexing it duplicates the link targets that already exist as their own pages |
| `log.md` | Append-only journal | Most entries already appear on a dedicated page's timeline section; double-indexing pollutes retrieval |

The vault model assumes every directory has a `README.md` that's a routing rule. Indexing those would mean the top hits for any high-level query are "rules about what goes in this category" instead of "actual things in this category". Excluding them is a curation decision — not a bug.

### Where the assumption breaks

The skip list is a **flat array of four filenames**, not a per-source or per-strategy decision. So:

- **Personal wiki user**: assumption holds. README.md really is the resolver. Skipping it is correct.
- **Code repo user**: assumption is wrong. `README.md` is often the **most knowledge-dense** file in the repo. Skipping it makes `gbrain query` blind to your most carefully-written prose.
- **Mixed source**: ambiguous. The same source might have `people/README.md` (a resolver — should skip) and `src/README.md` (project docs — should index). The current code cannot distinguish them.

This is a deliberate trade-off, not an oversight. The gbrain authors picked the personal-wiki default because that's the original target audience. Code-repo users have to work around it.

### Note on the skip list's irregularity

`RESOLVER.md` (the top-level decision tree document — even more clearly a "rule file" than `README.md`) is **not** in the skip list. The list is a hand-maintained empirical patch, not an output of some clean "meta-file type" abstraction. Don't assume future entries will be principled.

## The directory prune list

`src/core/sync.ts:236-281`. Walkers refuse to descend into:

- Anything starting with `.` (catches `.git`, `.obsidian`, `.cache`, etc.)
- `node_modules`
- `ops` (the gstack convention for operational state)
- `*.raw` (gbrain sidecar convention for raw source data)
- Git submodules (detected by `.git` as a *file* inside the candidate dir)

This list is less controversial — these are obvious "not source content" directories. If your code lives under one of these paths, that's a deeper convention mismatch and renaming the path is the right answer.

## User-configurable exclusion (v0.40.9.0)

Three layers of per-repo exclusion gate every walker pass and incremental diff filter. Each layer takes gitignore-style patterns (via the [`ignore`](https://www.npmjs.com/package/ignore) npm lib — same parser ESLint, Prettier, and Husky use, so muscle memory transfers).

### Layer 1 — `.gbrainignore` at the repo root

Drop a `.gbrainignore` file alongside `.gitignore`. Same syntax. Commits with the repo; every contributor and machine respects the same policy.

```
# .gbrainignore
data/
fixtures/large/
notebooks/scratch/
*.parquet
*.bin
```

Patterns parse on every sync (mtime-cached so the autopilot daemon picks up edits within one cycle). Comments (`#`) and blank lines are skipped. Up to 1000 lines per file.

### Layer 2 — `--exclude` CLI flag

Repeatable, one-shot. Merges on top of `.gbrainignore`:

```bash
gbrain sync --strategy auto --source my-repo --exclude 'tmp/**' --exclude '!data/keep.md'
```

The `--exclude` patterns win against the dotfile (last-match-wins per gitignore). Use this for ad-hoc rescues or to add exclusions without editing the committed dotfile.

### Layer 3 — per-source persistent config

Set on the source row itself; survives across syncs without a checked-in dotfile or a CLI flag:

```bash
# Set at source creation:
gbrain sources add my-repo --path /path/to/repo --exclude 'data/' --exclude '*.parquet'

# Or update an existing source:
gbrain sources update my-repo --exclude 'fixtures/' --exclude 'cache/'

# Reset to empty:
gbrain sources update my-repo --clear-excludes
```

The `--exclude` flag on `update` is additive (appends to the existing list, deduplicates). To replace the whole list, run `--clear-excludes` first, then `--exclude` in a second command.

### Merge order (gitignore last-match-wins)

```
[.gbrainignore patterns]
  ++ [sources.config.excludePatterns]
  ++ [--exclude CLI flags]
```

The CLI flag is appended last, so `--exclude '!data/keep.md'` can rescue a single file from a dotfile exclusion. **Important gitignore gotcha:** once a directory is excluded via `data/`, children cannot be re-included with `!data/keep.md`. The rescue pattern requires excluding contents instead:

```
data/*
!data/keep.md
```

This is documented gitignore behavior (`git-scm.com/docs/gitignore`), not a gbrain quirk.

### Auto-cleanup when patterns change

When `.gbrainignore` / `sources.config.excludePatterns` / `--exclude` flags change since the last sync, gbrain runs a reconciliation pass: walks existing pages for the source, deletes any whose path now matches an exclusion.

The pass is gated by a **safety guard**: if the proposed cleanup would delete more than 50% of the source's pages OR more than 1000 pages absolute, gbrain refuses and asks you to confirm:

```bash
[reconcile-excludes] SAFETY GUARD TRIPPED:
  source: my-repo
  scanned: 12000 page(s)
  would delete: 8000 (66.7%)
  thresholds: >1000 absolute OR >50% ratio

  Patterns changed since last sync, but the proposed cleanup looks
  destructive. Inspect your .gbrainignore + sources.config.excludePatterns
  + any --exclude flags. To force the cleanup anyway, re-run with:
    gbrain sync --reconcile-excludes --yes --source my-repo
```

Without `--yes` the reconciliation hash isn't advanced — the same warning fires on every sync until you either fix your patterns or confirm the cleanup. This is the regression that catches a typo'd `**` from wiping a whole source by accident.

### Storage tier vs. exclusion

`gbrain.yml` `storage.db_only` and `.gbrainignore` are orthogonal:
- `storage.db_only` says "write this directory's pages to the DB but not to the git tree" (tier routing — the pages exist, just not on disk).
- `.gbrainignore` says "don't index this directory at all" (skip entirely — the pages never exist).

They can both list `data/` and the semantics compose: `data/` is skipped entirely by the dotfile, so `db_only` has nothing to route.

### Autopilot daemon respects all three layers

The autopilot daemon (`gbrain autopilot --install`) reads `cfg.strategy` and `cfg.excludePatterns` from each source's config at the start of every cycle. Per-source policy that `sync --all` honored before v0.40.9.0 now applies under autopilot too. `.gbrainignore` and CLI `--exclude` continue to apply by their normal mechanisms (the dotfile is loaded at walker entry; CLI flags only apply when the daemon invokes sync with them, which it doesn't by default — daemon-side `--exclude` would require a wrapper script).

## How to index code + markdown from one repo

Three approaches, ranked by maintainability:

### Option 1 — Per-sync override (one-off)

```bash
gbrain sync --strategy auto --source <id> --yes
```

Indexes code + markdown in a single pass. Not persistent — the next sync that doesn't pass `--strategy` reverts to markdown-only.

### Option 2 — Persist strategy on the source (recurring)

Write the strategy into `sources.config` so `sync --all` honors it:

```sql
UPDATE sources
   SET config = config || '{"strategy":"auto"}'::jsonb
 WHERE id = '<source-id>';
```

Then schedule periodic syncs:

```bash
gbrain sync --all --yes
```

`src/commands/sync.ts:1346` reads `cfg.strategy` per source and threads it into `performSync`.

**Caveat:** the autopilot daemon does NOT call `sync --all`. It runs `runCycle({ brainDir: repoPath })` against a single brainDir (`src/commands/autopilot.ts:511`), and `runPhaseSync` does not pass a strategy. So persisted strategy via this option requires you to run `gbrain sync --all` from your own cron / systemd / launchd job — not from the autopilot daemon.

### Option 3 — Two-stage sync (matches /sync-gbrain's design)

If you're already using the `/sync-gbrain` skill, it runs `gbrain sync --strategy code` for the code stage. Add a second stage for markdown:

```bash
gbrain sync --strategy code --source <id> --yes      # code stage
gbrain sync --strategy markdown --source <id> --yes  # markdown stage
```

Or short-circuit both into one `--strategy auto` call. Two-stage is useful when you want different cadences for the two file types (e.g., markdown every 5 min, code every hour).

## Workarounds for the hard-skipped filenames

Especially for `README.md` in code repos. None are perfect.

| Approach | Trade-off |
|---|---|
| Symlink `README.md` → `overview.md` and keep both | Two paths, one file. Some tools (GitHub) display README at the repo root; gbrain indexes `overview.md`. |
| Manually write the README content as a brain page via `gbrain put_page` | Disconnects from the file. Updates require re-running `put_page`, not just `git pull`. |
| Patch `src/core/sync.ts:299` to remove `'README.md'` from `skipFiles` | Library-wide change. Affects every source on this brain, including knowledge-vault sources where the skip is correct. Hard to maintain across `gbrain upgrade`. |
| Add per-source override for `skipFiles` (feature work) | Right long-term answer; not implemented today. Would require schema + CLI + new `isSyncable` plumbing. |

For most code-repo users, the symlink workaround is the lowest-friction path.

## References

- `src/core/sync.ts:138-184` — strategy filter implementation
- `src/core/sync.ts:236-281` — directory prune list
- `src/core/sync.ts:287-307` — `isSyncable` (the gate every file passes through)
- `src/core/sync.ts:299` — the hard-coded skip list itself
- `src/commands/sync.ts:1335-1348` — `sync --all` reads `cfg.strategy` per source
- `src/core/cycle.ts:616-668` — `runPhaseSync` in the autopilot cycle (does NOT pass strategy)
- `src/commands/autopilot.ts:511` — autopilot calls `runCycle` with a single `brainDir`
- `docs/GBRAIN_RECOMMENDED_SCHEMA.md:27-64` — design rationale for the per-directory `README.md` resolver convention
- `docs/guides/live-sync.md` — operational guide for keeping the index current
- `docs/guides/multi-source-brains.md` — source registration + federation
- `docs/architecture/brains-and-sources.md` — the brain/source dual-axis mental model
