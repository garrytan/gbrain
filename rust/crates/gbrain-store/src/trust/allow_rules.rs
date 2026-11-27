//! The owner's write-gate allow rules: `trust_allow_rules` (src/core/trust/allow-rules.ts). A rule
//! lets the write gate accept a source's content (by URI prefix and reason family) that it would
//! otherwise quarantine. Removing a rule keeps its row as the receipt (`removed_at`, `removed_by`).
//!
//! Keys:
//! - `t 0x0f id` (8 bytes, big-endian) -> [`AllowRuleRecord`], every rule, active or removed.
//! - `t 0x10 source \0 uri_prefix \0 reason_family` -> the active rule's id: the partial unique
//!   index `trust_allow_rules_active_unique` on `(source_id, COALESCE(uri_prefix, ''),
//!   COALESCE(reason_family, '')) WHERE removed_at IS NULL`. Removing a rule deletes its entry.
//!
//! Ids come from the `trust_allow_rules` counter and start at 1 (`BIGSERIAL`). The rows reference
//! `sources` with `ON DELETE CASCADE`, so a source delete removes its rules
//! ([`remove_source_rows`]). The family came in at store format 8 without a format bump: an
//! older build at the same format ignores these keys, applies no allow rule and so screens
//! stricter, never looser (rust/docs/store/format.md).

use crate::env::iso;
use crate::error::{CONSTRAINT_VIOLATION, Result, STORE_CORRUPT, StoreError};
use crate::kv::{KvRead, KvWrite, scan_prefix};
use crate::links::no_nul;
use crate::pages::next_id;
use crate::sources::{read_source, require_source};
use crate::{Store, get_json, keys, put_json};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

const RULE: u8 = 0x0f;
const ACTIVE: u8 = 0x10;
/// The id counter, as Postgres' `trust_allow_rules_id_seq`.
pub(crate) const COUNTER: &str = "trust_allow_rules";

/// The table's `reason_family` CHECK (allow-rules.ts `TRUST_ALLOW_REASON_FAMILIES`).
const REASON_FAMILIES: [&str; 4] = [
    "override",
    "standing_instruction",
    "exfiltration",
    "credential",
];

/// One stored rule.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AllowRuleRecord {
    pub id: u64,
    pub source_id: String,
    pub uri_prefix: Option<String>,
    pub reason_family: Option<String>,
    pub created_by: String,
    pub created_at_us: i64,
    pub removed_at_us: Option<i64>,
    pub removed_by: Option<String>,
    pub reason: Option<String>,
}

impl AllowRuleRecord {
    /// The row as `SELECT * FROM trust_allow_rules` returns it, times as ISO text.
    pub fn to_row(&self) -> Value {
        json!({
            "id": self.id,
            "source_id": self.source_id,
            "uri_prefix": self.uri_prefix,
            "reason_family": self.reason_family,
            "created_by": self.created_by,
            "created_at": iso(self.created_at_us),
            "removed_at": self.removed_at_us.map(iso),
            "removed_by": self.removed_by,
            "reason": self.reason,
        })
    }

    fn active_key(&self) -> Vec<u8> {
        active_key(
            &self.source_id,
            self.uri_prefix.as_deref(),
            self.reason_family.as_deref(),
        )
    }
}

/// The input of `addTrustAllowRule`, after allow-rules.ts normalized it.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewAllowRule {
    pub source_id: String,
    pub uri_prefix: Option<String>,
    pub reason_family: Option<String>,
    pub created_by: String,
    pub reason: Option<String>,
}

fn by_id(id: u64) -> Vec<u8> {
    let mut key = vec![keys::TRUST, RULE];
    key.extend_from_slice(&id.to_be_bytes());
    key
}

fn active_key(source_id: &str, uri_prefix: Option<&str>, reason_family: Option<&str>) -> Vec<u8> {
    let mut key = keys::text(
        keys::TRUST,
        &[
            source_id,
            uri_prefix.unwrap_or(""),
            reason_family.unwrap_or(""),
        ],
    );
    key.insert(1, ACTIVE);
    key
}

fn read_record(read: &dyn KvRead, id: u64) -> Result<Option<AllowRuleRecord>> {
    get_json(read, &by_id(id))
}

fn active_id(read: &dyn KvRead, key: &[u8]) -> Result<Option<u64>> {
    match read.get(key)? {
        None => Ok(None),
        Some(bytes) => keys::be8(&bytes).map(Some).ok_or_else(|| {
            StoreError::new(
                STORE_CORRUPT,
                "trust allow rule active index entry is malformed",
            )
        }),
    }
}

fn all_records(read: &dyn KvRead) -> Result<Vec<AllowRuleRecord>> {
    let mut out = Vec::new();
    let mut failure = None;
    scan_prefix(read, &[keys::TRUST, RULE], false, &mut |_, v| {
        match serde_json::from_slice::<AllowRuleRecord>(v) {
            Ok(record) => out.push(record),
            Err(e) => failure = Some(StoreError::from(e)),
        }
        failure.is_none()
    })?;
    failure.map_or(Ok(out), Err)
}

/// The table's CHECK constraints and the text columns' NUL refusal, as Postgres raises them.
fn check(op: &str, rule: &AllowRuleRecord) -> Result<()> {
    let mut texts = vec![
        ("source_id", rule.source_id.as_str()),
        ("created_by", rule.created_by.as_str()),
    ];
    for (name, value) in [
        ("uri_prefix", &rule.uri_prefix),
        ("reason_family", &rule.reason_family),
        ("removed_by", &rule.removed_by),
        ("reason", &rule.reason),
    ] {
        if let Some(v) = value {
            texts.push((name, v.as_str()));
        }
    }
    no_nul(op, &texts)?;
    let violation = |name: &str| {
        StoreError::new(
            CONSTRAINT_VIOLATION,
            format!(
                "new row for relation \"trust_allow_rules\" violates check constraint \"trust_allow_rules_{name}_check\""
            ),
        )
    };
    if let Some(prefix) = &rule.uri_prefix {
        let n = prefix.chars().count();
        if !(1..=2048).contains(&n) {
            return Err(violation("uri_prefix"));
        }
    }
    if let Some(family) = &rule.reason_family
        && !REASON_FAMILIES.contains(&family.as_str())
    {
        return Err(violation("reason_family"));
    }
    if rule
        .reason
        .as_ref()
        .is_some_and(|r| r.chars().count() > 500)
    {
        return Err(violation("reason"));
    }
    Ok(())
}

/// Removes every rule of a deleted source with its active index entry (`ON DELETE CASCADE`).
pub(crate) fn remove_source_rows(tx: &mut dyn KvWrite, source_id: &str) -> Result<()> {
    for record in all_records(tx)? {
        if record.source_id == source_id {
            delete_record(tx, &record)?;
        }
    }
    Ok(())
}

fn delete_record(tx: &mut dyn KvWrite, record: &AllowRuleRecord) -> Result<()> {
    if record.removed_at_us.is_none() {
        let key = record.active_key();
        if active_id(tx, &key)? == Some(record.id) {
            tx.delete(&key)?;
        }
    }
    tx.delete(&by_id(record.id))
}

/// The shadow seed: stores `record`, a rule copied from another engine with its own id, times and
/// receipt, with the active index entry when it is not removed. `false` when the id already holds a
/// rule; the active key held by another id is the partial unique index violation.
pub(crate) fn seed_rule(tx: &mut dyn KvWrite, record: &AllowRuleRecord) -> Result<bool> {
    const OP: &str = "shadow_seed trust_allow_rules";
    if read_record(&*tx, record.id)?.is_some() {
        return Ok(false);
    }
    check(OP, record)?;
    require_source(tx, &record.source_id)?;
    if record.removed_at_us.is_none() {
        let key = record.active_key();
        if active_id(&*tx, &key)?.is_some() {
            return Err(StoreError::new(
                CONSTRAINT_VIOLATION,
                "duplicate key value violates unique constraint \"trust_allow_rules_active_unique\"",
            ));
        }
        tx.put(&key, &record.id.to_be_bytes())?;
    }
    put_json(tx, &by_id(record.id), record)?;
    Ok(true)
}

/// The shadow follow: removes the rule `id` with its active index entry. `false` when there is none.
pub(crate) fn remove_rule(tx: &mut dyn KvWrite, id: u64) -> Result<bool> {
    let Some(record) = read_record(&*tx, id)? else {
        return Ok(false);
    };
    delete_record(tx, &record)?;
    Ok(true)
}

impl Store {
    /// `addTrustAllowRule(rule)`: when the source is not an active source, `{ source_active: false,
    /// row: null, created: false }` and nothing is written. Otherwise inserts the rule and returns
    /// it with `created: true`, or, when an active rule already holds the same (source, prefix,
    /// family), returns that rule with `created: false` (`ON CONFLICT DO NOTHING`, then the lowest
    /// id of the active rules with that key). A repeated add uses up one id, as the sequence does. A
    /// CHECK refusal rolls back and takes no id (Postgres' sequence would still use one up).
    pub fn add_trust_allow_rule(&self, input: &NewAllowRule) -> Result<Value> {
        const OP: &str = "addTrustAllowRule";
        let now = self.env.now_micros();
        self.write(|tx| {
            let active = read_source(&*tx, &input.source_id)?.is_some_and(|s| !s.archived);
            if !active {
                return Ok(json!({ "source_active": false, "row": null, "created": false }));
            }
            let mut record = AllowRuleRecord {
                id: 0,
                source_id: input.source_id.clone(),
                uri_prefix: input.uri_prefix.clone(),
                reason_family: input.reason_family.clone(),
                created_by: input.created_by.clone(),
                created_at_us: now,
                removed_at_us: None,
                removed_by: None,
                reason: input.reason.clone(),
            };
            check(OP, &record)?;
            let key = record.active_key();
            // Postgres draws the id (the column default) before ON CONFLICT DO NOTHING finds the active
            // rule, so a repeated add still uses up one id of the sequence.
            record.id = next_id(tx, COUNTER)?;
            if let Some(existing) = active_id(&*tx, &key)? {
                let row = read_record(&*tx, existing)?.ok_or_else(|| {
                    StoreError::new(STORE_CORRUPT, "trust allow rule active index names no rule")
                })?;
                return Ok(json!({ "source_active": true, "row": row.to_row(), "created": false }));
            }
            tx.put(&key, &record.id.to_be_bytes())?;
            put_json(tx, &by_id(record.id), &record)?;
            Ok(json!({ "source_active": true, "row": record.to_row(), "created": true }))
        })
    }

    /// `removeTrustAllowRule(id, removedBy)`: marks the active rule `id` removed now and returns
    /// it, or null when no active rule has that id. The row stays as the receipt.
    pub fn remove_trust_allow_rule(&self, id: u64, removed_by: &str) -> Result<Value> {
        no_nul("removeTrustAllowRule", &[("removed_by", removed_by)])?;
        let now = self.env.now_micros();
        self.write(|tx| {
            let Some(mut record) = read_record(&*tx, id)? else {
                return Ok(Value::Null);
            };
            if record.removed_at_us.is_some() {
                return Ok(Value::Null);
            }
            let key = record.active_key();
            if active_id(&*tx, &key)? == Some(id) {
                tx.delete(&key)?;
            }
            record.removed_at_us = Some(now);
            record.removed_by = Some(removed_by.to_string());
            put_json(tx, &by_id(id), &record)?;
            Ok(record.to_row())
        })
    }

    /// `readTrustAllowRule(id)`: the rule `id`, active or removed, or null.
    pub fn read_trust_allow_rule(&self, id: u64) -> Result<Value> {
        let read = self.read()?;
        Ok(read_record(&*read, id)?.map_or(Value::Null, |r| r.to_row()))
    }

    /// `listTrustAllowRuleRows({ sourceIds?, includeRemoved? })`: the rules by id, active only
    /// unless `include_removed`; `source_ids` empty or absent reads every source.
    pub fn list_trust_allow_rules(
        &self,
        source_ids: Option<&[String]>,
        include_removed: bool,
    ) -> Result<Vec<Value>> {
        let read = self.read()?;
        let sources = source_ids.filter(|s| !s.is_empty());
        Ok(all_records(&*read)?
            .into_iter()
            .filter(|r| include_removed || r.removed_at_us.is_none())
            .filter(|r| sources.is_none_or(|s| s.contains(&r.source_id)))
            .map(|r| r.to_row())
            .collect())
    }
}

#[cfg(test)]
mod tests;
