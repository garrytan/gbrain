# Historical retrieval for `think {known_as_of}`: design

Status: **built** (draft PR #6895, with W2's reshaped second slice). This is
wave 4b's W3 design item in the 10x memory-advantage plan (gbrain-evals
`docs/plans/2026-10-07-10x-memory-advantage/PLAN.md`, wave 4, row W3). The
design was approved as written, with open question 1 taken at its default
(section 12). Section 13 records what the build changed or measured. Section 9
gives the verdict the build was gated on. Every `file:line` below was read on master `28ebe6b2b`
(v0.60.274.0). It builds on what wave 4a shipped: W1's `belief_events` ledger
(#6806), W2's page-at-time on validity intervals (#6850) and W4's weekly belief
diff (#6866), all described in [the ledger design](../designs/BELIEF_LEDGER.md),
sections 13 to 16.

## 1. The problem

`think {known_as_of: T}` should answer from **what this brain had recorded at
T**, the same clock as `get_page {known_as_of}`. Filtering today's evidence by T
does not do that:

- **Retrieval reads the current text.** The page stream is `hybridSearch`
  over current chunks and current embeddings (`think/gather.ts:168-205`). The
  take streams search current takes (`gather.ts:207-229`). A word that was in a
  page at T and removed afterwards is in no index. Filtering current hits by T
  can only drop pages; it can never find the page the removed word was in.
- **Hydration reads the current text.** Each hit's excerpt is the current
  page body with the current withdrawal overlay (`gather.ts:141-144`,
  `think/index.ts:546-575`). An old hit rendered with current text leaks later
  knowledge.
- **Every other evidence branch reads current state too**: graph expansion
  (current links), aliases (current frontmatter), backlink and salience
  boosts, trajectory facts, calibration profiles, trust tiers and the
  semantic result cache.

So the design must name, for every branch of think that produces evidence,
either a view bounded by T that it reads, or the fact that the branch is off
under `known_as_of`. It must also name the index each view needs.

## 2. What wave 4a already gives a read bounded by T

| Shipped piece | What it gives at T | What it does not give |
|---|---|---|
| W1 ledger (`belief_events`, `belief_page_lifetimes`, commit marks, coverage intervals, purge redaction) | Every publication of every page lifetime with `revision_before` and `revision_after`, the event's `visibility` and `trust_tier`, the commit-mark visibility rule (section 5.3), coverage cuts per source and per page, certified or uncertified intervals, purge and expiry markers | Any text, and any way to **find** a page by its content at T. Creation and baseline are one snapshot event with no text (section 4) |
| W2 page-at-time (`belief/page-at-time.ts:134`, `readPageAtTime`) | For one slug: the interval current at T, its body (a `page_versions` preimage or the live page), title, type, frontmatter and tags, or `body: unavailable` with a reason (`purged`, `expired`, `hard_deleted`, `pruned`, `version_missing`). Refusals `coverage_from`, `coverage_gap` and `known_as_of_unproven`. The remote rule `remoteMayRead` (`:270`): the interval's event was world-visible when it was recorded, and the page is visible now | A batch read; it reads one slug at a time. Any search |
| W4 belief diff (`belief/changes.ts`) | `bodySubjects` (`belief/backfill.ts:55`): the facts and takes fence rows of a body at an interval, keyed like ledger subjects, used at `changes.ts:249-300` to read a value as recorded at an instant. The remote rule for history: takes only of the holders the caller may read, never a claim made private later or a key a purge hid | Anything outside a window's changed subjects |

So a T-bounded **body** exists for every page that W1 covers, and a T-bounded
**fact and take state** exists for any page whose body can be read. What is
missing is a **T-bounded way to find candidates**. There is no historical
index: even `pages.search_vector` leaves out `compiled_truth` (`src/schema.sql:1155-1180`),
and `content_chunks` holds only the current text.

## 3. The design in one paragraph

Under `known_as_of`, think does not run `hybridSearch`. It runs a
**historical retriever** over a new derived index, the **history text index**
(section 4). The index stores every page revision's chunks once, by content
hash, together with that revision's recorded-time interval taken from the
ledger. The retriever matches the query lexically, keeps the revisions whose
interval contains T, confirms each surviving page with W2's exact read, and
ranks with one scorer that depends only on the text at T. Hydration renders the
page-at-time body. Takes come from the fence rows of those bodies. Branches
that need state the ledger does not record at T are off and listed in the
result. Permissions follow one rule: **content is bounded by T, and
restrictions are bounded by now.** A later privacy change, withdrawal, purge or
trust demotion can remove evidence. A later edit, alias, link, take or summary
can never add evidence or change it.

## 4. The history text index (new, derived, rebuildable)

Three tables. They come from `page_versions`, the live page and `belief_events`,
so they are **not** canonical state: no backup contract, and a full rebuild
from those sources gives the same rows. Rebuilding is the recovery step after
`gbrain backup restore`, a graduation copy or `migrate-engine`.

```sql
CREATE TABLE belief_text_revisions (
  id                 BIGSERIAL PRIMARY KEY,
  source_id          TEXT NOT NULL,
  source_incarnation UUID NOT NULL,
  page_lifetime      UUID NOT NULL,
  revision           UUID NOT NULL,                 -- label only: one revision can hold several intervals (a view change)
  title              TEXT,
  aliases            TEXT[] NOT NULL DEFAULT '{}',  -- declared aliases at this revision, normalized (alias-normalize.ts)
  content_date       DATE,                          -- effective date from this revision's frontmatter and slug (content sources only)
  visibility         TEXT NOT NULL,                 -- the opening event's visibility
  segmented          BOOLEAN NOT NULL DEFAULT false,
  known_from         TIMESTAMPTZ NOT NULL,          -- recorded_at of the event that opened the revision
  known_until        TIMESTAMPTZ,                   -- recorded_at of the event that closed it; NULL while open
  opening_event      BIGINT NOT NULL,
  closing_event      BIGINT,
  stale              BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX ON belief_text_revisions (source_id, known_from);
CREATE INDEX ON belief_text_revisions (page_lifetime, known_from);
CREATE INDEX ON belief_text_revisions USING GIN (aliases);

CREATE TABLE belief_text_chunks (
  text_hash     BYTEA PRIMARY KEY,
  search_vector TSVECTOR NOT NULL
);
CREATE INDEX ON belief_text_chunks USING GIN (search_vector);

CREATE TABLE belief_text_revision_chunks (
  revision_row BIGINT NOT NULL REFERENCES belief_text_revisions(id) ON DELETE CASCADE,
  ord          INTEGER NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('body', 'take')),
  holder       TEXT,                                -- take rows only
  take_key     TEXT,                                -- take rows only: the ledger's take subject key
  text_hash    BYTEA NOT NULL,
  PRIMARY KEY (revision_row, ord)
);
CREATE INDEX ON belief_text_revision_chunks (text_hash);
```

Each table gets RLS like the ledger's tables. This is one additive migration,
folded into wave 4b's single migration next to W9's `page_refresh_proposals`.
The plan's W3 row says "Migration: no", so that cell changes (section 10).

**Chunks are hashed and deduplicated.** Each interval's `compiled_truth` and
`timeline` go through the same chunker as `content_chunks` (`chunkText`,
`chunkers/recursive.ts:104-115`). That chunker strips takes fences and
private fact rows before chunking, so body chunks hold exactly what today's
keyword search can match. **Take rows are indexed separately**: each fence take
row of the interval's body (read with `bodySubjects`) gets its own row of kind
`take`, carrying its holder and take key, with the claim text as the hashed
chunk. A phrase that appears only in a take can then find that take, and the
holder allow-list applies in SQL. Each chunk's hash
names a row in `belief_text_chunks`, and its `search_vector` is built with the
same `gbrain_fts_input` and `english` configuration as `content_chunks`
(`schema.sql:416-430`). An edit stores only the chunks it changed, so storage
grows with the amount of text edited, not with the number of revisions times
the page size. A whole-body tsvector per revision is ruled out: it overflows
Postgres's 1 MB tsvector cap on large inline pages, the same reason
`pages.search_vector` leaves out `compiled_truth` (#2704).

**One row per content interval, not per revision.** A row opens at every
page event that page-at-time's `replay` (`belief/page-at-time.ts`) counts as a
content change: a creation, a replacing write, a revert, a baseline, a
reconcile and a `page.view_changed`. A withdrawal's materialization rewrites
the body at the **same** revision (`ledger.ts:365-366`), so keying rows by
revision would index the wrong body for one of those intervals. The index
maintenance and page-at-time share one content predicate, so they cannot
disagree about where an interval starts.

**Maintenance runs inside the appending transaction.** In
`appendBeliefEvents` (`belief/append.ts:147`), which every page event goes
through (publications, baselines, reconciles and view changes), each content
event also does three things in the same transaction. It sets `known_until`
and `closing_event` on the lifetime's open row. It inserts the new row with
the event's own `recorded_at` as `known_from`, reading the body from the live
page row, which already holds the new body at that point in the transaction.
And it inserts the chunks with `ON CONFLICT DO NOTHING`. A row therefore
commits exactly when its event commits, and the index can never lag the
ledger. **A baseline opens a row**, so a page never edited since its baseline
is still findable. A delete, restore or rename that advances the knowledge
revision (the page revision trigger advances it on any change to slug, title,
body, frontmatter or `deleted_at`, `schema.sql:1866-1882`) opens a row too,
because the exact read requires the matched row to be the page's interval at
T. A row opened by a delete is never a candidate, since the exact read
excludes deleted pages. Only a visibility-only event, which carries no
revision, opens no row. Like W2's preimage
invariant, a test-only check in `finalizeBeliefEvents` fails the transaction
when a content event has no open index row. Doctor lists any such event in
production. **Segmented pages** get a row with
`segmented = true` and no chunks, and are excluded (section 6, branch 1). The
write cost is measured on the publication bench (`test/bench-publish.test.ts`).
The budget is publication p50 within 15% of master on that bench. If it goes over, the fallback is an asynchronous projection
that refuses any T it has not covered through commit marks. That fallback is
more complex, so it is the second choice (section 11).

**Purge, expiry and hard delete reach the index in their own transaction.**
They follow the ledger design's rule that redaction follows every field that
carries the text (section 6.5). For each affected lifetime, the transaction
marks every revision row `stale`, sets its `title` and `aliases` to NULL and
empty, deletes its chunk mappings, and deletes every chunk row that is no
longer referenced. The purged words then remain in no column of the index. A tsvector's lexemes reveal words, so
an orphaned chunk row counts as carrying the text. A follow-up rebuild indexes
the affected lifetime again from its redacted versions. Until then its rows
are excluded. That exclusion can only remove evidence, so it is a restriction,
which the gate allows (section 7).

**The initial build is a preview-first operator step.** Nothing rewrites data
on upgrade. The migration creates empty tables. `gbrain beliefs history-index
--source <id>` previews the number of intervals and bytes and an estimated
time, and `--apply` builds the index resumably, one lifetime at a time, from
`page_versions` and the live pages under the ledger's intervals. It works in
two passes. The first pass indexes **every interval still open** when the
build starts, which are the live pages. The second pass indexes the closed
intervals, newest first. The source's **index cut** stays unset until the first
pass completes. Until then every T refuses `history_index_incomplete`, because
a page unchanged since before the migration has no row yet, and finding it
later would change the evidence. After the first pass, the cut is the earliest
instant from which every interval is indexed. It moves back to the source's
coverage cut when the second pass completes. Doctor `belief_ledger_coverage`
reports each source's index cut, build progress, stale rows and any orphaned
chunks.

## 5. The historical retriever

One function, `readHistoricalCandidates(engine, {query, at, sources, remote, limit})`,
in a new `src/core/belief/historical-search.ts`. It has six steps:

1. **Refusals before any work.** It parses `known_as_of` with
   `parseKnownAsOf`, so a bare date refuses `clock_mismatch`. A future instant
   refuses `invalid_params`. For each source in scope it calls `coverageAt`
   (`belief/coverage-report.ts:134`). Any uncovered source refuses the whole
   call with `coverage_from`. T inside a stopped interval or a restore gap
   refuses `coverage_gap`. T before a source's index cut refuses
   `coverage_from` with the new reason `history_index_incomplete`, whose fix
   names the build command. This is one new reason on an existing catalogue
   entry, not a new code. A partial answer over the covered sources would
   quietly answer a different question, so the refusal names the uncovered
   source and its hint says to narrow `source_id`.
2. **Candidate revisions.** It runs a GIN match of the query's tsquery over
   `belief_text_chunks`, joined through the mappings to revision rows with
   `known_from <= T AND (known_until IS NULL OR known_until > T) AND NOT stale AND NOT segmented`,
   restricted to the source incarnations in scope. For a remote caller it adds
   `visibility = 'world'` and a join to the page row that is visible now
   (`privatePagesFilterFragment`, `deleted_at IS NULL`).
   **Why this filter is exact.** Intervals of one lifetime are disjoint, so at
   most one revision per lifetime passes. Take a revision whose closing event
   was recorded at or before T. At T that event is either visible, which
   closes the revision, or unproven, which makes the page unanswerable at T
   (step 4). A revision recorded after T has `known_from > T`. So no
   answerable body at T is filtered out, and nothing recorded after T passes.
3. **One scorer, from the text at T only.** A page's score is the maximum
   `ts_rank_cd` over the chunks of its T revision, plus a fixed title-match
   term computed from the revision row's title. Ties break on
   `(source_id, page_lifetime)`, never on row ids or insert order.
   `ts_rank_cd` uses no corpus statistics, so a page's score does not depend
   on any other page. The retriever fetches the top `2 × limit` rows in that
   order.
4. **Exact confirmation.** A new batch reader, `readPagesAtTime`, carries the
   same logic as `readPageAtTime` over a set of lifetimes in three queries.
   It reads each candidate at T and keeps a candidate only when its interval
   at T is the matched revision, is not deleted and has a body. A page whose
   state at T is unproven is dropped and counted in `unproven_pages`. An
   unavailable body is counted under its `body_reason`, and its text is never
   borrowed from a neighbour. When fewer than `limit` pages survive and more
   rows exist, the retriever fetches the next batch. Truncation happens only
   after this step, so a strong match recorded after T can never push out a
   body that was live at T.
5. **Restrictions made after T.** For a remote caller, the fact and take rows
   of each survivor's T body go through W4's restriction
   (`changes.ts:300-316`): rows made private by a later event, and keys a purge
   hid, are removed. `sanitizeRemoteBody` checks only the row's visibility in
   the T body (`remote-body.ts:30-41`), so it cannot see a later change. A
   survivor that lost a row is scored again on its restricted text with the
   same scorer, in SQL. Index scores are upper bounds after a restriction, so
   the retriever stops fetching only when the Kth best final score is at least
   the next unfetched index score. Text made private later can therefore
   neither appear in the evidence nor lift a page into it.
6. **Bodies for the reader.** For each survivor, the body at T is put through
   the withdrawal overlay, with withdrawals active at T or active now (the
   union, so a later un-withdrawal adds nothing). The set active at T comes
   from the `fact.withdrawn` events and their reversals visible at T. The
   overlay gains a variant that takes an explicit withdrawal set, because
   today's `overlaidBoundedRows` (`page-window/bounded-lead.ts:60`) reads
   current page snapshots. For a remote caller it also
   goes through `sanitizeRemoteBody`, then the same bounded projection the
   current gather uses.

The retriever is lexical only. No embeddings exist for past revisions, and
embedding every revision would be a paid, per-edit cost that needs its own
decision (section 11). Mixing vector scores for pages unchanged since T with
lexical-only scores for edited pages would break invariance: one later edit
would move a page from one scorer to the other and change the ranking. So the
vector arms are off for every page, not just for the edited ones.

## 6. Every evidence branch of think, with its verdict

"T-bounded" means the branch reads a view that changes only under the
restrictions of section 7. "Off" means the branch does not run under
`known_as_of`, and the result's `known_as_of.disabled_branches` names it.

| # | Branch (where it runs today) | Reads today | Under `known_as_of` | View and index |
|---|---|---|---|---|
| 1 | Page search, keyword arm (`gather.ts:168-205` → `hybridSearch`, `search/hybrid.ts:1094`) | `content_chunks.search_vector` (current text) | **Replaced** by the historical retriever | History text index (section 4), new |
| 2 | Page search, vector and image arms | Current chunk embeddings | **Off** | Would need embeddings per revision (paid per edit); not in V1 |
| 3 | Title arm and title-phrase boost | Current title | **T-bounded**: the title term in step 3 | `belief_text_revisions.title` |
| 4 | Window floor (`gather.ts:176`, `listPages` by effective date) and the valid-time window filter | Current `effective_date` | **T-bounded**: `content_date` of the revision live at T; the floor lists revisions live at T in the window | `belief_text_revisions (source_id, known_from)` plus `content_date` |
| 5 | Relational recall, structural-neighbour expansion, session pool cap (inside `hybridSearch`) | Current links and chunks | **Off** | Needs a link history index (branch 13) |
| 6 | Reranker | Current chunk text | **Off in V1** | Over T text it is a pure function and allowed later. It is kept out so the invariance gate stays deterministic |
| 7 | Post-fusion boosts: backlink, salience, recency, chronicle, graph signals, alias-resolved, supersede downrank (`hybrid.ts:537-680`) | Current link counts, emotional weight, take counts, dates, `slug_aliases`, supersede edges | **Off** | None planned: each would need its own history of counts |
| 8 | Alias hop and identity lookups (`search/alias-hop.ts`) | Current `page_aliases` | **T-bounded** for the anchor and for an exact alias match of the whole query | `belief_text_revisions.aliases` (GIN) |
| 9 | Semantic result cache (`hybrid/cache-stages.ts`) | Results cached at any time | **Bypassed**: never read, never written | None |
| 10 | System One: search intent (S2), answerability (S4), trajectory intent (`think/decide.ts:150-171`) | Question plus current evidence | **Off in V1** (off by default anyway) | S4 judges only the evidence it is given, so it can follow once the gate holds |
| 11 | Take keyword search (`gather.ts:207-216`) | Current `takes` | **T-bounded**: a separate candidate query over the `take` rows of the history text index (the same T filter, holder allow-list in SQL), each take confirmed by its page's exact read and W4's restriction, ranked by the same scorer | `bodySubjects` on page-at-time bodies (W2 + W4) |
| 12 | Take vector search (`gather.ts:218-229`) | Current take embeddings | **Off** | Same as branch 2 |
| 13 | Graph traversal around `anchor` (`gather.ts:231-250`) | Current `links` | **Off** | A link history index built from `link.*` events plus link extraction from creation bodies (which carry only counts in the ledger, section 4). Not in V1 |
| 14 | Anchor hydration (`gather.ts:254-262`) | Current page | **T-bounded**: the anchor resolves at T (slug, then rename chain, then aliases at T); its body is page-at-time. An anchor unproven at T refuses `known_as_of_unproven` | W2 + branch 8 |
| 15 | Page hydration (`visibleLeads`, `overlaidBoundedRows`, `deliverEvidence` in `index.ts:546-575`) | Current body and current withdrawals; session expansion from current chunks | **T-bounded**: the body at T, with the withdrawal overlay as the union of withdrawals active at T and now; session expansion off | W2 |
| 16 | Trust stamping (`index.ts:656-657`, `eligibility/stamp.ts:62`) | Current page and take tiers, fence markers | **T-bounded with restriction**: the lower of the tier on the newest event at or before T and the tier now; fence markers come from the T body | Ledger `trust_tier` |
| 17 | Trajectory facts and the entity extraction and resolution that feed them (`index.ts:713-799`) | Current `facts`, current slugs and aliases | **Off in V1**. A retrieved entity page's facts fence still reaches the reader inside its T body | A fact-state reader (the fence at T plus database-only `fact.*` events). That reader is the reshaped W2 `recall` (section 8), deferred |
| 18 | Calibration profile (`index.ts:679-706`) | Newest profile now | **Off**: `with_calibration` with `known_as_of` refuses `invalid_params` | A profile history that covers purge and calibration undo; not planned |
| 19 | Temporal context (`index.ts:608`, `think/temporal-context.ts`) | Today in `brain.timezone` | **T-bounded**: the reference date is T's day in the brain's time zone (an explicit `reference_date` must be at or before it); page dates come from branch 4 | None |
| 20 | Summaries: compiled-truth leads, synthesis pages, refreshed summary blocks (W9) | Current pages | **T-bounded as pages**: a summary is evidence only if its revision was live at T. `timeline_entries` (derived, rebuilt at any time) is not read; the timeline text in the T body is | History text index + W2 |
| 21 | Citations and quote verification (`index.ts:1018`, `cite-render.ts`) | Current slugs; blocks as rendered | **T-bounded**: each citation carries its slug at T, `revision` and `recorded_at`; quote verification runs against the blocks rendered at T | W2 |
| 22 | Writes: `save`, `take`, `persistSynthesis` (`index.ts:1095`) | None | **Refused**: `invalid_params` names the parameter | None |
| 23 | Source scope and page visibility | Current grants and privacy | **Restriction bounded by now**: a page private now, a source removed or ungranted now, or (for a remote caller) an interval not world-visible when recorded is never evidence | W2's `remoteMayRead` rule, in SQL in step 2 |
| 24 | Question embedding, query expansion, model and config resolution | Provider and config | **Not evidence**. No question embedding is requested, because branch 2 is off. Expansion is already off in think | None |

The think result gains a `known_as_of` block: `at`, `certified`,
`uncertified_reason`, `coverage_from` per source, `retrieval: "lexical"`,
`disabled_branches`, `unproven_pages`, and `bodies_unavailable` (counts by
reason, plus `segmented`). The prompt gets one header line: "Recorded state as
of T; certified: yes or no". An answer from an unmanaged source therefore
carries its disclosure to the reader as well as in the result.

**Surface.** `think {known_as_of}` is available on the full surface only, so
the starter schema and `test/mcp-schema-budget.test.ts` stay unchanged. The CLI
flag is `--known-as-of <instant>`. It combines with `anchor`, `since`, `until`,
`rounds`, `model` and `source_id`. It refuses `save`, `take` and
`with_calibration`. Remote callers get the rules of branch 23. The protocol doc
and `docs/TOOL_CATALOG.md` record the parameter under W2's clock glossary.

## 7. The invariance gate (the design gate)

The gate tests the evidence, not the answer. The test client captures the
user message think builds, so no model runs and the gate costs $0. It runs on
PGLite and Postgres, for a local caller and a remote OAuth caller scoped to
world holders.

**Fixture.** Each seed generates a synthetic brain with the ledger turned on
before the first write. It has about 40 pages: people and companies (placeholder
names such as `alice-example` and `acme-example`), facts and takes fences,
declared aliases, typed links, two synthesis pages and one large page. The
history up to T is fixed. It includes three interval shapes that a careless
index misses: a page never edited after its baseline, a `forget` whose
materialization rewrites a body at the same revision before T, a page deleted
and restored before T, a phrase that appears only in a take, and a page
created before the index tables existed, indexed only by the build's first
pass. T is chosen **quiescent**: every transaction recorded
at or before T is committed and has its commit mark. This is the only
condition the guarantee needs. A read taken while a transaction recorded
before T is still open can differ from a read taken after it commits. W2
already has that case and answers it with `known_as_of_unproven`.

**Questions.** There are 12 per seed, at least 3 of them **removed-phrase
questions**: each names a phrase that was in exactly one page at T and that
the later history deletes. Some also rename that page and add the question's
other words to five other pages, so a current-text retriever would rank those
pages first.

**Later history (the mutation).** A seeded generator applies 30 to 60 changes
after T. These are the plan's list, made concrete:

- edit the text of every page, including removing each removed phrase;
- add and remove aliases, including an alias of the whole query on another page;
- add and remove typed links and backlinks;
- add, revise, resolve and retract takes;
- rewrite every summary and synthesis page, and create new pages that contain
  the answer words;
- rename pages, delete and restore them, and merge a phantom page;
- change emotional weight;
- embed again and change the active embedding model;
- fill the semantic cache with the same questions.

**Assertions.**

1. **Invariance.** The captured user message, the `known_as_of` block and
   every citation's `(slug, revision)` are byte-identical before and after the
   later history. That holds for every question, seed, engine and caller, over
   20 seeds × 12 questions × 2 engines × 2 callers = 960 comparisons, with
   0 differences allowed.
2. **Removed phrase.** For every removed-phrase question, the T evidence
   holds the phrase inside the T body of the page that had it. Today's think
   on the same brain after the later history does not hold it. That control
   shows the question really tests history, at $0 and with no model.
3. **The oracle agrees.** A brute-force reference retriever reads every page
   live at T with `readPageAtTime`, scores it with the same scorer and returns
   the same ranked list as the indexed retriever. This holds on every seed, so
   the index can neither miss nor add a candidate.
4. **Mutants are caught.** Each of these forced probes must fail assertion 1
   or 2 on at least one seed: (a) current text instead of the T body;
   (b) current candidates filtered by T; (c) current alias resolution;
   (d) the backlink boost kept on; (e) the semantic cache read; (f) truncation
   before the exact check; (g) index rows keyed by revision instead of by
   interval; (h) an index cut set before the build's first pass completes;
   (i) no index row on restore; (j) take rows not indexed, so a take-only
   phrase finds nothing; (k) a remote body without W4's later-private
   restriction. That is 11 of 11.
5. **Restrictions only remove evidence.** These cells run separately, because
   the rule lets them change the evidence: a later `forget`, `purge_fact`,
   page purge, page made private, a fact made private, holder narrowed, source
   removed, trust demoted, and version pruning of the large page. The fixture
   has more eligible pages than the retrieval limit, so a restriction can let
   a lower-ranked page in. The assertion is therefore exact rather than a
   subset: the evidence after the change equals the top K of the brute-force
   ranking at T with the restricted items removed, and contains nothing that
   was not eligible at T. The purged words must appear nowhere in the prompt,
   the history text index or its chunk rows. A later **un**-withdrawal must
   add nothing.
6. **Coverage and refusals.** These cases are covered:
   - T before the watermark refuses `coverage_from` (`not_recorded`).
   - T before the index cut refuses `coverage_from` (`history_index_incomplete`).
   - T inside a restore gap refuses `coverage_gap`.
   - A bare date refuses `clock_mismatch`.
   - An anchor whose write straddles T refuses `known_as_of_unproven`.
   - Any other page whose write straddles T is dropped and counted.
   - An unmanaged source answers with `certified: false`.
   - `save`, `take` and `with_calibration` each refuse.
7. **N6.** N6 gains a `known_as_of` variant of `think` with the synthesis
   stubbed. No remote caller may receive evidence from a page that is private
   now, an interval that was not world-visible, a holder it may not read, or a
   purged key. The rules are the same as for `get_page {known_as_of}`.

**Performance gate ($0).** On a synthetic brain with 10,000 pages, 50,000
content intervals and their chunk rows:

- historical retrieval p95 is at most 2 s on PGLite and on Postgres, for
  queries made of common words and of rare words;
- publication p50 on the publication bench (`test/bench-publish.test.ts`) is
  within 15% of master;
- a baseline run over 10,000 pages takes at most 2× master's time.

Index size and rows per interval are reported. Each case reports machine,
engine, data size, N, p50 and p95, measured interleaved with master.

The gate passes when all seven assertions and the performance gate hold. W3 then ships behind its parameter. Like
every recorded-time read it is never on by default, and the QA below decides
what the docs claim, not whether the parameter exists.

**Belief as-of QA, run only if W3 is built.** This is a paid eval,
preregistered in gbrain-evals before any cell runs. A seeded generator builds
worlds with recorded-time gold. There are about 200 questions of the form
"as of T, what had the brain recorded about X's employer, title, a metric, a
take's weight, a decision", where each value changed after T. About 20% of the
questions ask about a value first recorded after T, so the correct answer is
"not recorded then". Every question carries its **comparator**: the value
recorded after T. The values are fictional, and the generator makes each
comparator value a token that appears nowhere in the brain as it stood at T.
So a reader can only produce a comparator value if it reached it through the
evidence, and a leak is unambiguous.

- **Readers.** Opus 5.5, GPT-6.1 Sol and Sonnet 5.5, re-checked for newer
  models on run day under the project's model rules.
- **Metrics.** Scoring is deterministic, with no judge model. Per reader:
  accuracy against recorded-time gold, with a Wilson interval, and the
  **comparator-leak rate**: answers that state a value recorded after T.
- **Gate.** 0 leaks in all 600 answers (one-sided 95% upper bound about
  0.5%). Accuracy is reported. A comparison arm needs no model: the
  evidence-level control of assertion 2 runs on every question.
- **Data.** Development uses fixed seeds. The counted run uses a seed minted
  after the code freeze.

## 8. W2's second slice, reshaped

The plan's second slice was `known_as_of` on `recall`, `takes_list`,
`get_links`, `ontology_get` and `entity`, after W4's workflow is used. Under
this design, each recorded-time parameter is either a direct byproduct of a
view W3 builds, or it waits for the view it needs:

- **`search {known_as_of}` (new in the slice).** The historical retriever as
  a keyword search op: full surface only, lexical, and the same refusals and
  disclosures as think. It is the LLM-free door to W3's retrieval, the surface
  the invariance gate also runs through, and the cheapest user-visible answer
  to "which pages said X as of T".
- **`takes_list {known_as_of}`, with `page_slug` required.** The take rows of
  that page's body at T, through `bodySubjects`, with W4's holder and remote
  rule. Listing every take in the brain at T would mean reading every body, so
  without `page_slug` the parameter refuses `invalid_params`.
- **Deferred, each until its view exists.** `recall {known_as_of}` needs the
  fact-state reader (branch 17). `get_links {known_as_of}` needs the link
  history index (branch 13). `ontology_get` and `entity` need both. Nothing
  consumes those views in wave 4, so building them now would be designing
  ahead. The plan's rule that the wider parameters wait for evidence of need
  still applies.

The slice therefore shrinks to two parameters on views W3 builds anyway, and
its estimate moves into W3's (section 9).

## 9. Estimate and verdict

Implementation estimate, in the plan's units (human-days / agent-hours):

| Piece | Effort |
|---|---|
| History text index: migration (3 tables, GIN and btree indexes, RLS), interval rows and take rows maintained in `appendBeliefEvents`, the test-only row check, purge, expiry and hard-delete hooks (metadata included), the two-pass preview-first build command, doctor rows, the write-cost bench | 4 / 18 |
| `readPagesAtTime` batch reader (with `readPageAtTime` refactored onto it first) and the historical retriever (refusals, page and take candidate SQL, exact confirmation, scorer, remote rule with W4's later-private restriction and re-scoring, withdrawal union, disclosures) | 3 / 14 |
| think integration: parameter and CLI flag, gather switch, hydration, takes from bodies, trust at T, anchor and aliases at T, temporal context, refusals, the `known_as_of` result block, citations | 2 / 10 |
| W2 second slice as reshaped: `search {known_as_of}`, `takes_list {known_as_of}` | 1 / 5 |
| Invariance gate: both engines, both callers, 11 mutants, restriction and coverage cells, brute-force oracle, the performance gate; the N6 variant | 2.5 / 13 |
| Docs, the catalogue reason, protocol and tool catalog, schema budget test | 0.5 / 3 |
| gbrain-evals: belief as-of QA generator, preregistration, runner, deterministic scorer | 2 / 10 |
| **Total** | **15 / 73** |

**Cost of the QA eval.** At the pricing table's rates (`src/core/model-pricing.ts`),
per reader per answer:

| Reader | Input rate | Output rate | Cost per reader for 200 answers |
|---|---|---|---|
| Opus 5.5 | $4 per 1M tokens | $20 per 1M tokens | about $7.20 |
| Sonnet 5.5 | $2 per 1M tokens | $10 per 1M tokens | about $3.60 |
| GPT-6.1 Sol | $2 per 1M tokens | $10 per 1M tokens | about $3.60 |

That assumes about 6,000 input tokens and 600 output tokens per answer, since
think's pages block is budgeted at 12,000 characters, plus takes and the system
prompt. The total is about **$14** a run, and $10 to $19 across 4,000 to 8,000
input tokens. The invariance gate, the N6 variant and the index build cost $0.
The plan's "$3 to $6 if built" underestimates this: 600 frontier answers with
think's evidence block cannot cost that little. The preregistration caps the
run with `--paid --budget-usd 20`.

**Does it close within wave 4's remaining budget? Yes.** $137.88 of the $150
remains. Here is the paid work still ahead in wave 4, at each item's plan upper
bound:

| Item | Upper bound |
|---|---|
| E2 W5 custodian rerun | $8 cap |
| W6 | $15 |
| W8 | $8 |
| W9's eval | $40 |
| W11 | $20 |
| W12, two arms | $10 |
| **Subtotal** | **$101** |
| W3's QA at its cap | $20 |
| **Total** | **$121** |

That leaves about $17 of headroom at every upper bound. The lower bounds total
about $55. W12 at three arms would still leave $12. W3 needs no money beyond
its QA. Its real cost is the 15 human-days, the one additive migration (folded
into 4b's) and no extra merge slot (it rides 4b). Two things would flip this
verdict to "out of V1": the write-cost bench missing its 15% budget with no
acceptable fallback, or the invariance gate failing for a reason the design
cannot fix.

## 10. Changes this design makes to the plan

- W3's Migration cell: **yes**, one additive (the three index tables), folded
  into wave 4b's one migration.
- W3's paid cell: about $14, capped at $20 (was $3 to $6).
- W2's second slice: `search {known_as_of}` and `takes_list {known_as_of, page_slug}`.
  `recall`, `get_links`, `ontology_get` and `entity` are deferred until their
  views have a consumer.
- W3's implementation estimate: 15 / 73, which includes the reshaped second
  slice.
- The catalogue entry `coverage_from` gains the reason `history_index_incomplete`.

## 11. Alternatives considered

- **Filter today's candidates by T.** Rejected by the plan (section 1). It
  also fails mutant (b) in the gate.
- **Scan every page live at T on every call.** It is exact, and it is the
  gate's brute-force oracle. But its cost grows with brain size: one
  page-at-time read per live page per question. Rejected as the product path,
  kept as the reference.
- **A whole-body tsvector per revision on `page_versions`.** It overflows the
  1 MB tsvector cap on large inline pages (#2704), and it stores the full text
  of every revision. Chunk deduplication stores only edited text.
- **An asynchronous index with a cursor.** The write path stays as it is. But
  the read path would have to refuse any T whose events are not all indexed,
  and across pages the only order is by commit mark (ledger design section
  5.3), so the cursor must follow commit marks and handle events with no mark
  yet. It is kept as the fallback if the synchronous write cost misses its
  budget.
- **Embeddings for every revision.** These would bring back the vector arms.
  But they are a paid cost per edit, which needs the maintainer's decision and
  a measured benefit. They are out of V1 and recorded here as the index
  branches 2 and 12 would need.
- **Restore a backup taken at T.** Backups are not taken per instant, and a
  restore cannot be served per request.

## 12. Open questions

1. **Uncovered sources. Taken: refuse.** Section 5 refuses the whole call when
   any source in scope is uncovered, naming the source; it never answers
   partially with a disclosure. The maintainer may still prefer partial answers
   for federated owners later.
2. **The reranker over T text (branch 6).** It is allowed in principle and
   off in V1 so the gate stays deterministic. Turning it on later needs a gate
   cell with a deterministic stub reranker.

## 13. Build notes

What the build changed from the text above, or measured, so a reader of the
code finds no surprise:

- **Migration v257** (`belief_history_index`) adds four tables, not three:
  `belief_text_revisions`, `belief_text_chunks`, `belief_text_revision_chunks`
  and `belief_text_index_state`. The fourth holds each source's index cut and
  build pass, so the cut stays unset until build pass 1 completes. A source
  enabled after the migration gets its cut at its coverage start.
- **The body every caller reads** goes through `sanitizeRemoteBody` and
  `credentialSafeProjection`. This is the same projection the current gather
  renders for local callers too (`boundedProjectedPrefix`). So a withdrawn fact
  row is dropped rather than struck, private rows stay out of a local page block
  just as they do today, and takes reach the prompt only as take blocks.
- **Restrictions on the body** reuse W4's rule (`changes.ts` `subjectsOf`).
  A restricted fact row enters the withdrawal overlay as a purge tombstone, so
  one overlay pass applies the withdrawal union and the restriction together.
- **The write-cost bench** was a put_page bench in scratch, because
  `test/bench-publish.test.ts` only tests baseline files. It ran interleaved
  with master on both engines (3 rounds × 15 runs), then 6 more rounds × 30 runs
  of PGLite typical pages. The largest p50 change was +11.8% (PGLite, one-fact
  edit of a typical page), inside the 15% budget.
- **Mutant (b)** reads candidates from today's `content_chunks` and truncates
  at the limit before the T filter, which is the shape of filtering today's
  ranking by T. Without the truncation, the OR query matches nearly every page
  of the synthetic world, and the gate cannot tell the mutant apart.
- **The world fixture** restores the trust tier of its two renamed pages after
  each rename. A sync rename retiers the moved page to `unknown`, which is a
  restriction (branch 16), and assertions 1 and 2 compare under a later history
  with no restriction. The trust cell of assertion 5 tests a demotion.
- **The CLI** is `gbrain beliefs history-index --source <id> [--apply] [--json]`.
  It previews by default and resumes on a rerun.
