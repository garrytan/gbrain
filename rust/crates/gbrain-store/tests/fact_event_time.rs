//! Unknown event dates written by the actual store, across close and reopen.

mod common;

use common::{TempDir, open};
use gbrain_store::facts::cycle::BulkDayQuery;
use gbrain_store::facts::{FactQuery, InsertFactArgs, InsertFactsArgs, TrajectoryQuery};
use gbrain_store::kv::Kv;
use gbrain_store::redb_kv::RedbKv;
use serde_json::{Value, from_value, json};

#[test]
fn new_unknown_dates_survive_reopen_without_entering_the_event_axis() {
    let dir = TempDir::new("fact-event-time");
    let store = open(&dir);
    let unknown = store.insert_fact(&from_value::<InsertFactArgs>(json!({
        "sourceId": "default",
        "input": { "fact": "Unknown event", "source": "test", "entity_slug": "example", "valid_from": null },
    })).unwrap()).unwrap();
    let inserted = store.insert_facts(&from_value::<InsertFactsArgs>(json!({
        "sourceId": "default", "rows": [
            { "fact": "Known event", "source": "test", "entity_slug": "example", "valid_from": "2025-04-28T00:00:00.000Z" },
            { "fact": "Omitted event", "source": "test", "entity_slug": "example" },
        ]
    })).unwrap()).unwrap();
    assert_eq!(inserted["inserted"], 2);
    store.close();

    let store = open(&dir);
    let mut query = FactQuery {
        source_id: "default".into(),
        entity_slug: Some("example".into()),
        limit: 10.0,
        since: Some("2025-01-01T00:00:00.000Z".into()),
        ..FactQuery::default()
    };
    let rows = store.list_facts_by_entity(&query).unwrap();
    let found = |id: &Value| rows.iter().find(|row| &row["id"] == id).unwrap();
    assert_eq!(found(&unknown["id"])["valid_from"], Value::Null);
    assert_eq!(found(&inserted["ids"][1])["valid_from"], Value::Null);
    assert_eq!(
        found(&inserted["ids"][0])["valid_from"],
        "2025-04-28T00:00:00.000000Z"
    );
    assert!(found(&unknown["id"])["created_at"].is_string());
    assert_eq!(store.list_facts_since(&query).unwrap().len(), 3);
    query.event_time = true;
    let event_rows = store.list_facts_since(&query).unwrap();
    assert_eq!(event_rows.len(), 1);
    assert_eq!(event_rows[0]["id"], inserted["ids"][0]);
    query.include_undated = true;
    assert_eq!(store.list_facts_since(&query).unwrap().len(), 3);
    let trajectory = store
        .find_trajectory(&TrajectoryQuery {
            source_ids: vec!["default".into()],
            entity_slug: "example".into(),
            limit: 10.0,
            ..TrajectoryQuery::default()
        })
        .unwrap();
    assert_eq!(trajectory.len(), 1);
    assert_eq!(trajectory[0]["fact_id"], inserted["ids"][0]);
    let days = store
        .find_bulk_fact_days(
            &from_value::<BulkDayQuery>(json!({
                "rule": { "minFacts": 1, "minEntities": 1, "minShare": 0 }
            }))
            .unwrap(),
        )
        .unwrap();
    assert_eq!(days.len(), 1);
    assert_eq!(days[0]["day"], "2025-04-28");
    assert_eq!(days[0]["facts"], 1);
    assert_eq!(days[0]["source_facts"], 3);
}

#[test]
fn format_one_numeric_facts_keep_their_bytes_when_the_internal_marker_advances() {
    let dir = TempDir::new("legacy-fact-date");
    let store = open(&dir);
    let written = store.insert_fact(&from_value::<InsertFactArgs>(json!({
        "sourceId": "default",
        "input": { "fact": "Legacy dated event", "source": "test", "valid_from": "2025-04-28T00:00:00.000Z" },
    })).unwrap()).unwrap();
    let brain_id = store.brain_id().to_string();
    let path = dir.path().join("brain");
    store.close();

    // Format one stores the known date as the same JSON number.
    let mut row_key = vec![gbrain_store::keys::FACT, 1];
    row_key.extend_from_slice(&written["id"].as_u64().unwrap().to_be_bytes());
    let format_key = gbrain_store::keys::meta("format");
    let db = RedbKv::open_path(&path.join("records.redb")).unwrap();
    let mut tx = db.begin_write().unwrap();
    let bytes = tx.get(&row_key).unwrap().unwrap();
    assert!(serde_json::from_slice::<Value>(&bytes).unwrap()["valid_from_us"].is_i64());
    let mut format: Value = serde_json::from_slice(&tx.get(&format_key).unwrap().unwrap()).unwrap();
    format["format_version"] = json!(1);
    tx.put(&format_key, &serde_json::to_vec(&format).unwrap())
        .unwrap();
    tx.commit().unwrap();
    drop(db);
    let format_file = path.join("FORMAT");
    let mut external: Value =
        serde_json::from_slice(&std::fs::read(&format_file).unwrap()).unwrap();
    external["format_version"] = json!(1);
    std::fs::write(&format_file, serde_json::to_vec(&external).unwrap()).unwrap();

    let upgraded = open(&dir);
    assert_eq!(upgraded.brain_id(), brain_id);
    assert_eq!(upgraded.info().format_version, 2);
    assert!(!upgraded.info().created);
    let rows = upgraded
        .list_facts_by_entity(&FactQuery {
            source_id: "default".into(),
            limit: 10.0,
            ..FactQuery::default()
        })
        .unwrap();
    assert_eq!(rows[0]["id"], written["id"]);
    assert_eq!(rows[0]["valid_from"], "2025-04-28T00:00:00.000000Z");
    upgraded.close();
    let db = RedbKv::open_path(&path.join("records.redb")).unwrap();
    assert_eq!(
        db.snapshot().unwrap().get(&row_key).unwrap().unwrap(),
        bytes
    );
    let external: Value = serde_json::from_slice(&std::fs::read(&format_file).unwrap()).unwrap();
    assert_eq!(external["format_version"], 2);
}
