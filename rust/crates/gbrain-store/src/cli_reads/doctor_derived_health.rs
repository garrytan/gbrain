//! Doctor-derived reads, third part: the page-state checks (`atom_provenance_drift`,
//! `derived_visibility`, `embeddings` backlog age, `privacy_label_ignored`,
//! `credential_projection_pending`). SQL in `src/core/engine-sql/doctor-derived.ts`, docs in
//! `rust/docs/store/cli-reads-doctor-derived.md`. Each read takes one snapshot and has no keys of
//! its own.
//!
//! The store keeps no folder access rules and no pending coverage (`facts/privacy.rs`), so the
//! `folder_rule_ids IS NOT NULL OR gbrain_access_pending_covers(..) OR gbrain_access_state_unreadable()`
//! terms of `countDerivedVisibility` take their empty-table value, false.

use std::collections::{BTreeMap, HashSet};

use serde_json::{Map, Value, json};

use super::doctor_derived::{LiveSources, in_scope, rebuildable};
use super::pg_text::{fm_text, jsonb_text};
use crate::Store;
use crate::aliases::{read_slug_alias, renamed_to};
use crate::chunks::{keyed_chunks, read_chunks, segmented};
use crate::config::read_config;
use crate::env::{iso, parse_iso};
use crate::error::Result;
use crate::facts::privacy::{EDGE_SPACE, alias_private, snapshot_fields_allow};
use crate::kv::KvRead;
use crate::links::out_links;
use crate::page_body::health::{has_published_pem, segmented_body};
use crate::pages::{PageRecord, all_pages, read_page, read_page_by_id};

/// The config key the backfill migration stamps (`embedding_pending_since_backfilled_at`).
const BACKFILLED_KEY: &str = "embedding_pending_since_backfilled_at";
/// The scan cap of the ignored-privacy-label statement (`LIMIT 100001`).
const LABEL_SCAN_CAP: usize = 100_001;
/// The group cap of the same statement (`LIMIT 50`).
const LABEL_GROUPS: usize = 50;

/// `btrim(x, <edge spaces>)`.
fn edge_trim(text: &str) -> &str {
    text.trim_matches(EDGE_SPACE)
}

/// `frontmatter ->> key` of a nested object value.
fn nested_text(frontmatter: &Map<String, Value>, outer: &str, key: &str) -> Option<String> {
    match frontmatter.get(outer)?.as_object()?.get(key)? {
        Value::Null => None,
        Value::String(s) => Some(s.clone()),
        other => Some(jsonb_text(other)),
    }
}

/// `frontmatter ->> 'captured_via' LIKE 'life-chronicle:%'`.
fn life_chronicle(page: &PageRecord) -> bool {
    fm_text(&page.frontmatter, "captured_via").is_some_and(|v| v.starts_with("life-chronicle:"))
}

/// `type = 'concept' AND frontmatter ->> 'synthesized_by' IS NOT NULL`.
fn synthesized_concept(page: &PageRecord) -> bool {
    page.page_type == "concept" && fm_text(&page.frontmatter, "synthesized_by").is_some()
}

/// Whether `page` is live and exists (soft-deleted pages stay in `pages`).
fn live(page: Option<PageRecord>) -> Option<PageRecord> {
    page.filter(|p| p.deleted_at_us.is_none())
}

/// One source's chunks with no vector: how many, how many carry no pending-since stamp, and the
/// oldest stamp.
#[derive(Default)]
struct Backlog {
    pending: i64,
    unaged: i64,
    oldest: Option<i64>,
}

/// The chunks of live pages (not `embed_skip`) with no vector, per source. `sources` keeps only
/// those source ids (`p.source_id = ANY($1)`). `live_body` keeps only the chunks of the page's
/// live body (`chunkGenerationFilter('p', 'cc')`: an inline chunk of a page that is not segmented,
/// a segment chunk of a published occurrence at or below the page's generation); without it every
/// stored chunk counts, as the doctor's backlog age statement reads them.
fn backlog_scan(
    read: &dyn KvRead,
    sources: Option<&HashSet<&str>>,
    live_body: bool,
) -> Result<BTreeMap<String, Backlog>> {
    let mut out: BTreeMap<String, Backlog> = BTreeMap::new();
    for page in all_pages(read)? {
        if page.deleted_at_us.is_some()
            || page.frontmatter.contains_key("embed_skip")
            || sources.is_some_and(|s| !s.contains(page.source_id.as_str()))
        {
            continue;
        }
        let chunks = if live_body {
            keyed_chunks(read, page.id, Some(segmented(&page)))?
                .into_iter()
                .map(|(_, c)| c)
                .collect()
        } else {
            read_chunks(read, page.id)?
        };
        for chunk in chunks {
            if chunk.embed.has_vector() {
                continue;
            }
            let row = out.entry(page.source_id.clone()).or_default();
            row.pending += 1;
            match chunk.embed.pending_since_us {
                Some(since) => row.oldest = Some(row.oldest.map_or(since, |o| o.min(since))),
                None => row.unaged += 1,
            }
        }
    }
    Ok(out)
}

/// The oldest pending-since stamp and the unstamped count over every live chunk with no vector.
fn backlog_chunks(read: &dyn KvRead) -> Result<(Option<i64>, i64)> {
    let (mut oldest, mut unaged) = (None::<i64>, 0i64);
    for row in backlog_scan(read, None, false)?.into_values() {
        unaged += row.unaged;
        oldest = match (oldest, row.oldest) {
            (Some(a), Some(b)) => Some(a.min(b)),
            (a, b) => a.or(b),
        };
    }
    Ok((oldest, unaged))
}

/// `^[0-9]{4}-[0-9]{2}-[0-9]{2}`.
fn iso_date_prefix(text: &str) -> bool {
    let b = text.as_bytes();
    b.len() >= 10
        && b[..10].iter().enumerate().all(|(i, c)| match i {
            4 | 7 => *c == b'-',
            _ => c.is_ascii_digit(),
        })
}

/// `-----(BEGIN|END) [A-Z ]*PRIVATE KEY-----`: after a `-----BEGIN ` or `-----END ` marker, a run
/// of capitals and spaces that ends in (or contains, at its end) `PRIVATE KEY-----`.
fn has_private_key_marker(text: &str) -> bool {
    const TAIL: &[u8] = b"PRIVATE KEY-----";
    let bytes = text.as_bytes();
    for marker in [&b"-----BEGIN "[..], &b"-----END "[..]] {
        let mut from = 0;
        while let Some(at) = find(bytes, marker, from) {
            let start = at + marker.len();
            let mut end = start;
            while end < bytes.len() && (bytes[end].is_ascii_uppercase() || bytes[end] == b' ') {
                end += 1;
            }
            // The run `[A-Z ]*` may stop anywhere in `start..=end`; the tail starts there.
            if (start..=end).any(|j| bytes[j..].starts_with(TAIL)) {
                return true;
            }
            from = at + 1;
        }
    }
    false
}

fn find(haystack: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    haystack
        .get(from..)?
        .windows(needle.len())
        .position(|w| w == needle)
        .map(|p| p + from)
}

/// The slugs an atom's origin reference names for the looser-atom test: the slug itself, or, when
/// no page sits at it, the slug its `rename` alias resolves to (`atomOriginSlugsSql`).
fn atom_origin_slug(read: &dyn KvRead, source: &str, slug: &str) -> Result<String> {
    if read_page(read, source, slug)?.is_none()
        && let Some(alias) = read_slug_alias(read, source, slug)?
        && alias.notes.as_deref() == Some("rename")
    {
        return Ok(alias.canonical_slug);
    }
    Ok(slug.to_string())
}

/// `EXISTS (SELECT 1 FROM slug_rename_history moved JOIN pages moved_to ... WHERE moved.old_slug
/// = <slug> AND moved_to.visibility = 'private')`: a page the slug moved to is explicitly private.
fn moved_to_private(read: &dyn KvRead, source: &str, slug: Option<&str>) -> Result<bool> {
    let Some(slug) = slug else {
        return Ok(false);
    };
    for new in renamed_to(read, source, slug)? {
        if let Some(page) = read_page(read, source, &new)?
            && fm_text(&page.frontmatter, "visibility").as_deref() == Some("private")
        {
            return Ok(true);
        }
    }
    Ok(false)
}

/// The `looser_atoms` term for one world atom: no visible live origin, or an origin it moved to
/// is private.
fn looser_atom(read: &dyn KvRead, atom: &PageRecord) -> Result<bool> {
    let source = atom.source_id.as_str();
    let origin = fm_text(&atom.frontmatter, "source_slug");
    let visible_origin = match origin.as_deref() {
        None => false,
        Some(slug) => {
            let at = atom_origin_slug(read, source, slug)?;
            live(read_page(read, source, &at)?)
                .is_some_and(|o| snapshot_fields_allow(&o.page_type, &o.frontmatter, true))
        }
    };
    Ok(!visible_origin || moved_to_private(read, source, origin.as_deref())?)
}

/// The `looser_concepts` term for one world concept: a concept-provenance input that is private
/// by default, whose origin is private, or whose origin moved to a private page.
fn looser_concept(read: &dyn KvRead, concept: &PageRecord) -> Result<bool> {
    for link in out_links(read, concept.id)? {
        if link.link_source.as_deref() != Some("concept-provenance")
            || link.link_type != "synthesized_from"
        {
            continue;
        }
        let Some(input) = read_page_by_id(read, link.to_page_id)? else {
            continue;
        };
        let source = input.source_id.as_str();
        if fm_text(&input.frontmatter, "visibility").is_none_or(|v| v == "private") {
            return Ok(true);
        }
        let origin = fm_text(&input.frontmatter, "source_slug");
        if let Some(slug) = origin.as_deref() {
            let mut slugs = vec![slug.to_string()];
            if let Some(alias) = read_slug_alias(read, source, slug)?
                && alias.notes.as_deref() == Some("rename")
            {
                slugs.push(alias.canonical_slug);
            }
            for at in slugs {
                if let Some(page) = read_page(read, source, &at)?
                    && fm_text(&page.frontmatter, "visibility").as_deref() == Some("private")
                {
                    return Ok(true);
                }
            }
        }
        if moved_to_private(read, source, origin.as_deref())? {
            return Ok(true);
        }
    }
    Ok(false)
}

/// The `looser_events` term for one event: the page at the event's `depth` slug is not visible,
/// carries an ignored privacy label, or names readers.
fn looser_event(read: &dyn KvRead, event: &PageRecord) -> Result<bool> {
    let Some(depth) = nested_text(&event.frontmatter, "event", "depth") else {
        return Ok(false);
    };
    Ok(
        live(read_page(read, &event.source_id, &depth)?).is_some_and(|o| {
            !snapshot_fields_allow(&o.page_type, &o.frontmatter, true)
                || alias_private(&o.frontmatter)
                || o.frontmatter.contains_key("readable_by")
        }),
    )
}

impl Store {
    /// `readEmbeddingBacklogAge(column)`: one row over the chunks of live pages (not `embed_skip`)
    /// with no vector: `age_s` of the oldest pending-since stamp, `unaged` chunks with no stamp,
    /// and whether the oldest stamp is at or before the backfill time. The store keeps one vector
    /// per chunk, so `column` names the only column there is. The backfill time is a config key
    /// the Rust store never writes; with none (or text that is not an ISO instant) `backfilled`
    /// is NULL, as in a PGLite brain that never ran the backfill.
    /// `readEmbedBacklogRows(column, sourceIds)`: per source among `sourceIds`, the live-body chunks
    /// of live pages (not `embed_skip`) with no vector (`pending`), the ones with no pending-since
    /// stamp (`unaged`) and the oldest stamp as ISO text (`oldest`). A source with none has no row;
    /// rows come in byte order of the source id. `column` names the only vector column there is.
    pub fn read_embed_backlog_rows(&self, _column: &str, source_ids: &[String]) -> Result<Value> {
        let read = self.read()?;
        let wanted: HashSet<&str> = source_ids.iter().map(String::as_str).collect();
        let rows: Vec<Value> = backlog_scan(&*read, Some(&wanted), true)?
            .into_iter()
            .map(|(source_id, row)| {
                json!({
                    "source_id": source_id,
                    "pending": row.pending,
                    "unaged": row.unaged,
                    "oldest": row.oldest.map(iso),
                })
            })
            .collect();
        Ok(Value::Array(rows))
    }

    pub fn read_embedding_backlog_age(&self, _column: &str) -> Result<Value> {
        let read = self.read()?;
        let now = self.env.now_micros();
        let (oldest, unaged) = backlog_chunks(&*read)?;
        let backfilled_at = read_config(&*read, BACKFILLED_KEY)?.and_then(|v| parse_iso(&v));
        Ok(json!({
            "age_s": oldest.map(|o| (now - o) as f64 / 1e6),
            "unaged": unaged,
            "backfilled": oldest.zip(backfilled_at).map(|(o, b)| o <= b),
        }))
    }

    /// `readAtomProvenanceCounts()`: one row over the live atoms that carry a `source_hash`
    /// (a `pending:` marker counts only on a managed atom, and a managed atom sheds it). An atom
    /// with a `source_slug` has drifted when no live page of its source has the first 16 characters
    /// of its hash as `content_hash`; a drifted atom is `source_changed` when its source page (or
    /// the page a `rename` alias moved it to) is live, `source_gone` when not.
    pub fn read_atom_provenance_counts(&self) -> Result<Value> {
        let read = self.read()?;
        let pages = all_pages(&*read)?;
        let live_pages = || pages.iter().filter(|p| p.deleted_at_us.is_none());
        let hashes: HashSet<(&str, String)> = live_pages()
            .filter_map(|p| {
                let hash = p.content_hash.as_deref()?;
                Some((p.source_id.as_str(), hash.chars().take(16).collect()))
            })
            .collect();
        let slugs: HashSet<(&str, &str)> = live_pages()
            .map(|p| (p.source_id.as_str(), p.slug.as_str()))
            .collect();
        let (mut total, mut unbound, mut drifted, mut changed, mut gone) = (0u64, 0u64, 0, 0, 0);
        let mut oldest: Option<String> = None;
        for atom in live_pages().filter(|p| p.page_type == "atom") {
            let fm = &atom.frontmatter;
            let Some(hash) = fm_text(fm, "source_hash") else {
                continue;
            };
            let managed = fm_text(fm, "managed_extraction").as_deref() == Some("true");
            if hash.starts_with("pending:") && !managed {
                continue;
            }
            let hash = if managed {
                hash.strip_prefix("pending:").unwrap_or(&hash).to_string()
            } else {
                hash
            };
            let Some(slug) = fm_text(fm, "source_slug").filter(|s| !s.is_empty()) else {
                unbound += 1;
                continue;
            };
            total += 1;
            let source = atom.source_id.as_str();
            if hashes.contains(&(source, hash)) {
                continue;
            }
            drifted += 1;
            let mut alive = slugs.contains(&(source, slug.as_str()));
            if !alive
                && let Some(alias) = read_slug_alias(&*read, source, &slug)?
                && alias.notes.as_deref() == Some("rename")
            {
                alive = slugs.contains(&(source, alias.canonical_slug.as_str()));
            }
            if alive {
                changed += 1;
            } else {
                gone += 1;
            }
            if let Some(ext) = fm_text(fm, "extracted_at").filter(|e| iso_date_prefix(e))
                && oldest
                    .as_deref()
                    .is_none_or(|o| ext.as_bytes() < o.as_bytes())
            {
                oldest = Some(ext);
            }
        }
        Ok(json!({
            "total": total,
            "slug_unbound": unbound,
            "drifted": drifted,
            "source_changed": changed,
            "source_gone": gone,
            "oldest_ext": oldest,
        }))
    }

    /// `countCredentialProjectionPending(sourceIds?)`: live pages of unarchived sources
    /// (`page_kind` markdown or code) whose text projection is behind their knowledge revision and
    /// whose body holds a private key block, split into the ones a repair can rebuild and the ones
    /// it keeps. A segmented page holds one when a published manifest row records a `pem`
    /// protected region; an inline page, when its text matches the key marker.
    pub fn count_credential_projection_pending(
        &self,
        source_ids: Option<&[String]>,
    ) -> Result<Value> {
        let read = self.read()?;
        let mut sources = LiveSources::new(&*read);
        let (mut rebuild, mut kept) = (0u64, 0u64);
        for page in all_pages(&*read)? {
            if page.deleted_at_us.is_some()
                || !matches!(page.page_kind.as_str(), "markdown" | "code")
                || page.text_projection_revision.as_deref()
                    == Some(page.knowledge_revision.as_str())
                || !in_scope(source_ids, &page.source_id)
                || !sources.unarchived(&page.source_id)?
            {
                continue;
            }
            let marked = |text: Option<&str>| text.is_some_and(has_private_key_marker);
            let holds_key = marked(page.compiled_truth.as_deref())
                || marked(page.timeline.as_deref())
                || (segmented_body(&*read, page.id)?.is_some()
                    && has_published_pem(&*read, page.id)?);
            if !holds_key {
                continue;
            }
            if rebuildable(&page) {
                rebuild += 1;
            } else {
                kept += 1;
            }
        }
        Ok(json!({ "rebuildable": rebuild, "kept": kept }))
    }

    /// `readIgnoredPrivacyLabelCounts({ sourceIds?, timeoutMs })`: among live pages with an
    /// `access` or `confidentiality` key and no `visibility`, whose label the privacy filter does
    /// not recognize (and that no derived-page rule covers), the groups of non-blank
    /// `(key, raw value, is_string)` by page count: at most 50, largest first. At most 100001
    /// pages are scanned. The statement deadline does not apply: the read has no cancellation point.
    pub fn read_ignored_privacy_label_counts(
        &self,
        source_ids: Option<&[String]>,
    ) -> Result<Vec<Value>> {
        let read = self.read()?;
        let blank = |text: Option<&str>| text.is_none_or(|t| edge_trim(t).is_empty());
        let mut scanned = 0usize;
        let mut groups: BTreeMap<(&str, String, bool), u64> = BTreeMap::new();
        for page in all_pages(&*read)? {
            if scanned >= LABEL_SCAN_CAP {
                break;
            }
            let fm = &page.frontmatter;
            let (access, confidentiality) = (fm_text(fm, "access"), fm_text(fm, "confidentiality"));
            if page.deleted_at_us.is_some()
                || !in_scope(source_ids, &page.source_id)
                || !(fm.contains_key("access") || fm.contains_key("confidentiality"))
                || fm_text(fm, "visibility").is_some()
                || alias_private(fm)
                || fm_text(fm, "pinned_question").is_some()
                || matches!(page.page_type.as_str(), "atom" | "question")
                || synthesized_concept(&page)
                || (page.page_type == "event" && life_chronicle(&page))
                || fm_text(fm, "derived_from").is_some()
                || fm_text(fm, "source_slug").is_some()
                || (blank(access.as_deref()) && blank(confidentiality.as_deref()))
            {
                continue;
            }
            scanned += 1;
            for (key, raw) in [("access", access), ("confidentiality", confidentiality)] {
                if let Some(raw) = raw.filter(|r| !edge_trim(r).is_empty()) {
                    let is_string = matches!(fm.get(key), Some(Value::String(_)));
                    *groups.entry((key, raw, is_string)).or_default() += 1;
                }
            }
        }
        let total = groups.len();
        let mut rows: Vec<_> = groups.into_iter().collect();
        // `ORDER BY pages DESC, key, raw`: the map already orders by key, raw (bytes).
        rows.sort_by_key(|a| std::cmp::Reverse(a.1));
        rows.truncate(LABEL_GROUPS);
        Ok(rows
            .into_iter()
            .map(|((key, raw, is_string), pages)| {
                json!({
                    "key": key, "raw": raw, "is_string": is_string,
                    "pages": pages, "scanned": scanned, "groups": total,
                })
            })
            .collect())
    }

    /// `countDerivedVisibility(sourceIds, timeoutMs)`: over the live derived pages of the sources
    /// (atoms, synthesized concepts, Life Chronicle events), how many carry no `visibility` and how
    /// many world-visible ones are looser than their origin allows (the origin page is gone,
    /// private by its own label, or moved to a private page), plus the live non-derived pages
    /// whose `access` or `confidentiality` label has no `visibility` to carry it.
    pub fn count_derived_visibility(&self, source_ids: &[String]) -> Result<Value> {
        let read = self.read()?;
        let scope = Some(source_ids);
        let [mut unstamped_atoms, mut unstamped_concepts] = [0u64; 2];
        let [mut looser_atoms, mut looser_concepts, mut looser_events] = [0u64; 3];
        let mut alias_pages = 0u64;
        for page in all_pages(&*read)? {
            if page.deleted_at_us.is_some() || !in_scope(scope, &page.source_id) {
                continue;
            }
            let visibility = fm_text(&page.frontmatter, "visibility");
            let derived_event = page.page_type == "event" && life_chronicle(&page);
            let concept = synthesized_concept(&page);
            if page.page_type != "atom" && !concept && !derived_event {
                if visibility.is_none() && alias_private(&page.frontmatter) {
                    alias_pages += 1;
                }
                continue;
            }
            let world = visibility.as_deref() == Some("world");
            match page.page_type.as_str() {
                "atom" => {
                    unstamped_atoms += u64::from(visibility.is_none());
                    looser_atoms += u64::from(world && looser_atom(&*read, &page)?);
                }
                "concept" => {
                    unstamped_concepts += u64::from(visibility.is_none());
                    looser_concepts += u64::from(world && looser_concept(&*read, &page)?);
                }
                _ => {
                    looser_events += u64::from(
                        visibility.as_deref() != Some("private") && looser_event(&*read, &page)?,
                    );
                }
            }
        }
        Ok(json!({
            "unstamped_atoms": unstamped_atoms,
            "unstamped_concepts": unstamped_concepts,
            "looser_atoms": looser_atoms,
            "looser_concepts": looser_concepts,
            "looser_events": looser_events,
            "alias_pages_without_visibility": alias_pages,
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::{has_private_key_marker, iso_date_prefix};

    #[test]
    fn private_key_marker_matches_the_regex() {
        assert!(has_private_key_marker(concat!(
            "x -----BEGIN ",
            "RSA PRIVATE KEY----- y"
        )));
        assert!(has_private_key_marker("-----END PRIVATE KEY-----"));
        assert!(has_private_key_marker(concat!(
            "-----BEGIN ",
            "OPENSSH PRIVATE KEY-----"
        )));
        assert!(!has_private_key_marker(concat!(
            "-----BEGIN ",
            "PUBLIC KEY-----"
        )));
        assert!(!has_private_key_marker(concat!(
            "-----BEGIN ",
            "rsa PRIVATE KEY-----"
        )));
        assert!(!has_private_key_marker(concat!(
            "-----BEGIN ",
            "PRIVATE KEY----"
        )));
        assert!(!has_private_key_marker("----BEGIN PRIVATE KEY-----"));
        // The run may not hold anything but capitals and spaces before the tail.
        assert!(!has_private_key_marker(concat!(
            "-----BEGIN ",
            "A-B PRIVATE KEY-----"
        )));
        // A later marker can match when an earlier one does not.
        assert!(has_private_key_marker(concat!(
            "-----BEGIN ",
            "PUBLIC KEY----- -----END PRIVATE KEY-----"
        )));
    }

    #[test]
    fn extracted_at_needs_a_date_prefix() {
        assert!(iso_date_prefix("2026-11-19T10:00:00Z"));
        assert!(iso_date_prefix("2026-11-19"));
        assert!(!iso_date_prefix("2026-1-19"));
        assert!(!iso_date_prefix("20261119"));
    }
}
