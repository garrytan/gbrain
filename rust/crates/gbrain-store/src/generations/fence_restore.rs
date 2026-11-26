//! The ledger reads of `src/core/generations/fence-restore.ts` (a fence kind's restore through
//! `gbrain repair generations`) over the rows of the parent module.
//!
//! Members: readGenerationFenceBlocks, listOwnedGenerationItems and readLiveGenerationId (the
//! statements of `engine-sql/generation-fence-restore.ts`). These are ledger reads, not page
//! reads, so they take no page read policy. They add no keys.

use super::{GenerationKey, ItemRecord, check_key, int8, item_prefix, pointed, read_record};
use crate::Store;
use crate::error::Result;
use crate::kv::collect_prefix;
use serde_json::{Value, json};
use std::collections::BTreeSet;

/// The distinct generation ids of `ids`, as `BIGINT`s, in id order; an id no row can have is
/// dropped (`ANY` matches nothing for it).
fn generation_ids(op: &str, ids: &[f64]) -> Result<Vec<u64>> {
    let mut wanted = BTreeSet::new();
    for id in ids {
        wanted.insert(int8(op, "id", *id)?);
    }
    Ok(wanted
        .into_iter()
        .filter_map(|id| u64::try_from(id).ok())
        .collect())
}

impl Store {
    /// `readGenerationFenceBlocks(ids)`: `{ id, fence }` for each generation row of `ids`, in id
    /// order (Postgres sends no ORDER BY); `fence` is `completeness->'fence'`, null when the
    /// completeness is not an object or has no `fence` member.
    pub fn read_generation_fence_blocks(&self, ids: &[f64]) -> Result<Vec<Value>> {
        let ids = generation_ids("readGenerationFenceBlocks", ids)?;
        let read = self.read()?;
        let mut rows = Vec::new();
        for id in ids {
            if let Some(record) = read_record(&*read, id)? {
                let fence = record
                    .completeness
                    .as_object()
                    .and_then(|object| object.get("fence"))
                    .cloned()
                    .unwrap_or(Value::Null);
                rows.push(json!({ "id": id, "fence": fence }));
            }
        }
        Ok(rows)
    }

    /// `listOwnedGenerationItems(ids)`: `{ generation_id, item_key }` for each item of the
    /// generations `ids` whose action is not `retired`, in id and item key order.
    pub fn list_owned_generation_items(&self, ids: &[f64]) -> Result<Vec<Value>> {
        let ids = generation_ids("listOwnedGenerationItems", ids)?;
        let read = self.read()?;
        let mut rows = Vec::new();
        for id in ids {
            let prefix = item_prefix(id);
            for (k, v) in collect_prefix(&*read, &prefix, false, usize::MAX)? {
                let item: ItemRecord = serde_json::from_slice(&v)?;
                if item.action != "retired" {
                    rows.push(json!({
                        "generation_id": id,
                        "item_key": String::from_utf8_lossy(&k[prefix.len()..]),
                    }));
                }
            }
        }
        Ok(rows)
    }

    /// `readLiveGenerationId(key)`: `{ id }` of the live generation of `key`, or null.
    pub fn read_live_generation_id(&self, key: &GenerationKey) -> Result<Value> {
        check_key("readLiveGenerationId", key)?;
        let read = self.read()?;
        Ok(match pointed(&*read, key, "live")? {
            Some(id) => json!({ "id": id }),
            None => Value::Null,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::generations::{ActivationInput, LedgerItemInput};
    use crate::test_support::store;

    fn key() -> GenerationKey {
        GenerationKey {
            source_id: "default".into(),
            kind: "fact_fence".into(),
            owner_key: "page:a".into(),
        }
    }

    fn activate(
        store: &Store,
        live: Option<f64>,
        completeness: &str,
        actions: &[(&str, &str)],
    ) -> f64 {
        let items: Vec<LedgerItemInput> = actions
            .iter()
            .map(|(item_key, action)| LedgerItemInput {
                item_key: (*item_key).into(),
                identity_hash: "id".into(),
                action: (*action).into(),
                preimage: None,
                preimage_bytes: None,
                pending: false,
            })
            .collect();
        store
            .activate_generation_rows(
                &key(),
                live,
                &ActivationInput {
                    generation: if live.is_some() { 2.0 } else { 1.0 },
                    run_id: None,
                    operation_id: format!("op-{live:?}"),
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

    #[test]
    fn the_restore_reads_name_the_blocks_the_owned_keys_and_the_live_row() {
        let store = store();
        assert_eq!(store.read_live_generation_id(&key()).unwrap(), Value::Null);
        let prev = activate(
            &store,
            None,
            r#"{"fence":{"body":"old","timeline":null}}"#,
            &[("r1", "published"), ("r2", "published")],
        );
        let live = activate(
            &store,
            Some(prev),
            "{}",
            &[("r1", "kept"), ("r2", "retired")],
        );
        assert_eq!(
            store.read_live_generation_id(&key()).unwrap(),
            json!({ "id": live as u64 })
        );

        let blocks = store
            .read_generation_fence_blocks(&[live, prev, prev, 99.0])
            .unwrap();
        assert_eq!(
            blocks,
            vec![
                json!({ "id": prev as u64, "fence": { "body": "old", "timeline": null } }),
                json!({ "id": live as u64, "fence": null }),
            ]
        );
        let items = store.list_owned_generation_items(&[live, prev]).unwrap();
        assert_eq!(
            items,
            vec![
                json!({ "generation_id": prev as u64, "item_key": "r1" }),
                json!({ "generation_id": prev as u64, "item_key": "r2" }),
                json!({ "generation_id": live as u64, "item_key": "r1" }),
            ]
        );
    }
}
