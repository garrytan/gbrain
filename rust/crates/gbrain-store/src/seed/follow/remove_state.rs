//! The follow spec of the identity, link, purge and token relations.
//!
//! `access_tokens` keeps only its id in the digest identity: the token hash is the family's unique key, but the digest
//! entry never holds it, so a hash is stored once, in the token record. A second token with a stored hash is refused by the
//! importer (`constraint_violation`) and the batch fails.

use super::remove_core::need;
use super::{Follow, Identity, Mode, Replace, number, text};
use crate::error::Result;
use crate::kv::KvWrite;

const fn follow(
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
    (
        "entity_identities",
        follow(
            &["id", "page_id", "entity_id", "source_id"],
            &[&["source_id", "page_id"]],
            remove_identity,
        ),
    ),
    (
        "link_relationships",
        follow(
            &["from_page_id", "to_page_id", "link_type", "scope"],
            &[],
            remove_relationship,
        ),
    ),
    (
        "link_transitions",
        follow(
            &[
                "id",
                "source_id",
                "from_page_id",
                "to_page_id",
                "link_type",
                "kind",
                "occurred_on",
                "producer",
                "origin_page_id",
                "link_source",
            ],
            &[&[
                "origin_page_id",
                "from_page_id",
                "to_page_id",
                "link_type",
                "link_source",
                "kind",
                "occurred_on",
                "producer",
            ]],
            remove_transition,
        ),
    ),
    (
        "fact_purges",
        follow(
            &["source_id", "visibility", "subject", "fact_hash"],
            &[],
            remove_fact_purge,
        ),
    ),
    ("access_tokens", follow(&["id"], &[], remove_token)),
];

fn remove_identity(tx: &mut dyn KvWrite, id: &Identity, _: Mode) -> Result<bool> {
    crate::entity_identities::remove_identity(tx, need!(id, "page_id", u64), need!(id, "entity_id"))
}

fn remove_relationship(tx: &mut dyn KvWrite, id: &Identity, _: Mode) -> Result<bool> {
    crate::link_queries::link_temporal::remove_relationship(
        tx,
        need!(id, "from_page_id", u64),
        need!(id, "to_page_id", u64),
        need!(id, "link_type"),
        need!(id, "scope"),
    )
}

fn remove_transition(tx: &mut dyn KvWrite, id: &Identity, _: Mode) -> Result<bool> {
    crate::link_queries::link_temporal::remove_transition(
        tx,
        need!(id, "source_id"),
        (
            need!(id, "from_page_id", u64),
            need!(id, "to_page_id", u64),
            need!(id, "link_type"),
        ),
        need!(id, "id", u64),
    )
}

fn remove_fact_purge(tx: &mut dyn KvWrite, id: &Identity, _: Mode) -> Result<bool> {
    crate::facts::purge_ledger::remove_fact_purge(
        tx,
        [
            need!(id, "source_id"),
            need!(id, "visibility"),
            need!(id, "subject"),
            need!(id, "fact_hash"),
        ],
    )
}

fn remove_token(tx: &mut dyn KvWrite, id: &Identity, _: Mode) -> Result<bool> {
    crate::jobs::remove_token(tx, need!(id, "id"))
}
