//! `listSharedSkillMigrationRows(sourceId)`: the members that follow one source, with the stage of the batch each
//! last acknowledged, in byte order of adapter then installation id (engine-sql/collate-store-reads.ts). A child of
//! `shared_skill_members`, so it reads the member and batch records of that module.

use super::{BatchRecord, MemberRecord, all_members, member_batches};
use crate::Store;
use crate::error::Result;
use serde_json::{Value, json};

/// `follow_policy->'sources' ? source_id`: the jsonb `?` operator on the `sources` value (a key of an object, a string
/// element of an array, or a string scalar itself).
fn follows(policy: &Value, source_id: &str) -> bool {
    match policy.get("sources") {
        Some(Value::Object(map)) => map.contains_key(source_id),
        Some(Value::Array(items)) => items.iter().any(|i| i.as_str() == Some(source_id)),
        Some(Value::String(s)) => s == source_id,
        _ => false,
    }
}

/// `follow_policy->'sources'->>source_id`: the text of the value under the key of an object, else null.
fn approved(policy: &Value, source_id: &str) -> Value {
    match policy
        .get("sources")
        .and_then(|s| s.as_object())
        .and_then(|m| m.get(source_id))
    {
        None | Some(Value::Null) => Value::Null,
        Some(Value::String(s)) => json!(s),
        Some(other) => json!(other.to_string()),
    }
}

impl Store {
    /// `listSharedSkillMigrationRows(sourceId)`: at most 4096 rows `{ installation_id, adapter, epoch, active,
    /// approved_incarnation, desired_view, acknowledged_view, stage }`. `stage` is the `stage` of the evidence of the
    /// member's batch at its acknowledged sequence in its current epoch, when that batch was acknowledged.
    pub fn list_shared_skill_migration_rows(&self, source_id: &str) -> Result<Value> {
        let read = self.read()?;
        let mut members: Vec<MemberRecord> = all_members(&*read)?
            .into_iter()
            .filter(|m| follows(&m.follow_policy, source_id))
            .collect();
        members.sort_by(|a, b| {
            a.adapter
                .as_bytes()
                .cmp(b.adapter.as_bytes())
                .then_with(|| a.installation_id.cmp(&b.installation_id))
        });
        members.truncate(4096);
        let mut rows = Vec::with_capacity(members.len());
        for m in members {
            let batches: Vec<BatchRecord> = member_batches(&*read, &m.installation_id)?;
            let stage = batches
                .iter()
                .find(|b| {
                    b.epoch == m.epoch
                        && b.sequence == m.acknowledged_sequence
                        && b.acknowledged_at_us.is_some()
                })
                .and_then(|b| b.evidence.as_ref())
                .and_then(|e| e.get("stage"))
                .map(|s| match s {
                    Value::String(t) => json!(t),
                    Value::Null => Value::Null,
                    other => json!(other.to_string()),
                })
                .unwrap_or(Value::Null);
            rows.push(json!({
                "installation_id": m.installation_id,
                "adapter": m.adapter,
                "epoch": m.epoch,
                "active": m.active,
                "approved_incarnation": approved(&m.follow_policy, source_id),
                "desired_view": m.desired_view,
                "acknowledged_view": m.acknowledged_view,
                "stage": stage,
            }));
        }
        Ok(Value::Array(rows))
    }
}
