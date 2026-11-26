//! The id counters the import raises, and the check that none of them sits at or below an id the
//! primary already used (`allocatorCheck`).

use super::{check_seed, check_seed_id, invalid};
use crate::Store;
use crate::error::{Result, STORE_CORRUPT, StoreError};
use crate::kv::KvRead;
use crate::{keys, seed};
use serde::Serialize;
use std::collections::BTreeMap;

/// Where a relation's next id comes from.
enum Counter {
    /// `M <name>`: the next id, big-endian; 1 when unused.
    Meta(&'static str),
    /// A jobs-family sequence: the last id handed out; 0 when unused.
    Seq(&'static str),
}

/// The relations whose import raises an id counter, and the counter. A relation not listed keeps
/// no integer id counter (its rows are keyed by text or by natural key).
const ALLOCATORS: &[(&str, Counter)] = &[
    ("pages", Counter::Meta(crate::pages::NEXT_PAGE_ID)),
    (
        "content_chunks",
        Counter::Meta(crate::chunks::NEXT_CHUNK_ID),
    ),
    ("links", Counter::Meta(crate::links::NEXT_LINK_ID)),
    (
        "timeline_entries",
        Counter::Meta(crate::timeline::NEXT_TIMELINE_ID),
    ),
    ("facts", Counter::Meta(crate::facts::COUNTER)),
    ("takes", Counter::Meta(crate::takes::NEXT_TAKE_ID)),
    (
        "page_versions",
        Counter::Meta(crate::pages::NEXT_VERSION_ID),
    ),
    ("files", Counter::Meta(crate::raw_files::NEXT_FILE_ID)),
    ("code_edges_chunk", Counter::Meta("next_code_edge_chunk")),
    ("code_edges_symbol", Counter::Meta("next_code_edge_symbol")),
    ("open_loops", Counter::Meta(crate::facts::loops::COUNTER)),
    (
        "core_edit_notices",
        Counter::Meta(crate::core_edit_notices::COUNTER),
    ),
    ("trust_proposals", Counter::Meta("trust_proposals")),
    (
        "wanted_links",
        Counter::Meta(crate::wanted_links::ID_COUNTER),
    ),
    ("mcp_spend_log", Counter::Seq("mcp_spend_log")),
    (
        "decide_calibrations",
        Counter::Meta(crate::eval_capture::decide_store::CALIBRATION_ID),
    ),
    (
        "decision_receipts",
        Counter::Meta(crate::eval_capture::decide_store::RECEIPT_ID),
    ),
    (
        "decide_proposals",
        Counter::Meta(crate::eval_capture::decide_proposals::NEXT_PROPOSAL_ID),
    ),
    (
        "decide_review_proposals",
        Counter::Meta(crate::eval_capture::decide_proposals::NEXT_REVIEW_PROPOSAL_ID),
    ),
    (
        "calibration_profiles",
        Counter::Meta(crate::eval_capture::calibration_profiles::NEXT_ID),
    ),
    (
        "derived_generations",
        Counter::Meta(crate::generations::ID_COUNTER),
    ),
    ("wake_cron_runs", Counter::Seq("wake_cron_run")),
    ("wake_forgets", Counter::Seq("wake_forget")),
];

/// One relation's counter against the primary's highest id.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AllocatorCheck {
    pub relation: String,
    /// The id the store hands out next, as text.
    pub counter: String,
    /// The primary's highest id, as text; `None` when its table is empty.
    pub primary_max: Option<String>,
    /// The counter is above the primary's highest id (true when the table is empty).
    pub ok: bool,
}

impl Counter {
    /// The id the store would hand out next.
    fn next(&self, read: &dyn KvRead) -> Result<u64> {
        match self {
            Counter::Meta(name) => match read.get(&keys::meta(name))? {
                Some(bytes) => keys::be8(&bytes)
                    .ok_or_else(|| StoreError::new(STORE_CORRUPT, "bad id counter")),
                None => Ok(1),
            },
            Counter::Seq(name) => Ok(u64::try_from(crate::jobs::read_seq(read, name)?)
                .map_err(|_| StoreError::new(STORE_CORRUPT, "bad id sequence"))?
                + 1),
        }
    }
}

/// The relations that keep an id counter, in import order.
pub(super) fn counted_relations() -> Vec<&'static str> {
    seed::plan()
        .relations
        .iter()
        .map(|r| r.relation)
        .filter(|r| ALLOCATORS.iter().any(|(name, _)| name == r))
        .collect()
}

impl Store {
    /// `allocatorCheck(seedId, primaryMax)`: for every relation that keeps an id counter, the
    /// counter against `primary_max[relation]`, the primary's highest id as text (`None`: empty).
    /// An unknown relation in the map is `invalid_argument`, as is a value that is not a
    /// non-negative whole number. Read only.
    pub fn allocator_check(
        &self,
        seed_id: &str,
        primary_max: &BTreeMap<String, Option<String>>,
    ) -> Result<Vec<AllocatorCheck>> {
        check_seed_id(seed_id)?;
        let planned = counted_relations();
        let all: Vec<&str> = seed::plan().relations.iter().map(|r| r.relation).collect();
        let mut maxima = BTreeMap::new();
        for (relation, max) in primary_max {
            if !all.contains(&relation.as_str()) {
                return Err(invalid(format!(
                    "shadow_follow: unknown relation {relation:?} in primary_max"
                )));
            }
            let parsed = match max {
                Some(text) => Some(parse_id(relation, text)?),
                None => None,
            };
            maxima.insert(relation.as_str(), parsed);
        }
        let read = self.read()?;
        check_seed(&*read, seed_id)?;
        let mut out = Vec::new();
        for relation in planned {
            let Some((_, counter)) = ALLOCATORS.iter().find(|(name, _)| *name == relation) else {
                continue;
            };
            let next = counter.next(&*read)?;
            let max = maxima.get(relation).copied().flatten();
            out.push(AllocatorCheck {
                relation: relation.to_owned(),
                counter: next.to_string(),
                primary_max: max.map(|m| m.to_string()),
                ok: max.is_none_or(|m| next > m),
            });
        }
        Ok(out)
    }
}

fn parse_id(relation: &str, text: &str) -> Result<u64> {
    text.parse::<u64>().map_err(|_| {
        invalid(format!(
            "shadow_follow: primary_max of {relation} is not a non-negative whole number"
        ))
    })
}
