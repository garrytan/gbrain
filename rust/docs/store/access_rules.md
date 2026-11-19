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
| `z 0x04 <source> \0 <revision u64 BE>` | `{ source_id, revision, applied }` | `access_policy_revisions` |

The writes mirror the v283 checks: a rule id matches `^[a-z0-9][a-z0-9._-]{0,63}$`, a prefix is one or more
segments that each end in `/` (at most 512 bytes, no `..`), a pending prefix is `''` or such a prefix with reason
`pending` or `invalid`, and a revision is positive. A rule, a pending prefix or a revision needs its source's policy
state (the foreign key). The policy writes in `policy.ts` (`proposeRevision`, `applyApproved`, `restampSource`) stay
raw SQL, which this engine refuses, so on a Rust brain only the fixtures below write this state.

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.readFolderAccess(readers)` | `{ rules, coverage }`: each rule whose `readable_by` names any of `readers` (`{ source_id, rule_id, readable_by }`, by source and id; none when `readers` is empty) and each distinct pending prefix (`{ source_id, prefix }`, by source and prefix) | `readFolderAccess` (`FOLDER_RULES_FOR_READERS_SQL`, `FOLDER_COVERAGE_SQL`) |
| `brain.listAppliedPolicyRevisions()` | `{ source_id, rev }` for each source with policy state, by source id; `rev` is its newest applied revision, `null` when none is applied | `listAppliedPolicyRevisions` |
| `brain.isFolderRestricted(sourceId, slug)` | `true` when a rule of the source has a prefix the slug starts with, or a pending prefix of the source covers it (`''` covers every slug) | `isFolderRestricted` |
| `brain.putAccessPolicyState(sourceId)` | records policy state; a second put changes nothing | fixture (`INSERT ... ON CONFLICT DO NOTHING`) |
| `brain.putAccessRule(rule)` | stores the rule, replacing the same source and id; `covers_derived` defaults to `true` | fixture |
| `brain.putAccessPendingCoverage(row)` | stores the prefix; the first row for one source, prefix and reason stays | fixture |
| `brain.putAccessPolicyRevision(row)` | stores the revision, replacing the same number | fixture |

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
