//! Brain history and graph: page versions, files, raw data, code edges, open loops, synthesis
//! evidence, trust proposals, wanted links, the facts reconcile watermark, fact relink attempts and
//! the derived generation ledger.

use super::decode::Row;
use super::{
    Column::{Kept, Unmapped},
    Losses, Outcome, Relation, raise_counter, require_page, require_source,
};
use crate::code_edges::{EdgeRecord, Table, seed_edge};
use crate::dream::jsonb;
use crate::error::{Result, StoreError};
use crate::facts::loops::{COUNTER as NEXT_OPEN_LOOP_ID, LoopRecord, seed_open_loop};
use crate::facts::reconcile::{ReconcileRecord, put_reconcile, read_reconcile};
use crate::facts::relink::{AttemptRecord, seed_attempt};
use crate::generations::{SeedGeneration, seed_generation, seed_item};
use crate::keys;
use crate::kv::KvWrite;
use crate::pages::{NEXT_VERSION_ID, PageText, VersionRecord, seed_version};
use crate::raw_files::{FileRecord, NEXT_FILE_ID, RawRecord, seed_file, seed_raw_data};
use crate::takes::{fk_failed, seed_evidence};
use crate::trust::allow_rules::{AllowRuleRecord, COUNTER as NEXT_ALLOW_RULE_ID, seed_rule};
use crate::trust::proposals::{ProposalRecord, seed_proposal};
use crate::wanted_links::{ID_COUNTER as NEXT_WANTED_LINK_ID, WantedRecord, seed_wanted};
use crate::write_receipt::VersionReceipt;
use serde_json::{Value, json};

/// In import order.
pub(super) const RELATIONS: &[(&str, &Relation)] = &[
    ("page_versions", &PAGE_VERSIONS),
    ("files", &FILES),
    ("raw_data", &RAW_DATA),
    ("code_edges_chunk", &CODE_EDGES_CHUNK),
    ("code_edges_symbol", &CODE_EDGES_SYMBOL),
    ("open_loops", &OPEN_LOOPS),
    ("synthesis_evidence", &SYNTHESIS_EVIDENCE),
    ("trust_proposals", &TRUST_PROPOSALS),
    ("trust_allow_rules", &TRUST_ALLOW_RULES),
    ("wanted_links", &WANTED_LINKS),
    ("page_facts_reconcile", &PAGE_FACTS_RECONCILE),
    ("fact_relink_attempts", &FACT_RELINK_ATTEMPTS),
    ("derived_generations", &DERIVED_GENERATIONS),
    ("derived_generation_items", &DERIVED_GENERATION_ITEMS),
];

/// A column the table declares NOT NULL, read as the value or an error naming it.
fn need<T>(value: Option<T>, column: &str) -> Result<T> {
    value.ok_or_else(|| StoreError::invalid(format!("seed {column}: is NULL")))
}

// ---- page_versions -------------------------------------------------------------------------

static PAGE_VERSIONS: Relation = Relation {
    key: &["id"],
    columns: &[
        ("id", Kept),
        ("page_id", Kept),
        ("compiled_truth", Kept),
        ("frontmatter", Kept),
        ("snapshot_at", Kept),
        ("content_hash", Kept),
        ("source_path", Kept),
        ("knowledge_revision", Kept),
        ("timeline", Kept),
        ("title", Kept),
        ("type", Kept),
        ("tags", Kept),
        ("is_deleted", Kept),
        ("trust_tier", Kept),
        ("write_origin", Kept),
        ("change_reason", Kept),
        ("successor_pruned", Kept),
        ("body_storage", Kept),
        ("body_generation", Kept),
        ("body_bytes", Kept),
        ("write_request_id", Kept),
        ("write_principal_kind", Kept),
        ("write_principal_id", Kept),
        ("archived_write_request_id", Kept),
        ("archived_principal_kind", Kept),
        ("archived_principal_id", Kept),
    ],
    import: import_version,
};

/// A version written before migration v248 or v193 can hold NULL in `title`, `type`, `tags`,
/// `knowledge_revision` or `is_deleted`; the store's record holds an empty value, counted as
/// `legacy_version_columns`. A segmented snapshot keeps its body generation and size but not the
/// segments they name (`segmented_version_body`).
fn import_version(tx: &mut dyn KvWrite, row: &Row, losses: &mut Losses) -> Result<Outcome> {
    let id = row.req_id("id")?;
    let page_id = row.req_id("page_id")?;
    require_page(&*tx, page_id)?;
    let segmented = row.value("body_storage") == Some("segmented");
    if segmented {
        losses.add("segmented_version_body");
    }
    let legacy = ["title", "type", "tags", "knowledge_revision", "is_deleted"]
        .iter()
        .any(|column| row.value(column).is_none());
    if legacy {
        losses.add("legacy_version_columns");
    }
    let text = |col: &str| row.text(col).map_or_else(PageText::null, PageText::from);
    let tags = match row.json("tags")? {
        None => Vec::new(),
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| item.as_str().map(str::to_owned))
            .collect::<Option<Vec<_>>>()
            .ok_or_else(|| StoreError::invalid("seed page_versions.tags: not an array of text"))?,
        Some(_) => return Err(StoreError::invalid("seed page_versions.tags: not an array")),
    };
    let record = VersionRecord {
        id,
        page_id,
        compiled_truth: text("compiled_truth"),
        timeline: text("timeline"),
        title: row.text_or("title", ""),
        page_type: row.text_or("type", ""),
        tags,
        frontmatter: row.object("frontmatter")?,
        source_path: row.text("source_path"),
        content_hash: row.text("content_hash"),
        knowledge_revision: row.text_or("knowledge_revision", ""),
        is_deleted: row.bool("is_deleted")?.unwrap_or(false),
        snapshot_at_us: row.req_ts("snapshot_at")?,
        body_storage: segmented.then(|| "segmented".to_owned()),
        body_generation: row.i64("body_generation")?,
        body_bytes: row.i64("body_bytes")?,
        trust_tier: row.text("trust_tier").filter(|tier| tier != "unknown"),
        write_origin: row.json("write_origin")?,
        change_reason: row.text("change_reason"),
        successor_pruned: row.bool("successor_pruned")?.unwrap_or(false),
        receipt: VersionReceipt {
            written: row.actor(
                "write_request_id",
                "write_principal_kind",
                "write_principal_id",
            ),
            archived: row.actor(
                "archived_write_request_id",
                "archived_principal_kind",
                "archived_principal_id",
            ),
        },
    };
    if !seed_version(tx, &record)? {
        return Ok(Outcome::Skipped);
    }
    raise_counter(tx, NEXT_VERSION_ID, id)?;
    Ok(Outcome::Imported)
}

// ---- files ---------------------------------------------------------------------------------

static FILES: Relation = Relation {
    key: &["id"],
    columns: &[
        ("id", Kept),
        ("source_id", Kept),
        ("page_slug", Kept),
        ("page_id", Kept),
        ("filename", Kept),
        ("storage_path", Kept),
        ("mime_type", Kept),
        ("size_bytes", Kept),
        ("content_hash", Kept),
        ("metadata", Kept),
        ("created_at", Kept),
    ],
    import: import_file,
};

fn import_file(tx: &mut dyn KvWrite, row: &Row, _: &mut Losses) -> Result<Outcome> {
    let source_id = row.text_or("source_id", "default");
    require_source(&*tx, &source_id)?;
    let page_id = row.id("page_id")?;
    if let Some(page) = page_id {
        require_page(&*tx, page)?;
    }
    let record = FileRecord {
        id: row.req_id("id")?,
        source_id,
        page_slug: row.text("page_slug"),
        page_id,
        filename: row.req("filename")?,
        storage_path: row.req("storage_path")?,
        mime_type: row.text("mime_type"),
        size_bytes: row.i64("size_bytes")?,
        content_hash: row.req("content_hash")?,
        metadata: crate::jsonb::order(row.json("metadata")?.unwrap_or_else(|| json!({}))),
        created_at_us: row.req_ts("created_at")?,
    };
    if !seed_file(tx, &record)? {
        return Ok(Outcome::Skipped);
    }
    raise_counter(tx, NEXT_FILE_ID, record.id)?;
    Ok(Outcome::Imported)
}

// ---- raw_data ------------------------------------------------------------------------------

/// The store keys raw data by `(page_id, source)` and keeps no serial id: `id` is reported.
static RAW_DATA: Relation = Relation {
    key: &["id"],
    columns: &[
        ("id", Unmapped(None)),
        ("page_id", Kept),
        ("source", Kept),
        ("data", Kept),
        ("fetched_at", Kept),
    ],
    import: import_raw_data,
};

fn import_raw_data(tx: &mut dyn KvWrite, row: &Row, _: &mut Losses) -> Result<Outcome> {
    let page_id = row.req_id("page_id")?;
    require_page(&*tx, page_id)?;
    let record = RawRecord {
        id: None,
        page_id,
        source: row.req("source")?,
        data: crate::jsonb::order(need(row.json("data")?, "raw_data.data")?),
        fetched_at_us: row.req_ts("fetched_at")?,
    };
    Ok(if seed_raw_data(tx, &record)? {
        Outcome::Imported
    } else {
        Outcome::Skipped
    })
}

// ---- code_edges_chunk, code_edges_symbol ---------------------------------------------------

static CODE_EDGES_CHUNK: Relation = Relation {
    key: &["id"],
    columns: &[
        ("id", Kept),
        ("from_chunk_id", Kept),
        ("to_chunk_id", Kept),
        ("from_symbol_qualified", Kept),
        ("to_symbol_qualified", Kept),
        ("edge_type", Kept),
        ("edge_metadata", Kept),
        ("source_id", Kept),
        ("created_at", Kept),
    ],
    import: import_chunk_edge,
};

static CODE_EDGES_SYMBOL: Relation = Relation {
    key: &["id"],
    columns: &[
        ("id", Kept),
        ("from_chunk_id", Kept),
        ("from_symbol_qualified", Kept),
        ("to_symbol_qualified", Kept),
        ("edge_type", Kept),
        ("edge_metadata", Kept),
        ("source_id", Kept),
        ("created_at", Kept),
    ],
    import: import_symbol_edge,
};

fn import_chunk_edge(tx: &mut dyn KvWrite, row: &Row, _: &mut Losses) -> Result<Outcome> {
    import_edge(tx, row, Table::Chunk)
}

fn import_symbol_edge(tx: &mut dyn KvWrite, row: &Row, _: &mut Losses) -> Result<Outcome> {
    import_edge(tx, row, Table::Symbol)
}

/// The chunk store has no index by chunk id, so a chunk is checked by its id counter: an id the
/// chunks never reached (or a store with no chunks yet) names no chunk. An edge of a chunk the
/// seed dropped (`retired_chunk`, `segment_chunk`) is stored; no read returns it, because every
/// edge read keeps only live chunk ends.
fn require_chunk(tx: &dyn crate::kv::KvRead, table: &str, column: &str, id: u64) -> Result<()> {
    let next = match tx.get(&keys::meta(crate::chunks::NEXT_CHUNK_ID))? {
        Some(bytes) => keys::be8(&bytes).unwrap_or(1),
        None => 1,
    };
    if id < next {
        return Ok(());
    }
    Err(fk_failed(table, &format!("{table}_{column}_fkey")))
}

fn import_edge(tx: &mut dyn KvWrite, row: &Row, table: Table) -> Result<Outcome> {
    let name = if table == Table::Chunk {
        "code_edges_chunk"
    } else {
        "code_edges_symbol"
    };
    let id = row.req_id("id")?;
    let from = row.req_id("from_chunk_id")?;
    require_chunk(&*tx, name, "from_chunk_id", from)?;
    let to_chunk_id = match table {
        Table::Chunk => Some(row.req_id("to_chunk_id")?),
        Table::Symbol => None,
    };
    if let Some(to) = to_chunk_id {
        require_chunk(&*tx, name, "to_chunk_id", to)?;
    }
    let source_id = row.text("source_id");
    if let Some(source) = &source_id {
        require_source(&*tx, source)?;
    }
    let edge = EdgeRecord {
        table,
        id,
        from_chunk_id: from,
        to_chunk_id,
        from_symbol_qualified: row.req("from_symbol_qualified")?,
        to_symbol_qualified: row.req("to_symbol_qualified")?,
        edge_type: row.req("edge_type")?,
        edge_metadata: jsonb(&row.json("edge_metadata")?.unwrap_or_else(|| json!({}))),
        source_id,
        created_at_us: row.req_ts("created_at")?,
    };
    if !seed_edge(tx, &edge)? {
        return Ok(Outcome::Skipped);
    }
    raise_counter(tx, table.sequence(), id)?;
    Ok(Outcome::Imported)
}

// ---- open_loops ----------------------------------------------------------------------------

static OPEN_LOOPS: Relation = Relation {
    key: &["id"],
    columns: &[
        ("id", Kept),
        ("source_id", Kept),
        ("dedup_key", Kept),
        ("loop_type", Kept),
        ("counterparty_slug", Kept),
        ("counterparty_source_id", Kept),
        ("counterparty_email", Kept),
        ("summary", Kept),
        ("evidence", Kept),
        ("thread_id", Kept),
        ("page_slug", Kept),
        ("due_at", Kept),
        ("status", Kept),
        ("detector", Kept),
        ("confidence", Kept),
        ("fact_id", Kept),
        ("opened_at", Kept),
        ("last_activity_at", Kept),
        ("closed_at", Kept),
        ("closed_by", Kept),
        ("created_at", Kept),
        ("updated_at", Kept),
    ],
    import: import_open_loop,
};

fn import_open_loop(tx: &mut dyn KvWrite, row: &Row, _: &mut Losses) -> Result<Outcome> {
    let id = row.req_id("id")?;
    let record = LoopRecord {
        source_id: row.req("source_id")?,
        dedup_key: row.req("dedup_key")?,
        loop_type: row.req("loop_type")?,
        counterparty_slug: row.text("counterparty_slug"),
        counterparty_source_id: row.text("counterparty_source_id"),
        counterparty_email: row.text("counterparty_email"),
        summary: row.req("summary")?,
        evidence: crate::jsonb::order(row.json("evidence")?.unwrap_or_else(|| json!([]))),
        thread_id: row.text("thread_id"),
        page_slug: row.text("page_slug"),
        due_at_us: row.ts("due_at")?,
        status: row.text_or("status", "open"),
        detector: row.req("detector")?,
        confidence: row.f32("confidence")?.unwrap_or(1.0),
        fact_id: row.i64("fact_id")?,
        opened_at_us: row.req_ts("opened_at")?,
        last_activity_at_us: row.req_ts("last_activity_at")?,
        closed_at_us: row.ts("closed_at")?,
        closed_by: row.text("closed_by"),
        created_at_us: row.req_ts("created_at")?,
        updated_at_us: row.req_ts("updated_at")?,
    };
    if !seed_open_loop(tx, id, &record)? {
        return Ok(Outcome::Skipped);
    }
    raise_counter(tx, NEXT_OPEN_LOOP_ID, id)?;
    Ok(Outcome::Imported)
}

// ---- synthesis_evidence --------------------------------------------------------------------

static SYNTHESIS_EVIDENCE: Relation = Relation {
    key: &["synthesis_page_id", "take_page_id", "take_row_num"],
    columns: &[
        ("synthesis_page_id", Kept),
        ("take_page_id", Kept),
        ("take_row_num", Kept),
        ("citation_index", Kept),
        ("created_at", Kept),
    ],
    import: import_evidence,
};

fn import_evidence(tx: &mut dyn KvWrite, row: &Row, _: &mut Losses) -> Result<Outcome> {
    let synthesis = require_page(&*tx, row.req_id("synthesis_page_id")?)?;
    let stored = seed_evidence(
        tx,
        &synthesis,
        row.req_id("take_page_id")?,
        need(row.i32("take_row_num")?, "synthesis_evidence.take_row_num")?,
        need(
            row.i32("citation_index")?,
            "synthesis_evidence.citation_index",
        )?,
        row.req_ts("created_at")?,
    )?;
    Ok(if stored {
        Outcome::Imported
    } else {
        Outcome::Skipped
    })
}

// ---- trust_proposals -----------------------------------------------------------------------

/// The store holds the decider (`decided_principal_*`) but not the proposer's principal or the
/// write request.
static TRUST_PROPOSALS: Relation = Relation {
    key: &["id"],
    columns: &[
        ("id", Kept),
        ("action", Kept),
        ("source_id", Kept),
        ("target_table", Kept),
        ("target_id", Kept),
        ("related_table", Kept),
        ("related_id", Kept),
        ("before_state", Kept),
        ("after_state", Kept),
        ("proposer", Kept),
        ("status", Kept),
        ("decided_at", Kept),
        ("decided_principal_kind", Kept),
        ("decided_principal_id", Kept),
        ("created_at", Kept),
        ("updated_at", Kept),
        ("proposer_principal_kind", Unmapped(None)),
        ("proposer_principal_id", Unmapped(None)),
        ("write_request_id", Unmapped(None)),
    ],
    import: import_proposal,
};

fn import_proposal(tx: &mut dyn KvWrite, row: &Row, _: &mut Losses) -> Result<Outcome> {
    let id = row.req_id("id")?;
    let record = ProposalRecord {
        id,
        action: row.req("action")?,
        source_id: row.req("source_id")?,
        target_table: row.req("target_table")?,
        target_id: need(row.i64("target_id")?, "trust_proposals.target_id")?,
        related_table: row.text("related_table"),
        related_id: row.i64("related_id")?,
        before_state: row.json("before_state")?.unwrap_or_else(|| json!({})),
        after_state: row.json("after_state")?.unwrap_or_else(|| json!({})),
        proposer: row.req("proposer")?,
        status: row.text_or("status", "pending"),
        decided_at_us: row.ts("decided_at")?,
        decided_principal_kind: row.text("decided_principal_kind"),
        decided_principal_id: row.text("decided_principal_id"),
        created_at_us: row.req_ts("created_at")?,
        updated_at_us: row.req_ts("updated_at")?,
    };
    if !seed_proposal(tx, &record)? {
        return Ok(Outcome::Skipped);
    }
    raise_counter(tx, "trust_proposals", id)?;
    Ok(Outcome::Imported)
}

// ---- trust_allow_rules ---------------------------------------------------------------------

/// Every column is kept: a removed rule keeps `removed_at` and `removed_by`, its receipt.
static TRUST_ALLOW_RULES: Relation = Relation {
    key: &["id"],
    columns: &[
        ("id", Kept),
        ("source_id", Kept),
        ("uri_prefix", Kept),
        ("reason_family", Kept),
        ("created_by", Kept),
        ("created_at", Kept),
        ("removed_at", Kept),
        ("removed_by", Kept),
        ("reason", Kept),
    ],
    import: import_allow_rule,
};

fn import_allow_rule(tx: &mut dyn KvWrite, row: &Row, _: &mut Losses) -> Result<Outcome> {
    let id = row.req_id("id")?;
    let record = AllowRuleRecord {
        id,
        source_id: row.req("source_id")?,
        uri_prefix: row.text("uri_prefix"),
        reason_family: row.text("reason_family"),
        created_by: row.req("created_by")?,
        created_at_us: row.req_ts("created_at")?,
        removed_at_us: row.ts("removed_at")?,
        removed_by: row.text("removed_by"),
        reason: row.text("reason"),
    };
    if !seed_rule(tx, &record)? {
        return Ok(Outcome::Skipped);
    }
    raise_counter(tx, NEXT_ALLOW_RULE_ID, id)?;
    Ok(Outcome::Imported)
}

// ---- wanted_links --------------------------------------------------------------------------

static WANTED_LINKS: Relation = Relation {
    key: &["id"],
    columns: &[
        ("id", Kept),
        ("origin_page_id", Kept),
        ("source_id", Kept),
        ("producer", Kept),
        ("ref_kind", Kept),
        ("target_source_id", Kept),
        ("target_ref", Kept),
        ("link_type", Kept),
        ("context", Kept),
        ("checked_at", Kept),
        ("first_seen_at", Kept),
    ],
    import: import_wanted_link,
};

/// `checked_at` is `-infinity` on a slug row whose target was a live page when it was written;
/// the store keeps that as no time.
fn import_wanted_link(tx: &mut dyn KvWrite, row: &Row, _: &mut Losses) -> Result<Outcome> {
    let origin_page_id = row.req_id("origin_page_id")?;
    require_page(&*tx, origin_page_id)?;
    let source_id = row.req("source_id")?;
    require_source(&*tx, &source_id)?;
    let checked_at_us = match row.value("checked_at") {
        Some("-infinity") => None,
        _ => Some(row.req_ts("checked_at")?),
    };
    let record = WantedRecord {
        id: row.req_id("id")?,
        origin_page_id,
        source_id,
        producer: row.req("producer")?,
        ref_kind: row.req("ref_kind")?,
        target_source_id: row.req("target_source_id")?,
        target_ref: row.req("target_ref")?,
        link_type: row.text_or("link_type", ""),
        context: row.text_or("context", ""),
        checked_at_us,
        first_seen_at_us: row.req_ts("first_seen_at")?,
    };
    if !seed_wanted(tx, &record)? {
        return Ok(Outcome::Skipped);
    }
    raise_counter(tx, NEXT_WANTED_LINK_ID, record.id)?;
    Ok(Outcome::Imported)
}

// ---- page_facts_reconcile ------------------------------------------------------------------

static PAGE_FACTS_RECONCILE: Relation = Relation {
    key: &["page_id"],
    columns: &[
        ("page_id", Kept),
        ("reconciled_revision", Kept),
        ("reconciled_at", Kept),
        ("outcome", Kept),
        ("attempted_revision", Kept),
        ("attempted_at", Kept),
    ],
    import: import_reconcile,
};

fn import_reconcile(tx: &mut dyn KvWrite, row: &Row, _: &mut Losses) -> Result<Outcome> {
    let page_id = row.req_id("page_id")?;
    require_page(&*tx, page_id)?;
    if read_reconcile(&*tx, page_id, "shadow_seed")?.is_some() {
        return Ok(Outcome::Skipped);
    }
    let record = ReconcileRecord {
        reconciled_revision: row.text("reconciled_revision"),
        reconciled_at_us: row.ts("reconciled_at")?,
        outcome: row.req("outcome")?,
        attempted_revision: row.text("attempted_revision"),
        attempted_at_us: row.req_ts("attempted_at")?,
    };
    put_reconcile(tx, page_id, &record)?;
    Ok(Outcome::Imported)
}

// ---- fact_relink_attempts ------------------------------------------------------------------

/// The table has no foreign key: a row names a source and a fact that need not exist.
static FACT_RELINK_ATTEMPTS: Relation = Relation {
    key: &["source_id", "fact_id"],
    columns: &[
        ("source_id", Kept),
        ("fact_id", Kept),
        ("outcome", Kept),
        ("reason", Kept),
        ("tier", Kept),
        ("model", Kept),
        ("target_slug", Kept),
        ("run_id", Kept),
        ("attempted_at", Kept),
    ],
    import: import_relink_attempt,
};

fn import_relink_attempt(tx: &mut dyn KvWrite, row: &Row, _: &mut Losses) -> Result<Outcome> {
    let record = AttemptRecord {
        fact_id: need(row.i64("fact_id")?, "fact_relink_attempts.fact_id")?,
        outcome: row.req("outcome")?,
        reason: row.text("reason"),
        tier: row.text("tier"),
        model: row.text("model"),
        target_slug: row.text("target_slug"),
        run_id: row.text("run_id"),
        attempted_at_us: row.req_ts("attempted_at")?,
    };
    Ok(if seed_attempt(tx, &row.req("source_id")?, &record)? {
        Outcome::Imported
    } else {
        Outcome::Skipped
    })
}

// ---- derived_generations, derived_generation_items -----------------------------------------

/// The store keeps the fields `listUnwithdrawnFacts` reads. The rest of the ledger row is
/// reported, not dropped silently.
static DERIVED_GENERATIONS: Relation = Relation {
    key: &["id"],
    columns: &[
        ("id", Kept),
        ("source_id", Kept),
        ("kind", Kept),
        ("owner_key", Kept),
        ("generation", Kept),
        ("state", Kept),
        ("created_at", Kept),
        ("run_id", Unmapped(None)),
        ("operation_id", Unmapped(None)),
        ("hold_id", Unmapped(None)),
        ("input_pin", Unmapped(None)),
        ("input_size", Unmapped(None)),
        ("completeness", Unmapped(Some("{}"))),
        ("item_set_hash", Unmapped(None)),
        ("held_reason", Unmapped(None)),
        ("held_context", Unmapped(None)),
        ("proposal", Unmapped(None)),
        ("proposal_bytes", Unmapped(None)),
        ("attempts", Unmapped(Some("0"))),
        ("superseded_by", Unmapped(None)),
        ("restore_of", Unmapped(None)),
        ("updated_at", Unmapped(None)),
        ("locator", Unmapped(None)),
        ("activation_id", Unmapped(None)),
    ],
    import: import_generation,
};

fn import_generation(tx: &mut dyn KvWrite, row: &Row, _: &mut Losses) -> Result<Outcome> {
    let (id, record) = generation_record(&*tx, row)?;
    Ok(if seed_generation(tx, id, &record)? {
        Outcome::Imported
    } else {
        Outcome::Skipped
    })
}

/// The generation a row describes, with no items: the items ride in their own relation.
pub(super) fn generation_record(
    read: &dyn crate::kv::KvRead,
    row: &Row,
) -> Result<(u64, SeedGeneration)> {
    let source_id = row.req("source_id")?;
    require_source(read, &source_id)?;
    let record = SeedGeneration {
        source_id,
        kind: row.req("kind")?,
        owner_key: row.req("owner_key")?,
        generation: row.i32("generation")?.unwrap_or(0),
        state: row.req("state")?,
        created_at_us: row.req_ts("created_at")?,
    };
    Ok((row.req_id("id")?, record))
}

/// The store keeps items inline in their generation, so an item row appends to it.
static DERIVED_GENERATION_ITEMS: Relation = Relation {
    key: &["generation_id", "item_key"],
    columns: &[
        ("generation_id", Kept),
        ("item_key", Kept),
        ("action", Kept),
        ("preimage", Kept),
        ("identity_hash", Unmapped(None)),
        ("preimage_bytes", Unmapped(None)),
        ("pending", Unmapped(Some("false"))),
    ],
    import: import_generation_item,
};

fn import_generation_item(tx: &mut dyn KvWrite, row: &Row, _: &mut Losses) -> Result<Outcome> {
    Ok(
        if seed_item(
            tx,
            row.req_id("generation_id")?,
            &row.req("item_key")?,
            &row.req("action")?,
            row.json("preimage")?,
        )? {
            Outcome::Imported
        } else {
            Outcome::Skipped
        },
    )
}

#[cfg(test)]
mod tests;
