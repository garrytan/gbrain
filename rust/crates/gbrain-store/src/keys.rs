//! The key layout. One byte of tag, then the parts of the key. Parts that are text never contain
//! NUL (callers' text is checked on the way in), so NUL separates parts without ambiguity, and
//! numbers are big-endian so byte order is numeric order.

pub const META: u8 = b'M';
pub const CONFIG: u8 = b'C';
pub const SOURCE: u8 = b'S';
pub const PAGE: u8 = b'P';
pub const PAGE_ID: u8 = b'I';
pub const CHUNK: u8 = b'K';
pub const POSTING: u8 = b'T';
pub const VERSION: u8 = b'V';
pub const REQUEST: u8 = b'J';
pub const REQUEST_ID: u8 = b'j';
pub const WRITER: u8 = b'W';
pub const LINK: u8 = b'L';
pub const LINK_TO: u8 = b'l';
pub const LINK_UNIQUE: u8 = b'U';
pub const LINK_ORIGIN: u8 = b'O';
pub const TIMELINE: u8 = b'E';
pub const TIMELINE_DEDUP: u8 = b'D';
pub const TIMELINE_LATEST: u8 = b'G';
pub const PAGE_ORIGIN: u8 = b'o';

// Reserved, one byte per planned family (docs/designs/RUST_ENGINE_INTERFACES.md, "Key layout").
// The family's module owns every byte after its tag. Never reuse, reorder or repurpose a byte;
// a family that is not listed here takes an unused byte in a reviewed change to this list.
/// Family `page_ops` (`page_ops.rs`).
pub const PAGE_OPS: u8 = b'p';
/// Family `extraction` (`extraction.rs`).
pub const EXTRACTION: u8 = b'e';
/// Family `aliases` (`aliases.rs`).
pub const ALIAS: u8 = b'k';
/// Family `page_body` (`page_body.rs`).
pub const PAGE_BODY: u8 = b'b';
/// Family `facts` (`facts.rs`).
pub const FACT: u8 = b'F';
/// Family `ontology` (`ontology.rs`).
pub const ONTOLOGY: u8 = b'N';
/// Family `takes` (`takes.rs`).
pub const TAKE: u8 = b'A';
/// Family `contradictions` (`contradictions.rs`).
pub const CONTRADICTIONS: u8 = b'Q';
/// Family `dream` (`dream.rs`).
pub const DREAM_VERDICT: u8 = b'Y';
/// Family `eval_capture` (`eval_capture.rs`).
pub const EVAL_CAPTURE: u8 = b'Z';
/// Family `code_edges` (`code_edges.rs`).
pub const CODE_EDGE: u8 = b'H';
/// Family `code_edges`, the `code_traversal_cache` table (`code_edges/traversal_cache.rs`).
pub const CODE_TRAVERSAL_CACHE: u8 = b'g';
/// Family `salience` (`salience.rs`).
pub const SALIENCE: u8 = b's';
/// Family `stats` (`stats.rs`).
pub const INGEST_LOG: u8 = b'n';
/// Family `raw_files` (`raw_files.rs`).
pub const RAW_FILES: u8 = b'r';
/// Family `link_queries` (`link_queries.rs`).
pub const LINK_QUERIES: u8 = b'q';
/// Family `timeline_queries` (`timeline_queries.rs`).
pub const TIMELINE_QUERIES: u8 = b'u';
/// Family `keyword` (`keyword.rs`): the keyword index of store format 4. Kind byte after the tag:
/// `0x00` the index state, `0x01` chunk and `0x02` page lexeme postings, `0x03` title trigrams,
/// `0x04` slug basenames, `0x05` and `0x06` the chunk and page forward records (the `KW_*`
/// constants and builders below; `rust/docs/store/keyword.md`, "Keys").
pub const TRIGRAM: u8 = b'R';
/// Family `chunk_queries` (`chunk_queries.rs`).
pub const CHUNK_QUERIES: u8 = b'c';
/// Family `vectors` (`vectors.rs`).
pub const VECTOR: u8 = b'X';
/// Family `embeddings` (`embeddings.rs`).
pub const EMBEDDING_STATE: u8 = b'B';
/// Family `transactions` (`transactions.rs`).
pub const LOCK_QUEUE: u8 = b'w';
/// Family `relations` (`relations.rs`).
pub const RELATION_CATALOG: u8 = b'v';
/// Family `persistence` (`persistence.rs`): effects, checkpoints, bindings and the page
/// projection queue. Its write requests stay under `REQUEST` and `REQUEST_ID`, and its local
/// writers under `WRITER`. The byte after `d`: `0x01` counters, `0x02` housekeeping
/// checkpoints, `0x03` topology changes, `0x04` page projection jobs, `0x05` to `0x07` effect
/// rows, effect order and operation checkpoint paths, `0x08` the commit notifier
/// (`persistence/notifier.rs`; `d 0x08 0x01 <host_id>` is the host lease).
pub const PERSISTENCE: u8 = b'd';
/// Family `jobs` (`jobs.rs`).
pub const JOBS: u8 = b'm';
/// Family `trust` (`trust.rs`).
pub const TRUST: u8 = b't';
/// Family `telemetry` (`telemetry.rs`): search telemetry, MCP usage, retrieval feedback and the
/// budget ledger. The byte after the tag names the table (`TELEMETRY_*` below).
pub const TELEMETRY: u8 = b'a';
/// `telemetry` sub-tags, one per table. Never reuse, reorder or repurpose one.
pub const TELEMETRY_SEARCH: u8 = 0x01; // search_telemetry
pub const TELEMETRY_MCP_REQUEST: u8 = 0x02; // mcp_request_log
pub const TELEMETRY_MCP_ROLLUP: u8 = 0x03; // mcp_request_log_rollup
pub const TELEMETRY_RETRIEVAL_EVENT: u8 = 0x04; // retrieval_events
pub const TELEMETRY_RETRIEVAL_EVENT_PAGE: u8 = 0x05; // retrieval_event_pages
pub const TELEMETRY_RETRIEVAL_EVENT_LINK: u8 = 0x06; // retrieval_event_links
pub const TELEMETRY_FEEDBACK: u8 = 0x07; // retrieval_feedback
pub const TELEMETRY_RETRIEVAL_WEIGHT: u8 = 0x08; // retrieval_weights
pub const TELEMETRY_BUDGET_LEDGER: u8 = 0x09; // budget_ledger
pub const TELEMETRY_BUDGET_RESERVATION: u8 = 0x0A; // budget_reservations
pub const TELEMETRY_CHAT_USAGE: u8 = 0x0B; // chat_usage_log
pub const TELEMETRY_VOLUNTEER_EVENT: u8 = 0x0C; // context_volunteer_events
pub const TELEMETRY_VOLUNTEER_SEQUENCE: u8 = 0x0D; // the context_volunteer_events id sequence
pub const TELEMETRY_CHRONICLE_ROW: u8 = 0x0E; // chronicle_page_state
pub const TELEMETRY_CHRONICLE_RESERVATION: u8 = 0x0F; // chronicle_judge_reservations
pub const TELEMETRY_CHRONICLE_SEQUENCE: u8 = 0x10; // the chronicle_judge_reservations id sequence
pub const TELEMETRY_ACCESS_READ_LOG: u8 = 0x11; // access_read_log
/// Family `jobs`, the `dream_synthesis_completions` archive (`jobs/synthesis_completions.rs`).
pub const DREAM_SYNTHESIS_COMPLETION: u8 = b'f';
/// Family `entity_identities` (`entity_identities.rs`).
pub const ENTITY_IDENTITY: u8 = b'i';
/// Family `session_state` (`session_state.rs`).
pub const SESSION_STATE: u8 = b'y';
/// Family `persistence_journal`, the `derived_generations` ledger (`generations.rs`).
pub const DERIVED_GENERATION: u8 = b'h';
/// Family access_members (access_members.rs): members 0x01, groups 0x02, group members 0x03, member links 0x04
/// (access_member_links.rs), shared-skill members 0x05, batches 0x06, the token secret 0x0d
/// (shared_skill_members.rs); rust/docs/store/access-members.md lists every sub-tag.
pub const ACCESS_MEMBERS: u8 = b'x';
/// Family `access_rules` (`access_rules.rs`): folder rules, pending prefixes, policy state and
/// revisions. The byte after the tag names the table; the module owns the sub-tags.
pub const ACCESS_RULES: u8 = b'z';
/// Family `reason_tombstones` (`reason_tombstones.rs`): the purged `(commit, path)` pairs of
/// `reason_purge_tombstones`, `1 source \0 commit \0 path`. Every letter is taken, so this family
/// uses a digit; `y` is `SESSION_STATE`.
pub const REASON_TOMBSTONE: u8 = b'1';
// Tag `2` is the commit log's (multi-user mode, `commit_log::COMMIT_LOG`, interface I-4; claimed in the tag
// registry of docs/designs/RUST_ENGINE_INTERFACES.md). It is declared in `commit_log.rs`, not here, so the keyspace
// catalog stays as it is while the mode is off. It once held the `embedding_holds` family, dropped at the main join.
/// Family `secret_store` (`secret_store.rs`): the `secret_store` entries and the `secret_store_occurrence` rows. The byte
/// after the tag names the record (`ENTRY`, `BY_MAC`, `BY_ENTRY`, `OCCURRENCE`, `BY_SLUG`, `BY_PAGE` in that module).
/// The digit `3`: every letter is taken or reserved across the lanes (`x` by `ACCESS_MEMBERS`, `y` by
/// `SESSION_STATE`), and `0` and `1` are `GUEST_SOURCE` and `REASON_TOMBSTONE`; `2` is left free on purpose.
pub const SECRET_STORE: u8 = b'3';

// The one-byte tag space is nearly full (docs/designs/RUST_ENGINE_INTERFACES.md, "Tag registry"). A digit `4`-`9`
// is claimed only through an approved registry row; every later family takes a two-byte tag under `FAMILY_ESCAPE`.
/// The family escape: `~ <family byte>` is a two-byte family tag (`family_tag`), and the family owns every byte
/// after both. `~` (0x7E) sorts after every letter and digit, so the two-byte families sit after the one-byte tags,
/// each in its own contiguous range. No one-byte family ever takes `~`.
pub const FAMILY_ESCAPE: u8 = b'~';

/// Family `leases` (`leases.rs`): leases with epochs, consumer heartbeat rows, per-entity fact sequences, the clock
/// high-water mark and claim epochs of the multi-user build. The byte after the tag names the record (`leases.rs`).
pub const LEASES: [u8; 2] = family_tag(b'L');

/// The two-byte tag of a family under `FAMILY_ESCAPE`. `family` is never `0x00` (the storage adapter's byte).
pub const fn family_tag(family: u8) -> [u8; 2] {
    assert!(family != 0, "a family byte is never 0x00");
    [FAMILY_ESCAPE, family]
}

/// `family_tag`, then `parts` joined by `0x00`, as `text` does after a one-byte tag. With no parts it is the
/// family's scan prefix.
pub fn family_text(tag: [u8; 2], parts: &[&str]) -> Vec<u8> {
    let mut key = tag.to_vec();
    for (i, part) in parts.iter().enumerate() {
        if i > 0 {
            key.push(0);
        }
        key.extend_from_slice(part.as_bytes());
    }
    key
}

pub fn text(tag: u8, parts: &[&str]) -> Vec<u8> {
    let mut key = vec![tag];
    for (i, part) in parts.iter().enumerate() {
        if i > 0 {
            key.push(0);
        }
        key.extend_from_slice(part.as_bytes());
    }
    key
}

pub fn meta(name: &str) -> Vec<u8> {
    text(META, &[name])
}

/// `R 0x00`: the keyword index state (`keyword/index.rs`). Kind byte 0x00 of the `keyword`
/// family; its later kinds are listed in `keyword.rs`.
pub fn keyword_index_state() -> Vec<u8> {
    vec![TRIGRAM, KW_STATE]
}

/// The kind bytes of the keyword index records (`keyword.rs` lists them).
pub const KW_STATE: u8 = 0x00;
pub const KW_CHUNK_POSTING: u8 = 0x01;
pub const KW_PAGE_POSTING: u8 = 0x02;
pub const KW_TITLE_TRIGRAM: u8 = 0x03;
pub const KW_BASENAME: u8 = 0x04;
pub const KW_CHUNK_FORWARD: u8 = 0x05;
pub const KW_PAGE_FORWARD: u8 = 0x06;

/// `R kind len(2) text`: the start of the postings of one lexeme or basename. The length prefix
/// keeps one text's range apart from a longer text that starts with it.
pub fn keyword_term_prefix(kind: u8, term: &[u8]) -> Vec<u8> {
    let len = u16::try_from(term.len()).unwrap_or(u16::MAX);
    let mut key = Vec::with_capacity(4 + term.len() + 12);
    key.extend_from_slice(&[TRIGRAM, kind]);
    key.extend_from_slice(&len.to_be_bytes());
    key.extend_from_slice(term);
    key
}

/// `R 0x01 len(2) lexeme page_id chunk_index`: a chunk's entry for one lexeme.
pub fn chunk_posting(lexeme: &str, page_id: u64, index: u32) -> Vec<u8> {
    let mut key = keyword_term_prefix(KW_CHUNK_POSTING, lexeme.as_bytes());
    key.extend_from_slice(&page_id.to_be_bytes());
    key.extend_from_slice(&index.to_be_bytes());
    key
}

/// `R 0x02 len(2) lexeme page_id`: a page vector's entry for one lexeme.
pub fn page_posting(lexeme: &str, page_id: u64) -> Vec<u8> {
    let mut key = keyword_term_prefix(KW_PAGE_POSTING, lexeme.as_bytes());
    key.extend_from_slice(&page_id.to_be_bytes());
    key
}

/// `R 0x03 len(2) trigram page_id`: a page whose title has the raw pg_trgm trigram (`trgm.rs`).
pub fn title_trigram_posting(trigram: [u8; 3], page_id: u64) -> Vec<u8> {
    let mut key = keyword_term_prefix(KW_TITLE_TRIGRAM, &trigram);
    key.extend_from_slice(&page_id.to_be_bytes());
    key
}

/// `R 0x04 len(2) basename page_id`: a page whose slug ends in `basename`.
pub fn basename_posting(basename: &str, page_id: u64) -> Vec<u8> {
    let mut key = keyword_term_prefix(KW_BASENAME, basename.as_bytes());
    key.extend_from_slice(&page_id.to_be_bytes());
    key
}

/// `R 0x05 page_id chunk_index`: the lexemes a chunk has postings for.
pub fn chunk_forward(page_id: u64, index: u32) -> Vec<u8> {
    let mut key = vec![TRIGRAM, KW_CHUNK_FORWARD];
    key.extend_from_slice(&page_id.to_be_bytes());
    key.extend_from_slice(&index.to_be_bytes());
    key
}

/// `R 0x06 page_id`: the lexemes, title trigrams and basename a page has postings for.
pub fn page_forward(page_id: u64) -> Vec<u8> {
    let mut key = vec![TRIGRAM, KW_PAGE_FORWARD];
    key.extend_from_slice(&page_id.to_be_bytes());
    key
}

/// `P source \0 slug`
pub fn page(source_id: &str, slug: &str) -> Vec<u8> {
    text(PAGE, &[source_id, slug])
}

pub fn page_id(id: u64) -> Vec<u8> {
    let mut key = vec![PAGE_ID];
    key.extend_from_slice(&id.to_be_bytes());
    key
}

/// `K page_id chunk_index`
pub fn chunk(page_id: u64, index: u32) -> Vec<u8> {
    let mut key = chunk_prefix(page_id);
    key.extend_from_slice(&index.to_be_bytes());
    key
}

pub fn chunk_prefix(page_id: u64) -> Vec<u8> {
    let mut key = vec![CHUNK];
    key.extend_from_slice(&page_id.to_be_bytes());
    key
}

/// `T term \0 page_id chunk_index`
pub fn posting(term: &str, page_id: u64, index: u32) -> Vec<u8> {
    let mut key = posting_prefix(term);
    key.extend_from_slice(&page_id.to_be_bytes());
    key.extend_from_slice(&index.to_be_bytes());
    key
}

pub fn posting_prefix(term: &str) -> Vec<u8> {
    let mut key = text(POSTING, &[term]);
    key.push(0);
    key
}

/// `V page_id version`
pub fn version(page_id: u64, version: u64) -> Vec<u8> {
    let mut key = version_prefix(page_id);
    key.extend_from_slice(&version.to_be_bytes());
    key
}

pub fn version_prefix(page_id: u64) -> Vec<u8> {
    let mut key = vec![VERSION];
    key.extend_from_slice(&page_id.to_be_bytes());
    key
}

pub fn be8(bytes: &[u8]) -> Option<u64> {
    Some(u64::from_be_bytes(bytes.try_into().ok()?))
}

pub fn be4(bytes: &[u8]) -> Option<u32> {
    Some(u32::from_be_bytes(bytes.try_into().ok()?))
}

/// `J request-uuid`
pub fn request(id: &str) -> Vec<u8> {
    text(REQUEST, &[id])
}

/// `j principal-kind \0 principal-id \0 request_id`: the idempotency index.
pub fn request_by_principal(kind: &str, principal_id: &str, request_id: &str) -> Vec<u8> {
    text(REQUEST_ID, &[kind, principal_id, request_id])
}

/// `W writer-id`
pub fn writer(id: &str) -> Vec<u8> {
    text(WRITER, &[id])
}

/// `tag id...`: the tag, then each id as 8 big-endian bytes, so byte order is id order.
pub fn id_key(tag: u8, ids: &[u64]) -> Vec<u8> {
    let mut key = vec![tag];
    for id in ids {
        key.extend_from_slice(&id.to_be_bytes());
    }
    key
}

/// `L from_page_id link_id`: the link record, under the page it leaves.
pub fn link(from_page_id: u64, link_id: u64) -> Vec<u8> {
    id_key(LINK, &[from_page_id, link_id])
}

pub fn link_prefix(from_page_id: u64) -> Vec<u8> {
    id_key(LINK, &[from_page_id])
}

/// `l to_page_id link_id` -> `from_page_id`: the links that arrive at a page.
pub fn link_to(to_page_id: u64, link_id: u64) -> Vec<u8> {
    id_key(LINK_TO, &[to_page_id, link_id])
}

pub fn link_to_prefix(to_page_id: u64) -> Vec<u8> {
    id_key(LINK_TO, &[to_page_id])
}

/// `o source \0 origin \0 page_id` -> empty: the live pages of a source that record an origin
/// (`source_path`), as the partial unique index `pages_live_origin_key` holds them. `origin` is
/// the compared form (`pages::origin_key`) and holds no NUL.
pub fn page_origin(source_id: &str, origin: &str, page_id: u64) -> Vec<u8> {
    let mut key = page_origin_prefix(source_id, origin);
    key.extend_from_slice(&page_id.to_be_bytes());
    key
}

pub fn page_origin_prefix(source_id: &str, origin: &str) -> Vec<u8> {
    let mut key = text(PAGE_ORIGIN, &[source_id, origin]);
    key.push(0);
    key
}

/// `O origin_page_id link_id` -> `from_page_id`: the links a page authored.
pub fn link_origin(origin_page_id: u64, link_id: u64) -> Vec<u8> {
    id_key(LINK_ORIGIN, &[origin_page_id, link_id])
}

pub fn link_origin_prefix(origin_page_id: u64) -> Vec<u8> {
    id_key(LINK_ORIGIN, &[origin_page_id])
}

/// `U from to link_type \0 source origin` -> `link_id`: the
/// `UNIQUE NULLS NOT DISTINCT (from_page_id, to_page_id, link_type, link_source, origin_page_id)`
/// constraint. `source` is byte 0 for a NULL `link_source`, else byte 1, the text and `\0`.
/// Origin 0 stands for NULL (page ids start at 1). Neither text holds a NUL.
pub fn link_unique(
    from: u64,
    to: u64,
    link_type: &str,
    link_source: Option<&str>,
    origin: Option<u64>,
) -> Vec<u8> {
    let mut key = id_key(LINK_UNIQUE, &[from, to]);
    key.extend_from_slice(link_type.as_bytes());
    key.push(0);
    match link_source {
        None => key.push(0),
        Some(text) => {
            key.push(1);
            key.extend_from_slice(text.as_bytes());
            key.push(0);
        }
    }
    key.extend_from_slice(&origin.unwrap_or(0).to_be_bytes());
    key
}

/// `E page_id date entry_id`: a timeline entry. `date` is the 10 bytes `YYYY-MM-DD`, so a reverse
/// scan of one page is `ORDER BY date DESC, id DESC`.
pub fn timeline(page_id: u64, date: &str, entry_id: u64) -> Vec<u8> {
    let mut key = timeline_prefix(page_id);
    key.extend_from_slice(date.as_bytes());
    key.extend_from_slice(&entry_id.to_be_bytes());
    key
}

pub fn timeline_prefix(page_id: u64) -> Vec<u8> {
    id_key(TIMELINE, &[page_id])
}

/// `D page_id date sha256(summary) source` -> `entry_id`: the
/// `(page_id, date, md5(summary), source)` dedup index.
pub fn timeline_dedup(
    page_id: u64,
    date: &str,
    summary_digest: &[u8; 32],
    source: &str,
) -> Vec<u8> {
    let mut key = timeline_dedup_prefix(page_id);
    key.extend_from_slice(date.as_bytes());
    key.extend_from_slice(summary_digest);
    key.extend_from_slice(source.as_bytes());
    key
}

pub fn timeline_dedup_prefix(page_id: u64) -> Vec<u8> {
    id_key(TIMELINE_DEDUP, &[page_id])
}

/// `G page_id` -> the newest `created_at` (microseconds, big-endian i64) of the page's entries.
pub fn timeline_latest(page_id: u64) -> Vec<u8> {
    id_key(TIMELINE_LATEST, &[page_id])
}

#[cfg(test)]
mod family_tag_tests {
    use super::*;
    use crate::kv::{KvWrite, collect_prefix};

    /// A two-byte family sorts after every one-byte tag, and a prefix scan of one family reads only its own keys.
    #[test]
    fn two_byte_family_tags_sort_after_one_byte_tags_and_scan_alone() {
        let store = crate::test_support::store();
        let fam_a = family_tag(b'a');
        let fam_b = family_tag(b'b');
        store
            .write(|tx: &mut dyn KvWrite| {
                tx.put(&family_text(fam_a, &["x", "1"]), b"a1")?;
                tx.put(&family_text(fam_a, &["y"]), b"a2")?;
                tx.put(&family_text(fam_b, &["x"]), b"b1")?;
                tx.put(&text(b'z', &["x"]), b"z1")?;
                tx.put(&text(b'2', &["x"]), b"d1")
            })
            .unwrap();
        let read = store.read().unwrap();
        let values = |prefix: &[u8]| -> Vec<Vec<u8>> {
            collect_prefix(&*read, prefix, false, 100)
                .unwrap()
                .into_iter()
                .map(|(_, v)| v)
                .collect()
        };
        assert_eq!(values(&fam_a), vec![b"a1".to_vec(), b"a2".to_vec()]);
        assert_eq!(values(&fam_b), vec![b"b1".to_vec()]);
        assert_eq!(
            values(&[FAMILY_ESCAPE]),
            vec![b"a1".to_vec(), b"a2".to_vec(), b"b1".to_vec()]
        );
        assert_eq!(
            values(b"z"),
            vec![b"z1".to_vec()],
            "a one-byte family never reads a two-byte one"
        );
        // Every letter and digit sorts below the escape, so no one-byte tag interleaves with the two-byte ranges.
        for tag in (b'0'..=b'9').chain(b'A'..=b'Z').chain(b'a'..=b'z') {
            assert!(tag < FAMILY_ESCAPE);
        }
        assert_eq!(family_text(fam_a, &[]), fam_a.to_vec());
    }

    /// `0x00` is the storage adapter's byte, so no family takes it.
    #[test]
    #[should_panic(expected = "a family byte is never 0x00")]
    fn family_tag_refuses_the_storage_adapter_byte() {
        let zero = std::hint::black_box(0u8);
        let _ = family_tag(zero);
    }
}
