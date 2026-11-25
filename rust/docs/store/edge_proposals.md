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

## The `gbrain edge-proposals` command

`src/commands/edge-proposals.ts` lists, shows, clears, undoes and dates proposals through six more members of the same
SQL file. The store serves them from `edge_proposals/cli.rs`.

| Member | Result |
| --- | --- |
| `listEdgeProposalCliRows(filter, limit)` | the proposals `filter` admits (`all`, `statuses`, one `id`, or one `undated` id), newest `created_at` first and then the larger id, at most `limit`; each with the subject, target and ending slugs; a proposal whose subject or target page is gone is left out |
| `deleteHeldEdgeProposalErrors()` | deletes the `error` proposals whose detail starts with `held after `; `[{ id }]` in id order |
| `listAppliedEdgeProposalIds()` | `[{ id }]` of the `applied` proposals in id order |
| `deleteEdgeProposalError(id)` | deletes the proposal while it is an `error` row; `[{ id }]`, `[]` when it is not one |
| `readEdgeProposalSourceId(id)` | the proposal's source, or null |
| `markEdgeProposalDated(id)` | the proposal becomes `rejected` with the detail `dated by user` |

A deleted proposal takes its evidence key with it, so the next dream cycle can record the same evidence again.

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
- A `listEdgeProposalCliRows` limit that is not a whole number from 1 to 1000: `INVALID_ARGUMENT`. The SQL member
  refuses the same limits before it runs (the command clamps its `--limit` to that range).

## Known differences

- Text order is byte order. A Postgres database with an `en_US` collation can order mixed-case or punctuated slugs
  another way; PGLite agrees with the store.
- Groups that tie on their newest `refreshed_at` are cut by `maxSubjects` in `(source_id, from_page_id, link_type)`
  order. Postgres names no order for such ties.
- A record refused for an unknown status draws no id on the store; Postgres draws one before the check fails.
- `readLastContradictionsPromptVersion` belongs to the same capability and is served (`contradictions.md`), so the
  store reports `contradictions`.
- `confidence` is a `REAL`. `listEdgeProposalCliRows` answers it as the shortest decimal that reads back as the stored
  single-precision value (0.9, not 0.8999999761581421), as PGLite and Postgres print a `REAL`.
- `gbrain edge-proposals date` writes its timeline line through the `add_timeline_entry` operation. On a Rust brain that
  write queues: its preparation reads the source kind through `executeRaw`
  (`src/core/persistence/semantic-pages.ts:83`). The command's own members are served; the parity case pins that stop
  by name. The getSource hunk on that line serves the read: babe38bded (`rust-engine/admin-unowned-rust`) and
  65b3f8a992 (`rust-engine/timeline-add-rust`) carry it byte-identical. With that hunk, the write stops next in
  `guardFenceRows` (`src/core/trust/fence-guard.ts:71`), which the pin also names. Whichever change lands second
  removes the pin.
