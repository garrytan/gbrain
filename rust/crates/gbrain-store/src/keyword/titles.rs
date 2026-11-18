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
//! (`tsquery_or`) from the left. The chain holds at most one query's item bound in all. `'whole'` and `'complete'` match and rank the whole page vector;
//! `'title'` matches and ranks `ts_filter(vector, '{a}')`, the title lexemes. A `'complete'`
//! attempt whose matches do not fit the cap returns no rows and `cut`.
//!
//! The page `search_vector` is not stored; it is rebuilt from the page as PGLite last wrote it:
//!
//! - Sealed form (`pageSearchVectorSql`): the title at weight A and the sanitized timeline the
//!   seal sent at weight C (`pages::search_timeline`), when that seal is the page's current one:
//!   its revision equals the page's `text_projection_revision`.
//! - Trigger form (`update_page_search_vector`): otherwise. Every write that sets the title or
//!   timeline deletes the record (`pages::forget_search_timeline`), as PGLite's trigger then
//!   rewrites the vector, also for a putPage of an unchanged page, whose revision and seal stay.
//!   So no record, or one from an older seal, means PGLite's vector is the one the trigger wrote
//!   at the last title or timeline write: the title at A, the first 65,536
//!   characters of the raw timeline at C, and the first 32,768 characters of the page's
//!   timeline entries (`summary || ' ' || detail`, by id, joined by a space) at C. The trigger
//!   reads the entries that exist when the page row is written; the store keeps the entries
//!   created no later than the page's `updated_at`. A NULL timeline (a segmented page) reads
//!   the page's `timeline_lead`, as the trigger does (`coalesce(timeline, timeline_lead, '')`).
//!   The page_body family keeps the lead in its body state; [`timeline_lead`] reads it there.
//!
//! A sealed segmented page takes the sealed form: PGLite's `sealSegmentedPage` writes the title
//! plus the sanitized lead (withdrawals and purges overlaid), which only TypeScript computes, so
//! the family that seals segmented pages records it with `pages::record_search_timeline`.
//!
//! `ts_rank_cd` is a `real`; times the numeric source factor it is a `double precision`.

use std::collections::HashMap;
use std::sync::Arc;

use serde::Deserialize;
use serde_json::{Value, json};

use super::filters::{KeywordOptions, PageFilter, row_count, source_factor};
use super::rank::ts_rank_cd;
use super::stem::pg_lower;
use super::tsearch::{
    TsQuery, TsVector, Weight, check_query_items, concat, fts_input, is_vector_overflow, setweight,
    to_tsvector, ts_filter, ts_matches, tsquery_or_all, websearch_to_tsquery,
};
use super::vector_cache::{VectorKind, cached};
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

/// The `timeline_lead` of a segmented page: the lead its last flip published, NULL for an inline
/// page or a shell no flip has published (`page_body::timeline_lead`).
fn timeline_lead(read: &dyn KvRead, page: &PageRecord) -> Result<Option<String>> {
    crate::page_body::timeline_lead(read, page.id)
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

/// The sealed form of the page's `search_vector` (`pageSearchVectorSql`): the title at weight A and the sealed timeline
/// at weight C. Cached by both texts (`vector_cache`).
fn sealed_vector(title: &str, timeline: &str) -> Result<Arc<TsVector>> {
    cached(VectorKind::PageSealed, &[title, timeline], || {
        let head = weighted(title, Weight::A)?;
        let tail = weighted(left(timeline, SEARCH_TIMELINE_MAX_CHARS), Weight::C)?;
        concat(&head, &tail)
    })
}

/// The trigger form of the page's `search_vector` (`update_page_search_vector`): the title at weight A, the timeline (or
/// the lead of a segmented page) and the timeline entries the page row sees at weight C.
fn trigger_vector(read: &dyn KvRead, page: &PageRecord) -> Result<Arc<TsVector>> {
    let raw = trigger_timeline(page.timeline.as_deref(), || timeline_lead(read, page))?;
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
    cached(
        VectorKind::PageTrigger,
        &[&page.title, &raw, &joined],
        || {
            let title = weighted(&page.title, Weight::A)?;
            let timeline = weighted(left(&raw, TIMELINE_FTS_MAX_CHARS), Weight::C)?;
            let entries = weighted(left(&joined, TIMELINE_ENTRIES_FTS_MAX_CHARS), Weight::C)?;
            concat(&concat(&title, &timeline)?, &entries)
        },
    )
}

/// The page's `search_vector` (see the module doc).
fn page_vector(read: &dyn KvRead, page: &PageRecord) -> Result<Arc<TsVector>> {
    if let Some(sealed) = search_timeline(read, page.id)?
        && page.text_projection_revision.as_deref() == Some(sealed.revision.as_str())
    {
        return sealed_vector(&page.title, &sealed.timeline);
    }
    trigger_vector(read, page)
}

/// The page's vector as a search reads it, or `None` for a page whose vector cannot be built (past the tsvector size
/// cap). SQL never stores such a page (its trigger raises in the write, and [`check_page_vector`] raises the same here),
/// but a store written before that check may hold one. It matches nothing; it must not fail the searches that pass over
/// it. Any other failure is still an error.
fn readable_page_vector(read: &dyn KvRead, page: &PageRecord) -> Result<Option<Arc<TsVector>>> {
    match page_vector(read, page) {
        Ok(vector) => Ok(Some(vector)),
        Err(e) if is_vector_overflow(&e) => Ok(None),
        Err(e) => Err(e),
    }
}

/// The write-time half of `update_page_search_vector`: builds the vector the trigger would store for `page` (as the
/// write leaves it) and returns the error the trigger raises (\"string is too long for tsvector\") when it cannot be
/// stored. The built vector is cached for the searches that read the page next.
pub(crate) fn check_page_vector(read: &dyn KvRead, page: &PageRecord) -> Result<()> {
    trigger_vector(read, page).map(|_| ())
}

/// The write-time half of `pageSearchVectorSql`: the vector a seal that sends `timeline` stores for a page titled `title`.
pub(crate) fn check_sealed_page_vector(title: &str, timeline: &str) -> Result<()> {
    sealed_vector(title, timeline).map(|_| ())
}

/// `$tsq`: each text's `websearch_to_tsquery(gbrain_fts_input(t))`, ORed from the left.
fn title_query(texts: &[String]) -> Result<TsQuery> {
    let mut queries = Vec::with_capacity(texts.len());
    let mut items = 0usize;
    for text in texts {
        let next = websearch_to_tsquery(&fts_input(text))?;
        // The bound holds for the whole `||` chain, not just each text, so it stops the parsing as well as the join.
        // An empty query (a stopword-only text) is skipped by `||` and adds no item and no operator; a nonempty one
        // adds its items and, unless it comes first, the OR that joins it. The count is `tsquery_or_all`'s own.
        if !next.items.is_empty() {
            items += next.items.len() + usize::from(items > 0);
            check_query_items(items)?;
        }
        queries.push(next);
    }
    tsquery_or_all(queries)
}

/// `lower(btrim(title, ' "''' || chr(160)))`.
fn exact_title_key(title: &str) -> String {
    pg_lower(title.trim_matches(&EXACT_TITLE_TRIM[..]))
}

/// A page that passed the filters, with its vectors built on first use.
struct Candidate {
    page: PageRecord,
    whole: Arc<TsVector>,
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
                let Some(whole) = readable_page_vector(&*read, &page)? else {
                    continue;
                };
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
        let parts = |texts: &[&str]| {
            tsquery_or_all(
                texts
                    .iter()
                    .map(|t| websearch_to_tsquery(t).unwrap())
                    .collect(),
            )
            .unwrap()
        };
        let q = parts(&["alpha", "beta gamma"]);
        assert_eq!(q.to_text(), "'alpha' | 'beta' & 'gamma'");
        // PGLite: ts_rank_cd('alpha beta', 'alpha' | 'beta' & 'gamma') = 0.10000000149011612.
        let doc = to_tsvector("alpha beta").unwrap();
        assert_eq!(f64::from(ts_rank_cd(&doc, &q)), 0.10000000149011612);
        // An empty query (all stopwords) is skipped wherever it stands; three queries fold from the left.
        assert_eq!(parts(&["the", "alpha", "beta gamma"]), q);
        assert_eq!(parts(&["alpha", "the", "beta gamma", "the"]), q);
        assert_eq!(parts(&["alpha", "beta gamma", "the"]), q);
        assert!(parts(&["the"]).items.is_empty());
        assert_eq!(
            parts(&["alpha", "beta", "gamma"]).to_text(),
            "'alpha' | 'beta' | 'gamma'"
        );
        assert_eq!(
            parts(&["alpha beta", "gamma delta", "epsilon"]).to_text(),
            "'alpha' & 'beta' | 'gamma' & 'delta' | 'epsilon'"
        );
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

    /// A segmented page published from one segment with `lead` as its timeline lead.
    fn segmented(store: &Store, slug: &str, title: &str, lead: &str) {
        use sha2::{Digest, Sha256};
        let staging = "66666666-6666-4666-8666-666666666666";
        let body = "one\n";
        let sha: String = Sha256::digest(body.as_bytes())
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        let shell: crate::page_body::ShellOptions =
            serde_json::from_value(json!({"sourceId": "default"})).unwrap();
        let id = store
            .create_segmented_page_shell(
                slug,
                &serde_json::from_value(json!({"type": "note", "title": "Shell"})).unwrap(),
                &shell,
            )
            .unwrap()["id"]
            .clone();
        store
            .open_body_staging(
                &serde_json::from_value(json!({
                    "id": staging, "kind": "put", "principalKind": "local", "principalId": "cli",
                    "clientRequestId": "77777777-7777-4777-8777-777777777777", "sourceId": "default",
                    "sourceIncarnation": "33333333-3333-4333-8333-333333333333", "slug": slug,
                    "pageId": id, "mode": "replace", "declaredBytes": 1, "reservedBytes": 1,
                    "idleExpiresAt": "2099-01-01T00:00:00Z", "hardExpiresAt": "2099-01-02T00:00:00Z",
                }))
                .unwrap(),
            )
            .unwrap();
        let text: crate::page_body::SegmentTextInput = serde_json::from_value(json!({
            "sha256": sha, "body": "6f6e650a", "lineCount": 1,
        }))
        .unwrap();
        let options: crate::page_body::StageTextsOptions =
            serde_json::from_value(json!({"stagingId": staging})).unwrap();
        store
            .stage_segment_texts("default", &[text], &options)
            .unwrap();
        let row: crate::page_body::ManifestRow = serde_json::from_value(json!({
            "pageId": id, "occurrenceId": 1, "genFrom": 1, "seq": 0, "region": "truth",
            "sourceId": "default", "sha256": sha, "byteStart": 0, "byteLen": 4, "lineStart": 0,
            "lineCount": 1, "cutKind": "heading", "entryState": {"depth": 0}, "protectedRegions": [],
            "factsSlots": [], "outline": [], "staticProjBytes": 4, "staticProjLines": 1,
            "hashState": sha, "stagingId": staging,
        }))
        .unwrap();
        store.stage_manifest_rows(&[row]).unwrap();
        let flip: crate::page_body::BodyFlipInput = serde_json::from_value(json!({
            "pageId": id, "expectedGeneration": 0, "newGeneration": 1, "stagingId": staging,
            "retireMaxRows": 1000,
            "body": {
                "content_hash": "h", "body_bytes": 4, "truth_bytes": 4, "body_lines": 1,
                "segment_count": 1, "segmenter_version": 1, "truth_lead": "",
                "timeline_lead": lead, "body_flags": {},
            },
            "meta": {"type": "note", "title": title},
        }))
        .unwrap();
        store.flip_body_generation(&flip).unwrap();
    }

    #[test]
    fn a_segmented_page_without_a_seal_reads_its_published_timeline_lead_at_weight_c() {
        let store = crate::test_support::store();
        segmented(&store, "notes/seg", "Alpha Nebula", "zephyrwinds lead");
        // No seal record: the trigger form, whose NULL timeline reads the flip's lead.
        assert_eq!(
            vector_of(&store),
            "'alpha':1A 'lead':4C 'nebula':2A 'zephyrwind':3C"
        );
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

    /// `searchTitlesAttempts` takes the `||` chain of an attempt's texts from the caller. Each text is one small query,
    /// but the chain holds the item bound of a single query in all: past it the attempt is refused (PostgreSQL answers
    /// `stack depth limit exceeded` for a query it would walk that deep) instead of building a huge query, and a chain
    /// at the bound is still answered.
    #[test]
    fn a_chain_of_texts_past_the_query_item_bound_is_refused() {
        let store = crate::test_support::store();
        put(&store, "notes/a", "Quasar Notes", "");
        let opts = KeywordOptions::default();
        let run = |count: usize| {
            let texts = vec!["quasar"; count];
            store.search_titles_attempts(
                &[attempt(&texts, TitleAttemptKind::Whole, 10.0)],
                "",
                5000.0,
                &opts,
            )
        };
        // 40,000 one-item queries and their 39,999 operators are 79,999 items: under the bound of 131,072.
        let ok = run(40_000).unwrap();
        assert_eq!(slugs(&ok[0]), ["notes/a"]);
        // 70,000 of them are 139,999 items.
        let started = std::time::Instant::now();
        let e = run(70_000).unwrap_err();
        assert!(
            e.message.starts_with("stack depth limit exceeded"),
            "{}",
            e.message
        );
        assert!(started.elapsed() < std::time::Duration::from_secs(20));
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
    /// Distinct six-character tokens whose tsvector is 1,048,570 bytes (ten each): inside the 1,048,575-byte cap alone,
    /// and over it with one more lexeme.
    fn full_title() -> String {
        (0..104_857)
            .map(|i| {
                if i < 100_000 {
                    format!("n{i:05}")
                } else {
                    format!("m{:05}", i - 100_000)
                }
            })
            .collect::<Vec<_>>()
            .join(" ")
    }

    /// Distinct tokens whose tsvector is past the cap by itself.
    fn oversized_title() -> String {
        format!("{} extra", full_title())
    }

    fn quasar_slugs(store: &Store, kind: TitleAttemptKind) -> Vec<String> {
        let out = store
            .search_titles_attempts(
                &[attempt(&["quasar"], kind, 10.0)],
                "",
                10.0,
                &KeywordOptions::default(),
            )
            .unwrap();
        slugs(&out[0])
    }

    /// `trg_pages_search_vector` builds the vector before the row is stored, so a title past the cap fails its own
    /// putPage in SQL with nothing stored, with chunking or without.
    #[test]
    fn a_title_whose_vector_cannot_be_stored_is_refused_at_write_and_changes_nothing() {
        let store = crate::test_support::store();
        put(&store, "notes/ok", "Quasar one", "");
        let before = store.count_pages(None).unwrap();
        let chunks = store.count_chunks().unwrap();
        let big = oversized_title();
        let input: crate::pages::PageInput = serde_json::from_value(
            json!({ "type": "note", "title": big, "compiled_truth": "body text" }),
        )
        .unwrap();
        for index in [json!({}), json!({ "index": false })] {
            let options: crate::pages::PutPageOptions = serde_json::from_value(index).unwrap();
            for slug in ["notes/new", "notes/ok"] {
                let err = store.put_page(slug, &input, &options).unwrap_err();
                assert!(
                    err.message.starts_with("string is too long for tsvector ("),
                    "{}",
                    err.message
                );
            }
        }
        assert_eq!(store.count_pages(None).unwrap(), before);
        assert_eq!(store.count_chunks().unwrap(), chunks);
        let stored = crate::pages::read_page(
            &*store.read().unwrap(),
            crate::sources::DEFAULT_SOURCE,
            "notes/ok",
        )
        .unwrap()
        .unwrap();
        assert_eq!(stored.title, "Quasar one");
        assert_eq!(quasar_slugs(&store, TitleAttemptKind::Whole), ["notes/ok"]);
        // The largest title that fits is stored.
        put(&store, "notes/full", &full_title(), "");
    }

    /// `pageSearchVectorSql` builds the sealed vector in the seal's statement: a sealed timeline that pushes the page
    /// vector past the cap fails the seal and stores nothing (the seal's own state stays as it was).
    #[test]
    fn a_seal_whose_vector_cannot_be_stored_is_refused_and_changes_nothing() {
        let store = crate::test_support::store();
        put(&store, "notes/ok", "Quasar one", "");
        put(&store, "notes/full", &full_title(), "");
        let revision = |store: &Store| {
            crate::pages::read_page(
                &*store.read().unwrap(),
                crate::sources::DEFAULT_SOURCE,
                "notes/full",
            )
            .unwrap()
            .unwrap()
            .text_projection_revision
        };
        let sealed_before = revision(&store);
        let options = crate::chunks::UpsertChunksOptions {
            seal: true,
            search_timeline: Some("alpha beta".into()),
            ..crate::chunks::UpsertChunksOptions::default()
        };
        let err = store
            .upsert_chunks("notes/full", &[], &options)
            .unwrap_err();
        assert!(
            err.message.starts_with("string is too long for tsvector ("),
            "{}",
            err.message
        );
        assert_eq!(revision(&store), sealed_before);
        let read = store.read().unwrap();
        let id = all_pages(&*read)
            .unwrap()
            .into_iter()
            .find(|p| p.slug == "notes/full")
            .unwrap()
            .id;
        assert_eq!(search_timeline(&*read, id).unwrap(), None);
        assert_eq!(quasar_slugs(&store, TitleAttemptKind::Whole), ["notes/ok"]);
    }

    /// A page stored with a vector past the cap (a store written before the write check) matches nothing and fails no
    /// search: the other pages are still found by every attempt kind.
    #[test]
    fn a_stored_page_that_cannot_be_vectored_is_skipped_by_every_attempt() {
        let store = crate::test_support::store();
        put(&store, "notes/ok", "Quasar one", "");
        put(&store, "notes/bad", "Quasar two", "");
        store
            .write(|tx| {
                let mut page =
                    crate::pages::read_page(&*tx, crate::sources::DEFAULT_SOURCE, "notes/bad")?
                        .unwrap();
                page.title = format!("quasar {}", oversized_title());
                crate::put_json(tx, &keys::page(&page.source_id, &page.slug), &page)
            })
            .unwrap();
        for kind in [
            TitleAttemptKind::Whole,
            TitleAttemptKind::Title,
            TitleAttemptKind::Complete,
        ] {
            assert_eq!(quasar_slugs(&store, kind), ["notes/ok"], "{kind:?}");
        }
    }

    /// Slugs of the pages one title attempt over `text` finds.
    fn found(store: &Store, text: &str) -> Vec<String> {
        let out = store
            .search_titles_attempts(
                &[attempt(&[text], TitleAttemptKind::Whole, 10.0)],
                "",
                10.0,
                &KeywordOptions::default(),
            )
            .unwrap();
        slugs(&out[0])
    }

    /// `trg_pages_search_vector` fires for every statement that SETs the title or timeline, also with the values they
    /// already hold, and rebuilds the vector with the timeline entries the page has by then. A page whose title
    /// fits the cap alone but not beside a timeline entry added later is therefore refused by the next putPage, with
    /// no change: before, the check ran only for a changed title or timeline, the write was accepted, and the
    /// updated timestamp brought the entry into the vector the searches read, so the page was silently skipped.
    #[test]
    fn a_putpage_with_unchanged_values_refuses_a_vector_a_timeline_entry_made_too_big() {
        let store = crate::test_support::store();
        put(&store, "notes/full", &full_title(), "");
        assert_eq!(found(&store, "n00005"), ["notes/full"]);
        let entry: crate::timeline::TimelineInput = serde_json::from_value(
            json!({ "date": "2026-01-02", "summary": "extra", "detail": "" }),
        )
        .unwrap();
        store
            .add_timeline_entry(
                "notes/full",
                &entry,
                &crate::timeline::AddTimelineOptions::default(),
            )
            .unwrap();
        let input: crate::pages::PageInput = serde_json::from_value(
            json!({ "type": "note", "title": full_title(), "compiled_truth": "body text", "timeline": "" }),
        )
        .unwrap();
        for index in [json!({}), json!({ "index": false })] {
            let options: crate::pages::PutPageOptions = serde_json::from_value(index).unwrap();
            let err = store
                .put_page("notes/full", &input, &options)
                .expect_err("the unchanged putPage must be refused");
            assert!(
                err.message.starts_with("string is too long for tsvector ("),
                "{}",
                err.message
            );
        }
        assert_eq!(found(&store, "n00005"), ["notes/full"]);
    }

    /// The bound counts the items the chain really holds: only nonempty queries, and an OR only between two of them.
    /// `-quasar` parses to two items (`!'quasar'`) and `the` to none, so `-quasar` followed by 65,535 `quasar` texts holds
    /// 2 + 65,535 + 65,535 = 131,072 items, exactly the bound (accepted), and 65,537 `quasar` texts hold 131,073 (refused).
    /// Before, an OR was counted before the first query and for every empty one: the 131,072-item chain was refused, and so
    /// was 65,536 `quasar` texts with a stopword (131,071 items).
    #[test]
    fn the_item_bound_counts_only_nonempty_queries_and_the_ors_between_them() {
        let store = crate::test_support::store();
        put(&store, "notes/a", "Quasar Notes", "");
        let opts = KeywordOptions::default();
        let run = |lead: &[&str], quasars: usize| {
            let mut texts: Vec<&str> = lead.to_vec();
            texts.extend(std::iter::repeat_n("quasar", quasars));
            store.search_titles_attempts(
                &[attempt(&texts, TitleAttemptKind::Whole, 10.0)],
                "",
                5000.0,
                &opts,
            )
        };
        // 131,072 items: the bound itself.
        let ok = run(&["-quasar"], 65_535).unwrap();
        assert_eq!(slugs(&ok[0]), ["notes/a"]);
        // 131,071 items, with an empty query and a stopword-only query that hold none.
        let ok = run(&["the", "", "the"], 65_536).unwrap();
        assert_eq!(slugs(&ok[0]), ["notes/a"]);
        // 131,073 items.
        let e = run(&[], 65_537).unwrap_err();
        assert!(
            e.message.starts_with("stack depth limit exceeded"),
            "{}",
            e.message
        );
    }
}
