//! The core relations: sources, config, pages and the page families, chunks, links, timeline
//! entries, aliases, facts and takes.

use super::decode::Row;
use super::{
    Column::{Derived, Kept, Unmapped},
    Losses, Outcome, Relation, duplicate, raise_counter, require_page, require_source, seed_trust,
};
use crate::chunks::{ChunkRecord, EmbedState};
use crate::error::{CONSTRAINT_VIOLATION, Result, StoreError};
use crate::extraction::ExtractionRecord;
use crate::facts::{FactRecord, md5_hex, read_fact};
use crate::kv::KvWrite;
use crate::links::{LinkRecord, check_link};
use crate::pages::{PageRecord, PageText, read_page_by_id, write_page};
use crate::sources::{SourceRecord, read_source, source_key};
use crate::takes::TakeRecord;
use crate::timeline::TimelineRecord;
use crate::{get_json, keys, put_json};
use serde_json::{Map, Value, json};
use std::collections::BTreeMap;

/// In import order.
pub(super) const RELATIONS: &[(&str, &Relation)] = &[
    ("sources", &SOURCES),
    ("config", &CONFIG),
    ("pages", &PAGES),
    ("tags", &TAGS),
    ("content_chunks", &CHUNKS),
    ("links", &LINKS),
    ("timeline_entries", &TIMELINE),
    ("slug_aliases", &SLUG_ALIASES),
    ("page_aliases", &PAGE_ALIASES),
    ("facts", &FACTS),
    ("takes", &TAKES),
];

// ---- sources -------------------------------------------------------------------------------

static SOURCES: Relation = Relation {
    key: &["id"],
    columns: &[
        ("id", Kept),
        ("name", Kept),
        ("local_path", Kept),
        ("last_sync_at", Kept),
        ("config", Kept),
        ("archived", Kept),
        ("incarnation", Kept),
        ("created_at", Kept),
        ("chunker_version", Kept),
        ("trust_frontmatter_overrides", Unmapped(Some("false"))),
        ("purge_epoch", Unmapped(Some("0"))),
    ],
    import: import_source,
};

fn import_source(tx: &mut dyn KvWrite, row: &Row, _: &mut Losses) -> Result<Outcome> {
    let record = SourceRecord {
        id: row.req("id")?,
        name: row.text("name"),
        local_path: row.text("local_path"),
        last_sync_at_us: row.ts("last_sync_at")?,
        config: row.object("config")?,
        incarnation: row.req("incarnation")?,
        archived: row.bool("archived")?.unwrap_or(false),
        created_at_us: row.req_ts("created_at")?,
        chunker_version: row.text("chunker_version"),
        archived_at_us: None,
        archive_expires_at_us: None,
        upstream_checked_at_us: None,
        upstream_commit: None,
        upstream_behind: None,
        last_commit: None,
        newest_content_at_us: None,
        purge_epoch: 0,
    };
    let stored = read_source(&*tx, &record.id)?;
    if stored.is_some_and(|s| serde_json::to_value(&s).ok() == serde_json::to_value(&record).ok()) {
        return Ok(Outcome::Skipped);
    }
    put_json(tx, &source_key(&record.id), &record)?;
    Ok(Outcome::Imported)
}

// ---- config --------------------------------------------------------------------------------

static CONFIG: Relation = Relation {
    key: &["key"],
    columns: &[("key", Kept), ("value", Kept)],
    import: import_config,
};

/// `version` is the store's own schema version, which the store's migrations own: a different
/// value is kept and counted as `config_version_differs`.
fn import_config(tx: &mut dyn KvWrite, row: &Row, _: &mut Losses) -> Result<Outcome> {
    let key = row.req("key")?;
    let value = row.req("value")?;
    let stored_key = keys::text(keys::CONFIG, &[&key]);
    let stored = tx.get(&stored_key)?;
    if stored.as_deref() == Some(value.as_bytes()) {
        return Ok(Outcome::Skipped);
    }
    if key == "version" && stored.is_some() {
        return Ok(Outcome::Dropped("config_version_differs"));
    }
    tx.put(&stored_key, value.as_bytes())?;
    Ok(Outcome::Imported)
}

// ---- pages ---------------------------------------------------------------------------------

static PAGES: Relation = Relation {
    key: &["id"],
    columns: &[
        ("id", Kept),
        ("source_id", Kept),
        ("slug", Kept),
        ("type", Kept),
        ("page_kind", Kept),
        ("title", Kept),
        ("compiled_truth", Kept),
        ("timeline", Kept),
        ("frontmatter", Kept),
        ("content_hash", Kept),
        ("emotional_weight", Kept),
        ("salience_touched_at", Kept),
        ("created_at", Kept),
        ("updated_at", Kept),
        ("deleted_at", Kept),
        ("effective_date", Kept),
        ("effective_date_source", Kept),
        ("import_filename", Kept),
        ("links_extracted_at", Kept),
        ("links_attendance_blocked_revision", Kept),
        ("links_attendance_blocked_at", Kept),
        ("contextual_retrieval_mode", Kept),
        ("corpus_generation", Kept),
        ("search_vector", Derived),
        ("knowledge_revision", Kept),
        ("text_projection_revision", Kept),
        ("chunker_version", Kept),
        ("source_path", Kept),
        ("ingested_via", Kept),
        ("ingested_at", Kept),
        ("source_uri", Kept),
        ("source_kind", Kept),
        ("embedding_signature", Kept),
        ("trust_tier", Kept),
        ("write_origin", Kept),
        ("revision_write_request_id", Kept),
        ("revision_principal_kind", Kept),
        ("revision_principal_id", Kept),
        ("body_storage", Kept),
        ("body_bytes", Kept),
        ("truth_bytes", Kept),
        ("body_lines", Kept),
        ("body_generation", Kept),
        ("segment_count", Kept),
        ("segmenter_version", Kept),
        ("body_flags", Kept),
        ("truth_lead", Kept),
        ("timeline_lead", Kept),
        ("version_history_gap_at", Kept),
        ("database_only_reason", Kept),
        // `page_projection_jobs` joined on the page's source incarnation and slug.
        ("projection_job_revision", Kept),
        ("projection_job_reason", Kept),
        ("projection_job_updated_at", Kept),
        ("generation", Unmapped(Some("1"))),
    ],
    import: import_page,
};

fn import_page(tx: &mut dyn KvWrite, row: &Row, losses: &mut Losses) -> Result<Outcome> {
    let id = row.req_id("id")?;
    if read_page_by_id(&*tx, id)?.is_some() {
        return Ok(Outcome::Skipped);
    }
    let source_id = row.req("source_id")?;
    require_source(&*tx, &source_id)?;
    let slug = row.req("slug")?;
    if tx.get(&keys::page(&source_id, &slug))?.is_some() {
        return Err(duplicate("pages (source_id, slug)"));
    }
    let text = |col: &str| row.text(col).map_or_else(PageText::null, PageText::from);
    let chunker_version = row
        .i64("chunker_version")?
        .map(i16::try_from)
        .transpose()
        .map_err(|_| StoreError::invalid("seed pages.chunker_version: out of range"))?;
    let tier = row.text_or("trust_tier", "unknown");
    let record = PageRecord {
        id,
        source_id,
        slug,
        page_type: row.req("type")?,
        page_kind: row.text_or("page_kind", "markdown"),
        title: row.req("title")?,
        compiled_truth: text("compiled_truth"),
        timeline: text("timeline"),
        frontmatter: row.object("frontmatter")?,
        content_hash: row.text("content_hash"),
        chunker_version: Some(chunker_version.unwrap_or(1)),
        source_path: row.text("source_path"),
        knowledge_revision: row.req("knowledge_revision")?,
        text_projection_revision: row.text("text_projection_revision"),
        created_at_us: row.req_ts("created_at")?,
        updated_at_us: row.req_ts("updated_at")?,
        deleted_at_us: row.ts("deleted_at")?,
        effective_date_us: row.ts("effective_date")?,
        effective_date_source: row.text("effective_date_source"),
        import_filename: row.text("import_filename"),
        source_kind: row.text("source_kind"),
        source_uri: row.text("source_uri"),
        ingested_via: row.text("ingested_via"),
        ingested_at_us: row.ts("ingested_at")?,
        tags: Vec::new(),
        tag_sources: BTreeMap::new(),
        trust_tier: (tier != "unknown").then_some(tier),
        write_origin: row.json("write_origin")?,
        revision_receipt: row.actor(
            "revision_write_request_id",
            "revision_principal_kind",
            "revision_principal_id",
        ),
        version_history_gap_at_us: row.ts("version_history_gap_at")?,
        database_only_reason: row.text("database_only_reason"),
    };
    // Before the page: its vector check reads the timeline lead.
    seed_body(tx, row, id, losses)?;
    write_page(tx, &record)?;
    raise_counter(tx, crate::pages::NEXT_PAGE_ID, id)?;
    let job = crate::persistence::SeedJob {
        revision: row.text("projection_job_revision"),
        reason: row.text("projection_job_reason"),
        updated_at_us: row.ts("projection_job_updated_at")?,
    };
    if !crate::persistence::seed_job(tx, &record, job)? {
        losses.add("projection_job_seed_time");
    }

    let weight = row.f32("emotional_weight")?.unwrap_or(0.0);
    match row.ts("salience_touched_at")? {
        Some(touched) => crate::salience::seed_record(tx, id, weight, touched)?,
        None if weight != 0.0 => losses.add("emotional_weight_without_touch"),
        None => {}
    }
    match (
        row.text("contextual_retrieval_mode"),
        row.text("corpus_generation"),
    ) {
        (Some(mode), generation) => crate::aliases::seed_cr_state(tx, id, mode, generation)?,
        (None, Some(_)) => losses.add("corpus_generation_without_mode"),
        (None, None) => {}
    }
    if let Some(signature) = row.value("embedding_signature") {
        crate::embeddings::seed_page_signature(tx, id, signature)?;
    }
    let extraction = ExtractionRecord {
        links_extracted_at_us: row.ts("links_extracted_at")?,
        links_attendance_blocked_revision: row.text("links_attendance_blocked_revision"),
        links_attendance_blocked_at_us: row.ts("links_attendance_blocked_at")?,
    };
    crate::extraction::seed_record(tx, id, &extraction)?;
    Ok(Outcome::Imported)
}

/// The page's body columns, stored when they are not an inline page's (`inline`, generation 0).
/// A segmented page keeps its columns, but not its segments: `segmented_body`.
fn seed_body(tx: &mut dyn KvWrite, row: &Row, id: u64, losses: &mut Losses) -> Result<()> {
    let storage = row.text_or("body_storage", "inline");
    let generation = row.i64("body_generation")?.unwrap_or(0);
    if storage == "inline" && generation == 0 {
        return Ok(());
    }
    if storage == "segmented" {
        losses.add("segmented_body");
    }
    let columns = json!({
        "body_storage": storage,
        "body_generation": generation,
        "body_bytes": row.i64("body_bytes")?,
        "truth_bytes": row.i64("truth_bytes")?,
        "body_lines": row.i64("body_lines")?,
        "segment_count": row.i64("segment_count")?,
        "segmenter_version": row.i64("segmenter_version")?,
        "truth_lead": row.text("truth_lead"),
        "timeline_lead": row.text("timeline_lead"),
        "body_flags": row.json("body_flags")?,
        "chunker_version": row.i64("chunker_version")?,
    });
    crate::page_body::seed_body_state(tx, id, columns)
}

// ---- tags ----------------------------------------------------------------------------------

static TAGS: Relation = Relation {
    key: &["id"],
    columns: &[("page_id", Kept), ("tag", Kept), ("tag_source", Kept)],
    import: import_tag,
};

fn import_tag(tx: &mut dyn KvWrite, row: &Row, _: &mut Losses) -> Result<Outcome> {
    let mut page = require_page(&*tx, row.req_id("page_id")?)?;
    let tag = row.req("tag")?;
    if page.tags.contains(&tag) {
        return Ok(Outcome::Skipped);
    }
    if let Some(source) = row.text("tag_source") {
        page.tag_sources.insert(tag.clone(), source);
    }
    page.tags.push(tag);
    write_page(tx, &page)?;
    Ok(Outcome::Imported)
}

// ---- content_chunks ------------------------------------------------------------------------

static CHUNKS: Relation = Relation {
    key: &["id"],
    columns: &[
        ("id", Kept),
        ("page_id", Kept),
        ("chunk_index", Kept),
        ("chunk_text", Kept),
        ("chunk_source", Kept),
        ("embedding", Kept),
        ("model", Kept),
        ("token_count", Kept),
        ("embedded_at", Kept),
        ("embedded_text_hash", Kept),
        ("embedding_input_hash", Kept),
        ("language", Kept),
        ("symbol_name", Kept),
        ("symbol_type", Kept),
        ("start_line", Kept),
        ("end_line", Kept),
        ("modality", Kept),
        ("embedding_image", Kept),
        ("embedding_multimodal", Kept),
        ("parent_symbol_path", Kept),
        ("doc_comment", Kept),
        ("symbol_name_qualified", Kept),
        ("search_vector", Derived),
        ("embedding_pending_since", Kept),
        ("projected_byte_start", Kept),
        ("projected_byte_end", Kept),
        ("occurrence_id", Kept),
        ("local_ordinal", Kept),
        ("raw_byte_start", Kept),
        ("raw_byte_end", Kept),
        ("body_generation", Kept),
        ("retired_generation", Kept),
    ],
    import: import_chunk,
};

const CHUNK_TEXT_META: [&str; 5] = [
    "language",
    "symbol_name",
    "symbol_type",
    "doc_comment",
    "symbol_name_qualified",
];
const CHUNK_NUMBER_META: [&str; 5] = [
    "start_line",
    "end_line",
    "projected_byte_start",
    "projected_byte_end",
    "token_count",
];

fn import_chunk(tx: &mut dyn KvWrite, row: &Row, losses: &mut Losses) -> Result<Outcome> {
    let id = row.req_id("id")?;
    let page_id = row.req_id("page_id")?;
    require_page(&*tx, page_id)?;
    // A dropped chunk still existed on the primary, and a code edge may name it: the id counter is how an edge's chunk is
    // checked (`history::require_chunk`), so it moves past a dropped chunk too.
    if row.value("retired_generation").is_some() {
        raise_counter(tx, crate::chunks::NEXT_CHUNK_ID, id)?;
        return Ok(Outcome::Dropped("retired_chunk"));
    }
    if row.value("body_generation").is_some() || row.value("occurrence_id").is_some() {
        raise_counter(tx, crate::chunks::NEXT_CHUNK_ID, id)?;
        return Ok(Outcome::Dropped("segment_chunk"));
    }
    let chunk_index = row
        .i64("chunk_index")?
        .and_then(|v| u32::try_from(v).ok())
        .ok_or_else(|| StoreError::invalid("seed content_chunks.chunk_index: not a chunk index"))?;
    if let Some(stored) = get_json::<ChunkRecord>(&*tx, &keys::chunk(page_id, chunk_index))? {
        if stored.id == id {
            return Ok(Outcome::Skipped);
        }
        return Err(duplicate("content_chunks (page_id, chunk_index)"));
    }
    let chunk_text = row.req("chunk_text")?;
    let model = row.text_or("model", "voyage:voyage-4");
    let mut meta = Map::new();
    for col in CHUNK_TEXT_META {
        if let Some(value) = row.text(col) {
            meta.insert(col.into(), Value::String(value));
        }
    }
    for col in CHUNK_NUMBER_META {
        if let Some(value) = row.i64(col)? {
            meta.insert(col.into(), json!(value));
        }
    }
    if let Some(path) = row.text_array("parent_symbol_path")? {
        meta.insert("parent_symbol_path".into(), json!(path));
    }
    meta.insert("model".into(), Value::String(model.clone()));
    for col in ["embedding_image", "embedding_multimodal"] {
        if row.value(col).is_some() {
            losses.add(col);
        }
    }
    let vector = row.vector("embedding")?;
    let embedded_at_us = row.ts("embedded_at")?;
    // The store hashes chunk text with sha256; Postgres wrote md5. A hash of the current text
    // carries over as the store's own hash, any other (a stale vector) stays as it is.
    let text_hash = row.text("embedded_text_hash").map(|hash| {
        if hash == md5_hex(&chunk_text) {
            crate::embeddings::text_hash(&chunk_text)
        } else {
            hash
        }
    });
    let record = ChunkRecord {
        id,
        page_id,
        chunk_index,
        chunk_text,
        chunk_source: row.text_or("chunk_source", "compiled_truth"),
        modality: row.text_or("modality", "text"),
        length: 0,
        meta,
        segment: None,
        embed: EmbedState {
            dims: vector.as_ref().map_or(0, |v| v.len() as u32),
            embedded_at_us,
            text_hash,
            input_hash: row.text("embedding_input_hash"),
            pending_since_us: row.ts("embedding_pending_since")?,
        },
    };
    let at = match (&vector, embedded_at_us) {
        (Some(_), None) => {
            losses.add("vector_without_embedded_at");
            0
        }
        (_, at) => at.unwrap_or(0),
    };
    let stored_vector = vector.as_deref().map(|v| (model.as_str(), at, v));
    crate::chunks::seed_chunk(tx, record, stored_vector)?;
    raise_counter(tx, crate::chunks::NEXT_CHUNK_ID, id)?;
    Ok(Outcome::Imported)
}

// ---- links ---------------------------------------------------------------------------------

static LINKS: Relation = Relation {
    key: &["id"],
    columns: &[
        ("id", Kept),
        ("from_page_id", Kept),
        ("to_page_id", Kept),
        ("link_type", Kept),
        ("context", Kept),
        ("link_source", Kept),
        ("link_kind", Kept),
        ("origin_page_id", Kept),
        ("origin_field", Kept),
        ("resolution_type", Kept),
        ("assertion_tense", Kept),
        ("created_at", Kept),
    ],
    import: import_link,
};

fn import_link(tx: &mut dyn KvWrite, row: &Row, _: &mut Losses) -> Result<Outcome> {
    let record = LinkRecord {
        id: row.req_id("id")?,
        from_page_id: row.req_id("from_page_id")?,
        to_page_id: row.req_id("to_page_id")?,
        link_type: row.text_or("link_type", ""),
        context: row.text_or("context", ""),
        link_source: row.text("link_source"),
        link_kind: row.text("link_kind"),
        origin_page_id: row.id("origin_page_id")?,
        origin_field: row.text("origin_field"),
        resolution_type: row.text("resolution_type"),
        assertion_tense: row.text("assertion_tense"),
        created_at_us: row.req_ts("created_at")?,
    };
    for page in [record.from_page_id, record.to_page_id]
        .into_iter()
        .chain(record.origin_page_id)
    {
        require_page(&*tx, page)?;
    }
    if tx
        .get(&keys::link(record.from_page_id, record.id))?
        .is_some()
    {
        return Ok(Outcome::Skipped);
    }
    check_link(&record)?;
    if tx.get(&record.unique_key())?.is_some() {
        return Err(duplicate("links"));
    }
    crate::links::put_link(tx, &record)?;
    raise_counter(tx, crate::links::NEXT_LINK_ID, record.id)?;
    Ok(Outcome::Imported)
}

// ---- timeline_entries ----------------------------------------------------------------------

static TIMELINE: Relation = Relation {
    key: &["id"],
    columns: &[
        ("id", Kept),
        ("page_id", Kept),
        ("date", Kept),
        ("source", Kept),
        ("summary", Kept),
        ("detail", Kept),
        ("event_page_id", Kept),
        ("created_at", Kept),
        ("trust_tier", Kept),
        ("write_origin", Kept),
        ("write_request_id", Kept),
        ("write_principal_kind", Kept),
        ("write_principal_id", Kept),
        ("last_write_request_id", Kept),
        ("last_write_principal_kind", Kept),
        ("last_write_principal_id", Kept),
        ("last_written_at", Kept),
    ],
    import: import_timeline,
};

fn import_timeline(tx: &mut dyn KvWrite, row: &Row, _: &mut Losses) -> Result<Outcome> {
    let record = TimelineRecord {
        id: row.req_id("id")?,
        page_id: row.req_id("page_id")?,
        date: row
            .date("date")?
            .ok_or_else(|| StoreError::invalid("seed timeline_entries.date: is NULL"))?,
        source: row.text_or("source", ""),
        summary: row.req("summary")?,
        detail: row.text_or("detail", ""),
        event_page_id: row.id("event_page_id")?,
        created_at_us: row.req_ts("created_at")?,
        receipt: row.write_receipt()?,
        trust: row.row_trust()?,
    };
    for page in std::iter::once(record.page_id).chain(record.event_page_id) {
        require_page(&*tx, page)?;
    }
    if tx
        .get(&keys::timeline(record.page_id, &record.date, record.id))?
        .is_some()
    {
        return Ok(Outcome::Skipped);
    }
    crate::timeline::put_entry(tx, None, &record)?;
    raise_counter(tx, crate::timeline::NEXT_TIMELINE_ID, record.id)?;
    Ok(Outcome::Imported)
}

// ---- slug_aliases, page_aliases ------------------------------------------------------------

static SLUG_ALIASES: Relation = Relation {
    key: &["id"],
    columns: &[
        ("source_id", Kept),
        ("alias_slug", Kept),
        ("canonical_slug", Kept),
        ("notes", Kept),
    ],
    import: import_slug_alias,
};

fn import_slug_alias(tx: &mut dyn KvWrite, row: &Row, _: &mut Losses) -> Result<Outcome> {
    let source = row.req("source_id")?;
    require_source(&*tx, &source)?;
    let record = crate::aliases::SlugAliasRecord {
        canonical_slug: row.req("canonical_slug")?,
        notes: row.text("notes"),
    };
    let stored = crate::aliases::seed_slug_alias(tx, &source, &row.req("alias_slug")?, &record)?;
    Ok(if stored {
        Outcome::Imported
    } else {
        Outcome::Skipped
    })
}

static PAGE_ALIASES: Relation = Relation {
    key: &["id"],
    columns: &[
        ("source_id", Kept),
        ("alias_norm", Kept),
        ("slug", Kept),
        ("origin", Kept),
        ("case_sensitive", Kept),
        ("alias_text", Kept),
    ],
    import: import_page_alias,
};

fn import_page_alias(tx: &mut dyn KvWrite, row: &Row, losses: &mut Losses) -> Result<Outcome> {
    let source = row.req("source_id")?;
    require_source(&*tx, &source)?;
    let origin = row.text_or("origin", "frontmatter");
    let value = crate::aliases::DerivedAliasValue {
        case_sensitive: row.bool("case_sensitive")?.unwrap_or(false),
        alias_text: row.text("alias_text"),
    };
    // A frontmatter row is stored without the two columns (`setPageAliases` writes the defaults).
    if origin == "frontmatter" && (value.case_sensitive || value.alias_text.is_some()) {
        losses.add("frontmatter_alias_columns");
    }
    let stored = crate::aliases::seed_page_alias(
        tx,
        &source,
        &row.req("alias_norm")?,
        &row.req("slug")?,
        &origin,
        &value,
    )?;
    Ok(if stored {
        Outcome::Imported
    } else {
        Outcome::Skipped
    })
}

// ---- facts ---------------------------------------------------------------------------------

static FACTS: Relation = Relation {
    key: &["id"],
    columns: &[
        ("id", Kept),
        ("source_id", Kept),
        ("entity_slug", Kept),
        ("fact", Kept),
        ("kind", Kept),
        ("visibility", Kept),
        ("notability", Kept),
        ("context", Kept),
        ("valid_from", Kept),
        ("valid_until", Kept),
        ("expired_at", Kept),
        ("superseded_by", Kept),
        ("consolidated_at", Kept),
        ("consolidated_into", Kept),
        ("source", Kept),
        ("source_session", Kept),
        ("confidence", Kept),
        ("embedding", Kept),
        ("embedded_at", Kept),
        ("created_at", Kept),
        ("row_num", Kept),
        ("source_markdown_slug", Kept),
        ("claim_metric", Kept),
        ("claim_value", Kept),
        ("claim_unit", Kept),
        ("claim_period", Kept),
        ("event_type", Kept),
        ("dimension", Kept),
        ("value", Kept),
        ("value_hash", Kept),
        ("dim_status", Kept),
        ("embedding_model", Kept),
        ("embedded_text_hash", Kept),
        ("attributed_to", Kept),
        ("trust_tier", Kept),
        ("write_origin", Kept),
        ("write_request_id", Kept),
        ("write_principal_kind", Kept),
        ("write_principal_id", Kept),
        ("last_write_request_id", Kept),
        ("last_write_principal_kind", Kept),
        ("last_write_principal_id", Kept),
        ("last_written_at", Kept),
    ],
    import: import_fact,
};

fn import_fact(tx: &mut dyn KvWrite, row: &Row, _: &mut Losses) -> Result<Outcome> {
    let id = row.req_id("id")?;
    if read_fact(&*tx, id)?.is_some() {
        return Ok(Outcome::Skipped);
    }
    let source_id = row.text_or("source_id", "default");
    require_source(&*tx, &source_id)?;
    let record = FactRecord {
        id,
        source_id,
        entity_slug: row.text("entity_slug"),
        fact: row.req("fact")?,
        kind: row.text_or("kind", "fact"),
        visibility: row.text_or("visibility", "private"),
        notability: row.text_or("notability", "medium"),
        context: row.text("context"),
        valid_from_us: row.req_ts("valid_from")?,
        valid_until_us: row.ts("valid_until")?,
        expired_at_us: row.ts("expired_at")?,
        superseded_by: row.id("superseded_by")?,
        consolidated_at_us: row.ts("consolidated_at")?,
        consolidated_into: row.i64("consolidated_into")?,
        source: row.req("source")?,
        source_session: row.text("source_session"),
        confidence: row.f32("confidence")?.unwrap_or(1.0),
        embedding: row.vector("embedding")?,
        embedding_model: row.text("embedding_model"),
        embedded_text_hash: row.text("embedded_text_hash"),
        embedded_at_us: row.ts("embedded_at")?,
        created_at_us: row.req_ts("created_at")?,
        row_num: row.i32("row_num")?,
        source_markdown_slug: row.text("source_markdown_slug"),
        claim_metric: row.text("claim_metric"),
        claim_value: row.f64("claim_value")?,
        claim_unit: row.text("claim_unit"),
        claim_period: row.text("claim_period"),
        event_type: row.text("event_type"),
        dimension: row.text("dimension"),
        value: row.text("value"),
        value_hash: row.text("value_hash"),
        dim_status: row.text("dim_status"),
        attributed_to: row.text("attributed_to"),
        trust_tier: row.text_or("trust_tier", "unknown"),
        write_origin: row.json("write_origin")?,
        receipt: row.write_receipt()?,
    };
    crate::facts::write_fact(tx, &seed_trust(), None, &record)?;
    raise_counter(tx, crate::facts::COUNTER, id)?;
    Ok(Outcome::Imported)
}

// ---- takes ---------------------------------------------------------------------------------

static TAKES: Relation = Relation {
    key: &["id"],
    columns: &[
        ("id", Kept),
        ("page_id", Kept),
        ("row_num", Kept),
        ("claim", Kept),
        ("kind", Kept),
        ("holder", Kept),
        ("weight", Kept),
        ("since_date", Kept),
        ("until_date", Kept),
        ("source", Kept),
        ("superseded_by", Kept),
        ("active", Kept),
        ("resolved_at", Kept),
        ("resolved_outcome", Kept),
        ("resolved_value", Kept),
        ("resolved_unit", Kept),
        ("resolved_source", Kept),
        ("resolved_by", Kept),
        ("embedded_at", Kept),
        ("created_at", Kept),
        ("updated_at", Kept),
        ("resolved_quality", Kept),
        ("embedding", Kept),
        ("embedding_model", Kept),
        ("embedded_text_hash", Kept),
        ("trust_tier", Kept),
        ("write_origin", Kept),
        ("write_request_id", Kept),
        ("write_principal_kind", Kept),
        ("write_principal_id", Kept),
        ("last_write_request_id", Kept),
        ("last_write_principal_kind", Kept),
        ("last_write_principal_id", Kept),
        ("last_written_at", Kept),
    ],
    import: import_take,
};

fn import_take(tx: &mut dyn KvWrite, row: &Row, losses: &mut Losses) -> Result<Outcome> {
    let page = require_page(&*tx, row.req_id("page_id")?)?;
    let weight = row.f32("weight")?.unwrap_or(0.5);
    if !(0.0..=1.0).contains(&weight) {
        return Err(StoreError::new(
            CONSTRAINT_VIOLATION,
            "new row for relation \"takes\" violates check constraint \"takes_weight_check\"",
        ));
    }
    let take = TakeRecord {
        id: row.req_id("id")?,
        page_id: page.id,
        source_id: page.source_id,
        row_num: row
            .i32("row_num")?
            .ok_or_else(|| StoreError::invalid("seed takes.row_num: is NULL"))?,
        claim: row.req("claim")?,
        kind: row.req("kind")?,
        holder: row.req("holder")?,
        weight,
        since_date: row.text("since_date"),
        until_date: row.text("until_date"),
        source: row.text("source"),
        superseded_by: row.i32("superseded_by")?,
        active: row.bool("active")?.unwrap_or(true),
        resolved_at_us: row.ts("resolved_at")?,
        resolved_outcome: row.bool("resolved_outcome")?,
        resolved_quality: row.text("resolved_quality"),
        resolved_value: row.f32("resolved_value")?,
        resolved_unit: row.text("resolved_unit"),
        resolved_source: row.text("resolved_source"),
        resolved_by: row.text("resolved_by"),
        created_at_us: row.req_ts("created_at")?,
        updated_at_us: row.req_ts("updated_at")?,
        claim_rev: 0,
        receipt: row.write_receipt()?,
        trust: row.row_trust()?,
    };
    if !crate::takes::seed_take(tx, &take)? {
        return Ok(Outcome::Skipped);
    }
    raise_counter(tx, crate::takes::NEXT_TAKE_ID, take.id)?;
    // The store keeps a take vector for a claim revision, not a text hash: only a vector of the
    // current claim carries over.
    if let Some(vector) = row.vector("embedding")? {
        let current = row.value("embedded_text_hash") == Some(md5_hex(&take.claim).as_str());
        match (current, row.text("embedding_model"), row.ts("embedded_at")?) {
            (true, Some(model), Some(at)) => crate::embeddings::put_take_vector(
                tx,
                take.id,
                take.claim_rev,
                &model,
                at,
                &vector,
            )?,
            _ => losses.add("take_vector_not_current"),
        }
    }
    Ok(Outcome::Imported)
}
