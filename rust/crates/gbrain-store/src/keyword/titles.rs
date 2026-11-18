//! `searchTitles(query, opts?)`: the title arm, one row per page, as `search/title-statement.ts`
//! builds it and `engine-sql/titles.ts` runs it. One call runs a list of attempts, each one
//! statement:
//!
//! ```sql
//! WITH candidates AS MATERIALIZED (            -- 'whole' and 'complete' only
//!   SELECT p.id FROM pages p JOIN sources s ON s.id = p.source_id
//!   WHERE p.search_vector @@ $tsq <filters> [ORDER BY p.id] LIMIT $cap + 1),
//! top_pages AS (
//!   SELECT ..., (lower(btrim(p.title, ' "''' || chr(160))) = $exact) AS exact_title,
//!          ts_rank_cd(<vector>, $tsq) * <source factor> AS score
//!   FROM <the lowest-id $cap candidates, or every matching page for 'title'>
//!   [WHERE (SELECT count(*) FROM candidates) <= $cap]   -- 'complete'
//!   ORDER BY exact_title DESC, score DESC, p.id ASC LIMIT $limit OFFSET $offset)
//! SELECT ..., <representative chunk>, <stale>, (count(candidates) > $cap) AS candidates_cut ...
//! ```
//!
//! `$tsq` is `websearch_to_tsquery(gbrain_fts_input(t))` of each text, joined by `||`
//! (`tsquery_or`) from the left. `'whole'` and `'complete'` match and rank the whole page vector;
//! `'title'` matches and ranks `ts_filter(vector, '{a}')`, the title lexemes. A `'complete'`
//! attempt whose matches do not fit the cap returns no rows and `cut`.
//!
//! The page `search_vector` is not stored; it is rebuilt from the page as PGLite last wrote it:
//!
//! - Sealed form (`pageSearchVectorSql`): the title at weight A and the sanitized timeline the
//!   seal sent at weight C (`pages::search_timeline`), when that seal is the page's current one:
//!   its revision equals the page's `text_projection_revision`.
//! - Trigger form (`update_page_search_vector`): otherwise (no record, or one from an older
//!   seal: PGLite's vector is then the one the trigger wrote at the last title/timeline write), the title at A, the first 65,536
//!   characters of the raw timeline at C, and the first 32,768 characters of the page's
//!   timeline entries (`summary || ' ' || detail`, by id, joined by a space) at C. The trigger
//!   reads the entries that exist when the page row is written; the store keeps the entries
//!   created no later than the page's `updated_at`. A NULL timeline (a segmented page) reads
//!   the page's `timeline_lead`, as the trigger does (`coalesce(timeline, timeline_lead, '')`).
//!   The page_body family keeps the lead in its private body state; [`timeline_lead`] reads
//!   NULL until page_body exposes a `pub(crate)` reader (follow-up `title-vector-segmented-lead`).
//!
//! A sealed segmented page takes the sealed form: PGLite's `sealSegmentedPage` writes the title
//! plus the sanitized lead (withdrawals and purges overlaid), which only TypeScript computes, so
//! the family that seals segmented pages records it with `pages::record_search_timeline`.
//!
//! PGLite's trigger also fires when a putPage writes an unchanged page after its seal (the
//! revision, and so the served state, stays): the vector then holds the trigger form. The store
//! keeps the sealed form until the seal's timeline is dropped (follow-up
//! `title-vector-reput-after-seal`).
//!
//! `ts_rank_cd` is a `real`; times the numeric source factor it is a `double precision`.

use std::collections::HashMap;

use serde::Deserialize;
use serde_json::{Value, json};

use super::filters::{KeywordOptions, PageFilter, row_count, source_factor};
use super::rank::ts_rank_cd;
use super::stem::pg_lower;
use super::tsearch::{
    TsQuery, TsVector, Weight, concat, fts_input, setweight, to_tsvector, ts_filter, ts_matches,
    tsquery_or, websearch_to_tsquery,
};
use crate::Store;
use crate::chunks::{ChunkRecord, read_chunks, read_segment_view};
use crate::env::iso;
use crate::error::{Result, StoreError};
use crate::keys;
use crate::kv::{KvRead, scan_prefix};
use crate::pages::{PageRecord, SEARCH_TIMELINE_MAX_CHARS, all_pages, search_timeline};
use crate::timeline::{TimelineRecord, latest_entry_micros};

/// `PAGE_TIMELINE_FTS_MAX_CHARS` (fts-language.ts): the timeline characters a page vector reads.
const TIMELINE_FTS_MAX_CHARS: usize = 65_536;
/// `PAGE_TIMELINE_ENTRIES_FTS_MAX_CHARS`: the joined timeline-entry characters the trigger reads.
const TIMELINE_ENTRIES_FTS_MAX_CHARS: usize = 32_768;

/// The characters `btrim(title, ' "''' || chr(160))` strips from both ends.
const EXACT_TITLE_TRIM: [char; 4] = [' ', '"', '\'', '\u{A0}'];

/// Which vector an attempt matches and ranks, and whether it is capped.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TitleAttemptKind {
    /// The whole vector; only the lowest-id `cap` matching pages are ranked.
    Whole,
    /// The title lexemes (`ts_filter(vector, '{a}')`); every matching page is ranked.
    Title,
    /// The whole vector, ranked only when every matching page fits the cap.
    Complete,
}

/// One statement of the title arm.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TitleAttempt {
    /// `$1` (the websearch text) and the given-name variants, ORed in this order.
    pub texts: Vec<String>,
    pub kind: TitleAttemptKind,
    pub limit: f64,
    pub offset: f64,
}

/// `left(text, n)`: the first `n` characters.
fn left(text: &str, n: usize) -> &str {
    text.char_indices()
        .nth(n)
        .map_or(text, |(at, _)| &text[..at])
}

/// A weighted `to_tsvector(gbrain_fts_input(text))`.
fn weighted(text: &str, weight: Weight) -> Result<TsVector> {
    Ok(setweight(to_tsvector(&fts_input(text))?, weight))
}

/// The `timeline_lead` of a segmented page (NULL for an inline page). The page_body family keeps
/// it in its private body state; until it exposes a `pub(crate)` reader, this reads NULL (follow-up
/// `title-vector-segmented-lead`), so a segmented page's trigger form holds the title and entries.
fn timeline_lead(_read: &dyn KvRead, _page: &PageRecord) -> Result<Option<String>> {
    Ok(None)
}

/// The trigger's timeline text: `coalesce(timeline, timeline_lead, '')`, the lead read only for a
/// NULL timeline.
fn trigger_timeline(
    timeline: Option<&str>,
    lead: impl FnOnce() -> Result<Option<String>>,
) -> Result<String> {
    Ok(match timeline {
        Some(t) => t.to_owned(),
        None => lead()?.unwrap_or_default(),
    })
}

/// The page's `search_vector` (see the module doc).
fn page_vector(read: &dyn KvRead, page: &PageRecord) -> Result<TsVector> {
    let title = weighted(&page.title, Weight::A)?;
    if let Some(sealed) = search_timeline(read, page.id)?
        && page.text_projection_revision.as_deref() == Some(sealed.revision.as_str())
    {
        let timeline = weighted(left(&sealed.timeline, SEARCH_TIMELINE_MAX_CHARS), Weight::C)?;
        return concat(&title, &timeline);
    }
    let raw = trigger_timeline(page.timeline.as_deref(), || timeline_lead(read, page))?;
    let timeline = weighted(left(&raw, TIMELINE_FTS_MAX_CHARS), Weight::C)?;
    let mut entries: Vec<TimelineRecord> = Vec::new();
    let mut failure = None;
    scan_prefix(read, &keys::timeline_prefix(page.id), false, &mut |_, v| {
        match serde_json::from_slice::<TimelineRecord>(v) {
            Ok(entry) => {
                if entry.created_at_us <= page.updated_at_us {
                    entries.push(entry);
                }
            }
            Err(e) => failure = Some(StoreError::from(e)),
        }
        failure.is_none()
    })?;
    if let Some(e) = failure {
        return Err(e);
    }
    entries.sort_by_key(|e| e.id);
    let joined = entries
        .iter()
        .map(|e| format!("{} {}", e.summary, e.detail))
        .collect::<Vec<_>>()
        .join(" ");
    let entries = weighted(left(&joined, TIMELINE_ENTRIES_FTS_MAX_CHARS), Weight::C)?;
    concat(&concat(&title, &timeline)?, &entries)
}

/// `$tsq`: each text's `websearch_to_tsquery(gbrain_fts_input(t))`, ORed from the left.
fn title_query(texts: &[String]) -> Result<TsQuery> {
    let mut query: Option<TsQuery> = None;
    for text in texts {
        let next = websearch_to_tsquery(&fts_input(text))?;
        query = Some(match query {
            None => next,
            Some(q) => tsquery_or(q, next),
        });
    }
    Ok(query.unwrap_or_default())
}

/// `lower(btrim(title, ' "''' || chr(160)))`.
fn exact_title_key(title: &str) -> String {
    pg_lower(title.trim_matches(&EXACT_TITLE_TRIM[..]))
}

/// A page that passed the filters, with its vectors built on first use.
struct Candidate {
    page: PageRecord,
    whole: TsVector,
    title: Option<TsVector>,
}

impl Candidate {
    fn vector(&mut self, kind: TitleAttemptKind) -> &TsVector {
        match kind {
            TitleAttemptKind::Title => self
                .title
                .get_or_insert_with(|| ts_filter(&self.whole, &[Weight::A])),
            _ => &self.whole,
        }
    }
}

struct Ranked {
    index: usize,
    exact: bool,
    score: f64,
}

/// The representative chunk: visible, text, compiled truth first (only compiled truth for
/// `detail` low), then the lowest chunk index.
fn representative(
    read: &dyn KvRead,
    page: &PageRecord,
    detail_low: bool,
) -> Result<Option<ChunkRecord>> {
    let generation = read_segment_view(read, page.id)?.generation;
    Ok(read_chunks(read, page.id)?
        .into_iter()
        .filter(|c| {
            c.visible_at(generation)
                && c.modality == "text"
                && (!detail_low || c.chunk_source == "compiled_truth")
        })
        .min_by_key(|c| (c.chunk_source != "compiled_truth", c.chunk_index)))
}

fn title_row(page: &PageRecord, chunk: Option<&ChunkRecord>, score: f64, stale: bool) -> Value {
    json!({
        "slug": page.slug,
        "page_id": page.id,
        "title": page.title,
        "type": page.page_type,
        "source_id": page.source_id,
        "effective_date": page.effective_date_us.map(iso),
        "effective_date_source": page.effective_date_source,
        "chunk_id": chunk.map_or(0, |c| c.id),
        "chunk_index": chunk.map_or(0, |c| c.chunk_index),
        "chunk_text": chunk.map_or("", |c| c.chunk_text.as_str()),
        "chunk_source": chunk.map_or("compiled_truth", |c| c.chunk_source.as_str()),
        "score": score,
        "stale": stale,
    })
}

impl Store {
    /// The title arm's statements, in order, over one read: per attempt `{ rows, cut }`, where
    /// `cut` says more pages matched than `candidates_cap` (always `false` for `'title'`).
    /// `exact_key` is `normalizeAlias(query)`. The page filters come from `options`.
    pub fn search_titles_attempts(
        &self,
        attempts: &[TitleAttempt],
        exact_key: &str,
        candidates_cap: f64,
        options: &KeywordOptions,
    ) -> Result<Vec<Value>> {
        let cap = row_count(candidates_cap, "LIMIT")?;
        let windows = attempts
            .iter()
            .map(|a| {
                Ok((
                    row_count(a.limit, "LIMIT")?,
                    row_count(a.offset, "OFFSET")?,
                    title_query(&a.texts)?,
                ))
            })
            .collect::<Result<Vec<_>>>()?;
        let read = self.read()?;
        let mut filter = PageFilter::new(options)?;
        let mut pages = all_pages(&*read)?;
        pages.sort_by_key(|p| p.id);
        let mut candidates: Vec<Candidate> = Vec::new();
        for page in pages {
            if filter.keeps(&*read, &page)? {
                let whole = page_vector(&*read, &page)?;
                candidates.push(Candidate {
                    page,
                    whole,
                    title: None,
                });
            }
        }
        let mut factors: HashMap<usize, f64> = HashMap::new();
        let mut out = Vec::with_capacity(attempts.len());
        for (attempt, (limit, offset, query)) in attempts.iter().zip(windows) {
            let kind = attempt.kind;
            let matched: Vec<usize> = (0..candidates.len())
                .filter(|&i| ts_matches(candidates[i].vector(kind), &query))
                .collect();
            let cut = kind != TitleAttemptKind::Title && matched.len() > cap;
            let ranked_pages: &[usize] = match kind {
                TitleAttemptKind::Title => &matched,
                TitleAttemptKind::Whole => &matched[..matched.len().min(cap)],
                TitleAttemptKind::Complete if cut => &[],
                TitleAttemptKind::Complete => &matched,
            };
            let mut ranked: Vec<Ranked> = ranked_pages
                .iter()
                .map(|&index| {
                    let factor = *factors
                        .entry(index)
                        .or_insert_with(|| source_factor(&candidates[index].page, &options.boosts));
                    let c = &mut candidates[index];
                    let exact = exact_title_key(&c.page.title) == exact_key;
                    let score = f64::from(ts_rank_cd(c.vector(kind), &query)) * factor;
                    Ranked {
                        index,
                        exact,
                        score,
                    }
                })
                .collect();
            ranked.sort_by(|a, b| {
                b.exact
                    .cmp(&a.exact)
                    .then(b.score.total_cmp(&a.score))
                    .then(
                        candidates[a.index]
                            .page
                            .id
                            .cmp(&candidates[b.index].page.id),
                    )
            });
            let mut rows = Vec::new();
            for r in ranked.into_iter().skip(offset).take(limit) {
                let page = &candidates[r.index].page;
                let chunk = representative(&*read, page, options.detail_low)?;
                let stale = latest_entry_micros(&*read, page.id)?
                    .is_some_and(|latest| page.updated_at_us < latest);
                rows.push(title_row(page, chunk.as_ref(), r.score, stale));
            }
            out.push(json!({ "rows": rows, "cut": cut }));
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn put(store: &Store, slug: &str, title: &str, timeline: &str) {
        let input: crate::pages::PageInput = serde_json::from_value(json!({
            "type": "note", "title": title, "compiled_truth": "body text", "timeline": timeline,
        }))
        .unwrap();
        store
            .put_page(slug, &input, &crate::pages::PutPageOptions::default())
            .unwrap();
    }

    fn attempt(texts: &[&str], kind: TitleAttemptKind, limit: f64) -> TitleAttempt {
        TitleAttempt {
            texts: texts.iter().map(|t| t.to_string()).collect(),
            kind,
            limit,
            offset: 0.0,
        }
    }

    fn slugs(result: &Value) -> Vec<String> {
        result["rows"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| r["slug"].as_str().unwrap().to_string())
            .collect()
    }

    #[test]
    fn ts_filter_keeps_title_positions_and_tsquery_or_puts_the_left_operand_first() {
        let v = concat(
            &setweight(to_tsvector("alpha beta").unwrap(), Weight::A),
            &to_tsvector("alpha gamma").unwrap(),
        )
        .unwrap();
        assert_eq!(
            ts_filter(&v, &[Weight::A]).to_text(),
            "'alpha':1A 'beta':2A"
        );
        let q = tsquery_or(
            websearch_to_tsquery("alpha").unwrap(),
            websearch_to_tsquery("beta gamma").unwrap(),
        );
        assert_eq!(q.to_text(), "'alpha' | 'beta' & 'gamma'");
        // PGLite: ts_rank_cd('alpha beta', 'alpha' | 'beta' & 'gamma') = 0.10000000149011612.
        let doc = to_tsvector("alpha beta").unwrap();
        assert_eq!(f64::from(ts_rank_cd(&doc, &q)), 0.10000000149011612);
        let empty = websearch_to_tsquery("the").unwrap();
        assert_eq!(tsquery_or(empty.clone(), q.clone()), q);
        assert_eq!(tsquery_or(q.clone(), empty), q);
    }

    #[test]
    fn the_trigger_form_reads_the_timeline_and_older_entries_at_weight_c() {
        let store = crate::test_support::store();
        put(&store, "notes/a", "Alpha Nebula", "gamma linex");
        let read = store.read().unwrap();
        let page = all_pages(&*read).unwrap().remove(0);
        assert_eq!(
            page_vector(&*read, &page).unwrap().to_text(),
            "'alpha':1A 'gamma':3C 'linex':4C 'nebula':2A"
        );
        assert_eq!(left("héllo", 2), "hé");
        assert_eq!(left("hi", 5), "hi");
    }

    fn seal(store: &Store, slug: &str, search_timeline: Option<&str>) {
        let options = crate::chunks::UpsertChunksOptions {
            seal: true,
            search_timeline: search_timeline.map(str::to_owned),
            ..crate::chunks::UpsertChunksOptions::default()
        };
        store.upsert_chunks(slug, &[], &options).unwrap();
    }

    fn vector_of(store: &Store) -> String {
        let read = store.read().unwrap();
        let page = all_pages(&*read).unwrap().remove(0);
        page_vector(&*read, &page).unwrap().to_text()
    }

    #[test]
    fn the_sealed_form_reads_the_seal_timeline_only_at_the_current_seal() {
        let store = crate::test_support::store();
        put(&store, "notes/a", "Alpha Nebula", "gamma linex");
        // The seal's sanitized text replaces the raw timeline.
        seal(&store, "notes/a", Some("delta"));
        assert_eq!(vector_of(&store), "'alpha':1A 'delta':3C 'nebula':2A");
        // A new revision sealed without text: the record is from an older seal, so the trigger form.
        put(&store, "notes/a", "Alpha Nebula", "omega");
        assert_eq!(vector_of(&store), "'alpha':1A 'nebula':2A 'omega':3C");
        seal(&store, "notes/a", Some(""));
        assert_eq!(vector_of(&store), "'alpha':1A 'nebula':2A");
    }

    #[test]
    fn a_null_timeline_reads_the_lead_and_a_present_timeline_never_does() {
        let lead = || Ok(Some("segment lead".to_owned()));
        assert_eq!(trigger_timeline(None, lead).unwrap(), "segment lead");
        assert_eq!(
            trigger_timeline(Some(""), || panic!("read the lead")).unwrap(),
            ""
        );
        assert_eq!(
            trigger_timeline(Some("raw"), || panic!("read the lead")).unwrap(),
            "raw"
        );
        assert_eq!(trigger_timeline(None, || Ok(None)).unwrap(), "");
    }

    #[test]
    fn exact_titles_lead_then_score_then_page_id_and_title_attempts_skip_timelines() {
        let store = crate::test_support::store();
        put(&store, "notes/a", "Quasar Notes", "");
        put(&store, "notes/b", "Quasar", "");
        put(&store, "notes/c", "Other", "quasar mentioned");
        let opts = KeywordOptions::default();
        let out = store
            .search_titles_attempts(
                &[
                    attempt(&["quasar"], TitleAttemptKind::Whole, 10.0),
                    attempt(&["quasar"], TitleAttemptKind::Title, 10.0),
                ],
                "quasar",
                5000.0,
                &opts,
            )
            .unwrap();
        // notes/a and notes/c tie on ts_rank_cd; page id breaks the tie.
        assert_eq!(slugs(&out[0]), ["notes/b", "notes/a", "notes/c"]);
        assert_eq!(out[0]["cut"], false);
        assert_eq!(slugs(&out[1]), ["notes/b", "notes/a"]);
        // Representative chunk defaults for a page without chunks.
        let row = &out[0]["rows"][0];
        assert_eq!(row["chunk_source"], "compiled_truth");
    }

    #[test]
    fn the_cap_ranks_the_lowest_ids_and_complete_attempts_return_nothing_when_cut() {
        let store = crate::test_support::store();
        put(&store, "notes/a", "Quasar one", "");
        put(&store, "notes/b", "Quasar two", "");
        put(&store, "notes/c", "Quasar three", "");
        let opts = KeywordOptions::default();
        let out = store
            .search_titles_attempts(
                &[
                    attempt(&["quasar"], TitleAttemptKind::Whole, 10.0),
                    attempt(&["quasar"], TitleAttemptKind::Complete, 10.0),
                    attempt(&["quasar"], TitleAttemptKind::Title, 10.0),
                ],
                "",
                2.0,
                &opts,
            )
            .unwrap();
        assert_eq!(slugs(&out[0]), ["notes/a", "notes/b"]);
        assert_eq!(out[0]["cut"], true);
        assert!(slugs(&out[1]).is_empty());
        assert_eq!(out[1]["cut"], true);
        assert_eq!(slugs(&out[2]).len(), 3);
        assert_eq!(out[2]["cut"], false);
    }

    #[test]
    fn exact_key_trims_quotes_and_lowercases_like_postgres() {
        assert_eq!(exact_title_key("\u{A0}\"ÉCOLE Ǆ\" "), "école ǆ");
    }
}
