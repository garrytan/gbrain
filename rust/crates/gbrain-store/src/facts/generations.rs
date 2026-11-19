//! `listUnwithdrawnFacts` (engine-sql/facts-repair.ts): the retired fence rows of the derived
//! generation ledger whose facts are expired and not withdrawn.
//!
//! The ledger is the `derived_generations` and `derived_generation_items` tables under
//! `keys::DERIVED_GENERATION` (`h`, `generations.rs`); this module reads it through
//! [`ledger_rows`] and keeps no keys of its own. The ledger's writers and its source-delete
//! cascade live in `generations.rs`.

use super::purge::withdrawal_covers;
use super::{FactRecord, fact_fingerprint, read_fact, source_rows};
use crate::Store;
use crate::env::iso;
use crate::error::{Result, StoreError};
use crate::generations::{LedgerRow, ledger_rows};
use crate::kv::KvRead;
use crate::links::no_nul;
use crate::pages::read_page;
use crate::timeline_queries::jsonb_field_text;
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet, HashSet};

/// `listUnwithdrawnFacts({ sourceIds, slug, fenceKind })`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct UnwithdrawnArgs {
    pub source_ids: Vec<String>,
    pub slug: Option<String>,
    pub fence_kind: String,
}

/// `preimage ->> field` of an object preimage.
fn field(preimage: &Value, name: &str) -> Option<String> {
    preimage.get(name).and_then(jsonb_field_text)
}

/// A retired item the CTE keeps: the fact id, the generation and the page slug.
struct Retired<'a> {
    generation_id: u64,
    generation: &'a LedgerRow,
    slug: &'a str,
    preimage: &'a Value,
}

impl Store {
    /// `listUnwithdrawnFacts` (engine-sql/facts-repair.ts). The retired fence rows of the `fenceKind`
    /// generations of the sources (not `held`, owner `page:<slug>`, `slug` when set) whose object
    /// preimage holds an `id`, a `row_num` and no `expired_at`; for each fact id the newest
    /// generation's item counts. A row lists when its fact, in the same source, is expired, holds no
    /// `row_num`, has the preimage's `fact` and `visibility` and is not a conversation extractor's.
    /// Rows go in (source, slug) byte order (the SQL pins `COLLATE "C"`), then fact id.
    pub fn list_unwithdrawn_facts(&self, a: &UnwithdrawnArgs) -> Result<Vec<Value>> {
        let op = "listUnwithdrawnFacts";
        no_nul(op, &[("fenceKind", &a.fence_kind)])?;
        for source in &a.source_ids {
            no_nul(op, &[("sourceIds", source)])?;
        }
        if let Some(slug) = &a.slug {
            no_nul(op, &[("slug", slug)])?;
        }
        let read = self.read()?;
        let generations = ledger_rows(&*read)?;
        let sources: HashSet<&str> = a.source_ids.iter().map(String::as_str).collect();
        let mut retired: BTreeMap<i64, Retired> = BTreeMap::new();
        for g in &generations {
            let id = &g.id;
            let Some(slug) = g.owner_key.strip_prefix("page:") else {
                continue;
            };
            if g.kind != a.fence_kind
                || !sources.contains(g.source_id.as_str())
                || g.state == "held"
                || a.slug.as_deref().is_some_and(|s| s != slug)
            {
                continue;
            }
            for item in &g.items {
                let Some(pre) = item.preimage.as_ref().filter(|p| p.is_object()) else {
                    continue;
                };
                if item.action != "retired"
                    || pre.get("id").is_none()
                    || field(pre, "expired_at").is_some()
                    || field(pre, "row_num").is_none()
                {
                    continue;
                }
                let text = field(pre, "id").unwrap_or_default();
                let fact_id: i64 = text.trim().parse().map_err(|_| {
                    StoreError::invalid(format!(
                        "{op}: invalid input syntax for type bigint: \"{text}\""
                    ))
                })?;
                // DISTINCT ON (fact id) ORDER BY g.id DESC: the newest generation wins.
                if retired.get(&fact_id).is_none_or(|r| r.generation_id < *id) {
                    retired.insert(
                        fact_id,
                        Retired {
                            generation_id: *id,
                            generation: g,
                            slug,
                            preimage: pre,
                        },
                    );
                }
            }
        }
        let now = self.env.now_micros();
        let mut withdrawals: BTreeMap<&str, BTreeSet<(String, String, String)>> = BTreeMap::new();
        let mut active: BTreeMap<&str, Vec<FactRecord>> = BTreeMap::new();
        let mut rows: Vec<(String, String, u64, Value)> = Vec::new();
        for (fact_id, r) in &retired {
            let source = r.generation.source_id.as_str();
            let Some(f) = u64::try_from(*fact_id)
                .ok()
                .map(|id| read_fact(&*read, id))
                .transpose()?
                .flatten()
                .filter(|f| f.source_id == source)
            else {
                continue;
            };
            if f.expired_at_us.is_none()
                || f.row_num.is_some()
                || field(r.preimage, "fact").as_deref() != Some(f.fact.as_str())
                || field(r.preimage, "visibility").as_deref() != Some(f.visibility.as_str())
                || f.conversation_slot()
            {
                continue;
            }
            if !withdrawals.contains_key(source) {
                withdrawals.insert(source, self.withdrawal_keys(source)?);
            }
            // The SQL also matches the v1 fingerprint of rows from before v174. The store's only
            // writer, `insertFactWithdrawal`, keys a withdrawal by the current fingerprint, so a
            // store holds no v1 key.
            let fingerprint = fact_fingerprint(&f.fact);
            let mut withdrawn = false;
            for (visibility, hash, subject) in &withdrawals[source] {
                if visibility == &f.visibility
                    && hash == &fingerprint
                    && covers_fact(&*read, &f, subject)?
                {
                    withdrawn = true;
                    break;
                }
            }
            if !active.contains_key(source) {
                let live = source_rows(&*read, source)?
                    .into_iter()
                    .filter(|x| x.active(now))
                    .collect();
                active.insert(source, live);
            }
            let active_duplicate = active[source].iter().any(|x| {
                x.source_markdown_slug.as_deref() == Some(r.slug)
                    && x.entity_slug == f.entity_slug
                    && (x.attributed_to.is_none()
                        || f.attributed_to.is_none()
                        || x.attributed_to == f.attributed_to)
                    && fact_fingerprint(&x.fact) == fingerprint
            });
            let page = read_page(&*read, source, r.slug)?;
            rows.push((
                source.to_string(),
                r.slug.to_string(),
                f.id,
                json!({
                    "id": f.id,
                    "source_id": source,
                    "slug": r.slug,
                    "fact": f.fact,
                    "visibility": f.visibility,
                    "entity_slug": f.entity_slug,
                    "attributed_to": f.attributed_to,
                    "superseded": f.superseded_by.is_some(),
                    "generation_id": r.generation_id,
                    "generation": r.generation.generation,
                    "retired_at": iso(r.generation.created_at_us),
                    "expired_at": f.expired_at_us.map(iso),
                    "preimage": r.preimage,
                    "fingerprint": fingerprint,
                    "page_id": page.as_ref().map(|p| p.id),
                    // `p.deleted_at IS NOT NULL` over the LEFT JOIN: false with no page row.
                    "page_deleted": page.as_ref().is_some_and(|p| p.deleted_at_us.is_some()),
                    // No member sets `version_history_gap_at` on Rust (page-state/versions.ts
                    // writes it with raw SQL and refuses), so no page has a gap.
                    "history_gap": false,
                    "withdrawn": withdrawn,
                    "active_duplicate": active_duplicate,
                }),
            ));
        }
        rows.sort_by(|x, y| (&x.0, &x.1, x.2).cmp(&(&y.0, &y.1, y.2)));
        Ok(rows.into_iter().map(|(_, _, _, row)| row).collect())
    }

    /// The source's withdrawal keys as (visibility, fact_hash, subject).
    fn withdrawal_keys(&self, source: &str) -> Result<BTreeSet<(String, String, String)>> {
        Ok(self
            .list_fact_withdrawal_keys(source, i64::MAX)?
            .into_iter()
            .map(|k| (k.visibility, k.fact_hash, k.subject))
            .collect())
    }
}

/// `withdrawalCoversFactSql`: on a member page only that page's withdrawal covers the row;
/// otherwise the withdrawal's reach ([`withdrawal_covers`]).
fn covers_fact(read: &dyn KvRead, f: &FactRecord, subject: &str) -> Result<bool> {
    let slug = f.source_markdown_slug.as_deref().unwrap_or("");
    if slug.starts_with(super::MEMBER_PAGE_PREFIX) {
        return Ok(subject == slug);
    }
    withdrawal_covers(read, f, subject)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::facts::{ExpireFactArgs, InsertFactsArgs};
    use crate::generations::{LedgerItem, put_ledger_row};

    fn generation(id: u64, id_text: Value, owner: &str, state: &str, created: i64) -> LedgerRow {
        LedgerRow {
            id,
            source_id: "default".into(),
            kind: "fact_fence".into(),
            owner_key: owner.into(),
            generation: 1,
            state: state.into(),
            created_at_us: created,
            items: vec![LedgerItem {
                action: "retired".into(),
                preimage: Some(json!({ "id": id_text, "fact": "a retired claim",
                    "visibility": "world", "row_num": 1, "expired_at": null })),
            }],
        }
    }

    #[test]
    fn the_newest_retirement_of_an_expired_fact_lists_unless_it_is_held() {
        let store = crate::test_support::store();
        let insert: InsertFactsArgs = serde_json::from_value(json!({ "sourceId": "default",
            "rows": [{ "fact": "a retired claim", "visibility": "world", "source": "mcp:put_page",
                "valid_from": "2026-01-01T00:00:00.000Z" }] }))
        .unwrap();
        store.insert_facts(&insert).unwrap();
        let id = 1u64;
        let args = |slug: Option<&str>| UnwithdrawnArgs {
            source_ids: vec!["default".into()],
            slug: slug.map(str::to_string),
            fence_kind: "fact_fence".into(),
        };
        store
            .write(|tx| {
                put_ledger_row(tx, &generation(1, json!(id), "page:notes/a", "live", 0))?;
                put_ledger_row(
                    tx,
                    &generation(2, json!(id.to_string()), "page:notes/a", "superseded", 5),
                )?;
                put_ledger_row(tx, &generation(3, json!(id), "page:notes/a", "held", 9))
            })
            .unwrap();
        // The fact is still active: nothing lists.
        assert!(
            store
                .list_unwithdrawn_facts(&args(None))
                .unwrap()
                .is_empty()
        );
        let expire = ExpireFactArgs {
            id: id as f64,
            superseded_by: None,
            at: None,
            successor_from: None,
        };
        assert!(store.expire_fact(&expire).unwrap());
        let rows = store.list_unwithdrawn_facts(&args(None)).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["generation_id"], json!(2));
        assert_eq!(rows[0]["slug"], json!("notes/a"));
        assert_eq!(rows[0]["withdrawn"], json!(false));
        assert_eq!(rows[0]["page_id"], Value::Null);
        assert_eq!(rows[0]["page_deleted"], json!(false));
        assert!(
            store
                .list_unwithdrawn_facts(&args(Some("notes/b")))
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            store
                .list_unwithdrawn_facts(&args(Some("notes/a")))
                .unwrap()
                .len(),
            1
        );
    }
}
