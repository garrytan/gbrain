//! `matchSavedFacts` (src/core/engine-sql/facts-trust.ts): the keyword scan behind a `search` /
//! `query` saved-facts block (src/core/search/saved-facts-match.ts).
//!
//! The SQL, clause by clause, as this read serves it:
//!
//! - `w`: each term with its CJK `LIKE` pattern, kept when it has a pattern or when
//!   `numnode(plainto_tsquery(term)) > 0` (a stopword-only term counts toward neither side of
//!   the threshold); `k.n` is the count of kept terms;
//! - the active rows: `source_id = ANY(sources)`, `expired_at IS NULL`, `valid_until` null or in
//!   the future, `source` not an audit checkpoint source, and with `worldOnly` the plain
//!   `visibility = 'world'` (the member refuses when `grantedPrivateFactSql` widens it);
//! - `excludePrivate`: the private-provenance policy (`facts/privacy.rs`);
//! - `projectionEligibleSql('facts', { floor: minTrust })`: a soft-deleted page, a live
//!   quarantined provenance page, and the trust floor hide the row. Its `needs_rederive` clause
//!   is not modelled: the store has no re-derive queue (rust/docs/store/takes.md);
//! - `matched`: the indexes (1-based, in order) of the kept terms whose tsquery matches the
//!   facts keyword document, or whose pattern `LIKE`s `lower(fact || ' ' || entity_slug)`;
//! - `need = LEAST(4, GREATEST(LEAST(2, n), ceil(n * 0.75)))`; `cue = supersede AND fact ~* cue`;
//!   a row is kept when `cardinality(matched) >= (cue ? LEAST(2, need) : need)`. The keyword
//!   scan `doc @@ anyq OR LIKE ANY(pats)` holds for every kept row, since `need >= 1` when
//!   `n >= 1`, and no row passes when `n = 0`;
//! - `pool_rank`: `row_number()` partitioned by `cue AND cardinality(matched) < need`, ordered by
//!   the match count, `valid_from` and id, all descending; rows ranked past 200 drop.
//!
//! The rows come back ordered by match count, `valid_from` and id, all descending. The FTS
//! configuration is `english` and the cue is `CORRECTION_CUE`: the member refuses any other.

use super::{
    AUDIT_ROW_SOURCES, FactRecord, PrivacyPolicy, fact_fingerprint, hidden_by_deleted_page,
    hidden_by_policy, hidden_by_quarantine, like, source_rows,
};
use crate::Store;
use crate::env::iso;
use crate::error::Result;
use crate::keyword::{TsQuery, pg_lower, plainto_tsquery, to_tsvector, ts_matches};
use crate::links::no_nul;
use crate::timeline_queries::timestamptz_text;
use crate::trust::TrustPolicy;
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::BTreeSet;

/// `matchSavedFacts(q)` as the member resolved it.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SavedFactsMatchQuery {
    pub sources: Vec<String>,
    pub terms: Vec<String>,
    /// One `LIKE` pattern per term, null for a term that is not CJK.
    pub pats: Vec<Option<String>>,
    pub supersede: bool,
    pub world_only: bool,
    pub exclude_private: Option<PrivacyPolicy>,
    pub min_trust: Option<String>,
}

/// The phrases `CORRECTION_CUE` (saved-facts-match.ts) spells as one ARE alternation:
/// `\m(correction|retract(s|ed|ing|ion)?|disregard|scratch that|i misspoke|i was wrong|
/// not what (i|we) (posted|said|wrote)|ignore (the|my|that|what))\M`.
const CORRECTION_PHRASES: [&str; 20] = [
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

/// An ARE word character: alphanumeric or `_`.
fn word_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

/// `text ~* CORRECTION_CUE`: some phrase starts at a word start (`\m`) and ends at a word end
/// (`\M`), compared case-insensitively.
fn has_correction_cue(text: &str) -> bool {
    let chars: Vec<char> = pg_lower(text).chars().collect();
    let phrases: Vec<Vec<char>> = CORRECTION_PHRASES
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

/// One kept term of `w`: its 1-based ordinality and either its pattern or its tsquery.
enum Term {
    Pattern(usize, String),
    Query(usize, TsQuery),
}

/// One row that passed the threshold, before the pool cut.
struct Hit {
    row: FactRecord,
    matched: Vec<usize>,
    cue: bool,
}

impl Store {
    /// `matchSavedFacts`: the active facts that share the query's words, with the matched word
    /// indexes, the threshold, the cue flag, the trust rank and the pool rank.
    pub fn match_saved_facts(&self, q: &SavedFactsMatchQuery) -> Result<Vec<Value>> {
        const OP: &str = "matchSavedFacts";
        let mut texts: Vec<(&str, &str)> =
            q.sources.iter().map(|s| ("sources", s.as_str())).collect();
        texts.extend(q.terms.iter().map(|t| ("terms", t.as_str())));
        texts.extend(q.pats.iter().flatten().map(|p| ("pats", p.as_str())));
        no_nul(OP, &texts)?;
        let trust = TrustPolicy::parse(q.min_trust.as_deref(), false)?;
        // `unnest(terms, pats)` pads the shorter array with NULLs.
        let mut terms = Vec::new();
        for i in 0..q.terms.len().max(q.pats.len()) {
            let pat = q.pats.get(i).cloned().flatten();
            let term = q.terms.get(i).map(String::as_str);
            if let Some(pat) = pat {
                terms.push(Term::Pattern(i + 1, pat));
                continue;
            }
            let Some(term) = term else { continue };
            let query = plainto_tsquery(term)?;
            if !query.items.is_empty() {
                terms.push(Term::Query(i + 1, query));
            }
        }
        let n = terms.len();
        if n == 0 {
            return Ok(Vec::new());
        }
        let need = 4.min(n.min(2).max((n * 3).div_ceil(4)));
        let read = self.read()?;
        let now = self.env.now_micros();
        let sources: BTreeSet<&str> = q.sources.iter().map(String::as_str).collect();
        let mut hits = Vec::new();
        for source in sources {
            for row in source_rows(&*read, source)? {
                if row.expired_at_us.is_some()
                    || row.valid_until_us.is_some_and(|until| until <= now)
                    || AUDIT_ROW_SOURCES.contains(&row.source.as_str())
                    || (q.world_only && row.visibility != "world")
                {
                    continue;
                }
                let document = format!(
                    "{} {}",
                    row.fact,
                    row.entity_slug.as_deref().unwrap_or("").replace('-', " ")
                );
                let vector = to_tsvector(&document)?;
                let lowered = pg_lower(&format!(
                    "{} {}",
                    row.fact,
                    row.entity_slug.as_deref().unwrap_or("")
                ));
                let mut matched = Vec::new();
                for term in &terms {
                    let (i, hit) = match term {
                        Term::Pattern(i, pat) => (*i, like(&lowered, pat, false)?),
                        Term::Query(i, query) => (*i, ts_matches(&vector, query)),
                    };
                    if hit {
                        matched.push(i);
                    }
                }
                let cue = q.supersede && has_correction_cue(&row.fact);
                let floor = if cue { need.min(2) } else { need };
                if matched.len() < floor {
                    continue;
                }
                if hidden_by_policy(&*read, &row, &q.exclude_private)?
                    || hidden_by_deleted_page(&*read, &row)?
                    || hidden_by_quarantine(&*read, &row)?
                    || !trust.admits(&*read, "facts", row.id, row.tier())?
                {
                    continue;
                }
                hits.push(Hit { row, matched, cue });
            }
        }
        hits.sort_by(|a, b| {
            b.matched
                .len()
                .cmp(&a.matched.len())
                .then(b.row.valid_from_us.cmp(&a.row.valid_from_us))
                .then(b.row.id.cmp(&a.row.id))
        });
        let (mut below, mut above) = (0usize, 0usize);
        let mut out = Vec::new();
        for hit in hits {
            let pool = if hit.cue && hit.matched.len() < need {
                &mut below
            } else {
                &mut above
            };
            *pool += 1;
            let pool_rank = *pool;
            if pool_rank > 200 {
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
                "need": need,
                "cue": hit.cue,
                "trust_rank": row.tier().rank(),
                "pool_rank": pool_rank,
            }));
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::has_correction_cue;

    #[test]
    fn correction_cue_matches_whole_words_only() {
        for yes in [
            "Correction: it is 12",
            "I RETRACTED that",
            "please disregard",
            "scratch that, 4",
            "Not what we said.",
            "ignore my last note",
            "x_y correction",
        ] {
            assert!(has_correction_cue(yes), "{yes}");
        }
        for no in [
            "corrections were made",
            "corrected later",
            "retractable roof",
            "xcorrection",
            "ignore them",
            "scratch thatch",
            "not what you said",
        ] {
            assert!(!has_correction_cue(no), "{no}");
        }
    }
}
