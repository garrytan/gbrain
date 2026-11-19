//! Synthetic pages and chunks for the write-side workloads (the corpus feeds the import and read
//! sides; writes need fresh rows that never collide with it).

use crate::records::{Chunk, Page, DIMS};
use crate::util::Rng;

const LOREM: &str =
    "The quick brown fox keeps a ledger of every page it has read, and writes down only \
what it can verify. Short sentences age better than clever ones. A record that cannot be read back \
after a crash is not a record. ";

pub fn random_vector(rng: &mut Rng) -> Vec<f32> {
    let mut v: Vec<f32> = (0..DIMS).map(|_| rng.unit_f32() - 0.5).collect();
    let norm = v.iter().map(|x| x * x).sum::<f32>().sqrt().max(1e-9);
    for x in &mut v {
        *x /= norm;
    }
    v
}

pub fn random_chunks(rng: &mut Rng, n: u32) -> Vec<Chunk> {
    (0..n)
        .map(|idx| Chunk {
            idx,
            text: format!(
                "chunk {idx} {}",
                &LOREM[..(200 + rng.below(120)).min(LOREM.len())]
            ),
            vector: random_vector(rng),
        })
        .collect()
}

pub fn synth_page(id: u64, source: &str, slug: &str) -> Page {
    Page {
        id,
        source_id: source.to_string(),
        slug: slug.to_string(),
        page_type: "note".to_string(),
        title: format!("Synthetic {slug}"),
        frontmatter: "{\"synthetic\":true}".to_string(),
        body: LOREM.repeat(8),
        chunk_count: 0,
    }
}

pub const CRASH_SOURCE: &str = "bench-crash";

pub fn crash_slug(writer: u32, n: u32) -> String {
    format!("crash/{writer}-{n}")
}

/// Fully determined by (writer, n), so the parent can rebuild what an acknowledged write held.
pub fn crash_page(writer: u32, n: u32) -> (Page, Vec<Chunk>) {
    let mut rng = Rng::new(((writer as u64) << 32 | n as u64) + 0x9e37_79b9);
    (
        synth_page(0, CRASH_SOURCE, &crash_slug(writer, n)),
        random_chunks(&mut rng, 4),
    )
}
