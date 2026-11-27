//! Privacy state: owner-only marks, rename history, fact withdrawals, page purges and the spend
//! columns of OAuth clients.

use super::decode::Row;
use super::{
    Column::{Kept, Unmapped},
    Losses, Outcome, Relation, raise_counter, require_source,
};
use crate::error::Result;
use crate::kv::KvWrite;

/// In import order.
pub(super) const RELATIONS: &[(&str, &Relation)] = &[
    ("owner_only_marks", &OWNER_ONLY_MARKS),
    ("slug_rename_history", &SLUG_RENAME_HISTORY),
    ("fact_withdrawals", &FACT_WITHDRAWALS),
    ("page_purges", &PAGE_PURGES),
    ("oauth_clients", &OAUTH_CLIENTS),
    ("guest_sources", &GUEST_SOURCES),
];

/// Maps the family's "newly stored" answer to the row's outcome.
fn stored(stored: bool) -> Outcome {
    if stored {
        Outcome::Imported
    } else {
        Outcome::Skipped
    }
}

// ---- owner_only_marks ----------------------------------------------------------------------

static OWNER_ONLY_MARKS: Relation = Relation {
    key: &["row_table", "row_id"],
    columns: &[
        ("row_table", Kept),
        ("row_id", Kept),
        ("marked_at", Unmapped(None)),
    ],
    import: import_owner_only_mark,
};

/// The store marks pages only (`M owner_only_mark/pages/<id>`): a mark of any other table is dropped
/// as `owner_only_mark_not_a_page`. The mark's time is not kept.
fn import_owner_only_mark(tx: &mut dyn KvWrite, row: &Row, _: &mut Losses) -> Result<Outcome> {
    if row.req("row_table")? != "pages" {
        return Ok(Outcome::Dropped("owner_only_mark_not_a_page"));
    }
    let id = row.req_id("row_id")?;
    // A mark outlives its page, so its id can exceed every surviving page: the store must never hand that id to a new page.
    raise_counter(tx, crate::pages::NEXT_PAGE_ID, id)?;
    Ok(stored(crate::owner_only_marks::seed_mark(tx, id)?))
}

// ---- slug_rename_history -------------------------------------------------------------------

static SLUG_RENAME_HISTORY: Relation = Relation {
    key: &["source_id", "old_slug", "new_slug"],
    columns: &[
        ("source_id", Kept),
        ("old_slug", Kept),
        ("new_slug", Kept),
        ("created_at", Unmapped(None)),
    ],
    import: import_slug_rename,
};

fn import_slug_rename(tx: &mut dyn KvWrite, row: &Row, _: &mut Losses) -> Result<Outcome> {
    let source = row.req("source_id")?;
    require_source(&*tx, &source)?;
    Ok(stored(crate::aliases::seed_rename(
        tx,
        &source,
        &row.req("old_slug")?,
        &row.req("new_slug")?,
    )?))
}

// ---- fact_withdrawals ----------------------------------------------------------------------

static FACT_WITHDRAWALS: Relation = Relation {
    key: &["source_id", "visibility", "subject", "fact_hash"],
    columns: &[
        ("source_id", Kept),
        ("visibility", Kept),
        ("subject", Kept),
        ("fact_hash", Kept),
        ("withdrawn_at", Kept),
    ],
    import: import_fact_withdrawal,
};

/// The primary's `fact_hash` and `withdrawn_at` are stored as given.
fn import_fact_withdrawal(tx: &mut dyn KvWrite, row: &Row, _: &mut Losses) -> Result<Outcome> {
    let source = row.req("source_id")?;
    require_source(&*tx, &source)?;
    Ok(stored(crate::trust::withdrawals::seed_withdrawal(
        tx,
        [
            &source,
            &row.req("visibility")?,
            &row.text_or("subject", "*"),
            &row.req("fact_hash")?,
        ],
        row.req_ts("withdrawn_at")?,
    )?))
}

// ---- page_purges ---------------------------------------------------------------------------

static PAGE_PURGES: Relation = Relation {
    key: &["source_id", "content_hash"],
    columns: &[
        ("source_id", Kept),
        ("content_hash", Kept),
        ("slug", Kept),
        ("request_id", Kept),
        ("purged_at", Kept),
    ],
    import: import_page_purge,
};

fn import_page_purge(tx: &mut dyn KvWrite, row: &Row, _: &mut Losses) -> Result<Outcome> {
    let source = row.req("source_id")?;
    require_source(&*tx, &source)?;
    Ok(stored(crate::facts::seed_purge(
        tx,
        &source,
        &row.req("content_hash")?,
        (
            &row.req("slug")?,
            row.value("request_id"),
            row.req_ts("purged_at")?,
        ),
    )?))
}

// ---- oauth_clients -------------------------------------------------------------------------

static OAUTH_CLIENTS: Relation = Relation {
    key: &["client_id"],
    columns: &[
        ("client_id", Kept),
        ("client_name", Kept),
        ("scope", Kept),
        ("bound_tools", Kept),
        ("budget_usd_per_day", Kept),
        ("deleted_at", Kept),
        // The store keeps only the spend columns of a client.
        ("client_secret_hash", Unmapped(None)),
        ("redirect_uris", Unmapped(None)),
        ("grant_types", Unmapped(Some("{client_credentials}"))),
        ("token_endpoint_auth_method", Unmapped(None)),
        ("client_id_issued_at", Unmapped(None)),
        ("client_secret_expires_at", Unmapped(None)),
        ("token_ttl", Unmapped(None)),
        ("source_id", Unmapped(None)),
        ("federated_read", Unmapped(Some("{}"))),
        ("bound_source_id", Unmapped(None)),
        ("bound_brain_id", Unmapped(None)),
        ("bound_slug_prefixes", Unmapped(None)),
        ("bound_max_concurrent", Unmapped(Some("1"))),
        ("surface", Unmapped(None)),
        ("surface_set_by", Unmapped(None)),
        ("allowed_operations", Unmapped(None)),
        ("delegated_slug_prefixes", Unmapped(None)),
        ("delegated_namespace", Unmapped(Some("prefixes"))),
        ("grant_profile", Unmapped(None)),
        ("grant_revision", Unmapped(Some("0"))),
        ("grant_repair_reasons", Unmapped(Some("{}"))),
        ("created_at", Unmapped(None)),
        ("source_grant", Unmapped(None)),
        ("takes_holders", Unmapped(None)),
        ("private_pages", Unmapped(Some("none"))),
        ("private_facts", Unmapped(Some("none"))),
        ("registered_via", Unmapped(None)),
        ("reads_unscoped", Unmapped(None)),
        ("attest_read", Unmapped(None)),
        ("attest_actor", Unmapped(None)),
        ("attest_ops", Unmapped(None)),
        ("attest_sources", Unmapped(None)),
        ("member_id", Unmapped(None)),
        ("may_act_for", Unmapped(None)),
        ("read_shared_revision", Unmapped(None)),
    ],
    import: import_oauth_client,
};

fn import_oauth_client(tx: &mut dyn KvWrite, row: &Row, _: &mut Losses) -> Result<Outcome> {
    Ok(stored(crate::jobs::seed_client(
        tx,
        (
            &row.req("client_id")?,
            &row.req("client_name")?,
            row.value("scope"),
        ),
        row.text_array("bound_tools")?,
        row.f64("budget_usd_per_day")?,
        row.ts("deleted_at")?,
    )?))
}

#[cfg(test)]
mod tests;

// ---- guest_sources -------------------------------------------------------------------------

static GUEST_SOURCES: Relation = Relation {
    key: &["source_id"],
    columns: &[
        ("source_id", Kept),
        ("writers", Kept),
        ("trust_ceiling", Kept),
        ("created_at", Unmapped(None)),
    ],
    import: import_guest_source,
};

/// A guest source's record (guest_sources.rs), its writers in the primary's order. Imported after the pages, so the
/// trust stamp's guest rules never refuse the seed's own page rows. The row's time is not kept.
fn import_guest_source(tx: &mut dyn KvWrite, row: &Row, _: &mut Losses) -> Result<Outcome> {
    let source = row.req("source_id")?;
    require_source(&*tx, &source)?;
    let writers = row.text_array("writers")?.unwrap_or_default();
    let ceiling = row.req("trust_ceiling")?;
    Ok(stored(crate::guest_sources::seed_row(
        tx, &source, writers, ceiling,
    )?))
}
