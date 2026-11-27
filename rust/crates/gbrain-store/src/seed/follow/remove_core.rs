//! The follow spec of the core and privacy relations.

use super::{Custom, Follow, Identity, Mode, Replace, number, text};
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
    keyed(identity, &[], remove)
}

/// A relation with unique natural keys besides its primary key: `unique` names the column sets.
const fn keyed(
    identity: &'static [&'static str],
    unique: &'static [&'static [&'static str]],
    remove: super::Remover,
) -> Follow {
    Follow {
        identity,
        unique,
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
            unique: &[],
            remove: None,
            replace: Replace::Import,
        },
    ),
    ("config", follow(&["key"], remove_config)),
    (
        "pages",
        Follow {
            identity: &["id", "source_id", "slug"],
            unique: &[&["source_id", "slug"]],
            remove: Some(remove_page),
            replace: Replace::Custom(Custom {
                release: release_page,
                store: store_page,
            }),
        },
    ),
    (
        "tags",
        keyed(
            &["id", "page_id", "tag"],
            &[&["page_id", "tag"]],
            remove_tag,
        ),
    ),
    (
        "content_chunks",
        keyed(
            &["id", "page_id", "chunk_index"],
            &[&["page_id", "chunk_index"]],
            remove_chunk,
        ),
    ),
    (
        "links",
        keyed(
            &[
                "id",
                "from_page_id",
                "to_page_id",
                "link_type",
                "link_source",
                "origin_page_id",
            ],
            &[&[
                "from_page_id",
                "to_page_id",
                "link_type",
                "link_source",
                "origin_page_id",
            ]],
            remove_link,
        ),
    ),
    (
        "timeline_entries",
        keyed(
            &[
                "id",
                "page_id",
                "date",
                "summary",
                "source",
                "event_page_id",
            ],
            &[&["page_id", "date", "summary", "source"]],
            remove_timeline,
        ),
    ),
    (
        "slug_aliases",
        keyed(
            &["id", "source_id", "alias_slug"],
            &[&["source_id", "alias_slug"]],
            remove_slug_alias,
        ),
    ),
    (
        "page_aliases",
        keyed(
            &["id", "source_id", "alias_norm", "slug", "origin"],
            &[&["source_id", "alias_norm", "slug", "origin"]],
            remove_page_alias,
        ),
    ),
    (
        "facts",
        keyed(
            &[
                "id",
                "source_id",
                "source_markdown_slug",
                "row_num",
                "entity_slug",
                "dimension",
                "value_hash",
                "valid_from",
            ],
            &[
                &["source_id", "source_markdown_slug", "row_num"],
                &[
                    "source_id",
                    "entity_slug",
                    "dimension",
                    "value_hash",
                    "source_markdown_slug",
                    "valid_from",
                ],
            ],
            remove_fact,
        ),
    ),
    (
        "takes",
        keyed(
            &["id", "page_id", "row_num"],
            &[&["page_id", "row_num"]],
            remove_take,
        ),
    ),
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
    ("guest_sources", follow(&["source_id"], remove_guest_source)),
    ("guest_marks", follow(&["page_id"], remove_guest_mark)),
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
/// Its own records are removed first; the new row is stored after, and its tags, which ride in the
/// page record but are rows of their own, are put back.
fn release_page(tx: &mut dyn KvWrite, row: &Row) -> Result<Option<serde_json::Value>> {
    let Some(old) = read_page_by_id(&*tx, row.req_id("id")?)? else {
        return Ok(None);
    };
    crate::pages::remove_page_own_state(tx, &old)?;
    Ok(Some(serde_json::to_value((&old.tags, &old.tag_sources))?))
}

fn store_page(
    tx: &mut dyn KvWrite,
    row: &Row,
    losses: &mut Losses,
    import: Importer,
    carry: Option<&serde_json::Value>,
) -> Result<Outcome> {
    let outcome = import(tx, row, losses)?;
    if let Some(carry) = carry
        && let Some(mut page) = read_page_by_id(&*tx, row.req_id("id")?)?
    {
        (page.tags, page.tag_sources) = serde_json::from_value(carry.clone())?;
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
    crate::timeline::remove_entry_by_id(
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

fn remove_guest_source(tx: &mut dyn KvWrite, id: &Identity, _: Mode) -> Result<bool> {
    crate::guest_sources::remove_row(tx, need!(id, "source_id"))
}

fn remove_guest_mark(tx: &mut dyn KvWrite, id: &Identity, _: Mode) -> Result<bool> {
    crate::guest_marks::remove_mark(tx, need!(id, "page_id", u64))
}

fn remove_client(tx: &mut dyn KvWrite, id: &Identity, _: Mode) -> Result<bool> {
    crate::jobs::remove_client(tx, need!(id, "client_id"))
}
