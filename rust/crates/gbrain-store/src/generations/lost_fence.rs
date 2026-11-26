//! The ledger read of `gbrain repair lost-fence-rows` (`src/core/repair/lost-fence-rows.ts`,
//! `engine-sql/lost-fence-reads.ts`): `listRetiredFenceItems`.
//!
//! Each `retired` item with a preimage of a fact or take fence generation of a page (`owner_key`
//! `page:<slug>`) that is not held and carries no `completeness.proof`, by (source, owner key,
//! generation id, item key) in byte order. `retired_at` is the generation's `created_at::text`. It
//! adds no keys.

use super::{GenerationRecord, ItemRecord, item_prefix, source_records};
use crate::Store;
use crate::cli_reads::pg_text::timestamptz_text;
use crate::error::Result;
use crate::kv::collect_prefix;
use crate::links::no_nul;
use serde_json::{Value, json};
use std::collections::BTreeSet;

/// `COALESCE(g.completeness->>'proof', '') = ''`.
fn unproven(record: &GenerationRecord) -> bool {
    match record.completeness.get("proof") {
        None | Some(Value::Null) => true,
        Some(Value::String(s)) => s.is_empty(),
        Some(_) => false,
    }
}

impl Store {
    /// `listRetiredFenceItems(sourceIds, only)`: `[{ kind, source_id, slug, retired_at, preimage }]`.
    pub fn list_retired_fence_items(
        &self,
        source_ids: &[String],
        only: Option<(String, String)>,
    ) -> Result<Vec<Value>> {
        let op = "listRetiredFenceItems";
        for source in source_ids {
            no_nul(op, &[("sourceIds", source)])?;
        }
        if let Some((source, slug)) = &only {
            no_nul(op, &[("sourceId", source), ("slug", slug)])?;
        }
        let sources: BTreeSet<&str> = source_ids.iter().map(String::as_str).collect();
        let read = self.read()?;
        let mut generations: Vec<GenerationRecord> = Vec::new();
        for source in sources {
            generations.extend(source_records(&*read, source)?.into_iter().filter(|g| {
                (g.kind == "fact_fence" || g.kind == "take_fence")
                    && g.state != "held"
                    && g.owner_key.starts_with("page:")
                    && unproven(g)
                    && only.as_ref().is_none_or(|(s, slug)| {
                        g.source_id == *s
                            && g.owner_key.strip_prefix("page:") == Some(slug.as_str())
                    })
            }));
        }
        generations.sort_by(|a, b| {
            a.source_id
                .as_bytes()
                .cmp(b.source_id.as_bytes())
                .then(a.owner_key.as_bytes().cmp(b.owner_key.as_bytes()))
                .then(a.id.cmp(&b.id))
        });
        let mut out = Vec::new();
        for g in &generations {
            let prefix = item_prefix(g.id);
            for (_, v) in collect_prefix(&*read, &prefix, false, usize::MAX)? {
                let item: ItemRecord = serde_json::from_slice(&v)?;
                let Some(preimage) = item.preimage else {
                    continue;
                };
                if item.action != "retired" {
                    continue;
                }
                out.push(json!({
                    "kind": g.kind,
                    "source_id": g.source_id,
                    "slug": &g.owner_key[5..],
                    "retired_at": timestamptz_text(g.created_at_us),
                    "preimage": preimage,
                }));
            }
        }
        Ok(out)
    }
}
