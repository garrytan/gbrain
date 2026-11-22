//! The same checks run against every real base store (redb, fjall, LMDB) and the in-memory one,
//! so a store that disagrees with the contract shows up here and not as a strange benchmark number.
//! Test stores live under `target/test-tmp/` (never the system temp dir).

use crate::children::check_consistency;
use crate::engine::{open_base, Engine};
use crate::kv::*;
use crate::mem_store::MemStore;
use crate::occ::{Db, Options};
use crate::records::*;
use std::path::PathBuf;
use std::sync::Arc;

pub fn test_dir(name: &str) -> PathBuf {
    static N: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = N.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("target")
        .join("test-tmp")
        .join(format!("{name}-{}-{n}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn engines() -> Vec<Option<Engine>> {
    vec![
        None,
        Some(Engine::Redb),
        Some(Engine::Fjall),
        Some(Engine::Lmdb),
    ]
}

fn open(engine: Option<Engine>, dir: &std::path::Path) -> Arc<dyn BaseStore> {
    match engine {
        None => Arc::new(MemStore::new()),
        Some(e) => open_base(e, dir).unwrap(),
    }
}

fn collect(
    snap: &dyn Snapshot,
    t: Table,
    s: &[u8],
    e: &[u8],
    rev: bool,
    limit: usize,
) -> Vec<Vec<u8>> {
    let mut out = Vec::new();
    snap.scan(t, s, e, rev, &mut |k, _| {
        out.push(k.to_vec());
        out.len() < limit
    })
    .unwrap();
    out
}

#[test]
fn every_store_honours_the_base_store_contract() {
    for engine in engines() {
        let dir = test_dir("contract");
        let store = open(engine, &dir);
        let name = store.name();
        let mut b = WriteBatch::default();
        for k in [&b"a"[..], b"b", b"c", b"d"] {
            b.put(Table::Data, k.to_vec(), k.to_vec());
        }
        b.put(Table::Log, b"x".to_vec(), b"1".to_vec());
        store.commit(&b).unwrap();

        let before = store.snapshot().unwrap();
        let mut b = WriteBatch::default();
        b.delete(Table::Data, b"b".to_vec());
        b.put(Table::Data, b"e".to_vec(), b"E".to_vec());
        store.commit(&b).unwrap();
        let after = store.snapshot().unwrap();

        // A snapshot taken before a commit never sees it.
        assert_eq!(
            before.get(Table::Data, b"b").unwrap().as_deref(),
            Some(&b"b"[..]),
            "{name}"
        );
        assert_eq!(before.get(Table::Data, b"e").unwrap(), None, "{name}");
        assert_eq!(after.get(Table::Data, b"b").unwrap(), None, "{name}");
        assert_eq!(
            after.get(Table::Data, b"e").unwrap().as_deref(),
            Some(&b"E"[..]),
            "{name}"
        );
        // Tables are separate.
        assert_eq!(after.get(Table::Log, b"a").unwrap(), None, "{name}");
        assert_eq!(
            after.get(Table::Log, b"x").unwrap().as_deref(),
            Some(&b"1"[..]),
            "{name}"
        );
        // Range scans: bounds, order, reverse, early stop, empty start, empty range.
        let keys = |v: Vec<Vec<u8>>| {
            v.into_iter()
                .map(|k| String::from_utf8(k).unwrap())
                .collect::<Vec<_>>()
        };
        assert_eq!(
            keys(collect(after.as_ref(), Table::Data, b"a", b"e", false, 99)),
            ["a", "c", "d"],
            "{name}"
        );
        assert_eq!(
            keys(collect(after.as_ref(), Table::Data, b"a", b"f", true, 99)),
            ["e", "d", "c", "a"],
            "{name}"
        );
        assert_eq!(
            keys(collect(after.as_ref(), Table::Data, b"a", b"f", false, 2)),
            ["a", "c"],
            "{name}"
        );
        assert_eq!(
            keys(collect(after.as_ref(), Table::Data, b"", b"d", false, 99)),
            ["a", "c"],
            "{name}"
        );
        assert!(
            collect(after.as_ref(), Table::Data, b"d", b"d", false, 99).is_empty(),
            "{name}"
        );
        assert!(
            collect(after.as_ref(), Table::Data, b"z", b"a", false, 99).is_empty(),
            "{name}"
        );
        drop((before, after, store));
        let _ = std::fs::remove_dir_all(&dir);
    }
}

fn page(id: u64, slug: &str) -> Page {
    Page {
        id,
        source_id: "s".into(),
        slug: slug.into(),
        page_type: "note".into(),
        title: slug.into(),
        frontmatter: "{}".into(),
        body: "b".into(),
        chunk_count: 0,
    }
}

fn chunks(n: u32, seed: f32) -> Vec<Chunk> {
    (0..n)
        .map(|idx| Chunk {
            idx,
            text: format!("t{idx}"),
            vector: vec![seed + idx as f32; DIMS],
        })
        .collect()
}

#[test]
fn records_survive_a_reopen_and_the_consistency_check_finds_damage() {
    for engine in engines() {
        let dir = test_dir("reopen");
        let first_version;
        {
            let db = Arc::new(Db::open(open(engine, &dir), Options::default()).unwrap());
            let records = Records::open(db).unwrap();
            let id = records.alloc_page_id();
            first_version = records
                .put_page_with_chunks(&page(id, "a"), &chunks(3, 1.0))
                .unwrap();
            let id = records.alloc_page_id();
            records
                .put_page_with_chunks(&page(id, "b"), &chunks(2, 2.0))
                .unwrap();
            // Replace page a with fewer chunks: the old chunk rows must go.
            records
                .put_page_with_chunks(&page(999, "a"), &chunks(1, 9.0))
                .unwrap();
            assert!(check_consistency(&records, true).unwrap().is_empty());
        }
        if engine.is_none() {
            continue; // the in-memory store has nothing to reopen
        }
        let db = Arc::new(Db::open(open(engine, &dir), Options::default()).unwrap());
        let records = Records::open(db.clone()).unwrap();
        let a = records.get_page("s", "a").unwrap().unwrap();
        assert_eq!(
            (a.id, a.chunk_count),
            (1, 1),
            "an existing page keeps its id on upsert"
        );
        assert_eq!(records.get_chunks(1).unwrap(), chunks(1, 9.0));
        assert_eq!(records.get_chunks(2).unwrap(), chunks(2, 2.0));
        assert!(db.published_version() > first_version);
        assert!(check_consistency(&records, true).unwrap().is_empty());
        assert_eq!(
            records.alloc_page_id(),
            3,
            "the id allocator resumes after reopen"
        );

        // Damage it behind the layer's back: an orphan chunk row and a log gap.
        let mut b = WriteBatch::default();
        b.put(Table::Data, crate::keys::chunk_key(77, 0), vec![0; 8]);
        db.store().commit(&b).unwrap();
        let problems = check_consistency(&records, true).unwrap();
        assert!(
            problems.iter().any(|p| p.contains("orphan")),
            "{problems:?}"
        );
        drop((records, db));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
