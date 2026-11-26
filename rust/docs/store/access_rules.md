# The brain store: folder access rules

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

Folder rules keep whole folders of a source to named members (`src/core/access/folder-rules.ts`, `policy.ts`). On
PGLite and Postgres the applied rulebook is four tables from schema migration v283: `access_policy_state` (one row per
source with a rulebook), `access_rules`, `access_policy_revisions` and `access_pending_coverage`. The store keeps the
same state under key tag `z` (`crates/gbrain-store/src/access_rules.rs`). The byte after the tag names the table;
these additive records need no format bump of their own; this build writes store format 13 and opens formats 1-8 and 13 ([format.md](format.md)).

| Key | Value | Table |
| --- | --- | --- |
| `z 0x01 <source>` | `{}` | `access_policy_state` |
| `z 0x02 <source> \0 <rule_id>` | `{ source_id, rule_id, prefix, readable_by, revision, covers_derived }` | `access_rules` |
| `z 0x03 <source> \0 <prefix> \0 <reason>` | `{ source_id, prefix, reason, revision }` | `access_pending_coverage` |
| `z 0x04 <source> \0 <revision u64 BE>` | `{ source_id, revision, applied, rules, digest, change_kind, origin, operation_id, proposed_by, approved_by, created_at_us, applied_at_us, approved_at_us }` | `access_policy_revisions` |
| `z 0x05 <source> \0 <page id u64 BE>` | the sorted rule ids the last restamp gave the page | `pages.folder_rule_ids` |
| `z 0x06 <source> \0 <id>` | `{ id, source_id, direction, phase, receipts, created_at_us, created_seq, updated_at_us }` | `access_policy_migrations` |

The writes mirror the v283 and v303 checks: a rule id matches `^[a-z0-9][a-z0-9._-]{0,63}$`, a prefix is a folder
(segments that each end in `/`) or one page (the same segments without the final `/`), at most 512 bytes with no `..`,
a pending prefix is `''` or such a prefix with reason `pending` or `invalid`, and a revision is positive. A folder
prefix covers every slug under it; a page prefix covers only the slug it names. A rule, a pending prefix or a revision
needs its source's policy state (the foreign key). Rule ids, revision numbers and operation ids are unique as the
primary keys and the unique index make them.

On PGLite and Postgres a source delete cascades to all six tables (`ON DELETE CASCADE` from `sources`). The store has
no source delete: `deleteSourceRow` (`src/core/source-delete.ts`, used by `gbrain sources remove`, the archive purge
and the persistence source lifecycle) runs `executeRaw`, which this engine refuses with `engine_capability_missing`
(`raw_sql`) before any work, so the source and its `z` records stay together. A store source delete must also remove
every `z 0x01`–`z 0x06` record of the source (`source_prefix(sub, source_id)`).

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.readFolderAccess(readers)` | `{ rules, coverage }`: each rule whose `readable_by` names any of `readers` (`{ source_id, rule_id, readable_by }`, by source and id; none when `readers` is empty) and each distinct pending prefix (`{ source_id, prefix }`, by source and prefix) | `readFolderAccess` (`FOLDER_RULES_FOR_READERS_SQL`, `FOLDER_COVERAGE_SQL`) |
| `brain.listAppliedPolicyRevisions()` | `{ source_id, rev }` for each source with policy state, by source id; `rev` is its newest applied revision, `null` when none is applied | `listAppliedPolicyRevisions` |
| `brain.isFolderRestricted(sourceId, slug)` | `true` when a rule or pending prefix of the source covers the slug: a folder prefix ending in `/` matches descendants, a page prefix matches only that exact slug, and an empty pending prefix (`''`) covers every slug | `isFolderRestricted` |
| `brain.putAccessPolicyState(sourceId)` | records policy state; a second put changes nothing | fixture (`INSERT ... ON CONFLICT DO NOTHING`) |
| `brain.putAccessRule(rule)` | stores the rule, replacing the same source and id; `covers_derived` defaults to `true` | fixture |
| `brain.putAccessPendingCoverage(row)` | stores the prefix; the first row for one source, prefix and reason stays | fixture |
| `brain.putAccessPolicyRevision(row)` | stores the revision, replacing the same number | fixture |

## Policy writes

`src/core/access/policy.ts` (`proposeRevision`, `applyApproved`, `restampSource`, `policyStatus`,
`markPolicyInvalid`) runs eighteen typed BrainEngine members (`src/core/engine-sql/access-policy.ts` on PGLite and
Postgres, `crates/gbrain-store/src/access_policy.rs` here, `src/core/rust-engine/store-members/access-policy.ts`).
Each write member is one `Store::write`, so a refused change writes nothing and `FlaggingWriter` still sets the
member-access flag. `engine.transaction` opens the store write transaction, which holds the writer gate until it ends:
that is the row lock `lockSource` (`lockAccessPolicy`) takes on the SQL engines, so two rule changes run one after the
other and the second sees the first's revision. A second write of one revision number refuses
`constraint_violation`, and the transaction rolls back every rule it wrote.

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.readAccessStoreConfig(sourceId)` / `writeAccessStoreConfig(sourceId, store)` | `{ store }` (null when unset), or null for a missing source / sets `config.access_store` | `ACCESS_STORE_SQL`, `WRITE_ACCESS_STORE_SQL` |
| `brain.ensureAccessPolicyState(sourceId)` / `hasAccessPolicyState(sourceId)` | records policy state (a missing source refuses) / whether it exists | `ENSURE_POLICY_STATE_SQL`, `POLICY_STATE_COUNT_SQL` |
| `brain.lockAccessPolicy(sourceId)` | nothing; holds the writer gate for one statement, or for the transaction | `LOCK_SOURCE_SQL`, `LOCK_POLICY_STATE_SQL` |
| `brain.listAccessRules(sourceId)` / `listAccessCoverage(sourceId)` | the rules by id / the pending and invalid prefixes by reason and prefix | `APPLIED_RULES_SQL`, `COVERAGE_ROWS_SQL` |
| `brain.readAccessPolicyRevisions(query)` | revision rows (`latest`, one `revision`, `recent` with a limit, or by `operation`), newest first, times as text | `LATEST_REVISION_SQL`, `REVISION_SQL`, `RECENT_REVISIONS_SQL`, `OPERATION_REVISION_SQL` |
| `brain.readAccessStateUnreadable()` | `false`: no row-level security | `STATE_UNREADABLE_SQL` |
| `brain.applyAccessRuleChanges(sourceId, changes)` | deletes `remove`, inserts `insert` (an existing id refuses), upserts `pending`, in one write | `DELETE_RULE_SQL`, `INSERT_RULE_SQL`, `UPSERT_PENDING_SQL` |
| `brain.restampAccessWindow(sourceId, after, batch)` | `{ last, scanned, changed }` for the next `batch` pages by id, deleted pages included; writes the `0x05` stamps | `RESTAMP_WINDOW_SQL` |
| `brain.finishAccessRestamp(sourceId)` | the pages restamped; then drops the pending prefixes and marks every revision applied | `RESTAMP_ALL_SQL`, `DELETE_PENDING_SQL`, `MARK_APPLIED_SQL` |
| `brain.countAccessFolderDrift(sourceId)` | the pages of the source (a soft-deleted one too) whose kept rule ids differ from the folder rules that cover them now; a read, the count a restamp would change | `COUNT(*) ... folder_rule_ids IS DISTINCT FROM gbrain_access_folder_rules(source_id, slug)` (the `access_policy_pending` doctor check) |
| `brain.insertAccessPolicyRevision(row)` | records a revision (a revision number the source has, or an operation id any source has, refuses) | `INSERT_REVISION_SQL` |
| `brain.markAccessRevisionsApplied(sourceId, upTo?)` / `approveAccessPolicyRevision(sourceId, revision, actor)` | marks unapplied revisions applied (up to `upTo`) / records the approver, now | `MARK_APPLIED_SQL`, `MARK_APPLIED_UP_TO_SQL`, `APPROVE_REVISION_SQL` |
| `brain.listAccessPrefixSlugs(sourceId, prefixes)` | the live slugs that start with any prefix, by slug | `PREFIX_SLUGS_SQL`, `PREFIXES_SLUGS_SQL` |
| `brain.readAccessPolicyMarks(sourceId, operationId?)` | `{ applied, approved, operation? }` | `POLICY_MARKS_SQL`, `OPERATION_MARKS_SQL` |
| `brain.replaceAccessInvalidCoverage(sourceId, prefixes, detail)` | replaces the invalid prefixes; an empty list clears them | `DELETE_INVALID_SQL`, `INSERT_INVALID_SQL` |

The store stamps a page when it is written, as the trigger `pages_access_stamp_folder_rules` does: a page record put
under a key that held no record of the same page (an insert, a rename or a move) takes the `0x05` rule ids that cover
it now when its source has access state, and none otherwise, in the same write (`FlaggingWriter`,
`access_policy::stamp_page_put`). A put over the same page keeps its ids, as an UPDATE that names no slug, source or
stamp column does. So `pages_restamped` counts the same pages as on PGLite and Postgres. What a caller can read
depends on the stamps only for an id whose rule was removed and not yet restamped (below): otherwise the store judges
each read against the rules it holds.

The store has no row-level security, so `readFolderAccess` never returns the `'!unreadable'` row and the unreadable
part of `isFolderRestricted` is always false.

## The member-access flag

v283's triggers `access_rules_mark_restricted` and `access_pending_coverage_mark_restricted` set config
`access.restrictions_present` to `'1'` on the first rule or pending prefix. The store's `FlaggingWriter` does the same on
every put of a `z 0x02` or `z 0x03` key, whatever code path made it ([access-flag.md](access-flag.md)).

## Page reads

The store's privacy filter (`crates/gbrain-store/src/facts/privacy.rs`) applies these records to the pages a served
caller reads:

- a page whose slug is under a rule of its source is stamped (`pages.folder_rule_ids IS NOT NULL`). The policy carries
  the caller's satisfied rule ids (`satisfiedRuleIds`, `source:rule_id`) and its record's coverage (`folderCoverage`).
  A stamped page passes the full form only when the caller satisfies every rule that covers it and no coverage entry
  covers it; the unrestricted short form passes no stamped page. The satisfied rules count only for the caller's own
  identity, never for the empty identity that judges a provenance page;
- a page under a pending prefix is hidden in the full form, as the coverage conjuncts of `folderRulesAllowedSql` hide
  it;
- as a fact's origin or a derivative's input, a rule stored with `covers_derived: false` does not count
  (`gbrain_access_lineage_rules`, v305); a rule that covers derived pages, or a pending prefix, closes the origin.

One difference remains: PGLite stamps `folder_rule_ids` when a page is written and changes it only on a restamp, and
the store judges a page against the rules it holds when the read runs. The two agree after `restampSource`, which is
the state a finished policy change leaves.

The one window where that difference could open a page is a rule removed before its restamp: SQL keeps the deleted id
in `folder_rule_ids`, which no caller satisfies, so the page stays hidden until the restamp. The store closes it the
same way. `facts::privacy::stamped_rules`, the one helper every privacy read takes its folder rules from (the readers
and folder test, the short open form, the origin tests and the owner read rule), also returns a retired rule for each
id in the page's kept `0x05` record that is no longer a live rule of its source (`access_policy::retired_rules`): no
readers, so nobody satisfies it, and `covers_derived` true, so the origin tests close too, as `gbrain_access_lineage_rules`
keeps a stamped id whose rule is gone ("fail closed"). A page with no `0x05` record keeps the live rules alone, and a
retired rule only ever hides a page, never shows one
(`a_page_stamped_with_a_removed_rule_stays_hidden_until_the_restamp`; parity case in `access-policy.test.ts`).

The folder test reads the store's rules and pending prefixes, and the policy's `satisfiedRuleIds` and `folderCoverage`
(both default to empty). `member_access_allows` ANDs it with the owner-only test (`owner_only`, absent means `closed`).
So a policy with every defaulted field missing still hides a folder-restricted page, and no
owner-only form reopens one (`a_policy_missing_its_defaulted_fields_still_hides_a_folder_restricted_page`).

Inside a caller record (`callerRecord: true`, the canonical caller-readers rendering), Postgres renders the record's
coverage and no live pending conjunct, so a record that names no pending prefix reads a page under one by the ids
its last stamp kept. The store does the same: in that rendering the record's `folderCoverage` replaces the live
pending test, and a page under a live pending prefix is judged by its kept ids (sub-tag `0x05`), not the rules
installed since. The record's coverage applies whatever identity is judged; its satisfied rules only for its own
identity. Outside a caller record, and for every fact and origin test, the store reads the pending prefixes live.

## Setup and policy-store members

`src/commands/access-serves.ts` (`gbrain access serves` and `sources unfederate`), `src/core/access/policy-migrate.ts`
(the policy-store move), `src/core/access/policy-transfer.ts` (export) and `src/core/access/serves.ts` run fourteen
typed BrainEngine members (`src/core/engine-sql/access-setup.ts` on PGLite and Postgres,
`src/core/rust-engine/store-members/access-setup.ts` here). The token members read and write the store's
`access_tokens` and `oauth_clients` ([access-tokens.md](access-tokens.md), [oauth-clients.md](oauth-clients.md)). No
store member binds a token to a member yet (the binding write refuses, [access-members.md](access-members.md)), so
every live token is unbound and no key reads a source; a client registered with a `member_id` is bound. The policy-store migration journal is
`crates/gbrain-store/src/access_migrations.rs`; each write is one `Store::write`.

| JS member | Rust answers | Mirrors |
| --- | --- | --- |
| `listUnboundTokenNames()` / `listUnboundClientIds()` | the distinct names of the live tokens, and the ids of the live clients, bound to no member, in byte order (`brain.listUnboundTokenNames`, `brain.listUnboundClientIds`) | `UNBOUND_TOKEN_NAMES_SQL`, `UNBOUND_CLIENT_IDS_SQL` |
| `readLiveAccessToken(name)` / `listKeysReadingSource(sourceId)` | the live token's `{ member_id, token_hash, source_grant, source_id, federated_read, permissions }` or `null` (`brain.readLiveAccessToken`); the live member-bound federated keys reading the source, by name in byte order (`brain.listKeysReadingSource`) | `LIVE_TOKEN_SQL`, `KEYS_READING_SOURCE_SQL` |
| `recordTokenSetupReads(name, reads)` / `revokeAccessTokenById(id)` | sets `setup_reads` in the live token's permissions object (`brain.recordTokenSetupReads`); revokes the live token with the id (`brain.revokeAccessToken`) | `RECORD_SETUP_READS_SQL`, `REVOKE_TOKEN_SQL` |
| `listUnarchivedSourceIds(ids)` | the ids of `ids` that name a source that is not archived (`listAllSources`) | `UNARCHIVED_SOURCE_IDS_SQL` |
| `listUnboundTokenNames()` / `listUnboundClientIds()` | `[]` | `UNBOUND_TOKEN_NAMES_SQL`, `UNBOUND_CLIENT_IDS_SQL` |
| `filterUnarchivedSourceIds(ids)` | the ids of `ids` that name a source that is not archived (`listAllSources`) | `UNARCHIVED_SOURCE_IDS_SQL` |
| `countCompanyPages(sourceId)` | `{ pages, calls }`: the live pages of the source and those under `company/calls/` (`listAccessPrefixSlugs`) | `COMPANY_PAGE_COUNTS_SQL` |
| `listAccessPolicySources()` | every source with access state, archived ones too, by id in code-unit order | `POLICY_STATE_SOURCES_SQL` |
| `countOpenPages(sources, exclude)` | `{ source, folder, type, visible, pages }` for each group of live pages the empty-identity member-access policy admits in `sources`, less each excluded prefix; `visible` is whether the page policy admits the page too; no set order (`listAccessPrefixSlugs`, then `readLivePageTypes` under each policy); inside a caller record the floor must equal a fresh record's rendering for the empty identity with the caller's folder coverage, which the store judges together with its live pending prefixes (`openPageSql` adds them), and the page policy is judged for that empty identity; any other rendering refuses | `openPagesStatement` |
| `countPeopleFolderPages()` | `{ source_id, folder, pages }` for each `people/<folder>/` holding live pages, by source then folder in code-unit order | `PEOPLE_FOLDER_PAGES_SQL` |
| `brain.readUnfinishedAccessMigration(sourceId)` | `{ id, phase, direction, receipts }` of the newest migration of the source that has not switched, or null | `UNFINISHED_MIGRATION_SQL` |
| `brain.insertAccessMigration(id, sourceId, direction)` | starts a migration at `started` with `{}` receipts; a source with no access state, a direction other than `to_git` or `to_database`, or a used id refuses | `INSERT_MIGRATION_SQL` |
| `brain.recordAccessMigrationPhase(id, phase, receipts)` | sets the phase and receipts (`switchAccessMigration` sends `switched`); a missing id changes nothing, a phase the table does not allow refuses | `RECORD_MIGRATION_PHASE_SQL`, `SWITCH_MIGRATION_SQL` |

A migration is a `z 0x06 <source> \0 <id>` record `{ id, source_id, direction, phase, receipts, created_at_us,
created_seq, updated_at_us }`; `created_seq` orders two migrations made in one microsecond. The SQL sorts every text
key of these members, and of the rule, pending-prefix, prefix-slug and applied-revision reads, with `COLLATE "C"`, so
a Postgres server whose collation is not `C` gives the byte order PGLite and the store give
(`test/engine-parity/access-sort-order.test.ts`).

## Tests

- `crates/gbrain-store/src/access_rules.rs` (unit tests): reads in key order, the flag on a rule or pending put, the
  newest applied revision per source, folder restriction and stamping, and the writes the v283 checks refuse.
- `crates/gbrain-store/src/facts/privacy.rs` (unit tests): a folder rule and a pending prefix hide pages from a
  caller that satisfies no rule; a raw-only rule does not close an origin; a reader a rule names is served the folder
  unless its record covers the prefix or the prefix is invalid, and only for its own identity; a caller record that
  names no pending prefix reads a page under one.
- `test/engine-parity/write-misc.test.ts` and `test/engine-parity/import-path.test.ts`: `readFolderAccess`,
  `folderAccessForAll`, `appliedAccessSummary`, `isFolderRestricted` and `listAppliedPolicyRevisions` on every arm, and
  a private folder that refuses a caller its rule does not name (no rule satisfied, the folder's page hidden from
  `findPagesByTitles`). The `restrictFolder` and `seedAccessPolicy` fixtures (`test/engine-parity/harness.ts`) write
  the state.
- `crates/gbrain-store/src/access_policy.rs` (unit tests): a revision number or operation id refuses a second write,
  a refused rule change leaves no rule, the restamp counts drifted pages, a page written or renamed under a rule is
  stamped in its write, page prefixes cover one page, and invalid coverage is replaced and cleared.
- `test/engine-parity/access-policy.test.ts`: on every arm, a rule added through `policy.ts` hides the folder, a
  removal waits for approval and then shows it, the pending prefix between install and restamp, the revision count, a
  rule change refused part way, two concurrent rule changes that cannot both apply against one revision, a page
  written or renamed under an applied rule that a later restamp does not count, and a reader a rule names that
  `findPagesByTitles` serves the folder, except while its prefix is pending; and a caller record with no folder
  coverage, read while a prefix is pending, that `findPagesByTitles` and `getRecentSalience` serve as Postgres does.
  The salience, salience-score and anomaly reads serve a rule-named reader the folder (not while pending); the write
  visibility probe says an identity could open a page only a folder rule hides; a world fact held by a page under a
  rule counts as a world fact from a private page and stays out of the consolidate buckets; and the fact cache
  watermark moves when a rule or a pending prefix changes.
- `crates/gbrain-store/src/access_migrations.rs` (unit tests): the unfinished migration is the newest that has not
  switched, and a migration write the table refuses (a source with no access state, a direction or phase it does not
  allow, a used id) writes nothing; an id one source used is refused for another; a switch keeps its receipts and stamps
  an update time after the creation time; and the newest is by creation time when ids are in reverse key order.
- `test/engine-parity/access-migrate.test.ts`: on every arm, the whole `gbrain access rule migrate` flow: `--to database`
  from no store, `--to git` with its files and commits, a resume after a stop, the refusal of the other way, and `resume`
  in the preview.
- `test/engine-parity/access-setup.test.ts`: on every arm, a brain with no access tokens has nothing unbound, no live
  key and no key reading a source, the unarchived source ids, the company and people-folder page counts, the sources
  with access state, and a policy-store migration from its start until it switches.
  `test/engine-sql-caller-raw-sql-pins.test.ts` pins each Postgres statement to the text its caller ran.
