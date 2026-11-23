//! Folder access state: the applied folder rules (`access_rules`), the pending or invalid folder
//! prefixes (`access_pending_coverage`), which sources hold access state (`access_policy_state`)
//! and their policy revisions (`access_policy_revisions`), all from schema migration v283.
//!
//! PGLite and Postgres run the SQL in `src/core/engine-sql/access-control.ts`; this answers the
//! same reads from the store's records:
//!
//! - `readFolderAccess`: the rules whose readers name any of the caller's principals, and the
//!   distinct pending prefixes by source and prefix. The store has no row-level security, so the
//!   `'!unreadable'` row (`gbrain_access_state_unreadable()`) never appears.
//! - `listAppliedPolicyRevisions`: each source with access state and its newest applied revision.
//! - `isFolderRestricted`: a slug under a rule (`gbrain_access_folder_rules`) or a pending prefix
//!   (`gbrain_access_pending_covers`).
//!
//! The page policy (`facts/privacy.rs`) reads the same records: a page under a rule of a source
//! with access state counts as stamped (`pages.folder_rule_ids`), judged against the rules as
//! they are now, as after `restampSource`.
//!
//! The access commands (`src/core/access/policy.ts`) write this state through the typed policy
//! members in `access_policy.rs`; the fixtures below write it for tests. Every write runs through
//! `Store::write`, whose handle sets the member-access flag on a rule or pending put, as the
//! triggers `access_rules_mark_restricted` and `access_pending_coverage_mark_restricted` do.
//!
//! Keys (tag [`keys::ACCESS_RULES`], then one sub-tag byte):
//!
//! - `0x01 <source>`: the source holds access state.
//! - `0x02 <source> 0 <rule_id>`: a rule.
//! - `0x03 <source> 0 <prefix> 0 <reason>`: a pending or invalid prefix.
//! - `0x04 <source> 0 <revision as 8 big-endian bytes>`: a policy revision.
//! - `0x05 <source> 0 <page id as 8 big-endian bytes>`: the rule ids the last restamp gave a page.
//! - `0x06 <source> 0 <id>`: a policy-store migration (`access_migrations.rs`).
//!
//! See rust/docs/store/access_rules.md.

use crate::error::{INVALID_ARGUMENT, Result, StoreError};
use crate::keys;
use crate::kv::{KvRead, scan_prefix};
use crate::{Store, get_json, put_json};
use serde::{Deserialize, Serialize};

/// Sub-tag: a source holds access state (`access_policy_state`).
pub(crate) const STATE: u8 = 0x01;
/// Sub-tag: a folder rule (`access_rules`).
pub(crate) const RULE: u8 = 0x02;
/// Sub-tag: a pending or invalid prefix (`access_pending_coverage`).
pub(crate) const COVERAGE: u8 = 0x03;
/// Sub-tag: a policy revision (`access_policy_revisions`).
pub(crate) const REVISION: u8 = 0x04;
/// Sub-tag: a page's restamped rule ids (`pages.folder_rule_ids`), which only the restamp writes.
pub(crate) const STAMP: u8 = 0x05;
/// Sub-tag: a policy-store migration (`access_policy_migrations`, `access_migrations.rs`).
pub(crate) const MIGRATION: u8 = 0x06;

pub(crate) fn key(sub: u8, parts: &[&[u8]]) -> Vec<u8> {
    let mut key = vec![keys::ACCESS_RULES, sub];
    for (i, part) in parts.iter().enumerate() {
        if i > 0 {
            key.push(0);
        }
        key.extend_from_slice(part);
    }
    key
}

/// The prefix of every key of `sub` in `source_id`.
pub(crate) fn source_prefix(sub: u8, source_id: &str) -> Vec<u8> {
    let mut key = key(sub, &[source_id.as_bytes()]);
    key.push(0);
    key
}

/// Whether a put of `key` stores a rule or a pending prefix: the writes the PG triggers mark the
/// member-access flag on.
pub(crate) fn marks_restricted(key: &[u8]) -> bool {
    key.first() == Some(&keys::ACCESS_RULES) && matches!(key.get(1), Some(&RULE | &COVERAGE))
}

/// One folder rule as stored.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AccessRuleRecord {
    pub source_id: String,
    pub rule_id: String,
    pub prefix: String,
    pub readable_by: Vec<String>,
    pub revision: i64,
    /// `covers_derived`: the rule also covers what is derived from its pages.
    #[serde(default = "covers_derived_default")]
    pub covers_derived: bool,
    /// `created_by`: who installed the rule.
    #[serde(default)]
    pub created_by: Option<String>,
}

fn covers_derived_default() -> bool {
    true
}

/// One pending or invalid prefix as stored. `prefix` is `''` for the whole source.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PendingCoverageRecord {
    pub source_id: String,
    pub prefix: String,
    pub reason: String,
    #[serde(default)]
    pub revision: Option<i64>,
    /// `detail`: why an invalid prefix is invalid.
    #[serde(default)]
    pub detail: Option<serde_json::Value>,
}

/// One policy revision as stored. A fixture revision (`putAccessPolicyRevision`) carries only the
/// source, the number and `applied`; one policy.ts records carries every column, its times in
/// microseconds.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PolicyRevisionRecord {
    pub source_id: String,
    pub revision: i64,
    #[serde(default)]
    pub applied: bool,
    #[serde(default)]
    pub rules: Option<serde_json::Value>,
    #[serde(default)]
    pub digest: String,
    #[serde(default)]
    pub change_kind: String,
    #[serde(default)]
    pub origin: String,
    #[serde(default)]
    pub operation_id: Option<String>,
    #[serde(default)]
    pub proposed_by: Option<String>,
    #[serde(default)]
    pub approved_by: Option<String>,
    #[serde(default)]
    pub created_at_us: Option<i64>,
    #[serde(default)]
    pub applied_at_us: Option<i64>,
    #[serde(default)]
    pub approved_at_us: Option<i64>,
}

impl PolicyRevisionRecord {
    /// Whether the revision counts as applied (`applied_at IS NOT NULL`).
    pub fn is_applied(&self) -> bool {
        self.applied || self.applied_at_us.is_some()
    }
}

/// A rule whose readers name one of the caller's principals (`source_id, rule_id, readable_by`).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct FolderRuleRow {
    pub source_id: String,
    pub rule_id: String,
    pub readable_by: Vec<String>,
}

/// A pending prefix (`source_id, prefix`).
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize)]
pub struct FolderCoverageRow {
    pub source_id: String,
    pub prefix: String,
}

/// The rows the caller's folder access is built from.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct FolderAccessRows {
    pub rules: Vec<FolderRuleRow>,
    pub coverage: Vec<FolderCoverageRow>,
}

/// A source with access state and its newest applied revision (`AppliedPolicyRevision`).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AppliedPolicyRevisionRow {
    pub source_id: String,
    pub rev: Option<i64>,
}

pub(crate) fn invalid(message: impl Into<String>) -> StoreError {
    StoreError::new(INVALID_ARGUMENT, message.into())
}

/// The v283 checks on a rule id: `^[a-z0-9][a-z0-9._-]{0,63}$`.
pub(crate) fn valid_rule_id(id: &str) -> bool {
    let b = id.as_bytes();
    !b.is_empty()
        && b.len() <= 64
        && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit())
        && b.iter()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || b"._-".contains(c))
}

/// One path segment of a rule prefix: `[a-z0-9][a-z0-9._-]*`.
fn valid_segment(seg: &str) -> bool {
    let b = seg.as_bytes();
    !b.is_empty()
        && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit())
        && b.iter()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || b"._-".contains(c))
}

/// The v303 checks on a rule prefix: a folder (`^([a-z0-9][a-z0-9._-]*/)+$`) or one page (the
/// same segments without the trailing `/`), at most 512 bytes, no `..`.
pub(crate) fn valid_prefix(prefix: &str) -> bool {
    let body = prefix.strip_suffix('/').unwrap_or(prefix);
    prefix.len() <= 512 && !prefix.contains("..") && body.split('/').all(valid_segment)
}

/// Whether a rule prefix covers `slug` (folder-rules.ts `ruleCovers`): a folder prefix covers the
/// slugs under it, a page prefix only the slug it names.
pub(crate) fn rule_covers(slug: &str, prefix: &str) -> bool {
    if prefix.ends_with('/') {
        slug.starts_with(prefix)
    } else {
        slug == prefix
    }
}

pub(crate) fn each<T: serde::de::DeserializeOwned>(
    read: &dyn KvRead,
    prefix: &[u8],
    mut f: impl FnMut(T) -> bool,
) -> Result<()> {
    let mut failed = None;
    scan_prefix(
        read,
        prefix,
        false,
        &mut |_, value| match serde_json::from_slice(value) {
            Ok(record) => f(record),
            Err(e) => {
                failed = Some(e);
                false
            }
        },
    )?;
    match failed {
        Some(e) => Err(e.into()),
        None => Ok(()),
    }
}

/// Whether `source_id` holds access state (`access_policy_state`).
pub(crate) fn has_state(read: &dyn KvRead, source_id: &str) -> Result<bool> {
    Ok(read.get(&key(STATE, &[source_id.as_bytes()]))?.is_some())
}

/// The v283 foreign key: a rule, a pending prefix or a revision needs its source's access state.
pub(crate) fn require_state(read: &dyn KvRead, op: &str, source_id: &str) -> Result<()> {
    if has_state(read, source_id)? {
        Ok(())
    } else {
        Err(invalid(format!(
            "{op}: source {source_id:?} holds no access state"
        )))
    }
}

/// The rules of `source_id` whose prefix `slug` starts with (`gbrain_access_folder_rules`), by
/// rule id.
pub(crate) fn folder_rules(
    read: &dyn KvRead,
    source_id: &str,
    slug: &str,
) -> Result<Vec<AccessRuleRecord>> {
    let mut out = Vec::new();
    each(
        read,
        &source_prefix(RULE, source_id),
        |r: AccessRuleRecord| {
            if rule_covers(slug, &r.prefix) {
                out.push(r);
            }
            true
        },
    )?;
    Ok(out)
}

/// Whether a pending or invalid prefix of `source_id` covers `slug`
/// (`gbrain_access_pending_covers`); the empty prefix covers every slug.
pub(crate) fn pending_covers(read: &dyn KvRead, source_id: &str, slug: &str) -> Result<bool> {
    let mut found = false;
    each(
        read,
        &source_prefix(COVERAGE, source_id),
        |c: PendingCoverageRecord| {
            found = c.prefix.is_empty() || rule_covers(slug, &c.prefix);
            !found
        },
    )?;
    Ok(found)
}

/// Whether `source_id` holds a rule or a pending prefix whose prefix is exactly `prefix`
/// (`EXISTS (SELECT 1 FROM access_rules ...) OR EXISTS (SELECT 1 FROM access_pending_coverage ...)`
/// on `prefix = $2`).
pub(crate) fn has_exact_prefix(read: &dyn KvRead, source_id: &str, prefix: &str) -> Result<bool> {
    let mut found = false;
    each(
        read,
        &source_prefix(RULE, source_id),
        |r: AccessRuleRecord| {
            found = r.prefix == prefix;
            !found
        },
    )?;
    if found {
        return Ok(true);
    }
    each(
        read,
        &source_prefix(COVERAGE, source_id),
        |c: PendingCoverageRecord| {
            found = c.prefix == prefix;
            !found
        },
    )?;
    Ok(found)
}

/// Whether a page at `slug` carries folder rules (`pages.folder_rule_ids IS NOT NULL`): its
/// source holds access state and a rule covers the slug.
pub(crate) fn stamped(read: &dyn KvRead, source_id: &str, slug: &str) -> Result<bool> {
    Ok(has_state(read, source_id)? && !folder_rules(read, source_id, slug)?.is_empty())
}

impl Store {
    /// Records that `source_id` holds access state (`INSERT INTO access_policy_state ... ON
    /// CONFLICT DO NOTHING`).
    pub fn put_access_policy_state(&self, source_id: &str) -> Result<()> {
        self.write(|tx| {
            let k = key(STATE, &[source_id.as_bytes()]);
            if tx.get(&k)?.is_none() {
                tx.put(&k, b"{}")?;
            }
            Ok(())
        })
    }

    /// Stores a folder rule, replacing the rule of the same source and id. Refuses an id or a
    /// prefix the v283 checks refuse, or a source with no access state.
    pub fn put_access_rule(&self, rule: AccessRuleRecord) -> Result<()> {
        if !valid_rule_id(&rule.rule_id) {
            return Err(invalid(format!(
                "putAccessRule: invalid rule id {:?}",
                rule.rule_id
            )));
        }
        if !valid_prefix(&rule.prefix) {
            return Err(invalid(format!(
                "putAccessRule: invalid prefix {:?}",
                rule.prefix
            )));
        }
        self.write(|tx| {
            require_state(tx, "putAccessRule", &rule.source_id)?;
            let k = key(RULE, &[rule.source_id.as_bytes(), rule.rule_id.as_bytes()]);
            put_json(tx, &k, &rule)
        })
    }

    /// Stores a pending or invalid prefix, keeping the first row for one source, prefix and reason
    /// (the table's primary key). Refuses a reason other than `pending` or `invalid`, a prefix
    /// that is neither `''` nor a valid rule prefix, or a source with no access state.
    pub fn put_access_pending_coverage(&self, row: PendingCoverageRecord) -> Result<()> {
        if row.reason != "pending" && row.reason != "invalid" {
            return Err(invalid(format!(
                "putAccessPendingCoverage: invalid reason {:?}",
                row.reason
            )));
        }
        if !row.prefix.is_empty() && !valid_prefix(&row.prefix) {
            return Err(invalid(format!(
                "putAccessPendingCoverage: invalid prefix {:?}",
                row.prefix
            )));
        }
        self.write(|tx| {
            require_state(tx, "putAccessPendingCoverage", &row.source_id)?;
            let k = key(
                COVERAGE,
                &[
                    row.source_id.as_bytes(),
                    row.prefix.as_bytes(),
                    row.reason.as_bytes(),
                ],
            );
            if tx.get(&k)?.is_none() {
                put_json(tx, &k, &row)?;
            }
            Ok(())
        })
    }

    /// Stores a policy revision (a positive revision number), replacing the same revision. Refuses
    /// a source with no access state.
    pub fn put_access_policy_revision(&self, row: PolicyRevisionRecord) -> Result<()> {
        let Ok(revision) = u64::try_from(row.revision) else {
            return Err(invalid(
                "putAccessPolicyRevision: revision must be positive",
            ));
        };
        if revision == 0 {
            return Err(invalid(
                "putAccessPolicyRevision: revision must be positive",
            ));
        }
        self.write(|tx| {
            require_state(tx, "putAccessPolicyRevision", &row.source_id)?;
            let k = key(
                REVISION,
                &[row.source_id.as_bytes(), &revision.to_be_bytes()],
            );
            put_json(tx, &k, &row)
        })
    }

    /// The rules whose readers name any of `readers` (`readable_by && $1::text[]`), by source and
    /// rule id, and the distinct pending prefixes by source and prefix. An empty `readers` reads
    /// no rule.
    pub fn read_folder_access(&self, readers: &[String]) -> Result<FolderAccessRows> {
        let read = self.read()?;
        let mut rules = Vec::new();
        if !readers.is_empty() {
            each(
                &*read,
                &[keys::ACCESS_RULES, RULE],
                |r: AccessRuleRecord| {
                    if r.readable_by.iter().any(|reader| readers.contains(reader)) {
                        rules.push(FolderRuleRow {
                            source_id: r.source_id,
                            rule_id: r.rule_id,
                            readable_by: r.readable_by,
                        });
                    }
                    true
                },
            )?;
        }
        let mut coverage: Vec<FolderCoverageRow> = Vec::new();
        each(
            &*read,
            &[keys::ACCESS_RULES, COVERAGE],
            |c: PendingCoverageRecord| {
                let row = FolderCoverageRow {
                    source_id: c.source_id,
                    prefix: c.prefix,
                };
                if coverage.last() != Some(&row) {
                    coverage.push(row);
                }
                true
            },
        )?;
        Ok(FolderAccessRows { rules, coverage })
    }

    /// Each source with access state, by source id, with its newest applied revision (`None`
    /// when no revision of it is applied).
    pub fn list_applied_policy_revisions(&self) -> Result<Vec<AppliedPolicyRevisionRow>> {
        let read = self.read()?;
        let mut sources = Vec::new();
        scan_prefix(&*read, &[keys::ACCESS_RULES, STATE], false, &mut |k, _| {
            sources.push(String::from_utf8_lossy(&k[2..]).into_owned());
            true
        })?;
        let mut out = Vec::with_capacity(sources.len());
        for source_id in sources {
            let mut rev = None;
            let mut failed = None;
            scan_prefix(
                &*read,
                &source_prefix(REVISION, &source_id),
                true,
                &mut |_, value| match serde_json::from_slice::<PolicyRevisionRecord>(value) {
                    Ok(r) if r.is_applied() => {
                        rev = Some(r.revision);
                        false
                    }
                    Ok(_) => true,
                    Err(e) => {
                        failed = Some(e);
                        false
                    }
                },
            )?;
            if let Some(e) = failed {
                return Err(e.into());
            }
            out.push(AppliedPolicyRevisionRow { source_id, rev });
        }
        Ok(out)
    }

    /// Whether `slug` in `source_id` is under a folder rule or a pending prefix. The store has no
    /// row-level security, so the unreadable-state part is always false.
    pub fn is_folder_restricted(&self, source_id: &str, slug: &str) -> Result<bool> {
        let read = self.read()?;
        Ok(!folder_rules(&*read, source_id, slug)?.is_empty()
            || pending_covers(&*read, source_id, slug)?)
    }

    /// The stored rule of `source_id` and `rule_id`, if any.
    pub fn get_access_rule(
        &self,
        source_id: &str,
        rule_id: &str,
    ) -> Result<Option<AccessRuleRecord>> {
        let read = self.read()?;
        get_json(
            &*read,
            &key(RULE, &[source_id.as_bytes(), rule_id.as_bytes()]),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::store;

    fn rule(source: &str, id: &str, prefix: &str, readers: &[&str]) -> AccessRuleRecord {
        AccessRuleRecord {
            source_id: source.into(),
            rule_id: id.into(),
            prefix: prefix.into(),
            readable_by: readers.iter().map(|r| r.to_string()).collect(),
            revision: 1,
            covers_derived: true,
            created_by: None,
        }
    }

    fn pending(source: &str, prefix: &str, reason: &str) -> PendingCoverageRecord {
        PendingCoverageRecord {
            source_id: source.into(),
            prefix: prefix.into(),
            reason: reason.into(),
            revision: None,
            detail: None,
        }
    }

    #[test]
    fn rules_overlapping_the_readers_and_distinct_pending_prefixes_read_in_key_order() {
        let s = store();
        s.put_access_policy_state("work").unwrap();
        s.put_access_policy_state("default").unwrap();
        s.put_access_rule(rule("work", "team", "team/", &["group:team-a"]))
            .unwrap();
        s.put_access_rule(rule("work", "alice", "private/", &["member:alice-example"]))
            .unwrap();
        s.put_access_rule(rule("default", "x", "x/", &["member:bob-example"]))
            .unwrap();
        s.put_access_pending_coverage(pending("work", "queued/", "pending"))
            .unwrap();
        s.put_access_pending_coverage(pending("work", "queued/", "invalid"))
            .unwrap();
        s.put_access_pending_coverage(pending("default", "", "invalid"))
            .unwrap();
        let rows = s
            .read_folder_access(&["member:alice-example".into(), "group:team-a".into()])
            .unwrap();
        let ids: Vec<_> = rows
            .rules
            .iter()
            .map(|r| format!("{}:{}", r.source_id, r.rule_id))
            .collect();
        assert_eq!(ids, ["work:alice", "work:team"]);
        let cov: Vec<_> = rows
            .coverage
            .iter()
            .map(|c| (c.source_id.as_str(), c.prefix.as_str()))
            .collect();
        assert_eq!(cov, [("default", ""), ("work", "queued/")]);
        assert!(s.read_folder_access(&[]).unwrap().rules.is_empty());
    }

    #[test]
    fn a_rule_or_pending_put_sets_the_member_access_flag() {
        let s = store();
        assert_eq!(s.get_config("access.restrictions_present").unwrap(), None);
        s.put_access_policy_state("work").unwrap();
        assert_eq!(s.get_config("access.restrictions_present").unwrap(), None);
        s.put_access_rule(rule("work", "r", "private/", &["member:a"]))
            .unwrap();
        assert_eq!(
            s.get_config("access.restrictions_present")
                .unwrap()
                .as_deref(),
            Some("1")
        );
        let t = store();
        t.put_access_policy_state("work").unwrap();
        t.put_access_pending_coverage(pending("work", "", "pending"))
            .unwrap();
        assert_eq!(
            t.get_config("access.restrictions_present")
                .unwrap()
                .as_deref(),
            Some("1")
        );
    }

    #[test]
    fn applied_revisions_give_the_newest_applied_one_per_source_with_state() {
        let s = store();
        s.put_access_policy_state("work").unwrap();
        s.put_access_policy_state("quiet").unwrap();
        for (rev, applied) in [(1, true), (2, true), (3, false)] {
            s.put_access_policy_revision(PolicyRevisionRecord {
                source_id: "work".into(),
                revision: rev,
                applied,
                ..Default::default()
            })
            .unwrap();
        }
        s.put_access_policy_revision(PolicyRevisionRecord {
            source_id: "quiet".into(),
            revision: 1,
            applied: false,
            ..Default::default()
        })
        .unwrap();
        assert!(
            s.put_access_policy_revision(PolicyRevisionRecord {
                source_id: "nostate".into(),
                revision: 1,
                applied: true,
                ..Default::default()
            })
            .is_err(),
            "a revision needs its source's access state"
        );
        let rows = s.list_applied_policy_revisions().unwrap();
        assert_eq!(
            rows,
            [
                AppliedPolicyRevisionRow {
                    source_id: "quiet".into(),
                    rev: None
                },
                AppliedPolicyRevisionRow {
                    source_id: "work".into(),
                    rev: Some(2)
                },
            ]
        );
    }

    #[test]
    fn folder_restriction_follows_rules_and_pending_prefixes() {
        let s = store();
        s.put_access_policy_state("work").unwrap();
        s.put_access_rule(rule("work", "r", "private/", &["member:a"]))
            .unwrap();
        s.put_access_pending_coverage(pending("work", "queued/", "pending"))
            .unwrap();
        assert!(s.is_folder_restricted("work", "private/diary").unwrap());
        assert!(s.is_folder_restricted("work", "queued/notes").unwrap());
        assert!(!s.is_folder_restricted("work", "private").unwrap());
        assert!(!s.is_folder_restricted("default", "private/diary").unwrap());
        let read = s.read().unwrap();
        assert!(stamped(&*read, "work", "private/diary").unwrap());
        assert!(!stamped(&*read, "work", "queued/notes").unwrap());
    }

    #[test]
    fn invalid_ids_prefixes_reasons_and_revisions_refuse() {
        let s = store();
        assert!(
            s.put_access_rule(rule("work", "r", "private/", &[]))
                .is_err(),
            "a rule needs its source's access state"
        );
        s.put_access_policy_state("work").unwrap();
        assert!(
            s.put_access_rule(rule("work", "Bad", "private/", &[]))
                .is_err()
        );
        assert!(
            s.put_access_rule(rule("work", "r", "Private/", &[]))
                .is_err()
        );
        assert!(
            s.put_access_rule(rule("work", "r", "a/../b/", &[]))
                .is_err()
        );
        assert!(
            s.put_access_pending_coverage(pending("work", "x/", "other"))
                .is_err()
        );
        assert!(
            s.put_access_policy_revision(PolicyRevisionRecord {
                source_id: "w".into(),
                revision: 0,
                applied: true,
                ..Default::default()
            })
            .is_err()
        );
        assert_eq!(s.get_access_rule("work", "r").unwrap(), None);
    }
}
