//! The held-concept rebuild's reads and link carry (src/core/engine-sql/concept-rebuild.ts; the TypeScript
//! `persistence/concept-rebuild.ts` orchestrates them).
//!
//! A held concept is a synthesized concept tombstone (`deleted_at` set, type `concept`, frontmatter `synthesized_by`
//! LIKE `synthesize_concepts%`) whose `needs_rederive` mark is open at its own delete instant (`marked_at = deleted_at`)
//! and on which no owner purge is owed (no `op_checkpoints` parent under the owed-purge op with the page id). The
//! owed-purge op is passed by the TypeScript member (`OWED_PURGE_OP`), so the two cannot drift.
//!
//! Members: `readHeldConcept`, `isConceptStillHeld`, `lockHeldConcept`, `lockLiveConceptMembers`,
//! `listLiveConceptMemberRevisions`, `listConceptIncomingLinks`, `carryConceptIncomingLinks`, `readTombstoneWindow`,
//! `readConceptStatedKinds`, `readRebuildAccess`, `readHeldConceptRows`. The store runs one write transaction at a time,
//! so the SQL's row locks (`FOR UPDATE`, `FOR SHARE`) are plain reads here. What each answers and where it differs:
//! rust/docs/store/concept_rebuild.md.
//!
//! Keys: this family adds none. It reads page, fact, take, timeline, link, alias, file, raw-data, write-gate,
//! edge-proposal, identity, secret-store, label-guard, derivation-input, re-derive and checkpoint records through their
//! own modules, and writes links through `links.rs`.

use crate::env::{iso, parse_iso};
use crate::error::{CONSTRAINT_VIOLATION, Result, StoreError};
use crate::facts::{PrivacyPolicy, like, page_hidden, privacy_allows, source_rows};
use crate::kv::{KvRead, scan_prefix};
use crate::links::{LinkRecord, check_link, in_links, link_at, out_links, put_link};
use crate::pages::{PageRecord, all_pages, next_id, read_page, read_page_by_id};
use crate::timeline_queries::jsonb_field_text;
use crate::{Store, keys};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::collections::BTreeSet;

/// One microsecond-to-hour factor of the recovery window.
const HOUR_US: f64 = 3_600_000_000.0;

/// A `$1::int` page id: one outside `integer` is refused as the cast refuses it; zero or below names no page.
fn page_u64(page_id: i64, member: &str) -> Result<Option<u64>> {
    if i32::try_from(page_id).is_err() {
        return Err(StoreError::invalid(format!(
            "{member}: value \"{page_id}\" is out of range for type integer"
        )));
    }
    Ok(u64::try_from(page_id).ok().filter(|id| *id > 0))
}

/// `HELD_CONCEPT_SQL` for `page`: a synthesized concept tombstone whose re-derive mark is at its delete and on which no
/// owner purge (`owed_op`) is owed.
fn held(read: &dyn KvRead, page: &PageRecord, owed_op: &str) -> Result<bool> {
    let Some(deleted) = page.deleted_at_us else {
        return Ok(false);
    };
    let synthesized = page
        .frontmatter
        .get("synthesized_by")
        .and_then(jsonb_field_text)
        .unwrap_or_default();
    if page.page_type != "concept" || !like(&synthesized, "synthesize_concepts%", false)? {
        return Ok(false);
    }
    if crate::generations::needs_rederive::marked_at(read, "pages", page.id)? != Some(deleted) {
        return Ok(false);
    }
    Ok(!crate::persistence::op_checkpoint_exists(
        read,
        owed_op,
        &page.id.to_string(),
    )?)
}

/// `DELETED_US_SQL`: the delete instant in microseconds since the epoch, as text.
fn deleted_us(page: &PageRecord) -> Option<String> {
    page.deleted_at_us.map(|us| us.to_string())
}

/// The held page with id `page_id` at the delete `deleted` (text), when it is held at that instant.
fn held_at(
    read: &dyn KvRead,
    page_id: Option<u64>,
    deleted: &str,
    owed_op: &str,
) -> Result<Option<PageRecord>> {
    let Some(id) = page_id else { return Ok(None) };
    let Some(page) = read_page_by_id(read, id)? else {
        return Ok(None);
    };
    if deleted_us(&page).as_deref() != Some(deleted) || !held(read, &page, owed_op)? {
        return Ok(None);
    }
    Ok(Some(page))
}

/// `readHeldConcept`'s answer.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct HeldConcept {
    pub deleted_us: String,
}

/// One member at the revision its body was read at.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MemberRevision {
    pub slug: String,
    pub revision: String,
}

/// One live member and its knowledge revision as text.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct MemberRevisionRow {
    pub slug: String,
    pub revision: String,
}

/// `carryConceptIncomingLinks`' answer: the fresh row's id and how many links were inserted.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CarriedLinks {
    pub id: u64,
    pub carried: u64,
}

/// `readTombstoneWindow`'s answer.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TombstoneWindow {
    pub until: String,
    pub past: bool,
}

/// The lists `STATED_SQL` binds as `$4`, `$5` and `$6`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StatedKindLists {
    pub derived_link_sources: Vec<String>,
    pub stated_label_keys: Vec<String>,
    pub synthesis_keys: Vec<String>,
}

/// `readConceptStatedKinds`' answer, in `STATED_SQL`'s column names.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ConceptStatedRow {
    pub kinds: Vec<String>,
    pub lead: Option<String>,
    pub segmented: Option<bool>,
}

/// `readRebuildAccess`' answer, in `ACCESS_SQL`'s column names.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RebuildAccess {
    pub open: bool,
    pub public_part: bool,
    pub readers: Option<Vec<String>>,
    pub page_readers: Option<Vec<String>>,
    pub folder_rule_ids: Option<Vec<String>>,
}

/// One row of `readHeldConceptRows`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct HeldConceptRow {
    pub id: u64,
    pub source_id: String,
    pub slug: String,
    pub private: bool,
    pub members_private: bool,
}

/// `replace(regexp_replace(slug, '^.*/', ''), '-', ' ')`: the slug's last segment with dashes as spaces.
fn slug_title(slug: &str) -> String {
    slug.rsplit('/').next().unwrap_or(slug).replace('-', " ")
}

/// `extractedFromPageSql('f', slug)` in three-valued logic: `None` where the SQL predicate is NULL (a fact with no
/// context that the other tests do not rule out), which the `NOT (...)` of `STATED_SQL` keeps NULL, so the row is out.
fn extracted_from_page(f: &crate::facts::FactRecord, slug: &str) -> Option<bool> {
    if f.source_markdown_slug.is_some()
        || !crate::facts::repair::PAGE_EXTRACTION_SOURCES.contains(&f.source.as_str())
    {
        return Some(false);
    }
    f.context
        .as_deref()
        .map(|c| crate::facts::repair::context_head(c) == slug)
}

/// `holdReachCte`: the slugs a hold's slug leads to through the source's slug aliases (alias to canonical) and rename
/// record (old to new), the hold's own slug included; a cycle ends.
fn hold_reach(read: &dyn KvRead, source_id: &str, start: &str) -> Result<BTreeSet<String>> {
    let mut seen: BTreeSet<String> = BTreeSet::new();
    let mut queue = vec![start.to_string()];
    while let Some(slug) = queue.pop() {
        if !seen.insert(slug.clone()) {
            continue;
        }
        if let Some(alias) = crate::aliases::read_slug_alias(read, source_id, &slug)? {
            queue.push(alias.canonical_slug);
        }
        queue.extend(crate::aliases::renamed_to(read, source_id, &slug)?);
    }
    Ok(seen)
}

/// The kinds of `STATED_SQL`, in its array order.
fn stated_kinds(
    read: &dyn KvRead,
    page_id: Option<u64>,
    page: Option<&PageRecord>,
    source_id: &str,
    slug: &str,
    lists: &StatedKindLists,
) -> Result<Vec<String>> {
    let mut kinds: Vec<String> = Vec::new();
    let mut add = |kind: &str, hit: bool| {
        if hit {
            kinds.push(kind.to_string());
        }
    };
    let facts = source_rows(read, source_id)?.iter().any(|f| {
        (f.entity_slug.as_deref() == Some(slug) || f.source_markdown_slug.as_deref() == Some(slug))
            && extracted_from_page(f, slug) == Some(false)
    });
    add("facts", facts);
    let (
        takes,
        timeline_rows,
        links,
        files,
        transitions,
        raw,
        proposals,
        identity,
        labels_guard,
        secret,
    ) = match page_id {
        Some(id) => {
            let mut timeline = false;
            scan_prefix(read, &keys::timeline_prefix(id), false, &mut |_, _| {
                timeline = true;
                false
            })?;
            let stated_link = |l: &LinkRecord| {
                l.link_source
                    .as_deref()
                    .is_some_and(|s| !lists.derived_link_sources.iter().any(|d| d == s))
            };
            let links = out_links(read, id)?.iter().any(stated_link)
                || in_links(read, id)?.iter().any(stated_link);
            let files = crate::raw_files::all_file_records(read)?
                .iter()
                .any(|f| f.page_id == Some(id));
            let transitions = crate::link_queries::link_temporal::all_transitions(read)?
                .iter()
                .any(|t| {
                    t.from_page_id == id || t.to_page_id == id || t.origin_page_id == Some(id)
                });
            (
                !crate::takes::page_takes(read, id)?.is_empty(),
                timeline,
                links,
                files,
                transitions,
                !crate::raw_files::raw_rows_of(read, id)?.is_empty(),
                crate::edge_proposals::person_decided_proposal_names(read, id)?,
                crate::entity_identities::record(read, id)?.is_some(),
                crate::trust::label_guards::read(read, id)?.is_some(),
                crate::secret_store::page_holds_last_original(read, id, source_id, slug)?,
            )
        }
        None => (
            false, false, false, false, false, false, false, false, false, false,
        ),
    };
    add("takes", takes);
    add("timeline_entries", timeline_rows);
    add("links", links);
    add("tags", page.is_some_and(|p| !p.tags.is_empty()));
    add("files", files);
    add(
        "page_aliases",
        crate::aliases::count_alias_rows(read, source_id, slug, false)? > 0,
    );
    add(
        "slug_aliases",
        crate::aliases::count_alias_rows(read, source_id, slug, true)? > 0,
    );
    // The store keeps no core_edit_notices (facts/page_purge_sweep.rs), so none is stated here.
    add("core_edit_notices", false);
    let mut hold = false;
    for start in crate::trust::write_gate::source_hold_slugs(read, source_id)? {
        // A hold keeps no page id or candidate list here, so it reaches the page by its slug or a rename of it.
        if start == slug || hold_reach(read, source_id, &start)?.contains(slug) {
            hold = true;
            break;
        }
    }
    add("write_gate_holds", hold);
    add(
        "title",
        page.is_some_and(|p| p.title != slug_title(&p.slug)),
    );
    add(
        "frontmatter",
        page.is_some_and(|p| {
            p.frontmatter.iter().any(|(key, value)| {
                !lists.synthesis_keys.contains(key)
                    && !lists.stated_label_keys.contains(key)
                    && !(key == "tags" && value == &Value::Array(Vec::new()))
            })
        }),
    );
    add(
        "timeline",
        page.is_some_and(|p| {
            !crate::chunks::segmented(p) && !p.timeline.as_deref().unwrap_or("").is_empty()
        }),
    );
    // The store never withholds a source path (git_gap_census.rs answers it null).
    add(
        "source_path",
        page.is_some_and(|p| {
            p.source_path
                .as_deref()
                .is_some_and(|s| s != format!("{}.md", p.slug))
                || p.source_uri.is_some()
        }),
    );
    add("link_transitions", transitions);
    add("raw_data", raw);
    add("link_edge_proposals", proposals);
    add("entity_identities", identity);
    add(
        "guest_marks",
        match page_id {
            Some(id) => crate::guest_marks::read_mark(read, id)?.is_some(),
            None => false,
        },
    );
    add(
        "guest_promotions",
        match page_id {
            Some(id) => crate::guest_promotions::page_promoted(read, id)?,
            None => false,
        },
    );
    add("secret_store_occurrence", secret);
    add(
        "labels",
        labels_guard
            || page.is_some_and(|p| {
                lists
                    .stated_label_keys
                    .iter()
                    .any(|k| p.frontmatter.contains_key(k))
            }),
    );
    Ok(kinds)
}

/// The `to_jsonb(l)` row of a link, in the `links` column names (`created_at` as ISO text, `assertion_tense` as
/// `present` when the record holds none, its column default).
fn link_row(l: &LinkRecord) -> Value {
    json!({
        "id": l.id,
        "from_page_id": l.from_page_id,
        "to_page_id": l.to_page_id,
        "link_type": l.link_type,
        "context": l.context,
        "link_source": l.link_source,
        "link_kind": l.link_kind,
        "origin_page_id": l.origin_page_id,
        "origin_field": l.origin_field,
        "resolution_type": l.resolution_type,
        "created_at": iso(l.created_at_us),
        "assertion_tense": l.assertion_tense.clone().unwrap_or_else(|| "present".to_string()),
    })
}

/// An incoming row's column as text (`jsonb_populate_recordset`: a missing or null key is NULL).
fn row_text(row: &Map<String, Value>, key: &str) -> Option<String> {
    row.get(key).and_then(Value::as_str).map(str::to_string)
}

/// An incoming row's id column (`integer`): a missing or null key is NULL.
fn row_id(row: &Map<String, Value>, key: &str) -> Result<Option<u64>> {
    match row.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(v) => v.as_u64().map(Some).ok_or_else(|| {
            StoreError::invalid(format!(
                "carryConceptIncomingLinks: {key} is not an integer"
            ))
        }),
    }
}

impl Store {
    /// `readHeldConcept(pageId)`: the delete instant of the tombstone while it is held, else `None`.
    pub fn read_held_concept(&self, page_id: i64, owed_op: &str) -> Result<Option<HeldConcept>> {
        let id = page_u64(page_id, "readHeldConcept")?;
        let read = self.read()?;
        let Some(page) = id
            .map(|id| read_page_by_id(&*read, id))
            .transpose()?
            .flatten()
        else {
            return Ok(None);
        };
        Ok(if held(&*read, &page, owed_op)? {
            deleted_us(&page).map(|deleted_us| HeldConcept { deleted_us })
        } else {
            None
        })
    }

    /// `isConceptStillHeld(pageId, deletedUs)`: whether the tombstone is still held at that delete instant.
    pub fn is_concept_still_held(
        &self,
        page_id: i64,
        deleted: &str,
        owed_op: &str,
    ) -> Result<bool> {
        let id = page_u64(page_id, "isConceptStillHeld")?;
        let read = self.read()?;
        Ok(held_at(&*read, id, deleted, owed_op)?.is_some())
    }

    /// `lockHeldConcept(pageId, sourceId, slug, deletedUs)`: whether the tombstone at that source and slug is still
    /// held at that delete instant. The store has one writer at a time, so `FOR UPDATE` takes no lock here.
    pub fn lock_held_concept(
        &self,
        page_id: i64,
        source_id: &str,
        slug: &str,
        deleted: &str,
        owed_op: &str,
    ) -> Result<bool> {
        let id = page_u64(page_id, "lockHeldConcept")?;
        let read = self.read()?;
        Ok(held_at(&*read, id, deleted, owed_op)?
            .is_some_and(|p| p.source_id == source_id && p.slug == slug))
    }

    /// `lockLiveConceptMembers(sourceId, members)`: how many of `members` (each counted, repeats too) are live in the
    /// source at the revision given (`knowledge_revision::text`).
    pub fn lock_live_concept_members(
        &self,
        source_id: &str,
        members: &[MemberRevision],
    ) -> Result<u64> {
        let read = self.read()?;
        let mut count = 0u64;
        for m in members {
            if let Some(page) = read_page(&*read, source_id, &m.slug)?
                && page.deleted_at_us.is_none()
                && page.knowledge_revision.to_lowercase() == m.revision
            {
                count += 1;
            }
        }
        Ok(count)
    }

    /// `listLiveConceptMemberRevisions(sourceId, slugs)`: the live pages among the distinct slugs, with their revision
    /// as text, in byte order of the slug (PGLite sets no order).
    pub fn list_live_concept_member_revisions(
        &self,
        source_id: &str,
        slugs: &[String],
    ) -> Result<Vec<MemberRevisionRow>> {
        let read = self.read()?;
        let wanted: BTreeSet<&str> = slugs.iter().map(String::as_str).collect();
        let mut rows = Vec::new();
        for slug in wanted {
            if let Some(page) = read_page(&*read, source_id, slug)?
                && page.deleted_at_us.is_none()
            {
                rows.push(MemberRevisionRow {
                    slug: page.slug,
                    revision: page.knowledge_revision.to_lowercase(),
                });
            }
        }
        Ok(rows)
    }

    /// `listConceptIncomingLinks(pageId)`: the links into the page from other live pages, except concept provenance,
    /// as `to_jsonb` rows, in link id order (PGLite sets no order).
    pub fn list_concept_incoming_links(&self, page_id: i64) -> Result<Vec<Value>> {
        let Some(id) = page_u64(page_id, "listConceptIncomingLinks")? else {
            return Ok(Vec::new());
        };
        let read = self.read()?;
        let mut links: Vec<LinkRecord> = Vec::new();
        for l in in_links(&*read, id)? {
            if l.from_page_id == id || l.link_source.as_deref() == Some("concept-provenance") {
                continue;
            }
            if read_page_by_id(&*read, l.from_page_id)?.is_some_and(|f| f.deleted_at_us.is_none()) {
                links.push(l);
            }
        }
        links.sort_by_key(|l| l.id);
        Ok(links.iter().map(link_row).collect())
    }

    /// `carryConceptIncomingLinks(sourceId, slug, incoming, oldId)`: inserts each incoming row onto the live page at the
    /// slug (its `to_page_id`, and an `origin_page_id` naming `old_id`, become the fresh page's id); a row equal to a
    /// stored link under the table's unique key is skipped (`ON CONFLICT DO NOTHING`). `None` when no page is live
    /// there, with nothing inserted. A row whose from page or origin page is gone is refused, as the foreign keys are.
    pub fn carry_concept_incoming_links(
        &self,
        source_id: &str,
        slug: &str,
        incoming: &[Value],
        old_id: i64,
    ) -> Result<Option<CarriedLinks>> {
        let old = u64::try_from(old_id).ok();
        self.write(|tx| {
            let Some(fresh) = read_page(&*tx, source_id, slug)?.filter(|p| p.deleted_at_us.is_none()) else {
                return Ok(None);
            };
            let mut carried = 0u64;
            for value in incoming {
                let Some(row) = value.as_object() else {
                    return Err(StoreError::invalid("carryConceptIncomingLinks: an incoming row is not an object"));
                };
                let Some(from) = row_id(row, "from_page_id")? else {
                    return Err(StoreError::new(
                        CONSTRAINT_VIOLATION,
                        "null value in column \"from_page_id\" of relation \"links\" violates not-null constraint",
                    ));
                };
                let origin = row_id(row, "origin_page_id")?.map(|o| if Some(o) == old { fresh.id } else { o });
                for (column, page) in [("from_page_id", Some(from)), ("origin_page_id", origin)] {
                    if let Some(page) = page
                        && read_page_by_id(&*tx, page)?.is_none()
                    {
                        return Err(StoreError::new(
                            CONSTRAINT_VIOLATION,
                            format!("insert or update on table \"links\" violates foreign key constraint (\"{column}\")"),
                        ));
                    }
                }
                let created_at_us = match row_text(row, "created_at") {
                    Some(text) => parse_iso(&text).ok_or_else(|| {
                        StoreError::invalid(format!("carryConceptIncomingLinks: created_at {text:?} is not a timestamp"))
                    })?,
                    None => self.env.now_micros(),
                };
                let mut record = LinkRecord {
                    id: 0,
                    from_page_id: from,
                    to_page_id: fresh.id,
                    link_type: row_text(row, "link_type").unwrap_or_default(),
                    context: row_text(row, "context").unwrap_or_default(),
                    link_source: row_text(row, "link_source"),
                    link_kind: row_text(row, "link_kind"),
                    origin_page_id: origin,
                    origin_field: row_text(row, "origin_field"),
                    resolution_type: row_text(row, "resolution_type"),
                    created_at_us,
                    assertion_tense: row_text(row, "assertion_tense").filter(|t| t != "present"),
                };
                check_link(&record)?;
                if link_at(&*tx, from, &record.unique_key())?.is_some() {
                    continue;
                }
                record.id = next_id(tx, crate::links::NEXT_LINK_ID)?;
                put_link(tx, &record)?;
                carried += 1;
            }
            Ok(Some(CarriedLinks { id: fresh.id, carried }))
        })
    }

    /// `readTombstoneWindow(pageId, hours)`: when the tombstone's recovery window ends (its delete plus `hours`, UTC, to
    /// the second) and whether that has passed; `None` for a live or missing page. A `hours` that is not finite is
    /// refused, as the interval cast refuses it.
    pub fn read_tombstone_window(
        &self,
        page_id: i64,
        hours: f64,
    ) -> Result<Option<TombstoneWindow>> {
        if !hours.is_finite() {
            return Err(StoreError::invalid(format!(
                "readTombstoneWindow: invalid input syntax for type interval: \"{hours} hours\""
            )));
        }
        let Some(id) = page_u64(page_id, "readTombstoneWindow")? else {
            return Ok(None);
        };
        let read = self.read()?;
        let Some(deleted) = read_page_by_id(&*read, id)?.and_then(|p| p.deleted_at_us) else {
            return Ok(None);
        };
        let until = deleted + (hours * HOUR_US).round() as i64;
        let text = iso(until);
        Ok(Some(TombstoneWindow {
            until: format!("{}Z", &text[..19]),
            past: until <= self.env.now_micros(),
        }))
    }

    /// `readConceptStatedKinds(pageId, sourceId, slug, lists)`: `STATED_SQL`, what on or about the concept row
    /// synthesis did not write, with the bounded body lead and whether the body is segmented (both `None` for no row).
    pub fn read_concept_stated_kinds(
        &self,
        page_id: i64,
        source_id: &str,
        slug: &str,
        lists: &StatedKindLists,
    ) -> Result<ConceptStatedRow> {
        let id = page_u64(page_id, "readConceptStatedKinds")?;
        let read = self.read()?;
        let page = id
            .map(|id| read_page_by_id(&*read, id))
            .transpose()?
            .flatten();
        let kinds = stated_kinds(&*read, id, page.as_ref(), source_id, slug, lists)?;
        let lead = match &page {
            Some(p) => crate::cli_reads::entities::bounded_body_prefix(&*read, p)?,
            None => None,
        };
        Ok(ConceptStatedRow {
            kinds,
            lead,
            segmented: page.as_ref().map(crate::chunks::segmented),
        })
    }

    /// `readRebuildAccess(pageId)`: `ACCESS_SQL` for the page row with the id (live or deleted). `open_policy` is the
    /// no-caller page policy read off `privatePagesFilterFragment('p')`; the privacy part honours the aliases as that
    /// policy does. `None` when no row has the id.
    pub fn read_rebuild_access(
        &self,
        page_id: i64,
        open_policy: &PrivacyPolicy,
    ) -> Result<Option<RebuildAccess>> {
        let Some(id) = page_u64(page_id, "readRebuildAccess")? else {
            return Ok(None);
        };
        let read = self.read()?;
        let Some(page) = read_page_by_id(&*read, id)? else {
            return Ok(None);
        };
        let readers = crate::facts::access_readers(&page.frontmatter);
        Ok(Some(RebuildAccess {
            open: !page_hidden(&*read, &page, open_policy)?,
            public_part: privacy_allows(&*read, &page, open_policy.honor_aliases)?,
            page_readers: readers.clone(),
            readers,
            folder_rule_ids: crate::access_policy::kept_rule_ids(&*read, &page.source_id, page.id)?,
        }))
    }

    /// `readHeldConceptRows()`: every held concept, by source then slug in byte order (Postgres orders by its database
    /// collation), with whether its privacy part hides it and whether a live input page of its derivation fails the
    /// no-caller page policy `member_policy`. `private_aliases`: whether the privacy part honours the aliases.
    pub fn read_held_concept_rows(
        &self,
        owed_op: &str,
        private_aliases: bool,
        member_policy: &PrivacyPolicy,
    ) -> Result<Vec<HeldConceptRow>> {
        let read = self.read()?;
        let mut rows = Vec::new();
        for page in all_pages(&*read)? {
            if !held(&*read, &page, owed_op)? {
                continue;
            }
            let mut members_private = false;
            for (table, input) in crate::generations::derivation_inputs::inputs_of(
                &*read,
                "pages",
                &page.id.to_string(),
            )? {
                if table != "pages" {
                    continue;
                }
                let Ok(input_id) = input.parse::<u64>() else {
                    continue;
                };
                if let Some(m) = read_page_by_id(&*read, input_id)?
                    && m.deleted_at_us.is_none()
                    && page_hidden(&*read, &m, member_policy)?
                {
                    members_private = true;
                    break;
                }
            }
            rows.push(HeldConceptRow {
                id: page.id,
                private: !privacy_allows(&*read, &page, private_aliases)?,
                source_id: page.source_id,
                slug: page.slug,
                members_private,
            });
        }
        rows.sort_by(|a, b| (&a.source_id, &a.slug).cmp(&(&b.source_id, &b.slug)));
        Ok(rows)
    }
}
