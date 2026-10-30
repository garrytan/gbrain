# Generations

GBRA-161. A derived producer (atom extraction today; synthesis, fences and projections in later releases) replaces the
set of items one input owns through one primitive, `publishGeneration` (`src/core/generations/publish.ts`). The
generation ledger records which items each generation owns, so a bad result can be held before it lands and a landed
one can be undone.

## The ledger

Migration v265 (a placeholder number, restamped when the change merges) adds four tables. Nothing existing changes.

- `derived_generations`: one row per generation of a key (source, kind, owner key). At most one is `live` and at most
  one is `held`; earlier live rows become `superseded` and keep their items. A row records the input pin and size it
  was derived from, the item-set hash, the operation id an identical replay matches, and for a held row the reason, the
  attempts and the proposal it would publish (at most 4 MiB, else no releasable copy).
- `derived_generation_items`: each item a generation published, kept, adopted, revived or retired, with its identity
  hash (a digest of what the page says, leaving out completion, extraction and retirement stamps) and, for an item it
  overwrote or retired, a bounded preimage (at most the inline page size; none for a segmented page).
- `derived_generation_valve`: retirements counted per run window, for the retirement valve.
- `derived_generation_attempts`: terminal publish failures counted per hold identity (key, input pin, policy, item
  set). The third holds the result `attempts_exhausted` with the last three error codes and clears the counter; a
  later run of the same result stops at that held row until `--mode release-held` publishes it. A fenced producer is
  not counted. Only error codes are stored.

Migration v266 (also a placeholder) adds the managed side (PR 1b): `derived_generations.locator` (a transcript key's
current file) and `activation_id`, `derived_generation_items.pending` (an item a member request still overwrites or
retires; a retirement marked pending is `retire_pending` and still live), and `derived_generation_activations`: one row
per admitted managed activation with its members and whether it activated.

## Publishing

Under the item page locks (slug order) and then the key's advisory lock, `publishGeneration`:

1. replays an identical operation as `unchanged`;
2. refuses a producer that planned against another live generation or whose input moved (`generation_fenced`);
3. plans the result (`plan.ts`, pure): an item is the key's when the live generation recorded it, or when it carries
   the key's origin metadata and either the result reproduces it or a retained page version the producer wrote shows it
   unedited (legacy adoption). Any other row naming the key is protected: never retired, listed in the outcome;
4. holds the result instead of publishing it, in this order: `segmented_unsupported` (it would rewrite or retire a
   segmented page), `tie` (a strict-order adapter's result has a duplicate or missing rank, #6023), `no_proof` (an empty result without an empty-source proof, `proofs.ts`), `oversize` (more puts
   or retirements than `generations.max_items`), `shrunk` (a model-produced result keeping fewer than
   `generations.shrink_floor` of the owned items, scaled by how much the input shrank), `valve` (the run window would
   retire more than `generations.valve.max_per_run`, or more than 25 and over `generations.valve.max_ratio` of the
   kind's owned items). A held result writes nothing and retires nothing; the previous generation stays live;
5. otherwise, in one attributed transaction: writes the new and changed items, marks them complete (an atom's
   `source_hash`), rechecks each is live at the identity just written (`generation_live_conflict` otherwise), versions,
   soft-deletes and stamps what the new generation no longer has (`retired_by` the adapter's stamp, held from the
   purge for `generations.restore_days`), supersedes the previous row and activates the new one.

A partial result (an input cut at its cap, #6503) publishes additively: it writes its items, carries the rest of the
live generation forward, retires nothing and completes nothing.

Adapters (`contract.ts`) own one kind each: `adapters/atoms.ts` (atoms, one key per origin page or transcript) in this
release. An atom's identity leaves out the provenance a managed writer stamps (`source_kind`, `ingested_via`,
`ingested_at`, `trust_tier` and the other content-hash ephemeral keys), so a managed write never reads as an edit.

### Facts and takes (PR 2)

A page's `## Facts` and takes fences are canonical, so their kinds (`fact_fence`, `take_fence`, one key `page:<slug>`
each, `generations/fence.ts`) have no shrink floor, valve or item cap: a fence read whole and valid is complete whatever
its row count, and an empty one retires every row (`fenceParsedEmpty`). Every writer that would retire fence rows (the
page publication's projection, `extract_facts`, `gbrain extract takes`) calls `publishFenceGeneration` in its own
transaction, under the page key, before it writes. A fence that is absent, unread or on a segmented page holds
(`fence_absent`): nothing retires, and doctor `generation_held`, `gbrain sync status` (`fence_holds`) and
`get_page` (`fence_held`) list the page with an `ask_user` fix naming both outcomes (restore the section to keep the
rows, or write the exact empty fence it prints to retire them; never a default). The rows of a deleted page expire only
on `originGone`: the page is gone under its key and the rows came from a fence (a live generation, or a fence in the
deleted page's stored body); otherwise they are held `no_proof`. Each retired or replaced row's before-state is on the
ledger. A fence restore (`fence-restore.ts`) writes the earlier generation's fence block into the page as it is now
through a guarded `put_page` bound to its revision, leaving the body, timeline, tags and the other fence alone, and
refuses a fence edited since (`edited_since`, `section_moved`).

The dream consolidate phase records each cluster (`consolidation`, key `entity:<slug>:cluster:<ids>`,
`adapters/fact-rows.ts`): a strict chain records each member's `valid_until`, `consolidated_at` and
`consolidated_into` before it closes them (unmanaged and managed), a same-instant tie (#6023) is held `tie` with nothing
written, and `--mode restore` reopens a chain, which the phase then leaves open.

Model-extracted facts publish through `publishExtractedFacts` (`adapters/extracted-facts.ts`, kind `extracted_facts`,
key `page:<slug>:<writer>`), the path the conversation lane and the facts backstop move onto: a `whole_body` result
retires what it dropped under the model floor and valve, an `appended_range` result is additive, and an
assistant-attributed or third-party fact is stored on its source page with no entity, never attached to an entity page
as an owner fact. `deleteFactsForPage`, `expireFact` and `insertFacts({ deleteForPageFirst })` are deprecated; no
production code calls them (`test/generations-deprecated-fact-writers.test.ts`).

Life Chronicle events publish through `publishChronicleGeneration` (`adapters/chronicle-events.ts`, kind
`chronicle_event`, key `depth:<slug>`, GBRA-161 PR 3). Each judged revision of a depth page (meeting, conversation,
calendar page) is a generation of event pages; each event's timeline projection row on the depth page belongs to its
item. A complete re-judgment retires the events it dropped together with their projection rows in the activation
(versioned, `retired_by: life-chronicle`); a result below the model floor is held `shrunk`, and an empty or partial one
(#7013) retires nothing. An empty generation retires only with a proof: `originIneligible` (the revision became
ineligible: `not_chronicle_shaped`, `dream_generated` or `too_short`, rechecked against the chronicle ledger by the
adapter's `proofHolds`) or `originGone` (the chronicle phase retires the events of a deleted depth page). Ownership
stays content-addressed: an event is the extractor's while its content hash is on the chronicle ledger, its identity is
the one the live generation recorded, or it is exactly what this publication proposed; an operator-edited or
operator-deleted event is never an item, so nothing overwrites, retires or revives it.
`gbrain repair generations --kind chronicle-event --mode restore` brings retired events and their rows back.

### Synthesis

Dream synthesis outputs (kind `synthesis`, one key per transcript: the PR 1b transcript key, `transcript:<root>/<path>`;
`adapters/synthesis.ts`, GBRA-161 PR 4, #7065) publish in place (`publishesInPlace`): the synthesize phase's children
write the reflection and original pages as they always did, and after postprocess and the provenance stamp
`cycle/synthesize-generations.ts` records each synthesized transcript's outputs as its new generation. The decision is
the plan approved on Oct 21: replace only on a complete, non-empty result, always version first, always reversible.

- An earlier output retires at activation (versioned, `retired_by: synthesis-resynthesis`, its file removed when the
  database holds everything in it) only when it is matched (`generations/synthesis-coverage.ts`): an exact duplicate of a
  new page, or a page of the new generation with the same subject (slug without its hash suffix and date, or the same
  lowercased title tokens) while every claim unit (each sentence outside a quote), every verbatim quote (a `>` block or a
  quoted span of three or more words) and every citation (wikilink or link target) of the earlier page appears in the new
  generation.
- Every other earlier output is carried into the new generation, stays live and is recorded on it as an unmatched
  predecessor (why, and how many claims, quotes and citations it holds alone; a segmented page is never compared and is
  listed `unreadable`). `gbrain repair generations --kind synthesis --mode cleanup --since 30d` lists them and
  `--apply --expect <hash> --yes` retires exactly the previewed ones (`retired_by: synthesis-cleanup`).
- A transcript is complete only when every child of every chunk completed and nothing of the run is deferred or still
  pending publication. Otherwise, or with `generations.synthesis.retire_previous` set to false, the generation is
  partial: the new outputs are recorded and nothing retires.
- An output from before the ledger is never adopted as an earlier output (no legacy evidence), so the duplicate backlog
  an upgraded brain already holds is untouched. The shrink floor applies, measured against the live generation's items
  (an in-place kind's new outputs carry new keys), and so does the valve: a mass re-synthesis retires at most its share
  per run window and holds the rest (`valve`).
- `--mode restore` brings a retired earlier output back from its ledger preimage, retires the outputs that replaced it
  and puts the files back the same way (unmanaged brains). A managed brain admits the activation and one versioned
  delete per retirement (`managed_generation_retire`, `generations/managed-retire.ts`) in one transaction; the next run
  resumes a retirement left behind.

### Single-page kinds and fence-only writers (PR 5)

Three derived pages one writer rewrites in place under a fixed slug publish as single-item generations
(`adapters/single-page.ts`, owner key `page:<slug>`): the dream summary (kind `dream_summary`, S-2), the `think`
synthesis page (`think_synthesis`, S-10) and the drift report (`drift_report`, S-11). The writer reads the page revision
before it composes (the summary before its children are submitted, the drift report before the judge loop, the `think`
page before gathering, carried on `ThinkResult.persist_base`) and passes it as the generation's input pin. Activation
rechecks it under the page lock: a page that changed since is fenced (`generation_fenced`, `pin_moved`), keeps the
edit, and the writer reports it (the summary and drift report on stderr, `think --save` as an error) instead of writing.
A write that changes a live page copies it to `page_versions` first (`gbrain restore`) and keeps its bounded preimage
on the ledger, so `gbrain repair generations --kind dream_summary|think_synthesis|drift_report --mode restore` puts the
earlier page back. A segmented live page is held `segmented_unsupported`. Managed brains keep their coordinated
maintenance page request, which binds the revision it reads at publish time and versions first.

Derived links and timeline rows are fence-only kinds (plan: the revision fence and the guard, no ledger). Each delete
runs with the page row locked (`FOR SHARE`) and only while the page is still at the revision its producer read:

- Timeline orphan retraction (T-2): `retractRemovedTimelineEntries` takes `expectedRevision`; `pruneTimelineOrphans`
  (unmanaged), `gbrain extract timeline --source db` (unmanaged) and `extract --stale` pass the revision they read. A
  page that moved deletes nothing. File-source extraction reconciles against the file and keeps no fence here.
- The by-mention rebuild sweep (L-6): `gbrain extract links --by-mention --rebuild` reads the revision before the body;
  a page that moved before the sweep is not swept and stays unchecked, so a resume retries it.
- Concept provenance edges (C-4, #4589): `replaceConceptProvenanceLinks` banks a republished concept's edges and retires
  the edges of atoms that left its member group in one transaction, only while the concept is at the revision its
  publication produced. Edges retire only when a concept generation replaces the previous one.

### Managed sources

A managed source (`generations/managed.ts`) never composes a generation in one transaction: every page write is its own
coordinated request with its own file. A publication is planned without locks and admitted as one batch, in order:

1. `create` members: page writes of new identities only (a key no live row holds);
2. one `managed_generation_activate` request (trusted local only; a remote one is refused): under the member page locks
   and then the key lock it rechecks the expected generation, the input pin and each member at its planned identity,
   flips the ledger and marks every item a member still overwrites or retires `pending`;
3. `overwrite` and `retire` members: the existing per-page managed put and delete requests (version first, stamp), each
   refusing unless its item is pending on the live generation its activation made, and clearing the mark on commit.

A database-only kind (`databaseOnly`: chronicle events, which have no canonical file) writes its new and changed items
as their own requests before the activation, which it journals on the input page bound to its revision; the activation
checks those members at the identity they now hold, records their before-states from the plan and retires the dropped
items itself, so nothing is left pending. Its restore runs as one coordinated `managed_generation_restore` request.

The activation id is digest(operation id, run scope) and each member's digest(activation id, slug, action), so a rerun
replays them. Between steps 1 and 3 old and new items are both live, never neither. The next extraction run of the
source resumes pending members (`resumeManagedGenerationMembers`): a request still queued is waited on, one that ended
without committing is submitted again, and a page edited since keeps its content. Pages a `create` member wrote for an
activation that never happened are orphan candidates: doctor `generation_pending` and `--mode cleanup` list them with
their activation id, and nothing retires them automatically.

A transcript's key is its corpus root label and root-relative path (`transcript:corpus/team-a/2026-09-07-standup.txt`),
never its basename or content hash. A file a live generation names as its `locator` keeps that key, and a file whose
content equals the input of a live generation whose file is gone was moved: it keeps that key and the locator follows.

`gbrain repair stale-atoms` retires each listed atom as an approved generation of its origin key (no floor or valve),
bound to the atom's identity; `atoms-restore` keeps its command and JSON and still restores managed retirements, and
doctor `atom_retirements_restorable` leaves out an atom whose retirement the ledger records, so it warns once.

## Repair

`gbrain repair generations --kind <kind>` is explicit-only and preview-bound (docs/guides/repair.md#generations):
`--mode restore` (the default) republishes the item set the selected live generation replaced, `--mode release-held`
publishes a held result once (a managed source releases an atom page key through its writer), and `--mode cleanup` lists
pending members and orphan candidates, read-only (for `synthesis` it also lists unmatched predecessors, which its
`--apply` retires; see [Synthesis](#synthesis)). A managed source restores retired atoms with `gbrain repair
atoms-restore`; `--mode restore` refuses there for every kind but the fence kinds, whose restore is a guarded page write. Doctor reports `generation_retirements` (ok, with the restorable
count), `generation_held` (warn) and `generation_pending` (warn).

## Purge

A page purge nulls the purged item's preimages and every held proposal naming it; a fact purge nulls every preimage and
proposal carrying the claim (`ledger-scrub.ts`). Restore then refuses that item (`no_preimage`).

## Census

`scripts/check-derived-census.ts` counts the code that soft-deletes pages per file against
`docs/architecture/derived-census.tsv`. A new site needs a reviewed row; ceilings only shrink. Rows classed
`pending:inventory` are the derived writers later GBRA-161 PRs move onto the primitive.

## Settings

| Key | Default | Range |
| --- | --- | --- |
| `generations.restore_days` | 30 | 3 to 365 |
| `generations.shrink_floor` | 0.5 | 0.05 to 1 |
| `generations.max_items` | 64 | 8 to 1024 |
| `generations.valve.max_per_run` | 500 | 1 to 100000 |
| `generations.valve.max_ratio` | 0.5 | 0.01 to 1 |
| `generations.synthesis.retire_previous` | true | true or false |

`gbrain config set` refuses a value out of range; a stored value out of range reads as the default.

## Decisions

- The valve's ratio half applies only above 25 retirements in a run window, because on a small brain a few legitimate
  retirements are already a large share of the owned items; `generations.valve.max_per_run` still bounds every window.
- 11 census rows stay `pending:inventory`, because this release moves only unmanaged atoms onto the primitive; the
  rows name the other derived writers so a new soft-delete site cannot land unreviewed while later PRs move them.
- A partial result (#6503) publishes additively, because an input cut at its cap cannot show which items are gone:
  writing what it has keeps new work, and retiring nothing keeps a truncated read from deleting the rest.
- v265 has no `source_incarnation` column and no `attempted` state: deleting a source cascades its ledger rows, so a
  recreated source starts clean with nothing to tell apart, and a publication is one transaction, so no row exists
  before it activates.
- The operation index is not unique and replay matches only the live row, because one result can be published again
  after a different one superseded it (same pin, A then B then A); matching a superseded row would report it
  `unchanged` while B stays live.
- Attempts have their own table instead of the held row's `attempts` column, because a held row means a result
  waits for the operator (doctor warns, release-held lists it) and a key has at most one; counting failures there
  would warn before any result is held and displace a real held result.
- The shrink floor holds a result strictly below `shrink_floor` of the owned items (scaled by the input ratio), so a
  result exactly at the floor publishes; this is the plan's "below it the result is held".
- A managed activation's id includes the producer's run scope, because a connector run refused after an owner claimed the
  source must not collide with the owner's run of the same result.
- Managed `--mode restore` is refused and `atoms-restore` stays the managed restore path, because a generation restore
  writes pages in one transaction, which a managed source cannot do; a managed restore through member requests is left
  for a later PR.
- Synthesis subject matching accepts the slug stem (hash suffix and date prefix removed) or the lowercased title tokens,
  because a re-run may rename either; the coverage test (every sentence, quote and citation) is what makes a retirement
  safe, and an earlier page that fails it stays live whatever its subject.
- An in-place kind's shrink floor counts the live generation's items only, because its new outputs carry new keys and
  would otherwise count as owned before the run: a re-synthesis with fewer pages than before would always hold.
- A managed brain's synthesis restore is refused like every non-fence managed restore (see above); its retirements are
  versioned deletes, and the earlier pages come back through `gbrain repair generations` on an unmanaged brain or a
  later managed restore path.
