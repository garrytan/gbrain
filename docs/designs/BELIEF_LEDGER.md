# Belief ledger (`belief_events`): design

Status: **design, not built.** This note is wave 4a's first item (W1 in the
10x memory-advantage plan, `docs/plans/2026-10-07-10x-memory-advantage/PLAN.md`
in gbrain-evals, wave 4). No code ships with it. W1's implementation, W2's
page-at-time reads and W4's weekly change diff are built on what it settles.
Every `file:line` below was read on master `ea93c770` (v0.60.249.0, latest
migration v247).

Decisions folded in (Garry, after the trust-tier review on this PR): the
answers to section 12 questions 1–3, 5, 6 and 8; purge redaction follows every
carrying field (section 6.5); the active-memory purge policy and restore-time
purge replay (sections 6.5 and 8). The pre-W1 integrity wave, #6789, fixes
question 6's data loss and the purge read leaks the trust-tier review found
in shipped code (section 6.5). Question 7 (storage) is decided: one snapshot
event per page at creation (section 9).

## 1. What the ledger is

The ledger records **what this brain had recorded, and when**. It is one
append-only table, `belief_events`. Each row is one canonical transition of a
page, fact, take or typed-link assertion. The row is written in the same
transaction that publishes the change, keyed on a logical identity that
survives row-id churn, renames and engine copies.

It is **canonical audit state, not a projection.** Recorded time cannot be
rebuilt from Markdown: a fence carries what is true now, git carries file
history without observation time, and a fence format change produces held
files. The ledger therefore joins the DB-only category of
[system of record](../architecture/system-of-record.md#db-only-by-design-named-exceptions),
next to the withdrawal ledger and the mutation journal, and it carries a
backup and migration contract (section 8).

V1 answers "what this brain had recorded since its coverage watermark" (section
7), and it certifies that answer only on managed sources, where every write
of a fact, take or page passes a coordinated path. It does not claim what the
owner privately believed, and it does not certify historical observation for
anything it backfills or anything an unmanaged writer changed.

What it is not:

- It is not a diff of database rows. One prose edit to an entity page rewrites
  26 rows (a large page rewrites 256) while changing zero beliefs (section 9).
- It is not a replacement for `page_versions` (page bodies), `trust_proposals`
  (owner decisions), `write_gate_receipts` (gate verdicts), the purge
  tombstones or `persistence_requests` (request identity). It references them;
  it does not copy them.
- It does not record derived projections that can be recomputed from recorded
  evidence: `link_relationships` (both scopes), `timeline_entries`, chunks,
  embeddings, caches.

## 2. Why row-level capture fails here

The plan's eng review (finding 13) required the ledger to record canonical
transitions, not differences in disposable projections. The current code
confirms why.

**Facts.** The fence projection expires and detaches a replaced or removed
row instead of deleting it (`UPDATE facts SET expired_at=…, row_num=NULL`,
`src/core/persistence/canonical-projections.ts:413-418`). A changed claim at the
same fence position is inserted as a new row with a new id (`:472`, through
`engine-sql/facts.ts:195-222`). Then every fence row's cells are rewritten
unconditionally (`factFields`, `:420-430`), changed or not. That same statement
clears `expired_at` on rows a deleted page had expired, which is how restore
and revert re-activate facts. Higher-trust rows are first detached, then
moved back by `guardFenceRows` (`src/core/trust/fence-guard.ts:54`, `:72-73`).

**Takes.** Removed takes are deleted by row number (`dropTakes`, `:432`).
Kept takes are re-upserted with `updated_at = now()` (`:477`,
`engine-sql/takes.ts:73-90`). Every take's seven resolution fields are then
rewritten from Markdown (`resolveTakes`, `:433-445`), so a revert restores
resolutions, and an ordinary publish of a fence without resolution columns
nulls resolutions recorded only in the database (section 12, question 6).

**Typed links.** `refreshRelationships` keeps two materializations, `all` and
`world`, per relationship (`src/core/link-relationships.ts:101-104`). It
overwrites both on every refresh even when `evidence_hash` is unchanged
(`:133-152`) and deletes them when evidence disappears (`:105-107`,
`:155-163`). Every derived-link publication deletes and reinserts the origin
page's derived `link_transitions`.

**Identity.** A rename through `updateSlug` keeps the page row and writes no
take or link row (`engine-sql/pages.ts:968-981`). The fallback rename moves
links, timeline and versions but not takes, `link_transitions` or
`link_relationships` (`src/core/page-state/rename-alias.ts:80-104`). A hard
delete removes takes, links and relationships by FK cascade with no
application code.

**Blocked writes.** A lower-trust write that would supersede a higher-trust
row is not refused. It is contested: the new row is inserted active, the
higher-trust row stays, and a `trust_proposals` row is filed (section 6.2).
Part of that decision happens in prepare, before projection. A
post-projection diff cannot see it.

So a ledger fed by row triggers or a post-commit diff would record projection
churn as belief change. It would miss renames and cascades, and it would never
see the contested write. The ledger is instead fed by the **canonical diff
that the publishing writer already computes**, plus explicit events from the
guard and identity code paths.

## 3. Logical identity

Every event names a subject by a **logical key** that contains no row id.
Row ids (`facts.id`, `takes.id`, `pages.id`, `links.id`) and fence positions
(`row_num`) are payload only. They are recorded for debugging but never joined
on.

Two lifetimes scope every key:

- **Source lifetime.** `sources.incarnation` (a UUID minted when a source is
  created, `persistence/source-lifecycle.ts:246`). Removing a source deletes
  that row (`:278`), and re-adding a source with the same id mints a new
  incarnation. Every event stores `source_incarnation`, so an old source's
  history, watermark and authorization never attach to a new source that
  reuses its id.
- **Page lifetime.** `page_lifetime`, a UUID the ledger mints at the page's
  first event (its creation or its baseline, section 7.1) and stores in a
  side table `belief_page_lifetimes (source_id, source_incarnation, slug,
  page_lifetime, started_at, ended_at)`. It is not derived from
  `knowledge_revision`, which changes on every write (`src/schema.sql:1862`)
  and whose first value is not recoverable once versions are pruned. A soft
  delete keeps the lifetime: a later write to the slug restores the same page
  row and appends `page.restored` on it. Only a page removed outright (purge,
  retention cleanup) and then written again at the slug starts a new
  lifetime. A rename keeps the lifetime and records the new slug. Subjects with no page (database-only facts whose
  `entity_slug` names no page) have a NULL `page_lifetime` and are scoped by
  source lifetime and subject slug alone.

| Subject | Logical key (always under `source_incarnation`) | Notes |
|---|---|---|
| page | `page_lifetime` | Slug is payload, resolved through the lifetime table. |
| fact (claim) | `(subject, fp_version, fingerprint, visibility)` | `subject` is the page named by `source_markdown_slug` for fence rows and by `entity_slug` for database-only rows, serialized as its lifetime or, with no page, as the slug (rule below). Withdrawals already match on `(source_id, visibility, entity_slug, fingerprint)` (`src/core/facts/withdrawal.ts:77-82`). `fingerprint` is `gbrain_fact_fingerprint(fact)`, re-versioned once (`withdrawal-schema.ts:24-36`), hence `fp_version`. Two identical claims on one page are one belief whose value carries `count`, so reordering them emits nothing. |
| fact (ontology observation) | `(entity_slug, dimension, value_hash, source_markdown_slug, valid_from)` | The stint identity the schema already enforces (`v188-facts-ontology-stint-dedup.ts:15-17`). Stints with identical claim text are distinct beliefs. |
| take | `(page_lifetime, claim_hash, ordinal)` | `claim_hash` is over claim, kind and holder. `take_purges` hashes the claim alone, so events also carry the claim-only fingerprint for purge (section 6.5). `ordinal` separates identical claims on one page, ordered by `since_date` then row number at first sight, and stays fixed for the take's life. Row number is **not** identity: the collision check covers only new row numbers (`canonical-projections.ts:388`), and the upsert can replace a claim in place (`engine-sql/takes.ts:82-84`). A pure renumber emits nothing. An in-place claim edit at the same row is `take.retracted(old)` plus `take.asserted(new)` linked by `replaces`. |
| link assertion | `(from_source_id, from_slug, to_source_id, to_slug, link_type, link_source, origin_source_id, origin_slug)` | Every endpoint qualified by source, as the derived-links diff already does (`derived-links.ts:282-284`) and storage resolves (`engine-sql/links.ts:117-119`). Each endpoint and the origin are serialized as page lifetimes where a page exists (rule below); the slugs are payload labels. The event belongs to the **origin** page's stream (lock and order), else to the from page. |
| link transition | link key + `(kind, occurred_on, producer)` | Evidence rows from `link_transitions`. |

Identity changes are explicit events:

- **Rename** (`page.renamed`, carrying `old_slug` and `new_slug`): same
  lifetime, new slug. Because page-backed key components are lifetimes (rule
  below), a rename changes no key in any stream, including link keys in other
  pages' streams whose endpoint was renamed. The rename code rewrites fact
  slugs and link reads take endpoint slugs from the renamed page
  (`page-state/rename-alias.ts:54-57`, `engine-sql/links.ts:260-267`), and
  neither moves a key.
- **Merge** (phantom redirect). Not a rename: the managed merge is two
  requests (`cycle/phantom-redirect-managed.ts:4-12`), and both pages exist
  between them. The first transaction appends `page.published` for the
  canonical page and one `*.transferred` event per moved assertion, each
  naming the phantom's lifetime as `from_lifetime`. The second transaction,
  when it commits, appends `page.deleted` for the phantom. A crash between
  them leaves both pages live in the ledger, exactly as they are in the
  database. Overlapping claims on both pages stay two beliefs until a
  transfer names one of them.
- There is no code path that changes `pages.source_id` today (census P11), so
  `page.source_moved` is reserved but has no producer in V1.

**Slugs are labels; lifetimes are identity.** Every slug component in the
table above (a fact's `subject_slug`, each link endpoint and origin) is
serialized in `subject_key` as the page lifetime of the page that holds that
slug at the event, with the slug kept only as a label in the payload. A
component whose slug names no page (a database-only fact, a link to a page
that does not exist yet) is serialized as `(source_incarnation, slug)`. When
a page is later created at that slug, its first publication appends one
`*.adopted` event per page-less subject at the slug, moving it from the slug
form to the lifetime form in the same transaction, so a reused slug never
joins an older page's history. Append, replay, subject lookup and
`state_hash` all use this one serialization.

**Keys are derived, never stored as foreign keys.** That is what makes the
ledger survive the legacy engine copier (fresh page ids, takes not copied:
`src/commands/migrate-engine.ts:492-608`, `:233-238`), the fallback rename and
row reuse. Graduation copies ids verbatim anyway (section 8).

## 4. Event taxonomy

The plan names five cases the design must distinguish: a projection refresh,
a real assertion, a visibility-only recomputation, row reuse, and an identity
change. Each case maps to exactly one rule.

| Case | Rule | Example |
|---|---|---|
| Projection refresh | **No event.** The canonical value under the logical key is unchanged. | `factFields` rewriting identical cells; a takes upsert with the same claim; both relationship scopes re-upserted with the same `evidence_hash`; derived `link_transitions` deleted and reinserted with the same content. |
| Real assertion | One event per key whose canonical value changed (types below). | A fence row's claim edited; a take resolved; a link added in Markdown. |
| Visibility-only recomputation | **One page-level event**, never per row. | A page soft-deleted (`page.deleted`), restored (`page.restored`), made private or quarantined (`page.visibility_changed`). The facts the cycle later expires for a deleted page (census F3) and the `world` relationship scope are consequences that readers derive. |
| Row reuse | Retract the old key and assert the new key, linked by `replaces`. If only the row id or position changed, **no event**. | A different claim written at fence row 3 retracts `fp(old)` and asserts `fp(new)`. A higher-trust row moved to a new row number by the guard emits nothing. A take renumbered emits nothing. |
| Identity change | One `page.renamed` event, or a merge (above). | Sync rename and fallback rename are renames; a phantom redirect is a merge. |

### Event types (V1)

Page: `page.published` (create or replace; carries `revision_before` and
`revision_after`; a create is a **snapshot**, below), `page.deleted`, `page.restored`, `page.reverted` (cause
carries the version's revision), `page.renamed`, `page.merged` (section 3),
`page.visibility_changed`, `page.view_changed` (the effective page view
changed without a publication: a withdrawal and its materialization, section
10), `page.purged`, `page.expired` (retention removal of an old soft-deleted
page, section 6.5).

Every event carries `state_hash`: a digest of its slug's whole belief set
(page, facts, takes, links in its stream) after the transition. The coverage
check compares a slug's live state with the newest event of any type for that
slug, so database-only fact events do not read as drift.

Fact: `fact.asserted`, `fact.revised` (non-identity fields changed:
confidence, `valid_from`, `valid_until`, kind, notability, context, typed
claim cells), `fact.retracted` (left the canonical set: fence edit, revert,
replaced), `fact.withdrawn` (`forget`), `fact.superseded` (a `remember` or
extract supersession that names its successor), `fact.transferred` (merge),
`fact.purged`.

Take: `take.asserted`, `take.revised` (weight, since, source), `take.resolved`,
`take.unresolved` (a revert or a publication that cleared resolution fields),
`take.retracted`.

Link: `link.asserted`, `link.retracted`, `link.transition_added`,
`link.transition_removed`.

Trust and gating (section 6): `trust.contested`, `trust.held`,
`trust.retiered`.

Purge (section 6.5): `fact.purged` and `page.purged` (above),
`derived.hidden` for a key whose row a purge hid through the derivation walk,
and `redaction.released` when an owner release binds a redacted field to a new
value (value `{releases: [{field, purge_request, released_hash}]}`, never the
released text; cause `released_by`, the publication the event belongs to).
Retention removal of an old soft-deleted page is `page.expired`, never
`page.purged`.

Identity (section 3): `fact.adopted` and `link.adopted`, when a page is
created at a slug that page-less subjects already named.

Coverage (section 7): `coverage.started`, `coverage.stopped`,
`coverage.restored`, `baseline` (one snapshot per page at activation, or per
subject where section 4 requires it), plus history
rows of any type marked `origin = 'backfill'`.

**A page creation is one snapshot event, not one event per subject**
(section 12, question 7, decided). The create's `page.published` carries
`snapshot: true`, the subject counts and `state_hash`, and no text. The
values at creation are the page body at `revision_after`: the live page until
the first edit, then that edit's preimage version (the same join W2 uses,
section 10). Per-subject events start with each subject's first transition
after creation, whose prior value is read from the snapshot's body. Three
cases keep per-subject creation events, because no retained body holds their
values: database-only facts (no page), subjects of a page over 1 MiB (only its
newest five large versions are kept, `page-state/versions.ts:6-12`, so its
creation body can be pruned), and page-less link endpoints.

A page delete or restore emits one page event, not one event per fact, take
and link: the beliefs of a deleted page end with it. This also keeps a
500-row page's delete at one row instead of about 450.

## 5. Publication ownership, idempotency and order

### 5.1 Who writes the event

**The writer that publishes canonical state writes its events, in the same
transaction, last.** There is no single publication function to hook:
`withCoordinatedWrite` supplies permission and attribution, not publication.
So W1 defines one **finalization contract**, `finalizeBeliefEvents(tx,
batch)`, and every transaction that commits canonical state calls it after
its last projection and before its terminal receipt. The publication paths
that must call it on this tree:

- single publication: `prepared.apply` at `coordinator.ts:417`, before
  `completeWrite` (`:425`), next to `queuePublicationEffects` (`:423`);
- grouped publication: `member.apply` at `persistence/group-publish.ts:345`,
  which also serves eligible single writes on Postgres (`:417-421`), per
  member, inside the group transaction;
- withdrawal: `forget` / `forget_fact` record the withdrawal and complete the
  request in their own transaction (`persistence/memory-mutations.ts:278-287`);
- fact purge: `facts/purge.ts:295-346`, which completes its own write (`:344`);
- page purge: `persistence/page-purge.ts:116-190`, inside the delete
  transaction;
- restore-time purge replay (section 8), inside restore's transaction.

Each publication's batch is built the same way:

1. The preparer already holds the prior snapshot it observed and the incoming
   parsed page (`prepareCanonicalProjections`, `canonical-projections.ts:369`).
   It computes the **canonical diff** there, outside the publication lock:
   fact keys added, changed and removed, take keys likewise, link keys from
   the derived-links diff, and the page event. The diff is valid at apply time because
   the coordinator refuses the publication when the page's revision moved
   since preparation (`revision_conflict`, `coordinator.ts:385`).
2. Inside the transaction, the projection closure reports what actually
   happened. `guardFenceRows` returns contested and held rows (section 6.2).
   The expire and delete statements already return only the rows they
   changed (#5969, `:404`), so a row changed since preparation is not
   reported.
3. `finalizeBeliefEvents(tx, batch)` inserts the batch in one statement, after
   every projection and before the terminal receipt. If the transaction rolls
   back, nothing was recorded. If it commits, the events and the canonical
   change commit together.

The diff is not recomputed from table rows after projection, and no trigger
writes ledger rows. A trigger would see 26 to 258 row writes per edit,
including cascades, but neither the contested decision nor the rename.

Entry points, from the census (`~/.capy/work/belief/census.md`, summarized
here):

- **Journaled publications** cover most canonical writes: `put_page`,
  `capture`, `edit_page`, `delete_page`, `restore_page`, `revert_version`,
  `takes_*`, `remember`, managed `extract_facts`, managed sync and import,
  file repair, connector materialization, canonical reconcile and every
  receipted managed-maintenance kind (dream write-back, fence adoption,
  phantom merge, relink, consolidation). They reach the single or grouped
  publication path on managed and unmanaged brains alike, with the per-kind
  diff supplied by the preparer. `forget`, `purge_fact` and page purge call
  the contract from their own transactions (list above).
- **DB-only coordinated writes** without a page publication
  (`coordinatedDatabaseWrite`, `database-write.ts:21-55`: `ontology_propose`,
  `repair ontology-facts`) and the owner actions that write no receipt (hold
  release, `trust/owner-actions.ts:186-198`; `setRowTier`, `page-handlers.ts:123-144`)
  call the same contract inside their transaction.
- **Unmanaged brains do not route Markdown changes through the shared write
  path.** On an unmanaged brain, sync and import publish pages in a
  `maintenanceTransaction` (`src/core/import-file.ts:860`), and fence facts
  and takes are projected later by the cycle (`cycle/extract-facts.ts:464`
  `writeFenceReconcile`; `cycle/extract-takes.ts:319-322`, whose deletes are
  bare `engine.executeRaw` calls at `:121`); system-of-record.md:187-192
  lists the rest (legacy renames, the unmanaged facts pipeline, repairs,
  consolidate, phantom redirect, bare hard deletes; census sections 4 to 8,
  about 25 writers, listed as W1-later in section 11). V1 calls the contract
  from the three projection points that carry most unmanaged belief change
  (legacy import, `writeFenceReconcile`, takes reextract) with
  `origin = 'unmanaged'`, so changes are recorded when they are projected. It does not certify them: the other writers can change
  the same subjects unrecorded, so **coverage on an unmanaged source is never
  certified** (section 7). Only managed sources, where the SQL guard refuses
  every fact, take and page write outside a coordinated path
  (`writer-guard-schema.ts:9-80`), can be certified, and even there links
  need the next item.
- **Links are not guarded** by the managed-writer trigger (`src/schema.sql:2176`
  covers pages, tags, aliases, facts, takes, timeline and sources), and
  several link writers bypass the coordinator even on managed brains (census
  6.4: rows 5-11, 17, 18, 20, 23, 24). Until each is routed, a managed source's
  link history is certified only for links written by journaled
  publications; link events from the bypass writers come from the
  coverage check's reconcile and are marked uncertified (section 12,
  question 5).

### 5.2 Idempotency key

`event_key = sha256(publication_id ‖ subject_key ‖ event_type)`, unique.
`publication_id` is the durable request's `persistence_requests.id` for
journaled writes. For a DB-only or maintenance transaction it is a UUID minted
once per transaction (or the minion job id, when the job is retried with the
same id).

The journal already makes a repeated request return its stored outcome
without executing terminal work again
([system of record](../architecture/system-of-record.md#page-write-persistence-boundary)). So
the fault-injection cell, a crash after durable publication but before the
caller's acknowledgement, retries into the stored outcome and appends
nothing. The unique `event_key` is a second line of defence for maintenance
writers that retry their own transactions.

### 5.3 Order and ties

- **Within one publication**: `ord` follows page event first, then facts,
  takes and links, each sorted by logical key. This order is deterministic and
  independent of row ids, so a replay produces the same keys in the same
  order.
- **Within one page across publications**: the publication holds the page
  key lock through commit (`tx.lockPageKeys`, `coordinator.ts:380`), and the
  ledger's `id BIGSERIAL` is assigned inside that lock, so `id` order is
  commit order for a given page. Every appender must already hold the page
  keys of its batch: the contract checks the transaction's held-key set
  (`HeldPageKeys`, `page-state/guards.ts:91-97`) and fails closed when a slug
  is missing. It never takes the lock itself, because a lock taken late in a
  transaction, outside `lockPageKeys`'s sorted acquisition (`guards.ts:20`),
  can deadlock.
- **Across pages there is no global commit order.** Postgres sequences hand
  out values at insert, not at commit, and PGLite and managed Postgres have
  no commit timestamps. Readers must not compare `id` across pages. Across
  pages, order is by `recorded_at` with the visibility rule below.
- **`recorded_at`** is `clock_timestamp()` at the append, the last statement
  before the receipt and commit. It is a lower bound on visibility, not a
  commit time. There is no usable upper bound from configuration: the
  publication ceiling only marks a write overdue, and on PGLite a running
  transaction cannot be cancelled at all (`persistence/publication-deadline.ts:16-17`;
  Postgres cancels at ceiling plus grace, `:117`). So W1 stores a durable
  **post-commit observation**: the contract queues a publication effect
  (`queuePublicationEffects`) that, after commit, writes
  `belief_commit_marks (publication_id, observed_at)`. A maintenance writer
  outside the effects queue writes its mark in a follow-up statement after
  commit. Any later reader that finds a committed event with no mark (a
  crash before the mark) writes one. Every mark takes `clock_timestamp()` in
  the same statement that reads the committed event
  (`INSERT … SELECT publication_id, clock_timestamp() FROM belief_events …`),
  never `now()`: `now()` is the observing transaction's start, and a
  long-running READ COMMITTED transaction can start before the publication
  commits and read its event afterwards. The writer refuses a mark whose
  `observed_at` is below the publication's newest `recorded_at`. At a time `T`, an
  event is **visible** if `observed_at <= T`, **not visible** if
  `recorded_at > T`, and otherwise **unproven**, unless a later event on the
  same page (higher `id`) has `recorded_at <= T`, which proves the earlier
  commit, because that later event was written under the same page lock.
  W2 answers unproven intervals as unproven. A group publication's members
  share one mark, so their events become visible together.

### 5.4 Source time versus recorded time

Each event keeps `recorded_at` (when this brain recorded it) separate from
`source_time`, the time the evidence claims for itself: git commit time on
sync, a frontmatter or extracted date, `valid_from`. Imported timestamps never
populate `recorded_at`. Backfill rows carry the backfill run's time in
`recorded_at` and the historical time only in `source_time` (section 7.2).

## 6. Trust tiers

Built against #6396 (v0.60.139.0) as it exists. That PR shipped no event API.
It shipped a declaration seam: the writer computes a `WriteTrust` once
(`effectiveWriteTrust`, `src/core/trust/tier.ts:172-192`) and passes it
through the transaction settings `gbrain.write_trust_tier` and
`gbrain.write_origin` (`persistence/context.ts:11-16`). The BEFORE ROW trigger
`trust_tier_stamp` clamps it (`trust/schema.ts:106-146`). Tiers are stored on
`facts`, `takes`, `timeline_entries` and `pages`, with a nullable snapshot on
`page_versions` (`trust/schema.ts:42-43`, `:207-210`). **Links have no tier
column.**

### 6.1 Every event carries `trust_tier`

- Fact, take and page events copy the stored row's tier **after** the trigger
  ran, by reading the row in the same transaction, never the declared tier.
  The trigger can lower a declared tier (lower writers set `min(prior,
  writer)` on a content rewrite, `trust/schema.ts:138-142`) or refuse a raise
  (`:123-132`).
- **Destructive, contested and held events keep two tiers.** A retraction,
  delete or purge has no row after the write, so its event records the
  subject's **preimage tier**, read before the delete in the same
  transaction, as `trust_tier`, and the publication's tier separately as
  `writer_tier`. A `trust.contested` event records the held row's tier as
  `trust_tier` and the challenger's as `writer_tier`. A `trust.held` event has
  no canonical row: its `trust_tier` is the tier the write would have
  received, with `tier_basis: 'writer'`. The guard does not return this today:
  `guardFenceRows` returns `{ rows, finish() }` with proposal refs and drops
  the hold's return value (`trust/fence-guard.ts:30-34`, `:87`, `:94-113`), so
  W1 extends that seam to return each guarded or held row's key and tier.
- **Link events carry the writer's tier as actor attribution only**
  (`tier_basis: 'writer'`), because `links` has no tier column
  (`trust/schema.ts:42-43`, `engine-sql/links.ts:110-115`). It says who
  wrote the link, not how trustworthy the link is: consumers must not read an
  owner-run extraction as owner-confirmed link evidence. A derived link that
  needs an evidence tier computes it with the taint rule (section 6.3).
  Baseline, backfill and reconcile cannot recover the original writer of a
  tierless row, so they record `trust_tier = 'unknown'` with
  `tier_basis: 'unknown'`, never the scanner's own tier (section 12,
  question 3, decided). No `links` tier column is needed.
- Each event also carries `write_origin.channel` and, for derived writes, the
  `derivation_inputs` reference, so a reader can see why the tier is what it
  is.

### 6.2 A blocked supersession is its own event, emitted before projection

Lower-tier supersession is contested, not refused. A `trust.contested` event
is emitted by the code that makes the decision, in the same transaction,
whether or not any projected row changed. Its subject is the
higher-tier row's logical key. It carries the held row's tier as
`trust_tier`, the challenger's as `writer_tier` (section 6.1), `guard`, and
the `trust_proposals` reference (`tp<id>`).

| Producer | Where the decision is made | Event |
|---|---|---|
| Fence re-projection | `guardFenceRows`, `trust/fence-guard.ts:42-116`, inside the projection before expiry (`canonical-projections.ts:470-473`) | `trust.contested` per guarded row, with `supersede_fact` or `forget` proposal ref (`fence-guard.ts:98-107`) |
| `remember` replacing a higher-tier fact | prepare at `persistence/memory-prepare.ts:110-117`, re-checked under lock by `validate` at `:119-125` (`coordinator.ts:387`); guard name at `:195` | `trust.contested` (guard `remember.replaces`, `conflict_slot`, `conflict_slot_lexical`) plus `fact.asserted` for the new active row |
| `takes_supersede` | `persistence/takes-prepare.ts:150-156` | `trust.contested` plus `take.asserted` |
| Ontology stint close | `ONTOLOGY_SUPERSEDE_GUARD` in the closing UPDATE (`chronicle/ontology.ts:59-65`) | `trust.contested` from `contestOntologySupersession` (`supersede-handlers.ts:136-146`) |
| Remote `forget` of a higher-tier fact | before admission, `guardRemoteForget` (`trust/supersede-handlers.ts:112`, called at `persistence/memory-mutations.ts:243`) | the refusal files its `forget` proposal in its own attributed transaction (`forgetRequiresOwner`, `supersede-handlers.ts:93-109`); `trust.contested` is appended there, so a refused request still leaves a record |
| Agent edit of a higher-tier page | not blocked; the trigger lowers the page and `recordAgentPageLowering` files `lower_page` (`page-write.ts:82-106`) | `trust.retiered` on the page (from, to, proposal ref) |
| Write-gate hold of a new row | `decideFactWrite` → `recordWriteGateHold` (`fence-guard.ts:87`; `persistence/memory-prepare.ts:137-142`) | `trust.held` with the hold id. It stores a value hash only, not the held text, because held content is untrusted and may be rejected. |

**Takes and timeline rows removed by a lower-tier fence rewrite are contested,
not deleted** (section 12, question 1, decided). Today they have no tier
guard: `dropTakes` deletes by row number and timeline deletes compare content
but never tier (`canonical-projections.ts:432`, `:449-455`), and the tier
trigger handles INSERT and UPDATE, not DELETE (`trust/schema.ts:222-224`). So
omitting a higher-tier take from a page rewrite bypasses the explicit
`takes_supersede` guard (`takes-prepare.ts:150-156`). The fix is an inherited
product guard and a W1 prerequisite, not a ledger feature. It covers **every
destructive path**, not only an omitted fence row:

- the projection's deletes (`dropTakes`, the timeline deletes);
- the delete `takes_remove` runs after the projection
  (`takes-prepare.ts:215`);
- the takes upsert, whose `ON CONFLICT (page_id, row_num) DO UPDATE`
  replaces `claim` and sets `active` in place (`engine-sql/takes.ts:77-90`),
  so a same-row claim replacement or a deactivation;
- the timeline detail refresh, which updates without comparing tiers
  (`canonical-projections.ts:454-455`).

Each one, when the row's tier is above the writer's, keeps the row as it is
and files a proposal for the owner, as `guardFenceRows` does for facts. The
contest is decided **before** the old assertion changes, so #6789's rule that
an in-place claim edit drops the old grade runs only after the guard lets the
edit through. The ledger appends `trust.contested` for a
take (timeline rows are not ledger subjects, section 1), never a completed
`take.retracted`, until the owner accepts; the acceptance then appends the
retraction.

### 6.3 Refreshed text inherits the lowest tier of its evidence

That rule already holds at derivation time: `derivedWriteTrust` takes the
minimum over the inputs, capped at `agent_written` for model output and at
`operator_curated` for deterministic projections (`trust/taint.ts:84-96`). It
is used by synthesize, dream, patterns, consolidate, concepts, atoms,
chronicle, enrichment, think and the facts backstop (report §1.5). The ledger
records the tier the row received.

**A later lowering of an input propagates to what was derived from it; a
raise never does** (section 12, question 2, decided). Today only
`claim-sources --relower` has a pages-first child-lowering pass
(`trust/backfill.ts:375-378`, `:392-417`); otherwise `derivation_inputs` is
read only by purge (`facts/derivation-inputs.ts:51-74`), so a lowered input
leaves derived text wearing its old, higher tier. The rule:

- When an input's tier is lowered, each dependent's **effective tier** is
  recomputed as the minimum over all its current inputs and its derivation
  cap (`trust/taint.ts:84-96`, the lower-only republish helper at `:116-129`),
  or, where recomputation cannot run in that transaction, the dependent is
  made read-ineligible until it is recomputed. The dependency edges exist
  (`derivation-inputs.ts:33-41`).
- A raise never promotes a dependent automatically. It requires
  recomputation under the existing owner-promotion policy, and a model
  derivation never carries `user_confirmed` (`trust/schema.ts:123-131`;
  model cap `trust/tier.ts:179-181`).
- Historical event tiers stay as recorded. Each dependent whose tier changed
  gets its own `trust.retiered` event with the input's event as `cause`.

Like the take guard above, the propagation is a trust-model change that
lands with or before W1. Until it lands, W1's docs say that trust replay is
historical attribution, not a guarantee of current transitive trust. W9's
refresh proposals still compute their tier from current input tiers at
proposal time.

### 6.4 Tier changes are events

Today there is no uniform, append-only tier history: the stamp overwrites in
place. Only fragments survive: `setRowTier` stores an `owner_decision` in
`write_origin`, and page-lowering proposals keep before and after tiers
(`trust/page-handlers.ts:133-136`, `trust/page-write.ts:89-103`).
`trust.retiered` (subject, from, to, cause) is appended by owner confirm and
`setRowTier` (`page-handlers.ts:119-145`), supersede accept and undo
(`supersede-handlers.ts:180-192`), `trust backfill` and `claim-sources
--relower` (`trust/backfill.ts:338`, `:417`), the derived propagation of
section 6.3, and **every trigger-driven content retiering** on the four tiered
tables (`trust/schema.ts:133-143`), not only the agent page lowering above.

Bulk backfill and relower change individual facts, takes, timeline rows and
pages (`trust/backfill.ts:326-339`, `:392-417`), and a database-only fact may
have no page. So a bulk run appends one summary event per source and page
for readers, **plus a per-subject manifest** of `(subject key, from, to)`
behind each summary (`belief_retier_manifest`, keyed by the summary event), so replay can
say which belief's trust changed. A count alone cannot.

### 6.5 Purge: removal from active memory, never a physical-erasure promise

**Policy.** Withdrawal (`forget`) is a recorded event and erases nothing; it
removes a fact from active memory. Purge removes the content from the live
stores gbrain manages and refuses its return. Neither promises physical
erasure: #6396 and AGENTS.md say history, source material and private backups
may remain, and the ledger keeps that promise unchanged. Purge's receipt
separates what it removed from what it reports (`purge-verify.ts:391-395`);
`completion: complete` never means "no copy survives anywhere".

Today `purge_fact` deletes the facts, rewrites page bodies, redacts
`page_versions`, deletes trust proposals and gate rows, and tombstones the
claim (`facts/purge.ts:295-346`). Page purge does the same for a page and
every retained version (`persistence/page-purge.ts:115-192`).

**Inherited read leaks, fixed before W1.** The trust-tier review found four
places where shipped purge left a purged value readable through a read op.
Forced probes confirmed each on master on both engines, and #6789 fixes them:

- version redaction stopped after 5,000 snapshots, so the newest versions
  kept the purged fence row and `get_versions` returned it; it now runs in
  keyset batches until none is left;
- page purge did not walk `derivation_inputs`, so a fact derived onto
  another page stayed live in `recall`; page purge now hides derived rows as
  `purge_fact` does;
- a derived page `purge_fact` hid (soft-deleted, `needs_rederive`) was still
  returned by `get_page include_deleted` and `get_versions`; both now hide
  it;
- a version or page that stated the claim only in its title or frontmatter
  went unreported; the receipt now reports it with prose as
  `out_of_scope: source_prose`.

Prose that states a claim outside a fence is still reported, not redacted, as
before. Three carriers are probed and reported but not swept: link context,
timeline detail and raw data (`deletion-inventory.ts:84`, `:132`, `:163`;
`purge-verify.ts:98-104`, `:259-262`). **W1 prerequisite:** purge-verify
must report each of them honestly, naming the rows, and a test proves each
one appears in the receipt when it carries the claim. Sweeping them is not
W1 scope.

The contract W1 adds for the ledger:

1. **Redaction follows every carrying field, not only the purged keys.** The
   ledger stores text in `value` (W4 needs before-and-after text), and that
   text is not only under the purged claim's key. Another fact's `context`,
   a take's resolution evidence (`resolved_source`), a link's `context`
   (`canonical-projections.ts:424-430`, `:435-445`; `engine-sql/links.ts:110-115`)
   and W9's future refresh proposals can all quote it. So the purge
   transaction redacts in three passes, all inside it:
   - **Purged keys:** every event under the purged keys, including
     historical keys reached through the rename chain, gets `value` and
     `value_hash` set to NULL and `purged = true`.
   - **Carrying fields:** every event in the source whose `value` contains a
     purge needle has each carrying field replaced by a redaction marker
     naming the purge request. The needles are each purged claim with its
     fence-escaped and JSON-escaped forms, as `purge-verify.ts` already
     builds them. For a page purge the claim inventory is **exhaustive**:
     every fact and take claim on the page, every fence claim in its retained
     versions (claims from before coverage started live only there), and
     every claim in the page lifetime's historical ledger events, enumerated
     in keyset batches.
     `readPurgeClaims` is not that inventory: it reads at most 1,000 facts
     and takes, drops claims under 8 characters and keeps 32 needles
     (`page-purge.ts:64-66`), which suits its report and not a sweep. If
     enumeration cannot finish in the purge's budget, the purge refuses
     with a typed code, as a statement timeout does. The event's `value_hash` is
     recomputed over the redacted value, and the replaced fields are listed
     in `redacted_fields`. The next event's `prior_hash` then no longer
     matches, so chain checks treat an event with `redacted_fields` or
     `purged` as a disclosed break, not as drift. The scan runs in keyset
     batches until none is left, like the version redaction #6789 fixed, and
     it is an unindexed substring scan over the source's events, as the
     version and journal scans already are. A statement timeout refuses the
     whole purge with the typed `purge_lookup_timeout` (as #6511 does for the
     journal), never a partial one.

     **The redaction stays in force for later appends.** Purge leaves a live
     carrier as it is when it lies outside the purged row: a surviving fence
     row's context that quotes the claim survives `dropPurgedFenceRows`
     (`purge-overlay.ts:41`) and is re-projected unchanged
     (`canonical-projections.ts:424-426`). A later publication that changes
     only that fact's confidence would otherwise copy the context, and the
     purged text in it, back into a fresh event, and neither the tombstone
     check nor the purge epoch would stop it. So each field the pass redacts
     is recorded in `belief_redactions (source_id, subject_key, field,
     purge_request, field_hash, released_by, released_hash)`, where `field_hash` is the hash of the
     field's value at the purge. Every later append for that key (a
     revision, a baseline, a reconcile, a backfill) writes the redaction
     marker in that field **until an owner releases it**, whether or not the
     bytes changed: an agent can append a sentence to the context and keep
     the quote, and the fact guard lets a same-row, same-claim rewrite
     through (`trust/fence-guard.ts:50-51`). A release is an owner decision
     bound to one value: a trusted local write (`remote = false`) at or above
     `OWNER_TIER_FLOOR` (`trust/tier.ts:40`) that sets the field, or the
     owner confirm action on that key (`trust/confirm.ts`), records
     `released_by` (its request id) and `released_hash` (the hash of the new
     value) in `belief_redactions`. Only an append whose field value hashes to
     `released_hash` records it as written; any later change goes back to the
     marker until the next release. Agent writes, sync, reconcile and
     backfill never release, whatever their tier.

     **Suppression follows the field across identity changes.** A claim
     edit changes the fingerprint, so the successor is a new key linked by
     `replaces`, and the new row takes the incoming context
     (`engine-sql/facts.ts:183-184`). So when an append is linked to an
     earlier key by `replaces`, `*.adopted` or `*.transferred`, every active
     (unreleased) suppression on the earlier key is copied to the successor
     for the same field, keeping its purge request, and the same owner
     release is needed there. Separately, any append in the source whose
     field value hashes to an active suppression's `field_hash` (a verbatim
     copy of the whole field into an unlinked subject) gets the marker too
     (the register is indexed on `(source_id, field_hash)`).
     What remains is a stated limit, the same one the live resurrection
     guards have (they match fingerprints, not text): a writer that copies
     part of a suppressed field into a new, unlinked subject is not
     detected, because the purged text is no longer stored anywhere to match
     against. Purge-verify reports the live carrier
     itself (the surviving row's context) as `out_of_scope: source_prose`,
     naming the key, so the user can edit it.
   - **Derived keys:** a paraphrase cannot be matched by a needle, so the
     derivation walk decides. Purge maps each row the walk hides to its
     logical key and appends one `derived.hidden` event per key, naming the
     purge request. **That suppression is permanent for the events it
     covers:** every event of the key with an `id` up to the
     `derived.hidden` event stays hidden from history reads, because a
     paraphrase of the purged text is still in them. A later re-derivation
     from surviving inputs appends new events, and only those become
     readable. Unlike the live `needs_rederive` marker, which re-derivation
     clears (`eligibility/sql.ts:68-69`), nothing un-hides the earlier
     range. The cutoff is not only an `id`: a **backfill** event (section
     7.2) for a key with a `derived.hidden` is always appended hidden,
     whatever its `id`, because old git or version content of a suppressed
     derivation is the contaminated generation, not a re-derivation. Only a
     live re-derivation from surviving inputs creates readable events for
     that key. A walk that hits its bound (1,000 rows or eight hops,
     `derivation-inputs.ts:51-71`) is reported `truncated`, and
     certification of that source's coverage is withheld until a complete
     walk runs.

   Then the purge appends one `page.purged` or `fact.purged` event carrying
   the purge request id. The event skeleton (key, type, time, tier) stays, so
   history discloses that something was removed and when. The fingerprint in
   the key is the value the tombstone ledgers already keep (`fact_purges`,
   `take_purges`). The take key's hash covers claim, kind and holder, but
   `take_purges` hashes the claim only (`page-purge.ts:124-125`,
   `purge-schema.ts:139-142`), so take events also carry the claim-only
   fingerprint in an indexed column that purge matches on: changing kind or
   holder cannot evade redaction.
2. **Each new table enforces its own tombstones, in its appending
   transaction.** Registering a table as `swept` in the deletion inventory
   only adds detection: the generic adapter probes and reports residuals
   (`purge-verify.ts:113-124`). The resurrection triggers sit on `facts`,
   `takes` and `pages` only (`purge-schema.ts:133-134`, `:151-152`,
   `:168-169`). So `belief_events`, W9's `page_refresh_proposals` and W6's
   grade evidence each get, in the appending transaction and under the page
   key lock purge also takes:
   - a fingerprint check of the subject against `fact_purges`, `take_purges`
     and `page_purges`, following the rename chain;
   - a **stale-preparation check**: a new `sources.purge_epoch` counter is
     incremented by every fact and page purge in its own transaction (both
     already hold the source row `FOR UPDATE`, `facts/purge.ts:274` and
     `persistence/page-purge.ts:246`, so increments are serialized). Every payload records the epoch it read at
     preparation, and the append reads it again under the source `FOR SHARE`
     lock that `lockPageKeys` takes (`page-state/guards.ts:24-41`). If the
     epoch moved, the append is refused and the payload is prepared again
     from current, redacted state. The tombstone tables cannot serve here:
     they have no sequence, and their `purged_at` is the purge transaction's
     start time, which can precede a preparation that commits before the
     purge does. A text check cannot do it either, because the purged text
     is no longer stored anywhere to match against.
   Tests: an exact claim that survives only in another subject's context or
   take evidence is redacted; a refresh proposal prepared before a purge and
   appended after it is refused.
3. **No resurrected assertion event.** A direct insert of a purged fact,
   take or page is refused by the existing triggers, so it appends nothing.
   A re-import of stale Markdown is different: it is first sanitized
   (`preserveWithdrawnFenceRows` → `dropPurgedFenceRows`,
   `facts/withdrawal.ts:148-150`, called from `import-file.ts:446-448`) and can
   succeed, publishing unrelated changes. The rule is therefore no event
   that re-asserts a purged key, not no event at all. A replay of history
   shows the purged keys as present but redacted for the interval they were
   live.
4. **Other copies:**
   - `page_versions`: fence rows redacted, and prose, title and frontmatter
     carriers reported (#6789). W1's added preimages (section 10) are
     ordinary versions and are covered the same way.
   - Journal intents: already redacted (`intent-redaction.ts:214`).
   - Trust proposals and gate holds: already deleted.
   - `persistence_effects` payloads queued before the purge: the purge
     already queues its own effects, and W1 adds a check that no queued
     effect still carries purged text.
5. **Out of reach**, as purge already documents
   (`deletion-inventory.ts:188`, `:192-198`): git history, other clones,
   exports and context files written before the purge, earlier backups,
   provider copies, and physical pages and WAL until VACUUM.
   `docs/guides/memory-boundaries.md` gains the ledger line. A Markdown export
   made after the purge applies the current tombstones
   (`export-snapshot.ts:15-19`, `:31-34`); one made before it is not
   invalidated.
6. **A restore that brings purged content back replays the newer purges, or
   is flagged** (section 8). The replay source is the ledger's own purge
   events, which carry fingerprints, scope and request ids but no text.

`gbrain pages purge-deleted` hard-deletes old tombstones with no purge
tombstone (`engine-sql/pages.ts:286-318`). It removes body text but not
claims. It appends **`page.expired`**, a separate event type, and does not
redact earlier events, because nothing was asked to be forgotten. Retention
removal is never `page.purged`, so it is never mirrored or replayed as a
purge (section 8).

## 7. Watermark, backfill and coverage

Two properties are kept apart. **Timestamp accuracy** says an event's time is
right. **Interval completeness** says no unrecorded transition happened to a
subject between two of its events. W2's intervals and W4's change history
need completeness, and only instrumentation gives it: a matching hash cannot.
A take resolved by unmanaged grading (`cycle/grade-takes.ts:814`) and then
un-resolved by a calibration undo (`calibration/undo-wave.ts:123-134`)
between two scans returns to the same hash after two real transitions.

### 7.1 Activation, baseline and the watermark

Enabling W1 on a source does not certify anything by itself, because
nothing records what already existed. Activation is a **baseline run**:

1. Append `coverage.started` for the source (its source incarnation and the
   run id).
2. For each live page, under that page's key lock and with its revision
   checked in the same transaction (the same `revision_conflict` rule as a
   publication), append one `baseline` snapshot event for the page, in the
   same form as a creation snapshot (section 4), with the subject counts and
   `state_hash` as they are now, and mint the page's lifetime. A page over
   1 MiB gets one `baseline` event per subject instead, for the same reason
   as at creation. A publication that wins the lock first is
   simply recorded, and the baseline for that page runs after it. Purge
   takes the same lock, so a page cannot be purged in the middle of its
   baseline.
3. Baseline the database-only assertions (facts whose `entity_slug` names no
   page, `persistence/memory-prepare.ts:187-189`) under the subject-slug lock
   the fact writer already takes (`engine-sql/facts.ts:101`).
4. The run is resumable: it records progress per page, and a page's coverage
   starts at its own baseline cut. When every page and database-only subject
   has a cut, the run appends `coverage.complete`, and its `recorded_at` is
   the source's **watermark**.

A recorded-time read for `T` before a page's cut returns the coded refusal
`coverage_from` (a catalogue entry, W2). The brain-wide watermark is the
latest watermark among the sources a read touches.

**Coverage is a set of intervals, not one start.** Turning the flag off
appends `coverage.stopped`; turning it on again runs a new baseline.
`gbrain backup restore` appends `coverage.restored` naming the archive's
creation time, because the restored ledger does not know what happened
between the backup and the restore: W2 refuses inside that gap.

**Only managed sources are certified.** On an unmanaged source the baseline
still runs and events are still appended (section 5.1), but every interval is
marked uncertified, because about 25 unmanaged writers can change the same
subjects without an event. W2 answers uncertified intervals with a disclosure,
never as fact. A source becomes certifiable when it becomes managed, from its
next baseline.

### 7.2 The marked history backfill

The baseline is not history. A separate, optional backfill seeds history
before the watermark from `page_versions` and, where the source is a git
checkout, from git. Each row it writes has `origin = 'backfill'`,
`recorded_at` set to the backfill run's time, and the historical time only in
`source_time`, marked never certified. Known limits:

- `page_versions` stores preimages, and large pages keep only their last five
  (`page-state/versions.ts:12`, `:26-30`).
- Versions were redacted by purge and moved by the fallback rename.
- Git history is outside purge's reach (`deletion-inventory.ts:193`), and the
  resurrection guards are triggers on `facts`, `takes` and `pages`
  (`facts/purge-schema.ts:133`, `:151`, `:168`), not on the ledger. So every
  backfill and reconcile append rechecks `fact_purges`, `take_purges` and
  `page_purges` in the appending transaction, under the same page key lock
  purge takes, following rename chains to the historical slug. A payload
  prepared before a purge and appended after it is refused, not written.

So backfilled intervals are reported as best effort. W2 discloses a page
whose backfill is incomplete (`backfill_complete: false` on the page's
backfill summary event).

### 7.3 The doctor coverage check

New check `belief_ledger_coverage` (`src/commands/doctor/checks/belief-ledger.ts`,
registered with its category and golden per CONTRIBUTING's doctor-check row).
It reports:

- coverage intervals per source, with each source's certified or
  uncertified status and baseline progress;
- **drift**: slugs whose current belief set no longer hashes to the
  `state_hash` on their newest event. Drift means a writer changed state
  without appending. The check samples by default (bounded by pages and time,
  like the other hot checks) and is complete under `--deep`. With `--fix` (or
  the cycle's extract phase) it appends `reconcile` events for the keys that
  moved, with honest `recorded_at`. Reconcile repairs the head only: on a
  managed source, a drift finding also marks that slug's interval since its
  previous event uncertified, and a later clean hash never clears that mark;
- events whose keys reference a lifetime with no page and no rename chain
  (orphans), and committed events still missing a commit mark.

The check's `fix.next` follows the operator protocol: running the reconcile
is `run`; enabling the flag on a source is `ask_user`.

## 8. Backup and migration contract

| Path | Contract | Change in W1 |
|---|---|---|
| Graduation, `gbrain migrate --to postgres` (the default PGLite→Postgres route) | Copies every classified table verbatim with primary keys and sequence positions, triggers bypassed (`graduation-copy.ts:13-27`, `:255-282`); an unclassified table aborts the copy (`graduation-inventory.ts:222-254`) | `carry('belief_events')`. Event keys contain no ids, and the local `id` and its sequence are preserved, so the copied ledger is byte-identical. W1's probe asserts equal `event_key` sets and an identical replay. |
| Legacy copier, `migrate-engine` (to PGLite, or with graduation off) | Re-creates pages through `putPage` with new ids, copies no versions and no takes; already refuses any brain with rows in `persistence_requests`, `fact_withdrawals` or `persistence_worktrees` (`src/core/persistence/maintenance.ts:73-90`) | Add `belief_events` to that refusal list. A brain with a ledger always has journal rows, so in practice it is already refused; the explicit entry makes the refusal name the ledger. |
| `gbrain backup create` / `restore` (PGLite) | Physical cluster tar under the writer lock; restore requires the same schema version and an absent target root, and quarantines execution in one transaction (`src/core/backup/snapshot.ts:129-200`, `:225-342`) | Restore appends one `coverage.restored` event naming the archive's time, and **replays newer purges** (below) in the same transaction. The ledger is in the cluster, so apart from those two a restore reproduces it byte for byte; W1's probe asserts it. |
| Postgres | Operator-managed backups (`docs/ENGINES.md:345`) | `docs/ENGINES.md` and the system-of-record DR section name the ledger as state a Markdown rebuild cannot recover, and tell the operator to run the purge replay after a restore. |
| `gbrain export` | Markdown snapshot, explicitly not a database backup (`commands/export.ts:28-31`); applies current tombstones (`export-snapshot.ts:15-19`) | None; the docs say the ledger is not exported. An export made before a purge stays out of reach (section 6.5). |
| Fresh import / `reinit-pglite` + sync | Rebuilds file-backed state only | Starts a new ledger with a new watermark. The DR recipe in `system-of-record.md` says to restore the database backup first if recorded history matters. |

**Restore replays newer purges, or flags that it could not.** A backup
holds the physical database (`snapshot.ts:170-175`), so restoring one taken
before a purge brings the purged content back, and today restore runs no
replay (`:255-273`). W1 adds one, using the ledger's purge events as the
source: they are text-free (fingerprints, scope, source incarnation, request
id, recorded time), so reading them leaks nothing.

1. Restore needs the owner-requested `page.purged` and `fact.purged` events
   recorded after the archive's creation time (never `page.expired`, which
   is retention removal). A running PGLite cluster cannot be opened by a
   second process, so purge keeps a text-free mirror in the brain's home
   (`purge-events.jsonl`, 0600), outside the database, written **ahead** of
   the commit: the purge transaction appends and fsyncs an `intent` line
   (request id, source incarnation, scope, fingerprints, the `purge_epoch`
   it will commit) before it commits, and a post-commit effect appends a
   `committed` line. A post-commit write alone would leave a window in which
   a committed purge is missing from a file that otherwise reads as valid.
   So the mirror is a superset of committed purges: every committed purge has
   at least its intent line. Restore reads that mirror under
   `metadata.original_root`, which restore records, or a copy the operator
   names. On Postgres, the replay reads the events from the pre-restore
   database itself, which is complete by construction.
2. Inside restore's existing transaction, before the root is published, it
   replays them in recorded order for the matching source incarnation: it
   writes the tombstone rows, finds the restored fact, take or page rows by
   fingerprint or content hash (the restored rows still hold the text, so
   the standard purge redaction, including the ledger's carrying-field pass,
   runs on them), and appends one `fact.purged` or `page.purged` per replayed
   purge with `cause: 'restore_replay'` and the original request id. Each
   replayed purge records an outcome. `complete` means the purged text was
   recovered from a restored row and the carrying-field pass ran. `partial`
   means no restored row matches the fingerprint: the tombstones are written
   and key-level redaction by fingerprint runs, but a quote of the claim in
   another subject's text cannot be found without the text (for example, an
   archive older than the claim's own fact, holding only another subject's
   quote of it). A partial outcome raises the same restore warning and doctor
   finding as an unreadable mirror, naming the purge request ids. An intent
   line with no `committed` line may belong to a purge that rolled back, so
   it is not replayed automatically: restore reports it as `unverified`,
   with the same warning, and the doctor finding asks the user whether to
   run that purge again. No other
   process can reach the restored database before the root is published, so
   the replay needs no page key locks; it bumps `purge_epoch` like any purge.
3. When no newer purge events can be read, restore still succeeds but
   records `purge_replay: 'unavailable'` on `coverage.restored`, the restore
   receipt says so, and a doctor finding (`ask_user`) tells the user that
   purges made after the archive's time were not replayed and names the
   replay command to run when the original brain is available.

Postgres restores happen outside gbrain, so the same replay is a CLI step
pointed at the pre-restore database, and the docs name it.

The PLAN text called for an explicit `belief_events` and `page_versions` copy
with id remapping inside `migrate-engine`. On this tree that is not needed for
the ledger: graduation already carries tables verbatim with ids, and the
legacy copier already refuses any brain that could hold a ledger. W5's
`page_versions` copy in `migrate-engine` matters only for history-free brains.
W5 should be re-scoped with that in mind (section 12, question 8).

**Schema.** One additive migration (`bun run new:migration`; v214 is the
template). `CREATE TABLE IF NOT EXISTS belief_events`, three indexes plus the
unique `event_key` and the partial `claim_fp` index, `sources.purge_epoch BIGINT NOT NULL DEFAULT 0` (section 6.5), and the guarded `DO $rls$` block (`v214-wanted-links.ts:38-42`).
The DDL goes in `schema.sql` and the bootstrap blob (no column of it is
referenced by an older blob index, so no bootstrap probe is needed). Then
`build:schema` and `build:pglite-snapshot`, and regenerate the migrations and
schema-catalog goldens. It also gets inventory rows in deletion (`swept`) and
graduation (`carry`) for every ledger table (events, page lifetimes, commit marks, the retiering manifest and the redaction register), and, because its appends ride
canonical writes, a line in `docs/architecture/canonical-writers.tsv` naming
the finalization contract.

```sql
CREATE TABLE IF NOT EXISTS belief_events (
  id                 BIGSERIAL PRIMARY KEY,   -- order within one page stream; never joined on
  event_key          BYTEA NOT NULL UNIQUE,   -- sha256(publication_id, subject_key, event_type), 32 bytes
  source_id          TEXT NOT NULL,
  source_incarnation UUID NOT NULL,           -- sources.incarnation at recording time
  page_lifetime      UUID,                    -- NULL for page-less subjects (section 3)
  slug               TEXT NOT NULL,           -- stream slug at recording time (origin page for links)
  subject_kind       TEXT NOT NULL,           -- page | fact | take | link | link_transition | coverage
  subject_key        TEXT NOT NULL,           -- canonical serialization of the logical key (section 3)
  event_type         TEXT NOT NULL,
  origin             TEXT NOT NULL DEFAULT 'live', -- live | unmanaged | baseline | backfill | reconcile
  trust_tier         TEXT NOT NULL,           -- preimage tier for destructive events (section 6.1)
  writer_tier        TEXT,                    -- the publication's tier when it differs from trust_tier
  tier_basis         TEXT NOT NULL DEFAULT 'row',  -- row | writer | unknown
  visibility         TEXT NOT NULL,           -- the subject's visibility when recorded (section 8, privacy)
  publication_id     UUID NOT NULL,           -- persistence_requests.id or per-transaction UUID
  ord                INTEGER NOT NULL,
  recorded_at        TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  source_time        TIMESTAMPTZ,
  valid_from         TIMESTAMPTZ,
  valid_until        TIMESTAMPTZ,
  value              JSONB,                   -- canonical value after the transition; NULL when purged
  value_hash         TEXT,
  prior_hash         TEXT,                    -- value_hash of the key's previous event
  state_hash         TEXT NOT NULL,           -- the slug's belief set after this event
  cause              JSONB NOT NULL,          -- op, request ids, proposal refs, rename/merge/replace links, purge watermark at preparation
  claim_fp           TEXT,                    -- claim-only fingerprint for fact and take events (purge matching, section 6.5)
  purged             BOOLEAN NOT NULL DEFAULT false,
  redacted_fields    TEXT[]                   -- carrying fields a purge replaced with a redaction marker
);
CREATE INDEX IF NOT EXISTS belief_events_page ON belief_events (source_id, slug, id);
CREATE INDEX IF NOT EXISTS belief_events_subject ON belief_events (source_id, subject_kind, subject_key, id);
CREATE INDEX IF NOT EXISTS belief_events_recorded ON belief_events (recorded_at);
CREATE INDEX IF NOT EXISTS belief_events_claim_fp ON belief_events (source_id, claim_fp) WHERE claim_fp IS NOT NULL;
-- plus belief_page_lifetimes (section 3), belief_commit_marks (section 5.3), belief_retier_manifest (section 6.4) and belief_redactions (section 6.5)
```

The bench's 905-925 bytes per event used a TEXT hex `event_key`; BYTEA saves
about 64 bytes per row across the heap and the unique index.

Row-level security follows the blob convention. Remote reads go through ops,
never the table, and table RLS does not authorize them. **Privacy follows the
existing history reads, which check both the historical and the current
state** (`engine-sql/pages.ts:911-912` combines `privatePagesFilterFragment`
on the live page with `privateSnapshotFilterFragment` on the version). A
remote caller sees an event only when all of these hold, and the read fails
closed when any owner cannot be resolved:

- the event's own `visibility` was `world` when recorded (an old private
  value does not become readable when the page is made public later);
- the stream page's current lifetime is visible now (a page made private
  later hides its earlier events);
- for facts, the fact row's visibility is `world`, as the facts read
  requires (`engine-sql/facts.ts:693`);
- for links, the from page, the to page and the origin page are all visible,
  as the links read checks (`engine-sql/links.ts:248`).

## 9. Event volume and write-path cost (measured)

A free local bench (scratch test, not committed; `~/.capy/work/belief/`)
published pages through the shared write path (`submitPageMutation` →
coordinator) on PGLite and on Postgres 16 (pgvector container). It counted
raw row writes with temporary per-row triggers, and canonical transitions by
diffing logical state before and after. It also timed a multi-row append to
a `belief_events` table with the schema above, prefilled with 100,000 rows.
Two page shapes:

- **typical:** 10 facts, 5 takes, 10 timeline rows, 3 links;
- **large:** 200 facts, 25 takes, 200 timeline rows, 20 links.

Medians are over 15 runs. The two engines produced identical counts.

**Row writes versus canonical transitions per publication:**

| Step | Typical: canonical / row writes | Large: canonical / row writes |
|---|---|---|
| create | 28 / 47 | 445 / 674 |
| identical re-put | 0 / 0 (journal no-op) | 0 / 0 |
| prose-only edit | **0 / 27** | **0 / 258** |
| one fact changed | 1 / 26 | 1 / 256 |
| one take added | 1 / 26 | 1 / 256 |
| one timeline row added | 1 / 27 | 1 / 257 |

Canonical counts include timeline rows, which the ledger does not record
(section 1). Without them, a create would be 19 events typical and 246 large
as per-subject events; with the creation snapshot (section 4) it is one
event. Each edit adds one `page.published` event. A row-level capture would record
26 to 258 rows per edit to report at most one belief change. That is the
quantitative case for section 2.

**Write-path cost:**

| Append of K events in one transaction | PGLite | Postgres |
|---|---|---|
| K = 1 | +0.06 ms | +0.18 ms |
| K = 4 | +0.11 ms | +0.28 ms |
| K = 16 | +0.54 ms | +0.58 ms |
| K = 64 | +1.25 ms | +1.68 ms |
| K = 256 | +4.96 ms | +5.58 ms |

For comparison, median `put_page` latency through the same path was:

- typical page: PGLite create 37.9 ms, edits 32.8–42.9 ms; Postgres create 33.5 ms, edits 33.7–37.6 ms;
- large page: PGLite create 147 ms, edits 137–153 ms; Postgres create 130.5 ms, edits 124–180 ms.

A typical edit appends about 2 events, under 0.3 ms (under 1%). A create
appends one snapshot event, under 0.2 ms. As per-subject events it would have
appended 19 (about 0.6 ms) typical and 246 (about 5 ms, 3–4%) large; a page
over 1 MiB still does (section 4).

**Measured on W1 as built.** W1 computes the diff inside the publication
transaction instead of in prepare (section 13, item 1), so its cost is two
logical-state reads under the page keys plus keying and hashing, not only the
append. A no-change batch over 50 runs, median, isolated (scratch probe in
`~/.capy/work/belief/`):

| Page | PGLite | Postgres |
|---|---|---|
| typical (10 facts, 5 takes, 3 links) | 2.3–2.5 ms | 2.2–2.8 ms |
| large (200 facts, 25 takes, 20 links) | 10.7–13 ms | 9.9–13.5 ms |

On the large page each state read costs about 3 ms, the diff 2.5–4 ms,
lifetimes about 0.5 ms and the ledger probe about 0.2 ms. That is roughly
6–9% of `put_page` time, spent while the page keys are held. End to end (the
same `submitPageMutation` bench, ledger off against on, interleaved, 16 runs
per cell) the typical-page delta was +6 to +14 ms on Postgres and +1 to +6 ms
on PGLite, and an identical re-put still paid +6 to +9 ms on Postgres with no
event appended, because the batch reads before it can tell nothing changed.
Large-page deltas were within the bench's noise on both engines. One pipeline
for all five state reads and one merged lifetime read were both tried and were
slower: a round trip costs about 0.08 ms here, so server work, not round
trips, sets the cost. A source with the ledger off pays one source read per
publication.

After section 13 item 15 (one-statement reads, indexed link, transition
and fact selection, fingerprints reused by the post read), the ledger's own
work inside the transaction (both reads, keying, diff, append and the commit
mark), median over 10 runs per cell:

| Page | PGLite | Postgres |
|---|---|---|
| typical edit | ≈3.0 ms (7–8% of 35–45 ms) | ≈3.1 ms (≈10% of ≈31 ms) |
| large edit | ≈14 ms (8–9% of 160–175 ms) | ≈14 ms (11–12% of 120–130 ms) |

Before item 15 the typical figure was about 6 ms on both engines: the
transition read nested-looped pages against pages (about 2 ms with an empty
table) and the facts read scanned every fact of the source. A grouped
managed sync of 20 typical pages on Postgres costs about 4–5 ms per member.
End-to-end on/off medians on the 4-core bench machine vary by ±10 ms between
identical runs, so the in-transaction figure is the one to compare.

Bulk work with coverage on, 1000 typical pages plus 20 people pages, 4-core
machine, median of 2 runs, after section 13 item 16:

| Run | PGLite off → on | Postgres off → on |
|---|---|---|
| legacy `gbrain import` | 5.7 → 7.1 s (+1.4 ms/page) | 7.1 → 9.6 s (+2.6 ms/page) |
| re-import, every page edited | 6.3 → 7.6 s (+1.4 ms/page) | 7.4 → 9.4 s (+2.0 ms/page) |
| managed sync, create | 24.8 → 27.6 s (+11%) | 15.1 → 18.7 s (+24%) |
| managed sync, every page edited | 29.2 → 32.7 s (+12%) | within noise |
| `beliefs enable` baseline | 1.2 s (1.2 ms/page) | 1.8 s (1.8 ms/page) |
| `beliefs backfill`, 2 prior versions per page | 9.7 s (25,040 events) | 7.3 s |

**After the write-overhead pass** (section 13, items 17 to 20). Measured on
the 4-core bench machine with the same `submitPageMutation` bench, master
(v0.60.265.0) against the branch, interleaved, 3 rounds of 15 runs per cell
(median of the round medians):

| Cell | `put_page` ms | Ledger ms in the transaction | Ledger share |
|---|---|---|---|
| PGLite typical edit | 62 → 57 | 3.8–3.9 → 3.7–3.8 | 6.1% → 6.4–6.6% |
| PGLite large edit | 380–385 → 206–210 | 14.6 → 14.0 | 3.8% → 6.7–6.8% |
| Postgres typical edit | 47.5 → 44.4 | 4.5–4.6 → 3.8–3.9 | 9.7% → 8.6–8.7% |
| Postgres large edit | 229–231 → 208–223 | 25.5–28.2 → 23.4–23.6 | 12.2–12.3% → 10.4–11.3% |

The large PGLite share rose because `put_page` lost 45% of its time (the
projections no longer rewrite 225 identical rows), not because the ledger
grew. A typical Postgres edit now spends about 1.25 ms on the pre read,
0.9 ms on the post read, 0.35 ms on lifetimes, 0.3 ms keying, 0.2 ms
diffing, 0.4 ms on the append and 0.4 ms on the commit mark. Large-edit
Postgres medians move by ±3 ms between identical rounds.

Managed sync, create, 1000 typical pages plus 20 people, 5 interleaved reps
per arm on Postgres: off 17.18 s median (16.66–18.99), on 19.37 s median
(18.47–21.76), +12.7%, 7.2 ms per page in the transaction. On PGLite, 2 reps
per arm: 39.4 → 43.6 s, +10.8%. Creates gain nothing from items 17 and 19: a
create writes every table and reads every claim for the first time. The
earlier +24% (lane 32) and +35% (one noisy rep of two) came from too few
reps to quote.

**After the keying pass** (section 13, item 21), the same bench, master
(09943580e) against the branch, 3 interleaved rounds of 15 runs per cell
(ranges of the round medians):

| Cell | Ledger ms, master → branch | Ledger share, master → branch |
|---|---|---|
| PGLite typical edit | 4.1–5.4 → 4.2–5.0 | 6.1–6.7% → 6.0–6.7% |
| PGLite large edit | 17.5–20.6 → 14.3–16.1 | 3.9–4.3% → 5.6–6.4% |
| Postgres typical edit | 5.2–7.3 → 4.4–6.2 | 9.5–10.7% → 7.9–8.5% |
| Postgres large edit | 20.1–24.4 → 14.7–18.2 | 10.3–11.3% → 8.4–9.3% |

Master here lacks items 17 to 21, so the PGLite large share again rises
because `put_page` lost about 45% of its time. Large Postgres edits now meet
the 10% target; typical edits do not meet 5% on either engine, and creates
were not measured again.

**Targets for turning recording on by default:** typical edit ≤5%, large
edit ≤10% and managed-sync create ≤10% of the write's time, ledger on
against off. After this pass W1 meets none of them on Postgres (typical
8.6–8.7%, large 10.4–11.3%, create +12.7%) and only the large-edit one on
PGLite (typical 6.4–6.6%, large 6.7–6.8%, create +10.8%), so recording stays
opt-in per source (`gbrain beliefs enable`).

**Storage** (section 12, question 7, decided). A second free bench inserted
the creation events of 2,000 typical pages into a PGLite table with the full
schema of section 8 (before `writer_tier`, `claim_fp` and `redacted_fields`
were added) and measured `pg_total_relation_size` after `VACUUM ANALYZE`:

| Creation as | Bytes per event (heap) | Per typical page | Per 10,000 pages |
|---|---|---|---|
| Per-subject events, TEXT hashes | 1,180 (795) | 21.9 KB | 224 MB |
| Per-subject events, BYTEA hashes (as designed) | 1,105 (719) | 20.5 KB | **210 MB** |
| Per-subject, non-belief fields trimmed to a hash | 1,035 (647) | 19.2 KB | 197 MB |
| Trimmed, plus a hashed subject index | 877 (647) | 16.3 KB | 167 MB |
| **One snapshot event per page** | 905 (512) | 0.9 KB | **9 MB** |

The earlier estimate of about 170 MB used the first bench's narrower table
(905 bytes per event); the designed schema costs about 210 MB. Edits cost the
same in every option, about 2 events each. Page-at-time reads cost the same
too: rebuilding a typical page from a 39-event stream took 0.22 ms median
(p90 0.32), and from a snapshot plus a parse of its version body 0.25 ms
(p90 0.35).

**Why snapshots and not trimming.** About 900 bytes of each event is fixed
row and index overhead (about 510 bytes of heap and 390 of indexes even with
a tiny value), so trimming the non-belief fields saves only 7% (197 MB) and
gives up the values W4 displays; trimming plus a narrower subject index saves
20%. The snapshot removes the creation events themselves (96% less). W4's
weekly diff and W2's page-at-time both run off edits and versions, which cost
the same either way, and section 10 already reads page bodies from versions.
The snapshot also holds no text, so purge has one fewer copy to redact. The
cost: the creation-time value of a never-edited subject is read from the page
body, not from an indexed event.

## 10. What W2's first slice needs from W1

W2 defines page-at-time over validity intervals from publication events, not
by picking the latest `page_versions.snapshot_at <= T` (which returns the
wrong side of an edit, because versions are preimages,
`page-state/versions.ts:15-19`). From W1 it needs exactly:

1. **Publication events per page lifetime:** create, each replace, delete,
   restore, revert, rename, merge, view change and purge, each with
   `revision_before`, `revision_after`, `recorded_at` and the per-page `id`
   order. Version `i`'s interval is `[event_i, event_{i+1})` under the
   visibility rule of section 5.3. Its body is the `page_versions` row whose
   `knowledge_revision = revision_after(event_i)`, captured as the preimage
   of event `i+1`, or the live page for the head. A creation needs no
   preimage, because the next replacement's preimage is its body.
   `page_versions.knowledge_revision` exists (`src/schema.sql:1833`).
   **That join holds only if every transition that changes the effective
   page view leaves a preimage, and today two do not.** A withdrawal bumps
   the revision with no version (`facts/withdrawal.ts:91-93`), and its
   materialization rewrites the body with no version
   (`page-state/materialize.ts:22-24`). After create, forget, materialize,
   edit, no version holds the creation revision's pre-forget body. So W1
   adds `createPageVersion` before both writes and appends
   `page.view_changed` for each. That is one more version row per forgotten
   fact per affected page, and it is W1 scope, not W2's.
2. **The visibility rule** of section 5.3 and its commit marks, so a
   transaction straddling T is reported as unproven, not answered.
3. **Coverage intervals, per-page baseline cuts and certified status**
   (7.1) and **per-page backfill completeness** (7.2), so W2 can return
   `coverage_from`, refuse inside a gap, or disclose an uncertified interval.
4. **Purge and retention markers:** `page.purged` events and the large-page
   five-version cap, so W2 discloses rather than fabricates a body that was
   pruned or redacted.
   A segmented page's versions (#6787) are pruned by
   `pruneSegmentedVersions` on its own policy, so a publication event of a
   segmented page can name a `revision_after` whose body no version row holds
   any more. W2 must disclose that body as pruned, never pick a neighbour.

W2's interval tests map onto these directly:

| W2 cell | What W1 supplies |
|---|---|
| Before, at and after creation and each of two edits | (1) |
| Stalled transaction straddling T, including one that commits after ceiling plus grace | (2) |
| Rolled-back write | No event, because the append is in the rolled-back transaction |
| Soft delete then write; purge then write | `page.restored` on the same lifetime; a new page lifetime |
| Version-id tie | Per-page `id` order under the page lock |
| Create, forget, materialize, edit | (1), the added preimages |

## 11. Proof obligations for W1 (from the plan, made concrete)

The lifecycle probe asserts **exact event keys, types and values and the
reconstructed state, not counts**, on PGLite and Postgres:

1. no-op reimport → zero events;
2. prose-only edit → exactly one `page.published`, no fact, take or link events;
3. restart mid-stream → no duplicate `event_key`;
4. rename (cheap and fallback) → one `page.renamed`; same lifetime; replay
   at T before the rename resolves the old slug;
5. row reuse (different claim at fence row 3) → `fact.retracted(fp_old)` +
   `fact.asserted(fp_new)` linked by `replaces`; a take whose claim is edited
   in place → retract plus assert; a pure take renumber → zero events;
6. two concurrent relationship refreshes on one key → evidence events
   once, no relationship-state events;
7. fault injection after durable publication but before acknowledgement →
   the retry appends nothing;
8. a lower-tier fence rewrite of a higher-tier fact → `trust.contested` with
   its proposal ref, even though the higher-tier row's projection is
   unchanged; likewise for `remember`, `takes_supersede` and a refused remote
   `forget`;
9. graduation PGLite → Postgres → identical `event_key` sets and identical
   replay; legacy copier refuses with the ledger named;
10. `forget --purge`, then replay → redacted values and one purge event; a
    direct insert of the purged row is refused and appends nothing; a
    sanitized re-import of stale Markdown appends no event that re-asserts
    the purged key; purge before a backfill, and purge between a backfill's
    prepare and its append → only redacted history;
11. backup and restore (PGLite) → the restored ledger is byte-identical to
    the archive's plus one `coverage.restored`; W2 refuses inside the gap; a
    purge made after the backup is replayed by the restore (the restored
    brain returns the purged value through no read op), and a restore with
    no readable purge events records `purge_replay: 'unavailable'` and
    raises the doctor finding;
12. the same exact-value assertions through grouped Postgres publication,
    a successful `forget` and `purge_fact`, not only the single-write path;
13. a transaction that resumes and commits after ceiling plus grace → its
    events stay unproven until their commit mark, then become visible;
14. privacy: private → public, public → private, a reused slug, a private
    fact on a public page, a link with one private endpoint or origin → no
    remote leak;
15. unmanaged source: resolve then undo between two coverage scans → the
    interval stays uncertified even though the hash matches;
16. activation interrupted by a concurrent edit, and activation after
    large-page version pruning → each page's cut is consistent and resumable;
17. source removed and re-added with the same id → no old event or watermark
    attaches to the new source;
18. two links in one publication to identically spelled slugs in two
    sources → two keys, no collision;
19. phantom merge with a crash between its two requests, and overlapping
    claims on both pages → both pages stay live, transfers are explicit;
20. ontology stints with identical claim text → distinct keys;
21. the finalization contract called with a slug whose page key is not held
    → refused;
22. a claim that survives only in another fact's context, a take's
    resolution evidence or a link's context → redacted by the purge; a
    refresh-proposal or event payload prepared before a purge and appended
    after it → refused by the stale-preparation check;
23. a destructive event (take retraction, page delete, purge) carries the
    preimage tier and a separate `writer_tier`; a baseline link event
    carries `trust_tier = 'unknown'`;
24. a lower-tier rewrite that omits a higher-tier take → the take stays,
    a `trust.contested` event and a proposal, no `take.retracted` until the
    owner accepts;
25. a lowered input → each dependent's effective tier lowered with its own
    `trust.retiered`; a raised input → no dependent promoted;
26. a bulk `trust backfill` → summary events plus a per-subject manifest
    naming every changed subject;
27. purge-verify reports link context, timeline detail and raw data that
    carry the claim, naming the rows;
28. the contest guard on each destructive path: an explicit `takes_remove`,
    a same-row claim replacement, `active = false`, a timeline detail
    replacement and an omitted fence row → the higher-tier row unchanged
    and a proposal filed;
29. a renamed endpoint whose links live in another page's stream, then
    reuse of the old slug → no key changes, and the new page does not join
    the old page's history; a database-only fact whose page is created later
    → one `fact.adopted`;
30. a page purge with more than 32 claims, a short claim and a claim that
    exists only in historical take events, each quoted in another subject's
    context → all redacted;
31. purge, then re-derivation of the same page lifetime → history reads
    return none of the pre-purge derived events;
32. a restore from an archive that holds only another subject's quote of
    a claim asserted and purged after the backup → that purge's replay is
    `partial` and the warning is raised;
33. an observer transaction that starts before a publication commits and
    reads its event afterwards → `observed_at` is not below the event's
    `recorded_at`;
34. a crash after a purge commits and before its `committed` mirror line,
    with earlier complete lines in the mirror → restore finds the intent
    line, reports it `unverified` and raises the warning;
35. purge, live re-derivation, then backfill of the pre-purge git version
    of the derived page → the backfilled events stay hidden;
36. backup, soft delete, retention cleanup (`page.expired`), then restore
    → no content tombstone written and no history redacted;
37. purge X while fact Y's fence context quotes X, then a fresh
    publication that changes only Y's confidence → Y's new event carries
    the redaction marker in `context`, and the receipt names Y's context;
    an agent edit that changes Y's context but keeps the quote → still the
    marker; a trusted local owner replacement → the next event records the
    new value, and a later agent change to it → the marker again;
38. purge X, then an agent edits only the claim of fact Y whose context
    quotes X → the successor key's event carries the marker and needs the
    owner release; the same through `fact.adopted` and `fact.transferred`;
    a verbatim copy of Y's whole context into an unlinked fact → the
    marker;
39. a page create → exactly one snapshot `page.published` and no
    per-subject events; the first edit of one of its facts → one event whose
    prior value matches the snapshot body; a database-only fact and a page
    over 1 MiB → per-subject creation events;
40. N1 unchanged (388/388, 0 stale).

**Probe 40 record (W1 lane C, 2026-10-16).** N1 (benchmark 0.5.0, generator
`n1-knowledge-update-gen@1`, 897 tasks) ran against the lane C overlay
`b3db5af98` (CLI 0.60.253.0, harness pin `77cf8e11`), three PGLite and three
Postgres cells per arm. The ledger-on arm (`EVAL_BELIEF_LEDGER=1`) runs
`gbrain beliefs enable --source vault` before the cell writes any page, so the
ledger records every write. Both arms, on both engines: current value 388/388
with 0 stale served, history retained 385/385, negative controls 124/124, 0
private value leaks, 0 acknowledged writes lost, 0 system errors. Receipts and
report: gbrain-evals `docs/benchmarks/2026-10-16-belief-ledger-n1.md`.

Each assertion gets a forced probe, a deliberately broken emitter that must
fail it, per the shipping rules.

**Estimate after design and both reviews:** 12 human-days / 36 agent-hours
for W1 itself, up from 10 / 30 after the first review and 5.5 / 14 as
drafted. The trust-tier review added the carrying-field redaction, the
per-table tombstone and stale-preparation checks, the restore replay, the
two-tier event payloads and the bulk retiering manifest. Not in that
estimate: the take and timeline contest guard and the derived-tier
propagation (section 6.3), which are trust-model prerequisites, and the
W1-later routing below. The census and the reviews found:

- a finalization contract on two publication paths plus three transactions
  that complete their own writes, with per-kind diffs in about a dozen
  preparers;
- six blocked-write producers and the tier-change producers;
- three unmanaged projection points, the resumable baseline, coverage
  intervals and commit marks;
- version preimages for withdrawal and materialization;
- inventory and catalogue registrations.

**W1 prerequisites** (land before or with W1, outside the ledger):

- #6789 (Q6 resolution data loss, the purge read leaks of section 6.5);
- the take and timeline contest guard (section 6.2);
- derived-tier propagation on lowering (section 6.3), or the documented
  "historical attribution only" caveat until it lands;
- purge-verify reporting link context, timeline detail and raw data
  honestly (section 6.5).

**W1-later: route the unmanaged and bypass writers** (section 12, question
5). V1 records unmanaged sources from three projection points and leaves
their history uncertified. Certifying an unmanaged source, or a managed
source's whole link history, needs each of these writers to call the
finalization contract or go through a coordinated path (census section 8,
about 25 writers):

- unmanaged cycle phases: `extract_facts` reconcile and deleted-page expiry,
  consolidate, phantom redirect, dream verify re-projection, stale atom
  retirement;
- the unmanaged facts pipeline, single-fact writes, legacy forget,
  fence-write and the unfenced backfill;
- legacy sync renames, deletes and holds, unmanaged import rename,
  `repair frontmatter`;
- the company-brain unmanaged import (`company-brain/profile.ts:61-75`);
- unmanaged repairs and ontology writers;
- `bootstrap verify` cleanup (`bootstrap/verify.ts:227`, `:253-255`);
- unmanaged hard deletes (pages cascading to takes and links);
- the relationship sweep (`link-relationships.ts:245`);
- the link writers that bypass the coordinator on managed brains (census
  6.4: rows 5-11, 17, 18, 20, 23, 24).

## 12. Open questions

Questions 1–3 were for GBRA-58; the trust-tier review answered them and
Garry accepted those answers. Questions 5, 6, 7 and 8 are decided.

1. **Unguarded removals. Decided:** a lower-tier rewrite that removes
   higher-tier takes or timeline rows is contested, and the higher-tier
   assertion stays until the owner accepts (section 6.2). It is a W1
   prerequisite.
2. **Tier propagation to derived rows. Decided:** a lowering propagates to
   the dependents' effective tier, or makes them ineligible until
   recomputed; a raise never promotes a derivative automatically; historical
   event tiers stay as recorded (section 6.3).
3. **Links have no tier. Decided:** the writer's tier is recorded as
   link-event actor attribution only (`tier_basis: 'writer'`), never as an
   evidence tier; baseline, backfill and reconcile record `unknown`
   (section 6.1). No `links` tier column.
4. **Ledger stores claim text.** That makes it a purge target, and section
   6.5 handles it, carrying fields included. The alternative is text-free
   events with values read from `page_versions`. It fails for database-only
   facts, which have no version. *Recommendation:* store text, sweep on
   purge.
5. **Unmanaged sources and unguarded link writers. Decided:** V1 certifies
   history on managed sources only; unmanaged sources get recorded but
   uncertified history from their three projection points. The about 25
   writers are not routed now; they are listed as W1-later (section 11).
6. **`resolveTakes` erased database-only resolutions. Fixed before W1** in
   #6789: a fence without resolution cells no longer touches the database
   grade, and a claim edited in place drops its old grade. Forced probes fail
   on master and pass with the fix on both engines.
7. **Storage on PGLite. Decided:** one snapshot event per page at creation
   (and at baseline), about 9 MB of creation events per 10,000 typical pages
   instead of about 210 MB, with per-subject creation events kept where no
   retained body holds the values (section 4). Trimming was measured and
   skipped (section 9).
8. **PLAN correction. Accepted;** Garry updates the PLAN. The default
   PGLite→Postgres route is graduation, which carries ids verbatim, and the
   legacy copier refuses journaled brains. So the ledger needs a graduation
   `carry` row and a refusal-list entry, not an id-remapping copy. W5's
   `page_versions` copy is re-scoped to history-free brains or dropped.
9. **More version rows.** Section 10 adds a page version before each
   withdrawal and materialization, so page-at-time can show the pre-forget
   body. *Recommendation:* accept; the alternative is reconstructing
   historical overlays from withdrawal events, which W2 would then own.

## 13. W1 as built: deviations from this design

1. **The canonical diff is computed in the publication transaction** from
   logical state reads before and after the projections, under the held page
   keys (`withBeliefBatch`), not per preparer in prepare. The logical keys are
   the same; contested, held, withdrawn, transferred and purged rows are made
   explicit through batch notes. An in-transaction append cannot carry
   pre-purge state (a purge holds the same keys), so the `purge_epoch` stale
   preparation check applies only to payloads prepared outside the
   transaction (backfill, refresh proposals). Section 9 measures the cost.
2. **Link `context` is carried text:** it is in the event value (purge redacts
   it) but excluded from the diff hash, so prose edits near a link append
   nothing (probe 2).
3. **Added event types:** `link.revised`, `link.transition_revised`,
   `coverage.complete` and `redaction.released` (review #43/#5: every write of
   `belief_redactions.released_by` appends one on the redacted key and its
   stream in the same transaction and publication, from the owner-edit append
   path and from `trust confirm`; a confirm that leaves the tier unchanged
   publishes only this event); a held write's key is
   `["h", <stream lifetime or slug ref>, kind, hold fingerprint]`, so two
   holds with one fingerprint in one publication stay two keys.
4. **Commit marks** are a follow-up statement after commit by every appender
   (group members share one statement); readers fill missing marks. There is
   no effects-queue row.
5. **Take ordinal** is the rank among identical claims (claim, kind, holder) by
   `(since_date, row_num)` in each state. Identical claims are
   interchangeable, so removing one copy retracts the highest ordinal; the
   ordinal is not fixed at first sight.
6. **`belief_page_lifetimes.page_id` is a hint:** it ends a lifetime whose page
   an untracked writer replaced.
7. **The ledger is off per source** until `gbrain beliefs enable` baselines it;
   a publication on a source without coverage pays one source read.
8. **Segmented pages (#6787):** a page over 1 MiB takes the per-subject
   creation path; segmented pages project no fence facts, takes or links, so
   their snapshot and baseline carry no fact or take subjects; state hashes
   and the purge inventory never read segmented bodies; see section 10, item
   4, for pruned versions.
9. **Retention cleanup on a managed brain** removes the page without purge
   tombstones and appends `page.expired` (section 6.5). Before W1 it went
   through the page purge path and tombstoned the page's facts and takes; a
   BEHAVIOR_CHANGES row discloses the change.
10. **Ontology rows** are keyed into their provenance stream (the
    observation's `source_markdown_slug`) as database-only subjects, not into
    the entity's stream.
11. **Purge carrier registration resolves lifetimes outside the purge's page
    locks.** `registerLiveCarriers` and `registerVersionCarriers` key the
    carrying fields of pages the purge does not lock (any page quoting the
    claim) and may mint their open lifetime without that page's key. Taking
    those keys inside the purge transaction would break the global lock
    order, so a concurrent rename of such a page can mint a second lifetime.
12. **Owner release reach (6.5). W1-later: local CLI writes as owner tier
    needs Garry's trust-posture decision; in W1 only `trust confirm`
    releases.** A publication is an owner edit only when a
    local caller journals a direct edit (`put_page`, `edit_page`,
    `takes_update`, `takes_resolve`) with no internal intent kind; append
    still requires the writer tier at or above `OWNER_TIER_FLOOR`. The trust
    channel records those verbs as `agent_written` even from the local CLI,
    so in W1 the release that reaches the floor is the owner confirm action
    (`trust confirm`).
13. **Short claims quote a field only as a word.** A claim shorter than eight
    characters matches a carrying field only where no letter or digit of a
    space-separated script (Latin, Greek, Cyrillic, Armenian, Georgian) is
    glued to it; CJK, Thai, punctuation and markup still match as
    substrings. The inventory of claims stays exhaustive; only a short claim
    inside a longer word (`ceo` in `herbaceous`) no longer redacts.
14. **Purge leaves unsalted digests (known limit).** `claim_fp`,
    `belief_redactions.field_hash` and `state_hash` are plain sha256, as are
    the purge tombstones that predate W1 (`fact_purges.fact_hash`,
    `take_purges.claim_hash`, `page_purges.content_hash`). Anyone holding a
    backup or a database export can confirm a guess of a purged claim's exact
    normalized text. A per-source salt stored in the brain would not change
    that (the salt is in the same backup), and `claim_fp` must equal the
    tombstone digest for redaction to work. A keyed HMAC with the key outside
    the database would protect a database-only copy, but the key would have
    to travel with backups (defeating it) or be kept apart (a lost key stops
    tombstones matching, so purged facts return on the next sync), and the
    fingerprint is an immutable SQL function behind index expressions. Not
    built in W1.
15. **One-statement state read.** A batch's pre and post reads are one SQL
    statement each (pages, facts, takes, links, transitions and link
    endpoints as JSON). Link and transition rows are selected through their
    origin and from-page indexes before any endpoint join, facts through a new
    `idx_facts_belief_stream (source_id, source_markdown_slug) WHERE
    expired_at IS NULL` (v249's handler builds it online), and the post read
    reuses the pre read's claim fingerprints. Section 9 has the cost.
16. **The state read runs with a generic plan.** Under the default
    `plan_cache_mode` a bulk import kept re-planning the read for every page
    as its tables grew (about 3 ms each), so the ledger's per-page cost rose
    with the size of the import (0.8, 4.0 and 5.5 ms per page at 300, 1000
    and 2000 pages on PGLite). The read now sets `force_generic_plan` for
    that one statement, transaction-local, and restores the previous value;
    the cost stays about 0.6 ms per page at every size.
17. **Projections skip identical rewrites; the post read reuses untouched
    tables.** The fence fact-field update, the take upsert and the take
    resolution update write only rows whose values change, so a prose edit
    rewrites no fact or take row and `takes.updated_at` moves only when the
    take changes. Nothing reads a rewrite that changes no value: write
    attribution and the trust tier already move only on a value change, and
    every `updated_at` cursor and freshness reader is on `pages`. The post
    read compares the transaction's `pg_stat_get_xact_tuples_*` counters for
    facts, takes, links and link transitions with the pre read's and reuses
    the pre read's rows for every table the transaction did not write, while
    the stream pages are the same pages at the same slugs (fact entity pages
    and link endpoints are read fresh). With `track_counts` off it reads
    everything. A missed write would surface as drift in doctor
    `belief_ledger_coverage`, which a forced probe shows.
18. **Fewer statements per batch.** The source read that opens a batch also
    reads the managed mode and switches to generic plans for the pre read;
    each state read restores the plan mode inside its own statement. When
    the post read reused a table's rows, the post side reuses the pre side's
    fact and take subjects (take visibility from the post side) instead of
    keying them again.
19. **Process-local fingerprint cache.** Each stream read hashes claim texts
    (SHA-256, in SQL) and fingerprints only those whose hash the process has
    not fingerprinted before; `gbrain_fact_fingerprint` costs about 27 µs per
    claim on Postgres, the SHA-256 under 1 µs. The cache maps text hash to
    fingerprint only, never claim text, and is bounded (20,000 fingerprints,
    2,000 streams, oldest out first). A forced probe compares cached and SQL
    fingerprints for random claims with case, Unicode, punctuation and
    whitespace edge cases on both engines, because a divergence would break
    purge matching. One-shot CLI processes start cold and pay the full read.
20. **Declined: a subject snapshot cache on the lifetime row** (the "cheaper
    option" section 9 listed). After items 17 to 19 a typical Postgres edit
    costs about 3.8 ms of a 44–50 ms write. Removing the pre read entirely
    would leave about 2.6–2.8 ms (5.5–6%); a real cache also needs a
    validity check and a write per batch, so about 6–7%, still above the 5%
    target, for a migration plus invalidation on purge, redaction and
    unmanaged writers. Not built.
21. **Keying without re-sorting.** `canonicalJson` sorts an object's keys
    only when they are not already in order and caches the quoted form of
    key names (at most 4,096); fact and take values are built with their
    keys in canonical order; the state hash computes each subject's sort key
    once. The bytes are unchanged, so every stored value, claim and state
    hash stays valid: test/belief-ledger-canonical-json.test.ts holds the
    serializer and the state hash to the original implementation on a
    seeded corpus and every edge case, and broken variants fail it.

## 14. W2's first slice as built: page-at-time

1. **Surface.** Page-at-time is a parameter, not a new op: `get_page
   {known_as_of}` and `get_versions {known_as_of, diff, source_id}`, full
   surface only, so the served starter schema is unchanged. `known_as_of` is
   recorded time, an ISO 8601 instant with a zone; a bare date refuses
   `clock_mismatch` (`date_for_instant`) instead of being read as midnight,
   because a date is the valid-time clock (`as_of` on `get_links`). The
   catalogue gains `clock_mismatch` and `known_as_of_unproven` (retryable);
   `coverage_from` names `not_recorded`, `backfill_only` or
   `backfill_incomplete`, and backfilled history never answers a
   recorded-time read, because it has source times only. Every answer carries
   `certified` and `uncertified_reason`.
2. **Bodies pair by revision, in order.** Several intervals can share a
   revision: a withdrawal's materialization is a view change at the same
   revision. So the closed intervals of one revision pair with that
   revision's versions in id order, newest with newest, and the open head
   reads the live page while it is still at that revision. A body no version
   holds is returned as `body: unavailable` with `body_reason` (`purged`,
   `expired`, `hard_deleted`, `pruned` for a large or segmented page,
   `version_missing`), never taken from a neighbour.
3. **Correction to section 10, item 1: a rename also left no preimage.** The
   page revision trigger advances the revision on a slug change, and
   `updateSlug` (the cheap sync rename, the frontmatter slug repair, the held
   file and import moves, managed sync's rename) wrote no version, so after a
   rename no version held the body from before it. `updateSlug` now versions
   the page first, in the same transaction. A publication that changes the
   revision twice in one transaction (a rename then an edit) records the
   pre-transaction revision as `revision_before`, and that revision now has
   its version too. A BEHAVIOR_CHANGES row discloses the extra version.
4. **Correction to sections 3 and 10: a soft delete keeps the lifetime.** A
   write to a soft-deleted slug restores the same page row and appends
   `page.restored` on the same lifetime (`ledger.ts`); only a page removed
   outright (purge, retention cleanup) and written again starts a new
   lifetime. W1's code and probes already behaved this way; only the text was
   wrong.
5. **Purged lifetimes collapse.** Section 6.5 sets `value` to NULL on every
   event under a purged key, page events included, so a purged lifetime's
   events no longer carry revisions. Its intervals split only where its slug
   or deleted state changed (the event type and row still say), and every
   body is `purged`. A local caller reading an instant before the purge gets
   that interval with no body; a remote caller gets `page_not_found`, because
   the page row is gone and the remote rule fails closed. A probe un-redacting
   the revisions makes the lifetime split again, and `purge_fact` probes show
   no historical body or diff returns the purged claim to either caller.
6. **Proof of commit is the same lifetime, and backfill never proves.** An
   unmarked event counts at `T` only when a later event of the same page
   lifetime, not of origin `backfill`, was recorded by `T`. That is
   stricter than `beliefEventVisibility`, which also accepts a later
   backfill row, so a read can refuse `known_as_of_unproven` where the W1
   helper says visible; it never answers where the helper says unproven.
7. **The stalled-transaction cell runs on commit marks.** The read depends
   only on marks and recorded times, so the cell deletes and re-adds a mark
   (and stamps one at `recorded_at` as its forced probe) rather than holding
   a transaction past ceiling plus grace; W1's probe 13 holds a real one.
8. **The preimage invariant, enforced.** Every publication that moves a
   page's knowledge revision leaves a `page_versions` row of the revision it
   started from (`revision_before`), written in the same transaction before
   the write that advances it. Revisions a transaction only passes through
   (a rename then an edit in one publication) are never a ledger state, since
   events record only the publication's start and end, so they need no
   version. Large and segmented pages are exempt, because their versions are
   pruned on their own policy and page-at-time discloses those bodies as
   `pruned`. Enforcement has two parts:
   - **In tests**, `finalizeBeliefEvents` checks every stream whose
     revision moved and fails the transaction when no version of
     `revision_before` exists (`preimages.ts`, `missingPreimages`), so a
     writer that breaks the rule fails its own tests. It runs only under
     `NODE_ENV=test` (`GBRAIN_BELIEF_PREIMAGE_CHECK=0` turns it off for a
     probe that breaks the rule on purpose): in production it would add one
     indexed lookup per revision-moving publication to the write path the
     W1 overhead work is cutting.
   - **In production**, doctor `belief_ledger_coverage` lists page events
     from `live` or `unmanaged` publications whose `revision_before` no
     version of the live page holds (`preimageGaps`: last 30 days, complete
     under `--tier deep`) and warns, naming the slugs and events. The body
     is not recoverable; the finding names the writer to fix.

   Turning the check on found a second writer that broke the rule:
   `purge_fact` rewrote each affected page body (dropping the purged fence
   row) with no version. It now versions each page before the rewrite, and
   its version redaction pass then redacts that version like every other
   one, so the interval before a purge reads the body as it stood, minus the
   purged claim.

## 15. W4 as built: the weekly change diff

1. **Surface.** One reader, two doors. `delta {beliefs: true}` (full surface
   only, so the served starter schema is unchanged) adds `beliefs` for the
   same window as the rest of the wake, and `gbrain beliefs changes
   [<entity>...] [--since 7d]` prints it from the CLI. Both call
   `beliefChanges` (`src/core/belief/changes.ts`). On a thin client the CLI
   calls the host's `delta`, so it lists what a remote caller may see.
   `entities` (the CLI's positionals) keeps changes whose stream page, fact
   subject or entity, or link end is one of the named slugs.
2. **One entry per belief that ended the window different.** Events are read
   from `readBeliefHistory` between `since` (exclusive) and `until`
   (inclusive), grouped by subject key, and compared end to end: `before` is
   the subject's newest event at or before `since`, `after` its newest event
   in the window. An edit and its revert, or an assert and its retraction,
   report nothing. Each entry carries `kind` (`page`, `fact`, `take`,
   `link`, `link_transition`), `change` (`added`, `removed`, `changed`;
   page events add `deleted`, `restored`, `renamed`), a readable `subject`,
   `before`, `after`, `cause` (the event type, the op, and any request,
   replacement, proposal or purge pointer the event recorded), `evidence`
   (event id, recorded time, slug, fence row) and the event's `trust_tier`.
   Subjects net on hashes (the first event's prior hash against the last
   one's value hash). Page events net per lifetime: a delete and its restore,
   or a rename and its revert, report nothing, and so does a page created and
   gone again inside the window, together with its beliefs. A page renamed
   inside the window is reported under its final slug, and so are the beliefs
   it moved (their evidence keeps the slug each event was recorded on). A purge,
   expiry, merge or hard delete is one `removed` page entry.
3. **A subject with no earlier event.** Section 4 records a page's creation
   as one snapshot event, so a fact or take first edited inside the window may
   have no event before `since`. Its `before` is read from the page body as
   recorded at `since` (page-at-time, section 14). When no body answers (a
   pruned, purged or segmented body, or no version), `before` is null and
   `before_known` is false: the value is disclosed as unknown, never guessed.
   A page created inside the window is one `added` page entry plus one
   `added` entry per fence fact and take of its creation body; links that
   came with it are counted on the page entry (for local callers only: the
   counts include beliefs a remote caller may not read).
4. **Upper bounds.** A relationship end that only the nightly check inferred
   (a transition whose producer is `dream`) is flagged `upper_bound: true` and
   rendered `end by <date>`: the relationship ended on or before that date
   (section 16).
5. **What is never a change.** Backfill and baseline events are skipped:
   backfill carries source times, and a baseline is the state a coverage run
   found. A window that starts before the source's coverage sets
   `coverage_from`, because earlier changes are unknown rather than absent; a
   source with no coverage at all returns `not_recorded: true`.
6. **Remote callers.** `delta` passes `remote: !include_private`. The history
   reader's rule applies (events world-visible when recorded, on a page
   visible now, failing closed; takes of the holders the caller may read), and
   a body read for `before` or a creation is used only where `remoteMayRead`
   passes that interval, only for world fence rows, and never for a claim made
   private later or a key a purge hid. A remote history page is filtered after
   its SQL `LIMIT`, so reads page on the rows each page scanned, never on the
   rows it returned. A take removal carries no value, so its holder is the
   key's newest earlier value's; a take that came with its page's creation and
   was removed later has no earlier event, so a remote caller does not see the
   removal.
7. **Budget.** Under `budget_tokens`, belief lines pack into what pages,
   facts and threads leave; a dropped line sets `truncated`. Without a
   budget the list is capped at 200 entries, and a window with more than
   50,000 events the caller may read stops reading and sets `truncated`
   (events it may not read never count, so they cannot change the answer).
8. **Measured at $0.** Four seeded synthetic weeks (37 gold changes) give
   set-F1 1.0 with exact before and after values on PGLite and Postgres
   (`test/belief-ledger-weekly-probes.test.ts`). The cited diff costs 258,
   233, 215 and 273 tokens against 227, 182, 307 and 281 for the plain list
   of changed pages, so the cited answer costs about the same as the list it
   replaces while naming each claim, its old value and its evidence.

## 16. W5 as built: the time-model fixes

1. **Inferred ends are upper bounds.** `RelationshipState.lastEndUpperBound`
   (`link-validity.ts`) is true when every transition behind the last end has
   producer `dream`: the nightly contradiction check closed the stint on the
   day it noticed, so the true end is on or before that date. The relationship
   note renders `ended: works_at acme-example (by 2025-03-01)`.
2. **An explicit end replaces the inferred one.** An explicit end of the same
   stint, earlier or later than the inferred closure, replaces it
   (`withoutOverriddenInferredEnds`), so a late correction from the page is
   the end the reader sees.
3. **Correction to the plan: page versions are not copied between engines.**
   `gbrain migrate --to <engine>` on a source brain that holds page versions and
   no journal tables refuses `writer_coordinator_required` (reason
   `page_history`, "Engine migration would discard N page versions.")
   instead of copying them. The legacy copier re-creates pages with new ids,
   so carrying versions would mean re-keying every version to its new page;
   graduation to a managed brain already carries them
   (`persistence/graduation-copy.ts`), so the plan's copy step is replaced by
   the refusal, which names how many versions the copy would have discarded.
4. **Dropped from the plan.** The `since_supplied` probe passes on master, so
   no fix shipped for it; the probe stays as a regression pin
   (`test/belief-ledger-w5-time-model.test.ts`).
5. **E2 moves to a custodian.** The rerun of the P1 E2 late-closure eval runs
   on held-out text in owner custody, preregistered in gbrain-evals before any
   run; nothing in this repository reads the held-out set.
