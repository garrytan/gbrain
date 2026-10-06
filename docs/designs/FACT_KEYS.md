# Fact keys in chunk embeddings — design note

Status: **killed by the preregistered gate (2026-10-05); no product code
ships.** Fact keys under `balanced` did not beat `tokenmax` synopses on the
LoCoMo development conversations, which the gate requires, and did not beat
`balanced` there either. The full build described below (migration v209
`page_fact_keys` + `content_chunks.fact_keys`, publication, retirement,
withdrawal discovery, `gbrain fact-keys`, doctor `retrieval_enrichment`) is
preserved in branch history at `5024ec99f4f591227d12b39b38e304d3255de2c5`.
Results and the decision record:
[`docs/eval/TIME_AWARE_RETRIEVAL_RESULTS.md`](../eval/TIME_AWARE_RETRIEVAL_RESULTS.md),
[`docs/eval/decisions/p6-fact-keys/`](../eval/decisions/p6-fact-keys/).
This note covers obligations 1–9 from the preregistered plan
([`docs/eval/TIME_AWARE_RETRIEVAL_PREREG.md`](../eval/TIME_AWARE_RETRIEVAL_PREREG.md)).

## As built (at `5024ec99f`, not shipped)

- **Only `title`-mode pages are keyed.** Keys exist only in the title-tier
  embedding input (the `balanced` default). Pages in `none` or
  `per_chunk_synopsis` mode get no keys, so per-chunk tier detection on
  synopsis pages isn't needed: a synopsis page never carries keys, and its
  title-tier vectors from a partial re-embed carry none either.
- **`content_chunks.fact_keys`** holds each chunk's derived key text, next to
  the `page_fact_keys` provenance rows. Chunk rows carry their keys through
  `getChunks`, so `wrapChunkTextsForStoredMode`, `embeddingInputHash` and
  every plain re-embed path build the same keyed input with no extra lookup.
- **Exact-input install check.** `installPageEmbeddings` refuses a title-tier
  vector whose key text differs from the stored row. Callers pass the key text
  they embedded, or the prepared row the input was built from. This is the
  captured-input comparison of obligation 6, done on the input itself rather
  than on a separate hash parameter, so every existing caller is covered.
- **One SQL rule in `upsertChunks`:** when a row's key text changes and the
  incoming row brings no new vector, the stored vector and its provenance are
  dropped in the same statement. Re-chunking a page (the replacement chunks
  carry no keys) therefore never leaves a keyed vector behind, and
  `retireStaleFactKeys` deletes the rows of older revisions on every path that
  seals a new chunk set.
- **Withdrawal** finds keyed pages through `page_fact_keys` (key subject `'*'`
  matches any subject-scoped withdrawal) and sends them down the existing
  delete-and-rebuild path. The rebuild runs under a new revision, so the
  page's other keys are retired too until its next extraction.
- **Disable and recovery are commands.** `gbrain fact-keys clear` strips keys
  page by page with the same prepare-then-swap (re-embed without keys, then
  swap), whatever the setting says. `gbrain fact-keys refresh` re-runs facts
  extraction for eligible pages without current keys. `gbrain fact-keys status`
  and doctor's `retrieval_enrichment` report coverage and leftovers.
- **Extraction lanes.** Keys come from the extractor's output for that lane.
  `put_page` and capture lanes extract every notability tier. Git sync asks
  the extractor for high-notability facts only, so synced pages carry fewer
  keys.
- **Other vector columns** of a re-keyed chunk are nulled in the swap
  transaction. Only the active column gets the new vector.

## What it does

gbrain already extracts facts when an eligible page is written
(`facts/backstop.ts`; on by default, `facts/extract.ts`
`isFactsExtractionEnabled`; eligibility in `facts/eligibility.ts`). Fact keys
take the extractor's output for the current revision of a page and place each
item in the embedding input of the chunk it best matches:

```
<context>{title}
{fact; fact; fact}
</context>
{chunk text}
```

The vector then matches questions phrased the way the fact is phrased.
Stored `chunk_text`, the keyword index, reranker input, snippets and returned
evidence don't change, and a key never appears as text in any response.

## Evidence

All numbers come from development data. Held-out verdicts set the default.

| Arm (strict recall_all@5, `balanced`) | LongMemEval-S | LongMemEval-M |
|---|---:|---:|
| baseline | 450/470 | 367/470 |
| chunk keys, published user-fact prompt | 451/470 | 383/470 (+3.4 pts, CI [+1.5, +5.5]) |
| chunk keys, gbrain's extractor as shipped (Haiku 4.5 pinned) | 452/470 | 381/468 vs 366 (+3.2 pts, CI [+1.3, +5.1]) |
| page keys (every fact on every chunk) | 435/470 (rejected) | — |

On M, gbrain's own extractor can't be told apart from the published prompt
(−0.2 pts, CI [−2.1, +1.7]), so keys reuse the extraction the backstop already
pays for. The preregistered comparison against `tokenmax` synopses has **not**
run, so the development gate is incomplete (open question 1).

## Design

### Invariant

The design rests on one invariant: **every searchable vector was built from
the page's current key rows.** Adding or replacing keys is optional
enrichment, so it never destroys a working vector. Replacement vectors are
embedded first, and the keys and vectors are then swapped in one guarded
transaction. If anything fails, the previous keys and vectors stay in place.
Removing keys for withdrawal or projection retirement invalidates
synchronously and relies on rebuild paths that already exist and are durable.
Install stamps a vector only when the hash captured before the provider call
equals the hash recomputed from the current rows under the page lock.

This departs from obligation 5's `needs_reembed` marker, as the review
recommended. A marker would need a per-column debt flag threaded through about
a dozen stale readers (`embed-stale.ts`, `embed-oversize-heal.ts`,
`persistence/noop-kernel.ts`, `embedding-invalidation.ts`,
`embedding-migration.ts`, `embedding-migration-worst-case.ts`,
`embed-consent.ts`, `sync-status-report.ts`, onboarding counters, `types.ts`,
`utils.ts`). It would also keep vectors whose key provenance is gone, which
breaks withdrawal (see 4). Prepare-then-swap needs neither: a page waiting for
keys keeps its old, valid vectors, and there's no debt left for a background
process to clear. That matters because the cycle's `embed --stale` phase runs
only where autopilot is installed, which needs separate consent
(`commands/autopilot/install-consent.ts`).

### 1. Occurrence keys, bound to a page revision

The keys are stored in a new table:

```sql
CREATE TABLE page_fact_keys (
  page_id           INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  source_id         TEXT    NOT NULL,
  page_revision     UUID    NOT NULL,
  ordinal           INTEGER NOT NULL,   -- extractor output order
  item_text         TEXT    NOT NULL,
  item_fingerprint  TEXT    NOT NULL,   -- gbrain_fact_fingerprint(item_text)
  subject           TEXT    NOT NULL,   -- resolved entity slug or '*'
  visibility        TEXT    NOT NULL CHECK (visibility IN ('private','world')),
  extractor_version TEXT    NOT NULL,
  PRIMARY KEY (page_id, page_revision, ordinal)
);
CREATE INDEX page_fact_keys_withdrawal ON page_fact_keys (source_id, item_fingerprint, visibility, subject);
```

- Each row holds the extractor's own output for that revision, captured before
  dedup (`backstop.ts`, where `dedupCapturedFacts` runs). It is never the
  canonical dedup winner, because a cosine ≥ 0.95 match can carry a different
  amount or date. Subject and visibility belong to the occurrence's identity,
  so the same text about two entities stays two rows.
- The extractor's output order is stored in `ordinal`. Assignment and the
  800-character cap read rows in that order, so production and eval build the
  same bytes.
- A page has rows for at most one revision. Publishing a revision replaces the
  previous rows.
- **Projection cleanup.** Every path that seals a new chunk set for a page runs
  one shared hook, `retireStaleFactKeys(tx, page)`, inside its own transaction
  and under the page lock. That includes `installPageProjection` (both the
  rebuild and preservation branches) and the direct import path in
  `import-file.ts`, which deletes and upserts chunks itself. The hook:
  - deletes only rows whose `page_revision` differs from the locked current
    revision, so keys that won an extraction/install race survive;
  - recomputes assignment against the replacement chunks;
  - invalidates every embedding target, not just the active column, for chunks
    whose effective input changed.

  A new revision without fresh extraction therefore keeps no rows and no keyed
  vectors.

### 2. Publication (obligations 1 and 3)

The publication paths don't share a guarded revision. Managed extraction
captures one and checks text equality (`persistence/facts-maintenance.ts`
`prepareManagedFactsSession`), but it returns null for unmanaged brains. It
also commits in several child transactions that accept revisions produced by
the same batch (`persistence/facts-prepare.ts`). The unmanaged pipeline
extracts the caller's `parsedPage.compiled_truth` (`backstop.ts`), even when a
queued job runs it later, and that text can already be older than the stored
page. The legacy path writes each fact in its own transaction without checking
the revision.

So keys don't ride on fact publication. They get their own guarded write,
which both paths use:

1. **Bind the input before extraction.** The backstop entry
   (`runFactsBackstop`, where eligibility is checked) reads a page snapshot
   `{page_id, revision, source incarnation, compiled_truth}`. It requires byte
   equality between the snapshot's `compiled_truth` and the text about to be
   extracted, the same check managed preparation makes today. On a mismatch,
   the run extracts facts as it does now but publishes no keys. The queued job
   carries the snapshot, not the caller's object. It also records whether the
   sanitized body equals the raw body (see 3).
2. **Keep raw items, then prepare vectors.** On both paths, the items and
   their resolved subjects are kept before dedup, so all-duplicate and partial
   batches still key. Outside any transaction, the publisher computes the new
   assignment and finds the chunks whose effective input changes (see 5). It
   embeds those inputs through the spend gate and captures each input hash.
3. **Publish in one transaction**, `engine-sql/fact-keys.ts`
   `publishPageFactKeys`, following the global persistence lock order
   (`persistence/protocol.ts`):
   - declare the persistence protocol first, which takes the brain row
     `FOR SHARE`;
   - take the source row `FOR SHARE`, which conflicts with withdrawal's
     `FOR UPDATE` (`facts/withdrawal.ts`);
   - lock the page key (`lockPageKeys`; repeating the source lock inside it
     is safe) and re-read the snapshot. If the revision, incarnation or text
     differs, or the page is deleted, archived or `embed_skip`, nothing is
     published;
   - recheck protected-content eligibility and read `search.fact_keys` under
     the page lock;
   - drop items matching `fact_withdrawals`;
   - check that every prepared vector's captured hash still equals the hash
     recomputed from the new rows and the chunk's current text and tier;
   - replace the page's rows and install the prepared vectors for the changed
     chunks together (see 5). If any check fails, nothing is written.

   The transaction writes no request or effect rows. It always runs as its own
   top-level transaction, never nested inside a caller's.

The write is idempotent: republishing the same revision produces the same rows
and changes no vectors. Fact publication and its multi-commit semantics are
untouched. This departs from obligation 3's "atomically with the facts". What
that obligation protects is revision binding and withdrawal filtering, and the
separate guarded write gives both on either path. Keys never read fact rows,
so atomicity with them adds nothing.

### 3. Protected content and visibility (obligation 2)

- **Protected content.** Extraction reads raw `compiled_truth`, while chunks
  use the stricter remote sanitizer (`remote-body.ts`). A page whose sanitized
  body differs from its raw body gets no keys. Publication rechecks this under
  the page lock, and doctor counts skipped pages.
- **Visibility is an intersection, never a widening.** A key is used only when
  its fact visibility is at least as open as the page's. In practice: `world`
  facts key any page; `private` facts key only pages that are themselves
  private (`search/private-visibility.ts`). Ordinary pages default to world,
  but extracted facts default to `private` unless `facts.default_visibility`
  is `world` (`facts/visibility.ts`). The single-principal posture that
  bootstrap configures sets it to `world`. Under the fail-closed default, a
  world page gets no keys from private facts, and doctor reports that
  coverage gap with its fix (`gbrain config set facts.default_visibility
  world`, which needs the user's agreement). The alternative policy is
  open question 4.

### 4. Withdrawal (obligation 4)

`forget` already deletes the chunks of affected pages and queues their
rebuild in the same source-exclusive transaction (`facts/withdrawal.ts`). For
fact keys:

- Discovery (`facts/withdrawal-discovery.ts`) adds one branch: pages with a
  `page_fact_keys` row matching the withdrawn row's source, visibility,
  fingerprint and subject (`'*'` matches any subject). It joins on the key's
  subject, not the page slug, so a meeting page keyed with a fact about an
  entity is found. These pages join the same target union under the same
  256-page ceiling and go down the same delete-and-rebuild path.
- The invariant makes this complete: a searchable vector always comes from
  current rows, so no stale vector has lost its provenance. Disabling keys or
  replacing an extraction nulls the affected vectors first.
- Rebuild drops withdrawn items. Publication filters them too, and the shared
  source lock closes the race between the two.

Tests cover withdrawal right after extraction, after a replacement extraction,
and after disable, plus fan-out above 256 pages (refused as it is today). The
promise covers enrichment only: withdrawn enrichment stops influencing
retrieval when the withdrawal commits. The page's own prose is unchanged.

### 5. Changed chunks, tiers and refresh (obligation 5)

- **The installed tier is per chunk.** A synopsis page can hold title-tier
  vectors after a partial stale embed, because master accepts both hashes on
  such pages (`embedding-input-hash.ts` `acceptedEmbeddingInputHashes`;
  `embed-stale.ts` demotes only after a full re-embed). For each chunk, the
  tier is identified by matching its stored `embedding_input_hash` against the
  candidate hashes computed with the old keys. A title-tier or `none`-tier
  chunk includes its assigned keys. A synopsis-tier chunk always uses null
  keys, so new facts on a fully synopsis page change nothing and don't trigger
  the worker's whole-page re-embed and demotion (`persistence/effects.ts`). A
  chunk whose provenance is unknown (null or unmatched hash) is treated as
  changed and re-embedded under the page's plain tier.
- **Keys are added or replaced by swap only.** Changed chunks are re-embedded
  first (step 2 of publication) and swapped in with the rows. A failed or
  refused embed publishes nothing, so the page keeps its previous keys and
  vectors, and keyed-coverage counts report it as unkeyed. The failure is
  returned in the backstop result (`fact_keys: {published: false, reason}`)
  and counted in doctor's `retrieval_enrichment` check along with the
  recovery command, `gbrain fact-keys refresh --page <slug>`. No vector is
  ever nulled in this path.
- **Removal invalidates synchronously and rebuilds on existing durable
  paths.** Withdrawal already deletes the affected pages' chunks and queues
  their rebuild through the revision trigger (`facts/withdrawal.ts`).
  Projection retirement (`retireStaleFactKeys`) runs inside a sealing path
  that embeds the new chunk set itself.
- **Metadata.** When the swap replaces a vector, it also updates
  `embedded_at`, `embedded_text_hash` and `embedding_input_hash`, for every
  embedding target that the publisher prepared. A target it didn't prepare,
  such as a non-active column, is nulled for changed chunks and picked up by
  that column's existing migration and backfill path.
  `text_projection_revision` stays sealed, so keyword search is unaffected
  (`search/safe-chunks.ts`). `embedding_signature` is kept, because null
  vectors already override it in stale selection (`engine-sql/chunks.ts`).
- **`embed_skip`.** Stale selectors deliberately exclude `embed_skip` pages
  (`engine-sql/chunks.ts`), so publication never keys them (see 2). Doctor
  lists them in the unkeyed bucket.

### 6. No false-current installs (obligation 6)

`installPageEmbeddings` (`page-state/projections.ts`) stamps the hash
recomputed from the row at install time. Fact keys change this:

- Every caller passes the hash it captured before the provider call. That
  covers the effects worker, `embed-stale.ts`, `commands/embed.ts`,
  `import-file.ts` and `contextual-retrieval-service.ts`. The parameter
  becomes required, with no fallback to the current row.
- Under the page lock, install recomputes the hash from the current key rows.
  It stamps only on equality; otherwise it writes nothing.
- Install also validates incoming vectors: the captured hash must be the
  hash of the bytes that were actually sent to the provider.
- **Disable** sets `search.fact_keys off` first, then sweeps pages that still
  have rows. For each page, the sweep re-embeds keyed chunks without keys,
  then swaps them in and deletes the rows under the page lock, the same
  prepare-then-swap as publication. Keyed vectors are therefore never left
  null. The sweep is
  idempotent and resumable. If it's interrupted, rerunning `gbrain config set
  search.fact_keys off` or `gbrain doctor --fix` finishes it, and doctor flags
  rows that remain while the setting is off. Publication reads the setting
  after taking the page lock, so a publication that runs behind the sweep sees
  `off`.

Tests cover new keys, disable and a visibility change, each during an
in-flight embed, on both engines.

### 7. The hash covers every tier (obligation 7)

`EmbeddingInputContext` gains per-chunk `factKeys: string | null`.
`embeddingInputHash` digests it in the `none`, `title` and
`per_chunk_synopsis` tiers when it's non-null. A null value keeps today's
bytes, so no existing vector is invalidated by the upgrade.
`acceptedEmbeddingInputHashes` follows. Each tier gets golden tests.

### 8. tokenmax (obligation 8)

Keys apply only to pages embedded under the `none` or `title` tier:

- **Publication on a synopsis page** re-embeds only chunks whose own
  installed tier includes keys (title-tier chunks left by a partial re-embed);
  synopsis-tier chunks are untouched (see 5).
- **Promotion to synopsis** (`contextual-retrieval-service.ts`) computes the
  synopsis-tier input with no keys. The hash differs, so keyed vectors are
  replaced in the normal way.
- **Demotion to title** by the worker (`persistence/effects.ts`;
  `embed-retry.ts`) re-embeds the whole page under the title tier with its
  current keys, using captured hashes. Partial re-embeds are tested in both
  directions.

### 9. Downgrade (obligation 9)

There is no downgrade-safety claim. Older writers ignore the invalidation
rules (`cycle/extract-facts.ts`). Before a downgrade, the migration note
requires `search.fact_keys off` followed by a clean `embed --stale`.

### Graduation

`page_fact_keys` carries as `user_data`, the same as
`chronicle_page_state`, because the rows are paid extraction output and the
carried vectors were built from them. Dropping the rows while carrying the
vectors would break the invariant. `persistence/graduation-inventory.ts` gets
the row, and the carry count rises by one.

## Cost

- **Extraction:** no new calls. Keys reuse the backstop's extraction on
  eligible writes. Its default model is the reasoning tier; the dev gate
  pinned Haiku 4.5, and sealed runs use the shipping default.
- **Embedding:** an eligible page is embedded at write time, so it's
  searchable at once. Keyed chunks are re-embedded after extraction lands, so
  a keyed single-chunk page costs more than twice its original embedding
  tokens. The bound is measured on the **fact-bearing cohort** (eligible pages
  with keys), not on a diluted whole corpus, over a full write → extract →
  refresh cycle. The result is reported against the preregistered ≤1.3× bound
  and is expected to exceed it. Accuracy decides the default; the extra spend
  is reported as the price of intended work (open question 3).
- **Backfill:** existing brains have facts but no occurrence keys, and keys
  can't come from canonical facts. So a backfill means paid re-extraction plus
  re-embedding. The estimate prices both. Today's consent estimator only
  counts null-vector chunks (`embed-consent.ts`), so it gains an extraction
  term. Backfill follows the post-upgrade contract
  (`post-upgrade-reembed.ts`): non-interactive spend is deferred, and agents
  relay the prompt. New writes get keys with no backfill.

## Configuration and defaults

There is one key, `search.fact_keys` (`on` | `off`). The held-out verdict sets
its default: on when the verdict passes and both an embedding key and facts
extraction are configured, otherwise off.

Doctor check `retrieval_enrichment` reports keyed pages and eligible but
unkeyed pages, grouped by reason: protected, visibility, `embed_skip`, no
extraction yet, or failed publication. Each group comes with its fix command.

`gbrain fact-keys refresh [--page <slug> | --source <id>] [--max-usd <n>]
[--dry-run] [--json]` is a new CLI-only command and adds no new op. For eligible
pages without keys, it re-runs extraction and publication through the spend
gate. It serves as both the recovery command and the backfill command. It's a
writer under the P8 `writeInference` contract (#6027), and it gets classified
there.

## Files

- Migration (`page_fact_keys`), `schema.sql` and the generated blobs.
- `engine.ts`, both engines, and a new `engine-sql/fact-keys.ts`.
- `facts/backstop.ts` (bind the snapshot, carry it through queued jobs, keep
  raw items, both paths),
  `facts/withdrawal-discovery.ts`, `facts/withdrawal.ts`.
- `fact-keys.ts` (ordered input), `embedding-context.ts`,
  `embedding-input-hash.ts`, `page-state/projections.ts` (required captured
  hash; the shared `retireStaleFactKeys` hook), `import-file.ts` (same hook on
  the direct path).
- `persistence/effects.ts`, `embed-stale.ts`, `commands/embed.ts`,
  `import-file.ts`, `contextual-retrieval-service.ts`, `embed-retry.ts`.
- `embed-consent.ts`, `post-upgrade-reembed.ts`, `backfill-registry.ts`.
- `persistence/graduation-inventory.ts`, the doctor check, and
  `commands/fact-keys.ts` (the `refresh` command).

## Tests

- **Unit:** per-tier hash goldens with and without keys; ordered assignment;
  the visibility intersection.
- **Publication:** a superseded revision or stale submitted text publishes
  nothing (managed and unmanaged brains, including queued jobs);
  all-duplicate and partial batches still key; protected-content, archive and
  `embed_skip` rechecks; idempotent republish; publication on an active
  synopsis page invalidates nothing; lock order is exercised against a
  concurrent topology change and a concurrent withdrawal.
- **Lifecycle (E2E, both engines):** extraction → prepared vectors → swap with
  captured-hash checks; a failed or refused embed leaves the previous keys and
  vectors intact and reports `published: false`; a synopsis page with a
  partial keyed title refresh, followed by key replacement and by withdrawal; the three install races; withdrawal after
  extraction, replacement and disable; an interrupted disable sweep resumes;
  projection cleanup on both the rebuild path and the direct import path keeps
  race-winning keys; A→B→A key changes; the >256-page refusal; tokenmax
  promotion and demotion with partial re-embeds; a graduation round trip that
  keeps the invariant.

## Decisions (2026-10-05)

1. **The `tokenmax` gate** stays in the gate. It runs on LoCoMo (development
   conversations, then a third arm on the sealed run), because on
   LongMemEval-M production synopses would cost about $4,280. M stays as
   confirmation against `balanced` only (preregistration amendment 2).
2. **Extractor model:** sealed cells use the shipping default. Haiku 4.5 is
   disclosed as the development stand-in.
3. **Embedding cost** is reported, not gated (amendment 1). The verdict
   reports the embedding-spend ratio on the fact-bearing cohort and sync time.
4. **Visibility** fails closed. Coverage is reported with
   `facts.default_visibility` unset and set to `world`.
