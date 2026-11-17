//! The key layout. One byte of tag, then the parts of the key. Parts that are text never contain
//! NUL (callers' text is checked on the way in), so NUL separates parts without ambiguity, and
//! numbers are big-endian so byte order is numeric order.

pub const META: u8 = b'M';
pub const CONFIG: u8 = b'C';
pub const SOURCE: u8 = b'S';
pub const PAGE: u8 = b'P';
pub const PAGE_ID: u8 = b'I';
pub const CHUNK: u8 = b'K';
pub const POSTING: u8 = b'T';
pub const VERSION: u8 = b'V';
pub const REQUEST: u8 = b'J';
pub const REQUEST_ID: u8 = b'j';
pub const WRITER: u8 = b'W';

pub fn text(tag: u8, parts: &[&str]) -> Vec<u8> {
    let mut key = vec![tag];
    for (i, part) in parts.iter().enumerate() {
        if i > 0 {
            key.push(0);
        }
        key.extend_from_slice(part.as_bytes());
    }
    key
}

pub fn meta(name: &str) -> Vec<u8> {
    text(META, &[name])
}

/// `P source \0 slug`
pub fn page(source_id: &str, slug: &str) -> Vec<u8> {
    text(PAGE, &[source_id, slug])
}

pub fn page_id(id: u64) -> Vec<u8> {
    let mut key = vec![PAGE_ID];
    key.extend_from_slice(&id.to_be_bytes());
    key
}

/// `K page_id chunk_index`
pub fn chunk(page_id: u64, index: u32) -> Vec<u8> {
    let mut key = chunk_prefix(page_id);
    key.extend_from_slice(&index.to_be_bytes());
    key
}

pub fn chunk_prefix(page_id: u64) -> Vec<u8> {
    let mut key = vec![CHUNK];
    key.extend_from_slice(&page_id.to_be_bytes());
    key
}

/// `T term \0 page_id chunk_index`
pub fn posting(term: &str, page_id: u64, index: u32) -> Vec<u8> {
    let mut key = posting_prefix(term);
    key.extend_from_slice(&page_id.to_be_bytes());
    key.extend_from_slice(&index.to_be_bytes());
    key
}

pub fn posting_prefix(term: &str) -> Vec<u8> {
    let mut key = text(POSTING, &[term]);
    key.push(0);
    key
}

/// `V page_id version`
pub fn version(page_id: u64, version: u64) -> Vec<u8> {
    let mut key = version_prefix(page_id);
    key.extend_from_slice(&version.to_be_bytes());
    key
}

pub fn version_prefix(page_id: u64) -> Vec<u8> {
    let mut key = vec![VERSION];
    key.extend_from_slice(&page_id.to_be_bytes());
    key
}

pub fn be8(bytes: &[u8]) -> Option<u64> {
    Some(u64::from_be_bytes(bytes.try_into().ok()?))
}

pub fn be4(bytes: &[u8]) -> Option<u32> {
    Some(u32::from_be_bytes(bytes.try_into().ok()?))
}
