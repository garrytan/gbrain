# GBrain v0.12 Graph Layer — Exact File-by-File Port Checklist

Date: 2026-04-18

## Goal

Port the useful graph-layer pieces from `upstream/garrytan/link-timeline-extract` onto Roger's current branch without importing the whole v0.12 / Minions / migration surface.

Current branch:
- `roger/m5-gbrain-hotfixes-2026-04-15`

Source branch:
- `upstream/garrytan/link-timeline-extract`

Recommended target branch to create:
- `roger/gbrain-v012-graph-layer-selective-port`

## High-level strategy

Do this in two waves.

### Wave 1 — High-confidence graph layer only
Ship:
- typed graph traversal
- `graph-query` CLI
- self-wiring auto-link on `put_page`
- DB-source backfill extraction
- schema updates required for typed links and timeline dedup

Do NOT ship yet:
- Minions/jobs queue
- full v0.12 migration orchestrator
- benchmark/docs churn
- backlink-boost ranking changes

### Wave 2 — Search/heuristic improvements after Wave 1 is stable
Consider porting later:
- richer `inferLinkType` heuristics
- founder-of fix
- optional backlink boost, but only if combined carefully with Roger's canonical exact-ranking logic

## Non-negotiable preservation rules

Keep Roger's current local fixes intact:
1. Obsidian wikilink extraction in `src/commands/extract.ts`
2. canonical exact-entity ranking in `src/core/search/hybrid.ts`
3. embedding coercion / NaN prevention in:
   - `src/core/utils.ts`
   - `src/core/pglite-engine.ts`
   - `src/core/postgres-engine.ts`

If a candidate hunk conflicts with one of those, Roger's current behavior wins unless explicitly reworked.

## Commit shortlist

Port now, manually:
- `29006a5` — graph schema/foundation
- `f22dcb2` — auto-link + DB extract + link-extraction library
- `f933b0d` — `graph-query` CLI

Port after Wave 1 stabilizes:
- `038f1ef` — better `inferLinkType` heuristics
- `cc028a7` — `founder of` fix

Bring tests from:
- `9520a80`

Skip for now:
- `dc52464`, `036ed3f`, `675f901`
- all Minions/jobs commits
- benchmark/doc packaging commits

## Exact file-by-file plan

### 1. `src/core/link-extraction.ts`
Source:
- add from `f22dcb2`
- later refine from `038f1ef` and `cc028a7`

Action:
- new file, port in full as a starting point

Why:
- this is the center of the graph-layer extractor:
  - `extractEntityRefs`
  - `extractPageLinks`
  - `inferLinkType`
  - `isAutoLinkEnabled`

Required follow-up BEFORE enabling on Roger's vault:
- extend it to support Obsidian wikilinks, because the upstream file does not appear to include Roger's `[[wikilink]]` handling
- port Roger's current Obsidian logic from `src/commands/extract.ts` into this shared extractor so both:
  - `put_page` auto-link
  - `extract --source db`
  understand Obsidian links

Keep:
- upstream typed-link inference structure

Add on top:
- Obsidian wikilink parsing from Roger branch
- slug normalization behavior that worked on Roger's vault

Tests to pair with it:
- `test/link-extraction.test.ts`
- Roger's current `test/extract.test.ts` Obsidian cases

### 2. `src/commands/graph-query.ts`
Source:
- add from `f933b0d`

Action:
- port nearly verbatim

Why:
- additive new command
- low conflict risk

Dependency:
- requires `traversePaths()` and `GraphPath`

Tests:
- `test/graph-query.test.ts`

### 3. `src/cli.ts`
Source:
- selective lines from `f933b0d`
- maybe tiny pieces from `29006a5`

Action:
- manual merge only

Port exactly:
- add `graph-query` to CLI command set
- add dispatch case that imports `./commands/graph-query.ts`
- add help text for `graph-query`

Do NOT copy wholesale:
- candidate branch also adds `jobs`, `apply-migrations`, `skillpack-check`, and other unrelated command changes

Preserve:
- Roger's existing local CLI/runtime behavior

### 4. `src/core/types.ts`
Source:
- selective pieces from `29006a5`

Action:
- manual merge

Port:
- `GraphPath` type
- any graph-health typing needed for traversal responses if required by engine signatures

Do not pull unrelated type churn unless needed to compile.

### 5. `src/core/engine.ts`
Source:
- selective pieces from `29006a5`

Action:
- manual merge

Port now:
- `getAllSlugs(): Promise<Set<string>>`
- `traversePaths(...)`
- optional: `removeLink(..., linkType?)`
- optional: `addTimelineEntry(..., opts?)`

Defer if staying minimal:
- `getBacklinkCounts(...)`
- `executeRaw(...)`

Reason:
- `graph-query` needs `traversePaths`
- DB extract path benefits from `getAllSlugs`
- typed link reconciliation benefits from link-type-aware remove behavior
- backlink-count support is mainly for ranking, which should be deferred until after graph-layer stabilization

### 6. `src/core/pglite-engine.ts`
Source:
- selective pieces from `29006a5`

Action:
- manual merge

Port now:
- `traversePaths(...)`
- `getAllSlugs()` if missing in current implementation
- link-type-aware `removeLink(...)` behavior if needed
- any timeline dedup support required by the updated schema/migrations

Defer initially:
- `getBacklinkCounts(...)`
- `executeRaw(...)` unless needed for your chosen extract implementation
- health-metric expansion (`link_coverage`, `timeline_coverage`, `most_connected`) unless you want to adopt the whole health model now

Preserve explicitly:
- current `coerceEmbeddingVector` import and usage
- current `getEmbeddingsByChunkIds(...)` behavior that avoids NaN regressions
- current `rowToChunk(...)` call patterns that rely on coercion

### 7. `src/core/postgres-engine.ts`
Source:
- selective pieces from `29006a5`
- tiny hook from `f22dcb2`

Action:
- manual merge

Port now:
- `traversePaths(...)`
- `getAllSlugs()` if missing
- link-type-aware `removeLink(...)` behavior if needed
- timeline-entry dedup support if needed by schema changes

Defer initially:
- `getBacklinkCounts(...)`
- `executeRaw(...)` unless needed immediately
- broader health-metric expansion

Preserve explicitly:
- Roger's current embedding handling
- no regression in `getEmbeddingsByChunkIds(...)`

### 8. `src/core/import-file.ts`
Source:
- selective pieces from `29006a5`
- note: this file is also needed by `f22dcb2` behavior

Action:
- manual merge

Port:
- `ParsedPage` result metadata so `put_page` auto-link can reuse parsed content
- `parsedPage` return on both:
  - `status='imported'`
  - `status='skipped'`

Preserve:
- Roger's current `noEmbed` behavior

Reason:
- current branch already has `noEmbed`
- candidate adds `parsedPage`, which is the piece you need

### 9. `src/core/operations.ts`
Source:
- selective pieces from `f22dcb2`
- small dependencies from `29006a5`

Action:
- manual merge only

Port now:
- updated `put_page` description if desired
- `put_page` post-hook that runs auto-link after import
- `runAutoLink(...)`
- imports of:
  - `extractPageLinks`
  - `isAutoLinkEnabled`
- support for using `parsedPage` from `importFromContent`

Do NOT port wholesale:
- candidate file also contains unrelated security hardening and upload validation helpers:
  - `validateUploadPath`
  - `validatePageSlug`
  - `validateFilename`
- unless you explicitly want those now, keep them out of this selective graph-layer pass

Important local adjustment:
- `runAutoLink(...)` must use a link extractor that understands Roger's Obsidian wikilinks before enabling on real content

### 10. `src/commands/extract.ts`
Source:
- selective pieces from `f22dcb2`

Action:
- manual merge only

Keep from Roger branch:
- `extractObsidianWikilinks(...)`
- filesystem extraction path
- current slug normalization fixes
- current tests covering Obsidian links and uppercase filenames

Port from candidate:
- `runExtractCore(...)`
- `--source db` path
- `extractLinksFromDB(...)`
- `extractTimelineFromDB(...)`
- any safe command-line parsing additions needed for DB-source extraction

Important rule:
- if DB-source extraction uses `link-extraction.ts`, that shared extractor must be Obsidian-aware before you turn it on for the Winston vault

### 11. `src/schema.sql`
Source:
- selective graph-specific pieces from `29006a5`

Action:
- manual merge, minimal only

Port now:
- change links uniqueness from:
  - `UNIQUE(from_page_id, to_page_id)`
  to:
  - `UNIQUE(from_page_id, to_page_id, link_type)`
- add timeline dedup index:
  - `(page_id, date, summary)`
- optionally drop the legacy timeline trigger if it is obsolete under the new graph/timeline approach

Do NOT port:
- `minion_jobs`
- `minion_inbox`
- `minion_attachments`
- pg notify trigger for minion jobs
- related RLS/minion additions tied to the queue system

### 12. `src/core/migrate.ts`
Source:
- do NOT port wholesale from candidate

Action:
- create new local graph-only migrations on top of Roger's current migration chain

Reason:
- Roger branch currently stops at version 4
- candidate branch versions 5/6/7 are Minions-related
- graph layer is renumbered there to 8/9/10 because Minions landed first
- importing candidate migrate file as-is would drag in Minions migrations you do not want

Recommended local plan:
- add new local migration 5:
  - widen links uniqueness to include `link_type`
  - deduplicate any conflicting rows first
- add new local migration 6:
  - add timeline dedup index
  - remove old timeline trigger if safe

Only add a migration 7 if you need an app-level graph backfill helper, but prefer keeping backfill as a command rather than forced migration.

### 13. `src/core/pglite-schema.ts`
### 14. `src/core/schema-embedded.ts`
Source:
- do NOT port wholesale from candidate

Action:
- manually mirror only the graph-specific schema changes from `src/schema.sql`

Port:
- links uniqueness by `link_type`
- timeline dedup index

Do NOT port:
- any `minion_*` tables or indexes

### 15. `src/core/search/hybrid.ts`
Source:
- candidate branch has major changes from `29006a5`

Action:
- do NOT port in Wave 1

Reason:
- candidate branch removes Roger's canonical exact-ranking logic:
  - `EXACT_CANONICAL_PATH_BOOST`
  - `applyQueryAwareBoosts(...)`
- candidate branch replaces this with backlink boosting
- this is the highest regression risk for Roger's real vault

Wave 1 rule:
- keep Roger's current `hybrid.ts` unchanged

Wave 2 optional:
- if graph layer stabilizes, manually add `applyBacklinkBoost(...)` under the existing exact-ranking logic rather than replacing it
- do not adopt candidate ranking logic wholesale

### 16. `src/core/utils.ts`
Source:
- candidate branch is not better than Roger's current version here

Action:
- keep Roger's current file unchanged

Reason:
- current branch has `coerceEmbeddingVector(...)`
- candidate branch appears not to preserve the stronger coercion helper

### 17. Tests to bring over now
Source:
- `9520a80`

Action:
- port these first or very early

Bring now:
- `test/extract-db.test.ts`
- `test/graph-query.test.ts`
- `test/link-extraction.test.ts`
- `test/e2e/graph-quality.test.ts`

Merge carefully if needed:
- `test/pglite-engine.test.ts`

Keep Roger's current tests:
- `test/extract.test.ts`
- `test/search.test.ts`
- `test/utils.test.ts`
- `test/e2e/search-quality.test.ts`

## Suggested Wave 1 implementation order

1. Add tests:
- `test/extract-db.test.ts`
- `test/graph-query.test.ts`
- `test/link-extraction.test.ts`
- `test/e2e/graph-quality.test.ts`

2. Add new file:
- `src/core/link-extraction.ts`
- immediately patch it to support Obsidian wikilinks before enabling it

3. Add graph traversal foundations:
- `src/core/types.ts`
- `src/core/engine.ts`
- `src/core/pglite-engine.ts`
- `src/core/postgres-engine.ts`

4. Add `graph-query`:
- `src/commands/graph-query.ts`
- `src/cli.ts`

5. Add `importFromContent` parsed-page support:
- `src/core/import-file.ts`

6. Add auto-link hook and DB extract:
- `src/core/operations.ts`
- `src/commands/extract.ts`

7. Add graph-only schema migrations:
- `src/schema.sql`
- `src/core/migrate.ts`
- `src/core/pglite-schema.ts`
- `src/core/schema-embedded.ts`

8. Run both old and new tests

## Suggested Wave 2 implementation order

1. Port `038f1ef` heuristic improvements into `src/core/link-extraction.ts`
2. Port `cc028a7` founder-of fix
3. Re-run graph and exact-entity tests
4. Only then consider optional backlink boosting in `src/core/search/hybrid.ts`

## Minimum verification commands

```bash
cd ~/Projects/gbrain
bun test test/extract.test.ts test/utils.test.ts test/search.test.ts test/e2e/search-quality.test.ts
bun test test/extract-db.test.ts test/graph-query.test.ts test/link-extraction.test.ts test/e2e/graph-quality.test.ts
```

Smoke checks after Wave 1:

```bash
gbrain query "Roger Gimbel"
gbrain query "Rodaco"
gbrain query "SelfGrowth"
gbrain graph-query companies/rodaco --type works_at --direction in
```

## Acceptance criteria

Wave 1 is good enough when:
- Obsidian wikilinks still extract correctly
- exact canonical ranking is unchanged or better
- no NaN scores
- `graph-query` works
- `put_page` auto-link works
- DB-source extract works
- no Minions/jobs code is pulled in

## Bottom line

Port the graph layer, not the branch.

Exact instruction:
- manually merge graph foundations and graph-query
- adapt the shared extractor to Roger's Obsidian reality before enabling auto-link
- keep Roger's ranking and embedding fixes untouched in Wave 1
- treat backlink boosting as a separate later experiment, not part of the first port
