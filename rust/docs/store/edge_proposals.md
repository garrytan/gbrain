# Edge-contradiction proposals and candidates (`edge_proposals.rs`)

The edge-contradiction dream phase (`src/core/cycle/edge-contradictions.ts`) finds a subject with two live relationships
of one type, asks a judge whether both can hold, and records the answer as a proposal. The twelve members are typed
engine members with one SQL implementation for PGLite and Postgres (`src/core/engine-sql/contradictions-cycle.ts`). The
Rust store serves them from `rust/crates/gbrain-store/src/edge_proposals.rs`; the TypeScript bridge is
`src/core/rust-engine/store-members/edge-proposals.ts`.

| Member | Result |
| --- | --- |
| `listEdgeContradictionCandidates({ today, maxSubjects, pendingCutoff, personFilter })` | the live state relationships of the subjects with two or more targets of one link type, newest groups first, at most `maxSubjects` groups |
| `listKnownEdgeProposals(fromPageId, linkType, hashes)` | `[{ a, b, status, detail, recent }]` for the subject's proposals with one of the evidence hashes; `recent` is an update in the last 24 hours |
| `recordEdgeProposal(input)` | the new id; the existing id when the stored row for the same evidence has status `error` (the row takes the new values); null otherwise |
| `readEdgeProposal(id)` | the proposal with the subject and ending slugs, or null |
| `readEdgeProposalEvidence(id)` | `{ a, b }`: the current evidence hashes of the two relationships, or null when either is gone |
| `readEdgeProposalHash(id)` | `{ evidence_hash }` or null |
| `edgeClosureLanded(from, endingTo, linkType, closeDate)` | true when a `dream` `end` transition of that relationship has that date |
| `markEdgeProposalStale`, `setEdgeProposalStatus`, `markEdgeProposalUndone` | the status change |
| `rejectOpenEdgeProposal(id)` | true when an open proposal (`proposed`, `undated_unresolved`, `ambiguous_same_date`) became `rejected` |
| `markRevertedEdgeProposals()` | the count of applied proposals updated before now whose closure transition is gone; each becomes `reverted_by_user` |

## Records

- `Q 0x04 id -> proposal`: one proposal, the id as 8 big-endian bytes.
- `Q 0x05 from a b link_type \0 evidence_hash -> id`: the five-part unique key. `Q 0x05 from` is the prefix of one
  subject's proposals.
- The ids come from the `link_edge_proposal_id` counter. Each record draws one, also when the evidence is already
  stored, as `DEFAULT nextval` does for `INSERT ... ON CONFLICT`.
- The relationship (`R`) and transition (`T`) records belong to `link_temporal.rs`. This module reads them and writes
  none.
- A hard page delete removes each proposal whose subject or one of whose two targets is the page, and clears the
  ending page of the others (the foreign keys of the table: `ON DELETE CASCADE`, `ON DELETE SET NULL`).

## Candidate rules

- A row is a relationship with scope `all` and semantics `state` whose valid ranges contain `today`, from a live page
  to a live page.
- A `works_at` row needs a person-like subject (the first `personFilter.per_source` arm for the subject's source, or
  `personFilter.types`) and an employer target: a target that is not person-like and not one of the non-employer
  types. An untyped target is tested by its slug directory.
- With `pendingCutoff`, a row whose subject's links were extracted before the cutoff, or never, is left out.
- Groups sort by their newest `refreshed_at`, newest first; the rows sort by subject, link type, last start (null
  first) and target slug.

## Refusals

- An unknown status: `CONSTRAINT_VIOLATION`, the `link_edge_proposals_status_check` text. A status change on a missing
  row, or on a row the statement's guard does not admit, changes nothing and refuses nothing.
- A page id that names no page: `CONSTRAINT_VIOLATION`, the `link_edge_proposals_<column>_fkey` text.
- A close date that is not a date: `INVALID_ARGUMENT`, `invalid input syntax for type date`.
- A `maxSubjects` that is not a whole number or is negative: `INVALID_ARGUMENT`, the Postgres text.

## Known differences

- Text order is byte order. A Postgres database with an `en_US` collation can order mixed-case or punctuated slugs
  another way; PGLite agrees with the store.
- Groups that tie on their newest `refreshed_at` are cut by `maxSubjects` in `(source_id, from_page_id, link_type)`
  order. Postgres names no order for such ties.
- A record refused for an unknown status draws no id on the store; Postgres draws one before the check fails.
- `readLastContradictionsPromptVersion` belongs to the same capability and is served (`contradictions.md`), so the
  store reports `contradictions`.
