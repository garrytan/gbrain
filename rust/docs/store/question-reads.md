# Pinned-question reads (`question_reads.rs`)

`gbrain questions` keeps standing answers to pinned questions (src/core/questions/). Its reads are typed engine members
with one SQL implementation for PGLite and Postgres (src/core/engine-sql/question-reads.ts). The Rust store serves every
one that reads no pin record, from `rust/crates/gbrain-store/src/question_reads.rs`; it keeps no record of its own. The
newest pages under a pin's slug prefix come from `readPrefixAnchoredPages` (`cli_reads/entities.rs`, `page_ops.md`),
which the store serves too.

`pages.generation` is the store's per-page counter (`page_generation.rs`, [pages.md](pages.md) has the index key): it
moves exactly as the SQL engines' trigger moves it, so a generation read on Rust equals the SQL engines' number
(test/engine-parity/page-generation.test.ts). An insert takes the highest generation of all pages, soft-deleted ones
included, plus one; an update adds one when a watched column changes (body, timeline, frontmatter, deletion, title,
type, kind, content hash, the contextual retrieval stamp, or `body_generation` of a segmented page); one statement adds
at most one. The highest generation is the last key of the index (`M page_generation/<generation BE8><page id BE8>`),
one reverse seek.

| Member | Result |
| --- | --- |
| `listQuestionCandidatePages(sourceId, slugs)` | `[{ id, slug, source_id, generation, revision, type, compiled_truth, updated_at, marker }]`: the live inline pages of the source with these slugs that carry no `quarantine` frontmatter key, by page id (the SQL names no order). `marker` is the pinned-question frontmatter key; `updated_at` is ISO 8601 UTC and the TypeScript member reads it as a `Date`. |
| `listQuestionEvidenceTimeline(pageIds)` | `[{ id, date, summary, detail, page_id, slug, generation, revision, hash }]`: the timeline entries of these pages that are neither soft-deleted nor quarantined, newest `date` first, then id, at most 20. `hash` is `md5(date \| summary \| detail)`; `date` is `YYYY-MM-DD` and the TypeScript member reads it as a `Date`. |
| `listQuestionEvidenceTakes(pageIds)` | `[{ id, claim, holder, weight, page_id, slug, generation, revision, hash }]`: the active, unsuperseded takes of these pages (not soft-deleted, not quarantined), newest id first, at most 20. `weight` is the `real` column read as a number; `hash` is `md5(claim \| holder \| weight::text \| resolved_outcome::text)` with `weight::text` as Postgres prints a `real` (`float4_out`) and a missing outcome as `''`. |
| `listQuestionEvidenceFacts(sourceId, entitySlugs)` | `[{ id, fact, entity_slug, valid_from, hash }]`: the facts of the source about these entities that are not expired, not superseded and still valid (`valid_until` unset or after now), whose provenance page (live or soft-deleted) is not quarantined and is not a question, synthesis or pinned-question page, and whose provenance and entity pages are not soft-deleted. Newest first by `valid_from` (`created_at` for a fact dated after now), then id, at most 30. `hash` is `md5(fact \| visibility \| entity_slug or '' \| kind)`; `valid_from` is ISO 8601 UTC and the TypeScript member reads it as a `Date`. |
| `readQuestionPageRow(sourceId, slug)` | `{ id, generation, revision, compiled_truth, body_storage, archived }` of the live page, or `null`. `compiled_truth` is `null` for a segmented page; `archived` says its frontmatter `status` is the string `archived`. |
| `readQuestionEvidenceClock(sourceId)` | `{ generation, fact_id }`: the highest page generation of the brain (every source, soft-deleted pages included, 0 for none) and the highest fact id of the source (0 for none), each one reverse seek on an index. |
| `hasNewQuestionPages(sourceId, generation, prefix)` | whether a live page of the source that is not a question, synthesis or pinned-question page, with a slug that starts with `prefix` when it is not null, has a generation above `generation`. It reads the generation index from the watermark up and stops at the first match. |
| `hasNewQuestionFacts(sourceId, factId, entitySlug)` | whether the source holds an unexpired fact with an id above `factId`, about `entitySlug` when it is not null. |
| `lockQuestionEvidenceRows(kind, ids)` | the rows a publication rereads, one `kind` (`page`, `fact`, `timeline`, `take`) at a time, by id; an id with no row has none. `page`: `{ id, generation, revision, deleted, body }` (`body` is the content hash of a segmented page and `md5(compiled_truth)` of an inline one); the others `{ id, ok, hash }` (`ok`: a fact is unexpired, unsuperseded and still valid; a take is active and unsuperseded; a timeline entry is always `true`). The SQL reads them `FOR SHARE`; the store has one writer at a time and every call is one transaction, so there is no row lock to take and the rows are only read. A timeline entry has no index by id, so a `timeline` call scans the entry keys once. |

The store keeps no `needs_rederive` rows, so the eligibility filter that excludes them never excludes a row here.

Not served yet, and refused by name before any work (`src/core/rust-engine/question-stops.ts`, owner lane 15 head 2,
due 5 PM PST Nov 29):

- `listQuestionEvidenceJoin` and `listPublishedQuestionAnswers` read the `pinned_questions` and `question_evidence`
  records, which the store does not keep. The pin store functions of src/core/questions/store.ts and the refresh's
  ledger writes refuse the same way (`refusePinStore`), so no pin can exist on this engine.
