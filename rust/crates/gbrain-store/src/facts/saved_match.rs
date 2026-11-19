//! `matchSavedFacts` (src/core/engine-sql/facts-trust.ts): the keyword scan behind the saved-facts
//! block of `search` and `query` (src/core/search/saved-facts-match.ts).
//!
//! The SQL, read clause by clause:
//!
//! - `w`: each query term `i` (1-based) with its CJK `LIKE` pattern (or none) and
//!   `plainto_tsquery('english', term)`. A term with no pattern whose tsquery is empty (a stop
//!   word) is dropped. `k.n` counts the terms kept.
//! - The active rows: `source_id` in `sources`, `expired_at` NULL, `valid_until` NULL or in the
//!   future, `source` not an audit checkpoint source and, with `worldOnly`, `visibility = 'world'`
//!   (the TypeScript member refuses a caller whose private-facts grant widens that). Superseded
//!   rows are not excluded.
//! - The eligible rows: the private-provenance policy under `excludePrivate` (`facts/privacy.rs`),
//!   then `projectionEligibleSql('facts')`: a soft-deleted page of the row hides it, so does a live
//!   provenance page with a `quarantine` key, and the `minTrust` floor applies (`trust::TrustPolicy`).
//!   Its `needs_rederive` clause is not modelled, as in `facts/trust.rs`.
//! - `matched`: the indexes of the kept terms the row matches, in order. A CJK term matches when
//!   `lower(fact || ' ' || COALESCE(entity_slug, ''))` is `LIKE` its pattern; any other term when
//!   `to_tsvector('english', fact || ' ' || replace(COALESCE(entity_slug, ''), '-', ' '))` matches
//!   its tsquery. The SQL's keyword scan (any term matches) is implied by the threshold below.
//! - `need` is `LEAST(4, GREATEST(LEAST(2, n), ceil(n * 0.75)))`; `cue` is `supersede` and the fact
//!   matches the correction cue case-insensitively; a row is kept when it matches `need` terms, or
//!   `LEAST(2, need)` when it carries the cue.
//! - `pool_rank` numbers the rows of each pool (a cue row below `need`, or the rest) by match count,
//!   then `valid_from` and `id` descending; rows past 200 in their pool drop. The result sorts the
//!   same way across both pools.
//!
//! The correction cue is the Postgres ARE `\m(correction|retract(s|ed|ing|ion)?|...)\M` of
//! `CORRECTION_CUE`. The store matches the alternatives it spells as literal phrases between word
//! boundaries, and the TypeScript member refuses any other cue text.

use super::{
    AUDIT_ROW_SOURCES, FactRecord, PrivacyPolicy, fact_fingerprint, hidden_by_deleted_page,
    hidden_by_policy, hidden_by_quarantine, like, pg_lower_char, source_rows,
};
use crate::Store;
use crate::env::iso;
use crate::error::Result;
use crate::keyword::{TsQuery, plainto_tsquery, to_tsvector, ts_matches};
use crate::links::no_nul;
use crate::timeline_queries::timestamptz_text;
use crate::trust::TrustPolicy;
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::BTreeSet;

/// The rows each pool keeps (`p.pool_rank <= 200`).
const POOL_CAP: usize = 200;

/// The phrases of `CORRECTION_CUE`, each matched between word boundaries.
const CUE_PHRASES: &[&str] = &[
    "correction",
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
];

/// What the TypeScript member sends: the caller's words and its resolved read policy.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct SavedFactsMatchArgs {
    pub sources: Vec<String>,
    pub terms: Vec<String>,
    /// One `LIKE` pattern per term, null for a term that is not CJK.
    pub pats: Vec<Option<String>>,
    pub supersede: bool,
    pub exclude_private: Option<PrivacyPolicy>,
    pub world_only: bool,
    pub min_trust: Option<String>,
}

/// A Postgres ARE word character (`\m`, `\M`): alphanumeric or underscore.
fn word_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

/// `fact ~* CORRECTION_CUE`: one of the cue phrases, case-folded, between word boundaries.
pub(crate) fn correction_cue(fact: &str) -> bool {
    let text: Vec<char> = fact.chars().map(pg_lower_char).collect();
    CUE_PHRASES.iter().any(|phrase| {
        let p: Vec<char> = phrase.chars().collect();
        (0..text.len()).any(|at| {
            text[at..].starts_with(&p)
                && (at == 0 || !word_char(text[at - 1]))
                && text.get(at + p.len()).is_none_or(|c| !word_char(*c))
        })
    })
}

/// `LEAST(4, GREATEST(LEAST(2, n), ceil(n * 0.75)))`.
fn need(n: usize) -> usize {
    4.min(n.min(2).max((n * 3).div_ceil(4)))
}

/// One kept term: its 1-based index and how a row matches it.
enum Term {
    Like(String),
    Query(TsQuery),
}

struct Hit {
    row: FactRecord,
    matched: Vec<usize>,
    need: usize,
    cue: bool,
}

impl Hit {
    fn order(&self, other: &Hit) -> std::cmp::Ordering {
        other
            .matched
            .len()
            .cmp(&self.matched.len())
            .then(other.row.valid_from_us.cmp(&self.row.valid_from_us))
            .then(other.row.id.cmp(&self.row.id))
    }
}

impl Store {
    /// `matchSavedFacts`: the active, eligible facts of `sources` that share the query's words,
    /// each with its matched term indexes, `need`, `cue`, `trust_rank` and `pool_rank`.
    pub fn match_saved_facts(&self, q: &SavedFactsMatchArgs) -> Result<Vec<Value>> {
        const OP: &str = "matchSavedFacts";
        let mut texts: Vec<(&str, &str)> =
            q.sources.iter().map(|s| ("sources", s.as_str())).collect();
        texts.extend(q.terms.iter().map(|t| ("terms", t.as_str())));
        texts.extend(q.pats.iter().flatten().map(|p| ("pats", p.as_str())));
        no_nul(OP, &texts)?;
        let trust = TrustPolicy::parse(q.min_trust.as_deref(), false)?;
        let mut kept: Vec<(usize, Term)> = Vec::new();
        for (i, term) in q.terms.iter().enumerate() {
            match q.pats.get(i).cloned().flatten() {
                Some(pat) => kept.push((i + 1, Term::Like(pat))),
                None => {
                    let query = plainto_tsquery(term)?;
                    if !query.items.is_empty() {
                        kept.push((i + 1, Term::Query(query)));
                    }
                }
            }
        }
        if kept.is_empty() {
            return Ok(Vec::new());
        }
        let need = need(kept.len());
        let now = self.env.now_micros();
        let read = self.read()?;
        let sources: BTreeSet<&str> = q.sources.iter().map(String::as_str).collect();
        let mut hits: Vec<Hit> = Vec::new();
        for source in sources {
            for row in source_rows(&*read, source)? {
                if row.expired_at_us.is_some()
                    || row.valid_until_us.is_some_and(|until| until <= now)
                    || AUDIT_ROW_SOURCES.contains(&row.source.as_str())
                    || (q.world_only && row.visibility != "world")
                {
                    continue;
                }
                let lowered: String =
                    format!("{} {}", row.fact, row.entity_slug.as_deref().unwrap_or(""))
                        .chars()
                        .map(pg_lower_char)
                        .collect();
                let document = to_tsvector(&format!(
                    "{} {}",
                    row.fact,
                    row.entity_slug.as_deref().unwrap_or("").replace('-', " ")
                ))?;
                let mut matched = Vec::new();
                for (i, term) in &kept {
                    let hit = match term {
                        Term::Like(pat) => like(&lowered, pat, false)?,
                        Term::Query(query) => ts_matches(&document, query),
                    };
                    if hit {
                        matched.push(*i);
                    }
                }
                let cue = q.supersede && correction_cue(&row.fact);
                if matched.len() < if cue { need.min(2) } else { need } {
                    continue;
                }
                if hidden_by_policy(&*read, &row, &q.exclude_private)?
                    || hidden_by_deleted_page(&*read, &row)?
                    || hidden_by_quarantine(&*read, &row)?
                    || !trust.admits(&*read, "facts", row.id, row.tier())?
                {
                    continue;
                }
                hits.push(Hit {
                    row,
                    matched,
                    need,
                    cue,
                });
            }
        }
        hits.sort_by(Hit::order);
        let mut ranks = [0usize; 2];
        let mut out = Vec::new();
        for hit in hits {
            let pool = usize::from(hit.cue && hit.matched.len() < hit.need);
            ranks[pool] += 1;
            if ranks[pool] > POOL_CAP {
                continue;
            }
            let row = &hit.row;
            out.push(json!({
                "id": row.id,
                "fact": row.fact,
                "entity_slug": row.entity_slug,
                "kind": row.kind,
                "valid_from": timestamptz_text(row.valid_from_us),
                "source": row.source,
                "at": iso(row.valid_from_us),
                "source_id": row.source_id,
                "visibility": row.visibility,
                "created_at": iso(row.created_at_us),
                "attributed_to": row.attributed_to,
                "fact_fingerprint": fact_fingerprint(&row.fact),
                "matched": hit.matched,
                "need": hit.need,
                "cue": hit.cue,
                "trust_rank": row.tier().rank(),
                "pool_rank": ranks[pool],
            }));
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn need_follows_the_sql_threshold() {
        let got: Vec<usize> = (1..=8).map(need).collect();
        assert_eq!(got, vec![1, 2, 3, 3, 4, 4, 4, 4]);
    }

    #[test]
    fn the_cue_matches_whole_phrases_case_folded() {
        assert!(correction_cue("Correction: Priya prefers tea"));
        assert!(correction_cue("please DISREGARD the last post"));
        assert!(correction_cue("that was not what we said"));
        assert!(correction_cue("Retraction."));
        assert!(!correction_cue("the corrected figure"));
        assert!(!correction_cue("corrections pending"));
        assert!(!correction_cue("ignore them"));
        assert!(!correction_cue("x_correction"));
        assert!(!correction_cue(""));
    }
}
