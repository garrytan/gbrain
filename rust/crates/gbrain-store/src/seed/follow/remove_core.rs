//! The follow spec of the core and privacy relations.

use super::{Follow, Identity, Mode, Replace, number, text};
use crate::error::Result;
use crate::kv::KvWrite;
use crate::pages::{read_page_by_id, write_page};
use crate::{keys, seed::Importer, seed::Losses, seed::Outcome, seed::decode::Row};

/// A column the remover finds the row by; a missing one is a row it cannot locate.
macro_rules! need {
    ($id:expr, $col:expr) => {
        match text($id, $col) {
            Some(v) => v,
            None => return Ok(false),
        }
    };
    ($id:expr, $col:expr, $t:ty) => {
        match number::<$t>($id, $col) {
            Some(v) => v,
            None => return Ok(false),
        }
    };
}
pub(super) use need;

const fn follow(identity: &'static [&'static str], remove: super::Remover) -> Follow {
    Follow {
        identity,
        remove: Some(remove),
        replace: Replace::ByRemove,
    }
}

pub(super) static SPECS: &[(&str, Follow)] = &[
    // The store has no source delete, so a source is replaced in place and never removed.
    (
        "sources",
        Follow {
            identity: &["id"],
            remove: None,
            replace: Replace::Import,
        },
    ),
    ("config", follow(&["key"], remove_config)),
    (
        "pages",
        Follow {
            identity: &["id"],
            remove: Some(remove_page),
            replace: Replace::Custom(replace_page),
        },
    ),
    ("tags", follow(&["id", "page_id", "tag"], remove_tag)),
    (
        "content_chunks",
        follow(&["id", "page_id", "chunk_index"], remove_chunk),
    ),
    (
        "links",
        follow(&["id", "from_page_id", "to_page_id"], remove_link),
    ),
    (
        "timeline_entries",
        follow(&["id", "page_id", "date", "event_page_id"], remove_timeline),
    ),
    (
        "slug_aliases",
        follow(&["id", "source_id", "alias_slug"], remove_slug_alias),
    ),
    (
        "page_aliases",
        follow(
            &["id", "source_id", "alias_norm", "slug", "origin"],
            remove_page_alias,
        ),
    ),
    ("facts", follow(&["id"], remove_fact)),
    ("takes", follow(&["id", "page_id", "row_num"], remove_take)),
    (
        "owner_only_marks",
        follow(&["row_table", "row_id"], remove_mark),
    ),
    (
        "slug_rename_history",
        follow(&["source_id", "old_slug", "new_slug"], remove_rename),
    ),
    (
        "fact_withdrawals",
        follow(
            &["source_id", "visibility", "subject", "fact_hash"],
            remove_withdrawal,
        ),
    ),
    (
        "page_purges",
        follow(&["source_id", "content_hash"], remove_purge),
    ),
    ("oauth_clients", follow(&["client_id"], remove_client)),
];

/// `version` is the store's own schema version; the store's migrations own it.
fn remove_config(tx: &mut dyn KvWrite, id: &Identity, _: Mode) -> Result<bool> {
    let key = need!(id, "key");
    if key == "version" {
        return Ok(false);
    }
    let stored = keys::text(keys::CONFIG, &[key]);
    if tx.get(&stored)?.is_none() {
        return Ok(false);
    }
    tx.delete(&stored)?;
    Ok(true)
}

fn remove_page(tx: &mut dyn KvWrite, id: &Identity, mode: Mode) -> Result<bool> {
    let page_id = need!(id, "id", u64);
    let Some(page) = read_page_by_id(&*tx, page_id)? else {
        return Ok(false);
    };
    match mode {
        Mode::Delete => crate::pages::remove_page(tx, &page)?,
        Mode::Replace => crate::pages::remove_page_own_state(tx, &page)?,
    }
    Ok(true)
}

/// A changed page keeps what hangs off it: its chunks, links, timeline entries, tags and the rest.
/// Its own records are removed and stored again from the row, and its tags, which ride in the page
/// record but are rows of their own, are put back.
fn replace_page(
    tx: &mut dyn KvWrite,
    row: &Row,
    losses: &mut Losses,
    import: Importer,
) -> Result<Outcome> {
    let id = row.req_id("id")?;
    let Some(old) = read_page_by_id(&*tx, id)? else {
        return import(tx, row, losses);
    };
    crate::pages::remove_page_own_state(tx, &old)?;
    let outcome = import(tx, row, losses)?;
    if let Some(mut page) = read_page_by_id(&*tx, id)? {
        page.tags = old.tags;
        page.tag_sources = old.tag_sources;
        write_page(tx, &page)?;
    }
    Ok(outcome)
}

fn remove_tag(tx: &mut dyn KvWrite, id: &Identity, _: Mode) -> Result<bool> {
    let page_id = need!(id, "page_id", u64);
    let tag = need!(id, "tag");
    let Some(mut page) = read_page_by_id(&*tx, page_id)? else {
        return Ok(false);
    };
    if !page.tags.iter().any(|t| t == tag) {
        return Ok(false);
    }
    page.tags.retain(|t| t != tag);
    page.tag_sources.remove(tag);
    write_page(tx, &page)?;
    Ok(true)
}

fn remove_chunk(tx: &mut dyn KvWrite, id: &Identity, mode: Mode) -> Result<bool> {
    let page_id = need!(id, "page_id", u64);
    let index = need!(id, "chunk_index", u32);
    crate::chunks::remove_chunk(tx, page_id, index, mode == Mode::Delete)
}

fn remove_link(tx: &mut dyn KvWrite, id: &Identity, _: Mode) -> Result<bool> {
    crate::links::remove_link(tx, need!(id, "from_page_id", u64), need!(id, "id", u64))
}

fn remove_timeline(tx: &mut dyn KvWrite, id: &Identity, _: Mode) -> Result<bool> {
    crate::timeline::remove_entry(
        tx,
        need!(id, "page_id", u64),
        need!(id, "date"),
        need!(id, "id", u64),
    )
}

fn remove_slug_alias(tx: &mut dyn KvWrite, id: &Identity, _: Mode) -> Result<bool> {
    crate::aliases::remove_slug_alias(tx, need!(id, "source_id"), need!(id, "alias_slug"))
}

fn remove_page_alias(tx: &mut dyn KvWrite, id: &Identity, _: Mode) -> Result<bool> {
    crate::aliases::remove_page_alias(
        tx,
        need!(id, "source_id"),
        need!(id, "alias_norm"),
        need!(id, "slug"),
        need!(id, "origin"),
    )
}

fn remove_fact(tx: &mut dyn KvWrite, id: &Identity, mode: Mode) -> Result<bool> {
    crate::facts::remove_fact(
        tx,
        &crate::seed::seed_trust(),
        need!(id, "id", u64),
        mode == Mode::Delete,
    )
}

fn remove_take(tx: &mut dyn KvWrite, id: &Identity, mode: Mode) -> Result<bool> {
    crate::takes::remove_take(tx, need!(id, "id", u64), mode == Mode::Replace)
}

fn remove_mark(tx: &mut dyn KvWrite, id: &Identity, _: Mode) -> Result<bool> {
    if need!(id, "row_table") != "pages" {
        return Ok(false);
    }
    crate::owner_only_marks::remove_mark(tx, need!(id, "row_id", u64))
}

fn remove_rename(tx: &mut dyn KvWrite, id: &Identity, _: Mode) -> Result<bool> {
    crate::aliases::remove_rename(
        tx,
        need!(id, "source_id"),
        need!(id, "old_slug"),
        need!(id, "new_slug"),
    )
}

fn remove_withdrawal(tx: &mut dyn KvWrite, id: &Identity, _: Mode) -> Result<bool> {
    crate::trust::withdrawals::remove_withdrawal(
        tx,
        [
            need!(id, "source_id"),
            need!(id, "visibility"),
            need!(id, "subject"),
            need!(id, "fact_hash"),
        ],
    )
}

fn remove_purge(tx: &mut dyn KvWrite, id: &Identity, _: Mode) -> Result<bool> {
    crate::facts::remove_purge(tx, need!(id, "source_id"), need!(id, "content_hash"))
}

fn remove_client(tx: &mut dyn KvWrite, id: &Identity, _: Mode) -> Result<bool> {
    crate::jobs::remove_client(tx, need!(id, "client_id"))
}
