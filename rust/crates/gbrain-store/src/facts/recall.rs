//! The candidate-pool reads of a fact recall (`engine-sql/facts-recall.ts`): `readFactsEmbeddingColumn`,
//! `listNearestFacts`, `listSlotRows`, `listPoolUnbackedKeys`, `listCallOffCueFacts`, `listPoolEntityPairs` and
//! `listPooledFactRows`.
//!
//! Every pool read admits a row exactly as `listFactsForRelevance` does (`facts/trust.rs`, `Pool::admits`): the source,
//! the expiry clauses unless `includeExpired`, the audit sources, a quarantined provenance page, the visibility and
//! private-provenance policies, a soft-deleted page, the trust floor and the filters.
//! See rust/docs/store/facts.md, "Recall candidate-pool reads".
//!
//! - `readFactsEmbeddingColumn`: the column the store keeps, `halfvec` of the configured width.
//! - `listNearestFacts`: pool rows with a vector of the query's model (and, when the column does not declare its width,
//!   of the query's length), nearest by cosine first, at most `limit`; `similarity` is set on a comparable row only.
//! - `listSlotRows`: pool rows (expired ones included) that are still active conversation slot rows of the given
//!   `(source, entity, dimension)` slots, by `valid_from` then `id`.
//! - `listPoolUnbackedKeys`: the distinct `(source, entity)` pairs of pool rows whose entity is one of `keys` and has no
//!   live page, by source then slug, at most `limit`.
//! - `listCallOffCueFacts`: for each `(source, entity)` pair, the newest 50 pool rows whose text holds a retraction or
//!   call-off phrase (`\m(...)\M`, case-insensitive).
//! - `listPoolEntityPairs`: the distinct `(source, entity)` pairs of the pool rows that have an entity.
//! - `listPooledFactRows`: the whole rows of the given ids that the pool admits (recall's second read of its ranked ids,
//!   #10225), in id order.

use super::embedding::{cosine_distance, parse_vector, to_halfvec};
use super::forget::fact_number;
use super::saved_match::word_char;
use super::trust::{Pool, PoolArgs, VectorArg, pool_row, similarity};
use super::{FactRecord, OwnerOnlyCache, count_arg, invalid, read_fact, source_rows};
use crate::Store;
use crate::chunks::embedding_dimensions;
use crate::error::Result;
use crate::keyword::pg_lower;
use crate::links::no_nul;
use crate::pages::read_page;
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::BTreeSet;

/// Cue facts read per entity at most (`CALL_OFF_DEPTH`).
const CALL_OFF_DEPTH: usize = 50;

/// `RETRACTION` (search/saved-facts-match.ts) and `CALLED_OFF` (engine-sql/facts-recall.ts), each alternative spelled out
/// (`retract(s|ed|ing|ion)?` and `not what (i|we) (posted|said|wrote)` expanded).
const CALL_OFF_PHRASES: [&str; 28] = [
    "retract",
    "retracts",
    "retracted",
    "retracting",
    "retraction",
    "disregard",
    "scratch that",
    "i misspoke",
    "i was wrong",
    "not what i posted",
    "not what i said",
    "not what i wrote",
    "not what we posted",
    "not what we said",
    "not what we wrote",
    "ignore the",
    "ignore my",
    "ignore that",
    "ignore what",
    "rumour",
    "rumor",
    "called off",
    "cancelled",
    "canceled",
    "fell through",
    "not happening",
    "never happened",
    "no longer planned",
];

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct NearestArgs {
    pub pool: PoolArgs,
    pub vector: VectorArg,
    /// Whether the facts embedding column declares its width (otherwise rows are also matched on their length).
    pub declared: bool,
    pub limit: f64,
}

/// A `(source, entity)` pair.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct PairKey {
    pub source_id: String,
    pub entity_slug: String,
}

/// A `(source, entity, dimension)` slot.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct SlotKey {
    pub source_id: String,
    pub entity_slug: String,
    pub dimension: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct SlotArgs {
    pub pool: PoolArgs,
    pub slots: Vec<SlotKey>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct UnbackedArgs {
    pub pool: PoolArgs,
    pub keys: Vec<String>,
    pub limit: f64,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct CueArgs {
    pub pool: PoolArgs,
    pub pairs: Vec<PairKey>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct PairsArgs {
    pub pool: PoolArgs,
}

/// `listPooledFactRows`: the fact `ids` to read again under the pool.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct PooledRowsArgs {
    pub pool: PoolArgs,
    pub ids: Vec<f64>,
}

/// `text ~* '\m(<phrases>)\M'`: some phrase starts at a word start and ends at a word end.
fn has_call_off_cue(text: &str) -> bool {
    let chars: Vec<char> = pg_lower(text).chars().collect();
    let phrases: Vec<Vec<char>> = CALL_OFF_PHRASES
        .iter()
        .map(|p| p.chars().collect())
        .collect();
    (0..chars.len()).any(|at| {
        (at == 0 || !word_char(chars[at - 1]))
            && phrases.iter().any(|p| {
                let end = at + p.len();
                end <= chars.len()
                    && chars[at..end] == p[..]
                    && (end == chars.len() || !word_char(chars[end]))
            })
    })
}

/// A pool row as `FACT_POOL_COLUMNS` selects it, without the `similarity` column.
fn plain_row(row: &FactRecord) -> Value {
    let mut value = pool_row(row, Value::Null);
    if let Value::Object(map) = &mut value {
        map.remove("similarity");
    }
    value
}

/// The pool's admitted rows over every source of the pool, in source then id order.
fn admitted(store: &Store, op: &str, args: &PoolArgs) -> Result<Vec<FactRecord>> {
    let read = store.read()?;
    let pool = Pool::new(op, args, store.env.now_micros())?;
    let mut out = Vec::new();
    let mut owner_only = OwnerOnlyCache::default();
    for source in &pool.sources {
        for row in source_rows(&*read, source)? {
            if pool.admits(&*read, &row, &mut owner_only)? {
                out.push(row);
            }
        }
    }
    Ok(out)
}

impl Store {
    /// `readFactsEmbeddingColumn`: the store keeps `halfvec` at the configured width.
    pub fn read_facts_embedding_column(&self) -> Result<Value> {
        let read = self.read()?;
        let dims = embedding_dimensions(&*read)?;
        Ok(json!({ "type": "halfvec", "dims": dims }))
    }

    /// `listNearestFacts`: the pool rows nearest the query vector by cosine distance, closest first.
    pub fn list_nearest_facts(&self, args: &NearestArgs) -> Result<Vec<Value>> {
        const OP: &str = "listNearestFacts";
        no_nul(OP, &[("vector.model", args.vector.model.as_str())])?;
        let limit = count_arg(OP, "limit", args.limit)?;
        let target = to_halfvec(&parse_vector(&args.vector.literal)?, None)?;
        let model = &args.vector.model;
        let mut ranked: Vec<(f64, FactRecord)> = Vec::new();
        for row in admitted(self, OP, &args.pool)? {
            let Some(vector) = row.embedding.as_deref() else {
                continue;
            };
            if row.embedding_model.as_deref() != Some(model.as_str()) {
                continue;
            }
            if !args.declared && vector.len() != args.vector.dims {
                continue;
            }
            if vector.len() != target.len() {
                return Err(invalid(format!(
                    "different halfvec dimensions {} and {}",
                    vector.len(),
                    target.len()
                )));
            }
            ranked.push((cosine_distance(vector, &target), row));
        }
        // Postgres sorts `float8` with NaN above every number, as `total_cmp` does for a positive NaN.
        ranked.sort_by(|(da, a), (db, b)| da.total_cmp(db).then(a.id.cmp(&b.id)));
        let query = Some((target, &args.vector));
        Ok(ranked
            .iter()
            .take(limit)
            .map(|(_, row)| pool_row(row, similarity(row, &query)))
            .collect())
    }

    /// `listSlotRows`: the active conversation slot rows of the given slots, `valid_from` then `id`.
    pub fn list_slot_rows(&self, args: &SlotArgs) -> Result<Vec<Value>> {
        const OP: &str = "listSlotRows";
        let mut texts = Vec::new();
        for slot in &args.slots {
            texts.push(("slots", slot.source_id.as_str()));
            texts.push(("slots", slot.entity_slug.as_str()));
            texts.push(("slots", slot.dimension.as_str()));
        }
        no_nul(OP, &texts)?;
        let wanted: BTreeSet<(&str, &str, &str)> = args
            .slots
            .iter()
            .map(|s| {
                (
                    s.source_id.as_str(),
                    s.entity_slug.as_str(),
                    s.dimension.as_str(),
                )
            })
            .collect();
        let mut pool = args.pool.clone();
        pool.include_expired = true;
        let mut rows: Vec<FactRecord> = admitted(self, OP, &pool)?
            .into_iter()
            .filter(|f| {
                f.expired_at_us.is_none()
                    && f.superseded_by.is_none()
                    && f.value_hash.is_some()
                    && f.dim_status.as_deref().unwrap_or("active") == "active"
                    && f.conversation_slot()
                    && matches!((&f.entity_slug, &f.dimension),
                        (Some(entity), Some(dimension))
                            if wanted.contains(&(f.source_id.as_str(), entity.as_str(), dimension.as_str())))
            })
            .collect();
        // `ORDER BY f.valid_from, f.id`: an unknown date sorts last.
        rows.sort_by_key(|f| (f.valid_from().is_none(), f.valid_from_us, f.id));
        Ok(rows.iter().map(plain_row).collect())
    }

    /// `listPoolUnbackedKeys`: the distinct `(source, entity)` pairs of `keys` that hold a pool row and no live page.
    pub fn list_pool_unbacked_keys(&self, args: &UnbackedArgs) -> Result<Vec<Value>> {
        const OP: &str = "listPoolUnbackedKeys";
        let texts: Vec<(&str, &str)> = args.keys.iter().map(|k| ("keys", k.as_str())).collect();
        no_nul(OP, &texts)?;
        let limit = count_arg(OP, "limit", args.limit)?;
        let keys: BTreeSet<&str> = args.keys.iter().map(String::as_str).collect();
        let rows = admitted(self, OP, &args.pool)?;
        let read = self.read()?;
        let mut pairs: BTreeSet<(&str, &str)> = BTreeSet::new();
        for row in &rows {
            let Some(entity) = row.entity_slug.as_deref().filter(|e| keys.contains(e)) else {
                continue;
            };
            let live = read_page(&*read, &row.source_id, entity)?
                .is_some_and(|p| p.deleted_at_us.is_none());
            if !live {
                pairs.insert((row.source_id.as_str(), entity));
            }
        }
        Ok(pairs
            .into_iter()
            .take(limit)
            .map(|(source, entity)| json!({ "source_id": source, "entity_slug": entity }))
            .collect())
    }

    /// `listCallOffCueFacts`: per `(source, entity)` pair, the newest 50 pool rows that hold a call-off phrase.
    pub fn list_call_off_cue_facts(&self, args: &CueArgs) -> Result<Vec<Value>> {
        const OP: &str = "listCallOffCueFacts";
        let mut texts = Vec::new();
        for pair in &args.pairs {
            texts.push(("pairs", pair.source_id.as_str()));
            texts.push(("pairs", pair.entity_slug.as_str()));
        }
        no_nul(OP, &texts)?;
        let wanted: BTreeSet<(&str, &str)> = args
            .pairs
            .iter()
            .map(|p| (p.source_id.as_str(), p.entity_slug.as_str()))
            .collect();
        let mut rows: Vec<FactRecord> = admitted(self, OP, &args.pool)?
            .into_iter()
            .filter(|f| {
                f.entity_slug
                    .as_deref()
                    .is_some_and(|e| wanted.contains(&(f.source_id.as_str(), e)))
                    && has_call_off_cue(&f.fact)
                    && f.valid_from().is_some()
            })
            .collect();
        // The window's order: each partition (source, entity), newest first by the ranking time (a fact dated
        // after now ranks as of when it was saved); a fact with no event date is not a cue (#10288).
        let now = self.env.now_micros();
        rows.sort_by(|a, b| {
            (&a.source_id, &a.entity_slug)
                .cmp(&(&b.source_id, &b.entity_slug))
                .then(super::ranked_time(b, now).cmp(&super::ranked_time(a, now)))
                .then(b.id.cmp(&a.id))
        });
        let mut kept = Vec::new();
        let mut run = 0usize;
        let mut last: Option<(&str, &Option<String>)> = None;
        for row in &rows {
            let key = (row.source_id.as_str(), &row.entity_slug);
            run = if last == Some(key) { run + 1 } else { 1 };
            last = Some(key);
            if run <= CALL_OFF_DEPTH {
                kept.push(plain_row(row));
            }
        }
        Ok(kept)
    }

    /// `listPoolEntityPairs`: the distinct `(source, entity)` pairs of the pool rows that have an entity.
    pub fn list_pool_entity_pairs(&self, args: &PairsArgs) -> Result<Vec<Value>> {
        const OP: &str = "listPoolEntityPairs";
        let rows = admitted(self, OP, &args.pool)?;
        let pairs: BTreeSet<(&str, &str)> = rows
            .iter()
            .filter_map(|f| Some((f.source_id.as_str(), f.entity_slug.as_deref()?)))
            .collect();
        Ok(pairs
            .into_iter()
            .map(|(source, entity)| json!({ "source_id": source, "entity_slug": entity }))
            .collect())
    }

    /// `listPooledFactRows`: the whole rows of `ids` that the pool admits now (a fact whose visibility, provenance or
    /// trust narrowed since the pool read is left out), in id order, a repeated id once and an id below 1 naming no row.
    pub fn list_pooled_fact_rows(&self, args: &PooledRowsArgs) -> Result<Vec<Value>> {
        const OP: &str = "listPooledFactRows";
        let mut ids = BTreeSet::new();
        for id in &args.ids {
            if let Some(id) = fact_number(OP, *id)? {
                ids.insert(id);
            }
        }
        let read = self.read()?;
        let pool = Pool::new(OP, &args.pool, self.env.now_micros())?;
        let mut out = Vec::new();
        let mut owner_only = OwnerOnlyCache::default();
        for id in ids {
            if let Some(row) = read_fact(&*read, id)?
                && pool.admits(&*read, &row, &mut owner_only)?
            {
                out.push(row.to_json(false, false));
            }
        }
        Ok(out)
    }
}

impl Store {
    /// `listFactSourcePages(ids)` (search/facts-arm.ts applyFactSourcePages): for each distinct id, the live page of the
    /// fact's source whose slug is the fact's `source_markdown_slug`, when that slug is set and is not the fact's entity
    /// (`IS DISTINCT FROM`), as `{ id, page_id, slug, title, type }`; facts of any source, in id order (the SQL sets no
    /// order). A missing fact or page gives no row.
    pub fn list_fact_source_pages(&self, ids: &[f64]) -> Result<Vec<Value>> {
        let mut wanted = BTreeSet::new();
        for id in ids {
            if let Ok(id) = u64::try_from(super::bigint("listFactSourcePages", "ids", *id)?) {
                wanted.insert(id);
            }
        }
        let read = self.read()?;
        let mut out = Vec::new();
        for id in wanted {
            let Some(fact) = super::read_fact(&*read, id)? else {
                continue;
            };
            let Some(holding) = fact.source_markdown_slug.as_deref() else {
                continue;
            };
            if fact.entity_slug.as_deref() == Some(holding) {
                continue;
            }
            let Some(page) = read_page(&*read, &fact.source_id, holding)? else {
                continue;
            };
            if page.deleted_at_us.is_some() {
                continue;
            }
            out.push(json!({ "id": fact.id, "page_id": page.id, "slug": page.slug, "title": page.title, "type": page.page_type }));
        }
        Ok(out)
    }

    /// `listTypedClaimFactsAtPages(pageSlugs, entitySlugs)`: the facts whose `source_markdown_slug` is one of
    /// `page_slugs`, whose entity is one of `entity_slugs` and whose `claim_metric` is set, of any source and any state
    /// (the SQL has no other predicate), as `{ id, source_markdown_slug, source_id, entity_slug, claim_metric,
    /// claim_period, valid_from }` with `valid_from` as ISO text. The rows come in source, entity and id order (the SQL
    /// sets none).
    pub fn list_typed_claim_facts_at_pages(
        &self,
        page_slugs: &[String],
        entity_slugs: &[String],
    ) -> Result<Vec<Value>> {
        let pages: BTreeSet<&str> = page_slugs.iter().map(String::as_str).collect();
        let entities: BTreeSet<&str> = entity_slugs.iter().map(String::as_str).collect();
        let mut out = Vec::new();
        if pages.is_empty() || entities.is_empty() {
            return Ok(out);
        }
        let read = self.read()?;
        for source in crate::sources::all_sources(&*read)? {
            for entity in &entities {
                for fact in super::entity_rows(&*read, &source.id, entity)? {
                    let (Some(page), Some(metric)) = (
                        fact.source_markdown_slug.as_deref(),
                        fact.claim_metric.as_deref(),
                    ) else {
                        continue;
                    };
                    if !pages.contains(page) {
                        continue;
                    }
                    out.push(json!({
                        "id": fact.id,
                        "source_markdown_slug": page,
                        "source_id": fact.source_id,
                        "entity_slug": entity,
                        "claim_metric": metric,
                        "claim_period": fact.claim_period,
                        "valid_from": fact.valid_from().map(crate::env::iso),
                    }));
                }
            }
        }
        Ok(out)
    }

    /// `listFactHoldingRefs(ids)`: `{ id, source_id, slug, entity_slug }` for each of `ids` that names a fact, with
    /// `slug` its `source_markdown_slug`; facts of any source and any state, in id order (the SQL sets no order). A
    /// missing fact gives no row.
    pub fn list_fact_holding_refs(&self, ids: &[f64]) -> Result<Vec<Value>> {
        let mut wanted = BTreeSet::new();
        for id in ids {
            if let Ok(id) = u64::try_from(super::bigint("listFactHoldingRefs", "ids", *id)?) {
                wanted.insert(id);
            }
        }
        let read = self.read()?;
        let mut out = Vec::new();
        for id in wanted {
            if let Some(fact) = super::read_fact(&*read, id)? {
                out.push(json!({ "id": fact.id, "source_id": fact.source_id, "slug": fact.source_markdown_slug, "entity_slug": fact.entity_slug }));
            }
        }
        Ok(out)
    }
}
