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

The writes mirror the v283 and v303 checks: a rule id matches `^[a-z0-9][a-z0-9._-]{0,63}$`, a prefix is a folder
(segments that each end in `/`) or one page (the same segments without the final `/`), at most 512 bytes with no `..`,
a pending prefix is `''` or such a prefix with reason `pending` or `invalid`, and a revision is positive. A folder
prefix covers every slug under it; a page prefix covers only the slug it names. A rule, a pending prefix or a revision
needs its source's policy state (the foreign key). Rule ids, revision numbers and operation ids are unique as the
primary keys and the unique index make them.

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.readFolderAccess(readers)` | `{ rules, coverage }`: each rule whose `readable_by` names any of `readers` (`{ source_id, rule_id, readable_by }`, by source and id; none when `readers` is empty) and each distinct pending prefix (`{ source_id, prefix }`, by source and prefix) | `readFolderAccess` (`FOLDER_RULES_FOR_READERS_SQL`, `FOLDER_COVERAGE_SQL`) |
| `brain.listAppliedPolicyRevisions()` | `{ source_id, rev }` for each source with policy state, by source id; `rev` is its newest applied revision, `null` when none is applied | `listAppliedPolicyRevisions` |
| `brain.isFolderRestricted(sourceId, slug)` | `true` when a rule of the source has a prefix the slug starts with, or a pending prefix of the source covers it (`''` covers every slug) | `isFolderRestricted` |
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
| `brain.insertAccessPolicyRevision(row)` | records a revision (a revision number the source has, or an operation id any source has, refuses) | `INSERT_REVISION_SQL` |
| `brain.markAccessRevisionsApplied(sourceId, upTo?)` / `approveAccessPolicyRevision(sourceId, revision, actor)` | marks unapplied revisions applied (up to `upTo`) / records the approver, now | `MARK_APPLIED_SQL`, `MARK_APPLIED_UP_TO_SQL`, `APPROVE_REVISION_SQL` |
| `brain.listAccessPrefixSlugs(sourceId, prefixes)` | the live slugs that start with any prefix, by slug | `PREFIX_SLUGS_SQL`, `PREFIXES_SLUGS_SQL` |
| `brain.readAccessPolicyMarks(sourceId, operationId?)` | `{ applied, approved, operation? }` | `POLICY_MARKS_SQL`, `OPERATION_MARKS_SQL` |
| `brain.replaceAccessInvalidCoverage(sourceId, prefixes, detail)` | replaces the invalid prefixes; an empty list clears them | `DELETE_INVALID_SQL`, `INSERT_INVALID_SQL` |

The store does not stamp a page when it is written, so `pages_restamped` counts a page written under an existing rule
on a later restamp where PGLite does not. What a caller can read does not change: the store judges each read against
the rules it holds.

The store has no row-level security, so `readFolderAccess` never returns the `'!unreadable'` row and the unreadable
part of `isFolderRestricted` is always false.

## The member-access flag

v283's triggers `access_rules_mark_restricted` and `access_pending_coverage_mark_restricted` set config
`access.restrictions_present` to `'1'` on the first rule or pending prefix. The store's `FlaggingWriter` does the same on
every put of a `z 0x02` or `z 0x03` key, whatever code path made it ([access-flag.md](access-flag.md)).

## Page reads

The store's privacy filter (`crates/gbrain-store/src/facts/privacy.rs`) applies these records to the pages a served
caller reads:

- a page whose slug is under a rule of its source is stamped (`pages.folder_rule_ids IS NOT NULL`). A served caller
  satisfies no rule (the TypeScript members refuse a caller-access record with satisfied rule ids or folder coverage),
  so a stamped page is hidden from it, in the full form and in the unrestricted short form;
- a page under a pending prefix is hidden in the full form, as the coverage conjuncts of `folderRulesAllowedSql` hide
  it;
- as a fact's origin or a derivative's input, a rule stored with `covers_derived: false` does not count
  (`gbrain_access_lineage_rules`, v305); a rule that covers derived pages, or a pending prefix, closes the origin.

One difference remains: PGLite stamps `folder_rule_ids` when a page is written and changes it only on a restamp, and
the store judges a page against the rules it holds when the read runs. The two agree after `restampSource`, which is
the state a finished policy change leaves.

The folder test has no `PrivacyPolicy` field: it reads the store's rules and pending prefixes,
and `member_access_allows` ANDs it with the owner-only test (`owner_only`, absent means `closed`).
So a policy with every defaulted field missing still hides a folder-restricted page, and no
owner-only form reopens one (`a_policy_missing_its_defaulted_fields_still_hides_a_folder_restricted_page`).

## Tests

- `crates/gbrain-store/src/access_rules.rs` (unit tests): reads in key order, the flag on a rule or pending put, the
  newest applied revision per source, folder restriction and stamping, and the writes the v283 checks refuse.
- `crates/gbrain-store/src/facts/privacy.rs` (unit test): a folder rule and a pending prefix hide pages from every
  served caller; a raw-only rule does not close an origin.
- `test/engine-parity/write-misc.test.ts` and `test/engine-parity/import-path.test.ts`: `readFolderAccess`,
  `folderAccessForAll`, `appliedAccessSummary`, `isFolderRestricted` and `listAppliedPolicyRevisions` on every arm, and
  a private folder that refuses a caller its rule does not name (no rule satisfied, the folder's page hidden from
  `findPagesByTitles`). The `restrictFolder` and `seedAccessPolicy` fixtures (`test/engine-parity/harness.ts`) write
  the state.
- `crates/gbrain-store/src/access_policy.rs` (unit tests): a revision number or operation id refuses a second write,
  a refused rule change leaves no rule, the restamp counts drifted pages, page prefixes cover one page, and invalid
  coverage is replaced and cleared.
- `test/engine-parity/access-policy.test.ts`: on every arm, a rule added through `policy.ts` hides the folder, a
  removal waits for approval and then shows it, the pending prefix between install and restamp, the revision count, a
  rule change refused part way, and two concurrent rule changes that cannot both apply against one revision.
