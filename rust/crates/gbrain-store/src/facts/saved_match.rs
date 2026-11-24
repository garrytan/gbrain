//! `matchSavedFacts` (src/core/engine-sql/facts-trust.ts): the keyword scan behind a `search` /
//! `query` saved-facts block, and `readEntityNewestFacts`: a named entity's newest facts under the
//! same candidate rules, without the scan.
//!
//! The candidate rows are, clause by clause:
//!
//! - `f.source_id = ANY(sources)`, `expired_at IS NULL`, `valid_until` null or in the future, and
//!   `f.source` not an audit checkpoint source. A superseded row stays a candidate: the SQL does
//!   not read `superseded_by`;
//! - `worldOnly`: `visibility = 'world'`. The TypeScript member refuses a caller whose
//!   private-facts grant widens it (`grantedPrivateFactSql` not `FALSE`);
//! - `excludePrivate`: the private-provenance policy (`facts/privacy.rs`);
//! - `projectionEligibleSql('facts', { floor: minTrust })`: a soft-deleted page or a live
//!   quarantined provenance page hides the row, and the trust floor reads the stamped tier. Its
//!   `needs_rederive` clause hides a row a purge marked (`generations/needs_rederive.rs`).
//!
//! Each term is `plainto_tsquery('english', term)`, matched against
//! `to_tsvector('english', fact || ' ' || replace(entity_slug, '-', ' '))`; a term with a CJK
//! pattern matches `lower(fact || ' ' || entity_slug) LIKE pat` instead. A term with no lexeme and
//! no pattern is dropped and counts toward neither side of the threshold. `matched` lists the
//! 1-based indexes of the terms a row matches, `need` is
//! `LEAST(4, GREATEST(LEAST(2, n), ceil(n * 0.75)))` over the `n` kept terms, and a row is kept
//! when it matches `need` terms, or `LEAST(2, need)` when it carries the correction cue. Rows rank
//! in two pools (cue rows below `need`, and the rest) by match count, then `valid_from` and `id`
//! descending; each pool keeps its first 200. The result is ordered the same way.
//!
//! The cue is `f.fact ~* CORRECTION_CUE` when `supersede` is on. The store implements the one cue
//! the caller sends (saved-facts-match.ts); the member refuses any other.

use super::{
    AUDIT_ROW_SOURCES, FactRecord, PrivacyPolicy, hidden_by_deleted_page, hidden_by_policy,
    hidden_by_quarantine, like, pg_lower_char, ranked_time, source_rows,
};
use crate::Store;
use crate::cli_reads::pg_text::timestamptz_text;
use crate::env::iso;
use crate::error::Result;
use crate::keyword::{TsQuery, plainto_tsquery, to_tsvector, ts_matches};
use crate::links::no_nul;
use crate::trust::{TrustPolicy, TrustTier};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::BTreeSet;

/// What the member sends: the caller's words, one CJK pattern per word (null for the rest), and
/// the read policy it resolved.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct SavedFactsMatchQuery {
    pub sources: Vec<String>,
    pub terms: Vec<String>,
    pub pats: Vec<Option<String>>,
    /// `search.saved_facts_supersede`: whether `cue` reads the correction cue.
    pub supersede: bool,
    /// `excludePrivate`: the private-provenance policy (`facts/privacy.rs`).
    pub exclude_private: Option<PrivacyPolicy>,
    pub world_only: bool,
    /// `minTrust`: `trustFloorSql` over the row's stored tier; null sets none.
    pub min_trust: Option<String>,
}

/// Rows each pool keeps (`pool_rank <= 200`).
const POOL_CAP: usize = 200;

/// What `readEntityNewestFacts` sends (search/entity-facts.ts): one source's entity slugs and the
/// read policy the caller resolved.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct EntityNewestFactsQuery {
    pub source_id: String,
    pub slugs: Vec<String>,
    /// A remote caller's private-provenance policy (`facts/privacy.rs`); null for a local caller.
    pub exclude_private: Option<PrivacyPolicy>,
    /// `visibility = 'world'`, for a remote caller worldOnlyFacts admits only world facts for.
    pub world_only: bool,
    /// `minTrust`: `trustFloorSql` over the row's stored tier; null sets none.
    pub min_trust: Option<String>,
}

/// Rows `readEntityNewestFacts` returns (`SAVED_FACTS_COLLAPSE_WINDOW`).
const NEWEST_FACTS_WINDOW: usize = 50;

/// The phrases of `CORRECTION_CUE`, `\m(correction|retract(s|ed|ing|ion)?|disregard|scratch that|
/// i misspoke|i was wrong|not what (i|we) (posted|said|wrote)|ignore (the|my|that|what))\M`, each
/// alternative written out.
const CUE_PHRASES: [&str; 20] = [
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

/// A word character of a Postgres regular expression (`\w`): a letter, a digit or `_`.
pub(super) fn word_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

/// `text ~* CORRECTION_CUE`: one phrase, case-insensitively, starting at a word start and ending
/// at a word end. Every phrase is ASCII, and Postgres matches a pattern letter by its upper and
/// lower case forms, so a text character matches when it equals the phrase character ignoring
/// ASCII case.
pub(crate) fn has_correction_cue(text: &str) -> bool {
    let chars: Vec<char> = text.chars().collect();
    let phrases: Vec<Vec<char>> = CUE_PHRASES.iter().map(|p| p.chars().collect()).collect();
    for start in 0..chars.len() {
        if start > 0 && word_char(chars[start - 1]) {
            continue;
        }
        for phrase in &phrases {
            let end = start + phrase.len();
            if end > chars.len() {
                continue;
            }
            let equal = phrase
                .iter()
                .zip(&chars[start..end])
                .all(|(p, c)| c.eq_ignore_ascii_case(p));
            if equal && chars.get(end).is_none_or(|c| !word_char(*c)) {
                return true;
            }
        }
    }
    false
}

/// One kept term: its 1-based index, and its CJK pattern or its query.
enum Term {
    Pattern(usize, String),
    Query(usize, TsQuery),
}

/// `LEAST(4, GREATEST(LEAST(2, n), ceil(n * 0.75)))`.
fn need_of(n: usize) -> usize {
    4.min(n.min(2).max((3 * n).div_ceil(4)))
}

struct Candidate {
    row: FactRecord,
    matched: Vec<usize>,
    cue: bool,
}

impl Store {
    /// `matchSavedFacts`: the candidate rows that match enough of the terms, with their matched
    /// term indexes, `need`, the cue flag, the trust rank and the pool rank, most matches first,
    /// then newest.
    pub fn match_saved_facts(&self, q: &SavedFactsMatchQuery) -> Result<Vec<Value>> {
        const OP: &str = "matchSavedFacts";
        let mut texts: Vec<(&str, &str)> =
            q.sources.iter().map(|s| ("sources", s.as_str())).collect();
        texts.extend(q.terms.iter().map(|t| ("terms", t.as_str())));
        texts.extend(q.pats.iter().flatten().map(|p| ("pats", p.as_str())));
        no_nul(OP, &texts)?;
        // `unnest(terms, pats)` pads the shorter array with NULLs.
        let mut kept = Vec::new();
        for i in 0..q.terms.len().max(q.pats.len()) {
            let term = q.terms.get(i).map_or("", String::as_str);
            match q.pats.get(i).cloned().flatten() {
                Some(pat) => kept.push(Term::Pattern(i + 1, pat)),
                None => {
                    let query = plainto_tsquery(term)?;
                    if !query.items.is_empty() {
                        kept.push(Term::Query(i + 1, query));
                    }
                }
            }
        }
        // No kept term: the any-word scan is `doc @@ NULL`, which matches nothing.
        if kept.is_empty() {
            return Ok(Vec::new());
        }
        let need = need_of(kept.len());
        let trust = TrustPolicy::parse(q.min_trust.as_deref(), false)?;
        let now = self.env.now_micros();
        let read = self.read()?;
        let sources: BTreeSet<&str> = q.sources.iter().map(String::as_str).collect();
        let mut found: Vec<Candidate> = Vec::new();
        for source in &sources {
            for row in source_rows(&*read, source)? {
                if !row.active(now)
                    || AUDIT_ROW_SOURCES.contains(&row.source.as_str())
                    || (q.world_only && row.visibility != "world")
                    || hidden_by_policy(&*read, &row, &q.exclude_private)?
                    || hidden_by_deleted_page(&*read, &row)?
                    || hidden_by_quarantine(&*read, &row)?
                    || super::hidden_by_rederive(&*read, &row)?
                    || !trust.admits(&*read, "facts", row.id, row.tier())?
                {
                    continue;
                }
                let slug = row.entity_slug.as_deref().unwrap_or("");
                let lowered: String = format!("{} {}", row.fact, slug)
                    .chars()
                    .map(pg_lower_char)
                    .collect();
                let vector = to_tsvector(&format!("{} {}", row.fact, slug.replace('-', " ")))?;
                let mut matched = Vec::new();
                for term in &kept {
                    let (index, hit) = match term {
                        Term::Pattern(i, pat) => (*i, like(&lowered, pat, false)?),
                        Term::Query(i, query) => (*i, ts_matches(&vector, query)),
                    };
                    if hit {
                        matched.push(index);
                    }
                }
                let cue = q.supersede && has_correction_cue(&row.fact);
                let floor = if cue { need.min(2) } else { need };
                if matched.len() >= floor {
                    found.push(Candidate { row, matched, cue });
                }
            }
        }
        let order = |a: &Candidate, b: &Candidate| {
            b.matched
                .len()
                .cmp(&a.matched.len())
                .then(b.row.valid_from_us.cmp(&a.row.valid_from_us))
                .then(b.row.id.cmp(&a.row.id))
        };
        found.sort_by(order);
        let (mut below, mut rest) = (0usize, 0usize);
        let mut out = Vec::new();
        for c in &found {
            let pool = if c.cue && c.matched.len() < need {
                &mut below
            } else {
                &mut rest
            };
            *pool += 1;
            if *pool > POOL_CAP {
                continue;
            }
            out.push(row_json(c, need, *pool));
        }
        Ok(out)
    }

    /// `readEntityNewestFacts`: the source's active facts about any of `slugs` under the read
    /// policy, newest first (`ranked_time`: a fact dated after now ranks by when it was written),
    /// then highest id, at most 50, with the collapse columns.
    /// The candidate rules are `matchSavedFacts`'s, without the keyword scan.
    pub fn read_entity_newest_facts(&self, q: &EntityNewestFactsQuery) -> Result<Vec<Value>> {
        const OP: &str = "readEntityNewestFacts";
        let mut texts: Vec<(&str, &str)> = vec![("sourceId", q.source_id.as_str())];
        texts.extend(q.slugs.iter().map(|s| ("slugs", s.as_str())));
        no_nul(OP, &texts)?;
        let slugs: BTreeSet<&str> = q.slugs.iter().map(String::as_str).collect();
        let trust = TrustPolicy::parse(q.min_trust.as_deref(), false)?;
        let now = self.env.now_micros();
        let read = self.read()?;
        let mut found = Vec::new();
        for row in source_rows(&*read, &q.source_id)? {
            if !row
                .entity_slug
                .as_deref()
                .is_some_and(|s| slugs.contains(s))
                || !row.active(now)
                || AUDIT_ROW_SOURCES.contains(&row.source.as_str())
                || (q.world_only && row.visibility != "world")
                || hidden_by_policy(&*read, &row, &q.exclude_private)?
                || hidden_by_deleted_page(&*read, &row)?
                || hidden_by_quarantine(&*read, &row)?
                || !trust.admits(&*read, "facts", row.id, row.tier())?
            {
                continue;
            }
            found.push(row);
        }
        found.sort_by(|a, b| {
            ranked_time(b, now)
                .cmp(&ranked_time(a, now))
                .then(b.id.cmp(&a.id))
        });
        Ok(found
            .iter()
            .take(NEWEST_FACTS_WINDOW)
            .map(newest_row_json)
            .collect())
    }

    /// `matchHeadStems(heads, terms)`: one row per head in `heads` order, each with the 1-based
    /// indexes of the terms whose `plainto_tsquery` the head's `to_tsvector` matches, in `terms`
    /// order. A term that stems to nothing (a stopword) matches no head. English only; the
    /// TypeScript member refuses another language.
    pub fn match_head_stems(&self, heads: &[String], terms: &[String]) -> Result<Vec<HeadStemRow>> {
        const OP: &str = "matchHeadStems";
        let mut texts: Vec<(&str, &str)> = heads.iter().map(|h| ("heads", h.as_str())).collect();
        texts.extend(terms.iter().map(|t| ("terms", t.as_str())));
        no_nul(OP, &texts)?;
        let queries = terms
            .iter()
            .map(|t| plainto_tsquery(t))
            .collect::<Result<Vec<TsQuery>>>()?;
        heads
            .iter()
            .map(|h| {
                let vector = to_tsvector(h)?;
                let i = queries
                    .iter()
                    .enumerate()
                    .filter(|(_, q)| ts_matches(&vector, q))
                    .map(|(at, _)| at as u64 + 1)
                    .collect();
                Ok(HeadStemRow { h: h.clone(), i })
            })
            .collect()
    }
}

/// One `matchHeadStems` row: a name head and the 1-based indexes of the terms it matches.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct HeadStemRow {
    pub h: String,
    pub i: Vec<u64>,
}

/// One `readEntityNewestFacts` row: the fact columns, then `savedFactCollapseColumns`.
fn newest_row_json(row: &FactRecord) -> Value {
    json!({
        "id": row.id,
        "fact": row.fact,
        "entity_slug": row.entity_slug,
        "kind": row.kind,
        "valid_from": timestamptz_text(row.valid_from_us),
        "source": row.source,
        "source_id": row.source_id,
        "visibility": row.visibility,
        "created_at": iso(row.created_at_us),
        "attributed_to": row.attributed_to,
        "fact_fingerprint": super::fact_fingerprint(&row.fact),
    })
}

/// One row as the SQL returns it: the match columns, `savedFactCollapseColumns`, then the scores.
fn row_json(c: &Candidate, need: usize, pool_rank: usize) -> Value {
    let row = &c.row;
    json!({
        "id": row.id,
        "fact": row.fact,
        "entity_slug": row.entity_slug,
        "kind": row.kind,
        "valid_from": timestamptz_text(row.valid_from_us),
        "source": row.source,
        "at": iso(row.valid_from_us),
        "dimension": row.dimension,
        "source_id": row.source_id,
        "visibility": row.visibility,
        "created_at": iso(row.created_at_us),
        "attributed_to": row.attributed_to,
        "fact_fingerprint": super::fact_fingerprint(&row.fact),
        "matched": c.matched,
        "need": need,
        "cue": c.cue,
        // `trustRankSql`: a text that names no tier ranks 0, not as `unknown`.
        "trust_rank": TrustTier::parse(&row.trust_tier).map_or(0, TrustTier::rank),
        "pool_rank": pool_rank,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn need_follows_the_sql_formula() {
        let want = [(1, 1), (2, 2), (3, 3), (4, 3), (5, 4), (6, 4), (12, 4)];
        for (n, need) in want {
            assert_eq!(need_of(n), need, "n = {n}");
        }
    }

    #[test]
    fn the_cue_matches_whole_words_in_any_case() {
        for text in [
            "Correction: the round closed",
            "RETRACTED the figure",
            "scratch that, it was 5",
            "I was wrong about it",
            "that is not what we said",
            "please Ignore the last post",
            "(disregard)",
        ] {
            assert!(has_correction_cue(text), "{text}");
        }
        for text in [
            "corrected elsewhere",
            "the corrections file",
            "retractable roof",
            "scratch  that",
            "precorrection",
            "correction_2",
            "ignore them",
            "",
        ] {
            assert!(!has_correction_cue(text), "{text}");
        }
    }
}
