//! Identity, link and access state: entity identity groups, link relationship state and dated transitions, fact purge
//! tombstones and bearer tokens. Each table has a Rust family on master; the importers store the primary's rows through the
//! family's own keys.
//!
//! `access_tokens` rows carry `token_hash`, the stored hash of a bearer token. The importer keeps exactly what the family
//! keeps, never puts a value in a message or a loss, and leaves the hash out of the digest identity.

use super::decode::Row;
use super::{
    Column::{Kept, Unmapped},
    Losses, Outcome, Relation, require_page, require_source,
};
use crate::entity_identities::{self, IdentityRecord};
use crate::error::{Result, StoreError};
use crate::jobs::{self, TokenRecord};
use crate::kv::KvWrite;
use crate::link_queries::link_temporal::{self, RelationshipRecord, TransitionRecord};

/// In import order: every relation names pages or sources, which the core group stores first.
pub(super) const RELATIONS: &[(&str, &Relation)] = &[
    ("entity_identities", &ENTITY_IDENTITIES),
    ("link_relationships", &LINK_RELATIONSHIPS),
    ("link_transitions", &LINK_TRANSITIONS),
    ("fact_purges", &FACT_PURGES),
    ("access_tokens", &ACCESS_TOKENS),
];

fn stored(stored: bool) -> Outcome {
    if stored {
        Outcome::Imported
    } else {
        Outcome::Skipped
    }
}

fn need<T>(row: &Row, col: &str, value: Option<T>) -> Result<T> {
    value.ok_or_else(|| StoreError::invalid(format!("seed {}.{col}: is NULL", row.relation)))
}

// ---- entity_identities ---------------------------------------------------------------------

static ENTITY_IDENTITIES: Relation = Relation {
    key: &["id"],
    columns: &[
        // The store keys a membership by its page: the serial id is not kept.
        ("id", Unmapped(None)),
        ("entity_id", Kept),
        ("source_id", Kept),
        ("page_id", Kept),
        ("confidence", Kept),
        ("established_by", Kept),
        ("established_at", Kept),
        ("canonical", Kept),
    ],
    import: import_identity,
};

fn import_identity(tx: &mut dyn KvWrite, row: &Row, _: &mut Losses) -> Result<Outcome> {
    let page_id = row.req_id("page_id")?;
    require_page(&*tx, page_id)?;
    let record = IdentityRecord {
        entity_id: row.req("entity_id")?,
        source_id: row.req("source_id")?,
        confidence: need(row, "confidence", row.f64("confidence")?)?,
        established_by: row.text_or("established_by", "manual"),
        established_at_us: row.req_ts("established_at")?,
        canonical: row.bool("canonical")?.unwrap_or(false),
    };
    Ok(stored(entity_identities::seed_identity(
        tx, page_id, &record,
    )?))
}

// ---- link_relationships --------------------------------------------------------------------

static LINK_RELATIONSHIPS: Relation = Relation {
    key: &["from_page_id", "to_page_id", "link_type", "scope"],
    columns: &[
        ("from_page_id", Kept),
        ("to_page_id", Kept),
        ("link_type", Kept),
        ("scope", Kept),
        ("source_id", Kept),
        ("semantics", Kept),
        ("valid_ranges", Kept),
        ("status_now", Kept),
        ("first_start", Kept),
        ("last_start", Kept),
        ("last_end", Kept),
        ("undated_present", Kept),
        ("undated_past", Kept),
        ("disputed", Kept),
        ("recorded_at", Kept),
        ("retired_at", Kept),
        ("evidence_hash", Kept),
        ("refreshed_at", Kept),
    ],
    import: import_relationship,
};

fn import_relationship(tx: &mut dyn KvWrite, row: &Row, _: &mut Losses) -> Result<Outcome> {
    let from = require_page(&*tx, row.req_id("from_page_id")?)?;
    require_page(&*tx, row.req_id("to_page_id")?)?;
    let record = RelationshipRecord {
        from_page_id: from.id,
        to_page_id: row.req_id("to_page_id")?,
        link_type: row.req("link_type")?,
        scope: row.req("scope")?,
        source_id: row.req("source_id")?,
        semantics: row.req("semantics")?,
        valid_ranges: row.req("valid_ranges")?,
        status_now: row.req("status_now")?,
        first_start: row.date("first_start")?,
        last_start: row.date("last_start")?,
        last_end: row.date("last_end")?,
        undated_present: row.i64("undated_present")?.unwrap_or(0),
        undated_past: row.i64("undated_past")?.unwrap_or(0),
        disputed: row.bool("disputed")?.unwrap_or(false),
        recorded_at_us: row.req_ts("recorded_at")?,
        retired_at_us: row.ts("retired_at")?,
        evidence_hash: row.req("evidence_hash")?,
        refreshed_at_us: row.req_ts("refreshed_at")?,
    };
    Ok(stored(link_temporal::seed_relationship(
        tx,
        &from.source_id,
        &record,
    )?))
}

// ---- link_transitions ----------------------------------------------------------------------

static LINK_TRANSITIONS: Relation = Relation {
    key: &["id"],
    columns: &[
        ("id", Kept),
        ("source_id", Kept),
        ("from_page_id", Kept),
        ("to_page_id", Kept),
        ("link_type", Kept),
        ("kind", Kept),
        ("occurred_on", Kept),
        ("date_precision", Kept),
        ("producer", Kept),
        ("origin_page_id", Kept),
        ("line_hash", Kept),
        ("created_at", Kept),
        ("link_source", Kept),
    ],
    import: import_transition,
};

fn import_transition(tx: &mut dyn KvWrite, row: &Row, _: &mut Losses) -> Result<Outcome> {
    require_page(&*tx, row.req_id("from_page_id")?)?;
    require_page(&*tx, row.req_id("to_page_id")?)?;
    let origin_page_id = row.id("origin_page_id")?;
    if let Some(origin) = origin_page_id {
        require_page(&*tx, origin)?;
    }
    let record = TransitionRecord {
        id: row.req_id("id")?,
        source_id: row.req("source_id")?,
        from_page_id: row.req_id("from_page_id")?,
        to_page_id: row.req_id("to_page_id")?,
        link_type: row.req("link_type")?,
        kind: row.req("kind")?,
        occurred_on: need(row, "occurred_on", row.date("occurred_on")?)?,
        date_precision: row.text_or("date_precision", "day"),
        producer: row.req("producer")?,
        origin_page_id,
        line_hash: row.text_or("line_hash", ""),
        link_source: row.text("link_source"),
        created_at_us: row.req_ts("created_at")?,
    };
    Ok(stored(link_temporal::seed_transition(tx, &record)?))
}

// ---- fact_purges ---------------------------------------------------------------------------

static FACT_PURGES: Relation = Relation {
    key: &["source_id", "visibility", "subject", "fact_hash"],
    columns: &[
        ("source_id", Kept),
        ("visibility", Kept),
        ("subject", Kept),
        ("fact_hash", Kept),
        ("request_id", Kept),
        ("actor", Kept),
        ("reason", Kept),
        ("purged_at", Kept),
    ],
    import: import_fact_purge,
};

fn import_fact_purge(tx: &mut dyn KvWrite, row: &Row, _: &mut Losses) -> Result<Outcome> {
    let source = row.req("source_id")?;
    require_source(&*tx, &source)?;
    Ok(stored(crate::facts::purge_ledger::seed_fact_purge(
        tx,
        [
            &source,
            &row.req("visibility")?,
            &row.text_or("subject", "*"),
            &row.req("fact_hash")?,
        ],
        row.text("request_id").map(|id| id.to_lowercase()),
        (row.text("actor"), row.text("reason")),
        row.req_ts("purged_at")?,
    )?))
}

// ---- access_tokens -------------------------------------------------------------------------

static ACCESS_TOKENS: Relation = Relation {
    key: &["id"],
    columns: &[
        ("id", Kept),
        ("name", Kept),
        ("token_hash", Kept),
        ("scopes", Kept),
        ("created_at", Kept),
        ("last_used_at", Kept),
        ("revoked_at", Kept),
        ("permissions", Kept),
        ("source_grant", Kept),
        ("source_id", Kept),
        ("federated_read", Kept),
        ("allowed_operations", Kept),
        ("takes_holders", Kept),
        ("grant_revision", Kept),
        ("min_trust", Kept),
        ("private_pages", Kept),
        ("private_facts", Kept),
        ("member_id", Kept),
        ("may_act_for", Kept),
        ("attest_actor", Kept),
        ("attest_ops", Kept),
        ("attest_sources", Kept),
        ("attest_read", Kept),
        ("reads_unscoped", Kept),
        ("read_shared_revision", Kept),
    ],
    import: import_token,
};

/// The row as the family keeps it. A token with no `created_at` (the column is nullable) is stored at time 0 and counted
/// as `token_without_created_at`. No error or loss names a value of the row: `token_hash` stays out of every message.
fn import_token(tx: &mut dyn KvWrite, row: &Row, losses: &mut Losses) -> Result<Outcome> {
    let created_at = match row.ts("created_at")? {
        Some(at) => at,
        None => {
            losses.add("token_without_created_at");
            0
        }
    };
    let record = TokenRecord {
        id: row.req("id")?,
        name: row.req("name")?,
        token_hash: row.req("token_hash")?,
        scopes: row.text_array("scopes")?,
        permissions: crate::jsonb::order(need(row, "permissions", row.json("permissions")?)?),
        source_grant: row.text("source_grant"),
        source_id: row.text("source_id"),
        federated_read: row.text_array("federated_read")?,
        allowed_operations: row.text_array("allowed_operations")?,
        takes_holders: row.text_array("takes_holders")?,
        grant_revision: row.i32("grant_revision")?.unwrap_or(0),
        read_shared_revision: row.i32("read_shared_revision")?,
        min_trust: row.text("min_trust"),
        revoked_at: row.ts("revoked_at")?,
        created_at,
        last_used_at: row.ts("last_used_at")?,
        member_id: row.text("member_id"),
        may_act_for: row.text_array("may_act_for")?,
        attest_actor: row.text("attest_actor"),
        attest_ops: row.text_array("attest_ops")?,
        attest_sources: row.text_array("attest_sources")?,
        attest_read: row.text("attest_read"),
        reads_unscoped: row.ts("reads_unscoped")?,
        private_pages: row.text_or("private_pages", "none"),
        private_facts: row.text_or("private_facts", "none"),
    };
    Ok(stored(jobs::seed_token(tx, &record)?))
}

#[cfg(test)]
mod tests;
