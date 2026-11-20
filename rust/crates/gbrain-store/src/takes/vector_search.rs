//! Takes: vector search over the take vectors (`searchTakesVector`, `src/core/engine-sql/takes.ts`).
//!
//! Members: searchTakesVector.
//!
//! The SQL reads the active takes with a vector, applies the same holder allow-list, source scope,
//! page policy (`excludePrivate`) and read-eligibility clauses as `searchTakes`, and orders by
//! pgvector's cosine distance `t.embedding <=> query`, with score `(1 - distance)::real`. A take
//! vector counts only while it was written for the take's current claim
//! (`embeddings::current_take_vector`). The distance is pgvector's `cosine_distance` over `vector`
//! (`facts::cosine_distance`: `f32` sums, the similarity in `f64`, clamped, NaN kept). Hits come
//! nearest first, NaN after every number (a zero query vector), then by take id: the SQL has no
//! tiebreak, so two takes at the same distance may come back in either order there.
//!
//! The query vector refuses as pgvector's `::vector` cast and `<=>` refuse it: no element, more
//! than 16000, a NaN or an infinite element, or a width other than a candidate take's vector. A
//! zero query vector scores NaN, which the binding's JSON carries as null (the SQL arms read NaN).

use super::*;
use crate::embeddings::current_take_vector;
use crate::facts::cosine_distance;

/// pgvector's `VECTOR_MAX_DIM`.
const VECTOR_MAX_DIM: usize = 16000;

/// `searchTakesVector(embedding, opts)`; `limit` is already clamped.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct SearchTakesVectorOptions {
    /// The query vector; a null element is a value the caller could not send (NaN).
    pub embedding: Vec<Option<f64>>,
    pub limit: Option<u64>,
    pub allow_list: Option<Vec<Option<String>>>,
    pub source_ids: Option<Vec<Option<String>>>,
    /// A read-eligibility policy was given: hide the takes `projectionEligibleSql` always hides.
    pub eligible_only: bool,
    /// `eligibility.floor`: `trustFloorSql` over the take's stored tier; null sets none.
    pub min_trust: Option<String>,
    /// `eligibility.suppressFlagged`: drop a take `activationSuppressedSql('takes')` flags.
    pub suppress_flagged: bool,
    /// `excludePrivate`: the page policy (`facts/privacy.rs` `page_hidden`); null reads every page.
    pub exclude_private: Option<PrivacyPolicy>,
}

/// The query as pgvector's `'[..]'::vector` input reads it.
fn query_vector(embedding: &[Option<f64>]) -> Result<Vec<f32>> {
    if embedding.is_empty() {
        return Err(StoreError::invalid("vector must have at least 1 dimension"));
    }
    if embedding.len() > VECTOR_MAX_DIM {
        return Err(StoreError::invalid(format!(
            "vector cannot have more than {VECTOR_MAX_DIM} dimensions"
        )));
    }
    embedding
        .iter()
        .map(|v| match v.map(|v| v as f32) {
            None => Err(StoreError::invalid("NaN not allowed in vector")),
            Some(v) if v.is_nan() => Err(StoreError::invalid("NaN not allowed in vector")),
            Some(v) if v.is_infinite() => {
                Err(StoreError::invalid("infinite value not allowed in vector"))
            }
            Some(v) => Ok(v),
        })
        .collect()
}

impl Store {
    /// `searchTakesVector(embedding, opts)`: active takes with a current vector, nearest by cosine
    /// distance first.
    pub fn search_takes_vector(&self, options: &SearchTakesVectorOptions) -> Result<Vec<Value>> {
        const OP: &str = "searchTakesVector";
        let mut parts = list_texts("takesHoldersAllowList", &options.allow_list);
        parts.extend(list_texts("sourceIds", &options.source_ids));
        no_nul(OP, &parts)?;
        let query = query_vector(&options.embedding)?;
        let limit = options.limit.unwrap_or(30) as usize;
        let trust = TrustPolicy::parse(options.min_trust.as_deref(), options.suppress_flagged)?;
        let read = self.read()?;
        let mut pages = PageCache::new(&*read);
        let mut hits: Vec<(f64, TakeRecord, String)> = Vec::new();
        for take in all_takes(&*read)? {
            if !take.active || !allowed(&options.allow_list, &take.holder) {
                continue;
            }
            let Some(stored) = current_take_vector(&*read, &take)? else {
                continue;
            };
            let Some(page) = pages.get(take.page_id)? else {
                continue;
            };
            if !in_scope(&options.source_ids, &page.source_id)
                || (options.eligible_only && !eligible_page(page))
                || private_page(&*read, page, &options.exclude_private)?
                || !trust.admits(&*read, TAKES, take.id, take.trust.tier())?
            {
                continue;
            }
            if stored.vector.len() != query.len() {
                return Err(StoreError::invalid(format!(
                    "different vector dimensions {} and {}",
                    stored.vector.len(),
                    query.len()
                )));
            }
            let distance = cosine_distance(&stored.vector, &query);
            let slug = page.slug.clone();
            hits.push((distance, take, slug));
        }
        hits.sort_by(|(da, a, _), (db, b, _)| {
            da.is_nan()
                .cmp(&db.is_nan())
                .then(da.total_cmp(db))
                .then(a.id.cmp(&b.id))
        });
        Ok(hits
            .iter()
            .take(limit)
            .map(|(distance, t, slug)| t.hit_json(slug, (1.0 - distance) as f32))
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_query_refuses_as_the_vector_cast_does() {
        let err = |v: &[Option<f64>]| query_vector(v).unwrap_err().to_string();
        assert!(err(&[]).contains("at least 1 dimension"));
        assert!(err(&[Some(1.0), None]).contains("NaN not allowed"));
        assert!(err(&[Some(f64::INFINITY)]).contains("infinite value"));
        assert!(err(&vec![Some(0.0); VECTOR_MAX_DIM + 1]).contains("more than 16000"));
        assert_eq!(
            query_vector(&[Some(0.5), Some(-1.0)]).unwrap(),
            vec![0.5, -1.0]
        );
    }
}
