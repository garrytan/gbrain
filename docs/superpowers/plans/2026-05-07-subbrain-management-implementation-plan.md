# Sub-Brain Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add explicit registered sub-brains so one MBrain database can sync and write back to multiple git repos under a non-git `brain/` container.

**Architecture:** Store the registry in engine config as `subbrains.v1`, keep legacy single-repo sync untouched, and add sub-brain target resolution that namespaces checkpoints and slugs by registered id/prefix. Reuse existing markdown import and `put_page` safety checks by threading an optional slug prefix and repo-relative write path through existing helpers.

**Tech Stack:** Bun, TypeScript, existing `BrainEngine` config API, existing CLI command loaders, existing `Operation` registry, SQLite test engine, `bun test`.

---

## Scope Boundaries

- Implement explicit registration only; do not auto-discover nested git repos.
- Preserve legacy `mbrain sync --repo <path>` and configured `mbrain sync`.
- Use engine config, not a new database table.
- Use mandatory prefixes for registered sub-brains.
- Do not add git commit/push orchestration for sub-brain repos.
- Keep watch-mode changes minimal: route `--subbrain` and `--all-subbrains` through the same polling loop after one-shot sync supports them.

## File Structure

### Production Files

- Create: `src/core/subbrains.ts`
  - Registry parsing, validation, serialization, lookup, and prefix mapping.
- Create: `src/commands/subbrain.ts`
  - CLI command for `add`, `list`, and `remove`.
- Modify: `src/cli.ts`
  - Register `subbrain`; extend sync CLI spec with `subbrain` and `all_subbrains`; pass new sync flags into watch routing.
- Modify: `src/core/sync.ts`
  - Add helpers that derive prefixed slugs from repo-relative paths.
- Modify: `src/core/import-file.ts`
  - Allow import callers to supply a canonical slug prefix while preserving repo-relative manifest path.
- Modify: `src/core/services/import-service.ts`
  - Thread optional `slugPrefix` and optional sync metadata control through full imports.
- Modify: `src/commands/sync.ts`
  - Resolve legacy, single sub-brain, and all-sub-brain targets; namespace checkpoints; aggregate all-sub-brain results.
- Modify: `src/core/operations.ts`
  - Add `subbrain` and `all_subbrains` params to `sync_brain`; resolve prefixed `put_page` markdown targets.

### Test Files

- Create: `test/subbrains.test.ts`
- Create: `test/subbrain-command.test.ts`
- Modify: `test/sync.test.ts`
- Modify: `test/sync-command.test.ts`
- Modify: `test/page-write-precondition.test.ts`

---

## Task 1: Registry Helpers And CLI

**Files:**
- Create: `src/core/subbrains.ts`
- Create: `src/commands/subbrain.ts`
- Modify: `src/cli.ts`
- Test: `test/subbrains.test.ts`
- Test: `test/subbrain-command.test.ts`

- [ ] **Step 1: Write failing registry tests**

Create `test/subbrains.test.ts` with tests for empty registry parsing, add/remove serialization, duplicate id rejection, duplicate prefix rejection, invalid prefix rejection, and prefix slug mapping.

Run:

```bash
bun test test/subbrains.test.ts
```

Expected: FAIL because `src/core/subbrains.ts` does not exist.

- [ ] **Step 2: Implement registry helper**

Create `src/core/subbrains.ts` with:

```ts
export const SUBBRAIN_REGISTRY_CONFIG_KEY = 'subbrains.v1';

export interface SubbrainConfig {
  id: string;
  path: string;
  prefix: string;
  default?: boolean;
}

export interface SubbrainRegistry {
  subbrains: Record<string, SubbrainConfig>;
}
```

Add pure helpers:

- `parseSubbrainRegistry(raw: string | null): SubbrainRegistry`
- `serializeSubbrainRegistry(registry: SubbrainRegistry): string`
- `validateSubbrainId(value: string): string`
- `validateSubbrainPrefix(value: string): string`
- `addSubbrainToRegistry(registry, input)`
- `removeSubbrainFromRegistry(registry, id)`
- `findSubbrainBySlugPrefix(registry, slug)`
- `stripSubbrainPrefix(subbrain, slug)`

- [ ] **Step 3: Run registry tests**

Run:

```bash
bun test test/subbrains.test.ts
```

Expected: PASS.

- [ ] **Step 4: Write failing subbrain command tests**

Create `test/subbrain-command.test.ts` with fake engine tests for:

- `runSubbrain add personal <git repo> --default`
- `runSubbrain list --json`
- `runSubbrain remove personal`
- rejecting non-git paths

Run:

```bash
bun test test/subbrain-command.test.ts
```

Expected: FAIL because `src/commands/subbrain.ts` does not exist.

- [ ] **Step 5: Implement `mbrain subbrain` command**

Create `src/commands/subbrain.ts` exporting `runSubbrain(engine, args)`.

Support:

```bash
mbrain subbrain add <id> <path> [--prefix <prefix>] [--default]
mbrain subbrain list [--json]
mbrain subbrain remove <id>
```

Register it in `src/cli.ts` under `DIRECT_ENGINE_COMMANDS` and add help text.

- [ ] **Step 6: Run command tests**

Run:

```bash
bun test test/subbrain-command.test.ts test/subbrains.test.ts
```

Expected: PASS.

## Task 2: Prefixed Import And Slug Helpers

**Files:**
- Modify: `src/core/sync.ts`
- Modify: `src/core/import-file.ts`
- Modify: `src/core/services/import-service.ts`
- Modify: `test/sync.test.ts`

- [ ] **Step 1: Write failing slug/import tests**

Add tests proving:

```ts
expect(pathToSlug('people/alice.md', 'personal')).toBe('personal/people/alice');
expect(pathToSlug('people/alice.md', 'office')).toBe('office/people/alice');
```

Add import tests that import `people/alice.md` with `slugPrefix: 'personal'`
and expect the DB slug `personal/people/alice` while manifest path remains
`people/alice.md`.

Run:

```bash
bun test test/sync.test.ts test/import-service.test.ts
```

Expected: FAIL until import APIs accept `slugPrefix`.

- [ ] **Step 2: Thread `slugPrefix` through import APIs**

Update:

```ts
importFromFile(engine, filePath, relativePath, { noEmbed, slugPrefix })
```

Derive expected slug with:

```ts
const expectedSlug = pathToSlug(relativePath, options?.slugPrefix);
```

Keep manifest path as `relativePath`.

- [ ] **Step 3: Add import-service options**

Add `slugPrefix?: string` and `updateSyncMetadata?: boolean` to
`ImportRunOptions`. Use `slugPrefix` when calling `importFile`; skip
`updateImportGitState` when `updateSyncMetadata === false`.

- [ ] **Step 4: Run import tests**

Run:

```bash
bun test test/sync.test.ts test/import-service.test.ts
```

Expected: PASS.

## Task 3: Sub-Brain Sync Targets

**Files:**
- Modify: `src/commands/sync.ts`
- Modify: `src/core/operations.ts`
- Modify: `src/cli.ts`
- Modify: `test/sync-command.test.ts`

- [ ] **Step 1: Write failing sync target tests**

Add tests for:

- `performSync(engine, { subbrain: 'personal' })` reads registry and writes
  `sync.subbrains.personal.last_commit`.
- `performSync(engine, { subbrain: 'personal' })` imports as
  `personal/people/alice`.
- `performSync(engine, { allSubbrains: true })` syncs registered siblings and
  keeps checkpoints independent.
- `repoPath` with `subbrain` rejects before syncing.

Run:

```bash
bun test test/sync-command.test.ts
```

Expected: FAIL until `SyncOpts` supports sub-brain targets.

- [ ] **Step 2: Implement sync target resolution**

Extend `SyncOpts`:

```ts
subbrain?: string;
allSubbrains?: boolean;
```

Add target helpers inside `src/commands/sync.ts`:

```ts
interface ResolvedSyncTarget {
  id: string | null;
  repoPath: string;
  slugPrefix?: string;
  statePrefix: string;
  legacy: boolean;
}
```

Legacy target uses `sync.last_commit`. Sub-brain target uses
`sync.subbrains.<id>.last_commit`.

- [ ] **Step 3: Apply target state and prefixing**

Use target state keys for checkpoint reads/writes. Use target `slugPrefix` for
incremental delete, rename, dry-run, pagesAffected, and import calls.

For full sync, call `runImportService` with:

```ts
slugPrefix: target.slugPrefix,
updateSyncMetadata: false,
```

Then write the target checkpoint in `performFullSync`.

- [ ] **Step 4: Update operation and CLI sync params**

Add `subbrain` and `all_subbrains` to `SYNC_CLI_SPEC` and `sync_brain`.
Normalize watch args for both flags.

- [ ] **Step 5: Run sync tests**

Run:

```bash
bun test test/sync-command.test.ts test/sync.test.ts
```

Expected: PASS.

## Task 4: Prefixed `put_page` Write-Back

**Files:**
- Modify: `src/core/operations.ts`
- Modify: `test/page-write-precondition.test.ts`

- [ ] **Step 1: Write failing write-back tests**

Add tests proving:

- with `subbrains.v1` configured, `put_page` for
  `personal/concepts/example` writes
  `<personal repo>/concepts/example.md`;
- the imported DB page remains `personal/concepts/example`;
- prefix-only slug `personal` is rejected;
- unknown prefix falls back only when explicit `repo` is provided.

Run:

```bash
bun test test/page-write-precondition.test.ts
```

Expected: FAIL until `put_page` resolves registered sub-brain prefixes.

- [ ] **Step 2: Resolve markdown target by sub-brain prefix**

In `resolvePutPageMarkdownRepoPath` and `putPageMarkdownTarget`, add a resolver
that reads `subbrains.v1`, matches the first slug segment, strips the prefix for
the repo-relative file path, and returns:

```ts
{
  repoPath: subbrain.path,
  relativePath: 'concepts/example.md',
  filePath: '<subbrain repo>/concepts/example.md',
  slugPrefix: 'personal'
}
```

- [ ] **Step 3: Import prefixed write-back content**

When `put_page` reimports a markdown target, call:

```ts
importFromFile(tx, markdownTarget.filePath, markdownTarget.relativePath, {
  slugPrefix: markdownTarget.slugPrefix,
});
```

- [ ] **Step 4: Run write-back tests**

Run:

```bash
bun test test/page-write-precondition.test.ts
```

Expected: PASS.

## Task 5: Documentation And Final Verification

**Files:**
- Modify: `README.md`
- Modify: `docs/guides/live-sync.md`

- [ ] **Step 1: Add docs examples**

Document:

```bash
mbrain subbrain add personal ~/brain/personal --prefix personal --default
mbrain subbrain add office ~/brain/office --prefix office
mbrain sync --all-subbrains
mbrain embed --stale
```

- [ ] **Step 2: Run focused suite**

Run:

```bash
bun test test/subbrains.test.ts test/subbrain-command.test.ts test/sync.test.ts test/sync-command.test.ts test/import-service.test.ts test/page-write-precondition.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run broader regression suite**

Run:

```bash
bun test --timeout 20000
```

Expected: PASS or report any pre-existing/unrelated failures with evidence.

- [ ] **Step 4: Build**

Run:

```bash
bun run build
```

Expected: exit 0.

- [ ] **Step 5: Commit implementation**

Commit only files touched for this feature.
