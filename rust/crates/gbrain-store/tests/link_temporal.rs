//! Link temporal state (link_queries::link_temporal). Expected rows follow the PGLite SQL in
//! src/core/engine-sql/link-temporal.ts.

mod common;

use common::TempDir;
use gbrain_store::link_queries::{
    ApplyTemporalInput, EdgeValidityInput, EvidenceInput, InboundCountInput, KeysForOriginInput,
    KeysForPagesInput, KeysTouchingInput, ManualRelationship, ManualWriteInput, NoteRowsInput,
    PageStatusInput, RecordMetadataInput, RelationshipKey, StaleKeysInput, StateWrite,
};
use gbrain_store::links::AddLinkOptions;
use gbrain_store::pages::{PageInput, PutPageOptions};
use gbrain_store::redb_kv::RedbKv;
use gbrain_store::{OpenOptions, Store, SystemEnv};
use serde_json::{Value, json};
use std::sync::Arc;

struct Brain {
    _dir: TempDir,
    store: Store,
}

const TYPES: [&str; 2] = ["works_at", "advises"];

fn types() -> Vec<String> {
    TYPES.iter().map(|t| t.to_string()).collect()
}

fn de<T: serde::de::DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).unwrap()
}

impl Brain {
    fn new(name: &str) -> Self {
        let dir = TempDir::new(name);
        let kv = Arc::new(RedbKv::open_path(&dir.path().join("records.redb")).unwrap());
        let store = Store::open_kv(kv, Arc::new(SystemEnv), OpenOptions::default()).unwrap();
        Brain { _dir: dir, store }
    }

    fn page_with(&self, slug: &str, frontmatter: Value) -> u64 {
        let input: PageInput = de(json!({
            "type": "person", "title": format!("Title {slug}"), "compiled_truth": format!("{slug} body"),
            "frontmatter": frontmatter,
        }));
        let options: PutPageOptions = de(json!({"sourceId": "default", "index": false}));
        self.store.put_page(slug, &input, &options).unwrap()["id"]
            .as_u64()
            .unwrap()
    }

    fn page(&self, slug: &str) -> u64 {
        self.page_with(slug, json!({}))
    }

    fn link(&self, from: &str, to: &str, link_type: &str) {
        let options = AddLinkOptions {
            link_type: Some(link_type.into()),
            link_source: Some("markdown".into()),
            ..AddLinkOptions::default()
        };
        self.store.add_link(from, to, &options).unwrap();
    }

    fn manual(&self, from: &str, to: &str, rows: Value) -> Value {
        let input: ManualWriteInput = de(json!({
            "rel": {"from": from, "to": to, "linkType": "works_at", "sourceId": "default"},
            "rows": rows,
        }));
        serde_json::to_value(self.store.write_manual_link_transitions(&input).unwrap()).unwrap()
    }

    fn evidence(&self, keys: Value) -> Value {
        let input: EvidenceInput = de(json!({
            "keys": keys, "originPolicy": {"honorAliases": false, "entityPrivacy": true, "ownerOnly": "fn"},
        }));
        serde_json::to_value(self.store.read_link_relationship_evidence(&input).unwrap()).unwrap()
    }

    fn write_state(&self, rows: Value, removals: Value) -> u64 {
        let input: StateWrite = de(json!({"upserts": rows, "removals": removals, "changed": 0}));
        self.store.write_link_relationship_state(&input).unwrap()
    }
}

fn key(f: u64, t: u64, link_type: &str) -> Value {
    json!({"from_page_id": f, "to_page_id": t, "link_type": link_type})
}

fn state(f: u64, t: u64, scope: &str, ranges: &str, status: &str, last_end: Value) -> Value {
    json!({
        "from_page_id": f, "to_page_id": t, "link_type": "works_at", "scope": scope, "source_id": "default",
        "semantics": "state", "valid_ranges": ranges, "status_now": status, "first_start": "2021-01-01",
        "last_start": "2021-01-01", "last_end": last_end, "undated_present": 1, "undated_past": 0,
        "disputed": false, "recorded_at": "2026-01-02T00:00:00.000Z", "retired_at": null, "evidence_hash": "h1",
    })
}

#[test]
fn manual_transitions_feed_the_evidence_and_dedupe() {
    let b = Brain::new("lt-manual");
    let alice = b.page("alice");
    let acme = b.page("acme");
    let wrote = b.manual(
        "alice",
        "acme",
        json!([{"kind": "start", "occurred_on": "2021-01-01"}, {"kind": "end", "occurred_on": "2024-06-01"}]),
    );
    assert_eq!(
        wrote,
        json!({"inserted": 2, "key": key(alice, acme, "works_at")})
    );
    // The same statements again insert nothing (ON CONFLICT DO NOTHING on the identity).
    let again = b.manual(
        "alice",
        "acme",
        json!([{"kind": "start", "occurred_on": "2021-01-01"}]),
    );
    assert_eq!(again["inserted"], 0);
    let ev = b.evidence(json!([key(alice, acme, "works_at")]));
    let t = ev["transitions"].as_array().unwrap();
    assert_eq!(t.len(), 2);
    assert_eq!(t[0]["origin_id"], Value::Null);
    assert_eq!(t[0]["producer"], "manual");
    assert_eq!(t[0]["origin_public"], true);
    assert!(ev["assertions"].as_array().unwrap().is_empty());
    // A missing endpoint page writes nothing and has no key.
    let none = b.manual(
        "alice",
        "nobody",
        json!([{"kind": "start", "occurred_on": "2021-01-01"}]),
    );
    assert_eq!(none, json!({"inserted": 0, "key": null}));
    // A soft-deleted endpoint writes nothing, but the key still resolves.
    b.store.soft_delete_page("acme", None).unwrap();
    let soft = b.manual(
        "alice",
        "acme",
        json!([{"kind": "start", "occurred_on": "2022-01-01"}]),
    );
    assert_eq!(
        soft,
        json!({"inserted": 0, "key": key(alice, acme, "works_at")})
    );
    // Evidence with a soft-deleted endpoint does not count.
    let ev = b.evidence(json!([key(alice, acme, "works_at")]));
    assert!(ev["transitions"].as_array().unwrap().is_empty());
}

#[test]
fn invalid_rows_are_refused() {
    let b = Brain::new("lt-invalid");
    b.page("alice");
    b.page("acme");
    let input: ManualWriteInput = de(json!({
        "rel": {"from": "alice", "to": "acme", "linkType": "works_at", "sourceId": "default"},
        "rows": [{"kind": "start", "occurred_on": "2021-02-30"}],
    }));
    assert_eq!(
        b.store
            .write_manual_link_transitions(&input)
            .unwrap_err()
            .code,
        "invalid_argument"
    );
    let input: ManualWriteInput = de(json!({
        "rel": {"from": "alice", "to": "acme", "linkType": "works_at", "sourceId": "default"},
        "rows": [{"kind": "middle", "occurred_on": "2021-02-01"}],
    }));
    assert_eq!(
        b.store
            .write_manual_link_transitions(&input)
            .unwrap_err()
            .code,
        "constraint_violation"
    );
    let alice = b.page("alice");
    let acme = b.page("acme");
    let bad: StateWrite = de(json!({
        "upserts": [state(alice, acme, "all", "{[2021-01-01,2022-01-01]}", "live", Value::Null)],
    }));
    assert_eq!(
        b.store
            .write_link_relationship_state(&bad)
            .unwrap_err()
            .code,
        "invalid_argument"
    );
    let missing: StateWrite = de(json!({
        "upserts": [state(alice, 999, "all", "{}", "live", Value::Null)],
    }));
    assert_eq!(
        b.store
            .write_link_relationship_state(&missing)
            .unwrap_err()
            .code,
        "constraint_violation"
    );
}

#[test]
fn state_rows_round_trip_and_are_removed() {
    let b = Brain::new("lt-state");
    let alice = b.page("alice");
    let acme = b.page("acme");
    b.link("alice", "acme", "works_at");
    let changed = b.write_state(
        json!([
            state(
                alice,
                acme,
                "all",
                "{[2023-01-01,2024-01-01),[2021-01-01,2023-01-01)}",
                "ended",
                json!("2024-01-01")
            ),
            state(
                alice,
                acme,
                "world",
                "{[2021-01-01,2024-01-01)}",
                "ended",
                json!("2024-01-01")
            ),
        ]),
        json!([]),
    );
    assert_eq!(changed, 0);
    let ev = b.evidence(json!([key(alice, acme, "works_at")]));
    let existing = ev["existing"].as_array().unwrap();
    assert_eq!(existing.len(), 2);
    assert_eq!(existing[0]["recorded_at"], "2026-01-02T00:00:00.000Z");
    // recorded_at keeps the earlier value (LEAST) on update.
    let mut later = state(
        alice,
        acme,
        "all",
        "{[2021-01-01,2024-01-01)}",
        "ended",
        json!("2024-01-01"),
    );
    later["recorded_at"] = json!("2026-05-01T00:00:00.000Z");
    b.write_state(json!([later]), json!([]));
    let ev = b.evidence(json!([key(alice, acme, "works_at")]));
    assert_eq!(ev["existing"][0]["recorded_at"], "2026-01-02T00:00:00.000Z");
    // The note reads the canonical multirange text.
    let notes: NoteRowsInput = de(json!({"subjects": [{"slug": "alice", "source_id": "default"}]}));
    let rows = serde_json::to_value(b.store.list_relationship_note_rows(&notes).unwrap()).unwrap();
    assert_eq!(rows[0]["temporal_ranges"], "{[2021-01-01,2024-01-01)}");
    assert_eq!(rows[0]["to_title"], "Title acme");
    assert_eq!(rows[0]["end_upper_bound"], false);
    // Edge validity: the link still states the ended relationship.
    let counts = b
        .store
        .edge_validity_counts(&de::<EdgeValidityInput>(json!({"staleLimit": 21})))
        .unwrap();
    let counts = serde_json::to_value(counts).unwrap();
    assert_eq!(counts["byStatus"], json!([{"status": "ended", "n": 1}]));
    assert_eq!(
        counts["stale"],
        json!([{"slug": "alice", "target": "acme", "link_type": "works_at", "ended": "2024-01-01"}])
    );
    let other = b
        .store
        .edge_validity_counts(&de::<EdgeValidityInput>(
            json!({"sourceIds": ["elsewhere"], "staleLimit": 21}),
        ))
        .unwrap();
    assert!(other.by_status.is_empty());
    // Removing a row returns it in the count.
    let removed = b.write_state(
        json!([]),
        json!([{"from_page_id": alice, "to_page_id": acme, "link_type": "works_at", "scope": "world"},
               {"from_page_id": alice, "to_page_id": acme, "link_type": "works_at", "scope": "world"}]),
    );
    assert_eq!(removed, 1);
}

#[test]
fn stale_keys_follow_the_three_steps() {
    let b = Brain::new("lt-stale");
    let alice = b.page("alice");
    let acme = b.page("acme");
    let widget = b.page("widget");
    b.link("alice", "acme", "works_at");
    b.link("alice", "widget", "mentions");
    let stale = |limit: u64| {
        let input: StaleKeysInput = de(json!({"limit": limit, "linkTypes": types()}));
        serde_json::to_value(b.store.stale_link_relationship_keys(&input).unwrap()).unwrap()
    };
    // No state yet: the temporal link is stale, the reference link is not.
    assert_eq!(stale(10), json!([key(alice, acme, "works_at")]));
    b.write_state(
        json!([state(
            alice,
            acme,
            "all",
            "{[2021-01-01,)}",
            "live",
            Value::Null
        )]),
        json!([]),
    );
    assert_eq!(stale(10), json!([]));
    // An orphan: state with no evidence left.
    b.write_state(
        json!([state(alice, widget, "all", "{}", "live", Value::Null)]),
        json!([]),
    );
    assert_eq!(stale(10), json!([key(alice, widget, "works_at")]));
    assert_eq!(stale(0), json!([]));
    // The origin page edited after the refresh.
    std::thread::sleep(std::time::Duration::from_millis(2));
    b.page("alice");
    let keys = stale(10);
    assert!(
        keys.as_array()
            .unwrap()
            .contains(&key(alice, acme, "works_at"))
    );
}

#[test]
fn applying_temporal_rows_stamps_tense_and_replaces_derived_transitions() {
    let b = Brain::new("lt-apply");
    let alice = b.page("alice");
    let acme = b.page("acme");
    b.page("widget");
    b.link("alice", "acme", "works_at");
    let apply = |transitions: Value, tense: Option<&str>| {
        let input: ApplyTemporalInput = de(json!({
            "pageId": alice, "sourceId": "default",
            "tenseRows": [{"from_slug": "alice", "to_slug": "acme", "link_type": "works_at", "link_source": "markdown",
                           "from_source_id": "default", "to_source_id": "default", "tense": tense}],
            "transitions": transitions,
            "explicitTargets": ["acme", "nobody"],
            "producers": ["timeline", "explicit", "frontmatter", "dream", "inline"],
            "linkTypes": types(),
        }));
        serde_json::to_value(b.store.apply_link_temporal_rows(&input).unwrap()).unwrap()
    };
    let row = |occurred: &str| {
        json!({"from_slug": "alice", "to_slug": "acme", "link_type": "works_at", "kind": "end",
               "occurred_on": occurred, "date_precision": "day", "producer": "timeline", "line_hash": "x"})
    };
    let out = apply(json!([row("2024-01-01"), row("2024-01-01")]), Some("past"));
    assert_eq!(out["inserted"], json!([key(alice, acme, "works_at")]));
    assert_eq!(out["liveTargets"], json!(["acme"]));
    assert_eq!(out["keysAfter"], json!([key(alice, acme, "works_at")]));
    let ev = b.evidence(json!([key(alice, acme, "works_at")]));
    assert_eq!(ev["assertions"][0]["tense"], "past");
    assert_eq!(ev["transitions"].as_array().unwrap().len(), 1);
    // A second apply replaces the derived rows and clears the tense.
    let out = apply(json!([row("2025-01-01")]), None);
    assert_eq!(out["inserted"].as_array().unwrap().len(), 1);
    let ev = b.evidence(json!([key(alice, acme, "works_at")]));
    assert_eq!(ev["assertions"][0]["tense"], "present");
    assert_eq!(ev["transitions"][0]["occurred_on"], "2025-01-01");
    // Manual rows survive the replacement.
    b.manual(
        "alice",
        "acme",
        json!([{"kind": "start", "occurred_on": "2020-01-01"}]),
    );
    apply(json!([]), None);
    let ev = b.evidence(json!([key(alice, acme, "works_at")]));
    assert_eq!(ev["transitions"].as_array().unwrap().len(), 1);
    assert_eq!(ev["transitions"][0]["producer"], "manual");
    let origin: KeysForOriginInput = de(json!({"pageId": alice, "linkTypes": types()}));
    assert_eq!(
        serde_json::to_value(b.store.link_relationship_keys_for_origin(&origin).unwrap()).unwrap(),
        json!([key(alice, acme, "works_at")])
    );
    // Removing the manual statements reports one key per row.
    let rel: ManualRelationship = de(json!({"from": "alice", "to": "acme", "sourceId": "default"}));
    let gone = b.store.remove_manual_link_transitions(&rel).unwrap();
    assert_eq!(
        gone,
        vec![de::<RelationshipKey>(key(alice, acme, "works_at"))]
    );
}

#[test]
fn key_lookups_and_hard_delete_cascade() {
    let b = Brain::new("lt-keys");
    let alice = b.page("alice");
    let acme = b.page("acme");
    b.link("alice", "acme", "works_at");
    b.manual(
        "alice",
        "acme",
        json!([{"kind": "start", "occurred_on": "2021-01-01"}]),
    );
    b.write_state(
        json!([state(
            alice,
            acme,
            "all",
            "{[2021-01-01,)}",
            "live",
            Value::Null
        )]),
        json!([]),
    );
    let pages: KeysForPagesInput = de(json!({"pageIds": [acme], "linkTypes": types()}));
    assert_eq!(
        serde_json::to_value(b.store.link_relationship_keys_for_pages(&pages).unwrap()).unwrap(),
        json!([key(alice, acme, "works_at")])
    );
    let touching: KeysTouchingInput = de(json!({
        "pairs": [], "fromPages": [{"slug": "alice", "source_id": "default"}], "linkTypes": types(),
    }));
    assert_eq!(
        serde_json::to_value(b.store.link_relationship_keys_touching(&touching).unwrap()).unwrap(),
        json!([key(alice, acme, "works_at")])
    );
    b.store.delete_page("acme", None).unwrap();
    let ev = b.evidence(json!([key(alice, acme, "works_at")]));
    assert_eq!(
        ev,
        json!({"assertions": [], "transitions": [], "existing": []})
    );
}

#[test]
fn record_metadata_and_page_status() {
    let b = Brain::new("lt-records");
    let a = b.page_with("decision-a", json!({"status": "accepted"}));
    let c = b.page_with(
        "decision-c",
        json!({"status": "draft", "visibility": "private"}),
    );
    b.page_with("decision-q", json!({"status": "x", "quarantine": true}));
    b.link("decision-a", "decision-c", "amends");
    b.write_state(
        json!([{"from_page_id": a, "to_page_id": c, "link_type": "amends", "scope": "all", "source_id": "default",
                "semantics": "event", "valid_ranges": "{}", "status_now": "event", "first_start": "2024-03-01",
                "last_start": null, "last_end": null, "undated_present": 0, "undated_past": 0, "disputed": false,
                "recorded_at": "2026-01-02T00:00:00.000Z", "retired_at": null, "evidence_hash": "h"}]),
        json!([]),
    );
    let meta = |exclude: Value| {
        let input: RecordMetadataInput = de(json!({
            "pageIds": [a, c], "referrerSources": ["default"], "excludePrivate": exclude,
            "includeQuarantined": false, "scope": "all",
        }));
        serde_json::to_value(b.store.list_record_metadata_rows(&input).unwrap()).unwrap()
    };
    let trusted = meta(Value::Null);
    assert_eq!(
        trusted["links"],
        json!([{"from_id": a, "slug": "decision-c", "link_type": "amends", "since": "2024-03-01"}])
    );
    assert_eq!(trusted["status"][0], json!({"id": a, "status": "accepted"}));
    let remote = meta(json!({"honorAliases": false, "entityPrivacy": true, "ownerOnly": "fn"}));
    assert_eq!(remote["links"], json!([]));
    let status: PageStatusInput = de(json!({
        "refs": [{"slug": "decision-a", "source_id": "default"}, {"slug": "decision-c", "source_id": "default"},
                 {"slug": "decision-q", "source_id": "default"}],
        "excludePrivate": {"honorAliases": false, "entityPrivacy": true, "ownerOnly": "fn"},
    }));
    let rows = serde_json::to_value(b.store.list_page_status_by_ref(&status).unwrap()).unwrap();
    assert_eq!(
        rows,
        json!([{"source_id": "default", "slug": "decision-a", "status": "accepted"}])
    );
    let counts = b.store.count_search_vector_rows().unwrap();
    assert_eq!(counts.pages, 3);
}

#[test]
fn entity_inbound_edges_carry_the_scope_relationship_in_link_order() {
    let b = Brain::new("lt-inbound");
    let alice = b.page("alice");
    let acme = b.page("acme");
    b.page("bob");
    b.page("carol");
    b.link("alice", "acme", "works_at");
    b.link("bob", "acme", "advises");
    b.link("carol", "acme", "knows");
    let mention = AddLinkOptions {
        link_type: Some("mentions".into()),
        link_source: Some("mentions".into()),
        ..AddLinkOptions::default()
    };
    b.store.add_link("carol", "acme", &mention).unwrap();
    b.write_state(
        json!([state(
            alice,
            acme,
            "all",
            "{[2021-01-01,)}",
            "live",
            Value::Null
        )]),
        json!([]),
    );
    let read = |exclude: Value| {
        let input: InboundCountInput = de(json!({
            "slug": "acme", "sourceId": "default", "excludePrivate": exclude, "originSameSource": false,
        }));
        let n = b.store.count_inbound_links(&input).unwrap();
        let rows =
            serde_json::to_value(b.store.read_entity_inbound_edges(&input).unwrap()).unwrap();
        (n, rows)
    };
    let (n, rows) = read(Value::Null);
    assert_eq!(n, 3);
    let rows = rows.as_array().unwrap();
    let froms: Vec<&str> = rows
        .iter()
        .map(|r| r["from_slug"].as_str().unwrap())
        .collect();
    assert_eq!(froms, ["alice", "bob", "carol"]);
    assert_eq!(rows[0]["temporal_ranges"], "{[2021-01-01,)}");
    assert_eq!(rows[0]["temporal_semantics"], "state");
    assert_eq!(rows[0]["temporal_disputed"], false);
    assert_eq!(rows[0]["temporal_undated_past"], 0);
    assert_eq!(rows[0]["temporal_first_start"], "2021-01-01");
    assert_eq!(rows[0]["temporal_recorded_at"], "2026-01-02T00:00:00.000Z");
    assert_eq!(rows[0]["temporal_retired_at"], Value::Null);
    assert_eq!(rows[1]["temporal_ranges"], Value::Null);
    assert_eq!(rows[1]["temporal_semantics"], Value::Null);
    // The world scope has no relationship row, so every temporal column is null under the policy.
    let (n, rows) = read(json!({"honorAliases": false, "entityPrivacy": true}));
    assert_eq!(n, 3);
    assert_eq!(rows[0]["temporal_ranges"], Value::Null);
}
