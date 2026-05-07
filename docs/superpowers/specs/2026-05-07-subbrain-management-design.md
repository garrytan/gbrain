# Sub-Brain Management for MBrain

## Purpose

This design lets one MBrain database manage a non-git `brain/` container that
holds multiple git-backed sub-brains:

```text
brain/
  personal/    # git repo
    .git/
  office/      # git repo
    .git/
  research/    # git repo
    .git/
```

The user-facing goal is to keep today's MBrain read, search, query, and write
workflow while allowing each sub-brain to keep its own git remote, history, and
sync checkpoint.

## Problem

The current sync implementation assumes a single git repo:

- `mbrain sync --repo <path>` resolves one repo path.
- `sync.repo_path` stores one configured repo.
- `sync.last_commit` stores one global checkpoint.
- `markdown.repo_path` stores one markdown write-back root.
- Slugs are derived from repo-relative paths, so `people/alice.md` imports as
  `people/alice`.

That model breaks when `brain/` is only a container and `brain/personal`,
`brain/office`, and other children are independent git repos. A single global
checkpoint cannot safely track multiple histories, and unprefixed slugs collide
when different sub-brains contain the same relative page path.

## Goals

1. Support explicitly registered git-backed sub-brains under a non-git
   container directory.
2. Preserve existing single-repo behavior for `mbrain sync --repo <path>`.
3. Keep one MBrain database and one global search/query surface across all
   registered sub-brains.
4. Store independent sync checkpoints per sub-brain.
5. Prevent slug collisions between sub-brains.
6. Make `put_page` and MCP writes deterministically write back to the correct
   sub-brain repo.
7. Keep changes scoped to sync, registration, slug mapping, and markdown
   write-back behavior.

## Non-Goals

- Do not make the top-level `brain/` container a git repo.
- Do not introduce a new database table unless the config-backed registry proves
  insufficient.
- Do not auto-discover and sync arbitrary nested git repos without registration.
- Do not change search/query semantics beyond the presence of prefixed slugs.
- Do not migrate existing single-repo users into the sub-brain model
  automatically.
- Do not implement cross-sub-brain git commits, pushes, or remote management in
  this phase.

## Approaches Considered

### Engine-Backed Registry

Store registered sub-brains in engine config and expose `mbrain subbrain`
commands:

```text
subbrains.v1 = {
  "personal": { "path": "/Users/meghendra/brain/personal", "prefix": "personal", "default": true },
  "office": { "path": "/Users/meghendra/brain/office", "prefix": "office" }
}
```

Sync state is namespaced:

```text
sync.subbrains.personal.last_commit
sync.subbrains.personal.last_run
sync.subbrains.office.last_commit
sync.subbrains.office.last_run
```

This is the recommended approach. It works through the same engine path as CLI
and MCP operations, avoids schema migrations, and keeps the registry close to
the database projection it controls.

### File-Backed Local Registry

Store registered sub-brains in local config, such as `~/.mbrain/config.json`,
while storing checkpoints in the engine. This makes local path edits easy, but
it splits behavior between local config and engine state. CLI and MCP/server
contexts can drift if they do not load the same file config.

This is not recommended for the first implementation.

### Container Manifest

Store a manifest in the non-git container:

```text
brain/.mbrain-subbrains.json
```

This matches the mental model of a container directory, but it introduces a new
container concept and a new manifest lifecycle. It also leaves open whether the
manifest should itself be backed up or synced.

This can be revisited later if the engine-backed registry becomes too hidden
for users.

## Recommended Design

Add an explicit sub-brain registry backed by engine config.

Each sub-brain has:

- `id`: stable CLI identifier, such as `personal`.
- `path`: absolute or normalized path to a git repo.
- `prefix`: slug namespace, defaulting to `id`.
- `default`: optional boolean used for convenience in future workflows.

Example setup:

```bash
mbrain subbrain add personal ~/brain/personal --prefix personal --default
mbrain subbrain add office ~/brain/office --prefix office
mbrain subbrain list
mbrain subbrain remove office
```

Sync examples:

```bash
mbrain sync --subbrain personal
mbrain sync --subbrain office --full --no-pull
mbrain sync --all-subbrains
```

Existing single-repo sync remains valid and keeps its current state keys:

```bash
mbrain sync --repo ~/git/brain
```

The sync target modes are mutually exclusive:

- `--repo <path>` uses legacy single-repo behavior.
- `--subbrain <id>` syncs one registered sub-brain.
- `--all-subbrains` syncs every registered sub-brain.

## Registry Validation

`mbrain subbrain add` validates:

1. `id` is a valid slug segment.
2. `prefix` is a valid slug segment.
3. `id` is unique.
4. `prefix` is unique across registered sub-brains.
5. `path` exists and is a directory.
6. `path/.git` exists.
7. `path` is not a symlinked repo root.

Reserved ids and prefixes include hidden names and operational names that should
not become page namespaces:

- `.git`
- `node_modules`
- `ops`
- empty strings

`remove` updates `subbrains.v1` and leaves old namespaced checkpoint config keys
behind as harmless stale metadata. A later cleanup command can delete stale
checkpoint keys if needed.

## Sync Behavior

Sub-brain sync reuses the current git diff and import pipeline, but runs with a
target descriptor:

```ts
interface SyncTarget {
  id: string;
  repoPath: string;
  slugPrefix: string;
  stateMode: 'legacy' | 'subbrain';
}
```

Legacy sync reads and writes:

```text
sync.repo_path
markdown.repo_path
sync.last_commit
sync.last_run
```

Sub-brain sync reads and writes:

```text
subbrains.v1
sync.subbrains.<id>.last_commit
sync.subbrains.<id>.last_run
```

Sub-brain sync must not overwrite global `sync.repo_path` or
`markdown.repo_path` with the child repo path. Those global keys remain the
legacy single-repo defaults.

For `--all-subbrains`, each sub-brain sync is independent:

- A successful sub-brain advances only its own checkpoint.
- A failing sub-brain does not advance its checkpoint.
- Other sub-brains may still sync in the same run.
- The command exits with failure if any sub-brain fails.
- Output reports per-sub-brain status.

Watch mode may support `--subbrain` and `--all-subbrains`, but it should reuse
the same polling model as existing watch sync. Consecutive failure accounting
should be based on full polling cycles, with per-sub-brain errors printed in the
cycle output.

## Slug Namespacing

Registered sub-brains use mandatory prefixes.

```text
~/brain/personal/people/alice.md -> personal/people/alice
~/brain/office/people/alice.md   -> office/people/alice
```

This avoids collisions in the global `pages.slug` namespace.

Prefixing applies consistently to:

- full sync imports
- incremental add/modify imports
- delete handling
- rename handling
- dry-run output
- `pagesAffected`
- note manifest and section entries where the page slug is stored

The physical manifest path should remain repo-relative:

```text
page slug: personal/people/alice
manifest path: people/alice.md
```

This preserves the distinction between the database namespace and the physical
file path inside the sub-brain repo.

## Frontmatter Slug Rules

Sub-brain imports must validate frontmatter against the prefixed canonical slug.

For this file:

```text
~/brain/personal/people/alice.md
```

Valid frontmatter slug:

```yaml
slug: personal/people/alice
```

Invalid frontmatter slug:

```yaml
slug: people/alice
```

Files without an explicit `slug:` continue to derive the canonical slug from
the prefixed import target.

This is stricter than accepting unprefixed frontmatter, but it avoids ambiguous
canonical identity.

## Markdown Write-Back

`put_page` currently resolves one markdown repo and writes `<repo>/<slug>.md`.
With registered sub-brains, it should first check whether the slug starts with a
registered prefix.

Mapping:

```text
personal/concepts/x -> ~/brain/personal/concepts/x.md
office/projects/y   -> ~/brain/office/projects/y.md
```

The resolver strips exactly the first slug segment when mapping to disk:

```text
slug: personal/people/alice
prefix: personal
repo-relative path: people/alice.md
```

Validation:

1. A prefixed slug must match exactly one registered sub-brain.
2. The path after the prefix must be non-empty.
3. Existing path traversal and symlink checks continue to apply.
4. Existing markdown conflict detection and rollback behavior continue to
   apply.
5. If no registered prefix matches, `put_page` falls back to current legacy
   repo resolution only when no sub-brain registry is active or an explicit
   `repo` parameter is supplied.

This keeps legacy single-repo writes working while making multi-brain writes
deterministic.

## CLI And Operation Contract

Add a CLI-backed `subbrain` command:

```bash
mbrain subbrain add <id> <path> [--prefix <prefix>] [--default]
mbrain subbrain list [--json]
mbrain subbrain remove <id>
```

Update both sync surfaces so CLI, MCP, and tools-json stay aligned:

- `src/cli.ts` sync help/spec
- `src/core/operations.ts` `sync_brain` operation
- `src/commands/sync.ts` runtime implementation

`sync_brain` gains:

- `subbrain`: string
- `all_subbrains`: boolean

Invalid combinations fail before sync starts:

- `repo` with `subbrain`
- `repo` with `all_subbrains`
- `subbrain` with `all_subbrains`

## Backward Compatibility

Existing users are unaffected when they do not register sub-brains.

The following behavior remains unchanged:

```bash
mbrain import ~/git/brain
mbrain sync --repo ~/git/brain
mbrain sync
mbrain put concepts/example < page.md
```

Legacy sync continues to use unprefixed slugs and global checkpoint keys.

Sub-brain behavior is opt-in through `mbrain subbrain add`.

## Error Handling

Expected user-facing errors:

- `No sub-brains registered. Run: mbrain subbrain add <id> <path>.`
- `Unknown sub-brain: <id>.`
- `Sub-brain path is not a git repository: <path>.`
- `Sub-brain prefix already exists: <prefix>.`
- `Slug does not match any registered sub-brain prefix: <slug>.`
- `Cannot combine --repo with --subbrain or --all-subbrains.`
- `Sub-brain sync failed for <id>; checkpoint was not advanced.`

Incremental sync keeps the current fail-closed checkpoint behavior. If a
syncable import fails, the sub-brain checkpoint is not advanced.

## Testing Plan

Unit tests:

1. Registry add/list/remove validation.
2. Duplicate id and duplicate prefix rejection.
3. Sync option validation for mutually exclusive target modes.
4. `pathToSlug` or equivalent helper prefixes sub-brain slugs.
5. Prefixed import rejects unprefixed conflicting frontmatter slug.
6. Write-back resolver maps `personal/foo/bar` to
   `<personal repo>/foo/bar.md`.
7. Write-back resolver rejects prefix-only slugs such as `personal`.

Integration tests:

1. Register `personal` and `office`, each with `people/alice.md`; sync both and
   verify both `personal/people/alice` and `office/people/alice` exist.
2. Modify only `personal`; sync `personal`; verify `office` checkpoint is
   unchanged.
3. Delete a file in `office`; sync `office`; verify only the prefixed office
   page is deleted.
4. Rename a file in `personal`; sync `personal`; verify prefixed rename behavior.
5. Run `sync --all-subbrains` where one sub-brain contains an invalid slug and
   verify successful siblings advance while the failing sibling does not.
6. Use `put_page` with `personal/concepts/test` and verify the physical file is
   written under the personal repo with repo-relative path `concepts/test.md`.
7. Run an existing legacy `sync --repo` test to verify unprefixed single-repo
   behavior remains unchanged.

Documentation checks:

1. Update README sync examples with the optional sub-brain flow.
2. Update live-sync guidance with `mbrain sync --all-subbrains && mbrain embed
   --stale`.

## Implementation Notes

Keep the implementation small and local:

- Add a sub-brain registry helper module instead of spreading JSON parsing
  across commands.
- Reuse the existing `config` table instead of introducing a migration.
- Thread an optional `slugPrefix` through sync/import paths instead of
  duplicating the importer.
- Reuse existing markdown write preflight and rollback code for sub-brain
  write-back.
- Keep legacy sync paths as the default code path for `--repo` and configured
  `sync.repo_path`.

The main implementation risk is full sync: it currently delegates to
`runImportService`, which also updates global sync metadata. Sub-brain full sync
must either pass metadata options into the import service or use an import path
that does not mutate legacy global sync keys.

## Acceptance Criteria

1. A user can register `personal` and `office` sub-brains under a non-git
   `brain/` container.
2. `mbrain sync --subbrain personal` imports pages as `personal/...`.
3. `mbrain sync --all-subbrains` syncs all registered sub-brains and reports
   per-sub-brain results.
4. Each sub-brain has an independent checkpoint.
5. `put_page` writes prefixed slugs back to the matching sub-brain repo.
6. Existing single-repo sync and write-back tests still pass unchanged.
