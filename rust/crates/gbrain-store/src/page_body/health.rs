//! Read-only views of the segmented-body records for the doctor health reads
//! (`cli_reads/doctor_derived_health.rs`). They answer the questions the doctor statements put to
//! `page_body_manifest` and `page_segment_derivations`, so the private record types stay here.

use super::{
    DERIVATION, DerivationRecord, ManifestRow, collect, in_generation, kind_key, live_published,
    manifest_rows, read_body_state,
};
use crate::Result;
use crate::kv::KvRead;
use serde_json::Value;

/// The segmented-body columns of a page the doctor reads (`body_generation`, `body_bytes`,
/// `segment_count`).
pub(crate) struct SegmentedBody {
    pub generation: i64,
    pub bytes: Option<i64>,
    pub segments: Option<i64>,
}

/// The body columns of a page whose `body_storage` is `segmented`; `None` for an inline page, a
/// page with no body record or a missing page.
pub(crate) fn segmented_body(read: &dyn KvRead, page_id: u64) -> Result<Option<SegmentedBody>> {
    Ok(read_body_state(read, page_id)?
        .filter(|state| state.body_storage == "segmented")
        .map(|state| SegmentedBody {
            generation: state.body_generation,
            bytes: state.body_bytes,
            segments: state.segment_count,
        }))
}

/// What the tiling statement computes over the published rows of one generation.
pub(crate) struct Tiling {
    pub rows: i64,
    pub covered: i64,
    pub gapless: bool,
}

/// `count(*)`, `sum(byte_len)` and `bool_and(byte_start = <bytes before it>)` over the published
/// rows of `generation` in `seq` order (`UNTILED_SQL`): no row tiles an empty body.
pub(crate) fn tiling(read: &dyn KvRead, page_id: u64, generation: i64) -> Result<Tiling> {
    let mut rows: Vec<ManifestRow> = manifest_rows(read, page_id)?
        .into_iter()
        .map(|(_, row)| row)
        .filter(|row| in_generation(row, generation))
        .collect();
    rows.sort_by_key(|row| row.seq);
    let (mut prior, mut gapless) = (0i64, true);
    for row in &rows {
        gapless &= row.byte_start == prior;
        prior = prior.saturating_add(row.byte_len);
    }
    Ok(Tiling {
        rows: i64::try_from(rows.len()).unwrap_or(i64::MAX),
        covered: prior,
        gapless,
    })
}

/// `EXISTS (SELECT 1 FROM page_body_manifest m WHERE m.page_id = $1 AND m.gen_to IS NULL AND
/// m.staging_id IS NULL AND m.protected_regions @> '[{"kind":"pem"}]')`.
pub(crate) fn has_published_pem(read: &dyn KvRead, page_id: u64) -> Result<bool> {
    Ok(manifest_rows(read, page_id)?
        .iter()
        .filter(|(_, row)| live_published(row))
        .any(|(_, row)| {
            row.protected_regions.as_array().is_some_and(|regions| {
                regions
                    .iter()
                    .any(|region| region.get("kind").and_then(Value::as_str) == Some("pem"))
            })
        }))
}

/// One `page_segment_derivations` row.
pub(crate) struct Derivation {
    pub page_id: u64,
    pub pipeline: String,
    pub occurrence: i64,
    pub updated_at_us: i64,
    pub receipt: Value,
}

/// Every derivation of every page, in key order: page id, then pipeline, then occurrence id.
pub(crate) fn all_derivations(read: &dyn KvRead) -> Result<Vec<Derivation>> {
    let prefix = kind_key(DERIVATION);
    let mut out = Vec::new();
    for (key, record) in collect::<DerivationRecord>(read, &prefix)? {
        // `b 0x04 <page id, 8 bytes> <pipeline> 0x00 <occurrence id, 8 bytes, sign bit flipped>`
        let Some(tail) = key.get(prefix.len()..) else {
            continue;
        };
        let (Some(id), Some(rest)) = (tail.get(..8), tail.get(8..)) else {
            continue;
        };
        let Some(split) = rest.iter().position(|b| *b == 0) else {
            continue;
        };
        let (Ok(pipeline), Some(occ)) = (
            std::str::from_utf8(&rest[..split]),
            rest.get(split + 1..split + 9),
        ) else {
            continue;
        };
        let (Ok(id), Ok(occ)) = (<[u8; 8]>::try_from(id), <[u8; 8]>::try_from(occ)) else {
            continue;
        };
        out.push(Derivation {
            page_id: u64::from_be_bytes(id),
            pipeline: pipeline.to_string(),
            occurrence: (u64::from_be_bytes(occ) ^ (1u64 << 63)) as i64,
            updated_at_us: record.updated_at_us,
            receipt: record.receipt,
        });
    }
    Ok(out)
}
