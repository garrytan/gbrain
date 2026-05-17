# MERGE_PHANTOMS — design retrospective + future implementation guide

**Status:** Deferred. The `gbrain merge-phantoms` command was built and then
stripped from PR #1010 before merge. This doc captures the full context for a
future agent to pick up the work with a cleaner abstraction.

**History pointers:**
- PR #1010 (`fix/entity-resolution-prefix-expansion`) — the resolver + stub-guard
  + backstop-audit work that DID land.
- Plan: `~/.claude/plans/mossy-popping-crown.md` (decisions D1–D9).
- Codex iteration commits: 32 commits on `fix/entity-resolution-prefix-expansion`,
  rounds 1–30. The stripped `src/commands/merge-phantoms.ts` and
  `test/merge-phantoms.test.ts` are recoverable from any commit between
  `c861b43a` (initial scaffold) and `7f7a080f` (round-30 final).

---

## Problem statement

Pre-v0.34.5, the entity resolver had this failure mode:

1. User says "I just talked to Alice" in a session.
2. `extract_facts` calls `resolveEntitySlug(engine, source_id, "Alice")`.
3. The resolver tries exact-match, then fuzzy via pg_trgm. Short bare names
   like "Alice" score below the 0.4 similarity threshold, so fuzzy fails.
4. Resolver falls through to `slugify("Alice")` → `"alice"`.
5. `writeFactsToFence(..., { slug: "alice" })` doesn't find `alice.md` on disk,
   so it calls `stubEntityPage("alice")` which produces a minimal stub:
   ```
   ---
   type: concept
   title: alice
   slug: alice
   ---

   # alice
   ```
6. A phantom page is born at the brain's root. The fact lands in its `## Facts`
   fence. The user's REAL `people/alice-example.md` doesn't see the fact.
7. Repeat for every bare-name reference. Over months, the brain accumulates a
   pile of phantom unprefixed entity pages (`alice.md`, `jared.md`, `diana.md`)
   splitting facts away from their canonical prefixed pages.

The phantom population on a real production brain (the original PR was filed
against an OpenClaw deployment) was in the hundreds.

---

## What the PR was supposed to do — the original three-layer fix

PR #1010 landed three independent layers, all of which are still in master:

1. **Resolver prefix expansion** (`src/core/entities/resolve.ts`). When a bare
   name's exact + fuzzy match fails, the resolver walks each configured entity
   directory (`entities.prefix_expansion_dirs`, default `['people', 'companies',
   'deals', 'topics', 'concepts']`) and queries `slug = '<dir>/<token>'` OR `slug
   LIKE '<dir>/<token>-%'`. Picks the highest-connection match. `Alice` now
   finds `people/alice-example` BEFORE falling through to slugify.

2. **Stub-creation guard** (`src/core/facts/fence-write.ts`). When
   `writeFactsToFence` would stub-create a new entity page whose slug has no
   directory prefix, it refuses and returns `stubGuardBlocked: true`. The
   guard also fires on existing stub-shaped files (post-round-24) and consults
   the DB body to avoid blocking legitimate DB-only pages (post-round-26).

3. **Backstop dropped-fact audit** (`src/core/facts/backstop.ts` +
   `src/core/facts/dropped-audit.ts`). When the stub-guard fires, the backstop
   no longer inserts a legacy-shape DB row (that path tripped the v0.32.2
   `extract_facts` reconciliation guard). Instead it appends a structured entry
   to `~/.gbrain/facts.dropped.jsonl` for operator recovery. The fact text is
   preserved verbatim so a future `gbrain replay-dropped` tool can re-process
   the entries once the canonical entity pages exist.

These three layers stop NEW phantom creation. They do not address the existing
pile.

---

## What `gbrain merge-phantoms` was supposed to do

D7 of the plan-eng-review (the user upgraded my "add to TODOs" recommendation
to "build it now in this PR") was a destructive operator command:

```
gbrain merge-phantoms [--dry-run] [--source SOURCE_ID] [--json]
```

For each unprefixed entity page in the brain:
1. Find the canonical target via prefix expansion (e.g. `alice` → `people/alice-example`).
2. Re-fence the phantom's active facts into the canonical's `## Facts` fence.
3. Soft-delete the phantom page (v0.26.5 destructive-guard machinery).
4. Hard-purge after 72h via the autopilot cycle's purge phase.

Stated simply: "find phantoms, merge them into their canonical, delete the
phantom." This sounded straightforward.

It was not.

---

## How it became a bug farm

The command was built in PR #1010 and reviewed by `codex review --base master`
30 times. Each round found 1-2 real bugs. By round 30 the file had grown to
~600 lines with 8 skip reasons, bi-directional drift detection, rollback
machinery on import failure, on-disk stub detection, DB stale-detection,
materialize-from-DB-before-fence, and tuple-set comparison for content drift.

Below is the round-by-round account. Each round found a real bug — codex
wasn't inventing problems. The patches WERE necessary given the chosen
abstraction. But the abstraction itself was wrong, which is why the work
never converged.

### The cascade table

| Round | Severity | Finding | Fix |
|-------|----------|---------|-----|
| 1 | P1 | Real names in test fixtures break `check:privacy` | Scrub to placeholders |
| 1 | P1 | Private OpenClaw-fork names in stripped proposal doc | Strip doc |
| 1 | P2 | Full table GROUP-BYs in connection-count query | Correlated subqueries |
| 2 | P1 | Backstop legacy-DB insert trips v0.32.2 extract_facts guard | Drop fact + JSONL audit |
| 2 | P2 | Merge UPDATE only moves entity_slug, leaves source_markdown_slug stale | Re-fence into canonical |
| 3 | P2 | Resolver misses `<dir>/<token>` (no hyphen suffix) | Match both shapes |
| 3 | P2 | Default dir list missing `concepts/` | Add to default |
| 3 | P2 | merge-phantoms missing from thin-client refusal | Add |
| 4 | P1 | Cross-type collision (acme-company merged into people/acme-*) | Type-constrained search |
| 4 | P2 | Dry-run reports merge that real run would skip | Move feasibility check before dry-run |
| 5 | P2 | Real top-level pages (rag.md) classified as phantoms | Body-size threshold |
| 5 | P2 | Tests acquire page-locks under user's real ~/.gbrain | GBRAIN_HOME isolation |
| 6 | P2 | Pre-fix phantoms have `type: concept` default — type filter breaks them | Search all dirs |
| 6 | P2 | Fact-bearing phantoms exceed body threshold | Strip fence from body count |
| 7 | P2 | Live resolver still routes new facts to existing phantoms | Prefix-first ordering |
| 7 | P2 | Timeline content stripped from stub detection | Preserve Timeline |
| 8 | P2 | Stub-strip matches `## Facts` heading without machine markers | Match only fence markers |
| 8 | P2 | Prefix-first overrides real top-level pages | Stub-shape gate |
| 9 | **P1** | `stubBodyChars` regex used fictional fence markers (`<!-- facts -->`) — never matched real fences (`<!--- gbrain:facts:begin -->`) | Real markers |
| 9 | **P1** | `listFactsByEntity({ limit: 10_000 })` clamps at MAX_SEARCH_LIMIT=100 — overflow lost | Raw SQL |
| 10 | P2 | `valid_until` dropped during fact migration | Thread through FenceInputFact |
| 11 | P2 | 50-char threshold misclassifies terse real pages | Lower to 0 |
| 12 | P2 | postgres-js returns embeddings as text strings, not Float32Array | tryParseEmbedding |
| 13 | P2 | Hardcoded 'default' ignores GBRAIN_SOURCE / .gbrain-source chain | Use resolveSourceId |
| 14 | **P1** | writeFactsToFence doesn't refresh `pages.compiled_truth` — next extract_facts wipes migrated rows | Re-import canonical |
| 15 | P2 | importFromFile non-throw failure (skipped/error) still proceeds to delete phantom | Check ImportResult status |
| 16 | P2 | Timeline-only pages misclassified as stubs | Include pages.timeline column |
| 16 | P2 | Retry idempotency comment was wrong (real rerun fails on UNIQUE) | Rollback logic |
| 17 | P2 | DB-only canonical (put_page MCP, no .md) gets stub-overwritten | Materialize from DB |
| 18 | **P1** | writeFactsToFence stub-guard drops facts for legitimate DB-only bare pages | Materialize-then-append |
| 18 | P2 | tryExactSlugBody misses timeline column | Include in concat |
| 19 | P2 | Soft-deleted phantom .md file lingers — next sync resurrects | Unlink on soft-delete |
| 20 | P2 | Factless-phantom early continue bypasses unlink | Apply unlink in factless branch |
| 20 | P2 | Rerun NOT idempotent — engine.insertFacts uses plain INSERTs | Rollback canonical rows on import failure |
| 21 | P2 | DB stale relative to disk — unsynced .md edits get unlinked | Disk-side stub check |
| 22 | P2 | Prefix expansion overrides legitimate fuzzy title matches (Liz/Elizabeth) | Stub-only override |
| 23 | — | **CLEAN ROUND** (1 of 30) | — |
| 24 | P2 | Existing stub-shaped .md files slip past guard | Guard on existing files |
| 25 | P2 | Capitalized bare name `Alice` bounces past real bare slug | Return token immediately |
| 26 | P2 | Disk-stub gate drops facts when DB has real content | Check DB before dropping |
| 27 | **P1** | Factless DB but populated disk fence — unlink loses unreconciled facts | Parse fence, skip with fence_drift |
| 28 | P2 | Dry-run reports merge for fence-drift case real run would skip | Move drift check before dry-run |
| 29 | **P1** | Drift check only ran when facts_moved=0; mixed-state phantoms still lost disk-only facts | Run drift check for all file-backed phantoms |
| 30 | P2 | One-directional drift detection — user's strikethroughs get resurrected from stale DB | Bi-directional drift + tuple-set comparison |

### Why the cascade kept producing real bugs

Read down that table. There's a pattern. Each fix changed the shape of the
state machine. Each new shape exposed a new axis the previous shape didn't
consider:

- Body-size threshold (5) → fence inflates body length (6)
- Strip Facts fence (6) → also stripped Timeline (7)
- Prefix-first ordering (7) → overrides real pages (8) → 50-char threshold (8) →
  misclassifies terse pages (11) → strict-zero threshold (11)
- Type-constrained search (4) → pre-fix concept default (6) → search all dirs +
  ambiguity skip (6) → ambiguous candidates field (6)
- Stale compiled_truth (14) → re-import canonical → import can fail without
  throwing (15) → rollback on failure (15) → rollback is incomplete (16)
- Fence-drift check (27) → only ran for factless (29) → only one-directional (30)

This is a textbook "the design grows its own bugs" pattern. The defensive
checks were all real — codex caught them with concrete reproductions — but
they were defending the wrong shape.

---

## The meta-insight — why this is the wrong shape

The fence is the system of record per the v0.32.2 contract (`src/core/cycle/extract-facts.ts:1-32`).
The DB index is downstream. Reconciliation between the two is the
`extract_facts` cycle phase's job.

`merge-phantoms` was trying to do BOTH:
1. Route facts from phantom slug → canonical slug (an entity-resolution concern).
2. Reconcile the markdown fence ↔ DB index across the move (a reconciliation concern).

By doing #2 in a parallel command instead of letting the existing reconciliation
infrastructure handle it, the command had to duplicate every drift-handling
case that `extract_facts` already handles. That's the bug farm:
**every drift case `extract_facts` knows about had to be re-discovered by
codex review on `merge-phantoms`.**

Examples of duplication:
- `extract_facts` has the v0.32.2 reconciliation guard (`row_num IS NULL AND
  entity_slug IS NOT NULL` → refuse to reconcile). `merge-phantoms`'s round-2
  P1 was tripping that guard.
- `extract_facts` deletes facts by `source_markdown_slug = slug` and re-inserts
  from the fence. `merge-phantoms`'s round-14 P1 was forgetting to refresh
  `compiled_truth` so the next `extract_facts` would do exactly this delete-and-
  re-insert against stale state.
- `extract_facts` already handles fence drift (strikethrough, forgotten,
  superseded). `merge-phantoms`'s rounds 27–30 were re-implementing the same
  drift detection.

---

## Speculation — the platonic-ideal implementations

Three plausible shapes for a future agent. Listed in order of "amount of
existing infrastructure reused." Pick based on operator UX preferences.

### Option Alpha — report-only command, manual remediation

```
gbrain merge-phantoms [--source SOURCE_ID] [--json]
```

Read-only. Lists phantoms + suggested canonical targets. User runs
existing primitives to remediate:

```
$ gbrain merge-phantoms
3 phantom unprefixed entity pages found in source=default:

  alice.md      → people/alice-example (4 facts on phantom, 0 on canonical)
  jared.md      → people/jared-friedman (12 facts on phantom, 3 on canonical)
  acme.md       → companies/acme-example (1 fact on phantom)

To merge:
  1. Run `gbrain dream --phase extract_facts` to reconcile fence ↔ DB.
  2. For each phantom:
     - Edit alice.md's facts fence: move row to people/alice-example.md.
     - `rm alice.md`
     - `gbrain sync`

To verify no facts are lost, compare counts before/after via `gbrain recall
--entity people/alice-example | wc -l`.
```

- **Code size:** ~80 lines
- **Risk:** zero (no destructive paths)
- **Operator burden:** high
- **Best when:** the brain has fewer than ~20 phantoms and the operator wants
  full control.

### Option Beta — phantom redirect in the extract_facts cycle phase

Don't build a separate command. Add phantom-redirect logic to the existing
`runExtractFacts` function in `src/core/cycle/extract-facts.ts`.

When `extract_facts` walks pages:
1. If the page has an unprefixed slug AND is type=person/company/deal/topic/concept:
2. Compute the canonical target via `tryPrefixExpansion`.
3. If canonical exists and is unambiguous:
   - For each fact row keyed on the phantom, move it to the canonical
     (update `entity_slug` + `source_markdown_slug`).
   - Append the migrated fence rows to the canonical's markdown body.
   - Soft-delete the phantom page + unlink the .md file.
4. If canonical is ambiguous or missing, leave the phantom alone (continue to
   reconcile in place; the operator can resolve manually later).

This piggybacks on:
- The existing `extract_facts` empty-fence guard (the v0.32.2 reconciliation
  contract).
- The existing fence parser / strikethrough / forget semantics.
- The existing `deleteFactsForPage` + `insertFacts` reconcile pattern.
- The existing autopilot purge phase (72h soft-delete TTL).

Reconciliation drift is the EXISTING handler's problem, not a parallel
implementation. The phantom-redirect concern is small: "compute the canonical
target, treat the migrated fence as the new source-of-record for the canonical
page."

- **Code size:** ~150 lines added to extract-facts.ts + minimal new tests
- **Risk:** low (reuses battle-tested code paths)
- **Operator burden:** zero (automatic on next autopilot cycle)
- **Best when:** the brain is actively running autopilot. This is the right
  default.

**Open design question for Beta:** does the operator want SEE the migration
happen, or should it be invisible? If invisible, the operator might be
surprised when `alice.md` disappears from their brain repo. Suggest: emit a
progress event (`cycle.extract_facts.phantom_redirected`) and tally counts
in the cycle report so `gbrain doctor` can surface them.

### Option Gamma — phantoms as a first-class schema concept

The most invasive option. Add `pages.canonical_of TEXT REFERENCES pages.slug`
to the schema:

```sql
ALTER TABLE pages ADD COLUMN canonical_of TEXT;
-- canonical_of points at the page this row is a phantom of, NULL when
-- the row is itself canonical.
CREATE INDEX idx_pages_canonical_of ON pages(canonical_of) WHERE canonical_of IS NOT NULL;
```

Then:
- `resolveEntitySlug` follows `canonical_of` transparently: if it lands on a
  phantom page, return its canonical.
- `writeFactsToFence` follows `canonical_of` BEFORE picking a target path.
- Search (`hybridSearch`) hides phantom pages from results (already in the
  visibility chain via `deleted_at`).
- Migration becomes a SQL UPDATE: `UPDATE pages SET canonical_of = $canonical
  WHERE slug = $phantom_slug AND source_id = $source_id`.
- The markdown file stays on disk as a tombstone with frontmatter
  `canonical_of: people/alice-example` until the operator deletes it manually
  (no destructive command needed).

- **Code size:** schema migration + ~20 lines per affected callsite (resolver,
  fence-write, search). Maybe 300 lines total.
- **Risk:** medium (touches schema + multiple callsites)
- **Operator burden:** zero
- **Best when:** the brain has thousands of phantoms or wants phantom-as-
  first-class concept for other reasons (e.g. alias support).

**This option also unlocks:** entity aliases (`canonical_of` becomes "alias
of"). User can have `alice.md` with `canonical_of: people/alice-example` as a
deliberate redirect for legacy URLs. The phantom-fix becomes a special case
of a general alias system.

### Recommendation among the three

Build **Beta** first. It's the smallest change that solves the actual problem,
reuses existing infrastructure, and runs automatically. The bug farm went away
the moment the reconciliation concern moved into the existing reconcile path.

Iterate to **Gamma** if/when alias support is needed for other reasons. The
schema column is small enough that adding it later is fine — `canonical_of`
defaults NULL and only the phantom-redirect callsite needs to set it.

Skip **Alpha** unless the operator explicitly wants manual control.

---

## What's recoverable from PR #1010's iteration

Even though the implementation is being scrapped, the codex iteration found
real bugs that a future implementation MUST handle. Treat the round-by-round
commit messages as a regression checklist:

- **Round 9 (markers):** the fence markers are `<!--- gbrain:facts:begin -->`
  and `<!--- gbrain:facts:end -->`, NOT `<!-- facts -->`. They live as
  exported constants in `src/core/facts-fence.ts:53-54`. Use them.
- **Round 9 (clamp):** `listFactsByEntity` clamps `limit` at MAX_SEARCH_LIMIT
  (100). For unbounded reads, go through raw SQL.
- **Round 10 (valid_until):** `FenceInputFact.validUntil` is now part of the
  fence-write contract. Carry it through migrations.
- **Round 12 (embeddings):** postgres-js returns pgvector embeddings as text
  strings; PGLite returns Float32Array directly. Normalize via
  `tryParseEmbedding` from `src/core/utils.ts`.
- **Round 13 (source resolution):** any operator command must honor the
  4-tier resolveSourceId chain.
- **Round 14 (stale compiled_truth):** writeFactsToFence does NOT refresh
  `pages.compiled_truth`. The next extract_facts cycle will reconcile from
  the markdown, but if anything reads compiled_truth between writeFactsToFence
  and the next cycle, it sees stale state.
- **Round 17 (DB-only canonical):** canonical pages can exist in the DB via
  MCP `put_page` without ever having a .md file. Any code that calls
  writeFactsToFence on them must materialize the body from DB first.
- **Round 18 (timeline column):** `pages.timeline` is a separate column. Stub
  detection must read both compiled_truth + timeline.
- **Round 22 (fuzzy precedence):** prefix expansion should NOT short-circuit
  fuzzy when no bare slug exists. The "Liz/Elizabeth" case.
- **Round 27 + 29 + 30 (fence drift):** the fence is the system of record. Any
  operation that mutates DB rows MUST verify fence/DB consistency first, in
  both directions, including tuple-content comparison when counts match.

The stripped `merge-phantoms.ts` (last good version is commit `7f7a080f`)
is a worked example of EVERY one of these gotchas. Read it before building
Option Beta — not to copy, but as a regression checklist.

---

## Code pointers — what was stripped, what stayed

**Stripped from PR #1010 (will not land):**
- `src/commands/merge-phantoms.ts` — the entire 600-line command
- `test/merge-phantoms.test.ts` — 31 tests
- `src/cli.ts` entries: `CLI_ONLY`, `CLI_ONLY_SELF_HELP`,
  `THIN_CLIENT_REFUSED_COMMANDS`, `THIN_CLIENT_REFUSE_HINTS`, the dispatch
  case, and the help text line

**Kept (lands with PR #1010):**
- `src/core/entities/resolve.ts` — full resolver with prefix expansion, stub
  detection, real-page preservation. ALL of this is independently valuable.
- `src/core/facts/fence-write.ts` — stub-guard (rounds 1, 24, 26) and the
  DB-materialize path (round 18).
- `src/core/facts/backstop.ts` — dropped-fact audit (round 2 P1).
- `src/core/facts/dropped-audit.ts` — JSONL audit log infrastructure.
- `test/entity-resolve.test.ts` — 33 tests for resolver behavior.
- `entities.prefix_expansion_dirs` config key.

**Useful primitives (kept, intentionally exported for future Option Beta):**
- `resolve.ts:tryPrefixExpansion(engine, source_id, token, opts?)` — search
  configured directories for prefix-match candidates.
- `resolve.ts:stubBodyChars(compiled_truth)` — detect v0.34.5 stub shape.
- `resolve.ts:isStubBody(compiled_truth)` — boolean wrapper.
- `resolve.ts:PHANTOM_STUB_MAX_BODY_CHARS` — threshold constant (0).
- `resolve.ts:getPrefixExpansionDirs()` — config-driven resolver dir list.

A future Option Beta implementation will likely use all five.

---

## Open questions for the future implementer

1. **Should phantom redirect happen during extract_facts (autopilot-time) or
   eagerly during resolveEntitySlug (write-time)?** Beta proposes the former
   so the heavy lifting happens in batch and gets cycle-level reporting.
   Write-time would route facts AROUND the phantom without ever migrating
   the page — different semantics.

2. **What's the right UX for ambiguous canonical?** When `alice` matches
   both `people/alice-example` AND `people/alice-other`, what happens?
   merge-phantoms skipped with `ambiguous`. The plan-eng-review suggested
   surfacing this for operator resolution. A redirect-during-cycle approach
   could log to `~/.gbrain/audit/phantom-ambiguous.jsonl` and continue.

3. **What about phantoms in non-default sources?** The current PR has source
   isolation (the `resolveSourceId` chain), but a multi-source brain might
   have the phantom in source A and the canonical in source B (mounted brain).
   Cross-source redirect is out of scope for v0.34.5 but worth thinking about.

4. **Should Option Beta also handle phantom links?** The `links` table has
   `from_page_id` / `to_page_id` referencing the phantom row. After redirect,
   those need to point at the canonical. Easy SQL but it needs to happen.

5. **What about `find_orphans` / `gbrain doctor` reporting?** A redirect-aware
   doctor check could surface "N phantom pages pending redirect" so operators
   know what's coming.

---

## How to pick this up

A future agent doing this work should:

1. Read this doc top to bottom.
2. Read the round-by-round commit messages on PR #1010's commits between
   `c861b43a` and `7f7a080f` — they're a regression checklist.
3. Decide Alpha / Beta / Gamma after a real `/plan-eng-review` on the
   abstraction question. **Do not** start from the stripped
   `merge-phantoms.ts` and try to clean it up. That code is the wrong
   shape; rewriting it as Option Beta is faster than refactoring it.
4. If choosing Option Beta, the test surface should pin every regression
   in the cascade table above. The cascade table is the test backlog.
5. Land the rewrite as its own PR, not bolted onto a resolver fix.

---

## Lessons learned (about the iteration, not the bug)

This isn't an indictment of any particular decision. The cascade was a
predictable outcome of three things compounding:

1. **The plan-eng-review user-upgraded D7 from "follow-up" to "build it now."**
   That decision turned a small PR into a large one. Future plans should
   resist this — destructive operator commands should ALWAYS be follow-ups,
   not riders on the fix that motivated them.

2. **The chosen abstraction duplicated existing infrastructure.** The fence
   is the system of record. Any code that mutates fence + DB independently
   has to re-implement reconciliation. The cascade was the cost of that
   duplication.

3. **Codex review is brutally thorough.** Each round caught a real issue.
   The bugs WERE in the new code. But codex can't tell you "this whole
   abstraction is wrong" — it can only point at specific failure modes.
   The meta-insight required stepping out of the loop.

For the next destructive cleanup command in this codebase: do the design
work BEFORE the implementation. Make the reviewer answer "is this the right
abstraction?" before they're asked to review "does this code work?"
