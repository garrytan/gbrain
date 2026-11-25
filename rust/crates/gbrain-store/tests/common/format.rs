//! Old-format brain fixtures shared by the lifecycle and conformance tests.

use gbrain_store::kv::Kv;
use gbrain_store::redb_kv::RedbKv;

/// Rewrites a brain into format 1, the layout before the per-counter records: the chunk stats
/// and the unfinished-request counters are each one JSON record, and the format record says 1.
pub fn downgrade_to_format_1(brain: &std::path::Path) {
    use gbrain_store::keys;
    use gbrain_store::kv::{read_i64, scan_prefix};
    let kv = RedbKv::open_path(&brain.join("records.redb")).unwrap();
    let mut tx = kv.begin_write().unwrap();
    let chunks = read_i64(&*tx, &keys::meta("chunk_stats/chunks")).unwrap();
    let length = read_i64(&*tx, &keys::meta("chunk_stats/total_length")).unwrap();
    let brain_count = read_i64(&*tx, &keys::meta("journal_outstanding")).unwrap();
    let prefix = keys::meta("journal_outstanding/");
    let mut principals = serde_json::Map::new();
    let mut counter_keys = vec![
        keys::meta("chunk_stats/chunks"),
        keys::meta("chunk_stats/total_length"),
        keys::meta("journal_outstanding"),
    ];
    scan_prefix(&*tx, &prefix, false, &mut |k, v| {
        let name = std::str::from_utf8(&k[prefix.len()..]).unwrap().to_string();
        let n = i64::from_le_bytes(v.try_into().unwrap());
        principals.insert(name, n.into());
        counter_keys.push(k.to_vec());
        true
    })
    .unwrap();
    for key in counter_keys {
        tx.delete(&key).unwrap();
    }
    let put = |tx: &mut Box<dyn gbrain_store::KvWrite>, name: &str, v: serde_json::Value| {
        tx.put(&keys::meta(name), &serde_json::to_vec(&v).unwrap())
            .unwrap()
    };
    put(
        &mut tx,
        "chunk_stats",
        serde_json::json!({"chunks": chunks, "total_length": length}),
    );
    put(
        &mut tx,
        "journal_counters",
        serde_json::json!({"brain": brain_count, "principals": principals}),
    );
    let mut format: serde_json::Value =
        serde_json::from_slice(&tx.get(&keys::meta("format")).unwrap().unwrap()).unwrap();
    format["format_version"] = 1.into();
    put(&mut tx, "format", format);
    tx.commit().unwrap();
    let path = brain.join("FORMAT");
    let mut file: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    file["format_version"] = 1.into();
    std::fs::write(&path, serde_json::to_vec_pretty(&file).unwrap()).unwrap();
}

pub fn admission(n: u32) -> gbrain_store::journal::WriteAdmission {
    serde_json::from_value(serde_json::json!({
        "principal": {"kind": "local_cli", "id": "cli"}, "operation": "put_page",
        "sourceId": "default", "slug": format!("notes/held-{n}"),
        "requestId": format!("00000000-0000-4000-8000-{n:012}"),
        "callerIntent": {"slug": format!("notes/held-{n}")},
        "intent": {},
    }))
    .unwrap()
}
