//! The follow spec of the history relations.

use super::remove_core::need;
use super::{Follow, Identity, Mode, Replace, number, text};
use crate::error::Result;
use crate::keys;
use crate::kv::KvWrite;

const fn follow(identity: &'static [&'static str], remove: super::Remover) -> Follow {
    Follow {
        identity,
        remove: Some(remove),
        replace: Replace::ByRemove,
    }
}

pub(super) static SPECS: &[(&str, Follow)] = &[
    ("page_versions", follow(&["id", "page_id"], remove_version)),
    (
        "files",
        follow(&["id", "storage_path", "page_id"], remove_file),
    ),
    ("raw_data", follow(&["id", "page_id", "source"], remove_raw)),
    (
        "code_edges_chunk",
        follow(&["id", "from_chunk_id", "to_chunk_id"], remove_chunk_edge),
    ),
    (
        "code_edges_symbol",
        follow(&["id", "from_chunk_id"], remove_symbol_edge),
    ),
    ("open_loops", follow(&["id"], remove_loop)),
    (
        "synthesis_evidence",
        follow(
            &["synthesis_page_id", "take_page_id", "take_row_num"],
            remove_evidence,
        ),
    ),
    ("trust_proposals", follow(&["id"], remove_proposal)),
    (
        "wanted_links",
        follow(&["id", "origin_page_id", "source_id"], remove_wanted),
    ),
    (
        "page_facts_reconcile",
        follow(&["page_id"], remove_reconcile),
    ),
    (
        "fact_relink_attempts",
        follow(&["source_id", "fact_id"], remove_attempt),
    ),
    (
        "derived_generations",
        Follow {
            identity: &["id"],
            remove: Some(remove_generation),
            replace: Replace::Custom(replace_generation),
        },
    ),
    (
        "derived_generation_items",
        follow(&["generation_id", "item_key"], remove_item),
    ),
];

fn remove_version(tx: &mut dyn KvWrite, id: &Identity, _: Mode) -> Result<bool> {
    let key = keys::version(need!(id, "page_id", u64), need!(id, "id", u64));
    if tx.get(&key)?.is_none() {
        return Ok(false);
    }
    tx.delete(&key)?;
    Ok(true)
}

fn remove_file(tx: &mut dyn KvWrite, id: &Identity, _: Mode) -> Result<bool> {
    crate::raw_files::remove_file(tx, need!(id, "id", u64), need!(id, "storage_path"))
}

fn remove_raw(tx: &mut dyn KvWrite, id: &Identity, _: Mode) -> Result<bool> {
    crate::raw_files::remove_raw_data(tx, need!(id, "page_id", u64), need!(id, "source"))
}

fn remove_chunk_edge(tx: &mut dyn KvWrite, id: &Identity, _: Mode) -> Result<bool> {
    crate::code_edges::remove_edge(tx, crate::code_edges::Table::Chunk, need!(id, "id", u64))
}

fn remove_symbol_edge(tx: &mut dyn KvWrite, id: &Identity, _: Mode) -> Result<bool> {
    crate::code_edges::remove_edge(tx, crate::code_edges::Table::Symbol, need!(id, "id", u64))
}

fn remove_loop(tx: &mut dyn KvWrite, id: &Identity, _: Mode) -> Result<bool> {
    crate::facts::loops::remove_open_loop(tx, need!(id, "id", u64))
}

fn remove_evidence(tx: &mut dyn KvWrite, id: &Identity, _: Mode) -> Result<bool> {
    crate::takes::remove_evidence(
        tx,
        need!(id, "synthesis_page_id", u64),
        need!(id, "take_page_id", u64),
        need!(id, "take_row_num", i32),
    )
}

fn remove_proposal(tx: &mut dyn KvWrite, id: &Identity, _: Mode) -> Result<bool> {
    crate::trust::proposals::remove_proposal(tx, need!(id, "id", u64))
}

fn remove_wanted(tx: &mut dyn KvWrite, id: &Identity, _: Mode) -> Result<bool> {
    crate::wanted_links::remove_wanted(
        tx,
        need!(id, "source_id"),
        need!(id, "origin_page_id", u64),
        need!(id, "id", u64),
    )
}

fn remove_reconcile(tx: &mut dyn KvWrite, id: &Identity, _: Mode) -> Result<bool> {
    crate::facts::reconcile::remove_row(tx, need!(id, "page_id", u64))
}

fn remove_attempt(tx: &mut dyn KvWrite, id: &Identity, _: Mode) -> Result<bool> {
    crate::facts::relink::remove_attempt(tx, need!(id, "source_id"), need!(id, "fact_id", i64))
}

fn remove_generation(tx: &mut dyn KvWrite, id: &Identity, _: Mode) -> Result<bool> {
    crate::facts::generations::remove_generation(tx, need!(id, "id", u64))
}

/// A changed generation keeps its items, which are rows of their own.
fn replace_generation(
    tx: &mut dyn KvWrite,
    row: &super::Row,
    _: &mut super::super::Losses,
    _: super::super::Importer,
) -> Result<super::super::Outcome> {
    let (id, record) = super::super::history::generation_record(&*tx, row)?;
    crate::facts::generations::replace_generation(tx, id, record)?;
    Ok(super::super::Outcome::Imported)
}

fn remove_item(tx: &mut dyn KvWrite, id: &Identity, _: Mode) -> Result<bool> {
    crate::facts::generations::remove_item(
        tx,
        need!(id, "generation_id", u64),
        need!(id, "item_key"),
    )
}
