//! Writes the shadow-seed fixture with the v0.60.766.0 Rust store (origin/master rust/, byte-identical to
//! ae4bef02ce): seeds rows.json through `Store::import_relation_with_digests`, the path `gbrain engine shadow
//! seed` drives, then dumps every record of the redb file as hex pairs.
use gbrain_store::seed::{DigestInput, SeedRow};
use gbrain_store::{OpenOptions, Store};
use redb::{ReadableDatabase, ReadableTable, TableDefinition};
use serde_json::{Value, json};

const TABLE: TableDefinition<&[u8], &[u8]> = TableDefinition::new("kv");

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let rows: Value = serde_json::from_str(&std::fs::read_to_string(&args[1]).unwrap()).unwrap();
    let dir = std::path::PathBuf::from(&args[2]);
    let _ = std::fs::remove_dir_all(&dir);
    let seed_id = rows["seed_id"].as_str().unwrap();
    {
        let store = Store::open_dir(&dir, OpenOptions::default()).unwrap();
        for rel in rows["relations"].as_array().unwrap() {
            let name = rel[0].as_str().unwrap();
            let batch: Vec<SeedRow> = serde_json::from_value(rel[1].clone()).unwrap();
            let digests: Vec<DigestInput> = (0..batch.len())
                .map(|i| DigestInput { sort: format!("{:016x}", i + 1), digest: format!("{:064x}", i + 1) })
                .collect();
            let r = store.import_relation_with_digests(seed_id, name, batch, &digests).unwrap();
            eprintln!("{name}: imported {} skipped {}", r.imported, r.skipped);
        }
    }
    let db = redb::Database::open(dir.join("records.redb")).unwrap();
    let tx = db.begin_read().unwrap();
    let table = tx.open_table(TABLE).unwrap();
    let mut pairs = Vec::new();
    for item in table.iter().unwrap() {
        let (k, v) = item.unwrap();
        pairs.push(json!([hex(k.value()), hex(v.value())]));
    }
    println!("{}", serde_json::to_string_pretty(&json!({
        "written_by": "gbrain-store at origin/master 9ae266f1e8 (rust/crates identical to v0.60.766.0, ae4bef02ce)",
        "records": pairs,
    })).unwrap());
}
