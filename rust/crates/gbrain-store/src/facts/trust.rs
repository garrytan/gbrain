//! Group 5 facts reads, search relevance and trust reads (src/core/engine-sql/facts-trust.ts).
//!
//! Served: `listFactsForRelevance` (the keyword and entity arms) and `countUncomparableFacts`.
//! Both read the search pool of `search/fact-relevance.ts`, which is, clause by clause:
//!
//! - `f.source_id = ANY(sources)`, then unless `includeExpired`: `expired_at IS NULL`,
//!   `superseded_by IS NULL` and `valid_until` null or in the future;
//! - `f.source` is not an audit checkpoint source;
//! - the row's provenance page (same source, `source_markdown_slug`) carries no `quarantine` key.
//!   `quarantinedProvenanceFilterFragment` does not look at `deleted_at`, so a soft-deleted
//!   quarantined page still hides the row; `hidden_by_quarantine` (live pages only) is not used;
//! - `worldOnly`: `visibility = 'world'`, or a private row `widen` admits (`facts/widen.rs`);
//! - `excludePrivate`: the private-provenance policy (`facts/privacy.rs`);
//! - `projectionEligibleSql('facts')`: a soft-deleted page hides the row. The quarantine clause
//!   of that predicate is the live-page case of the check above. Its `needs_rederive` clause hides a
//!   row a purge marked (`generations/needs_rederive.rs`). Its trust floor (`minTrust`) and flagged-fact
//!   filter (`suppressFlagged`) read the row's stamped `trust_tier` and its write-gate receipts
//!   (`trust::TrustPolicy`).
//!
//! `matchSavedFacts` is served by `facts/saved_match.rs`; `listLexicalContestCandidates` by `facts/contest.rs`.
//! `listRestatedPrivateCopies` is served by `facts/trust_reads.rs`; `readFactForOwnerAction`, `listStandingPreferences`
//! and `countDerivedFactTaint` by `facts/trust_owner.rs`. The `entity_ended` history
//! arm reads the withdrawal ledger through `gbrain_fact_fingerprint`, which no store read joins yet.
//!
//! `similarity` is `1 - (embedding <=> query)` for a row whose embedding is comparable (a vector
//! of the query's model and length whose `embedded_text_hash` is `md5(fact)`), else NULL.

use super::embedding::{cosine_distance, md5_hex, parse_vector, to_halfvec};
use super::widen::world_admits;
use super::{
    AUDIT_ROW_SOURCES, FactRecord, count_arg, entity_rows, hidden_by_deleted_page,
    hidden_by_policy, invalid, like, opt_time, source_rows,
};
use super::{PrivacyPolicy, QUARANTINE_KEY, VisibilityWidening};
use crate::Store;
use crate::env::iso;
use crate::error::Result;
use crate::keyword::{
    FtsConfig, or_of_lexemes, plainto_tsquery_in, to_tsvector_in, ts_matches, ts_rank_cd,
};
use crate::kv::KvRead;
use crate::links::no_nul;
use crate::pages::read_page;
use crate::trust::TrustPolicy;
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

/// A `(source_id, slug)` pair.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct EntityRef {
    pub source_id: String,
    pub slug: String,
}

/// The pool's scope and filters, as the TypeScript member resolved them.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct PoolArgs {
    pub source_ids: Vec<String>,
    pub world_only: bool,
    /// With `worldOnly`, the private rows the caller's member page or private-facts grant also
    /// admits (`facts/widen.rs`).
    pub widen: Option<VisibilityWidening>,
    /// `excludePrivate`: the private-provenance policy (`facts/privacy.rs`).
    pub exclude_private: Option<PrivacyPolicy>,
    /// `minTrust`: `trustFloorSql` over the row's stored tier; null sets none.
    pub min_trust: Option<String>,
    /// `suppressFlagged`: drop a row `activationSuppressedSql('facts')` flags.
    pub suppress_flagged: bool,
    /// `filters.entities`: the `(source_id, entity_slug)` pairs the pool is limited to.
    pub entities: Option<Vec<EntityRef>>,
    pub session_id: Option<String>,
    /// `filters.since`, an ISO time: `COALESCE(valid_from, created_at) >= since`.
    pub since: Option<String>,
    /// With `since`: also the facts with no event date (`filters.includeUndated`, recall's `include_undated`, #10288).
    pub include_undated: bool,
    /// `filters.grep` as the `ILIKE` pattern (`%escaped%`).
    pub grep: Option<String>,
    pub include_expired: bool,
}

/// The query vector a relevance read scores each row against.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct VectorArg {
    pub literal: String,
    pub model: String,
    pub dims: usize,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct RelevanceQuery {
    /// `keyword` or `entity`.
    pub arm: String,
    pub pool: PoolArgs,
    pub vector: Option<VectorArg>,
    /// The keyword arm's search terms.
    pub terms: String,
    /// The entity arm's named entity.
    pub entity: Option<EntityRef>,
    pub limit: f64,
    /// The text search configuration (`GBRAIN_FTS_LANGUAGE`): absent is `english`; `german` is
    /// the other one ported, and any other name refuses.
    pub fts_config: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct UncomparableQuery {
    pub pool: PoolArgs,
    pub dims: usize,
    pub model: String,
    /// Whether the facts embedding column declares exactly `dims`.
    pub declared: bool,
}

/// `poolWhere` over one row, with the clock read once.
pub(super) struct Pool<'a> {
    args: &'a PoolArgs,
    trust: TrustPolicy,
    pub(super) sources: BTreeSet<&'a str>,
    since: Option<i64>,
    now: i64,
}

impl<'a> Pool<'a> {
    pub(super) fn new(op: &str, args: &'a PoolArgs, now: i64) -> Result<Self> {
        let mut texts: Vec<(&str, &str)> = args
            .source_ids
            .iter()
            .map(|s| ("sourceIds", s.as_str()))
            .collect();
        for entity in args.entities.iter().flatten() {
            texts.push(("entities", entity.source_id.as_str()));
            texts.push(("entities", entity.slug.as_str()));
        }
        for (name, text) in [("sessionId", &args.session_id), ("grep", &args.grep)] {
            if let Some(text) = text {
                texts.push((name, text));
            }
        }
        no_nul(op, &texts)?;
        Ok(Self {
            args,
            trust: TrustPolicy::parse(args.min_trust.as_deref(), args.suppress_flagged)?,
            sources: args.source_ids.iter().map(String::as_str).collect(),
            since: opt_time(op, "since", &args.since)?,
            now,
        })
    }

    /// The `WHERE` clauses of `poolWhere`, in the order the SQL states them.
    pub(super) fn admits(&self, read: &dyn KvRead, row: &FactRecord) -> Result<bool> {
        let a = self.args;
        if !self.sources.contains(row.source_id.as_str()) {
            return Ok(false);
        }
        if !a.include_expired
            && (row.expired_at_us.is_some()
                || row.superseded_by.is_some()
                || row.valid_until_us.is_some_and(|until| until <= self.now))
        {
            return Ok(false);
        }
        if AUDIT_ROW_SOURCES.contains(&row.source.as_str()) {
            return Ok(false);
        }
        if quarantined_provenance(read, row)? {
            return Ok(false);
        }
        if a.world_only && !world_admits(read, &a.widen, row)? {
            return Ok(false);
        }
        if hidden_by_policy(read, row, &a.exclude_private)?
            || hidden_by_deleted_page(read, row)?
            || super::hidden_by_rederive(read, row)?
        {
            return Ok(false);
        }
        if !self.trust.admits(read, "facts", row.id, row.tier())? {
            return Ok(false);
        }
        if let Some(entities) = &a.entities
            && !entities.iter().any(|e| {
                e.source_id == row.source_id && row.entity_slug.as_deref() == Some(e.slug.as_str())
            })
        {
            return Ok(false);
        }
        if let Some(session) = &a.session_id
            && row.source_session.as_deref() != Some(session.as_str())
        {
            return Ok(false);
        }
        // `COALESCE(valid_from, created_at) >= since`, and `valid_from IS NOT NULL` unless `includeUndated`.
        if self.since.is_some_and(|since| {
            (!a.include_undated && row.valid_from().is_none()) || row.at_us() < since
        }) {
            return Ok(false);
        }
        if let Some(pattern) = &a.grep
            && !like(&row.fact, pattern, true)?
        {
            return Ok(false);
        }
        Ok(true)
    }
}

/// `quarantinedProvenanceFilterFragment('f')`: the row's provenance page (deleted or not) carries
/// a `quarantine` key.
fn quarantined_provenance(read: &dyn KvRead, row: &FactRecord) -> Result<bool> {
    let Some(slug) = &row.source_markdown_slug else {
        return Ok(false);
    };
    Ok(read_page(read, &row.source_id, slug)?
        .is_some_and(|p| p.frontmatter.contains_key(QUARANTINE_KEY)))
}

/// `1 - (embedding <=> query)` of a comparable row, else NULL.
pub(super) fn similarity(row: &FactRecord, vector: &Option<(Vec<f32>, &VectorArg)>) -> Value {
    match vector {
        Some((target, arg)) if row.comparable(&arg.model, arg.dims) => {
            let distance = cosine_distance(row.embedding.as_deref().unwrap_or(&[]), target);
            json!(1.0 - distance)
        }
        _ => Value::Null,
    }
}

/// One pool row as the SQL returns it: the sixteen `FACT_POOL_COLUMNS`, then `similarity`.
pub(super) fn pool_row(row: &FactRecord, similarity: Value) -> Value {
    json!({
        "id": row.id,
        "fact": row.fact,
        "kind": row.kind,
        "entity_slug": row.entity_slug,
        "source_id": row.source_id,
        "source": row.source,
        "valid_from": row.valid_from().map(iso),
        "valid_until": row.valid_until_us.map(iso),
        "created_at": iso(row.created_at_us),
        "claim_metric": row.claim_metric,
        "claim_period": row.claim_period,
        "source_markdown_slug": row.source_markdown_slug,
        "visibility": row.visibility,
        "attributed_to": row.attributed_to,
        "dimension": row.dimension,
        "value_hash": row.value_hash,
        "similarity": similarity,
    })
}

/// `NOT (embedding IS NOT NULL AND model = $m AND hash = md5(fact) AND vector_dims(embedding) = $n)`
/// in SQL's three-valued logic: a NULL model or hash leaves the conjunction unknown, which `NOT`
/// keeps unknown, and `WHERE` drops. Only a false conjunct makes the row count.
fn uncomparable_undeclared(row: &FactRecord, model: &str, dims: usize) -> bool {
    let parts = [
        Some(row.embedding.is_some()),
        row.embedding_model.as_deref().map(|m| m == model),
        row.embedded_text_hash
            .as_deref()
            .map(|h| h == md5_hex(&row.fact)),
        row.embedding.as_ref().map(|v| v.len() == dims),
    ];
    parts.contains(&Some(false))
}

/// `embedding IS NULL OR embedded_text_hash IS DISTINCT FROM md5(fact)`, or a NULL or different
/// model (the declared column's two-branch `UNION`).
fn uncomparable_declared(row: &FactRecord, model: &str) -> bool {
    row.embedding.is_none()
        || row.embedded_text_hash.as_deref() != Some(md5_hex(&row.fact).as_str())
        || row.embedding_model.as_deref() != Some(model)
}

impl Store {
    /// `listFactsForRelevance` (keyword and entity arms): the pool's rows of one arm, with each
    /// row's cosine to the query vector when it is comparable. The keyword arm keeps the rows
    /// whose `to_tsvector('english', fact || ' ' || entity name)` matches the OR of the terms'
    /// lexemes, a row matching every searched word (the AND `plainto_tsquery`) ahead of any partial
    /// match, then best `ts_rank_cd` first, then `valid_from` and `id` descending; the entity arm
    /// reads the named entity's rows newest first (a future-dated row as of its `created_at`),
    /// then `id` descending.
    pub fn list_facts_for_relevance(&self, q: &RelevanceQuery) -> Result<Vec<Value>> {
        const OP: &str = "listFactsForRelevance";
        let keyword = match q.arm.as_str() {
            "keyword" => true,
            "entity" => false,
            other => return Err(invalid(format!("{OP}: no store read for the {other} arm"))),
        };
        let mut texts = vec![("terms", q.terms.as_str())];
        if let Some(entity) = &q.entity {
            texts.push(("entity", entity.source_id.as_str()));
            texts.push(("entity", entity.slug.as_str()));
        }
        if let Some(vector) = &q.vector {
            texts.push(("vector.model", vector.model.as_str()));
        }
        no_nul(OP, &texts)?;
        let limit = count_arg(OP, "limit", q.limit)?;
        let target = match &q.vector {
            Some(arg) => Some((to_halfvec(&parse_vector(&arg.literal)?, None)?, arg)),
            None => None,
        };
        let config = FtsConfig::parse(q.fts_config.as_deref())?;
        // The keyword arm's AND query (`plainto_tsquery`) pools a fact holding every searched word ahead
        // of any partial match; the OR of its lexemes is what a row must match to be pooled at all.
        let (query, every_word) = if keyword {
            let every_word = plainto_tsquery_in(config, &q.terms)?;
            match or_of_lexemes(&every_word) {
                Some(query) => (Some(query), Some(every_word)),
                None => return Ok(Vec::new()),
            }
        } else {
            (None, None)
        };
        let read = self.read()?;
        let pool = Pool::new(OP, &q.pool, self.env.now_micros())?;
        let candidates: Vec<FactRecord> = if keyword {
            let mut all = Vec::new();
            for source in &pool.sources {
                all.extend(source_rows(&*read, source)?);
            }
            all
        } else {
            let entity = q
                .entity
                .as_ref()
                .ok_or_else(|| invalid(format!("{OP}: the entity arm needs an entity")))?;
            entity_rows(&*read, &entity.source_id, &entity.slug)?
        };
        let mut ranked: Vec<(bool, f32, FactRecord)> = Vec::new();
        for row in candidates {
            if !pool.admits(&*read, &row)? {
                continue;
            }
            let (full, rank) = match &query {
                Some(query) => {
                    let document = format!(
                        "{} {}",
                        row.fact,
                        row.entity_slug.as_deref().unwrap_or("").replace('-', " ")
                    );
                    let vector = to_tsvector_in(config, &document)?;
                    if !ts_matches(&vector, query) {
                        continue;
                    }
                    let full = every_word
                        .as_ref()
                        .is_some_and(|every| ts_matches(&vector, every));
                    (full, ts_rank_cd(&vector, query))
                }
                None => (false, 0.0),
            };
            ranked.push((full, rank, row));
        }
        // Postgres sorts `real` with NaN above every number, as `total_cmp` does for a positive NaN.
        // The keyword arm breaks ties on `valid_from`; the entity arm ranks a future-dated fact by
        // when it was written.
        let now = self.env.now_micros();
        let time = |r: &FactRecord| {
            if keyword {
                r.at_us()
            } else {
                super::ranked_time(r, now)
            }
        };
        ranked.sort_by(|(fa, sa, a), (fb, sb, b)| {
            fb.cmp(fa)
                .then(sb.total_cmp(sa))
                .then(time(b).cmp(&time(a)))
                .then(b.id.cmp(&a.id))
        });
        Ok(ranked
            .iter()
            .take(limit)
            .map(|(_, _, row)| pool_row(row, similarity(row, &target)))
            .collect())
    }

    /// `countUncomparableFacts`: the pool's rows the cosine arm cannot compare (no vector,
    /// another model, a stale text hash or other dimensions), per source, the most first, then
    /// by source id. Only rows of the sources that are unexpired (unless `includeExpired`)
    /// are candidates; the pool then applies on top, as the SQL does.
    pub fn count_uncomparable_facts(&self, q: &UncomparableQuery) -> Result<Vec<Value>> {
        const OP: &str = "countUncomparableFacts";
        no_nul(OP, &[("model", q.model.as_str())])?;
        let read = self.read()?;
        let pool = Pool::new(OP, &q.pool, self.env.now_micros())?;
        let mut counts: BTreeMap<&str, u64> = BTreeMap::new();
        for source in &pool.sources {
            for row in source_rows(&*read, source)? {
                let candidate = (q.pool.include_expired || row.expired_at_us.is_none())
                    && if q.declared {
                        uncomparable_declared(&row, &q.model)
                    } else {
                        uncomparable_undeclared(&row, &q.model, q.dims)
                    };
                if candidate && pool.admits(&*read, &row)? {
                    *counts.entry(*source).or_default() += 1;
                }
            }
        }
        let mut out: Vec<(&str, u64)> = counts.into_iter().collect();
        out.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(b.0)));
        Ok(out
            .iter()
            .map(|(source, n)| json!({ "source_id": source, "n": n }))
            .collect())
    }
}
