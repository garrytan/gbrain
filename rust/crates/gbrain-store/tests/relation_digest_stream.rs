//! The streaming relation digest keeps no rows: its memory is flat however long the relation is.
//! This binary counts live heap bytes with its own allocator, so it holds one test only.

use gbrain_store::error::Result;
use gbrain_store::kv::KvRead;
use gbrain_store::seed::relation_digest_stream;
use sha2::{Digest as _, Sha256};
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering};

struct Counting;
static LIVE: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let live = LIVE.fetch_add(layout.size(), Ordering::SeqCst) + layout.size();
        PEAK.fetch_max(live, Ordering::SeqCst);
        unsafe { System.alloc(layout) }
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        LIVE.fetch_sub(layout.size(), Ordering::SeqCst);
        unsafe { System.dealloc(ptr, layout) }
    }
}

#[global_allocator]
static ALLOCATOR: Counting = Counting;

const ROWS: u32 = 300_000;

/// A relation of `ROWS` entries that exists only as the scan generates it.
struct Synthetic;

fn entry(i: u32) -> (Vec<u8>, Vec<u8>) {
    let mut record_id = b"Mshadow_digest/chunks/".to_vec();
    record_id.extend_from_slice(&i.to_be_bytes());
    let mut value = vec![(i % 251) as u8; 32];
    value.extend_from_slice(&0u64.to_be_bytes());
    value.extend_from_slice(br#"{"id":"0000000000","chunk_index":"0","page_id":"0000000000"}"#);
    (record_id, value)
}

impl KvRead for Synthetic {
    fn get(&self, _: &[u8]) -> Result<Option<Vec<u8>>> {
        Ok(None)
    }
    fn scan(
        &self,
        _: &[u8],
        _: &[u8],
        _: bool,
        f: &mut dyn FnMut(&[u8], &[u8]) -> bool,
    ) -> Result<()> {
        for i in 0..ROWS {
            let (key, value) = entry(i);
            if !f(&key, &value) {
                break;
            }
        }
        Ok(())
    }
}

#[test]
fn the_stream_holds_one_entry_at_a_time_and_matches_the_collected_encoding() {
    // What the collected algorithm hashes: u32be(len sort) || sort || digest for each entry.
    let mut expected = Sha256::new();
    for i in 0..ROWS {
        let (key, value) = entry(i);
        let sort = &key[b"Mshadow_digest/chunks/".len()..];
        expected.update((sort.len() as u32).to_be_bytes());
        expected.update(sort);
        expected.update(&value[..32]);
    }
    let expected: String = expected
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();

    let before = LIVE.load(Ordering::SeqCst);
    PEAK.store(before, Ordering::SeqCst);
    let digest = relation_digest_stream(&Synthetic, "chunks", None, None).unwrap();
    let growth = PEAK.load(Ordering::SeqCst) - before;
    assert_eq!((digest.rows, digest.digest), (u64::from(ROWS), expected));
    // Collecting the rows would hold at least ROWS * 100 bytes (30 MB).
    assert!(
        growth < 64 * 1024,
        "the stream grew the heap by {growth} bytes"
    );
}
