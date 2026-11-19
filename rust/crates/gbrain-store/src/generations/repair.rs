//! The reads of `gbrain repair generations` (`src/core/generations/repair.ts`) over the
//! `derived_generations` rows of the parent module.
//!
//! Members: readGenerationItemsByIds, listUnmatchedGenerationRows, listRestorableGenerationRows,
//! listHeldGenerationRows and readHeldGenerationProposal (the statements of
//! `engine-sql/generation-repair.ts`). The source incarnation read of the same file composes
//! `readSourceIncarnation` in the TypeScript store member.
//!
//! The three lists take the repair filter (`GenerationRepairFilter`): each field that is present
//! narrows the rows as its SQL fragment does (`g.run_id = …`, `g.created_at >= …::timestamptz`,
//! `g.owner_key = …`, `g.id = …`), and a row with a null `run_id` never matches a run. These are
//! ledger reads, not page reads, so they take no page read policy. They add no keys.

use super::{GenerationRecord, ItemRecord, RECORD, int8, item_prefix, read_record, source_records};
use crate::env::parse_iso;
use crate::error::{INVALID_ARGUMENT, Result, StoreError};
use crate::kv::collect_prefix;
use crate::links::no_nul;
use crate::{Store, keys};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::BTreeSet;

/// `GenerationRepairFilter`: the selector of a repair list. `since` is an ISO instant.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct RepairFilter {
    pub run_id: Option<String>,
    pub since: Option<String>,
    pub owner_key: Option<String>,
    pub id: Option<f64>,
}

/// The filter checked once: the `since` instant in microseconds and the id as a `BIGINT`.
struct Checked<'a> {
    run_id: Option<&'a str>,
    since_us: Option<i64>,
    owner_key: Option<&'a str>,
    id: Option<i64>,
}

impl RepairFilter {
    fn check(&self, op: &str) -> Result<Checked<'_>> {
        for text in [&self.run_id, &self.since, &self.owner_key]
            .into_iter()
            .flatten()
        {
            no_nul(op, &[("filter", text.as_str())])?;
        }
        let since_us = match &self.since {
            Some(text) => Some(parse_iso(text).ok_or_else(|| {
                StoreError::new(
                    INVALID_ARGUMENT,
                    format!(
                        "{op}: invalid input syntax for type timestamp with time zone: \"{text}\""
                    ),
                )
            })?),
            None => None,
        };
        let id = self.id.map(|id| int8(op, "id", id)).transpose()?;
        Ok(Checked {
            run_id: self.run_id.as_deref(),
            since_us,
            owner_key: self.owner_key.as_deref(),
            id,
        })
    }
}

impl Checked<'_> {
    fn matches(&self, record: &GenerationRecord) -> bool {
        self.run_id
            .is_none_or(|run| record.run_id.as_deref() == Some(run))
            && self
                .since_us
                .is_none_or(|since| record.created_at_us >= since)
            && self.owner_key.is_none_or(|owner| record.owner_key == owner)
            && self
                .id
                .is_none_or(|id| i64::try_from(record.id).is_ok_and(|own| own == id))
    }
}

/// The rows of `kind` in `state` across `source_ids` that pass `filter`, in id order.
fn selected(
    store: &Store,
    op: &str,
    source_ids: &[String],
    kind: &str,
    state: &str,
    filter: &RepairFilter,
) -> Result<Vec<GenerationRecord>> {
    for text in source_ids.iter().map(String::as_str).chain([kind]) {
        no_nul(op, &[("argument", text)])?;
    }
    let checked = filter.check(op)?;
    let read = store.read()?;
    let sources: BTreeSet<&str> = source_ids.iter().map(String::as_str).collect();
    let mut rows = Vec::new();
    for source in sources {
        rows.extend(
            source_records(&*read, source)?
                .into_iter()
                .filter(|record| {
                    record.kind == kind && record.state == state && checked.matches(record)
                }),
        );
    }
    rows.sort_by_key(|record| record.id);
    Ok(rows)
}

impl Store {
    /// `readGenerationItemsByIds(ids)`: every ledger item of the generations `ids`, as
    /// `{ generation_id, item_key, identity_hash, action, preimage }`, in id and item key order.
    pub fn read_generation_items_by_ids(&self, ids: &[f64]) -> Result<Vec<Value>> {
        const OP: &str = "readGenerationItemsByIds";
        let mut wanted = BTreeSet::new();
        for id in ids {
            wanted.insert(int8(OP, "generation_id", *id)?);
        }
        let read = self.read()?;
        let mut rows = Vec::new();
        for id in wanted.into_iter().filter_map(|id| u64::try_from(id).ok()) {
            let prefix = item_prefix(id);
            for (k, v) in collect_prefix(&*read, &prefix, false, usize::MAX)? {
                let item: ItemRecord = serde_json::from_slice(&v)?;
                rows.push(json!({
                    "generation_id": id,
                    "item_key": String::from_utf8_lossy(&k[prefix.len()..]),
                    "identity_hash": item.identity_hash,
                    "action": item.action,
                    "preimage": item.preimage,
                }));
            }
        }
        Ok(rows)
    }

    /// `listUnmatchedGenerationRows(sourceIds, kind, filter)`: the live rows whose completeness
    /// holds an `unmatched` array, as `{ id, source_id, owner_key, activation_id, unmatched }`.
    pub fn list_unmatched_generation_rows(
        &self,
        source_ids: &[String],
        kind: &str,
        filter: &RepairFilter,
    ) -> Result<Vec<Value>> {
        let rows = selected(
            self,
            "listUnmatchedGenerationRows",
            source_ids,
            kind,
            "live",
            filter,
        )?;
        Ok(rows
            .into_iter()
            .filter_map(|record| {
                let unmatched = record
                    .completeness
                    .get("unmatched")
                    .filter(|v| v.is_array())?
                    .clone();
                Some(json!({
                    "id": record.id,
                    "source_id": record.source_id,
                    "owner_key": record.owner_key,
                    "activation_id": record.activation_id,
                    "unmatched": unmatched,
                }))
            })
            .collect())
    }

    /// `listRestorableGenerationRows(sourceIds, kind, filter)`: each live row with each superseded
    /// row whose `superseded_by` names it, as `{ id, source_id, owner_key, generation, prev_id,
    /// prev_generation }`.
    pub fn list_restorable_generation_rows(
        &self,
        source_ids: &[String],
        kind: &str,
        filter: &RepairFilter,
    ) -> Result<Vec<Value>> {
        const OP: &str = "listRestorableGenerationRows";
        let live = selected(self, OP, source_ids, kind, "live", filter)?;
        if live.is_empty() {
            return Ok(Vec::new());
        }
        // The join matches a predecessor in any source or kind, so every row is read once.
        let read = self.read()?;
        let live_ids: BTreeSet<u64> = live.iter().map(|record| record.id).collect();
        let mut previous: Vec<GenerationRecord> = Vec::new();
        for (_, v) in collect_prefix(
            &*read,
            &[keys::DERIVED_GENERATION, RECORD],
            false,
            usize::MAX,
        )? {
            let record: GenerationRecord = serde_json::from_slice(&v)?;
            if record.state == "superseded"
                && record
                    .superseded_by
                    .is_some_and(|id| live_ids.contains(&id))
            {
                previous.push(record);
            }
        }
        let mut rows = Vec::new();
        for record in &live {
            let mut prior: Vec<&GenerationRecord> = previous
                .iter()
                .filter(|p| p.superseded_by == Some(record.id))
                .collect();
            prior.sort_by_key(|p| p.id);
            for p in prior {
                rows.push(json!({
                    "id": record.id,
                    "source_id": record.source_id,
                    "owner_key": record.owner_key,
                    "generation": record.generation,
                    "prev_id": p.id,
                    "prev_generation": p.generation,
                }));
            }
        }
        Ok(rows)
    }

    /// `listHeldGenerationRows(sourceIds, kind, filter)`: the held rows, as `{ id, source_id,
    /// owner_key, held_reason, hold_id, input_pin, attempts, proposal_bytes, items }`; `items` is
    /// the proposal's length (`jsonb_array_length`), null without a proposal.
    pub fn list_held_generation_rows(
        &self,
        source_ids: &[String],
        kind: &str,
        filter: &RepairFilter,
    ) -> Result<Vec<Value>> {
        const OP: &str = "listHeldGenerationRows";
        let rows = selected(self, OP, source_ids, kind, "held", filter)?;
        let mut out = Vec::with_capacity(rows.len());
        for record in rows {
            // `jsonb_array_length(proposal)`: NULL for SQL NULL; an object is a non-array and any
            // other value, a JSON `null` included, a scalar.
            let items = match record.proposal_column().value() {
                None => Value::Null,
                Some(Value::Array(items)) => json!(items.len()),
                Some(value) => {
                    let what = if value.is_object() {
                        "non-array"
                    } else {
                        "scalar"
                    };
                    return Err(StoreError::new(
                        INVALID_ARGUMENT,
                        format!("{OP}: cannot get array length of a {what}"),
                    ));
                }
            };
            out.push(json!({
                "id": record.id,
                "source_id": record.source_id,
                "owner_key": record.owner_key,
                "held_reason": record.held_reason,
                "hold_id": record.hold_id,
                "input_pin": record.input_pin,
                "attempts": record.attempts,
                "proposal_bytes": record.proposal_bytes,
                "items": items,
            }));
        }
        Ok(out)
    }

    /// `readHeldGenerationProposal(id)`: `{ proposal, hold_id }` of the row `id` while it is held,
    /// or null.
    pub fn read_held_generation_proposal(&self, id: f64) -> Result<Value> {
        let id = int8("readHeldGenerationProposal", "id", id)?;
        let Ok(id) = u64::try_from(id) else {
            return Ok(Value::Null);
        };
        let read = self.read()?;
        Ok(match read_record(&*read, id)? {
            Some(record) if record.state == "held" => {
                json!({ "proposal": record.proposal, "hold_id": record.hold_id })
            }
            _ => Value::Null,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::generations::{ActivationInput, GenerationKey, HeldInput, LedgerItemInput};
    use crate::test_support::store;

    fn key(owner: &str) -> GenerationKey {
        GenerationKey {
            source_id: "default".into(),
            kind: "repair_walk".into(),
            owner_key: owner.into(),
        }
    }

    fn activate(
        store: &Store,
        owner: &str,
        live: Option<f64>,
        run: &str,
        completeness: &str,
    ) -> f64 {
        let items = [LedgerItemInput {
            item_key: format!("walk/{owner}"),
            identity_hash: "id".into(),
            action: "published".into(),
            preimage: None,
            preimage_bytes: None,
            pending: false,
        }];
        store
            .activate_generation_rows(
                &key(owner),
                live,
                &ActivationInput {
                    generation: if live.is_some() { 2.0 } else { 1.0 },
                    run_id: Some(run.into()),
                    operation_id: format!("op-{owner}-{live:?}"),
                    input_pin: None,
                    input_size: None,
                    completeness: completeness.into(),
                    set_hash: "h".into(),
                    restore_of: None,
                    activation_id: None,
                    locator: None,
                },
                &items,
            )
            .unwrap() as f64
    }

    fn hold(store: &Store, owner: &str, proposal: Option<&str>) {
        store
            .record_held_generation_row(
                &key(owner),
                &HeldInput {
                    hold_id: format!("hold-{owner}"),
                    run_id: Some("ra".into()),
                    input_pin: None,
                    input_size: None,
                    set_hash: "h".into(),
                    reason: "shrunk".into(),
                    context: "{}".into(),
                    proposal: proposal.map(Into::into),
                    proposal_bytes: 2.0,
                },
            )
            .unwrap();
    }

    fn ids(rows: &[Value]) -> Vec<f64> {
        rows.iter()
            .filter_map(|row| row.get("id").and_then(Value::as_f64))
            .collect()
    }

    #[test]
    fn the_lists_apply_each_filter_and_join_the_predecessor() {
        let store = store();
        let sources = vec!["default".to_string(), "elsewhere".to_string()];
        let unmatched = r#"{"unmatched":[{"slug":"walk/old","why":"no_subject","missing":null}]}"#;
        let a_prev = activate(&store, "a", None, "ra", "{}");
        let a = activate(&store, "a", Some(a_prev), "ra", unmatched);
        let b_prev = activate(&store, "b", None, "rb", "{}");
        let b = activate(&store, "b", Some(b_prev), "rb", "{}");
        let all = RepairFilter::default();

        let rows = store
            .list_unmatched_generation_rows(&sources, "repair_walk", &all)
            .unwrap();
        assert_eq!(ids(&rows), vec![a]);
        assert_eq!(rows[0]["unmatched"][0]["slug"], "walk/old");

        let rows = store
            .list_restorable_generation_rows(&sources, "repair_walk", &all)
            .unwrap();
        assert_eq!(ids(&rows), vec![a, b]);
        assert_eq!(rows[1]["prev_id"].as_f64(), Some(b_prev));
        assert_eq!(rows[1]["prev_generation"], 1);

        let run = RepairFilter {
            run_id: Some("rb".into()),
            ..Default::default()
        };
        assert_eq!(
            ids(&store
                .list_restorable_generation_rows(&sources, "repair_walk", &run)
                .unwrap()),
            vec![b]
        );
        let owner = RepairFilter {
            owner_key: Some("a".into()),
            id: Some(b),
            ..Default::default()
        };
        assert!(
            store
                .list_restorable_generation_rows(&sources, "repair_walk", &owner)
                .unwrap()
                .is_empty()
        );
        let later = RepairFilter {
            since: Some("2999-01-01T00:00:00Z".into()),
            ..Default::default()
        };
        assert!(
            store
                .list_restorable_generation_rows(&sources, "repair_walk", &later)
                .unwrap()
                .is_empty()
        );
        assert!(
            store
                .list_restorable_generation_rows(&sources, "other_kind", &all)
                .unwrap()
                .is_empty()
        );
        let bad = RepairFilter {
            since: Some("yesterday".into()),
            ..Default::default()
        };
        assert_eq!(
            store
                .list_held_generation_rows(&sources, "repair_walk", &bad)
                .unwrap_err()
                .code,
            INVALID_ARGUMENT
        );
    }

    #[test]
    fn held_rows_count_their_proposal_and_reread_it_while_held() {
        let store = store();
        let sources = vec!["default".to_string()];
        hold(&store, "a", Some(r#"[{"slug":"x"},{"slug":"y"}]"#));
        hold(&store, "b", None);
        let rows = store
            .list_held_generation_rows(&sources, "repair_walk", &RepairFilter::default())
            .unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0]["items"], 2);
        assert_eq!(rows[1]["items"], Value::Null);
        let id = rows[0]["id"].as_f64().unwrap();
        let proposal = store.read_held_generation_proposal(id).unwrap();
        assert_eq!(proposal["hold_id"], "hold-a");
        assert_eq!(proposal["proposal"][1]["slug"], "y");
        let live = activate(&store, "a", None, "ra", "{}");
        assert_eq!(
            store.read_held_generation_proposal(id).unwrap(),
            Value::Null
        );
        assert_eq!(
            store.read_held_generation_proposal(live).unwrap(),
            Value::Null
        );

        let items = store
            .read_generation_items_by_ids(&[live, live, 99.0])
            .unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["item_key"], "walk/a");
        assert_eq!(items[0]["generation_id"].as_f64(), Some(live));
    }

    #[test]
    fn the_held_list_sizes_a_proposal_as_jsonb_array_length_does() {
        let sources = vec!["default".to_string()];
        let all = RepairFilter::default();
        for (proposal, outcome) in [
            (None, Ok(Value::Null)),
            (Some("[1,2]"), Ok(json!(2))),
            (Some("null"), Err("scalar")),
            (Some(r#""s""#), Err("scalar")),
            (Some(r#"{"a":1}"#), Err("non-array")),
        ] {
            let store = store();
            hold(&store, "a", proposal);
            let got = store.list_held_generation_rows(&sources, "repair_walk", &all);
            match outcome {
                Ok(items) => assert_eq!(got.unwrap()[0]["items"], items, "{proposal:?}"),
                Err(what) => assert_eq!(
                    got.unwrap_err().to_string(),
                    format!(
                        "invalid_argument: listHeldGenerationRows: cannot get array length of a {what}"
                    ),
                    "{proposal:?}"
                ),
            }
        }
    }
}
