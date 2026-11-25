//! The folder-rule policy members `src/core/access/policy.ts` runs (`engine-sql/access-policy.ts`
//! on PGLite and Postgres), answered from the records of [`crate::access_rules`].
//!
//! Every write runs in one `Store::write`, so its `FlaggingWriter` sets the member-access flag on a
//! rule or pending put, and a refused write leaves nothing of itself behind. The row locks policy.ts
//! takes (`lockAccessPolicy`: the source row, then its policy row) are the store write transaction:
//! `RustEngine.transaction` holds the writer gate until it commits or rolls back, so
//! `lockAccessPolicy` only takes that gate for one statement.
//!
//! Revisions keep the table's two keys: a revision number a source already has, or an operation id
//! any source already recorded, refuses `constraint_violation`, so two rule changes against one
//! revision cannot both apply.
//!
//! The restamp (`restampAccessWindow`, `finishAccessRestamp`) keeps each page's restamped rule ids
//! (`pages.folder_rule_ids`) under sub-tag [`STAMP`] and counts the pages whose kept ids differ from
//! the rules now. A page record put under a new key (an insert, a rename) takes its ids in the same
//! write ([`stamp_page_put`], from `FlaggingWriter`), as the trigger `pages_access_stamp_folder_rules`
//! does, so a restamp counts the same pages as on Postgres. The page policy judges against the rules
//! as they are, except a caller record's rendering judges a page under a live pending prefix by its
//! kept ids ([`kept_rules`]), as Postgres reads `folder_rule_ids` with no live pending conjunct.
//!
//! See rust/docs/store/access_rules.md.

use crate::access_rules::{
    AccessRuleRecord, COVERAGE, PendingCoverageRecord, PolicyRevisionRecord, REVISION, RULE, STAMP,
    STATE, each, folder_rules, has_state, invalid, key, require_state, source_prefix, valid_prefix,
    valid_rule_id,
};
use crate::error::{CONSTRAINT_VIOLATION, Result, SOURCE_NOT_FOUND, StoreError};
use crate::keys;
use crate::kv::{KvRead, KvWrite, scan_prefix};
use crate::pages::all_pages;
use crate::sources::read_source;
use crate::{Store, get_json, put_json};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// `{ store }`: the source's `config.access_store` text, `None` when unset.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AccessStoreConfig {
    pub store: Option<String>,
}

/// One applied rule (`AccessRuleRow`).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AccessRuleRow {
    pub rule_id: String,
    pub prefix: String,
    pub readable_by: Vec<String>,
    pub covers_derived: bool,
}

/// A rule to insert (`AccessRuleInsert`).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AccessRuleInsert {
    pub rule_id: String,
    pub prefix: String,
    pub readable_by: Vec<String>,
    pub covers_derived: bool,
}

/// One rulebook change (`AccessRuleChanges`).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AccessRuleChanges {
    pub remove: Vec<String>,
    pub insert: Vec<AccessRuleInsert>,
    pub pending: Vec<String>,
    pub revision: i64,
    pub actor: String,
}

/// Which revisions to read (`AccessRevisionQuery`).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "by", rename_all = "lowercase", deny_unknown_fields)]
pub enum AccessRevisionQuery {
    Latest {
        #[serde(rename = "sourceId")]
        source_id: String,
    },
    Revision {
        #[serde(rename = "sourceId")]
        source_id: String,
        revision: i64,
    },
    Recent {
        #[serde(rename = "sourceId")]
        source_id: String,
        limit: i64,
    },
    Operation {
        #[serde(rename = "operationId")]
        operation_id: String,
    },
}

/// A revision as `SELECT *` reads it, times as text.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AccessRevisionRow {
    pub source_id: String,
    pub revision: i64,
    pub rules: Value,
    pub digest: String,
    pub change_kind: String,
    pub origin: String,
    pub operation_id: Option<String>,
    pub proposed_by: Option<String>,
    pub approved_by: Option<String>,
    pub created_at: Option<String>,
    pub applied_at: Option<String>,
    pub approved_at: Option<String>,
}

/// A pending or invalid prefix of one source (`AccessCoverageRow`).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AccessCoverageRow {
    pub prefix: String,
    pub reason: String,
    pub revision: Option<i64>,
    pub detail: Option<Value>,
}

/// One restamp window (`AccessRestampWindow`).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AccessRestampWindow {
    pub last: Option<u64>,
    pub scanned: u64,
    pub changed: u64,
}

/// A revision to record (`AccessRevisionInsert`).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AccessRevisionInsert {
    pub source_id: String,
    pub revision: i64,
    pub rules: Value,
    pub digest: String,
    pub change_kind: String,
    pub origin: String,
    pub operation_id: Option<String>,
    pub proposed_by: Option<String>,
    pub approved_by: Option<String>,
    pub approved: bool,
}

/// The revision one operation id recorded in a source.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AccessOperationMarks {
    pub revision: i64,
    pub applied_at: Option<String>,
    pub approved_at: Option<String>,
}

/// `AccessPolicyMarks`: `operation` is absent when no operation id was asked about, null when
/// the source has no revision of it.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AccessPolicyMarks {
    pub applied: Option<i64>,
    pub approved: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operation: Option<Option<AccessOperationMarks>>,
}

fn constraint(message: String) -> StoreError {
    StoreError::new(CONSTRAINT_VIOLATION, message)
}

fn iso(us: Option<i64>) -> Option<String> {
    us.map(crate::env::iso)
}

fn revision_key(source_id: &str, revision: i64) -> Vec<u8> {
    key(
        REVISION,
        &[source_id.as_bytes(), &(revision as u64).to_be_bytes()],
    )
}

fn coverage_key(source_id: &str, prefix: &str, reason: &str) -> Vec<u8> {
    key(
        COVERAGE,
        &[source_id.as_bytes(), prefix.as_bytes(), reason.as_bytes()],
    )
}

fn stamp_key(source_id: &str, page_id: u64) -> Vec<u8> {
    key(STAMP, &[source_id.as_bytes(), &page_id.to_be_bytes()])
}

/// The identity of a stored page record, without decoding the rest of it.
#[derive(Deserialize)]
struct PageIdentity {
    id: u64,
    source_id: String,
    slug: String,
}

/// The id of the page record `value`, `None` when it does not decode.
pub(crate) fn page_record_id(value: &[u8]) -> Option<u64> {
    serde_json::from_slice::<PageIdentity>(value)
        .ok()
        .map(|p| p.id)
}

/// The page write half of the restamp, as the trigger `pages_access_stamp_folder_rules` does on
/// PGLite and Postgres: a page record put under a key that held no record of the same page (an
/// insert, a rename or a move) takes the rule ids that cover it now when its source has access
/// state, and none otherwise. A put over the same page (any other column) keeps its kept ids, as
/// an UPDATE that names no slug, source or stamp column does. `prior` is the id the key held.
pub(crate) fn stamp_page_put(tx: &mut dyn KvWrite, prior: Option<u64>, value: &[u8]) -> Result<()> {
    let Ok(page) = serde_json::from_slice::<PageIdentity>(value) else {
        return Ok(());
    };
    if prior == Some(page.id) {
        return Ok(());
    }
    let k = stamp_key(&page.source_id, page.id);
    let now = if has_state(&*tx, &page.source_id)? {
        rule_ids(&*tx, &page.source_id, &page.slug)?
    } else {
        None
    };
    match now {
        Some(ids) => put_json(tx, &k, &ids),
        None if tx.get(&k)?.is_some() => tx.delete(&k),
        None => Ok(()),
    }
}

/// The rule ids the last restamp or page write kept for page `page_id` (`pages.folder_rule_ids`), none when it keeps none.
pub(crate) fn kept_rule_ids(
    read: &dyn KvRead,
    source_id: &str,
    page_id: u64,
) -> Result<Option<Vec<String>>> {
    get_json(read, &stamp_key(source_id, page_id))
}

/// The rule records of the ids the last restamp or page write kept for page `page_id`
/// (`pages.folder_rule_ids`), empty when it keeps none. An id whose rule is gone reads as a rule
/// that covers no derived page, as `gbrain_access_lineage_rules` finds no row for it.
pub(crate) fn kept_rules(
    read: &dyn KvRead,
    source_id: &str,
    page_id: u64,
) -> Result<Vec<AccessRuleRecord>> {
    let kept: Option<Vec<String>> = get_json(read, &stamp_key(source_id, page_id))?;
    let mut out = Vec::new();
    for id in kept.unwrap_or_default() {
        let (source, rule_id) = id.split_once(':').unwrap_or((source_id, id.as_str()));
        let live: Option<AccessRuleRecord> =
            get_json(read, &key(RULE, &[source.as_bytes(), rule_id.as_bytes()]))?;
        out.push(live.unwrap_or_else(|| AccessRuleRecord {
            source_id: source.to_string(),
            rule_id: rule_id.to_string(),
            prefix: String::new(),
            readable_by: Vec::new(),
            revision: 0,
            covers_derived: false,
            created_by: None,
        }));
    }
    Ok(out)
}

/// The ids the last restamp or page write kept for page `page_id` whose rule is no longer a rule
/// of its source, each as a rule no caller satisfies: no readers, and it covers derived pages, so
/// the origin tests close too. After a rule is removed and before the restamp, SQL keeps the
/// deleted id in `pages.folder_rule_ids`, so the page stays hidden (`folder_rule_ids <@ satisfied`
/// fails; `gbrain_access_lineage_rules` keeps a stamped id whose rule is gone, "fail closed").
/// Empty when the page keeps no stamp or every kept id is a live rule.
pub(crate) fn retired_rules(
    read: &dyn KvRead,
    source_id: &str,
    page_id: u64,
) -> Result<Vec<AccessRuleRecord>> {
    let kept: Option<Vec<String>> = get_json(read, &stamp_key(source_id, page_id))?;
    let mut out = Vec::new();
    for id in kept.unwrap_or_default() {
        let (source, rule_id) = id.split_once(':').unwrap_or((source_id, id.as_str()));
        if read
            .get(&key(RULE, &[source.as_bytes(), rule_id.as_bytes()]))?
            .is_some()
        {
            continue;
        }
        out.push(AccessRuleRecord {
            source_id: source.to_string(),
            rule_id: rule_id.to_string(),
            prefix: String::new(),
            readable_by: Vec::new(),
            revision: 0,
            covers_derived: true,
            created_by: None,
        });
    }
    Ok(out)
}

fn revision_row(r: PolicyRevisionRecord) -> AccessRevisionRow {
    let applied_at = r
        .applied_at_us
        .or(if r.applied { r.created_at_us } else { None });
    AccessRevisionRow {
        source_id: r.source_id,
        revision: r.revision,
        rules: r.rules.unwrap_or_else(|| Value::Array(Vec::new())),
        digest: r.digest,
        change_kind: r.change_kind,
        origin: r.origin,
        operation_id: r.operation_id,
        proposed_by: r.proposed_by,
        approved_by: r.approved_by,
        created_at: iso(r.created_at_us),
        applied_at: iso(applied_at),
        approved_at: iso(r.approved_at_us),
    }
}

/// The revisions of `source_id`, newest first.
fn revisions(read: &dyn KvRead, source_id: &str) -> Result<Vec<PolicyRevisionRecord>> {
    let mut out = Vec::new();
    each(read, &source_prefix(REVISION, source_id), |r| {
        out.push(r);
        true
    })?;
    out.reverse();
    Ok(out)
}

/// Every revision of every source.
fn all_revisions(read: &dyn KvRead) -> Result<Vec<PolicyRevisionRecord>> {
    let mut out = Vec::new();
    each(read, &[keys::ACCESS_RULES, REVISION], |r| {
        out.push(r);
        true
    })?;
    Ok(out)
}

/// The rule ids that cover `slug` (`gbrain_access_folder_rules`): `source:rule_id` by rule id, or
/// `None` when no rule covers it.
fn rule_ids(read: &dyn KvRead, source_id: &str, slug: &str) -> Result<Option<Vec<String>>> {
    let rules = folder_rules(read, source_id, slug)?;
    if rules.is_empty() {
        return Ok(None);
    }
    Ok(Some(
        rules
            .into_iter()
            .map(|r| format!("{}:{}", r.source_id, r.rule_id))
            .collect(),
    ))
}

/// Restamps the pages of `source_id` with id above `after` (at most `batch` when given), in id
/// order: each page whose kept rule ids differ from the rules now takes the new ones.
fn restamp(
    tx: &mut dyn KvWrite,
    source_id: &str,
    after: u64,
    batch: Option<usize>,
) -> Result<AccessRestampWindow> {
    let mut pages: Vec<(u64, String)> = all_pages(&*tx)?
        .into_iter()
        .filter(|p| p.source_id == source_id && p.id > after)
        .map(|p| (p.id, p.slug))
        .collect();
    pages.sort();
    if let Some(batch) = batch {
        pages.truncate(batch);
    }
    let mut window = AccessRestampWindow {
        last: pages.last().map(|p| p.0),
        scanned: pages.len() as u64,
        changed: 0,
    };
    for (id, slug) in pages {
        let k = stamp_key(source_id, id);
        let now = rule_ids(&*tx, source_id, &slug)?;
        let kept: Option<Vec<String>> = get_json(&*tx, &k)?;
        if kept == now {
            continue;
        }
        match &now {
            Some(ids) => put_json(tx, &k, ids)?,
            None => tx.delete(&k)?,
        }
        window.changed += 1;
    }
    Ok(window)
}

/// Marks the unapplied revisions of `source_id` applied now, those up to `up_to` only when given.
fn mark_applied(tx: &mut dyn KvWrite, source_id: &str, up_to: Option<i64>, now: i64) -> Result<()> {
    for mut r in revisions(&*tx, source_id)? {
        if r.is_applied() || up_to.is_some_and(|u| r.revision > u) {
            continue;
        }
        r.applied_at_us = Some(now);
        let k = revision_key(source_id, r.revision);
        put_json(tx, &k, &r)?;
    }
    Ok(())
}

fn check_coverage_prefix(op: &str, prefix: &str) -> Result<()> {
    if prefix.is_empty() || valid_prefix(prefix) {
        Ok(())
    } else {
        Err(invalid(format!("{op}: invalid prefix {prefix:?}")))
    }
}

impl Store {
    /// `readAccessStoreConfig(sourceId)`: the source's `config.access_store`, or `None` when the
    /// source does not exist.
    pub fn read_access_store_config(&self, source_id: &str) -> Result<Option<AccessStoreConfig>> {
        let read = self.read()?;
        Ok(read_source(&*read, source_id)?.map(|s| AccessStoreConfig {
            store: s.config.get("access_store").map(|v| match v {
                Value::String(s) => s.clone(),
                other => other.to_string(),
            }),
        }))
    }

    /// `writeAccessStoreConfig(sourceId, store)`: sets `config.access_store`; a missing source
    /// changes nothing.
    pub fn write_access_store_config(&self, source_id: &str, store: &str) -> Result<()> {
        let mut patch = Map::new();
        patch.insert("access_store".into(), Value::String(store.into()));
        self.update_source_config(source_id, &patch).map(|_| ())
    }

    /// `ensureAccessPolicyState(sourceId)`: records that the source holds access state unless it
    /// does. Refuses a missing source (the table's foreign key).
    pub fn ensure_access_policy_state(&self, source_id: &str) -> Result<()> {
        self.write(|tx| {
            if read_source(&*tx, source_id)?.is_none() {
                return Err(StoreError::new(
                    SOURCE_NOT_FOUND,
                    format!("ensureAccessPolicyState: no source {source_id:?}"),
                ));
            }
            let k = key(STATE, &[source_id.as_bytes()]);
            if tx.get(&k)?.is_none() {
                tx.put(&k, b"{}")?;
            }
            Ok(())
        })
    }

    /// `lockAccessPolicy(sourceId)`: one statement under the writer gate. Inside
    /// `RustEngine.transaction` the gate is held until the transaction ends, which is the lock.
    pub fn lock_access_policy(&self, _source_id: &str) -> Result<()> {
        self.write(|_| Ok(()))
    }

    /// `listAccessRules(sourceId)`: the applied rules, by rule id.
    pub fn list_access_rules(&self, source_id: &str) -> Result<Vec<AccessRuleRow>> {
        let read = self.read()?;
        let mut out = Vec::new();
        each(
            &*read,
            &source_prefix(RULE, source_id),
            |r: AccessRuleRecord| {
                out.push(AccessRuleRow {
                    rule_id: r.rule_id,
                    prefix: r.prefix,
                    readable_by: r.readable_by,
                    covers_derived: r.covers_derived,
                });
                true
            },
        )?;
        Ok(out)
    }

    /// `readAccessPolicyRevisions(query)`: the revisions `query` selects, newest first.
    pub fn read_access_policy_revisions(
        &self,
        query: &AccessRevisionQuery,
    ) -> Result<Vec<AccessRevisionRow>> {
        let read = self.read()?;
        let rows: Vec<PolicyRevisionRecord> = match query {
            AccessRevisionQuery::Latest { source_id } => {
                revisions(&*read, source_id)?.into_iter().take(1).collect()
            }
            AccessRevisionQuery::Revision {
                source_id,
                revision,
            } => {
                if *revision <= 0 {
                    Vec::new()
                } else {
                    get_json(&*read, &revision_key(source_id, *revision))?
                        .into_iter()
                        .collect()
                }
            }
            AccessRevisionQuery::Recent { source_id, limit } => revisions(&*read, source_id)?
                .into_iter()
                .take(usize::try_from(*limit).unwrap_or(0))
                .collect(),
            AccessRevisionQuery::Operation { operation_id } => all_revisions(&*read)?
                .into_iter()
                .filter(|r| r.operation_id.as_deref() == Some(operation_id.as_str()))
                .collect(),
        };
        Ok(rows.into_iter().map(revision_row).collect())
    }

    /// `listAccessCoverage(sourceId)`: the pending and invalid prefixes, by reason and prefix.
    pub fn list_access_coverage(&self, source_id: &str) -> Result<Vec<AccessCoverageRow>> {
        let read = self.read()?;
        let mut out = Vec::new();
        each(
            &*read,
            &source_prefix(COVERAGE, source_id),
            |c: PendingCoverageRecord| {
                out.push(AccessCoverageRow {
                    prefix: c.prefix,
                    reason: c.reason,
                    revision: c.revision,
                    detail: c.detail,
                });
                true
            },
        )?;
        out.sort_by(|a, b| (&a.reason, &a.prefix).cmp(&(&b.reason, &b.prefix)));
        Ok(out)
    }

    /// `readAccessStateUnreadable()`: always false, the store has no row-level security.
    pub fn read_access_state_unreadable(&self) -> Result<bool> {
        Ok(false)
    }

    /// `applyAccessRuleChanges(sourceId, changes)`: deletes the rules `remove` names, inserts
    /// `insert` (refusing a bad id or prefix, a rule id the source has, or a source with no access
    /// state), then marks each `pending` prefix pending at `revision`. All or nothing.
    pub fn apply_access_rule_changes(
        &self,
        source_id: &str,
        changes: &AccessRuleChanges,
    ) -> Result<()> {
        for r in &changes.insert {
            if !valid_rule_id(&r.rule_id) {
                return Err(invalid(format!(
                    "applyAccessRuleChanges: invalid rule id {:?}",
                    r.rule_id
                )));
            }
            if !valid_prefix(&r.prefix) {
                return Err(invalid(format!(
                    "applyAccessRuleChanges: invalid prefix {:?}",
                    r.prefix
                )));
            }
        }
        for p in &changes.pending {
            check_coverage_prefix("applyAccessRuleChanges", p)?;
        }
        self.write(|tx| {
            for id in &changes.remove {
                tx.delete(&key(RULE, &[source_id.as_bytes(), id.as_bytes()]))?;
            }
            for r in &changes.insert {
                require_state(&*tx, "applyAccessRuleChanges", source_id)?;
                let k = key(RULE, &[source_id.as_bytes(), r.rule_id.as_bytes()]);
                if tx.get(&k)?.is_some() {
                    return Err(constraint(format!(
                        "applyAccessRuleChanges: source {source_id:?} already has rule {:?}",
                        r.rule_id
                    )));
                }
                let record = AccessRuleRecord {
                    source_id: source_id.into(),
                    rule_id: r.rule_id.clone(),
                    prefix: r.prefix.clone(),
                    readable_by: r.readable_by.clone(),
                    revision: changes.revision,
                    covers_derived: r.covers_derived,
                    created_by: Some(changes.actor.clone()),
                };
                put_json(tx, &k, &record)?;
            }
            for prefix in &changes.pending {
                require_state(&*tx, "applyAccessRuleChanges", source_id)?;
                let k = coverage_key(source_id, prefix, "pending");
                let mut row: PendingCoverageRecord =
                    get_json(&*tx, &k)?.unwrap_or_else(|| PendingCoverageRecord {
                        source_id: source_id.into(),
                        prefix: prefix.clone(),
                        reason: "pending".into(),
                        revision: None,
                        detail: None,
                    });
                row.revision = Some(changes.revision);
                put_json(tx, &k, &row)?;
            }
            Ok(())
        })
    }

    /// `restampAccessWindow(sourceId, after, batch)`: restamps the next `batch` pages after page id
    /// `after`.
    pub fn restamp_access_window(
        &self,
        source_id: &str,
        after: u64,
        batch: usize,
    ) -> Result<AccessRestampWindow> {
        self.write(|tx| restamp(tx, source_id, after, Some(batch)))
    }

    /// `countAccessFolderDrift(sourceId)`: the pages of the source (a soft-deleted one too) whose kept rule
    /// ids differ from the folder rules that cover them now
    /// (`folder_rule_ids IS DISTINCT FROM gbrain_access_folder_rules(source_id, slug)`), which a
    /// restamp would change. Reads only.
    pub fn count_access_folder_drift(&self, source_id: &str) -> Result<u64> {
        let read = self.read()?;
        let mut drifted = 0;
        for page in all_pages(&*read)?
            .into_iter()
            .filter(|p| p.source_id == source_id)
        {
            let now = rule_ids(&*read, source_id, &page.slug)?;
            let kept: Option<Vec<String>> = get_json(&*read, &stamp_key(source_id, page.id))?;
            if kept != now {
                drifted += 1;
            }
        }
        Ok(drifted)
    }

    /// `finishAccessRestamp(sourceId)`: restamps every page of the source that drifted, drops its
    /// pending prefixes and the kept ids of pages that no longer exist, and marks its unapplied
    /// revisions applied, in one write. Returns the pages restamped.
    pub fn finish_access_restamp(&self, source_id: &str) -> Result<u64> {
        let now = self.env.now_micros();
        self.write(|tx| {
            let changed = restamp(tx, source_id, 0, None)?.changed;
            let mut stale = Vec::new();
            let live: std::collections::BTreeSet<u64> = all_pages(&*tx)?
                .into_iter()
                .filter(|p| p.source_id == source_id)
                .map(|p| p.id)
                .collect();
            let stamps = source_prefix(STAMP, source_id);
            scan_prefix(&*tx, &stamps, false, &mut |k, _| {
                let id = k[stamps.len()..]
                    .try_into()
                    .map(u64::from_be_bytes)
                    .unwrap_or(0);
                if !live.contains(&id) {
                    stale.push(k.to_vec());
                }
                true
            })?;
            let mut pending = Vec::new();
            each(
                &*tx,
                &source_prefix(COVERAGE, source_id),
                |c: PendingCoverageRecord| {
                    if c.reason == "pending" {
                        pending.push(coverage_key(source_id, &c.prefix, &c.reason));
                    }
                    true
                },
            )?;
            for k in stale.iter().chain(&pending) {
                tx.delete(k)?;
            }
            mark_applied(tx, source_id, None, now)?;
            Ok(changed)
        })
    }

    /// `insertAccessPolicyRevision(row)`: records a revision. Refuses a revision number the source
    /// has or an operation id any source recorded (`constraint_violation`), a revision that is not
    /// positive, or a source with no access state.
    pub fn insert_access_policy_revision(&self, row: &AccessRevisionInsert) -> Result<()> {
        if row.revision <= 0 {
            return Err(invalid(
                "insertAccessPolicyRevision: revision must be positive",
            ));
        }
        let now = self.env.now_micros();
        self.write(|tx| {
            require_state(&*tx, "insertAccessPolicyRevision", &row.source_id)?;
            let k = revision_key(&row.source_id, row.revision);
            if tx.get(&k)?.is_some() {
                return Err(constraint(format!(
                    "insertAccessPolicyRevision: source {:?} already has revision {}",
                    row.source_id, row.revision
                )));
            }
            if let Some(op) = &row.operation_id
                && all_revisions(&*tx)?
                    .iter()
                    .any(|r| r.operation_id.as_deref() == Some(op.as_str()))
            {
                return Err(constraint(format!(
                    "insertAccessPolicyRevision: operation {op:?} already recorded a revision"
                )));
            }
            let record = PolicyRevisionRecord {
                source_id: row.source_id.clone(),
                revision: row.revision,
                applied: false,
                rules: Some(row.rules.clone()),
                digest: row.digest.clone(),
                change_kind: row.change_kind.clone(),
                origin: row.origin.clone(),
                operation_id: row.operation_id.clone(),
                proposed_by: row.proposed_by.clone(),
                approved_by: row.approved_by.clone(),
                created_at_us: Some(now),
                applied_at_us: None,
                approved_at_us: row.approved.then_some(now),
            };
            put_json(tx, &k, &record)
        })
    }

    /// `markAccessRevisionsApplied(sourceId, upTo?)`.
    pub fn mark_access_revisions_applied(&self, source_id: &str, up_to: Option<i64>) -> Result<()> {
        let now = self.env.now_micros();
        self.write(|tx| mark_applied(tx, source_id, up_to, now))
    }

    /// `approveAccessPolicyRevision(sourceId, revision, actor)`: a missing revision changes
    /// nothing.
    pub fn approve_access_policy_revision(
        &self,
        source_id: &str,
        revision: i64,
        actor: &str,
    ) -> Result<()> {
        if revision <= 0 {
            return Ok(());
        }
        let now = self.env.now_micros();
        self.write(|tx| {
            let k = revision_key(source_id, revision);
            if let Some(mut r) = get_json::<PolicyRevisionRecord>(&*tx, &k)? {
                r.approved_by = Some(actor.into());
                r.approved_at_us = Some(now);
                put_json(tx, &k, &r)?;
            }
            Ok(())
        })
    }

    /// `hasAccessPolicyState(sourceId)`.
    pub fn has_access_policy_state(&self, source_id: &str) -> Result<bool> {
        let read = self.read()?;
        has_state(&*read, source_id)
    }

    /// `listAccessPrefixSlugs(sourceId, prefixes)`: the slugs of the live pages that start with
    /// any of `prefixes`, by slug.
    pub fn list_access_prefix_slugs(
        &self,
        source_id: &str,
        prefixes: &[String],
    ) -> Result<Vec<String>> {
        let read = self.read()?;
        let mut out: Vec<String> = all_pages(&*read)?
            .into_iter()
            .filter(|p| {
                p.source_id == source_id
                    && p.deleted_at_us.is_none()
                    && prefixes.iter().any(|x| p.slug.starts_with(x.as_str()))
            })
            .map(|p| p.slug)
            .collect();
        out.sort();
        Ok(out)
    }

    /// `readAccessPolicyMarks(sourceId, operationId?)`.
    pub fn read_access_policy_marks(
        &self,
        source_id: &str,
        operation_id: Option<&str>,
    ) -> Result<AccessPolicyMarks> {
        let read = self.read()?;
        let all = revisions(&*read, source_id)?;
        let applied = all
            .iter()
            .filter(|r| r.is_applied())
            .map(|r| r.revision)
            .max();
        let approved = all
            .iter()
            .filter(|r| r.approved_at_us.is_some())
            .map(|r| r.revision)
            .max();
        let operation = operation_id.map(|op| {
            all.into_iter()
                .find(|r| r.operation_id.as_deref() == Some(op))
                .map(|r| {
                    let row = revision_row(r);
                    AccessOperationMarks {
                        revision: row.revision,
                        applied_at: row.applied_at,
                        approved_at: row.approved_at,
                    }
                })
        });
        Ok(AccessPolicyMarks {
            applied,
            approved,
            operation,
        })
    }

    /// `replaceAccessInvalidCoverage(sourceId, prefixes, detail)`: replaces the source's invalid
    /// prefixes with `prefixes`, each with `detail`. A prefix listed twice refuses
    /// (`constraint_violation`) and changes nothing.
    pub fn replace_access_invalid_coverage(
        &self,
        source_id: &str,
        prefixes: &[String],
        detail: &Value,
    ) -> Result<()> {
        for p in prefixes {
            check_coverage_prefix("replaceAccessInvalidCoverage", p)?;
        }
        self.write(|tx| {
            let mut invalid_keys = Vec::new();
            each(
                &*tx,
                &source_prefix(COVERAGE, source_id),
                |c: PendingCoverageRecord| {
                    if c.reason == "invalid" {
                        invalid_keys.push(coverage_key(source_id, &c.prefix, &c.reason));
                    }
                    true
                },
            )?;
            for k in &invalid_keys {
                tx.delete(k)?;
            }
            for prefix in prefixes {
                require_state(&*tx, "replaceAccessInvalidCoverage", source_id)?;
                let k = coverage_key(source_id, prefix, "invalid");
                if tx.get(&k)?.is_some() {
                    return Err(constraint(format!(
                        "replaceAccessInvalidCoverage: prefix {prefix:?} listed twice"
                    )));
                }
                let row = PendingCoverageRecord {
                    source_id: source_id.into(),
                    prefix: prefix.clone(),
                    reason: "invalid".into(),
                    revision: None,
                    detail: Some(detail.clone()),
                };
                put_json(tx, &k, &row)?;
            }
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pages::{PageInput, PutPageOptions};
    use crate::test_support::store;

    fn page(s: &Store, slug: &str) {
        let input = PageInput {
            page_type: "note".into(),
            title: slug.into(),
            compiled_truth: "body".into(),
            ..PageInput::default()
        };
        s.put_page(slug, &input, &PutPageOptions::default())
            .unwrap();
    }

    fn revision(n: i64, digest: &str, op: Option<&str>) -> AccessRevisionInsert {
        AccessRevisionInsert {
            source_id: "default".into(),
            revision: n,
            rules: Value::Array(Vec::new()),
            digest: digest.into(),
            change_kind: "narrowing".into(),
            origin: "cli".into(),
            operation_id: op.map(Into::into),
            proposed_by: Some("local:test".into()),
            approved_by: None,
            approved: false,
        }
    }

    fn changes(insert: &[(&str, &str)], remove: &[&str], revision: i64) -> AccessRuleChanges {
        AccessRuleChanges {
            remove: remove.iter().map(|r| r.to_string()).collect(),
            insert: insert
                .iter()
                .map(|(id, prefix)| AccessRuleInsert {
                    rule_id: (*id).into(),
                    prefix: (*prefix).into(),
                    readable_by: vec!["member:alice-example".into()],
                    covers_derived: true,
                })
                .collect(),
            pending: insert.iter().map(|(_, p)| p.to_string()).collect(),
            revision,
            actor: "local:test".into(),
        }
    }

    #[test]
    fn a_revision_number_or_operation_id_recorded_once_refuses_a_second_write() {
        let s = store();
        s.ensure_access_policy_state("default").unwrap();
        s.insert_access_policy_revision(&revision(1, "a", Some("op-1")))
            .unwrap();
        let again = s
            .insert_access_policy_revision(&revision(1, "b", None))
            .unwrap_err();
        assert_eq!(again.code, CONSTRAINT_VIOLATION);
        let reused = s
            .insert_access_policy_revision(&revision(2, "c", Some("op-1")))
            .unwrap_err();
        assert_eq!(reused.code, CONSTRAINT_VIOLATION);
        let rows = s
            .read_access_policy_revisions(&AccessRevisionQuery::Recent {
                source_id: "default".into(),
                limit: 50,
            })
            .unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].digest, "a");
    }

    #[test]
    fn a_rule_change_refused_mid_way_leaves_no_partial_rule() {
        let s = store();
        s.ensure_access_policy_state("default").unwrap();
        s.apply_access_rule_changes("default", &changes(&[("team", "team/")], &[], 1))
            .unwrap();
        let refused = s
            .apply_access_rule_changes(
                "default",
                &changes(&[("fresh", "fresh/"), ("team", "other/")], &[], 2),
            )
            .unwrap_err();
        assert_eq!(refused.code, CONSTRAINT_VIOLATION);
        let rules = s.list_access_rules("default").unwrap();
        assert_eq!(rules.len(), 1);
        assert_eq!(rules[0].rule_id, "team");
        let coverage = s.list_access_coverage("default").unwrap();
        assert_eq!(coverage.len(), 1);
        assert_eq!(coverage[0].prefix, "team/");
    }

    #[test]
    fn restamp_counts_drifted_pages_and_finish_clears_pending_and_applies() {
        let s = store();
        page(&s, "team/plan");
        page(&s, "notes/open");
        s.ensure_access_policy_state("default").unwrap();
        s.insert_access_policy_revision(&revision(1, "a", None))
            .unwrap();
        s.apply_access_rule_changes("default", &changes(&[("team", "team/")], &[], 1))
            .unwrap();
        assert!(s.is_folder_restricted("default", "team/plan").unwrap());
        let w = s.restamp_access_window("default", 0, 1).unwrap();
        assert_eq!((w.scanned, w.changed), (1, 1));
        let w2 = s
            .restamp_access_window("default", w.last.unwrap(), 10)
            .unwrap();
        assert_eq!((w2.scanned, w2.changed), (1, 0));
        assert_eq!(s.finish_access_restamp("default").unwrap(), 0);
        assert!(s.list_access_coverage("default").unwrap().is_empty());
        let marks = s.read_access_policy_marks("default", None).unwrap();
        assert_eq!(marks.applied, Some(1));
        s.apply_access_rule_changes("default", &changes(&[], &["team"], 2))
            .unwrap();
        assert_eq!(s.finish_access_restamp("default").unwrap(), 1);
        assert!(!s.is_folder_restricted("default", "team/plan").unwrap());
    }

    #[test]
    fn a_page_written_or_renamed_under_a_rule_is_stamped_in_its_write() {
        let s = store();
        page(&s, "notes/open");
        s.ensure_access_policy_state("default").unwrap();
        s.insert_access_policy_revision(&revision(1, "a", None))
            .unwrap();
        s.apply_access_rule_changes("default", &changes(&[("team", "team/")], &[], 1))
            .unwrap();
        assert_eq!(s.finish_access_restamp("default").unwrap(), 0);
        page(&s, "team/new");
        page(&s, "team/new");
        page(&s, "notes/later");
        assert_eq!(s.finish_access_restamp("default").unwrap(), 0);
        s.update_slug("notes/open", "team/moved", Some("default"))
            .unwrap();
        s.update_slug("team/new", "notes/out", Some("default"))
            .unwrap();
        assert_eq!(s.finish_access_restamp("default").unwrap(), 0);
    }

    #[test]
    fn page_prefixes_cover_only_the_page_they_name() {
        let s = store();
        s.ensure_access_policy_state("default").unwrap();
        s.apply_access_rule_changes("default", &changes(&[("one", "notes/secret")], &[], 1))
            .unwrap();
        s.finish_access_restamp("default").unwrap();
        assert!(s.is_folder_restricted("default", "notes/secret").unwrap());
        assert!(!s.is_folder_restricted("default", "notes/secret-2").unwrap());
        assert!(!s.is_folder_restricted("default", "notes/secret/x").unwrap());
    }

    #[test]
    fn invalid_coverage_replaces_and_clears() {
        let s = store();
        s.ensure_access_policy_state("default").unwrap();
        let detail = serde_json::json!({ "error": "bad" });
        s.replace_access_invalid_coverage("default", &["".into()], &detail)
            .unwrap();
        assert!(s.is_folder_restricted("default", "anything").unwrap());
        assert!(
            s.replace_access_invalid_coverage("default", &["a/".into(), "a/".into()], &detail)
                .is_err()
        );
        assert_eq!(s.list_access_coverage("default").unwrap()[0].prefix, "");
        s.replace_access_invalid_coverage("default", &[], &detail)
            .unwrap();
        assert!(s.list_access_coverage("default").unwrap().is_empty());
    }
}
