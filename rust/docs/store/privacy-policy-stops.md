# The brain store: privacy policy stops (known Rust stops)

Part of the store contract in [rust/README.md](../../README.md) ("The brain store").

This is the census of the reads that stop on a Rust brain when the caller's privacy policy is wider than the
store models. Each row stands alone: it names the store member, its file and line, the caller that reaches it, and
when it stops. Line numbers are those of `rust-engine/rust-5a` at `cd8eac4d0c`. The store members are in
`src/core/rust-engine/store-members/`, and the policy functions are in `private-provenance.ts` there.

A stop is a `refuseMember` refusal: the member throws before it reads or writes anything, and names the member.
The census comes from reading the code. It was not built or run against `cd8eac4d0c`.

## How the policy judges a caller

- The plain local CLI (no `--as`) passes `excludePrivate: false`, so the store is not asked for a policy and no row
  below stops on the CLI.
- An MCP caller (`remote: true`) builds its access record from the bound credential
  (`src/core/access/caller.ts:285-308`).
- A member with `callerReaders` serves a record that carries reader identity, private-readable grants, the folder rules
  the caller satisfies, a labelled-only grant and a member's lineage read (row 32e-b-2, `callerReference` in
  `private-provenance.ts`). The page policy judges the lineage read with the owner read rule and, for a labelled-only
  caller, with the labelled-only conjunct and its origin walk; the fact policy serves a labelled-only grant (a fact is read
  on the caller's own member page only) and still stops for every member under `access.members_read_lineage` (row 32e-b-4; `search` stops there too through its saved-facts arm). The remote read floor of a labelled-only caller (`remoteReadFloorSql`, used by `search`, `list_pages` and `recall` when no source is named) is served by `storePageTextPolicy`.
  An audience of several identities for a labelled-only member stops too.
- `storePrivacyPolicy` (fact policy) stops at `private-provenance.ts:166`. `storePageTextPolicy` and `storePagePolicy`
  stop at `:271` after `judgeWidenedCaller` (`:293`).
- `storeFloorPolicy` (the remote provenance floor) stops at `:179` for a labelled-only grant or an owner read.
- `storeMemberReadPolicy` stops at `:192` when the member whose page a save lands on meets a folder rule, and at
  `:201` for any other policy it does not model. `storeOwnerReadPolicy` stops at `:219`.

## Widened-caller stops (MCP only)

On MCP each of these serves a caller with identity, grants, the folder rules it satisfies, a labelled-only grant and a
member's lineage read, where the member opts in with `callerReaders`; the fact reads in the next section stop under lineage
(row 32e-b-4). A member that does not opt in still stops for a caller with folder-rule readers, lineage or a labelled-only
grant. On the plain CLI none of them is asked for a policy.

| Store member | File:line (cd8eac4d0c) | Reached from | Stops at |
| --- | --- | --- | --- |
| `listReadableFileRows`, `listReadableFilePaths`, `readReadableFileForUrl`, `readReadableFileForVerify`, `readReadablePageId`, `countUnreadableFilesAt` | `files-ops.ts:119-146`, policy `files-ops.ts:62` | `file_list`, `file_upload`, `file_url`, `file_register`, `file_verify` (`src/core/ops/files.ts:32/177/238/272/308/318`) | `private-provenance.ts:271` |
| `listLiveChunksByIds`, `listLiveTakesByIds` | `tail-reads.ts:50/65`, policy `tail-reads.ts:41` | `find_contradictions` (`src/core/ops/insights.ts:278` through `src/core/eval-contradictions/scoped-read.ts:52/60`) | `private-provenance.ts:271` |
| `getRawData` | `raw-files.ts:39`, policy `raw-files.ts:45` | `get_raw_data` (`src/core/ops/raw-data.ts:56`). Export, migrate-engine, skill migration export and transcript ingest pass no `excludePrivate` | `private-provenance.ts:271` |
| `listContestedProposalPairs` | `facts-rest.ts:37`, policy `facts-rest.ts:39` | `recall`, `context_pack`, `delta` and the search facts arm (`src/core/facts/contested-claims.ts:32` from `src/core/ops/facts.ts:597` and `src/core/search/facts-arm.ts:327`) | `private-provenance.ts:166` |
| `listSimilarActiveFacts` | `facts-purge.ts:67`, policy `facts-purge.ts:69` | forget (`src/core/persistence/memory-mutations.ts:492` through `src/core/facts/similar-active.ts:51`). The purge path (`src/core/facts/purge.ts:447`) passes `remote: false` | `private-provenance.ts:166` |
| `countWorldFacts` | `facts-cycle.ts:75`, policy `facts-cycle.ts:81` | the entity verb (`src/core/verbs/entity-card.ts:659`; `excludePrivate` from `remote` at `:292`) | `private-provenance.ts:166` |

## Floor-policy stops (MCP only)

| Store member | File:line (cd8eac4d0c) | Reached from | Stops when |
| --- | --- | --- | --- |
| `readReplacementTarget` | `facts-remember.ts:106`, policy `facts-remember.ts:108` | a remote fact save that replaces a fact (`src/core/facts/single-prepare.ts:202`), only with `excludePrivate` | a labelled-only grant or an owner read (`private-provenance.ts:179`) |
| `readClaimWithdrawal` | `facts-remember.ts:120`, policy `facts-remember.ts:121` | a remote save that meets a withdrawal (`src/core/facts/single-prepare.ts:102`), only with `excludePrivate` | a labelled-only grant or an owner read (`private-provenance.ts:179`) |
| `findActiveSingleFact` | `facts-purge.ts:75`, policy `facts-purge.ts:76` | a remote fact save with no page slug (`src/core/facts/single-prepare.ts:141-142`) | a labelled-only grant or an owner read (`private-provenance.ts:179`) |
| `readLiveFactEntityPage` | `facts-rest.ts:31`, policy `facts-rest.ts:33` (remote read floor, no `callerReaders`) | subject inference for a remote save (`src/core/facts/subject-infer.ts:254`) | a labelled-only grant only; the floor reads no other identity (`private-provenance.ts:271`) |
| `readMemberPageWithdrawal` | `facts-remember.ts:114`, policy `facts-remember.ts:115` | a remote save onto a member page (`src/core/facts/single-prepare.ts:64` and `:92`) | the page's member (not the caller) meets a folder rule (`private-provenance.ts:192`), or an owner read the store does not model (`:201`, `:219`) |

## Managed clone stop

| Step | File | Reached from | Stops when | Owner |
| --- | --- | --- | --- | --- |
| `managed_source_clone` | `src/core/persistence/topology-stop.ts` (`requireTopologyRawSql`), the first statement of `runManagedSourceClone` in `src/core/persistence/topology-clone.ts` | `gbrain sources add --url` and `sources reclone` (guarded first at `src/core/persistence/source-lifecycle.ts:155`, then `topology-clone.ts:43`) | always on a Rust brain: the clone needs `raw_sql`. The refusal names the step and reports `written=nothing` | lane 7 |

## Served, not stops

- `readHeldRowVisibility` (`facts-held.ts:42`, policy `facts-held.ts:43`, no `callerReaders`): reached from held fact
  moves (`src/core/facts/held-fact-move.ts:178`), which sync, access rules, the extract-facts cycle and facts
  maintenance run with no caller record. The no-caller policy is served. No MCP operation reaches it directly.
- `listDreamAtomPages` (`dream-cycle.ts:107`, policy `dream-cycle.ts:22-27`): `ownerOnlyFormIn` only classifies the
  owner-only form and never refuses. Reached from `src/core/cycle/synthesize-concepts.ts:181` with no caller record.

## Open question

- Held moves through sync: it is not verified whether a remote write that starts a sync can reach the held fact moves
  (`readHeldRowVisibility`) with an MCP caller record. If it can, that row becomes a widened-caller stop.
