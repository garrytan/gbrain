# The brain store: doctor reads, facts, fence and trust

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

These are the statements that the `gbrain doctor` facts, fence and trust checks ran through `executeRaw`. PGLite and Postgres run the same SQL as before (`src/core/engine-sql/doctor-facts-trust.ts`; the text is pinned by `test/doctor-facts-trust-sql.test.ts`). The TypeScript side is `src/core/rust-engine/store-members/doctor-facts-trust.ts`; the store methods are in `crates/gbrain-store/src/cli_reads/doctor_facts_trust.rs` and `crates/gbrain-store/src/jobs/checks.rs`.

## facts_extraction_health

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.countConversationPipelinePages({types, slug_patterns})` | the live pages whose type is in `types` and whose slug matches none of the `slug_patterns` (LIKE patterns, `%` and `_`) | the `conversationPipelineNote` count |
| `brain.listPersistentWriterContention(reason)` | per source, the facts-absorb deferrals of the last 24 hours with that reason that no later completed `facts-absorb` job covers, kept when there are more than 10 or the oldest is over an hour old | the `persistentWriterContention` query |

A deferral row is covered when a completed `facts-absorb` job for the same page and source finished at or after the row was written. A row with no source belongs to `default`.

## trust_tiers, trust_sources_unclaimed, trust_scan and the trust backfill

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.countRowTrustTiers(table)` | per stored `trust_tier` (a missing one reads `unknown`) the live rows of `facts`, `takes` or `timeline_entries` | `readTrustTierCounts` |
| `brain.countClaimLiftedRows(table)` | the rows whose `write_origin.channel` is `trust_claim` | the gate on the relower candidate loop |
| `brain.countLegacyUnknownBySource({ceilings, sourceIds})` | per source, the rows at tier `unknown` at or below the per-table id ceilings (pages, facts, takes, timeline entries), in the optional source scope | `legacyUnknownBySource` |
| `brain.countDerivedFactTaint()` | the fact half of the derived taint share (already a store read; now reached by the doctor; the other tables are `countDerivedRowTaint`, docs/store/trust.md) | `readDerivedTaintShare` |

Every table name is checked against the four modelled tables; any other (`links`, an injected name) is a typed `invalid_argument`. A soft-deleted page leaves the page count only: its facts, takes and timeline entries still count, as on PGLite and Postgres.

Served in TypeScript, not by a store method:

- `brain.listTrustClaimTargets(mode, sourceIds)` reads `brain.listDoctorSources()` and filters it (`owned`, `named` or `claimed`). The `readDoctorSources` variants stay as they were.
- `brain.listTrustColumns()` answers the `trust_tier` and `write_origin` columns of pages, facts, takes and timeline entries, plus `sources.config`. That is a subset of the information-schema read, which is all `trust backfill` asks for.

`trust_scan` (`countUnscannedTrustRows`) now reads takes and timeline entries too (see [trust.md](trust.md)); a row carries its page's source. Only `links` is still refused.

The relower candidates loop of `trust backfill` is classifier SQL and stays a raw read on Rust. It runs only when `countClaimLiftedRows(table)` is above zero, and no Rust writer produces a `trust_claim` origin, so on a Rust brain the loop is skipped. It is filed in `TODOS.md`.

## What a fresh Rust brain starts with

`seed()` (`crates/gbrain-store/src/lib.rs`) writes two config keys that migrations v226 and v227 write on an empty PGLite or Postgres brain, because
a new brain has no row to backfill or scan:

- `trust.backfill_completed_at`: the store clock as millisecond ISO text (v226). Without it `trust_tiers` warned "backfill has not run".
- `write_gate.scan_baseline`: `{"until": {"facts": 0, "pages": 0, "takes": 0, "timeline_entries": 0}, "detector_version": 2}` (v227, the `jsonb` text Postgres prints; the detector is the caller's `writeGateDetectorVersion`). Without it `trust_scan`
  and `trust_sources_unclaimed` counted every row as unscanned or legacy.

Both are in `SEED_CONFIG_KEYS` (`src/core/persistence/engine-graduation.ts`), so graduation does not count them as user-set config.
