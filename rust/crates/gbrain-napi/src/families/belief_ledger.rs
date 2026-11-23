//! The belief ledger's writes and the reads its append makes: events, commit marks, page
//! lifetimes, suppressions and purge tombstones (src/core/engine-sql/belief-ledger.ts); and its
//! history and source reads (engine-sql/trust-tier-reads.ts, engine-sql/belief.ts); and the
//! coverage reads of its activation (engine-sql/belief-ledger.ts, belief/coverage.ts); and its
//! state reads (engine-sql/belief-state.ts, belief/state.ts).
//!
//! One `#[napi] impl Brain` block; each method decodes its JSON arguments, runs one
//! `gbrain_store::trust::belief_*` call on the pool through `Brain::run` and resolves plain JSON.
//! The TypeScript members (src/core/rust-engine/store-members/belief-ledger.ts) send the
//! arguments and refuse what the store cannot answer.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde::Deserialize;
use serde_json::Value;

use crate::store_binding::{Brain, required};
use gbrain_store::trust::belief_events::{EventInsert, TombstoneQuery};
use gbrain_store::trust::belief_history::{HistoryQuery, VisibleLifetimesQuery};
use gbrain_store::trust::belief_lifetimes::{LifetimeMint, LifetimePair};
use gbrain_store::trust::belief_redactions::{RedactionInsert, RedactionQuery, RedactionRelease};
use gbrain_store::trust::belief_state::BeliefStateQuery;

/// `listBeliefBaselinePending`'s arguments.
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct PendingArgs {
    source_id: String,
    run_id: String,
    after: String,
    skip: Vec<String>,
    limit: u32,
}

/// `renameBeliefLifetime`'s arguments.
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct RenameArgs {
    lifetime: String,
    slug: String,
    page_id: Option<i32>,
}

#[napi]
impl Brain {
    /// `readBeliefTombstones({ sourceId, factFps, takeFps })`: resolves `{ fps }`.
    #[napi]
    pub fn read_belief_tombstones<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: TombstoneQuery = required(args, "readBeliefTombstones args")?;
            s.read_belief_tombstones(&a)
        })
    }

    /// `readBeliefRedactions({ sourceId, subjectKeys, fieldHashes })`: resolves the suppressions.
    #[napi]
    pub fn read_belief_redactions<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: RedactionQuery = required(args, "readBeliefRedactions args")?;
            s.read_belief_redactions(&a)
        })
    }

    /// `insertBeliefRedaction(row)`: resolves the new row's id.
    #[napi]
    pub fn insert_belief_redaction<'env>(
        &self,
        env: &'env Env,
        row: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: RedactionInsert = required(row, "insertBeliefRedaction row")?;
            s.insert_belief_redaction(&a)
        })
    }

    /// `releaseBeliefRedactions({ ids, publicationId, releasedHash })`.
    #[napi]
    pub fn release_belief_redactions<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: RedactionRelease = required(args, "releaseBeliefRedactions args")?;
            s.release_belief_redactions(&a)
        })
    }

    /// `insertBeliefEvents(rows)`: resolves how many were inserted.
    #[napi]
    pub fn insert_belief_events<'env>(
        &self,
        env: &'env Env,
        rows: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: Vec<EventInsert> = required(rows, "insertBeliefEvents rows")?;
            s.insert_belief_events(&a)
        })
    }

    /// `markBeliefCommits(publicationIds)`.
    #[napi]
    pub fn mark_belief_commits<'env>(
        &self,
        env: &'env Env,
        ids: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: Vec<String> = required(ids, "markBeliefCommits publicationIds")?;
            s.mark_belief_commits(&a)
        })
    }

    /// `readOpenBeliefLifetimes(pairs)`: resolves the open lifetimes.
    #[napi]
    pub fn read_open_belief_lifetimes<'env>(
        &self,
        env: &'env Env,
        pairs: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: Vec<LifetimePair> = required(pairs, "readOpenBeliefLifetimes pairs")?;
            s.read_open_belief_lifetimes(&a)
        })
    }

    /// `endBeliefLifetime(lifetime)`.
    #[napi]
    pub fn end_belief_lifetime<'env>(
        &self,
        env: &'env Env,
        lifetime: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.end_belief_lifetime(&lifetime))
    }

    /// `mintBeliefLifetime(mint)`: resolves the lifetime open at the pair.
    #[napi]
    pub fn mint_belief_lifetime<'env>(
        &self,
        env: &'env Env,
        mint: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: LifetimeMint = required(mint, "mintBeliefLifetime mint")?;
            s.mint_belief_lifetime(&a)
        })
    }

    /// `renameBeliefLifetime({ lifetime, slug, pageId })`.
    #[napi]
    pub fn rename_belief_lifetime<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: RenameArgs = required(args, "renameBeliefLifetime args")?;
            s.rename_belief_lifetime(&a.lifetime, &a.slug, a.page_id)
        })
    }

    /// `readMovedBeliefLifetimes(pageIds)`: resolves the moved lifetimes.
    #[napi]
    pub fn read_moved_belief_lifetimes<'env>(
        &self,
        env: &'env Env,
        ids: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: Vec<i32> = required(ids, "readMovedBeliefLifetimes pageIds")?;
            s.read_moved_belief_lifetimes(&a)
        })
    }

    /// `readBeliefHistoryRows(query)`: resolves one page of history rows.
    #[napi]
    pub fn read_belief_history_rows<'env>(
        &self,
        env: &'env Env,
        query: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let q: HistoryQuery = required(query, "readBeliefHistoryRows query")?;
            s.read_belief_history_rows(&q)
        })
    }

    /// `listVisibleBeliefLifetimes({ lifetimes, floor })`: resolves the visible lifetimes.
    #[napi]
    pub fn list_visible_belief_lifetimes<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let q: VisibleLifetimesQuery = required(args, "listVisibleBeliefLifetimes args")?;
            s.list_visible_belief_lifetimes(&q)
        })
    }

    /// `readLedgerSource(sourceId)`: resolves the source's ledger view, or null.
    #[napi]
    pub fn read_ledger_source<'env>(
        &self,
        env: &'env Env,
        source_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_ledger_source(&source_id))
    }

    /// `listCoveredSources(subjectKey)`: resolves the covered source ids.
    #[napi]
    pub fn list_covered_sources<'env>(
        &self,
        env: &'env Env,
        subject_key: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_covered_sources(&subject_key))
    }

    /// `readBeliefStateRows({ sourceId, slugs, pageIds, knownFp, visibility })`: resolves the
    /// streams' rows (pages, facts, takes, links, transitions, endpoints).
    #[napi]
    pub fn read_belief_state_rows<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let q: BeliefStateQuery = required(args, "readBeliefStateRows args")?;
            s.read_belief_state_rows(&q)
        })
    }

    /// `readBeliefFactsById(ids)`: resolves the fact rows among `ids`.
    #[napi]
    pub fn read_belief_facts_by_id<'env>(
        &self,
        env: &'env Env,
        ids: Vec<i64>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_belief_facts_by_id(&ids))
    }

    /// `readLatestBeliefCoverage(sourceId)`: resolves the newest coverage event, or null.
    #[napi]
    pub fn read_latest_belief_coverage<'env>(
        &self,
        env: &'env Env,
        source_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_latest_belief_coverage(&source_id))
    }

    /// `hasBeliefBaseline(sourceId, slug, runId)`: resolves whether the slug has the run's baseline.
    #[napi]
    pub fn has_belief_baseline<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        slug: String,
        run_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.has_belief_baseline(&source_id, &slug, &run_id)
        })
    }

    /// `countBeliefBaselineSlugs(sourceId, runId)`: resolves how many slugs have the run's baseline.
    #[napi]
    pub fn count_belief_baseline_slugs<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        run_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.count_belief_baseline_slugs(&source_id, &run_id)
        })
    }

    /// `listBeliefDriftCandidates(sourceId, incarnation)`: resolves the slugs the drift scan may check.
    #[napi]
    pub fn list_belief_drift_candidates<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        incarnation: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_belief_drift_candidates(&source_id, &incarnation)
        })
    }

    /// `readNewestBeliefEvent(sourceId, incarnation, slug)`: resolves the slug's newest event, or null.
    #[napi]
    pub fn read_newest_belief_event<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        incarnation: String,
        slug: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_newest_belief_event(&source_id, &incarnation, &slug)
        })
    }

    /// `listBeliefBaselinePending({ sourceId, runId, after, skip, limit })`: resolves the slugs.
    #[napi]
    pub fn list_belief_baseline_pending<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: PendingArgs = required(args, "listBeliefBaselinePending args")?;
            s.list_belief_baseline_pending(
                &a.source_id,
                &a.run_id,
                &a.after,
                &a.skip,
                a.limit as usize,
            )
        })
    }
}
