//! The keyless conflict slot's read of a remember (src/core/engine-sql/facts-trust.ts):
//! `listLexicalContestCandidates`. It reads only active rows (`expired_at` unset, `valid_until`
//! unset or in the future) whose stamped tier ranks above the writer's (`TRUST_TIER_RANK`; a
//! writer name that is no tier ranks 0).

use super::{FactRecord, source_rows};
use crate::Store;
use crate::error::Result;
use crate::links::no_nul;
use crate::trust::TrustTier;
use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct LexicalContestQuery {
    pub source_id: String,
    pub entity_slug: String,
    pub kind: String,
    pub visibility: String,
    pub page_slug: Option<String>,
    pub writer: String,
}

/// `TRUST_TIER_RANK[writer] ?? 0`.
fn writer_rank(writer: &str) -> u8 {
    TrustTier::parse(writer).map_or(0, TrustTier::rank)
}

impl Store {
    /// `listLexicalContestCandidates`: the active rows of the entity, kind and visibility more
    /// trusted than the writer, on `pageSlug` (a non-empty slug) or, without one, on no owned
    /// memory page; highest id first, at most 200. Each row is `{ id, fact, trust_tier }`.
    pub fn list_lexical_contest_candidates(&self, q: &LexicalContestQuery) -> Result<Vec<Value>> {
        no_nul(
            "listLexicalContestCandidates",
            &[("sourceId", &q.source_id), ("entitySlug", &q.entity_slug)],
        )?;
        let read = self.read()?;
        let now = self.env.now_micros();
        let rank = writer_rank(&q.writer);
        let page = q.page_slug.as_deref().filter(|slug| !slug.is_empty());
        let mut rows: Vec<FactRecord> = source_rows(&*read, &q.source_id)?
            .into_iter()
            .filter(|r| {
                r.entity_slug.as_deref() == Some(q.entity_slug.as_str())
                    && r.kind == q.kind
                    && r.visibility == q.visibility
                    && r.active(now)
                    && r.tier().rank() > rank
                    && match page {
                        Some(slug) => r.source_markdown_slug.as_deref() == Some(slug),
                        None => !r.on_owned_memory_page(),
                    }
            })
            .collect();
        rows.sort_by_key(|r| std::cmp::Reverse(r.id));
        rows.truncate(200);
        Ok(rows
            .iter()
            .map(|r| json!({ "id": r.id, "fact": r.fact, "trust_tier": r.tier().as_str() }))
            .collect())
    }
}
