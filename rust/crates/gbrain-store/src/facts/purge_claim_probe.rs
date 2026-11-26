//! A fact purge receipt's two store probes (`fingerprint` and `claim_text` of a `PurgeStoreProbe`, SQL in `fingerprintSelect` and
//! `claimTextSelect`, src/core/engine-sql/purge-verify.ts): after the purge, does any row still carry the purged claim? Both
//! read, none writes, and each count stops at `cap` (`rows + 1`) as the SQL's `LIMIT` does: every scan streams its rows and
//! leaves the later ones unread once the count reaches the cap.
//!
//! `fingerprint` counts the rows of a store whose claim has the purged fact's fingerprint (`gbrain_fact_fingerprint`), within
//! the source:
//! - `facts`: the visibility is the purge's, the subject is `*` or the fact's entity, and a purge's own outcome marker is not a
//!   claim and never counts;
//! - `takes`: the take's page is in the source, and (a named subject) is the subject page; a take has no visibility;
//! - `take_proposals`: the proposal's source.
//!
//! `claim_text` counts the rows of a store that state the claim (the caller lowers `claim`, `json` and `reason`):
//! - `pages`: a live page whose body, timeline, title or frontmatter (as jsonb text, matched against `json`) holds the claim.
//!   A segmented page's body columns are NULL, so only its title and frontmatter can match here;
//! - `content_chunks`: a chunk of any page of the source, soft-deleted pages and every generation included;
//! - `page_versions`: a snapshot of a page of the source that carries the claim as a page does, or whose change reason holds the
//!   claim or the reason;
//! - `persistence_requests`: a journal request of the source whose intent, outcome, error detail or error message holds the
//!   claim, its JSON form or the reason's;
//! - `core_edit_notices`: a notice of the source whose base text holds the claim (`core_edit_notices.rs`); a notice with no
//!   base text never matches.
//!
//! Text matching follows the SQL: `strpos(lower(x), n) > 0` is `pg_lower(x).contains(n)` with a NULL column never matching
//! (`COALESCE(x, '')` where the SQL coalesces it), and a jsonb column's text is `jsonb_text`. Needles are matched as given.

use super::purge_store_probe::{any_in, jsonb_or_empty};
use super::{FactRecord, fact_fingerprint, for_each_source_fact, invalid, purge};
use crate::cli_reads::pg_text::{jsonb_text, pg_lower};
use crate::error::Result;
use crate::journal::RequestRecord;
use crate::keys;
use crate::kv::{KvRead, for_each_prefix_paged, scan_prefix};
use crate::pages::PageRecord;
use serde_json::{Map, Value};

/// `fingerprint`'s arguments: the purged fact's source, hash, visibility and subject.
pub(super) struct Fingerprint<'a> {
    pub source_id: &'a str,
    pub fact_hash: &'a str,
    pub visibility: &'a str,
    pub subject: &'a str,
}

/// `claim_text`'s needles, as the caller built them.
pub(super) struct Claim<'a> {
    pub source_id: &'a str,
    pub claim: &'a str,
    pub json: &'a str,
    pub reason: &'a str,
    pub reason_json: &'a str,
}

/// `strpos(lower(text), needle) > 0`; a NULL column (`None`) never matches.
fn has(text: Option<&str>, needle: &str) -> bool {
    text.is_some_and(|t| pg_lower(t).contains(needle))
}

/// A page or page version states the claim: `carriesClaim` of src/core/engine-sql/purge-verify.ts. The timeline and the title are
/// read as `COALESCE(x, '')`.
fn carries(
    body: Option<&str>,
    timeline: Option<&str>,
    title: &str,
    frontmatter: &Map<String, Value>,
    q: &Claim,
) -> bool {
    has(body, q.claim)
        || has(Some(timeline.unwrap_or_default()), q.claim)
        || has(Some(title), q.claim)
        || has(
            Some(&jsonb_text(&Value::Object(frontmatter.clone()))),
            q.json,
        )
}

/// Counts what `matching` accepts of the facts of the source, stopping at `cap`.
fn count_facts(
    read: &dyn KvRead,
    source_id: &str,
    cap: usize,
    matching: &dyn Fn(&FactRecord) -> bool,
) -> Result<usize> {
    let mut count = 0;
    for_each_source_fact(read, source_id, &mut |row| {
        count += usize::from(matching(row));
        count < cap
    })?;
    Ok(count)
}

/// Counts the takes whose claim has the hash and whose page is in the source (and, for a named subject, has the slug).
fn count_takes(read: &dyn KvRead, q: &Fingerprint, cap: usize) -> Result<usize> {
    let mut count = 0;
    crate::takes::for_each_take(read, &mut |take| {
        if fact_fingerprint(&take.claim) == q.fact_hash {
            let page = crate::pages::read_page_by_id(read, take.page_id)?;
            count += usize::from(page.is_some_and(|p| {
                p.source_id == q.source_id && (q.subject == "*" || p.slug == q.subject)
            }));
        }
        Ok(count < cap)
    })?;
    Ok(count)
}

/// Counts the take proposals of the source whose claim text has the hash.
fn count_proposals(read: &dyn KvRead, q: &Fingerprint, cap: usize) -> Result<usize> {
    let mut count = 0;
    crate::takes::proposals::for_each_claim(read, &mut |source_id, claim| {
        count += usize::from(source_id == q.source_id && fact_fingerprint(claim) == q.fact_hash);
        count < cap
    })?;
    Ok(count)
}

/// The `fingerprint` probe of `store`: how many rows carry the purged fact's fingerprint, at most `cap`.
pub(super) fn count_fingerprint(
    read: &dyn KvRead,
    store: &str,
    q: &Fingerprint,
    op: &str,
    cap: usize,
) -> Result<usize> {
    match store {
        "facts" => count_facts(read, q.source_id, cap, &|row| {
            row.visibility == q.visibility
                && fact_fingerprint(&row.fact) == q.fact_hash
                && (q.subject == "*" || row.entity_slug.as_deref() == Some(q.subject))
                && !purge::outcome_marker(row)
        }),
        "takes" => count_takes(read, q, cap),
        "take_proposals" => count_proposals(read, q, cap),
        other => Err(invalid(format!(
            "{op}: the {other} fingerprint rows are not kept"
        ))),
    }
}

/// Calls `f` with each page of the source (soft-deleted included), in slug order, until it returns false or fails. The pages are
/// read a few at a time, so `f` may read the store.
fn for_each_page(
    read: &dyn KvRead,
    source_id: &str,
    f: &mut dyn FnMut(&PageRecord) -> Result<bool>,
) -> Result<()> {
    for_each_prefix_paged(
        read,
        &keys::text(keys::PAGE, &[source_id, ""]),
        64,
        &mut |_, v| f(&serde_json::from_slice::<PageRecord>(v).map_err(crate::StoreError::from)?),
    )
}

/// Counts the live pages of the source that state the claim.
fn count_pages(read: &dyn KvRead, q: &Claim, cap: usize) -> Result<usize> {
    let mut count = 0;
    for_each_page(read, q.source_id, &mut |p| {
        let live = p.deleted_at_us.is_none();
        count += usize::from(
            live && carries(
                p.compiled_truth.as_deref(),
                p.timeline.as_deref(),
                &p.title,
                &p.frontmatter,
                q,
            ),
        );
        Ok(count < cap)
    })?;
    Ok(count)
}

/// Counts the chunks of the pages of the source that hold the claim, every generation included.
fn count_chunks(read: &dyn KvRead, q: &Claim, cap: usize) -> Result<usize> {
    let mut count = 0;
    for_each_page(read, q.source_id, &mut |p| {
        let mut failure = None;
        scan_prefix(read, &keys::chunk_prefix(p.id), false, &mut |_, v| {
            match serde_json::from_slice::<crate::chunks::ChunkRecord>(v) {
                Ok(chunk) => count += usize::from(has(Some(&chunk.chunk_text), q.claim)),
                Err(e) => failure = Some(crate::StoreError::from(e)),
            }
            failure.is_none() && count < cap
        })?;
        failure.map_or(Ok(count < cap), Err)
    })?;
    Ok(count)
}

/// Counts the snapshots of the pages of the source that state the claim or whose change reason holds the claim or the reason.
fn count_versions(read: &dyn KvRead, q: &Claim, cap: usize) -> Result<usize> {
    let mut count = 0;
    for_each_page(read, q.source_id, &mut |p| {
        let mut failure = None;
        scan_prefix(read, &keys::version_prefix(p.id), false, &mut |_, v| {
            match serde_json::from_slice::<crate::pages::VersionRecord>(v) {
                Ok(version) => {
                    let reason = version.change_reason.as_deref();
                    count += usize::from(
                        carries(
                            version.compiled_truth.as_deref(),
                            version.timeline.as_deref(),
                            &version.title,
                            &version.frontmatter,
                            q,
                        ) || has(reason, q.claim)
                            || has(reason, q.reason),
                    );
                }
                Err(e) => failure = Some(crate::StoreError::from(e)),
            }
            failure.is_none() && count < cap
        })?;
        failure.map_or(Ok(count < cap), Err)
    })?;
    Ok(count)
}

/// Counts the journal requests of the source whose intent, outcome, error detail or error message holds the claim, its JSON form
/// or the reason's JSON form. The needles are matched as given (the column text is lowered, the needles are not).
fn count_requests(read: &dyn KvRead, q: &Claim, cap: usize) -> Result<usize> {
    let needles = [
        q.claim.to_string(),
        q.json.to_string(),
        q.reason_json.to_string(),
    ];
    let mut count = 0;
    let mut failure = None;
    scan_prefix(read, &[keys::REQUEST], false, &mut |_, v| {
        let r = match serde_json::from_slice::<RequestRecord>(v) {
            Ok(r) => r,
            Err(e) => {
                failure = Some(crate::StoreError::from(e));
                return false;
            }
        };
        if r.source_id == q.source_id
            && [
                jsonb_or_empty(Some(&r.intent)),
                jsonb_or_empty(r.outcome.as_ref()),
                jsonb_or_empty(r.extra.get("error_detail")),
                r.error_message.clone().unwrap_or_default(),
            ]
            .iter()
            .any(|text| any_in(text, &needles))
        {
            count += 1;
        }
        count < cap
    })?;
    failure.map_or(Ok(count), Err)
}

/// The `claim_text` probe of `store`: how many rows state the claim, at most `cap`.
pub(super) fn count_claim_text(
    read: &dyn KvRead,
    store: &str,
    q: &Claim,
    op: &str,
    cap: usize,
) -> Result<usize> {
    match store {
        "pages" => count_pages(read, q, cap),
        "content_chunks" => count_chunks(read, q, cap),
        "page_versions" => count_versions(read, q, cap),
        "persistence_requests" => count_requests(read, q, cap),
        "core_edit_notices" => {
            crate::core_edit_notices::count_claim_text(read, q.source_id, q.claim, cap)
        }
        other => Err(invalid(format!(
            "{op}: the {other} claim rows are not kept"
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::OpenOptions;
    use crate::chunks::{ChunkInput, UpsertChunksOptions};
    use crate::facts::InsertFactsArgs;
    use crate::kv::counting::Counting;
    use crate::pages::{PageInput, PutPageOptions};
    use crate::takes::{TakeInput, TakeProposalInput};
    use crate::{Store, kv::KvRead};
    use serde_json::json;
    use std::path::PathBuf;

    struct Dir(PathBuf);
    impl Drop for Dir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn open(name: &str) -> (Store, Dir) {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../target/unit-tmp")
            .join(format!("{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let store = Store::open_dir(&dir.join("brain"), OpenOptions::default()).unwrap();
        (store, Dir(dir))
    }

    /// Every entry of the store, held in a map that counts what a scan hands out and what a get reads.
    fn snapshot(store: &Store) -> Counting {
        let mut copy = Counting::default();
        store
            .read()
            .unwrap()
            .scan(&[0], &[0xff, 0xff], false, &mut |k, v| {
                copy.entries.insert(k.to_vec(), v.to_vec());
                true
            })
            .unwrap();
        copy
    }

    fn page(store: &Store, slug: &str, truth: &str) -> u64 {
        let input: PageInput = serde_json::from_value(
            json!({ "type": "note", "title": slug, "compiled_truth": truth, "frontmatter": {} }),
        )
        .unwrap();
        let options: PutPageOptions =
            serde_json::from_value(json!({ "sourceId": "default", "index": false })).unwrap();
        store.put_page(slug, &input, &options).unwrap()["id"]
            .as_u64()
            .unwrap()
    }

    fn claim(source_id: &str) -> Claim<'_> {
        Claim {
            source_id,
            claim: "the harbor will reopen",
            json: "the harbor will reopen",
            reason: "tidy",
            reason_json: "tidy",
        }
    }

    /// (count, entries handed out, records read by key) of a probe run with the counters at zero.
    fn run(
        store: &Counting,
        probe: &dyn Fn(&dyn KvRead) -> Result<usize>,
    ) -> (usize, usize, usize) {
        store.delivered.set(0);
        store.gets.set(0);
        let found = probe(store).unwrap();
        (found, store.delivered.get(), store.gets.get())
    }

    #[test]
    fn text_matching_follows_the_sql_lowered_haystack_and_a_null_never_matches() {
        assert!(has(Some("The HARBOR will reopen."), "harbor"));
        assert!(!has(Some("The harbor"), "Harbor"));
        assert!(!has(None, ""));
    }

    #[test]
    fn a_page_or_version_carries_the_claim_in_its_body_timeline_title_or_frontmatter() {
        let q = claim("default");
        let none = Map::new();
        let fm = |text: &str| match json!({ "note": text }) {
            Value::Object(o) => o,
            _ => unreachable!(),
        };
        assert!(carries(
            Some("x THE HARBOR WILL REOPEN y"),
            None,
            "t",
            &none,
            &q
        ));
        assert!(carries(
            None,
            Some("- the harbor will reopen"),
            "t",
            &none,
            &q
        ));
        assert!(carries(None, None, "The Harbor Will Reopen", &none, &q));
        assert!(carries(None, None, "t", &fm("The Harbor Will Reopen"), &q));
        assert!(!carries(None, None, "t", &none, &q));
        assert!(!carries(Some("harbor"), Some("reopen"), "t", &fm("x"), &q));
    }

    #[test]
    fn a_store_that_is_not_kept_refuses_both_probes() {
        let store = Counting::default();
        let q = claim("default");
        let f = Fingerprint {
            source_id: "default",
            fact_hash: "h",
            visibility: "world",
            subject: "*",
        };
        let claim_err = count_claim_text(&store, "page_aliases", &q, "op", 2).unwrap_err();
        assert!(claim_err.to_string().contains("claim rows are not kept"));
        let fp_err = count_fingerprint(&store, "pages", &f, "op", 2).unwrap_err();
        assert!(fp_err.to_string().contains("fingerprint rows are not kept"));
    }

    #[test]
    fn the_notice_count_serves_core_edit_notices_and_stops_at_the_cap() {
        let (store, _dir) = open("purge-claim-notices");
        let notice = |source: &str, slug: &str, base: Option<&str>| {
            let input: crate::core_edit_notices::CoreEditNoticeInput = serde_json::from_value(json!({
                "sourceId": source, "slug": slug, "pageId": null, "revision": "r", "baseRevision": null,
                "baseText": base, "actor": "remote:agent",
            }))
            .unwrap();
            store.insert_core_edit_notice(&input).unwrap();
        };
        for n in 0..6 {
            notice(
                "default",
                &format!("core/p{n}"),
                Some("The Harbor Will Reopen soon"),
            );
        }
        notice("default", "core/none", None);
        notice("default", "core/other", Some("unrelated"));
        let q = claim("default");
        let snap = snapshot(&store);
        // Not refused: a count, stopping at the cap.
        assert_eq!(
            count_claim_text(&snap, "core_edit_notices", &q, "op", 100).unwrap(),
            6
        );
        assert_eq!(
            count_claim_text(&snap, "core_edit_notices", &q, "op", 3).unwrap(),
            3
        );
        assert_eq!(
            count_claim_text(&snap, "core_edit_notices", &claim("other"), "op", 100).unwrap(),
            0
        );
    }

    #[test]
    fn the_fact_count_stops_at_the_cap_and_reads_no_later_fact() {
        let (store, _dir) = open("purge-claim-facts");
        let rows: Vec<_> = (0..40)
            .map(|n| {
                json!({ "fact": "The harbor will reopen", "kind": "fact", "visibility": "world",
                "source": "chat", "entity_slug": format!("notes/e{n:02}") })
            })
            .collect();
        let args: InsertFactsArgs =
            serde_json::from_value(json!({ "sourceId": "default", "rows": rows })).unwrap();
        assert_eq!(store.insert_facts(&args).unwrap()["inserted"], 40);
        let hash = fact_fingerprint("The harbor will reopen");
        let q = Fingerprint {
            source_id: "default",
            fact_hash: &hash,
            visibility: "world",
            subject: "*",
        };
        let counted = snapshot(&store);
        let probe = |cap| {
            run(&counted, &|read| {
                count_fingerprint(read, "facts", &q, "op", cap)
            })
        };
        // (count, index entries handed out, fact records read): the index is read 8 at a time, a record when its turn comes.
        assert_eq!(probe(1), (1, 8, 1));
        assert_eq!(probe(9), (9, 16, 9));
        assert_eq!(probe(500), (40, 40, 40));
    }

    #[test]
    fn the_take_and_proposal_counts_stop_at_the_cap() {
        let (store, _dir) = open("purge-claim-takes");
        let id = page(&store, "notes/a", "body");
        let takes: Vec<TakeInput> = (1..=30)
            .map(|n| {
                serde_json::from_value(json!({ "page_id": id, "row_num": n,
                    "claim": "The harbor will reopen", "kind": "take", "holder": "people/alice",
                    "weight": 0.5, "active": true }))
                .unwrap()
            })
            .collect();
        store.add_takes_batch(&takes).unwrap();
        for n in 0..30 {
            let p: TakeProposalInput = serde_json::from_value(json!({ "sourceId": "default",
                "pageSlug": "notes/a", "contentHash": format!("h{n}"), "promptVersion": "v",
                "proposalRunId": "r", "claimText": "The harbor will reopen", "kind": "bet",
                "holder": "brain", "weight": 0.5, "modelId": "m" }))
            .unwrap();
            store.insert_take_proposal(&p).unwrap();
        }
        let hash = fact_fingerprint("The harbor will reopen");
        let q = Fingerprint {
            source_id: "default",
            fact_hash: &hash,
            visibility: "world",
            subject: "*",
        };
        let counted = snapshot(&store);
        for kind in ["takes", "take_proposals"] {
            let probe = |cap| {
                run(&counted, &|read| {
                    count_fingerprint(read, kind, &q, "op", cap)
                })
            };
            let (all, all_delivered, _) = probe(500);
            assert_eq!(all, 30, "{kind}");
            let (one, delivered, _) = probe(1);
            assert_eq!(one, 1, "{kind}");
            assert!(
                delivered < all_delivered,
                "{kind}: {delivered} of {all_delivered}"
            );
            assert!(delivered <= 8, "{kind}: {delivered}");
        }
    }

    #[test]
    fn the_page_count_stops_at_the_cap_and_reads_no_later_page() {
        let (store, _dir) = open("purge-claim-pages");
        for n in 0..200 {
            page(&store, &format!("notes/p{n:03}"), "The harbor will reopen");
        }
        let counted = snapshot(&store);
        let q = claim("default");
        let probe = |cap| run(&counted, &|read| count_pages(read, &q, cap));
        let (one, delivered_one, _) = probe(1);
        let (all, delivered_all, _) = probe(500);
        assert_eq!((one, all), (1, 200));
        assert!(delivered_one <= 64, "{delivered_one}");
        assert!(delivered_all >= 200, "{delivered_all}");
    }

    #[test]
    fn the_chunk_and_version_counts_stop_at_the_cap_inside_a_page() {
        let (store, _dir) = open("purge-claim-chunks");
        page(&store, "notes/a", "body");
        let chunks: Vec<ChunkInput> = (0..40)
            .map(|n| {
                serde_json::from_value(json!({ "chunk_index": n,
                    "chunk_text": "The harbor will reopen", "chunk_source": "compiled_truth" }))
                .unwrap()
            })
            .collect();
        let own = UpsertChunksOptions {
            source_id: Some("default".into()),
            ..UpsertChunksOptions::default()
        };
        store.upsert_chunks("notes/a", &chunks, &own).unwrap();
        for n in 0..40 {
            store
                .create_version_with(
                    "notes/a",
                    Some("default"),
                    Some(&format!("the harbor will reopen {n}")),
                )
                .unwrap();
        }
        let counted = snapshot(&store);
        let q = claim("default");
        for (name, probe) in [
            (
                "chunks",
                count_chunks as fn(&dyn KvRead, &Claim, usize) -> Result<usize>,
            ),
            ("versions", count_versions),
        ] {
            let (all, all_delivered, _) = run(&counted, &|read| probe(read, &q, 500));
            let (one, delivered, _) = run(&counted, &|read| probe(read, &q, 3));
            assert_eq!((all, one), (40, 3), "{name}");
            assert!(
                delivered < all_delivered,
                "{name}: {delivered} of {all_delivered}"
            );
        }
    }
}
