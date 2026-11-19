//! Trust decisions: the `trust_proposals` table (src/core/trust/schema.ts, engine-sql/trust-proposals.ts).
//!
//! A proposal is a decision a trust guard files for the owner: a lower-tier fact that would
//! supersede a higher-tier one, a row a remote caller asked to forget, a page an agent edit
//! lowered. `target` is the row the decision changes, `related` the row that caused it. Keys:
//! - `t 0x06 id` (8 bytes, big-endian) -> [`ProposalRecord`].
//! - `t 0x07 action \0 target_table \0 target_id \0 related_table \0 related_id` -> the id of the
//!   pending proposal: the table's partial unique index (`status = 'pending'`, related read as
//!   `''` and `0` when absent). A status change away from `pending` removes it.
//! - `t 0x08 table \0 row_id proposal_id` (both ids 8 bytes, big-endian) -> empty: every proposal
//!   that names a row as target or related, for [`Store::pending_trust_proposals_for`] and the
//!   fence guard's held arm ([`held_narrower`]).
//!
//! Ids come from the `trust_proposals` counter and start at 1. An insert that meets a pending
//! proposal of the same key still takes an id, as the `BIGSERIAL` default does before
//! `ON CONFLICT DO NOTHING` decides. Deleting a source removes its proposals (`ON DELETE CASCADE`,
//! [`remove_source_rows`]).
//!
//! Gaps: the proposer principal and write request (`proposer_principal_kind`,
//! `proposer_principal_id`, `write_request_id`) are NULL, because the store's write trust context
//! does not carry the attribution settings PGLite reads them from. `lock` (`FOR UPDATE`) needs
//! nothing: the store has one writer.

use crate::env::{iso, parse_iso};
use crate::error::{CONSTRAINT_VIOLATION, Result, STORE_CORRUPT, StoreError};
use crate::kv::{KvRead, KvWrite, scan_prefix};
use crate::links::no_nul;
use crate::pages::next_id;
use crate::sources::require_source;
use crate::trust::TrustTable;
use crate::{Store, get_json, keys, put_json};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

const PROPOSAL: u8 = 0x06;
const PENDING: u8 = 0x07;
const BY_ROW: u8 = 0x08;

/// The table's `action` CHECK (`TRUST_PROPOSAL_ACTIONS`).
const ACTIONS: [&str; 5] = [
    "supersede_fact",
    "supersede_take",
    "forget",
    "lower_page",
    "confirm",
];
/// The table's `status` CHECK (`TRUST_PROPOSAL_STATUSES`).
const STATUSES: [&str; 5] = ["pending", "accepted", "rejected", "undone", "superseded"];
/// The statuses a status change stamps `decided_at` for.
const DECIDED: [&str; 3] = ["accepted", "rejected", "undone"];

/// A row a proposal names: its table and id.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProposalRow {
    pub table: String,
    pub id: i64,
}

/// `NewTrustProposal`.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct NewProposal {
    pub action: String,
    pub source_id: String,
    pub target: ProposalRow,
    #[serde(default)]
    pub related: Option<ProposalRow>,
    pub before: Value,
    #[serde(default)]
    pub after: Option<Value>,
    pub proposer: String,
}

/// `TrustProposalFilter`, with the limit already clamped and `since` as ISO text.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ProposalFilter {
    pub status: Option<String>,
    pub source_id: Option<String>,
    pub action: Option<String>,
    pub since: Option<String>,
    pub limit: Option<i64>,
}

/// The decider a status change records.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Decider {
    pub kind: String,
    pub id: String,
}

/// What is stored for a proposal.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct ProposalRecord {
    id: u64,
    action: String,
    source_id: String,
    target_table: String,
    target_id: i64,
    related_table: Option<String>,
    related_id: Option<i64>,
    before_state: Value,
    after_state: Value,
    proposer: String,
    status: String,
    decided_at_us: Option<i64>,
    decided_principal_kind: Option<String>,
    decided_principal_id: Option<String>,
    created_at_us: i64,
    updated_at_us: i64,
}

impl ProposalRecord {
    /// The row as `SELECT *` reads it; the principal and request columns are NULL (module docs).
    fn to_row(&self) -> Value {
        json!({
            "id": self.id,
            "action": self.action,
            "source_id": self.source_id,
            "target_table": self.target_table,
            "target_id": self.target_id,
            "related_table": self.related_table,
            "related_id": self.related_id,
            "before_state": self.before_state,
            "after_state": self.after_state,
            "proposer": self.proposer,
            "proposer_principal_kind": Value::Null,
            "proposer_principal_id": Value::Null,
            "write_request_id": Value::Null,
            "status": self.status,
            "decided_at": self.decided_at_us.map(iso),
            "decided_principal_kind": self.decided_principal_kind,
            "decided_principal_id": self.decided_principal_id,
            "created_at": iso(self.created_at_us),
            "updated_at": iso(self.updated_at_us),
        })
    }

    fn pending_key(&self) -> Vec<u8> {
        pending_key(
            &self.action,
            &self.target_table,
            self.target_id,
            self.related_table.as_deref(),
            self.related_id,
        )
    }

    fn names(&self, table: &str, id: i64) -> bool {
        (self.target_table == table && self.target_id == id)
            || (self.related_table.as_deref() == Some(table) && self.related_id == Some(id))
    }
}

fn by_id(id: u64) -> Vec<u8> {
    let mut key = vec![keys::TRUST, PROPOSAL];
    key.extend_from_slice(&id.to_be_bytes());
    key
}

fn pending_key(
    action: &str,
    target_table: &str,
    target_id: i64,
    related_table: Option<&str>,
    related_id: Option<i64>,
) -> Vec<u8> {
    let (target, related) = (target_id.to_string(), related_id.unwrap_or(0).to_string());
    let mut key = keys::text(
        keys::TRUST,
        &[
            action,
            target_table,
            &target,
            related_table.unwrap_or(""),
            &related,
        ],
    );
    key.insert(1, PENDING);
    key
}

fn row_prefix(table: &str, row_id: i64) -> Vec<u8> {
    let mut key = keys::text(keys::TRUST, &[table, ""]);
    key.insert(1, BY_ROW);
    key.extend_from_slice(&row_id.to_be_bytes());
    key
}

fn row_key(table: &str, row_id: i64, id: u64) -> Vec<u8> {
    let mut key = row_prefix(table, row_id);
    key.extend_from_slice(&id.to_be_bytes());
    key
}

fn corrupt(what: &str) -> StoreError {
    StoreError::new(STORE_CORRUPT, format!("trust proposal {what}"))
}

fn read_record(read: &dyn KvRead, id: u64) -> Result<Option<ProposalRecord>> {
    get_json(read, &by_id(id))
}

/// The ids of the proposals that name `(table, row_id)` as target or related, ascending.
fn ids_naming(read: &dyn KvRead, table: &str, row_id: i64) -> Result<Vec<u64>> {
    let prefix = row_prefix(table, row_id);
    let mut ids = Vec::new();
    let mut bad = false;
    scan_prefix(read, &prefix, false, &mut |k, _| {
        match keys::be8(&k[prefix.len()..]) {
            Some(id) => ids.push(id),
            None => bad = true,
        }
        !bad
    })?;
    if bad {
        return Err(corrupt("row index entry is malformed"));
    }
    ids.dedup();
    Ok(ids)
}

fn all_records(read: &dyn KvRead) -> Result<Vec<ProposalRecord>> {
    let mut out = Vec::new();
    let mut failure = None;
    scan_prefix(read, &[keys::TRUST, PROPOSAL], false, &mut |_, v| {
        match serde_json::from_slice::<ProposalRecord>(v) {
            Ok(record) => out.push(record),
            Err(e) => failure = Some(StoreError::from(e)),
        }
        failure.is_none()
    })?;
    failure.map_or(Ok(out), Err)
}

fn one_of(op: &str, name: &str, value: &str, allowed: &[&str]) -> Result<()> {
    if allowed.contains(&value) {
        Ok(())
    } else {
        Err(StoreError::invalid(format!(
            "{op}: {name} must be one of {}, not \"{value}\"",
            allowed.join(", ")
        )))
    }
}

fn trust_table(op: &str, name: &str, value: &str) -> Result<()> {
    TrustTable::parse(value).map(|_| ()).ok_or_else(|| {
        StoreError::invalid(format!(
            "{op}: {name} must be a trust table, not \"{value}\""
        ))
    })
}

/// Postgres `jsonb` refuses the `\u0000` escape anywhere in the document.
fn json_no_nul(op: &str, name: &str, value: &Value) -> Result<()> {
    let bad = |s: &str| s.contains('\0');
    let found = match value {
        Value::String(s) => bad(s),
        Value::Array(items) => {
            for item in items {
                json_no_nul(op, name, item)?;
            }
            false
        }
        Value::Object(map) => {
            for (k, v) in map {
                if bad(k) {
                    return Err(StoreError::invalid(format!(
                        "{op}: {name} must not contain a NUL character"
                    )));
                }
                json_no_nul(op, name, v)?;
            }
            false
        }
        _ => false,
    };
    if found {
        return Err(StoreError::invalid(format!(
            "{op}: {name} must not contain a NUL character"
        )));
    }
    Ok(())
}

fn put_record(tx: &mut dyn KvWrite, record: &ProposalRecord) -> Result<()> {
    put_json(tx, &by_id(record.id), record)
}

/// Removes every proposal of a deleted source and its index entries (`ON DELETE CASCADE`).
pub(crate) fn remove_source_rows(tx: &mut dyn KvWrite, source_id: &str) -> Result<()> {
    for record in all_records(tx)? {
        if record.source_id != source_id {
            continue;
        }
        if record.status == "pending" {
            let key = record.pending_key();
            if get_id(tx, &key)? == Some(record.id) {
                tx.delete(&key)?;
            }
        }
        tx.delete(&row_key(&record.target_table, record.target_id, record.id))?;
        if let (Some(table), Some(id)) = (&record.related_table, record.related_id) {
            tx.delete(&row_key(table, id, record.id))?;
        }
        tx.delete(&by_id(record.id))?;
    }
    Ok(())
}

fn get_id(read: &dyn KvRead, key: &[u8]) -> Result<Option<u64>> {
    match read.get(key)? {
        None => Ok(None),
        Some(bytes) => keys::be8(&bytes)
            .map(Some)
            .ok_or_else(|| corrupt("pending index entry is malformed")),
    }
}

/// The fence guard's held arm for one fact (engine-sql/trust-fence.ts `listFenceFactRows`): a
/// `supersede_fact` or `confirm` proposal names it as `related`, is pending, rejected or undone,
/// and its before state has a `visibility` key (`before_state->'visibility' IS NOT NULL`: a JSON
/// `null` value counts, a missing key or a before state that is no object does not).
pub(crate) fn held_narrower(read: &dyn KvRead, fact_id: u64) -> Result<bool> {
    let Ok(row_id) = i64::try_from(fact_id) else {
        return Ok(false);
    };
    for id in ids_naming(read, "facts", row_id)? {
        let Some(p) = read_record(read, id)? else {
            return Err(corrupt("row index entry without its row"));
        };
        if matches!(p.action.as_str(), "supersede_fact" | "confirm")
            && p.related_table.as_deref() == Some("facts")
            && p.related_id == Some(row_id)
            && matches!(p.status.as_str(), "pending" | "rejected" | "undone")
            && p.before_state
                .as_object()
                .is_some_and(|state| state.contains_key("visibility"))
        {
            return Ok(true);
        }
    }
    Ok(false)
}

impl Store {
    /// `insertTrustProposal(input)`: inserts a pending proposal and returns `{ id, created: true }`,
    /// or returns the pending proposal already recorded for the same action, target and related
    /// row with `created: false`.
    pub fn insert_trust_proposal(&self, input: &NewProposal) -> Result<Value> {
        let op = "insertTrustProposal";
        no_nul(
            op,
            &[
                ("action", input.action.as_str()),
                ("source_id", input.source_id.as_str()),
                ("target_table", input.target.table.as_str()),
                ("proposer", input.proposer.as_str()),
            ],
        )?;
        one_of(op, "action", &input.action, &ACTIONS)?;
        trust_table(op, "target_table", &input.target.table)?;
        if let Some(related) = &input.related {
            no_nul(op, &[("related_table", related.table.as_str())])?;
            trust_table(op, "related_table", &related.table)?;
        }
        let after = input
            .after
            .clone()
            .unwrap_or_else(|| Value::Object(Map::new()));
        json_no_nul(op, "before_state", &input.before)?;
        json_no_nul(op, "after_state", &after)?;
        let now = self.env.now_micros();
        self.write(|tx| {
            let id = next_id(tx, "trust_proposals")?;
            let record = ProposalRecord {
                id,
                action: input.action.clone(),
                source_id: input.source_id.clone(),
                target_table: input.target.table.clone(),
                target_id: input.target.id,
                related_table: input.related.as_ref().map(|r| r.table.clone()),
                related_id: input.related.as_ref().map(|r| r.id),
                before_state: input.before.clone(),
                after_state: after.clone(),
                proposer: input.proposer.clone(),
                status: "pending".into(),
                decided_at_us: None,
                decided_principal_kind: None,
                decided_principal_id: None,
                created_at_us: now,
                updated_at_us: now,
            };
            let pending = record.pending_key();
            if let Some(existing) = get_id(tx, &pending)? {
                return Ok(json!({ "id": existing, "created": false }));
            }
            require_source(tx, &input.source_id)?;
            tx.put(&pending, &id.to_be_bytes())?;
            tx.put(&row_key(&record.target_table, record.target_id, id), &[])?;
            if let (Some(table), Some(row)) = (&record.related_table, record.related_id) {
                tx.put(&row_key(table, row, id), &[])?;
            }
            put_record(tx, &record)?;
            Ok(json!({ "id": id, "created": true }))
        })
    }

    /// `getTrustProposal(id)`: the proposal's row, or `None`.
    pub fn get_trust_proposal(&self, id: i64) -> Result<Option<Value>> {
        let Ok(id) = u64::try_from(id) else {
            return Ok(None);
        };
        let read = self.read()?;
        Ok(read_record(&*read, id)?.map(|r| r.to_row()))
    }

    /// `listTrustProposals(filter)`: by status (`pending` when absent; `all` for every status),
    /// source, action and `created_at >= since`, by creation time and then id, at most `limit`.
    pub fn list_trust_proposals(&self, filter: &ProposalFilter) -> Result<Vec<Value>> {
        let op = "listTrustProposals";
        let status = filter.status.as_deref().unwrap_or("pending");
        let since = match filter.since.as_deref() {
            None => None,
            Some(text) => Some(parse_iso(text).ok_or_else(|| {
                StoreError::invalid(format!("{op}: since is not an ISO timestamp: {text}"))
            })?),
        };
        let limit = usize::try_from(filter.limit.unwrap_or(500).clamp(1, 5000)).unwrap_or(500);
        let read = self.read()?;
        let mut rows: Vec<ProposalRecord> = all_records(&*read)?
            .into_iter()
            .filter(|p| status == "all" || p.status == status)
            .filter(|p| filter.source_id.as_ref().is_none_or(|s| &p.source_id == s))
            .filter(|p| filter.action.as_ref().is_none_or(|a| &p.action == a))
            .filter(|p| since.is_none_or(|t| p.created_at_us >= t))
            .collect();
        rows.sort_by_key(|p| (p.created_at_us, p.id));
        Ok(rows
            .iter()
            .take(limit)
            .map(ProposalRecord::to_row)
            .collect())
    }

    /// `pendingTrustProposalsFor(table, id)`: the pending proposals naming the row as target or
    /// related, by id.
    pub fn pending_trust_proposals_for(&self, table: &str, row_id: i64) -> Result<Vec<Value>> {
        no_nul("pendingTrustProposalsFor", &[("table", table)])?;
        let read = self.read()?;
        let mut out = Vec::new();
        for id in ids_naming(&*read, table, row_id)? {
            let p = read_record(&*read, id)?
                .ok_or_else(|| corrupt("row index entry without its row"))?;
            if p.status == "pending" && p.names(table, row_id) {
                out.push(p.to_row());
            }
        }
        Ok(out)
    }

    /// `updatePendingTrustProposalAfter(id, after)`: replaces a pending proposal's after state and
    /// stamps `updated_at`; any other proposal is left alone.
    pub fn update_pending_trust_proposal_after(&self, id: i64, after: &Value) -> Result<()> {
        json_no_nul("updatePendingTrustProposalAfter", "after_state", after)?;
        let Ok(id) = u64::try_from(id) else {
            return Ok(());
        };
        let now = self.env.now_micros();
        self.write(|tx| {
            if let Some(mut p) = read_record(tx, id)?
                && p.status == "pending"
            {
                p.after_state = after.clone();
                p.updated_at_us = now;
                put_record(tx, &p)?;
            }
            Ok(())
        })
    }

    /// `transitionTrustProposal(id, from, to, { after, decidedBy })`: when the proposal is in
    /// `from`, sets `to`, stamps `updated_at` (and `decided_at` for accepted, rejected and undone),
    /// replaces the after state when one is given and records the decider when one is given.
    /// False when the proposal is missing or not in `from`.
    pub fn transition_trust_proposal(
        &self,
        id: i64,
        from: &str,
        to: &str,
        after: Option<&Value>,
        decided_by: Option<&Decider>,
    ) -> Result<bool> {
        let op = "transitionTrustProposal";
        no_nul(op, &[("from", from), ("to", to)])?;
        if let Some(after) = after {
            json_no_nul(op, "after_state", after)?;
        }
        if let Some(d) = decided_by {
            no_nul(
                op,
                &[
                    ("decided_principal_kind", d.kind.as_str()),
                    ("decided_principal_id", d.id.as_str()),
                ],
            )?;
        }
        let Ok(id) = u64::try_from(id) else {
            return Ok(false);
        };
        let now = self.env.now_micros();
        self.write(|tx| {
            let Some(mut p) = read_record(tx, id)? else {
                return Ok(false);
            };
            if p.status != from {
                return Ok(false);
            }
            one_of(op, "status", to, &STATUSES)?;
            let key = p.pending_key();
            if from == "pending" && to != "pending" && get_id(tx, &key)? == Some(id) {
                tx.delete(&key)?;
            }
            if from != "pending" && to == "pending" {
                if get_id(tx, &key)?.is_some_and(|other| other != id) {
                    return Err(StoreError::new(
                        CONSTRAINT_VIOLATION,
                        "duplicate key value violates the pending trust proposal unique index",
                    ));
                }
                tx.put(&key, &id.to_be_bytes())?;
            }
            p.status = to.to_string();
            p.updated_at_us = now;
            if let Some(after) = after {
                p.after_state = after.clone();
            }
            if DECIDED.contains(&to) {
                p.decided_at_us = Some(now);
            }
            if let Some(d) = decided_by {
                p.decided_principal_kind = Some(d.kind.clone());
                p.decided_principal_id = Some(d.id.clone());
            }
            put_record(tx, &p)?;
            Ok(true)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::store;

    fn proposal(action: &str, target: i64, related: Option<i64>, before: Value) -> NewProposal {
        NewProposal {
            action: action.into(),
            source_id: "default".into(),
            target: ProposalRow {
                table: "facts".into(),
                id: target,
            },
            related: related.map(|id| ProposalRow {
                table: "facts".into(),
                id,
            }),
            before,
            after: None,
            proposer: "fence_projection".into(),
        }
    }

    fn id_of(v: &Value) -> (u64, bool) {
        (v["id"].as_u64().unwrap(), v["created"].as_bool().unwrap())
    }

    #[test]
    fn a_second_pending_insert_returns_the_first_and_still_takes_an_id() {
        let s = store();
        let first = s
            .insert_trust_proposal(&proposal("forget", 7, None, json!({})))
            .unwrap();
        let again = s
            .insert_trust_proposal(&proposal("forget", 7, None, json!({})))
            .unwrap();
        let other = s
            .insert_trust_proposal(&proposal("forget", 8, None, json!({})))
            .unwrap();
        assert_eq!(
            (id_of(&first), id_of(&again), id_of(&other)),
            ((1, true), (1, false), (3, true))
        );
        assert!(
            s.transition_trust_proposal(1, "pending", "rejected", None, None)
                .unwrap()
        );
        let after = s
            .insert_trust_proposal(&proposal("forget", 7, None, json!({})))
            .unwrap();
        assert_eq!(id_of(&after), (4, true));
        assert_eq!(s.pending_trust_proposals_for("facts", 7).unwrap().len(), 1);
        assert!(
            !s.transition_trust_proposal(1, "pending", "accepted", None, None)
                .unwrap()
        );
        let err = s
            .transition_trust_proposal(1, "rejected", "pending", None, None)
            .unwrap_err();
        assert_eq!(err.code, CONSTRAINT_VIOLATION);
    }

    #[test]
    fn a_held_fact_needs_a_widening_proposal_with_a_visibility_before_state() {
        let s = store();
        s.insert_trust_proposal(&proposal(
            "supersede_fact",
            1,
            Some(2),
            json!({ "visibility": null }),
        ))
        .unwrap();
        s.insert_trust_proposal(&proposal(
            "supersede_fact",
            1,
            Some(3),
            json!({ "tier": "agent_written" }),
        ))
        .unwrap();
        s.insert_trust_proposal(&proposal(
            "forget",
            4,
            Some(5),
            json!({ "visibility": "private" }),
        ))
        .unwrap();
        let read = s.read().unwrap();
        let held: Vec<bool> = (1..=5)
            .map(|id| held_narrower(&*read, id).unwrap())
            .collect();
        assert_eq!(held, vec![false, true, false, false, false]);
        drop(read);
        assert!(
            s.transition_trust_proposal(1, "pending", "accepted", None, None)
                .unwrap()
        );
        assert!(!held_narrower(&*s.read().unwrap(), 2).unwrap());
    }

    #[test]
    fn a_bad_action_table_or_source_is_refused_and_writes_nothing() {
        let s = store();
        assert!(
            s.insert_trust_proposal(&proposal("delete", 1, None, json!({})))
                .is_err()
        );
        let mut bad = proposal("forget", 1, None, json!({}));
        bad.target.table = "links".into();
        assert!(s.insert_trust_proposal(&bad).is_err());
        let mut missing = proposal("forget", 1, None, json!({}));
        missing.source_id = "nowhere".into();
        assert!(s.insert_trust_proposal(&missing).is_err());
        assert!(
            s.insert_trust_proposal(&proposal("forget", 1, None, json!({ "a": "x\u{0}" })))
                .is_err()
        );
        assert!(
            s.list_trust_proposals(&ProposalFilter {
                status: Some("all".into()),
                ..Default::default()
            })
            .unwrap()
            .is_empty()
        );
    }
}
