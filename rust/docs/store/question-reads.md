# Pinned-question reads (`question_reads.rs`)

`gbrain questions` keeps standing answers to pinned questions (src/core/questions/). Its reads are typed engine members
with one SQL implementation for PGLite and Postgres (src/core/engine-sql/question-reads.ts). The Rust store serves the
three that read no `pages.generation` and no pin record, from `rust/crates/gbrain-store/src/question_reads.rs`; it keeps
no record of its own.

| Member | Result |
| --- | --- |
| `listQuestionEvidenceFacts(sourceId, entitySlugs)` | `[{ id, fact, entity_slug, valid_from, hash }]`: the facts of the source about these entities that are not expired, not superseded and still valid (`valid_until` unset or after now), whose provenance page (live or soft-deleted) is not quarantined and is not a question, synthesis or pinned-question page, and whose provenance and entity pages are not soft-deleted. Newest first by `valid_from` (`created_at` for a fact dated after now), then id, at most 30. `hash` is `md5(fact \| visibility \| entity_slug or '' \| kind)`; `valid_from` is ISO 8601 UTC and the TypeScript member reads it as a `Date`. |
| `listPrefixAnchoredPages(sourceId, prefix)` | `[{ id, slug }]`: the live pages of the source whose slug starts with `prefix` (the SQL's escaped `LIKE prefix%`), that are not question or synthesis pages and carry no `pinned_question` frontmatter key, newest first by `effective_date` (else `updated_at`), then id, at most 10. |
| `hasNewQuestionFacts(sourceId, factId, entitySlug)` | whether the source holds an unexpired fact with an id above `factId`, about `entitySlug` when it is not null. |

Not served yet, and refused by name before any work (`src/core/rust-engine/question-stops.ts`, owner lane 15 head 2,
due 5 PM PST Nov 29):

- `listQuestionCandidatePages`, `listQuestionEvidenceTimeline`, `listQuestionEvidenceTakes`, `readQuestionPageRow`,
  `readQuestionEvidenceClock`, `hasNewQuestionPages` and `lockQuestionEvidenceRows` return or compare
  `pages.generation`, the per-page counter of the SQL engines' trigger. The store keeps no such counter (it reads every
  page as generation 1, `seed.md`), so no answer would equal the SQL engines'.
- `listQuestionEvidenceJoin` and `listPublishedQuestionAnswers` read the `pinned_questions` and `question_evidence`
  records, which the store does not keep. The pin store functions of src/core/questions/store.ts and the refresh's
  ledger writes refuse the same way (`refusePinStore`), so no pin can exist on this engine.
