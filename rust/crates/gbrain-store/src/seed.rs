//! The shadow seed: `importRelation(seedId, relation, rows)` copies rows another engine holds
//! (PGLite or Postgres, read in one snapshot by `gbrain engine shadow seed`) into this store, with
//! their ids, timestamps, revisions, incarnations and source ids as they are. Each call is one write
//! transaction and goes through the family writers, so every index key a family keeps is written as
//! its own writes write it, and every id counter is raised past the highest id copied.
//!
//! A seed is claimed by its id. The first call writes the manifest `M shadow_seed`
//! ([`SeedManifest`]) and is refused unless the store is fresh: only the records a new store holds
//! (`Mformat`, `Cversion`, `Sdefault`). A later call is refused unless it carries the same seed id,
//! so a second seed never lands on top of a first, and a retried batch of the same seed skips the
//! rows it already stored.
//!
//! Rows carry each column as the Postgres text of its value ([`decode`]). The caller imports the
//! relations in dependency order ([`plan`]); a row whose source or page is missing is an error.
//! What the store does not keep is reported, not dropped silently: `unmapped_columns` names the
//! columns that held a value other than their default, and `losses` counts the rows and values the
//! seed could not carry. See rust/docs/store/seed.md.

mod chronicle;
mod core;
mod decide;
mod decode;
mod follow;
mod format_5;
mod history;
mod not_copied;
mod privacy;
mod questions;
mod spend;
#[cfg(test)]
mod tests;
#[cfg(test)]
mod v0_60_766_tests;
mod wake;

pub use decode::SeedRow;
pub(crate) use format_5::carry_over as carry_over_format_5;

/// What a person runs to replace a shadow store this build will not open (`src/shadow/seed.ts`
/// `RESEED_STEPS`).
pub const RESEED_STEPS: &str = "gbrain engine shadow stop --delete (deletes the store, ledger and reports), then gbrain engine shadow seed, then gbrain engine shadow start --plan, then gbrain engine shadow start --yes --expect <plan_hash> to turn shadow mode on again";
pub(crate) use follow::relation_digest_stream_until;
pub use follow::{
    AllocatorCheck, DigestInput, EntryInfo, FactFingerprints, FollowResult, IntervalDigest,
    KeyInput, MAX_ENTRIES, UNSUPPORTED, fact_fingerprints, relation_digest_stream,
};
pub use not_copied::{GapRows, LossKind, NOT_COPIED, NotCopied};

use crate::error::{CONSTRAINT_VIOLATION, INVALID_ARGUMENT, INVALID_STATE, Result, StoreError};
use crate::kv::{KvRead, KvWrite, scan_prefix};
use crate::pages::{PageRecord, read_page_by_id};
use crate::sources::{read_source, source_key};
use crate::trust::{TrustTier, WriteTrust};
use crate::{Store, get_json, keys, put_json};
use decode::Row;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

/// The manifest's meta key (`M shadow_seed`).
pub const MANIFEST: &str = "shadow_seed";

/// The relations a seed copies, in the order the caller imports them: each group's relations in
/// its own order, groups in this order. A relation names only rows of relations before it.
const GROUPS: &[&[(&str, &Relation)]] = &[
    core::RELATIONS,
    privacy::RELATIONS,
    history::RELATIONS,
    spend::RELATIONS,
    decide::RELATIONS,
    wake::RELATIONS,
    chronicle::RELATIONS,
    questions::RELATIONS,
];

/// One relation of the seed plan.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RelationPlan {
    /// The primary table, and the relation name `importRelation` takes.
    pub relation: &'static str,
    /// The primary key columns: the caller reads the table in this order, in keyset batches.
    pub key: &'static [&'static str],
    /// Whether the follow calls can delete and replace rows of the relation (`false`: they refuse
    /// with `unsupported`).
    pub removable: bool,
}

/// The seed plan: the relations it copies, the tables it carries inside them, and the tables it
/// leaves behind on purpose. Every other primary table is a gap.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SeedPlan {
    pub relations: Vec<RelationPlan>,
    /// `(table, relation)`: a table whose rows ride in the rows of `relation`.
    pub carried: Vec<(&'static str, &'static str)>,
    pub not_copied: &'static [NotCopied],
    /// Columns of copied relations that the store cannot keep yet: a row with a non-null value
    /// there is counted as the gap `gap`, so a swap is refused while one exists.
    pub gap_columns: &'static [GapColumn],
}

/// A column of a copied relation whose non-null values the store does not keep yet.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct GapColumn {
    pub table: &'static str,
    pub column: &'static str,
    pub gap: &'static str,
}

/// The columns the store does not keep yet. The raw frontmatter text comes with the frontmatter
/// format work; until the page family stores it, a page or version that has it is a gap.
pub const GAP_COLUMNS: &[GapColumn] = &[
    GapColumn {
        table: "page_versions",
        column: "frontmatter_raw",
        gap: "page_versions.frontmatter_raw",
    },
    GapColumn {
        table: "pages",
        column: "frontmatter_raw",
        gap: "pages.frontmatter_raw",
    },
];

/// Tables read as columns of a relation's rows.
const CARRIED: &[(&str, &str)] = &[("page_projection_jobs", "pages")];

/// The seed plan, relations in import order.
pub fn plan() -> SeedPlan {
    SeedPlan {
        relations: relations()
            .map(|(relation, spec)| RelationPlan {
                relation,
                key: spec.key,
                removable: follow::removable(relation),
            })
            .collect(),
        carried: CARRIED.to_vec(),
        not_copied: NOT_COPIED,
        gap_columns: GAP_COLUMNS,
    }
}

fn relations() -> impl Iterator<Item = (&'static str, &'static Relation)> {
    GROUPS.iter().flat_map(|group| group.iter().copied())
}

/// The seed that owns the store, with what each relation's calls stored so far.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct SeedManifest {
    pub seed_id: String,
    pub started_at_us: i64,
    #[serde(default)]
    pub relations: BTreeMap<String, RelationCounts>,
}

/// Running totals of one relation in the manifest.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct RelationCounts {
    pub imported: u64,
    pub skipped: u64,
    pub dropped: u64,
}

/// What one `importRelation` call did.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct ImportResult {
    /// Rows stored (for `sources` and `config`, also rows that replaced a different stored value).
    pub imported: u64,
    /// Rows the store already held under the same key: a retried batch.
    pub skipped: u64,
    /// Rows the store cannot hold; `losses` names why.
    pub dropped: u64,
    /// Columns that held a value other than their default in some row and that the store does not
    /// keep, sorted.
    pub unmapped_columns: Vec<String>,
    /// Dropped rows and values the store could not carry, by reason.
    pub losses: BTreeMap<String, u64>,
}

/// What one row did.
enum Outcome {
    Imported,
    Skipped,
    Dropped(&'static str),
}

/// What a column is to the seed.
enum Column {
    /// The store keeps it.
    Kept,
    /// Postgres derives it from kept columns (`search_vector`); the store derives its own.
    Derived,
    /// The store does not keep it: a value other than this default (`None`: any value) is reported.
    Unmapped(Option<&'static str>),
}

use Column::{Derived, Kept, Unmapped};

type Importer = fn(&mut dyn KvWrite, &Row, &mut Losses) -> Result<Outcome>;

/// Losses of values in rows that were stored.
#[derive(Default)]
struct Losses(BTreeMap<String, u64>);

impl Losses {
    fn add(&mut self, reason: &str) {
        *self.0.entry(reason.to_owned()).or_default() += 1;
    }
}

struct Relation {
    /// The primary key columns, in the order the caller reads the table.
    key: &'static [&'static str],
    columns: &'static [(&'static str, Column)],
    import: Importer,
}

/// The trust context of a seed write: rows keep the tiers and origins the other engine stored,
/// as a backfill that may carry any tier.
fn seed_trust() -> WriteTrust {
    WriteTrust {
        backfill: true,
        promotion: Some(TrustTier::UserConfirmed),
        ..Default::default()
    }
}

impl Store {
    /// `importRelation(seedId, relation, rows)`: stores `rows` of `relation` (one of [`plan`])
    /// in one write transaction, under the seed `seed_id`. Refused (`invalid_state`) when another
    /// seed owns the store, or when no seed does and the store is not fresh.
    pub fn import_relation(
        &self,
        seed_id: &str,
        relation: &str,
        rows: Vec<SeedRow>,
    ) -> Result<ImportResult> {
        self.import_rows(seed_id, relation, rows, None)
    }

    /// [`Store::import_relation`], storing a digest entry per row when `digests` align with `rows`.
    fn import_rows(
        &self,
        seed_id: &str,
        relation: &str,
        rows: Vec<SeedRow>,
        digests: Option<&[follow::RowDigest]>,
    ) -> Result<ImportResult> {
        let spec = relation_spec(relation)?;
        if seed_id.is_empty() || seed_id.contains('\0') {
            return Err(StoreError::new(
                INVALID_ARGUMENT,
                "shadow_seed: the seed id must be non-empty text",
            ));
        }
        self.write_as(seed_trust(), |tx| {
            let mut manifest = claim(tx, seed_id)?;
            let mut result = ImportResult::default();
            let mut losses = Losses::default();
            let mut unmapped = BTreeSet::new();
            for (n, row) in rows.iter().enumerate() {
                let row = Row { relation, row };
                note_unmapped(spec, &row, &mut unmapped);
                let outcome = (spec.import)(tx, &row, &mut losses).map_err(|e| {
                    StoreError::new(e.code, format!("{relation} row {n}: {}", e.message))
                })?;
                if let Some(digests) = digests {
                    follow::store_import_entry(tx, relation, &row, &digests[n])?;
                }
                match outcome {
                    Outcome::Imported => result.imported += 1,
                    Outcome::Skipped => result.skipped += 1,
                    Outcome::Dropped(reason) => {
                        result.dropped += 1;
                        losses.add(reason);
                    }
                }
            }
            let counts = manifest.relations.entry(relation.to_owned()).or_default();
            counts.imported += result.imported;
            counts.skipped += result.skipped;
            counts.dropped += result.dropped;
            put_json(tx, &keys::meta(MANIFEST), &manifest)?;
            result.unmapped_columns = unmapped.into_iter().collect();
            result.losses = losses.0;
            Ok(result)
        })
    }
}

/// The manifest of `seed_id`: the stored one, or a new one when the store is fresh.
fn claim(tx: &mut dyn KvWrite, seed_id: &str) -> Result<SeedManifest> {
    if let Some(manifest) = get_json::<SeedManifest>(&*tx, &keys::meta(MANIFEST))? {
        if manifest.seed_id != seed_id {
            return Err(StoreError::new(
                INVALID_STATE,
                format!(
                    "shadow_seed: the store holds seed {} and refuses rows of seed {seed_id}; reseed into a new store",
                    manifest.seed_id
                ),
            ));
        }
        return Ok(manifest);
    }
    let fresh = [
        keys::meta("format"),
        // Written by the open that made the store, once its scan found no restricted page.
        keys::meta(crate::access_flag::SCAN_DONE),
        // The keyword index state: a new store starts with the index on.
        keys::keyword_index_state(),
        crate::shared_skill_members::state_key(),
        // The open-time repair of the derivation sweep records' source index leaves its done marker.
        crate::page_body::purge_record::repair_done_key(),
        source_key(crate::sources::DEFAULT_SOURCE),
    ];
    // The config rows a new store's open writes: the schema version, the trust and write-gate marks (migrations v226 and
    // v227 on an empty brain) and the chunk strategy and embedding identity the caller names. The seed's config
    // relation merges over them.
    let opened_config: Vec<Vec<u8>> = [
        "version",
        "trust.backfill_completed_at",
        crate::WRITE_GATE_SCAN_BASELINE_KEY,
        "chunk_strategy",
        "embedding_model",
        "embedding_dimensions",
    ]
    .iter()
    .map(|name| keys::text(keys::CONFIG, &[name]))
    .collect();
    let mut foreign = None;
    scan_prefix(&*tx, &[], false, &mut |key, _| {
        if fresh
            .iter()
            .chain(&opened_config)
            .any(|k| k.as_slice() == key)
        {
            return true;
        }
        foreign = Some(String::from_utf8_lossy(key).into_owned());
        false
    })?;
    if let Some(key) = foreign {
        return Err(StoreError::new(
            INVALID_STATE,
            format!(
                "shadow_seed: the store is not empty (it holds {key:?}); a seed needs a new store"
            ),
        ));
    }
    Ok(SeedManifest {
        seed_id: seed_id.to_owned(),
        started_at_us: crate::env::transaction_clock::transaction_now().unwrap_or_default(),
        relations: BTreeMap::new(),
    })
}

fn note_unmapped(spec: &Relation, row: &Row, out: &mut BTreeSet<String>) {
    for (col, value) in row.row {
        let Some(value) = value else { continue };
        let default = match spec.columns.iter().find(|(name, _)| name == col) {
            Some((_, Kept | Derived)) => continue,
            Some((_, Unmapped(default))) => *default,
            None => None,
        };
        let is_default = default.is_some_and(|d| {
            d == value || matches!((d, value.as_str()), ("false", "f") | ("true", "t"))
        });
        if !is_default {
            out.insert(col.clone());
        }
    }
}

fn relation_spec(relation: &str) -> Result<&'static Relation> {
    match relations().find(|(name, _)| *name == relation) {
        Some((_, spec)) => Ok(spec),
        None => Err(StoreError::new(
            INVALID_ARGUMENT,
            format!(
                "shadow_seed: unknown relation {relation:?}; one of {}",
                relations()
                    .map(|(name, _)| name)
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
        )),
    }
}

/// Raises the id counter `name` past `id`.
pub(crate) fn raise_counter(tx: &mut dyn KvWrite, name: &str, id: u64) -> Result<()> {
    let key = keys::meta(name);
    let current = match tx.get(&key)? {
        Some(bytes) => keys::be8(&bytes)
            .ok_or_else(|| StoreError::new(crate::error::STORE_CORRUPT, "bad id counter"))?,
        None => 1,
    };
    if id >= current {
        tx.put(&key, &(id + 1).to_be_bytes())?;
    }
    Ok(())
}

pub(crate) fn require_source(read: &dyn KvRead, id: &str) -> Result<()> {
    match read_source(read, id)? {
        Some(_) => Ok(()),
        None => Err(StoreError::new(
            crate::error::SOURCE_NOT_FOUND,
            format!("source {id:?} is not seeded; seed sources first"),
        )),
    }
}

pub(crate) fn require_page(read: &dyn KvRead, id: u64) -> Result<PageRecord> {
    read_page_by_id(read, id)?.ok_or_else(|| {
        StoreError::new(
            crate::error::PAGE_NOT_FOUND,
            format!("page {id} is not seeded; seed pages first"),
        )
    })
}

fn duplicate(what: &str) -> StoreError {
    StoreError::new(
        CONSTRAINT_VIOLATION,
        format!("duplicate key value violates unique constraint on {what}"),
    )
}
