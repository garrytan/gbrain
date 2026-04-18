# GBrain v0.12 Selective Port Plan

Date: 2026-04-18

## Goal

Adopt the useful parts of the GBrain v0.12 graph layer from `upstream/garrytan/link-timeline-extract` without doing a full runtime cutover and without regressing Roger's current local fixes for:
- Obsidian wikilink extraction
- canonical exact-entity ranking
- embedding coercion / NaN score prevention

## Source branches

Current branch:
- `roger/m5-gbrain-hotfixes-2026-04-15`

Candidate upstream branch:
- `upstream/garrytan/link-timeline-extract`

Shared base:
- `b7e3005` (`v0.10.1` era)

## Decision summary

Do not wholesale cherry-pick the branch.

Use a mixed strategy:
- manual port for foundational graph/schema/engine changes that overlap with Roger's hotfixes
- direct cherry-pick or file-copy for mostly additive tests
- skip Minions/jobs/migration/docs churn for now

## Recommended buckets

### Bucket A — Port manually, not raw cherry-pick

These commits are valuable but overlap too heavily with Roger's branch.

1. `29006a5`
- `feat(schema): graph layer migrations v5/v6/v7 + GraphPath/health types`
- Why valuable:
  - adds typed graph path model
  - adds engine support for traversal/backlink counts
  - foundational schema for graph-query
- Why not cherry-pick directly:
  - overlaps with Roger-edited files:
    - `src/core/pglite-engine.ts`
    - `src/core/postgres-engine.ts`
    - `src/core/search/hybrid.ts`
    - `src/cli.ts`
  - candidate branch appears to remove Roger's canonical exact-ranking logic in `hybrid.ts`
- Manual-port target files:
  - `src/core/engine.ts`
  - `src/core/types.ts`
  - selective parts of `src/core/pglite-engine.ts`
  - selective parts of `src/core/postgres-engine.ts`
  - selective schema changes from:
    - `src/core/pglite-schema.ts`
    - `src/core/schema-embedded.ts`
    - `src/schema.sql`
    - `src/core/migrate.ts`
- Explicit preserve rules:
  - keep Roger's `hybrid.ts` canonical exact-ranking behavior
  - keep Roger's embedding coercion fixes in utils/engine code

2. `f22dcb2`
- `feat(graph): auto-link on put_page + extract --source db + security hardening`
- Why valuable:
  - adds auto-link post-hook on page writes
  - adds `link-extraction.ts`
  - adds DB-backed extract path
- Why not cherry-pick directly:
  - overlaps with Roger-edited `src/commands/extract.ts`
  - candidate extract path appears to drop Roger's explicit Obsidian wikilink support
- Manual-port target files:
  - mostly take `src/core/link-extraction.ts`
  - selectively merge `src/core/operations.ts`
  - selectively merge DB-source extract logic from `src/commands/extract.ts`
- Explicit preserve rules:
  - keep Roger's `extractObsidianWikilinks` support and tests
  - keep Roger's slug normalization behavior where it fixed uppercase/Obsidian issues

3. `f933b0d`
- `feat(cli): graph-query command + skill updates + v0.10.3 migration file`
- Why valuable:
  - adds the actual `gbrain graph-query` CLI
- Why not cherry-pick directly:
  - depends on graph traversal support from `29006a5`
  - touches `src/cli.ts`, already modified locally
- Manual-port target files:
  - `src/commands/graph-query.ts`
  - small `src/cli.ts` wiring only

### Bucket B — Good follow-up logic once Bucket A is stable

4. `038f1ef`
- `fix(link-extraction): inferLinkType prose precision — type accuracy 70.7% -> 88.5%`
- Use after the graph layer is working.
- Port only the heuristic changes in `src/core/link-extraction.ts` and the related tests.

5. `cc028a7`
- `fix(link-extraction): "founder of" pattern + benchmark methodology fix → recall jumps to 93%`
- Also a good follow-up once `link-extraction.ts` is in place.
- Port only the heuristic tweak plus related tests.

### Bucket C — Bring over tests early

6. `9520a80`
- `test(graph): unit + e2e + 80-page A/B/C benchmark for graph layer`
- Mostly additive and high-value.
- Safest pieces to bring first:
  - `test/extract-db.test.ts`
  - `test/graph-query.test.ts`
  - `test/link-extraction.test.ts`
  - `test/e2e/graph-quality.test.ts`
- Leave benchmark mega-file optional if it slows iteration.
- `test/pglite-engine.test.ts` will likely need manual merge because Roger already has local edits elsewhere in engine behavior.

### Bucket D — Skip for now

Do not port these yet:
- `dc52464` / `036ed3f`
  - migration/orchestrator renumbering and v0.12 packaging
- `7d61134`, `ddcd35a`, `06e0888`, `675f901`
  - benchmark/doc packaging only
- `26a7203`, `d861336`, `53d63b6` and other Minions/jobs-related changes
  - too large and orthogonal to the graph-layer goal

## Port order

### Task 1: Create a new integration branch
- Branch from current Roger branch
- Suggested name:
  - `roger/gbrain-v012-graph-layer-selective-port`

### Task 2: Add tests first
- Bring in additive graph tests from `9520a80`
- Keep them failing initially if features are missing
- Prefer to land:
  - `test/extract-db.test.ts`
  - `test/graph-query.test.ts`
  - `test/link-extraction.test.ts`
  - `test/e2e/graph-quality.test.ts`

### Task 3: Port graph foundations from `29006a5`
- Manually merge schema/types/engine support
- Avoid replacing Roger's local ranking and embedding fixes
- Required outcome:
  - traversal path type exists
  - engine traversal exists
  - backlink count support exists

### Task 4: Port graph wiring from `f22dcb2`
- Add `src/core/link-extraction.ts`
- Add `put_page` auto-link hook selectively
- Add DB-source extract path selectively
- Keep Roger's Obsidian wikilink extraction path intact

### Task 5: Port `graph-query` from `f933b0d`
- Add `src/commands/graph-query.ts`
- Wire `src/cli.ts`

### Task 6: Improve type inference with `038f1ef` and `cc028a7`
- Port only the heuristic logic and matching tests

### Task 7: Verify against Roger's real concerns
Minimum checks after each stage:
- no NaN scores
- exact canonical ranking still prefers summary/status/readme/index pages
- Obsidian wikilinks still extract correctly
- graph-query returns useful typed traversals

## Files likely to need careful manual merge

Highest conflict risk:
- `src/commands/extract.ts`
- `src/core/operations.ts`
- `src/core/pglite-engine.ts`
- `src/core/postgres-engine.ts`
- `src/core/search/hybrid.ts`
- `src/core/utils.ts`
- `src/cli.ts`

Likely additive / safer:
- `src/commands/graph-query.ts`
- `src/core/link-extraction.ts`
- `test/extract-db.test.ts`
- `test/graph-query.test.ts`
- `test/link-extraction.test.ts`
- `test/e2e/graph-quality.test.ts`

## Verification commands

Run after each major integration step:

```bash
cd ~/Projects/gbrain
bun test test/extract.test.ts test/utils.test.ts test/search.test.ts test/e2e/search-quality.test.ts
```

After graph port pieces land, also run:

```bash
cd ~/Projects/gbrain
bun test test/extract-db.test.ts test/graph-query.test.ts test/link-extraction.test.ts test/e2e/graph-quality.test.ts
```

And verify live-query behavior in staging:

```bash
gbrain query "Roger Gimbel"
gbrain query "Rodaco"
gbrain query "SelfGrowth"
gbrain graph-query companies/rodaco --type works_at --direction in
```

## Acceptance criteria

A successful selective port preserves all of Roger's current wins while adding the v0.12 graph value:
- Obsidian wikilinks still extract correctly
- canonical exact entity search still prefers summary/status/readme/index pages
- no NaN score regressions
- `gbrain graph-query` works
- auto-link on page write works
- typed link inference works for at least the main relation types
- Minions/jobs code is not pulled into the runtime yet

## Recommendation

Best path: port a narrow graph layer, not the whole branch.

Specifically:
- manually port `29006a5`, `f22dcb2`, `f933b0d`
- then selectively port heuristic improvements from `038f1ef` and `cc028a7`
- use tests from `9520a80` to keep the integration honest
