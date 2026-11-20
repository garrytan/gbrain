# Rust arm: where the byte-order sweep cases stop, and who lifts each stop

The eight `collate-*.test.ts` files in this directory pin some cases as "stopped on a typed refusal" on the Rust arm
(`rust-tally.tsv`). Every stop below is the same refusal: `executeRaw` needs the `raw_sql` capability, which the Rust
engine does not have. The table names the first place the case reaches it (the test's own seed, or the production
call) and the later slice that moves it to a typed member. Line numbers are as of the commit that adds this file; each
later slice that flips a case lowers the pin in `rust-tally.tsv` and removes its row here.

Slice ids are the ones of the re-cut table (C01..C22 reads, S01..S13 strict). "none" means no slice in the re-cut table
moves this site: the case stays pinned until some later change adds a typed member for it.

## collate-store-listings.test.ts (3 equal, 16 stopped)

| Case | Stops at | Owner |
|---|---|---|
| clientsReferencingSource lists clients by byte of client id | test seed `executeRaw`, test:107 | S05 (the OAuth-client listing member and the `insertOauthClient` seed; strict path) |
| feedbackStatus lists the lowest weights by byte of source and key | test seed `executeRaw`, test:116 | C13 (typed retrieval-event members) |
| feedbackStatus lists the highest weights by byte of source and key | test seed `executeRaw`, test:126 | C13 |
| getRetrievalEvent lists links by byte of source, edge key and target | `src/core/feedback/store.ts:71` `insertRetrievalEvents` | C13 |
| listPins lists pinned questions by byte of source id | `src/core/questions/store.ts:133` `insertPin` | C12 (typed pinned-question member) |
| readCandidateRecords lists candidates by byte of fingerprint | test seed `executeRaw`, test:157 | C15 (fence-repair candidate members) |
| readUncommittedFenceRepairs lists notices by byte of fingerprint | `src/core/fence-repair/uncommitted.ts:47` `recordUncommittedFenceRepair` | C15 |
| volunteerUsageStats lists arms and channels by byte | test seed `executeRaw`, test:179 | C14 (typed volunteer-event member) |
| readChronicleLedgerStats lists principals by byte | test `seedLedger` `executeRaw`, test:192 | C14 (typed chronicle-ledger members) |
| readChronicleLedgerStats lists reasons by byte | test `seedLedger` `executeRaw`, test:192 | C14 |
| derivationNeedles lists claim needles by byte | `src/core/page-body/segment-derive.ts:357` `derivationNeedles` | C16 (`normalizeDerivationClaims`) |
| readMissingTables lists missing tables by byte | test `executeRaw`, test:219 | none |
| readBudgetLimited lists held reasons by byte of source and reason | test `heldPage` seed `executeRaw`, test:75 | none |
| readBudgetLimited lists the held reasons of one source by byte | test `heldPage` seed `executeRaw`, test:75 | none |
| readBudgetLimited lists sources with equal pending chunks by byte of source id | test seed `executeRaw`, test:251 | none |
| inspectSharedMemberMigration lists installations by byte of adapter | test seed `executeRaw`, test:260 | S09 (shared-skill members; the case itself is rewritten in C16, which then needs S09 first) |

## collate-command-listings.test.ts (2 equal, 4 stopped)

| Case | Stops at | Owner |
|---|---|---|
| runReconcileLinks walks a source's markdown pages by byte slug | `src/commands/reconcile-links.ts:120` `runReconcileLinks` | C06 (`listMarkdownPageSlugs`) |
| proposeVisibility lists its unmatched pages by source id, then slug | `src/core/access/open-pages.ts:159`, the open-scope read `withOpenScope` runs for `proposeVisibility` (the query in `src/commands/repair-propose.ts:123` comes next) | none in the re-cut table: the main-branch lane that moves the open-pages reads |
| the git-gap census counts links, holds and parked effects in byte key order | test seed `executeRaw`, test:109 (then `src/commands/sources-git-gap.ts` runs raw SQL) | none |
| files verify reports its rows by byte storage path | test seed `executeRaw`, test:139 | C05 (the case is rewritten to seed through `upsertFile`) |

## collate-slug-sources.test.ts (1 equal, 5 stopped)

| Case | Stops at | Owner |
|---|---|---|
| resolvePageRef names the sources by byte, and suggests the first | `src/core/trust/refs.ts:79` `resolvePageRef` | C09 (`listLiveSlugSources`) |
| quarantine clear names the sources by byte | `src/commands/quarantine.ts:212` `runClear` | C09 |
| extract-conversation-facts --grammar names the sources by byte | `src/commands/extract-conversation-facts.ts:1667` `resolveGrammarSource` | C09 |
| the scoped get_links miss hint names the other sources by byte | test seed `executeRaw`, test:110 | C07 (`listUnarchivedSlugSources`) |
| probeTarget and resolveChainAnchors list the sources by byte | `src/core/search/explain-target.ts:215` `probeTarget` | C19 (`probeTargetRows`, `listChainAnchors`) |

## The other pinned files

| File | Case | Stops at | Owner |
|---|---|---|---|
| collate-ontology-config | the keyed config read for a handle without getConfigValues returns keys by byte | `src/core/config-values.ts:38` `readConfigRows` | none |
| collate-aggregated-lists | readExportPages lists tags by byte | test seed `executeRaw`, test:54 | C07 (the case is rewritten to read through `readExportPageRows`) |
| collate-repair-scans | orphaned-alias counts and the aliases plan list sources, then slugs, by byte | test seed `executeRaw`, test:51 | C08 (`countOrphanedAliasRows` and the other repair reads) |
| collate-repair-scans | findDuplicateFacts lists its groups by source id by byte | test `fact` helper `executeRaw`, test:44 | C08 (`listDuplicateFactRows`) |
| collate-repair-scans | classifyPagelessEntities lists sources, then entity slugs, by byte | test `fact` helper, test:44 | C08 (`listPagelessEntityFacts`) |
| collate-repair-scans | findClosedTies lists its ties by source id by byte | test `fact` helper, test:44 | C08 (`listClosedConsolidationTies`) |
| collate-schema-pack-samples | runRetypeCore samples slugs by byte | `src/core/schema-pack/retype.ts:148` `probeRule` | C09 (`listRetypeSampleSlugs`) |
| collate-schema-pack-samples | findTypeOrphans lists sources, then slugs, by byte | test seed `executeRaw`, test:60 | C07 (`listTypeOrphanPages`) |
| collate-schema-pack-samples | runPageToAliasCore samples slugs by byte | `src/core/schema-pack/page-to-alias.ts:164` | C09 (`listSourceTypePageBodies`) |
| collate-schema-pack-samples | runPageToLinkCore samples slugs by byte | `src/core/schema-pack/page-to-link.ts:141` | C09 (`listTypePageBodies`) |
| collate-facts-home | scanFactsHome lists unfenced facts by entity slug byte order | `src/core/facts/facts-home.ts:77` `scanFactsHome` | C20 (`scanUnfencedFactRows`) |

## How this was traced

Each case was run alone on the Rust arm with a temporary log of the first source and test frames of its refusal; the
owner is the later commit of the original series that adds the typed member (or rewrites the case to use it).
