//! `listFactsFromQuotedPages` and `listOwnerTierFacts` (`facts/quote.rs`): the quote reads
//! search/transcript-quote.ts runs before a model reads a fact. The parity cases are in
//! test/engine-parity/remember-meta.test.ts; these cover a deleted quoted page, a backstop
//! fact of a source that is not a backstop's, and a floor that names no tier.

mod memory_env;

use gbrain_store::facts::quote::{OwnerTierQuery, QuotedPagesQuery};
use gbrain_store::facts::{InsertFactArgs, InsertFactsArgs};
use gbrain_store::pages::{PageInput, PutPageOptions};
use memory_env::brain;
use serde_json::{Value, json};

fn args<T: serde::de::DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).unwrap()
}

fn page(b: &memory_env::Brain, slug: &str, kind: &str) {
    let input: PageInput = args(json!({ "type": kind, "title": slug, "compiled_truth": "body" }));
    let options: PutPageOptions = args(json!({}));
    b.put_page(slug, &input, &options).unwrap();
}

fn insert(b: &memory_env::Brain, input: Value) -> u64 {
    b.insert_fact(&args::<InsertFactArgs>(
        json!({ "input": input, "sourceId": "default" }),
    ))
    .unwrap()["id"]
        .as_u64()
        .unwrap()
}

fn quoted(b: &memory_env::Brain, ids: &[u64]) -> Vec<u64> {
    b.list_facts_from_quoted_pages(&args::<QuotedPagesQuery>(json!({
        "ids": ids, "pageTypes": ["chat", "transcript"],
        "backstop": [["sync", "sync:"], ["put", "put:"]] })))
        .unwrap()
}

#[test]
fn quoted_page_facts_are_held_by_or_named_after_a_quoted_page() {
    let b = brain("facts-quote-pages");
    page(&b, "chats/a", "chat");
    page(&b, "chats/gone", "chat");
    page(&b, "notes/plain", "note");
    b.soft_delete_page("chats/gone", Some("default")).unwrap();
    b.insert_facts(&args::<InsertFactsArgs>(json!({ "sourceId": "default", "rows": [
        { "fact": "On a chat", "entity_slug": "people/pat", "source": "fence", "source_markdown_slug": "chats/a", "row_num": 1 },
        { "fact": "On a deleted chat", "entity_slug": "people/pat", "source": "fence", "source_markdown_slug": "chats/gone", "row_num": 1 },
        { "fact": "On a note", "entity_slug": "people/pat", "source": "fence", "source_markdown_slug": "notes/plain", "row_num": 1 },
    ] })))
    .unwrap();
    let all = |b: &memory_env::Brain| -> Vec<u64> { quoted(b, &(1..=20).collect::<Vec<_>>()) };
    let held = all(&b);
    assert_eq!(
        held.len(),
        2,
        "the chat and the deleted chat hold a quoted fact"
    );

    let backstop = insert(
        &b,
        json!({ "fact": "Backstop", "entity_slug": "people/pat", "source": "sync", "source_session": "sync:chats/a" }),
    );
    let wrong_source = insert(
        &b,
        json!({ "fact": "Other source", "entity_slug": "people/pat", "source": "chat", "source_session": "sync:chats/a" }),
    );
    let wrong_prefix = insert(
        &b,
        json!({ "fact": "Other prefix", "entity_slug": "people/pat", "source": "put", "source_session": "sync:chats/a" }),
    );
    let to_note = insert(
        &b,
        json!({ "fact": "Names a note", "entity_slug": "people/pat", "source": "put", "source_session": "put:notes/plain" }),
    );
    let got = quoted(
        &b,
        &[to_note, wrong_prefix, wrong_source, backstop, backstop, 999],
    );
    assert_eq!(got, vec![backstop]);
    assert!(quoted(&b, &[]).is_empty());
}

#[test]
fn owner_tier_facts_rank_at_or_above_the_floor() {
    let b = brain("facts-quote-owner");
    let plain = insert(
        &b,
        json!({ "fact": "Plain", "entity_slug": "people/pat", "source": "chat" }),
    );
    let read = |floor: &str, ids: &[u64]| {
        b.list_owner_tier_facts(&args::<OwnerTierQuery>(
            json!({ "ids": ids, "floor": floor }),
        ))
        .unwrap()
    };
    // A typed write is tier unknown: it meets an unknown floor and nothing above it.
    assert_eq!(read("unknown", &[plain, plain, 999]), vec![plain]);
    assert!(read("operator_curated", &[plain]).is_empty());
    assert!(read("unknown", &[]).is_empty());
    assert!(read("no-such-tier", &[]).is_empty());
    let refused = b
        .list_owner_tier_facts(&args::<OwnerTierQuery>(
            json!({ "ids": [plain], "floor": "no-such-tier" }),
        ))
        .unwrap_err();
    assert!(
        refused
            .to_string()
            .contains("listOwnerTierFacts: unknown trust tier \"no-such-tier\""),
        "{refused}"
    );
}
