# Storage Tiering: db-tracked vs db-only directories

## Overview

GBrain supports storage tiering to separate version-controlled content from bulk machine-generated data. This prevents git repositories from becoming bloated with large amounts of automatically generated content while still preserving it in the database.

> Note on naming: the canonical keys are `db_tracked` / `db_only` (engine-agnostic — works on both PGLite and Postgres). The deprecated aliases `git_tracked` / `supabase_only` still load with a once-per-process warning; rename them in your config by hand to silence it.

## Configuration

Add a `storage` section to your `gbrain.yml` file in the brain repository root:

```yaml
storage:
  # Directories that are version-controlled (human-edited, committed to git).
  db_tracked:
    - people/
    - companies/
    - deals/
    - concepts/
    - yc/
    - ideas/
    - projects/

  # Directories persisted via the brain database only (bulk machine-generated
  # content). Written to disk as a local cache but not committed to git;
  # `gbrain sync` auto-manages .gitignore for these paths. `gbrain export
  # --restore-only` repopulates missing files from the database.
  db_only:
    - media/x/
    - media/articles/
    - meetings/transcripts/
```

Path requirements:

- Each directory must end with `/` for canonical form. The validator auto-normalizes missing trailing slashes (one-time info note shows what changed).
- A tier may also be a one-line flow list, `db_only: [media/x/, 'media/articles/']`. A flow list split over several lines, or a `db_only` key outside `storage:`, resolves no directory: `gbrain storage status` names it, and until it is fixed a managed sync keeps every live page whose file is gone (held as `file_drift` with reason `storage_invalid`) instead of deleting it, because it cannot tell which pages are database-only (#8007). A tier overlap holds them the same way, and so does a deprecated `supabase_only` list next to canonical keys, which canonical keys make gbrain ignore. `gbrain repair file-drift --prefer file` and `sync.apply_held_deletions` skip these pages while the config stays invalid. Fix `gbrain.yml`, commit it and sync again; the holds clear and each page is decided under the fixed config.
- A directory cannot appear in both tiers — that's a tier-overlap error and `loadStorageConfig` throws `StorageConfigError`. Edit `gbrain.yml` to remove the overlap and try again.
- Any other key under `storage:` is ignored with a warning naming it (a typo such as `kep_db` used to be ignored silently).

Optional: `keep_db:` lists directory prefixes whose drifted pages (the file and the database copy disagree, so writes refuse `source_changed`) the canonical owner host's resident consumer reconciles with the database copy, at most 10 every 10 minutes. It is opt-in, matches page slugs like the tiers, and changes nothing for other hosts or callers. See [the keep_db policy](guides/repair.md#file-drift-keep-db).

```yaml
storage:
  keep_db:
    - concepts/
```

## Behavior Changes

### 1. `gbrain sync` — automatic .gitignore management

When storage configuration is present, `gbrain sync` automatically manages `.gitignore` entries on every successful sync:

- Adds missing `db_only` directory patterns to `.gitignore`.
- A file under a `db_only` directory that git already tracked before the declaration stays tracked and shows as modified once the database updates it; untrack it with `git rm --cached <path>`. A managed sync never soft-deletes a live page under a declared `db_only` directory because its file left Git (untracked, ignored or gone): the database copy is canonical (#7324).
- Idempotent — re-running adds no duplicate entries.
- Stable comment header so the managed block is grep-able.
- Skipped on `--dry-run` (don't mutate disk in preview mode).
- Skipped on `blocked_by_failures` status (sync state is inconsistent).
- Skipped when the repo is a git submodule (`.git` is a file, not a directory) — submodule .gitignore changes don't survive parent updates. A warning explains.
- Skipped entirely when `GBRAIN_NO_GITIGNORE=1` is set (escape hatch for shared-repo setups where a maintainer wants gbrain to leave .gitignore alone).
- Failures (write permission denied, etc.) are caught and logged, never crash sync.
- Warns when a configured collector's declared output dir (recipe `output_paths`
  frontmatter) sits inside a `db_only` path: gitignored files never appear in the
  git-walking sync diff, and `gbrain import` honors `.gitignore` too — the
  collector would run green while nothing reaches the DB. The
  `db_only_collector_collision` doctor check surfaces the same trap.

Related doctor coverage: `undeclared_db_only_pages` warns about DB pages with no
backing file that sit outside every declared `db_only` path. The engine's own
derive-phase output prefixes (`life/events/`, `atoms/`, `extracts/`,
`dream-cycle-summaries/`) count as implicitly declared for that check, so healthy
brains stay quiet without adding them to `gbrain.yml`. They are NOT auto-added to
`.gitignore` — only explicitly declared `db_only` dirs are. Google and GitHub
connector sources running under managed persistence without a worktree binding
(`connector_database`) are skipped by that check: their pages live only in the
database by design, so no `gbrain.yml` is needed in the connector's directory.
Recover them with a full re-sync from the provider
(`gbrain sync --source <id> --full`).

Example `.gitignore` addition:

```gitignore
# Auto-managed by gbrain (db_only directories)
media/x/
media/articles/
meetings/transcripts/
```

### 2. `gbrain export --restore-only` — repopulate missing db_only files

```bash
# Restore only missing db_only files from the database.
gbrain export --restore-only --repo /path/to/brain

# Filter by page type.
gbrain export --restore-only --type media --repo /path/to/brain

# Filter by slug prefix.
gbrain export --restore-only --slug-prefix media/x/ --repo /path/to/brain

# Combine filters.
gbrain export --restore-only --type media --slug-prefix media/x/ --repo /path/to/brain
```

The `--restore-only` flag:

- Resolves repoPath via the chain `--repo` → typed `sources.getDefault()` → hard error.
  Never falls through to the current directory.
- Only exports pages that match `db_only` patterns AND are missing from disk.
- Ideal for container restart recovery and fresh clones.

### 3. `gbrain storage status` — storage-tier health dashboard

```bash
# Human-readable status.
gbrain storage status --repo /path/to/brain

# JSON output for scripts and orchestrators.
gbrain storage status --repo /path/to/brain --json
```

Output includes:

- Total page counts by storage tier.
- Disk usage breakdown by tier.
- Missing files that need restoration (top 10 shown; full list in `--json`).
- The `gbrain export --restore-only` command that restores them.
- Configuration validation warnings.
- Current tier directory listing.

Example output:

```
Storage Status
==============

Repository: /data/brain
Total pages: 15,243

Storage Tiers:
-------------
DB tracked:     2,156 pages
DB only:        12,887 pages
Unspecified:    200 pages

Disk Usage:
-----------
DB tracked:     45.2 MB
DB only:        2.1 GB

Missing Files (need restore):
-----------------------------
  media/x/tweet-1234567890
  media/x/tweet-0987654321
  ... and 47 more

Use: gbrain export --restore-only --source default --repo /data/brain

Configuration:
--------------
DB tracked directories:
  - people/
  - companies/
  - deals/

DB-only directories:
  - media/x/
  - media/articles/
  - meetings/transcripts/
```

Status picks the repo and source with the same rule as `gbrain export
--restore-only`, counts only that source's pages, and lists a page as missing
exactly when that export would restore it: the page is under a `db_only`
directory (even one nested in a `db_tracked` directory) and its recorded source
file, else `<slug>.md`, is absent from the repo. The `Use:` command therefore
writes exactly the listed files, into `--dir` (default `./export` under the
current directory, not into the repo). The repo path is shell-quoted, so the
line is safe to paste. Export refuses the whole restore when a page's recorded
path is unsafe or its file path runs through a symlink or has no unambiguous
native identity; status then names those pages under warnings (one line per
reason, with the first slug and a count) and prints the refusal instead of a
command, also when no file is left missing. When the source rule refuses (for example, a `--repo`
that no single active source owns, one registered only to an archived
source, or one inside an archived source's tree), status prints `Cannot suggest a restore command:` with the reason. It
then counts the pages of the active source that owns the repo path (its
`.gbrain-source` or the longest registered `local_path` containing it), or
every source's pages when no active source owns it.

## Restoring a page whose file is gone

On a classic brain (no managed persistence) sync keys a page on the file it
recorded (`source_path`). When that file leaves the checkout (`git rm
--cached`, an ignore rule, a deletion), sync soft-deletes the page. Restoring
it with `gbrain restore <slug> --force` while the restore writes no file
(`sync.write_through` off, a sandboxed agent, a database-only source) used to
bring the page back still recording the missing file, so the next
`gbrain sync --full` soft-deleted it again.

Since #6609 such a restore refuses with `source_changed` / detail
`canonical_file_absent`, restores nothing, and asks you to choose:

- **Keep it file-backed:** put the file back at its recorded path, commit it
  and run `gbrain sync --source <id>`. Sync restores the page from its file.
- **Keep it database-only:** `gbrain restore <slug> --source-id <id> --detach`
  (MCP `restore_page` with `detach: true`). The page is restored without its
  recorded file and stamped `pages.database_only_reason='detached'`, so no
  sync removes it. A file synced later at its path binds the page to it again
  and clears the stamp.

A file that is only missing on this host (an unpulled checkout, another
machine) never makes a page database-only by itself: detaching is always an
explicit choice. `--detach` is refused (`invalid_params`) when there is
nothing to detach (the page is not soft-deleted, its file is in place, or the
restore re-creates it).

A page under a declared `db_only` directory is canonical in the database, so
its `--detach` restore publishes database-only even on a managed checkout with
`sync.write_through` on (#7324): it keeps its page id, content and history,
forgets its recorded file, writes no file and leaves an ignored cache file
untouched. Its recorded file must still be gone from the syncable tree. A plain
restore of such a page keeps its recorded file and its cache file as before;
sync no longer deletes it either way.

Doctor `missing_recorded_files` warns about live pages whose recorded file is
not among the files `gbrain sync --full` enumerates (for example a page
restored the old way), so that sync would soft-delete them; it inspects at most
50,000 pages per source and asks you which of the choices above each page
gets. Managed sources are covered by `ghost_pages` instead.

## Validation

`loadStorageConfig` runs `normalizeAndValidateStorageConfig` after parsing:

- Auto-fixes (silent, with one-time info note showing what changed):
  - Missing trailing `/` is added: `'media/x'` → `'media/x/'`.
- Throws `StorageConfigError` (caller sees a clean exit-1 with actionable message):
  - Same directory in both `db_tracked` and `db_only` (ambiguous routing).

## Use cases

### Brain repository scaling

Perfect for brain repositories crossing 50K-200K+ files where:

- Core knowledge (people, companies, deals) remains git-tracked.
- Bulk data (tweets, articles, transcripts) moves to db_only.
- Development stays fast with smaller git repos.
- Full data remains available via the database.

### Container-based deployments

Essential for ephemeral container environments:

- Git repo contains only essential files.
- Container restarts don't lose db_only data.
- `gbrain export --restore-only` quickly restores bulk files when needed.
- Local disk acts as a cache layer.

### Multi-environment consistency

Enables consistent data access across environments:

- Development: small git clone, restore bulk data on demand.
- Production: full dataset via the database, selective local caching.
- CI/CD: fast tests with git-tracked data only.

## Migration strategy

1. **Assess current repository**: use `gbrain storage status` to understand current distribution.
2. **Plan directory structure**: identify which directories should be db_tracked vs db_only.
3. **Create `gbrain.yml`**: add storage configuration to the repository root.
4. **Test with dry-run**: `gbrain sync --dry-run` to verify behavior; `.gitignore` is NOT touched on dry-run.
5. **Run a real sync**: `gbrain sync` updates `.gitignore` automatically on success.
6. **Verify restore**: test `gbrain export --restore-only --repo .` against a small db_only directory.

## Best practices

- **Directory naming**: end storage paths with `/` (canonical form). The validator normalizes if you forget.
- **Start small**: begin with clearly machine-generated directories in `db_only`.
- **Address validation errors**: tier overlap is an error, not a warning. Fix it before sync.
- **Test restore**: regularly test `--restore-only` in staging environments.
- **Document decisions**: comment your `gbrain.yml` to explain tier choices.

## PGLite engine note

On the PGLite engine (gbrain's local-only embedded Postgres), the "DB" your db_only pages live in IS the local file gbrain uses for everything else. The `.gitignore` housekeeping still helps (keeps bulk content out of git history), but the offload-to-DB promise is technically vacuous. A once-per-process soft-warn explains when the engine is detected. To get full tiering, move the brain to Postgres with `gbrain migrate --to postgres` ([guide](guides/move-to-postgres.md)).

## Compatibility

- **Backward compatible**: systems without `gbrain.yml` work unchanged.
- **Progressive enhancement**: add configuration when needed.
- **Database unchanged**: all data remains in Postgres regardless of tier.
- **Export safety**: exports refuse collisions and occupied planned paths; use a fresh destination for each snapshot.
- **Deprecated keys**: `git_tracked` / `supabase_only` still load with a once-per-process warning.

## Safe export

`gbrain export` produces a point-in-time Markdown snapshot, not a full database
backup. It does not replace a verified PGLite/PostgreSQL backup or preserve all
database state. The existing `<slug>.md` and `.raw/<name>.json` layout is unchanged.

```sh
gbrain export --source default --dir './exports/default-new'
gbrain export --source=default --slug-prefix 'notes/' --dir './exports/notes-new'
gbrain export --restore-only --source default --repo './brain' --dir './restore-new'
```

Normal export without `--source` includes every source, including archived sources;
environment/dotfile defaults do not silently narrow it. An explicit source must be
active and registered. Restore-only selects one source, uses its storage tiering
configuration and checks the recorded file path before deciding a page is missing.
An ambiguous repo requires an explicit source. Restore-only writes to `--dir`, not
implicitly to `--repo`.

Source selection, page enumeration, canonical withdrawal overlays, tags and raw
sidecars share one repeatable-read transaction. A withdrawal committed before the
snapshot is reflected. A later withdrawal does not rewrite an already-created
historical export. Re-import is still subject to the current withdrawal ledger;
do not restore an old database over committed withdrawal intent.

All planned paths are staged privately before destination publication. Duplicate
slugs across sources, same-source aliases, case/Unicode aliases, page/sidecar and
file-prefix conflicts refuse without publishing files. Export sources separately
into fresh directories rather than changing their slug layout. Existing empty
destinations and unrelated files are preserved. An occupied planned file, sidecar
or reserved `.gbrain-export-status` path refuses; export never overwrites or prunes
unknown files and has no force option.

Publication uses the first-party native addon for Linux glibc/musl, macOS and
Windows on x64/arm64. Directory handles remain anchored, symlinks/reparse points
are rejected, and native no-replace operations publish complete leaves. Missing
addons or unsupported filesystem capabilities refuse rather than use an unsafe
pathname fallback. Windows destinations must use absolute drive paths, not UNC
or device namespaces. POSIX destinations must have no symlink ancestors; on macOS,
use physical paths rather than the conventional `/tmp` or `/var` aliases.
Use a directory controlled by the exporting operator; do not
concurrently rename the destination or its parent directories. Native confinement
is not a sandbox against another process running as the same operating-system user.

The reserved status file starts with `GBRAIN EXPORT INCOMPLETE`. Its final line is
`COMPLETE` only after data publication and flushes succeed. A nonzero exit means
the current run did not produce a complete new export; an occupied-path refusal
leaves an earlier completed export unchanged. A missing completion line or malformed
status marks newly published output as incomplete: preserve it for inspection and
retry into a **fresh** directory. Do not import a partial
export. Interruption or I/O failure can leave complete individual files plus the
incomplete marker; retry never deletes these or tries to guess ownership. Only a
completed run prints `Exported N pages` (or `Restored N pages`).

Enumeration uses 256-key batches, not OFFSET or a total-page cap. Private on-disk
SQLite staging is bounded to 8 GiB, individual payloads/withdrawal ledgers to 32 MiB,
and snapshot collection to ten minutes with a 60-second statement timeout. A page
stored in segments (over 1 MiB, see
[segmented page storage](guides/memory-boundaries.md#segmented-page-storage)) is
streamed to a staged file instead: its limit is the page ceiling plus 8 MiB of
metadata (256 MiB on Postgres, 128 MiB on PGLite), it needs that much free space
plus 512 MiB on the staging filesystem, and each MiB of it adds a second to the
collection limit. Reaching
a bound is failure, not truncation or success. Use `--source`, `--type` or
`--slug-prefix` to make smaller snapshots. These are fixed safety limits, not a
promise about export duration or a paid-work budget. No model provider is called.

The ten-minute collection limit includes time waiting for a remote database.
Page reads are sequential, so network latency can make a large remote snapshot
reach that limit even when its files fit the staging budget. Run the export near
the database or select smaller scopes. Separately exported scopes each have their
own snapshot time; together they are not one point-in-time database backup.

Within each key batch, export reads one source's capacity-checked withdrawal ledger
at a time and reuses it for that source's pages. It does not retain a whole-brain
ledger cache. Bodies and timelines without literal fact-marker text skip SQL
normalization; actual, malformed and orphan markers retain canonical fingerprinting.
