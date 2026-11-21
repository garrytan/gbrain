# The brain store: folder access rules

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

Folder rules keep whole folders of a source to named members (`src/core/access/folder-rules.ts`, `policy.ts`). On
PGLite and Postgres the applied rulebook is four tables from schema migration v283: `access_policy_state` (one row per
source with a rulebook), `access_rules`, `access_policy_revisions` and `access_pending_coverage`. The store keeps the
same state under key tag `z` (`crates/gbrain-store/src/access_rules.rs`). The byte after the tag names the table;
`FORMAT_VERSION` stays 1.

| Key | Value | Table |
| --- | --- | --- |
| `z 0x01 <source>` | `{}` | `access_policy_state` |
| `z 0x02 <source> \0 <rule_id>` | `{ source_id, rule_id, prefix, readable_by, revision, covers_derived }` | `access_rules` |
| `z 0x03 <source> \0 <prefix> \0 <reason>` | `{ source_id, prefix, reason, revision }` | `access_pending_coverage` |
| `z 0x04 <source> \0 <revision u64 BE>` | `{ source_id, revision, applied, rules, digest, change_kind, origin, operation_id, proposed_by, approved_by, created_at_us, applied_at_us, approved_at_us }` | `access_policy_revisions` |
| `z 0x05 <source> \0 <page id u64 BE>` | the sorted rule ids the last restamp gave the page | `pages.folder_rule_ids` |
| `z 0x06 <source> \0 <id>` | reserved for `access_policy_migrations`; nothing writes it yet (row 32h) | `access_policy_migrations` |

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
| `brain.isFolderRestricted(sourceId, slug)` | `true` when a rule of the source has a prefix the slug starts with, or a pending prefix of the source covers it (`''` covers every slug) | `isFolderRestricted` |

## Policy writes

`src/core/access/policy.ts` (`proposeRevision`, `applyApproved`, `restampSource`, `policyStatus`,
`markPolicyInvalid`) runs seventeen typed BrainEngine members (`src/core/engine-sql/access-policy.ts` on PGLite and
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
| `brain.insertAccessPolicyRevision(row)` | records a revision (a revision number the source has, or an operation id any source has, refuses) | `INSERT_REVISION_SQL` |
| `brain.markAccessRevisionsApplied(sourceId, upTo?)` / `approveAccessPolicyRevision(sourceId, revision, actor)` | marks unapplied revisions applied (up to `upTo`) / records the approver, now | `MARK_APPLIED_SQL`, `MARK_APPLIED_UP_TO_SQL`, `APPROVE_REVISION_SQL` |
| `brain.listAccessPrefixSlugs(sourceId, prefixes)` | the live slugs that start with any prefix, by slug | `PREFIX_SLUGS_SQL`, `PREFIXES_SLUGS_SQL` |
| `brain.readAccessPolicyMarks(sourceId, operationId?)` | `{ applied, approved, operation? }` | `POLICY_MARKS_SQL`, `OPERATION_MARKS_SQL` |
| `brain.replaceAccessInvalidCoverage(sourceId, prefixes, detail)` | replaces the invalid prefixes; an empty list clears them | `DELETE_INVALID_SQL`, `INSERT_INVALID_SQL` |

The store stamps a page when it is written, as the trigger `pages_access_stamp_folder_rules` does: a page record put
under a key that held no record of the same page (an insert, a rename or a move) takes the `0x05` rule ids that cover
it now when its source has access state, and none otherwise, in the same write (`FlaggingWriter`,
`access_policy::stamp_page_put`). A put over the same page keeps its ids, as an UPDATE that names no slug, source or
stamp column does. So `pages_restamped` counts the same pages as on PGLite and Postgres. What a caller can read does
not depend on the stamps: the store judges each read against the rules it holds.

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

## Rule add preview

`gbrain access rule add` previews what a change covers before it writes (`src/commands/access-rules.ts`). Three typed
members answer it: `countRuleCoveredPages(sourceId, prefixes)` (the live pages one prefix, or any of several, covers),
`listRuleCoveredSlugs(sourceId, prefixes)` and `listRuleCoveredPages(sourceId, prefix)` (the first 1,000 covered pages,
by slug, for the open-twin check). On PGLite and Postgres they run `RULE_COVERED_*_SQL`
(`src/core/engine-sql/access-policy.ts`); here they read `listAccessPrefixSlugs` and keep the slugs a prefix covers
(`ruleCovers`: a folder prefix covers every slug under it, a page prefix only its own slug, `''` every slug).

The preview also lists the open twins (`src/core/access/open-twins.ts`): live pages in other sources that share a slug
with a page the change covers and that a caller outside the change still reads. On PGLite and Postgres
`listOpenTwinRows` runs `openTwinsStatement` (`src/core/engine-sql/access-policy.ts`); here
`brain.listOpenTwinRows(pages, outside, honorAliases, listed)` judges each candidate page by its own labels
(`twin_snapshot_allows`), its readers and its stamped rules and pending prefixes (`twin_open_to` in
`crates/gbrain-store/src/facts/privacy.rs`), for the empty identity and each outside caller, by source then slug in byte
order. The member refuses inside a caller record, where the SQL reads the record's coverage. It also runs the held-fact
move plan ([facts.md](facts.md), `held_moves.rs`).

The SQL sorts the rule list, the pending prefixes and the prefix slugs with `COLLATE "C"`, so a Postgres server whose
collation is not `C` gives the byte order PGLite and the store give. `listRuleCoveredPages` sorts by `slug` with the
database collation, as the command did before; on such a server its order can differ from the store's byte order.

## Not served yet

- Moving a source's rules between the database and git (`src/core/access/policy-migrate.ts`, `gbrain access rule migrate`)
  runs `executeRaw`, so it stops on the `raw_sql` refusal before any work (row 32h). `previewMigrate` reads no
  migration row on this engine, because none can exist.

## Tests

- `crates/gbrain-store/src/access_rules.rs` (unit tests): reads in key order, the flag on a rule or pending put, the
  newest applied revision per source, folder restriction and stamping, the writes the v283 checks refuse, and the
  folder access digest the fact cache watermark reads.
- `crates/gbrain-store/src/access_policy.rs` (unit tests): a revision number or operation id refuses a second write,
  a refused rule change leaves no rule, the restamp counts drifted pages, a page written or renamed under a rule is
  stamped in its write, page prefixes cover one page, and invalid coverage is replaced and cleared.
- `crates/gbrain-store/src/facts/privacy.rs` (unit tests): a folder rule and a pending prefix hide pages from a
  caller that satisfies no rule; a raw-only rule does not close an origin; a reader a rule names is served the folder
  unless its record covers the prefix or the prefix is invalid, and only for its own identity; a policy missing its
  defaulted fields still hides a folder-restricted page.
- `test/engine-parity/access-rules.test.ts`: on every arm, a member outside a folder rule reads none of the pages
  under it and the member it names reads them; a widening is held until it is applied; the folder reads, invalid
  marks and resume; a page written under an applied rule is stamped; the rule add preview counts; and the fact cache
  watermark moves with a rule. It also pins the policy-store migration refusal (row 32h).
- `test/engine-parity/write-misc.test.ts`: `readFolderAccess`, `isFolderRestricted` and `listAppliedPolicyRevisions`
  on every arm, through `restrictFolder` (`test/engine-parity/harness.ts`, the typed policy members) and
  `proposeRevision`.
- `test/engine-parity/access-rule-add.test.ts`: on every arm, `gbrain access rule add` through the command, its preview
  and its `--yes` write printing the same JSON, the open twins, a brain with held facts, and the held-move rule reads.
- `test/engine-sql-caller-raw-sql-pins.test.ts` pins each Postgres statement to the text its caller ran.
