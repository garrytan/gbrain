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
pub const LINK: u8 = b'L';
pub const LINK_TO: u8 = b'l';
pub const LINK_UNIQUE: u8 = b'U';
pub const LINK_ORIGIN: u8 = b'O';
pub const TIMELINE: u8 = b'E';
pub const TIMELINE_DEDUP: u8 = b'D';
pub const TIMELINE_LATEST: u8 = b'G';

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

/// `J request-uuid`
pub fn request(id: &str) -> Vec<u8> {
    text(REQUEST, &[id])
}

/// `j principal-kind \0 principal-id \0 request_id`: the idempotency index.
pub fn request_by_principal(kind: &str, principal_id: &str, request_id: &str) -> Vec<u8> {
    text(REQUEST_ID, &[kind, principal_id, request_id])
}

/// `W writer-id`
pub fn writer(id: &str) -> Vec<u8> {
    text(WRITER, &[id])
}

fn id_key(tag: u8, ids: &[u64]) -> Vec<u8> {
    let mut key = vec![tag];
    for id in ids {
        key.extend_from_slice(&id.to_be_bytes());
    }
    key
}

/// `L from_page_id link_id`: the link record, under the page it leaves.
pub fn link(from_page_id: u64, link_id: u64) -> Vec<u8> {
    id_key(LINK, &[from_page_id, link_id])
}

pub fn link_prefix(from_page_id: u64) -> Vec<u8> {
    id_key(LINK, &[from_page_id])
}

/// `l to_page_id link_id` -> `from_page_id`: the links that arrive at a page.
pub fn link_to(to_page_id: u64, link_id: u64) -> Vec<u8> {
    id_key(LINK_TO, &[to_page_id, link_id])
}

pub fn link_to_prefix(to_page_id: u64) -> Vec<u8> {
    id_key(LINK_TO, &[to_page_id])
}

/// `O origin_page_id link_id` -> `from_page_id`: the links a page authored.
pub fn link_origin(origin_page_id: u64, link_id: u64) -> Vec<u8> {
    id_key(LINK_ORIGIN, &[origin_page_id, link_id])
}

pub fn link_origin_prefix(origin_page_id: u64) -> Vec<u8> {
    id_key(LINK_ORIGIN, &[origin_page_id])
}

/// `U from to link_type \0 source origin` -> `link_id`: the
/// `UNIQUE NULLS NOT DISTINCT (from_page_id, to_page_id, link_type, link_source, origin_page_id)`
/// constraint. `source` is byte 0 for a NULL `link_source`, else byte 1, the text and `\0`.
/// Origin 0 stands for NULL (page ids start at 1). Neither text holds a NUL.
pub fn link_unique(
    from: u64,
    to: u64,
    link_type: &str,
    link_source: Option<&str>,
    origin: Option<u64>,
) -> Vec<u8> {
    let mut key = id_key(LINK_UNIQUE, &[from, to]);
    key.extend_from_slice(link_type.as_bytes());
    key.push(0);
    match link_source {
        None => key.push(0),
        Some(text) => {
            key.push(1);
            key.extend_from_slice(text.as_bytes());
            key.push(0);
        }
    }
    key.extend_from_slice(&origin.unwrap_or(0).to_be_bytes());
    key
}

/// `E page_id date entry_id`: a timeline entry. `date` is the 10 bytes `YYYY-MM-DD`, so a reverse
/// scan of one page is `ORDER BY date DESC, id DESC`.
pub fn timeline(page_id: u64, date: &str, entry_id: u64) -> Vec<u8> {
    let mut key = timeline_prefix(page_id);
    key.extend_from_slice(date.as_bytes());
    key.extend_from_slice(&entry_id.to_be_bytes());
    key
}

pub fn timeline_prefix(page_id: u64) -> Vec<u8> {
    id_key(TIMELINE, &[page_id])
}

/// `D page_id date sha256(summary) source` -> `entry_id`: the
/// `(page_id, date, md5(summary), source)` dedup index.
pub fn timeline_dedup(
    page_id: u64,
    date: &str,
    summary_digest: &[u8; 32],
    source: &str,
) -> Vec<u8> {
    let mut key = timeline_dedup_prefix(page_id);
    key.extend_from_slice(date.as_bytes());
    key.extend_from_slice(summary_digest);
    key.extend_from_slice(source.as_bytes());
    key
}

pub fn timeline_dedup_prefix(page_id: u64) -> Vec<u8> {
    id_key(TIMELINE_DEDUP, &[page_id])
}

/// `G page_id` -> the newest `created_at` (microseconds, big-endian i64) of the page's entries.
pub fn timeline_latest(page_id: u64) -> Vec<u8> {
    id_key(TIMELINE_LATEST, &[page_id])
}
