//! The store's keyspace catalog: every top-level key tag of `keys.rs`, the family that owns it,
//! and, for the families whose byte after the tag names a record kind, those kinds. It answers
//! `listCatalogRelations` on the Rust engine, where a SQL engine reads `pg_class`: what kinds of
//! record this store keeps, not what a brain holds. It changes only when `keys.rs` or a family's
//! kind bytes change, and the tests below fail when it drifts from them.

use serde::Serialize;

use crate::{FORMAT_VERSION, keys};

/// One record kind: the byte after the tag, and the record it names.
#[derive(Debug, Clone, Copy, Serialize)]
pub struct KeyKind {
    pub kind: u8,
    pub name: &'static str,
}

/// One top-level key tag.
#[derive(Debug, Clone, Copy, Serialize)]
pub struct Keyspace {
    /// The tag byte, as its one ASCII character.
    #[serde(serialize_with = "tag_char")]
    pub tag: u8,
    /// The family that owns every byte after the tag.
    pub family: &'static str,
    /// What the records under the tag are.
    pub records: &'static str,
    /// The record kinds named by the byte after the tag; empty when the family does not use one.
    pub kinds: &'static [KeyKind],
}

fn tag_char<S: serde::Serializer>(tag: &u8, s: S) -> std::result::Result<S::Ok, S::Error> {
    s.serialize_str(&char::from(*tag).to_string())
}

const fn k(kind: u8, name: &'static str) -> KeyKind {
    KeyKind { kind, name }
}

const fn ks(tag: u8, family: &'static str, records: &'static str) -> Keyspace {
    Keyspace {
        tag,
        family,
        records,
        kinds: &[],
    }
}

/// The `takes` family's kind bytes (`takes.rs`, `takes/*.rs`, `extract_bookkeeping.rs`).
pub const TAKE_KINDS: &[KeyKind] = &[
    k(0x01, "take"),
    k(0x02, "take_by_row"),
    k(0x03, "take_evidence"),
    k(0x04, "take_cited"),
    k(0x05, "take_grade"),
    k(0x06, "take_horizon"),
    k(0x07, "take_nudge"),
    k(0x08, "take_proposal"),
    k(0x09, "take_proposal_idempotency"),
    k(0x0A, "extract_rollup_day"),
];

/// The `telemetry` family's sub-tags (`keys::TELEMETRY_*`), one per table.
pub const TELEMETRY_KINDS: &[KeyKind] = &[
    k(keys::TELEMETRY_SEARCH, "search_telemetry"),
    k(keys::TELEMETRY_MCP_REQUEST, "mcp_request_log"),
    k(keys::TELEMETRY_MCP_ROLLUP, "mcp_request_log_rollup"),
    k(keys::TELEMETRY_RETRIEVAL_EVENT, "retrieval_events"),
    k(
        keys::TELEMETRY_RETRIEVAL_EVENT_PAGE,
        "retrieval_event_pages",
    ),
    k(
        keys::TELEMETRY_RETRIEVAL_EVENT_LINK,
        "retrieval_event_links",
    ),
    k(keys::TELEMETRY_FEEDBACK, "retrieval_feedback"),
    k(keys::TELEMETRY_RETRIEVAL_WEIGHT, "retrieval_weights"),
    k(keys::TELEMETRY_BUDGET_LEDGER, "budget_ledger"),
    k(keys::TELEMETRY_BUDGET_RESERVATION, "budget_reservations"),
    k(keys::TELEMETRY_CHAT_USAGE, "chat_usage_log"),
];

/// The `keyword` family's kind bytes (`keys::KW_*`).
pub const KEYWORD_KINDS: &[KeyKind] = &[
    k(keys::KW_STATE, "keyword_index_state"),
    k(keys::KW_CHUNK_POSTING, "keyword_chunk_posting"),
    k(keys::KW_PAGE_POSTING, "keyword_page_posting"),
    k(keys::KW_TITLE_TRIGRAM, "keyword_title_trigram"),
    k(keys::KW_BASENAME, "keyword_slug_basename"),
    k(keys::KW_CHUNK_FORWARD, "keyword_chunk_forward"),
    k(keys::KW_PAGE_FORWARD, "keyword_page_forward"),
    k(keys::KW_CHUNK_PENDING, "keyword_chunk_pending"),
    k(keys::KW_PAGE_PENDING, "keyword_page_pending"),
    k(keys::KW_PENDING_COUNT, "keyword_pending_count"),
];

/// Every top-level tag, in tag-byte order. The tags `keys.rs` lists first, with no family
/// comment, belong to the core store (`pages.rs`, `chunks.rs`, `journal.rs` and the rest of the
/// core work); they are listed under the family `core`.
pub const KEYSPACES: &[Keyspace] = &[
    ks(
        keys::GUEST_SOURCE,
        "guest_sources",
        "guest sources: writers and trust ceiling",
    ),
    ks(
        keys::REASON_TOMBSTONE,
        "reason_tombstones",
        "purged change reasons",
    ),
    ks(
        keys::SECRET_STORE,
        "secret_store",
        "secret store entries and occurrences",
    ),
    Keyspace {
        tag: keys::TAKE,
        family: "takes",
        records: "takes and their records",
        kinds: TAKE_KINDS,
    },
    ks(keys::EMBEDDING_STATE, "embeddings", "embedding state"),
    ks(keys::CONFIG, "core", "config rows"),
    ks(keys::TIMELINE_DEDUP, "core", "timeline dedup keys"),
    ks(keys::TIMELINE, "core", "timeline entries"),
    ks(keys::FACT, "facts", "facts"),
    ks(
        keys::TIMELINE_LATEST,
        "core",
        "latest timeline entry per page",
    ),
    ks(keys::CODE_EDGE, "code_edges", "code edges"),
    ks(keys::PAGE_ID, "core", "page id index"),
    ks(keys::REQUEST, "core", "write requests"),
    ks(keys::CHUNK, "core", "chunks"),
    ks(keys::LINK, "core", "links by origin page"),
    ks(keys::META, "core", "store metadata"),
    ks(keys::ONTOLOGY, "ontology", "ontology rows"),
    ks(keys::LINK_ORIGIN, "core", "link origin index"),
    ks(keys::PAGE, "core", "pages"),
    ks(
        keys::CONTRADICTIONS,
        "contradictions",
        "contradiction findings",
    ),
    Keyspace {
        tag: keys::TRIGRAM,
        family: "keyword",
        records: "keyword index",
        kinds: KEYWORD_KINDS,
    },
    ks(keys::SOURCE, "core", "sources"),
    ks(keys::POSTING, "core", "search postings"),
    ks(keys::LINK_UNIQUE, "core", "link uniqueness index"),
    ks(keys::VERSION, "core", "page versions"),
    ks(keys::WRITER, "core", "local writers"),
    ks(keys::VECTOR, "vectors", "vectors"),
    ks(keys::DREAM_VERDICT, "dream", "dream verdicts"),
    ks(keys::EVAL_CAPTURE, "eval_capture", "eval capture rows"),
    Keyspace {
        tag: keys::TELEMETRY,
        family: "telemetry",
        records: "telemetry tables",
        kinds: TELEMETRY_KINDS,
    },
    ks(keys::PAGE_BODY, "page_body", "page bodies"),
    ks(keys::CHUNK_QUERIES, "chunk_queries", "chunk query state"),
    ks(
        keys::PERSISTENCE,
        "persistence",
        "effects, checkpoints, bindings and the projection queue",
    ),
    ks(keys::EXTRACTION, "extraction", "extraction state"),
    ks(
        keys::DREAM_SYNTHESIS_COMPLETION,
        "jobs",
        "dream synthesis completions",
    ),
    ks(
        keys::CODE_TRAVERSAL_CACHE,
        "code_edges",
        "code traversal cache",
    ),
    ks(
        keys::DERIVED_GENERATION,
        "generations",
        "derived generation ledger",
    ),
    ks(
        keys::ENTITY_IDENTITY,
        "entity_identities",
        "entity identity groups",
    ),
    ks(keys::REQUEST_ID, "core", "write request id index"),
    ks(keys::ALIAS, "aliases", "slug aliases"),
    ks(keys::LINK_TO, "core", "links by target page"),
    ks(keys::JOBS, "jobs", "jobs"),
    ks(keys::INGEST_LOG, "stats", "ingest log"),
    ks(keys::PAGE_ORIGIN, "core", "page origins"),
    ks(keys::PAGE_OPS, "page_ops", "page op state"),
    ks(keys::LINK_QUERIES, "link_queries", "link query state"),
    ks(keys::RAW_FILES, "raw_files", "raw files"),
    ks(keys::SALIENCE, "salience", "salience scores"),
    ks(keys::TRUST, "trust", "trust state"),
    ks(
        keys::TIMELINE_QUERIES,
        "timeline_queries",
        "timeline query state",
    ),
    ks(keys::RELATION_CATALOG, "relations", "relation catalog"),
    ks(keys::LOCK_QUEUE, "transactions", "lock queue"),
    ks(
        keys::ACCESS_MEMBERS,
        "access_members",
        "access members, groups, group members and member links",
    ),
    ks(
        keys::SESSION_STATE,
        "session_state",
        "session context state",
    ),
    ks(keys::ACCESS_RULES, "access_rules", "folder access rules"),
    ks(
        keys::FAMILY_ESCAPE,
        "family_escape",
        "the escape byte of every two-byte family tag",
    ),
];

/// The catalog the addon returns: the store format it describes and every keyspace.
#[derive(Debug, Clone, Serialize)]
pub struct KeyspaceCatalog {
    pub format_version: u32,
    pub keyspaces: &'static [Keyspace],
}

pub fn keyspace_catalog() -> KeyspaceCatalog {
    KeyspaceCatalog {
        format_version: FORMAT_VERSION,
        keyspaces: KEYSPACES,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    /// Every `pub const NAME: u8 = b'x';` of keys.rs: the top-level tags.
    fn tags_in_keys_rs() -> BTreeSet<u8> {
        include_str!("keys.rs")
            .lines()
            .filter_map(|line| {
                let rest = line.trim().strip_prefix("pub const ")?;
                let (_, value) = rest.split_once(": u8 = b'")?;
                value.bytes().next()
            })
            .collect()
    }

    #[test]
    fn every_tag_of_keys_rs_is_listed_once_in_byte_order() {
        let listed: Vec<u8> = KEYSPACES.iter().map(|k| k.tag).collect();
        let mut sorted = listed.clone();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(
            listed, sorted,
            "KEYSPACES is not in tag-byte order or lists a tag twice"
        );
        assert_eq!(
            listed.into_iter().collect::<BTreeSet<_>>(),
            tags_in_keys_rs()
        );
    }

    #[test]
    fn take_kinds_match_the_families_kind_bytes() {
        let sources = [
            include_str!("takes.rs"),
            include_str!("takes/grades.rs"),
            include_str!("takes/horizons.rs"),
            include_str!("takes/nudges.rs"),
            include_str!("takes/proposals.rs"),
            include_str!("extract_bookkeeping.rs"),
        ]
        .concat();
        for (name, byte) in [
            ("TAKE", 0x01u8),
            ("BY_ROW", 0x02),
            ("EVIDENCE", 0x03),
            ("CITED", 0x04),
            ("GRADE", 0x05),
            ("HORIZON", 0x06),
            ("NUDGE", 0x07),
            ("PROPOSAL", 0x08),
            ("IDEMPOTENCY", 0x09),
            ("ROLLUP_DAY", 0x0A),
        ] {
            let decl = format!("const {name}: u8 = 0x{byte:02X};");
            assert!(sources.contains(&decl), "no `{decl}` in the takes family");
            assert!(
                TAKE_KINDS.iter().any(|k| k.kind == byte),
                "TAKE_KINDS lacks 0x{byte:02X}"
            );
        }
        assert_eq!(TAKE_KINDS.len(), 10);
    }

    #[test]
    fn kinds_are_unique_within_a_tag() {
        for space in KEYSPACES {
            let bytes: BTreeSet<u8> = space.kinds.iter().map(|k| k.kind).collect();
            assert_eq!(
                bytes.len(),
                space.kinds.len(),
                "tag {} repeats a kind",
                char::from(space.tag)
            );
        }
    }

    #[test]
    fn the_catalog_serializes_tags_as_characters() {
        let json = serde_json::to_value(keyspace_catalog()).unwrap();
        assert_eq!(json["format_version"], FORMAT_VERSION);
        assert_eq!(json["keyspaces"].as_array().unwrap().len(), KEYSPACES.len());
        assert!(
            json["keyspaces"]
                .as_array()
                .unwrap()
                .iter()
                .any(|k| k["tag"] == "A" && k["kinds"].as_array().unwrap().len() == 10)
        );
    }
}
