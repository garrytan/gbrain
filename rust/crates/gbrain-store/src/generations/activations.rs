//! Managed generation activations: the `derived_generation_activations` table of the PGLite
//! engine, the activation rows of `src/core/generations/managed.ts`.
//!
//! Members: recordGenerationActivation, markGenerationActivated, readGenerationActivationState,
//! settleGenerationMember, listPendingGenerationMembers and listGenerationOrphanCandidates (the
//! statements of `engine-sql/generation-activations.ts`). The generation key lock of an
//! activation is `lockGenerationKey`, which the single-writer store answers without a lock.
//!
//! Keys, under `keys::DERIVED_GENERATION` (`h`) with the parent module's rows:
//! - `h 0x08 id -> ActivationRecord`, one row of `derived_generation_activations` (its primary
//!   key, `TEXT`).
//! - `h 0x09 generation_id(8) id -> []` for each row that names a generation: the reverse of the
//!   `generation_id` foreign key, so a deleted generation row sets the column to null
//!   (`ON DELETE SET NULL`) without a scan.
//!
//! A source delete removes the source's rows (`ON DELETE CASCADE` of `source_id`). Text compares by
//! bytes (the C collation). The orphan list reads the write journal (`persistence_requests`,
//! `journal::RequestRecord`) and the page records; an activation id that is not a UUID matches no
//! request there, where Postgres's `a.id::uuid` cast may refuse it.

use super::{GenerationKey, check_key, int8, item_key, jsonb_text, read_record, source_records};
use crate::dream::int4;
use crate::error::{CONSTRAINT_VIOLATION, Result, StoreError};
use crate::kv::{KvRead, KvWrite, collect_prefix, scan_prefix};
use crate::links::no_nul;
use crate::{Store, get_json, keys, put_json};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeSet, HashSet};

const ACTIVATION: u8 = 0x08;
const ACTIVATION_BY_GENERATION: u8 = 0x09;

/// One row of `derived_generation_activations`; the key holds `id`.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct ActivationRecord {
    source_id: String,
    kind: String,
    owner_key: String,
    expected_generation: i32,
    #[serde(default)]
    input_pin: Option<String>,
    item_set_hash: String,
    state: String,
    #[serde(default)]
    generation_id: Option<u64>,
    members: Value,
    created_at_us: i64,
    updated_at_us: i64,
}

/// `GenerationActivationRecord`. `members` is JSON text (the `::text::jsonb` parameter).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivationRecordInput {
    pub activation_id: String,
    pub expected_generation: f64,
    #[serde(default)]
    pub input_pin: Option<String>,
    pub set_hash: String,
    pub members: String,
}

fn activation_key(id: &str) -> Vec<u8> {
    let mut key = vec![keys::DERIVED_GENERATION, ACTIVATION];
    key.extend_from_slice(id.as_bytes());
    key
}

fn by_generation_prefix(generation_id: u64) -> Vec<u8> {
    let mut key = vec![keys::DERIVED_GENERATION, ACTIVATION_BY_GENERATION];
    key.extend_from_slice(&generation_id.to_be_bytes());
    key
}

fn by_generation_key(generation_id: u64, id: &str) -> Vec<u8> {
    let mut key = by_generation_prefix(generation_id);
    key.extend_from_slice(id.as_bytes());
    key
}

fn read_activation(read: &dyn KvRead, id: &str) -> Result<Option<ActivationRecord>> {
    if id.contains('\0') {
        return Ok(None);
    }
    get_json(read, &activation_key(id))
}

/// Whether the activation row `id` exists in state `activated` (`EXISTS (SELECT 1 FROM
/// derived_generation_activations a WHERE a.id = $id AND a.state = 'activated')`).
pub(super) fn activation_activated(read: &dyn KvRead, id: &str) -> Result<bool> {
    Ok(read_activation(read, id)?.is_some_and(|row| row.state == "activated"))
}

/// Every activation row with its id, in id order.
fn all_activations(read: &dyn KvRead) -> Result<Vec<(String, ActivationRecord)>> {
    let prefix = [keys::DERIVED_GENERATION, ACTIVATION];
    let mut rows = Vec::new();
    for (k, v) in collect_prefix(read, &prefix, false, usize::MAX)? {
        let id = String::from_utf8(k[prefix.len()..].to_vec())
            .map_err(|_| StoreError::new(crate::error::STORE_CORRUPT, "activation id"))?;
        rows.push((id, serde_json::from_slice(&v)?));
    }
    Ok(rows)
}

fn foreign_key_violation() -> StoreError {
    StoreError::new(
        CONSTRAINT_VIOLATION,
        "insert or update on table \"derived_generation_activations\" violates foreign key \
         constraint \"derived_generation_activations_generation_id_fkey\"",
    )
}

/// The `request_id`s of the journal's unfinished requests (`state IN ('queued', 'deferred',
/// 'running', 'recovering')`), lowercased as Postgres prints a `uuid`.
fn unfinished_request_ids(read: &dyn KvRead) -> Result<HashSet<String>> {
    let mut out = HashSet::new();
    let mut failure = None;
    scan_prefix(read, &[keys::REQUEST], false, &mut |_, v| {
        match serde_json::from_slice::<crate::journal::RequestRecord>(v) {
            Ok(request) if !crate::journal::TERMINAL.contains(&request.state.as_str()) => {
                out.insert(request.request_id.to_ascii_lowercase());
            }
            Ok(_) => {}
            Err(e) => {
                failure = Some(StoreError::from(e));
                return false;
            }
        }
        true
    })?;
    match failure {
        Some(e) => Err(e),
        None => Ok(out),
    }
}

/// `ON DELETE SET NULL` of `derived_generation_activations.generation_id` for the row `id`.
pub(super) fn unlink_generation(tx: &mut dyn KvWrite, generation_id: u64) -> Result<()> {
    let prefix = by_generation_prefix(generation_id);
    for (k, _) in collect_prefix(&*tx, &prefix, false, usize::MAX)? {
        tx.delete(&k)?;
        let Ok(id) = std::str::from_utf8(&k[prefix.len()..]) else {
            continue;
        };
        if let Some(mut record) = read_activation(&*tx, id)? {
            record.generation_id = None;
            put_json(tx, &activation_key(id), &record)?;
        }
    }
    Ok(())
}

/// `ON DELETE CASCADE` of `derived_generation_activations.source_id`.
pub(super) fn remove_source_activations(tx: &mut dyn KvWrite, source_id: &str) -> Result<()> {
    for (id, record) in all_activations(&*tx)? {
        if record.source_id != source_id {
            continue;
        }
        if let Some(generation_id) = record.generation_id {
            tx.delete(&by_generation_key(generation_id, &id))?;
        }
        tx.delete(&activation_key(&id))?;
    }
    Ok(())
}

impl Store {
    /// `recordGenerationActivation(key, row)`: inserts the pending activation row unless a row with
    /// its id exists (`ON CONFLICT (id) DO NOTHING`).
    pub fn record_generation_activation(
        &self,
        key: &GenerationKey,
        row: &ActivationRecordInput,
    ) -> Result<()> {
        const OP: &str = "recordGenerationActivation";
        check_key(OP, key)?;
        let mut texts = vec![
            ("id", row.activation_id.as_str()),
            ("item_set_hash", row.set_hash.as_str()),
        ];
        texts.extend(row.input_pin.as_deref().map(|pin| ("input_pin", pin)));
        no_nul(OP, &texts)?;
        let expected_generation = int4(OP, "expected_generation", row.expected_generation)?;
        let members = jsonb_text(OP, "members", &row.members)?;
        let now = self.env.now_micros();
        self.write(|tx| {
            if read_activation(&*tx, &row.activation_id)?.is_some() {
                return Ok(());
            }
            crate::sources::require_source(&*tx, &key.source_id)?;
            let record = ActivationRecord {
                source_id: key.source_id.clone(),
                kind: key.kind.clone(),
                owner_key: key.owner_key.clone(),
                expected_generation,
                input_pin: row.input_pin.clone(),
                item_set_hash: row.set_hash.clone(),
                state: "pending".into(),
                generation_id: None,
                members: members.clone(),
                created_at_us: now,
                updated_at_us: now,
            };
            put_json(tx, &activation_key(&row.activation_id), &record)
        })
    }

    /// `markGenerationActivated(activationId, generationId)`: the row `activationId` becomes
    /// `activated` with the generation it made. No row changes nothing; a generation id no row
    /// holds is a foreign key violation.
    pub fn mark_generation_activated(&self, activation_id: &str, generation_id: f64) -> Result<()> {
        const OP: &str = "markGenerationActivated";
        no_nul(OP, &[("id", activation_id)])?;
        let generation_id = int8(OP, "generation_id", generation_id)?;
        let now = self.env.now_micros();
        self.write(|tx| {
            let Some(mut record) = read_activation(&*tx, activation_id)? else {
                return Ok(());
            };
            let generation_id =
                u64::try_from(generation_id).map_err(|_| foreign_key_violation())?;
            if read_record(&*tx, generation_id)?.is_none() {
                return Err(foreign_key_violation());
            }
            if let Some(old) = record.generation_id {
                tx.delete(&by_generation_key(old, activation_id))?;
            }
            record.state = "activated".into();
            record.generation_id = Some(generation_id);
            record.updated_at_us = now;
            put_json(tx, &activation_key(activation_id), &record)?;
            tx.put(&by_generation_key(generation_id, activation_id), &[])
        })
    }

    /// `readGenerationActivationState(activationId, slug, sourceId)`: `{ state, generation_state,
    /// pending }` of the activation in `sourceId`, its generation's state and `slug`'s pending
    /// mark there, or null.
    pub fn read_generation_activation_state(
        &self,
        activation_id: &str,
        slug: &str,
        source_id: &str,
    ) -> Result<Value> {
        const OP: &str = "readGenerationActivationState";
        no_nul(
            OP,
            &[
                ("id", activation_id),
                ("item_key", slug),
                ("source_id", source_id),
            ],
        )?;
        let read = self.read()?;
        let Some(record) = read_activation(&*read, activation_id)? else {
            return Ok(Value::Null);
        };
        if record.source_id != source_id {
            return Ok(Value::Null);
        }
        let (generation_state, pending) = match record.generation_id {
            Some(id) => match read_record(&*read, id)? {
                Some(generation) => {
                    let item: Option<super::ItemRecord> = get_json(&*read, &item_key(id, slug))?;
                    (Some(generation.state), item.map(|item| item.pending))
                }
                None => (None, None),
            },
            None => (None, None),
        };
        Ok(json!({
            "state": record.state,
            "generation_state": generation_state,
            "pending": pending,
        }))
    }

    /// `settleGenerationMember(activationId, slug)`: clears `slug`'s pending mark on the generation
    /// the activation made.
    pub fn settle_generation_member(&self, activation_id: &str, slug: &str) -> Result<()> {
        no_nul(
            "settleGenerationMember",
            &[("id", activation_id), ("item_key", slug)],
        )?;
        self.write(|tx| {
            let Some(generation_id) =
                read_activation(&*tx, activation_id)?.and_then(|record| record.generation_id)
            else {
                return Ok(());
            };
            let key = item_key(generation_id, slug);
            if let Some(mut item) = get_json::<super::ItemRecord>(&*tx, &key)? {
                item.pending = false;
                put_json(tx, &key, &item)?;
            }
            Ok(())
        })
    }

    /// `listPendingGenerationMembers(sourceIds, kind)`: the pending items of the live generations
    /// of `sourceIds` (one kind when given), ordered by source, kind, owner and item key.
    pub fn list_pending_generation_members(
        &self,
        source_ids: &[String],
        kind: Option<&str>,
    ) -> Result<Vec<Value>> {
        const OP: &str = "listPendingGenerationMembers";
        for text in source_ids.iter().map(String::as_str).chain(kind) {
            no_nul(OP, &[("argument", text)])?;
        }
        let read = self.read()?;
        let sources: BTreeSet<&str> = source_ids.iter().map(String::as_str).collect();
        let mut rows = Vec::new();
        for source in sources {
            for record in source_records(&*read, source)? {
                if record.state != "live" || kind.is_some_and(|kind| record.kind != kind) {
                    continue;
                }
                let prefix = super::item_prefix(record.id);
                for (k, v) in collect_prefix(&*read, &prefix, false, usize::MAX)? {
                    let item: super::ItemRecord = serde_json::from_slice(&v)?;
                    if !item.pending {
                        continue;
                    }
                    let slug = String::from_utf8_lossy(&k[prefix.len()..]).into_owned();
                    rows.push((
                        (
                            record.source_id.clone(),
                            record.kind.clone(),
                            record.owner_key.clone(),
                            slug.clone(),
                        ),
                        json!({
                            "source_id": record.source_id,
                            "kind": record.kind,
                            "owner_key": record.owner_key,
                            "generation_id": record.id,
                            "activation_id": record.activation_id,
                            "slug": slug,
                            "item_action": item.action,
                            "identity": item.identity_hash,
                        }),
                    ));
                }
            }
        }
        rows.sort_by(|a, b| a.0.cmp(&b.0));
        Ok(rows.into_iter().map(|(_, row)| row).collect())
    }

    /// `listGenerationOrphanCandidates(sourceIds, kind)`: the `create` members of pending
    /// activations of `sourceIds` (one kind when given) whose request is not unfinished, whose page
    /// is live, and that no live generation of the activation's source and kind owns; ordered by
    /// source, kind, owner and slug.
    pub fn list_generation_orphan_candidates(
        &self,
        source_ids: &[String],
        kind: Option<&str>,
    ) -> Result<Vec<Value>> {
        const OP: &str = "listGenerationOrphanCandidates";
        for text in source_ids.iter().map(String::as_str).chain(kind) {
            no_nul(OP, &[("argument", text)])?;
        }
        let read = self.read()?;
        let sources: BTreeSet<&str> = source_ids.iter().map(String::as_str).collect();
        let candidates: Vec<(String, ActivationRecord)> = all_activations(&*read)?
            .into_iter()
            .filter(|(_, record)| {
                record.state == "pending"
                    && sources.contains(record.source_id.as_str())
                    && kind.is_none_or(|kind| record.kind == kind)
            })
            .collect();
        if candidates.is_empty() {
            return Ok(Vec::new());
        }
        let unfinished = unfinished_request_ids(&*read)?;
        let mut owned: std::collections::HashMap<(String, String), HashSet<String>> =
            std::collections::HashMap::new();
        let mut rows = Vec::new();
        for (id, record) in candidates {
            if unfinished.contains(&id.to_ascii_lowercase()) {
                continue;
            }
            let group = (record.source_id.clone(), record.kind.clone());
            if !owned.contains_key(&group) {
                let mut items = HashSet::new();
                for generation in source_records(&*read, &record.source_id)? {
                    if generation.state != "live" || generation.kind != record.kind {
                        continue;
                    }
                    let prefix = super::item_prefix(generation.id);
                    for (k, v) in collect_prefix(&*read, &prefix, false, usize::MAX)? {
                        let item: super::ItemRecord = serde_json::from_slice(&v)?;
                        if item.action != "retired" {
                            items.insert(String::from_utf8_lossy(&k[prefix.len()..]).into_owned());
                        }
                    }
                }
                owned.insert(group.clone(), items);
            }
            let items = &owned[&group];
            for member in record.members.as_array().into_iter().flatten() {
                if member.get("action").and_then(Value::as_str) != Some("create") {
                    continue;
                }
                let Some(slug) = member.get("slug").and_then(Value::as_str) else {
                    continue;
                };
                let live = crate::pages::read_page(&*read, &record.source_id, slug)?
                    .is_some_and(|page| page.deleted_at_us.is_none());
                if !live || items.contains(slug) {
                    continue;
                }
                rows.push((
                    (
                        record.source_id.clone(),
                        record.kind.clone(),
                        record.owner_key.clone(),
                        slug.to_string(),
                        id.clone(),
                    ),
                    json!({
                        "source_id": record.source_id,
                        "kind": record.kind,
                        "owner_key": record.owner_key,
                        "activation_id": id,
                        "slug": slug,
                        "created_at": crate::cli_reads::pg_text::timestamptz_text(record.created_at_us),
                    }),
                ));
            }
        }
        rows.sort_by(|a, b| a.0.cmp(&b.0));
        Ok(rows.into_iter().map(|(_, row)| row).collect())
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
            kind: "managed_walk".into(),
            owner_key: "input:m".into(),
        }
    }

    fn row(id: &str, members: &str) -> ActivationRecordInput {
        ActivationRecordInput {
            activation_id: id.into(),
            expected_generation: 0.0,
            input_pin: Some("pin".into()),
            set_hash: "h".into(),
            members: members.into(),
        }
    }

    fn activate(store: &Store, activation: &str, items: &[(&str, bool)]) -> u64 {
        let items: Vec<LedgerItemInput> = items
            .iter()
            .map(|(item, pending)| LedgerItemInput {
                item_key: (*item).into(),
                identity_hash: (*item).into(),
                action: "published".into(),
                preimage: None,
                preimage_bytes: None,
                pending: *pending,
            })
            .collect();
        let live = store.read_live_generation_row(&key()).unwrap();
        let live_id = live.get("id").and_then(Value::as_f64);
        store
            .activate_generation_rows(
                &key(),
                live_id,
                &ActivationInput {
                    generation: 1.0,
                    run_id: None,
                    operation_id: format!("op-{activation}"),
                    input_pin: Some("pin".into()),
                    input_size: None,
                    completeness: "{}".into(),
                    set_hash: "h".into(),
                    restore_of: None,
                    activation_id: Some(activation.into()),
                    locator: None,
                },
                &items,
            )
            .unwrap()
    }

    #[test]
    fn an_activation_flips_gates_its_members_and_settles_them() {
        let store = store();
        let id = "00000000-0000-8000-a000-000000000001";
        store
            .record_generation_activation(
                &key(),
                &row(id, r#"[{"slug":"a","action":"overwrite"}]"#),
            )
            .unwrap();
        // ON CONFLICT (id) DO NOTHING: a second record keeps the first row.
        store
            .record_generation_activation(&key(), &row(id, "[]"))
            .unwrap();
        let pending = store
            .read_generation_activation_state(id, "a", "default")
            .unwrap();
        assert_eq!(
            pending,
            json!({ "state": "pending", "generation_state": null, "pending": null })
        );
        let generation = activate(&store, id, &[("a", true), ("b", false)]);
        store
            .mark_generation_activated(id, generation as f64)
            .unwrap();
        let state = |slug: &str| {
            store
                .read_generation_activation_state(id, slug, "default")
                .unwrap()
        };
        assert_eq!(
            state("a"),
            json!({ "state": "activated", "generation_state": "live", "pending": true })
        );
        assert_eq!(
            store
                .read_generation_activation_state(id, "a", "elsewhere")
                .unwrap(),
            Value::Null
        );
        let listed = store
            .list_pending_generation_members(&["default".into()], None)
            .unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0]["slug"], "a");
        assert_eq!(listed[0]["generation_id"], json!(generation));
        store.settle_generation_member(id, "a").unwrap();
        assert_eq!(state("a")["pending"], json!(false));
        assert!(
            store
                .list_pending_generation_members(&["default".into()], Some("managed_walk"))
                .unwrap()
                .is_empty()
        );
        let err = store.mark_generation_activated(id, 999.0).unwrap_err();
        assert_eq!(err.code, CONSTRAINT_VIOLATION);
    }

    #[test]
    fn a_deleted_generation_sets_the_column_to_null_and_a_source_delete_removes_the_rows() {
        let store = store();
        let id = "00000000-0000-8000-a000-000000000002";
        store
            .record_generation_activation(&key(), &row(id, "[]"))
            .unwrap();
        let generation = activate(&store, id, &[("a", false)]);
        store
            .mark_generation_activated(id, generation as f64)
            .unwrap();
        store
            .write(|tx| {
                let record = read_record(&*tx, generation)?.unwrap();
                super::super::delete_row(tx, &record)
            })
            .unwrap();
        assert_eq!(
            store
                .read_generation_activation_state(id, "a", "default")
                .unwrap(),
            json!({ "state": "activated", "generation_state": null, "pending": null })
        );
        store
            .write(|tx| super::super::remove_source_rows(tx, "default"))
            .unwrap();
        assert_eq!(
            store
                .read_generation_activation_state(id, "a", "default")
                .unwrap(),
            Value::Null
        );
    }

    #[test]
    fn a_nul_or_bad_json_is_refused() {
        let store = store();
        assert!(
            store
                .record_generation_activation(&key(), &row("a\0b", "[]"))
                .is_err()
        );
        assert!(
            store
                .record_generation_activation(&key(), &row("x", "not json"))
                .is_err()
        );
        let unknown = GenerationKey {
            source_id: "nowhere".into(),
            ..key()
        };
        assert!(
            store
                .record_generation_activation(&unknown, &row("x", "[]"))
                .is_err()
        );
    }
}
