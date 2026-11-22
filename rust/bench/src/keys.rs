//! Order-preserving key encodings for the record layer. Byte-wise comparison of the encoded
//! keys must equal the comparison of the logical keys (tests below).
//!
//!   m/version                       meta: last committed version (see occ.rs)
//!   p <source> 00 <slug>            page record, ordered by (source_id, slug)
//!   i <page_id be64>                page-id index -> (source, slug)
//!   c <page_id be64> <idx be32>     chunk record, ordered by (page_id, chunk_index)
//!   k <name>                        counters (8-byte little-endian i64)

use crate::kv::prefix_end;

pub const PAGE: u8 = b'p';
pub const PAGE_ID: u8 = b'i';
pub const CHUNK: u8 = b'c';
pub const COUNTER: u8 = b'k';

pub fn page_key(source: &str, slug: &str) -> Vec<u8> {
    debug_assert!(!source.as_bytes().contains(&0) && !slug.as_bytes().contains(&0));
    let mut k = Vec::with_capacity(2 + source.len() + slug.len());
    k.push(PAGE);
    k.extend_from_slice(source.as_bytes());
    k.push(0);
    k.extend_from_slice(slug.as_bytes());
    k
}

/// Range covering every page of one source: `[start, end)`.
pub fn source_range(source: &str) -> (Vec<u8>, Vec<u8>) {
    let start = page_key(source, "");
    let end = prefix_end(&start).expect("page prefix is not all 0xFF");
    (start, end)
}

pub fn page_id_key(id: u64) -> Vec<u8> {
    let mut k = Vec::with_capacity(9);
    k.push(PAGE_ID);
    k.extend_from_slice(&id.to_be_bytes());
    k
}

pub fn page_id_range() -> (Vec<u8>, Vec<u8>) {
    (vec![PAGE_ID], vec![PAGE_ID + 1])
}

pub fn parse_page_id_key(k: &[u8]) -> Option<u64> {
    if k.len() == 9 && k[0] == PAGE_ID {
        Some(u64::from_be_bytes(k[1..9].try_into().unwrap()))
    } else {
        None
    }
}

pub fn chunk_key(page_id: u64, idx: u32) -> Vec<u8> {
    let mut k = Vec::with_capacity(13);
    k.push(CHUNK);
    k.extend_from_slice(&page_id.to_be_bytes());
    k.extend_from_slice(&idx.to_be_bytes());
    k
}

/// Range covering every chunk of one page.
pub fn page_chunks_range(page_id: u64) -> (Vec<u8>, Vec<u8>) {
    (chunk_key(page_id, 0), chunk_key(page_id, u32::MAX))
}

/// Range covering every chunk of every page (end is exclusive: the next prefix byte).
pub fn all_chunks_range() -> (Vec<u8>, Vec<u8>) {
    (vec![CHUNK], vec![CHUNK + 1])
}

pub fn parse_chunk_key(k: &[u8]) -> Option<(u64, u32)> {
    if k.len() == 13 && k[0] == CHUNK {
        Some((
            u64::from_be_bytes(k[1..9].try_into().unwrap()),
            u32::from_be_bytes(k[9..13].try_into().unwrap()),
        ))
    } else {
        None
    }
}

pub fn counter_key(name: &str) -> Vec<u8> {
    let mut k = vec![COUNTER];
    k.extend_from_slice(name.as_bytes());
    k
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pages_order_by_source_then_slug() {
        // A source that is a prefix of another must not interleave with it.
        let mut logical = vec![
            ("a", "z"),
            ("a", "a/b"),
            ("a", "a"),
            ("a-b", "a"),
            ("ab", "a"),
            ("a", ""),
            ("b", "a"),
        ];
        let mut encoded: Vec<_> = logical
            .iter()
            .map(|(s, l)| (page_key(s, l), (*s, *l)))
            .collect();
        encoded.sort();
        logical.sort();
        let from_keys: Vec<_> = encoded.into_iter().map(|(_, l)| l).collect();
        assert_eq!(from_keys, logical);
    }

    #[test]
    fn source_range_covers_exactly_one_source() {
        let (start, end) = source_range("a");
        for (s, slug, inside) in [
            ("a", "", true),
            ("a", "zzz", true),
            ("a-b", "x", false),
            ("b", "x", false),
            ("", "x", false),
        ] {
            let k = page_key(s, slug);
            assert_eq!(k >= start && k < end, inside, "{s}/{slug}");
        }
    }

    #[test]
    fn chunks_order_by_page_then_index_numerically() {
        let mut keys = [
            chunk_key(256, 0),
            chunk_key(1, 300),
            chunk_key(1, 2),
            chunk_key(2, 0),
            chunk_key(1, 256),
        ];
        keys.sort();
        let parsed: Vec<_> = keys.iter().map(|k| parse_chunk_key(k).unwrap()).collect();
        assert_eq!(parsed, vec![(1, 2), (1, 256), (1, 300), (2, 0), (256, 0)]);
    }

    #[test]
    fn page_chunks_range_is_one_page() {
        let (s, e) = page_chunks_range(7);
        assert!(chunk_key(7, 0) >= s && chunk_key(7, 5000) < e);
        assert!(chunk_key(6, u32::MAX) < s && chunk_key(8, 0) >= e);
    }

    #[test]
    fn page_ids_order_numerically_and_round_trip() {
        let mut ids = vec![10u64, 1, 256, 255, u64::MAX, 0];
        let mut keys: Vec<_> = ids.iter().map(|i| page_id_key(*i)).collect();
        keys.sort();
        ids.sort();
        let back: Vec<_> = keys.iter().map(|k| parse_page_id_key(k).unwrap()).collect();
        assert_eq!(back, ids);
    }

    #[test]
    fn key_classes_do_not_overlap() {
        // Each class has its own first byte, so a range scan of one class never leaves it.
        let firsts = [PAGE, PAGE_ID, CHUNK, COUNTER, b'm'];
        let mut sorted = firsts.to_vec();
        sorted.sort();
        sorted.dedup();
        assert_eq!(sorted.len(), firsts.len());
        let (cs, ce) = all_chunks_range();
        assert!(chunk_key(u64::MAX, u32::MAX) < ce && chunk_key(0, 0) >= cs);
        assert!(page_id_key(1) >= ce || page_id_key(1) < cs);
    }
}
