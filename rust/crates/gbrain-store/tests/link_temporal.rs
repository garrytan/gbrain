//! Link temporal state (link_queries::link_temporal). Expected rows follow the PGLite SQL in
//! src/core/engine-sql/link-temporal.ts.

mod common;

use common::TempDir;
use gbrain_store::link_queries::{
    ApplyTemporalInput, EdgeValidityInput, EvidenceInput, InboundCountInput, KeysForOriginInput,
    KeysForPagesInput, KeysTouchingInput, ManualRelationship, ManualWriteInput, NoteRowsInput,
    PageStatusInput, RecordMetadataInput, ReferrerGroupInput, ReferrerPageDetailsInput,
    ReferrerRecordCandidateInput, ReferrerRowInput, ReferrerTargetCountInput,
    ReferrerTargetSourcesInput, RelationshipKey, StaleKeysInput, StateWrite,
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

#[test]
fn referrer_groups_by_canonical_type() {
    let b = Brain::new("lt-referrers");
    let dated = |slug: &str, page_type: &str, date: &str, frontmatter: Value| {
        let input: PageInput = de(json!({
            "type": page_type, "title": slug, "compiled_truth": format!("{slug} body"), "frontmatter": frontmatter,
            "effective_date": format!("{date}T00:00:00.000Z"), "effective_date_source": "date",
        }));
        let options: PutPageOptions = de(json!({"sourceId": "default", "index": false}));
        b.store.put_page(slug, &input, &options).unwrap();
    };
    b.page("acme");
    dated("bob", "person", "2026-03-01", json!({}));
    dated("alice", "person", "2026-03-01", json!({}));
    dated("standup", "call", "2026-02-01", json!({}));
    dated("review", "meeting", "2026-04-01", json!({}));
    dated("loose", "", "2026-01-01", json!({}));
    dated(
        "secret",
        "person",
        "2026-05-01",
        json!({"visibility": "private"}),
    );
    dated("held", "person", "2026-05-02", json!({"quarantine": true}));
    for slug in [
        "bob", "alice", "standup", "review", "loose", "secret", "held",
    ] {
        b.link(slug, "acme", "mentions");
    }
    let read = |exclude: Value, per_group: u64| {
        let input: ReferrerGroupInput = de(json!({
            "targetSources": ["default"], "targetSlugs": ["acme"], "referrerSources": ["default"],
            "storedTypes": ["call"], "canonicalTypes": ["meeting"], "excludePrivate": exclude,
            "perGroup": per_group,
        }));
        let rows = serde_json::to_value(b.store.read_referrer_group_rows(&input).unwrap()).unwrap();
        rows.as_array()
            .unwrap()
            .iter()
            .map(|r| {
                format!(
                    "{}:{}:{}",
                    r["canonical_type"].as_str().unwrap(),
                    r["slug"].as_str().unwrap(),
                    r["gtotal"]
                )
            })
            .collect::<Vec<_>>()
    };
    assert_eq!(
        read(Value::Null, 10),
        [
            "meeting:review:2",
            "meeting:standup:2",
            "person:secret:3",
            "person:alice:3",
            "person:bob:3",
            "untyped:loose:1"
        ]
    );
    assert_eq!(
        read(json!({"honorAliases": false, "entityPrivacy": true}), 1),
        ["meeting:review:2", "person:alice:2", "untyped:loose:1"]
    );
    let input: ReferrerGroupInput = de(json!({
        "targetSources": ["default"], "targetSlugs": ["acme"], "referrerSources": ["default"], "perGroup": 1,
    }));
    let row = serde_json::to_value(&b.store.read_referrer_group_rows(&input).unwrap()[0]).unwrap();
    assert_eq!(
        row,
        json!({"id": row["id"], "slug": "standup", "source_id": "default", "type": "call", "canonical_type": "call",
               "d": "2026-02-01T00:00:00.000000Z", "gtotal": 1})
    );
}

#[test]
fn referrer_page_details_bound_the_body_and_name_the_date_source() {
    let b = Brain::new("lt-referrer-details");
    let put = |slug: &str, extra: Value| -> u64 {
        let mut input = json!({"type": "note", "title": format!("Title {slug}"), "compiled_truth": format!("{slug} body")});
        input
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        let input: PageInput = de(input);
        let options: PutPageOptions = de(json!({"sourceId": "default", "index": false}));
        b.store.put_page(slug, &input, &options).unwrap()["id"]
            .as_u64()
            .unwrap()
    };
    let long = put(
        "long",
        json!({"compiled_truth": "é".repeat(4100), "frontmatter": {"quarantine": {"reason": "test"}}}),
    );
    let dated = put(
        "dated",
        json!({"effective_date": "2026-02-01T00:00:00.000Z", "effective_date_source": "event_date"}),
    );
    let undated = put("undated", json!({}));
    let read = |ids: Vec<u64>| {
        let input: ReferrerPageDetailsInput = de(json!({"ids": ids}));
        serde_json::to_value(b.store.read_referrer_page_details(&input).unwrap()).unwrap()
    };
    let rows = read(vec![undated, long, dated, long, 9999]);
    let rows = rows.as_array().unwrap();
    assert_eq!(rows.len(), 3);
    assert_eq!(rows[0]["id"], long);
    assert_eq!(rows[0]["body"].as_str().unwrap().chars().count(), 4000);
    assert_eq!(
        rows[0]["frontmatter"],
        json!({"quarantine": {"reason": "test"}})
    );
    assert_eq!(rows[1]["date_source"], "event_date");
    assert_eq!(
        rows[2],
        json!({"id": undated, "title": "Title undated", "body": "undated body", "date_source": "updated_at",
               "trust_tier": rows[2]["trust_tier"], "write_origin": rows[2]["write_origin"], "flagged": false,
               "frontmatter": {}})
    );
    assert!(read(vec![]).as_array().unwrap().is_empty());
}

#[test]
fn referrer_target_counts_per_index_exclude_only_that_index() {
    let b = Brain::new("lt-referrer-counts");
    let typed = |slug: &str, page_type: &str, frontmatter: Value| {
        let input: PageInput = de(json!({
            "type": page_type, "title": slug, "compiled_truth": format!("{slug} body"), "frontmatter": frontmatter,
        }));
        let options: PutPageOptions = de(json!({"sourceId": "default", "index": false}));
        b.store.put_page(slug, &input, &options).unwrap();
    };
    typed("acme", "company", json!({}));
    typed("acme-alt", "company", json!({}));
    typed("alice", "person", json!({}));
    typed("standup", "call", json!({}));
    typed("review", "meeting", json!({}));
    typed("n1", "note", json!({}));
    typed("secret", "note", json!({"visibility": "private"}));
    typed("held", "note", json!({"quarantine": true}));
    for (from, to) in [
        ("standup", "acme"),
        ("review", "acme"),
        ("n1", "acme"),
        ("n1", "acme-alt"),
        ("secret", "acme"),
        ("held", "acme"),
        ("alice", "acme"),
        ("acme-alt", "acme"),
        ("acme", "alice"),
        ("review", "alice"),
    ] {
        b.link(from, to, "mentions");
    }
    let read = |exclude: Value, record_types: Value| {
        let input: ReferrerTargetCountInput = de(json!({
            "targetSources": ["default", "default", "default", "default"],
            "targetSlugs": ["acme", "acme-alt", "alice", "nobody"], "targetIndexes": [0, 0, 1, 2],
            "referrerSources": ["default"], "storedTypes": ["call"], "canonicalTypes": ["meeting"],
            "recordTypes": record_types, "excludePrivate": exclude,
        }));
        let rows =
            serde_json::to_value(b.store.read_referrer_target_counts(&input).unwrap()).unwrap();
        rows.as_array()
            .unwrap()
            .iter()
            .map(|r| {
                format!(
                    "{}:{}:{}",
                    r["i"],
                    r["canonical_type"].as_str().unwrap_or("*"),
                    r["n"]
                )
            })
            .collect::<Vec<_>>()
    };
    assert_eq!(
        read(Value::Null, json!(["person", "meeting"])),
        ["0:*:5", "0:meeting:2", "0:person:1", "1:*:2", "1:meeting:1"]
    );
    assert_eq!(
        read(
            json!({"honorAliases": false, "entityPrivacy": true}),
            json!([])
        ),
        ["0:*:4", "1:*:2"]
    );
}

/// The referrer page fixture: `acme` with six dated referrers (two on one date), one private, one
/// quarantined and one soft-deleted.
fn referrer_page_brain(name: &str) -> Brain {
    let b = Brain::new(name);
    let dated = |slug: &str, page_type: &str, date: &str, frontmatter: Value| {
        let input: PageInput = de(json!({
            "type": page_type, "title": format!("Title {slug}"), "compiled_truth": format!("{slug} body"), "frontmatter": frontmatter,
            "effective_date": format!("{date}T00:00:00.000Z"), "effective_date_source": "date",
        }));
        let options: PutPageOptions = de(json!({"sourceId": "default", "index": false}));
        b.store.put_page(slug, &input, &options).unwrap();
    };
    b.page("acme");
    dated("kickoff", "meeting", "2026-03-01", json!({}));
    dated("review", "meeting", "2026-05-01", json!({}));
    dated("standup", "call", "2026-02-15", json!({}));
    dated("b-tie", "note", "2026-04-01", json!({}));
    dated("a-tie", "note", "2026-04-01", json!({}));
    dated("loose", "", "2026-02-01", json!({}));
    dated(
        "secret",
        "note",
        "2026-06-01",
        json!({"visibility": "private"}),
    );
    dated("held", "note", "2026-06-02", json!({"quarantine": true}));
    dated("gone", "note", "2026-07-01", json!({}));
    for slug in [
        "kickoff", "review", "standup", "b-tie", "a-tie", "loose", "secret", "held", "gone",
    ] {
        b.link(slug, "acme", "mentions");
    }
    b.store.soft_delete_page("gone", Some("default")).unwrap();
    b
}

fn referrer_rows(b: &Brain, extra: Value) -> Vec<String> {
    let mut input = json!({
        "targetSources": ["default"], "targetSlugs": ["acme"], "referrerSources": ["default"],
        "storedTypes": ["call"], "canonicalTypes": ["meeting"], "limit": 100,
    });
    input
        .as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    let input: ReferrerRowInput = de(input);
    let rows = serde_json::to_value(b.store.read_referrer_rows(&input).unwrap()).unwrap();
    rows.as_array()
        .unwrap()
        .iter()
        .map(|r| {
            format!(
                "{}:{}",
                r["canonical_type"].as_str().unwrap(),
                r["slug"].as_str().unwrap()
            )
        })
        .collect()
}

#[test]
fn referrer_rows_page_newest_first_and_continue_after_the_cursor() {
    let b = referrer_page_brain("lt-referrer-rows");
    assert_eq!(
        referrer_rows(&b, json!({})),
        [
            "note:secret",
            "meeting:review",
            "note:a-tie",
            "note:b-tie",
            "meeting:kickoff",
            "meeting:standup",
            "untyped:loose"
        ]
    );
    let private = json!({"honorAliases": false, "entityPrivacy": true});
    assert_eq!(
        referrer_rows(&b, json!({"excludePrivate": private, "limit": 2})),
        ["meeting:review", "note:a-tie"]
    );
    // After the first tie row: the second tie row (same date, greater slug), then older rows.
    assert_eq!(
        referrer_rows(
            &b,
            json!({"cursor": ["2026-04-01T00:00:00.000000Z", "default", "a-tie"], "limit": 3})
        ),
        ["note:b-tie", "meeting:kickoff", "meeting:standup"]
    );
    // The type filter takes the canonical type (the `call` alias included) or a stored type.
    assert_eq!(
        referrer_rows(&b, json!({"type": "meeting"})),
        ["meeting:review", "meeting:kickoff", "meeting:standup"]
    );
    assert_eq!(
        referrer_rows(&b, json!({"type": "call"})),
        ["meeting:standup"]
    );
    assert_eq!(
        referrer_rows(&b, json!({"type": "untyped"})),
        ["untyped:loose"]
    );
    // A cursor with no date continues with nothing; one that is not a time is refused.
    assert!(referrer_rows(&b, json!({"cursor": [null, "default", "a-tie"]})).is_empty());
    let bad: ReferrerRowInput = de(
        json!({"targetSources": ["default"], "targetSlugs": ["acme"],
        "referrerSources": ["default"], "cursor": ["yesterday", "default", "a-tie"], "limit": 5}),
    );
    assert!(b.store.read_referrer_rows(&bad).is_err());
    let count = |extra: Value| {
        let mut input = json!({"targetSources": ["default"], "targetSlugs": ["acme"], "referrerSources": ["default"],
            "storedTypes": ["call"], "canonicalTypes": ["meeting"]});
        input
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        let input: ReferrerRowInput = de(input);
        b.store.count_referrer_rows(&input).unwrap()
    };
    assert_eq!(count(json!({})), 7);
    assert_eq!(count(json!({"excludePrivate": private})), 6);
    assert_eq!(count(json!({"type": "meeting"})), 3);
    assert_eq!(count(json!({"includeQuarantined": true})), 8);
    let row: ReferrerRowInput = de(
        json!({"targetSources": ["default"], "targetSlugs": ["acme"],
        "referrerSources": ["default"], "type": "untyped", "limit": 1}),
    );
    let row = serde_json::to_value(&b.store.read_referrer_rows(&row).unwrap()[0]).unwrap();
    assert_eq!(
        row,
        json!({"id": row["id"], "slug": "loose", "source_id": "default", "type": "", "canonical_type": "untyped",
               "d": "2026-02-01T00:00:00.000000Z"})
    );
}

#[test]
fn referrer_types_list_each_canonical_and_stored_pair_once() {
    let b = referrer_page_brain("lt-referrer-types");
    let read = |extra: Value| {
        let mut input = json!({"targetSources": ["default"], "targetSlugs": ["acme"], "referrerSources": ["default"],
            "storedTypes": ["call"], "canonicalTypes": ["meeting"]});
        input
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        let input: ReferrerRowInput = de(input);
        let rows = serde_json::to_value(b.store.read_referrer_types(&input).unwrap()).unwrap();
        rows.as_array()
            .unwrap()
            .iter()
            .map(|r| {
                format!(
                    "{}:{}",
                    r["canonical_type"].as_str().unwrap(),
                    r["type"].as_str().unwrap()
                )
            })
            .collect::<Vec<_>>()
    };
    // Two meetings and two notes appear once each; the `call` alias keeps its own pair; an untyped
    // referrer's stored type is empty. The type filter does not apply.
    let all = ["meeting:call", "meeting:meeting", "note:note", "untyped:"];
    assert_eq!(read(json!({})), all);
    assert_eq!(read(json!({"type": "meeting"})), all);
    // Without the alias pairs, `call` is its own canonical type.
    assert_eq!(
        read(json!({"storedTypes": [], "canonicalTypes": []})),
        ["call:call", "meeting:meeting", "note:note", "untyped:"]
    );
    assert!(read(json!({"targetSlugs": ["nobody"]})).is_empty());
}

#[test]
fn referrer_target_sources_name_the_live_page_sources_in_input_order() {
    let b = referrer_page_brain("lt-referrer-sources");
    let read = |slug: &str, sources: Value| {
        let input: ReferrerTargetSourcesInput = de(json!({"slug": slug, "sources": sources}));
        b.store.list_referrer_target_sources(&input).unwrap()
    };
    assert_eq!(
        read("acme", json!(["other", "default", "default"])),
        ["default"]
    );
    assert!(read("gone", json!(["default"])).is_empty());
    assert!(read("acme", json!([])).is_empty());
}

#[test]
fn referrer_record_candidates_keep_the_newest_per_index_and_name_titles() {
    let b = referrer_page_brain("lt-referrer-records");
    b.page("widget");
    b.link("review", "widget", "mentions");
    let read = |per_target: u64, exclude: Value| {
        let input: ReferrerRecordCandidateInput = de(json!({
            "targetSources": ["default", "default", "default"], "targetSlugs": ["acme", "widget", "nobody"],
            "targetIndexes": [0, 1, 2], "referrerSources": ["default"], "storedTypes": ["call"],
            "canonicalTypes": ["meeting"], "recordTypes": ["meeting", "note"], "excludePrivate": exclude,
            "perTarget": per_target,
        }));
        let rows =
            serde_json::to_value(b.store.read_referrer_record_candidates(&input).unwrap()).unwrap();
        rows.as_array()
            .unwrap()
            .iter()
            .map(|r| {
                format!(
                    "{}:{}:{}:{}",
                    r["i"],
                    r["canonical_type"].as_str().unwrap(),
                    r["slug"].as_str().unwrap(),
                    r["d"].as_str().unwrap()
                )
            })
            .collect::<Vec<_>>()
    };
    assert_eq!(
        read(3, Value::Null),
        [
            "0:note:secret:2026-06-01T00:00:00.000000Z",
            "0:meeting:review:2026-05-01T00:00:00.000000Z",
            "0:note:a-tie:2026-04-01T00:00:00.000000Z",
            "1:meeting:review:2026-05-01T00:00:00.000000Z"
        ]
    );
    assert_eq!(
        read(1, json!({"honorAliases": false, "entityPrivacy": true})),
        [
            "0:meeting:review:2026-05-01T00:00:00.000000Z",
            "1:meeting:review:2026-05-01T00:00:00.000000Z"
        ]
    );
    let id_of = |slug: &str| {
        let input: ReferrerRowInput = de(
            json!({"targetSources": ["default"], "targetSlugs": ["acme"],
            "referrerSources": ["default"], "limit": 100}),
        );
        b.store
            .read_referrer_rows(&input)
            .unwrap()
            .into_iter()
            .find(|r| r.slug == slug)
            .unwrap()
            .id
    };
    let (review, loose) = (id_of("review"), id_of("loose"));
    let input: ReferrerPageDetailsInput = de(json!({"ids": [loose, review, review, 9999]}));
    let rows = serde_json::to_value(b.store.read_referrer_record_pages(&input).unwrap()).unwrap();
    let mut rows = rows.as_array().unwrap().clone();
    rows.sort_by_key(|r| r["title"].as_str().unwrap().to_string());
    assert_eq!(
        rows,
        [
            json!({"id": loose, "title": "Title loose", "date_source": "date"}),
            json!({"id": review, "title": "Title review", "date_source": "date"})
        ]
    );
}

#[test]
fn page_reference_date_is_the_effective_date_else_the_update_time_of_a_live_page() {
    let b = Brain::new("link-temporal-reference-date");
    b.page_with("dated", json!({}));
    let input: PageInput = de(json!({
        "type": "note", "title": "Dated", "compiled_truth": "dated body", "frontmatter": {},
        "effective_date": "2026-01-02T03:04:05.123Z", "effective_date_source": "date",
    }));
    let options: PutPageOptions = de(json!({"sourceId": "default", "index": false}));
    b.store.put_page("dated", &input, &options).unwrap();
    b.page("undated");
    b.page("gone");
    b.store.soft_delete_page("gone", Some("default")).unwrap();
    let read = |slug: &str| b.store.read_page_reference_date("default", slug).unwrap();
    assert_eq!(
        read("dated").as_deref(),
        Some("2026-01-02T03:04:05.123000Z")
    );
    let undated = read("undated").unwrap();
    assert_eq!(undated.len(), "2026-01-02T03:04:05.123000Z".len());
    assert!(undated.ends_with('Z'));
    assert_eq!(read("gone"), None);
    assert_eq!(read("never"), None);
    assert_eq!(
        b.store
            .read_page_reference_date("elsewhere", "dated")
            .unwrap(),
        None
    );
}
