//! `gbrain edge-proposals` (src/commands/edge-proposals.ts): the command's own reads and writes of
//! the proposal rows of edge_proposals.rs, as the PGLite SQL of
//! src/core/engine-sql/contradictions-cycle.ts answers them.
//!
//! Members: listEdgeProposalCliRows, deleteHeldEdgeProposalErrors, listAppliedEdgeProposalIds,
//! deleteEdgeProposalError, readEdgeProposalSourceId and markEdgeProposalDated.
//!
//! A deleted proposal takes its evidence key with it, so the same evidence can be judged and
//! recorded again, as a deleted row frees its unique key.

use super::{ProposalRecord, all_proposals, id_arg, proposal_key, record_evidence_key};
use crate::env::iso;
use crate::error::{INVALID_ARGUMENT, Result, StoreError};
use crate::kv::KvWrite;
use crate::pages::read_page_by_id;
use crate::{Store, get_json, put_json};
use serde::Deserialize;
use serde_json::{Value, json};

/// `listEdgeProposalCliRows(filter, limit)`: the `EdgeProposalCliFilter` of the command.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum EdgeProposalCliFilter {
    /// `WHERE TRUE`.
    All,
    /// `p.status = ANY($1::text[])`.
    Statuses { statuses: Vec<String> },
    /// `p.id = $1`.
    Id { id: f64 },
    /// `p.id = $1 AND p.status = 'undated_unresolved'`.
    Undated { id: f64 },
}

impl EdgeProposalCliFilter {
    fn admits(&self, r: &ProposalRecord) -> bool {
        match self {
            Self::All => true,
            Self::Statuses { statuses } => statuses.contains(&r.status),
            Self::Id { id } => id_arg(*id) == Some(r.id),
            Self::Undated { id } => id_arg(*id) == Some(r.id) && r.status == "undated_unresolved",
        }
    }
}

/// `REAL` as Postgres prints it: the shortest decimal that reads back as the same `f32`, so 0.9
/// stays 0.9 rather than the `f64` widening of the stored `f32`.
fn real(value: f32) -> Value {
    format!("{value}")
        .parse::<f64>()
        .ok()
        .and_then(serde_json::Number::from_f64)
        .map_or(Value::Null, Value::Number)
}

/// Deletes one proposal and its evidence key.
fn delete_proposal(tx: &mut dyn KvWrite, r: &ProposalRecord) -> Result<()> {
    tx.delete(&proposal_key(r.id))?;
    tx.delete(&record_evidence_key(r))?;
    Ok(())
}

/// The ids, as `[{ id }]` in id order.
fn ids(rows: &[ProposalRecord]) -> Value {
    Value::Array(rows.iter().map(|r| json!({ "id": r.id })).collect())
}

impl Store {
    /// `listEdgeProposalCliRows(filter, limit)`: the proposals `filter` admits, newest
    /// `created_at` first and then the larger id, at most `limit` (1 to 1000). Each names its
    /// subject, both targets and its ending page by slug (`ending` null without one); a proposal
    /// whose subject or target page is gone is left out, as the inner joins do. `close_date` is
    /// its `YYYY-MM-DD` text and `created_at` an ISO string.
    pub fn list_edge_proposal_cli_rows(
        &self,
        filter: &EdgeProposalCliFilter,
        limit: f64,
    ) -> Result<Vec<Value>> {
        if limit.fract() != 0.0 || !(1.0..=1000.0).contains(&limit) {
            return Err(StoreError::new(
                INVALID_ARGUMENT,
                format!(
                    "listEdgeProposalCliRows: limit {limit} is not a whole number from 1 to 1000"
                ),
            ));
        }
        let read = self.read()?;
        let mut rows: Vec<ProposalRecord> = all_proposals(&*read)?
            .into_iter()
            .filter(|r| filter.admits(r))
            .collect();
        rows.sort_by(|x, y| y.created_at_us.cmp(&x.created_at_us).then(y.id.cmp(&x.id)));
        let slug = |id: u64| -> Result<Option<String>> {
            Ok(read_page_by_id(&*read, id)?.map(|p| p.slug))
        };
        let mut out = Vec::new();
        for r in rows {
            if out.len() as f64 >= limit {
                break;
            }
            let (Some(subject), Some(a_target), Some(b_target)) = (
                slug(r.from_page_id)?,
                slug(r.a_to_page_id)?,
                slug(r.b_to_page_id)?,
            ) else {
                continue;
            };
            let ending = match r.ending_to_page_id {
                Some(e) => slug(e)?,
                None => None,
            };
            out.push(json!({
                "id": r.id,
                "status": r.status,
                "link_type": r.link_type,
                "subject": subject,
                "a_target": a_target,
                "b_target": b_target,
                "ending": ending,
                "close_date": r.close_date,
                "born_closed": r.born_closed,
                "model": r.model,
                "confidence": r.confidence.map_or(Value::Null, real),
                "generated_line": r.generated_line,
                "created_at": iso(r.created_at_us),
            }));
        }
        Ok(out)
    }

    /// `deleteHeldEdgeProposalErrors()`: deletes the `error` proposals whose detail starts with
    /// `held after ` (`LIKE 'held after %'`); resolves `[{ id }]` in id order.
    pub fn delete_held_edge_proposal_errors(&self) -> Result<Value> {
        self.write(|tx| {
            let held: Vec<ProposalRecord> = all_proposals(&*tx)?
                .into_iter()
                .filter(|r| {
                    r.status == "error"
                        && r.detail
                            .as_deref()
                            .is_some_and(|d| d.starts_with("held after "))
                })
                .collect();
            for r in &held {
                delete_proposal(tx, r)?;
            }
            Ok(ids(&held))
        })
    }

    /// `listAppliedEdgeProposalIds()`: `[{ id }]` of the `applied` proposals in id order.
    pub fn list_applied_edge_proposal_ids(&self) -> Result<Value> {
        let applied: Vec<ProposalRecord> = all_proposals(&*self.read()?)?
            .into_iter()
            .filter(|r| r.status == "applied")
            .collect();
        Ok(ids(&applied))
    }

    /// `deleteEdgeProposalError(id)`: deletes the proposal while its status is `error`; resolves
    /// `[{ id }]`, `[]` when there is no such error row.
    pub fn delete_edge_proposal_error(&self, id: f64) -> Result<Value> {
        let Some(id) = id_arg(id) else {
            return Ok(Value::Array(Vec::new()));
        };
        self.write(|tx| {
            let Some(r) = get_json::<ProposalRecord>(&*tx, &proposal_key(id))? else {
                return Ok(Value::Array(Vec::new()));
            };
            if r.status != "error" {
                return Ok(Value::Array(Vec::new()));
            }
            delete_proposal(tx, &r)?;
            Ok(ids(&[r]))
        })
    }

    /// `readEdgeProposalSourceId(id)`: the proposal's source, `None` when there is no such
    /// proposal.
    pub fn read_edge_proposal_source_id(&self, id: f64) -> Result<Option<String>> {
        let Some(id) = id_arg(id) else {
            return Ok(None);
        };
        Ok(get_json::<ProposalRecord>(&*self.read()?, &proposal_key(id))?.map(|r| r.source_id))
    }

    /// `markEdgeProposalDated(id)`: the proposal becomes `rejected` with the detail
    /// `dated by user`; nothing happens when there is no such proposal.
    pub fn mark_edge_proposal_dated(&self, id: f64) -> Result<()> {
        let Some(id) = id_arg(id) else {
            return Ok(());
        };
        let now = self.env.now_micros();
        self.write(|tx| {
            let Some(mut r) = get_json::<ProposalRecord>(&*tx, &proposal_key(id))? else {
                return Ok(());
            };
            r.status = "rejected".to_string();
            r.detail = Some("dated by user".to_string());
            r.updated_at_us = now;
            put_json(tx, &proposal_key(id), &r)
        })
    }
}
