/**
 * Doctor reads, second set (src/core/engine-sql/doctor-derived.ts), on the Rust engine. Two kinds of member:
 *  - served from the store's records (rust/crates/gbrain-store/src/cli_reads/doctor_derived.rs,
 *    doctor_derived_health.rs and doctor_derived_ledgers.rs; the budget holds from embeddings.rs; the 7-day extract
 *    rollup from extract_bookkeeping.rs, whose day rows the extract rollup writer adds to;
 *    rust/docs/store/cli-reads-doctor-derived.md);
 *  - answered empty with no store call, because the store keeps no writer for the relation the statement reads
 *    (`derived_generations`, `derived_generation_items`,
 *    `derived_generation_activations`, `belief_events`): no Rust brain ever holds a row there, so
 *    the empty answer is the one PGLite gives a brain that never wrote one.
 * Every member of `DOCTOR_DERIVED_MEMBERS` is one of the two; none is left to refuse with `engine_capability_missing`.
 */
import type { BrainEngine } from '../../engine.ts';
import type { StoreBrain } from '../store.ts';
import { storeCall, type StoreMember } from './common.ts';
import { withEmbeddingColumn } from '../../engine-sql/doctor-derived.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;

// ---- served from the store's records (rust/crates/gbrain-store/src/cli_reads/doctor_derived.rs) ----------------------

export const countSafeIndexPending: Member<'countSafeIndexPending'> = async (brain, sourceIds) =>
  storeCall({ member: 'countSafeIndexPending' }, () => brain.countSafeIndexPending(sourceIds ?? null));
export const countPagesByTypeAndOwner: Member<'countPagesByTypeAndOwner'> = async (brain, sourceIds) =>
  storeCall({ member: 'countPagesByTypeAndOwner' }, () => brain.countPagesByTypeAndOwner(sourceIds ?? null));
export const listImageAssetFiles: Member<'listImageAssetFiles'> = async (brain) =>
  storeCall({ member: 'listImageAssetFiles' }, () => brain.listImageAssetFiles());
export const listRestorableAtomRetirements: Member<'listRestorableAtomRetirements'> = async (brain, sourceIds) =>
  storeCall({ member: 'listRestorableAtomRetirements' }, () => brain.listRestorableAtomRetirements(sourceIds));
export const listTimelineHistoryBatch: Member<'listTimelineHistoryBatch'> = async (brain, sourceIds, afterId) =>
  storeCall({ member: 'listTimelineHistoryBatch' }, () => brain.listTimelineHistoryBatch(sourceIds, afterId));
export const readPageCompiledTruths: Member<'readPageCompiledTruths'> = async (brain, ids) =>
  storeCall({ member: 'readPageCompiledTruths' }, () => brain.readPageCompiledTruths(ids));
// ---- served from the store's records (cli_reads/doctor_derived_health.rs, doctor_derived_ledgers.rs) ---------------

/** The one aggregate row; the store holds one vector column, so `column` names it. */
export const readEmbeddingBacklogAge: Member<'readEmbeddingBacklogAge'> = async (brain, column) =>
  storeCall({ member: 'readEmbeddingBacklogAge' }, () => brain.readEmbeddingBacklogAge(column));
export const readEmbedBacklogRows: Member<'readEmbedBacklogRows'> = async (brain, column, sourceIds) =>
  storeCall({ member: 'readEmbedBacklogRows' }, () => brain.readEmbedBacklogRows(column, sourceIds));
/** The unchanged-body recheck (engine-sql/doctor-derived.ts listBodyRecheckGroups, readBodyRecheckPage, listBodyRecheckVersions). */
export const listBodyRecheckGroups: Member<'listBodyRecheckGroups'> = async (brain) =>
  storeCall({ member: 'listBodyRecheckGroups' }, () => brain.listBodyRecheckGroups());
export const readBodyRecheckPage: Member<'readBodyRecheckPage'> = async (brain, pageId) =>
  storeCall({ member: 'readBodyRecheckPage' }, () => brain.readBodyRecheckPage(Number(pageId)));
export const listBodyRecheckVersions: Member<'listBodyRecheckVersions'> = async (brain, pageId) =>
  storeCall({ member: 'listBodyRecheckVersions' }, () => brain.listBodyRecheckVersions(Number(pageId)));
export const readAtomProvenanceCounts: Member<'readAtomProvenanceCounts'> = async (brain) =>
  storeCall({ member: 'readAtomProvenanceCounts' }, () => brain.readAtomProvenanceCounts());
export const countCredentialProjectionPending: Member<'countCredentialProjectionPending'> = async (brain, sourceIds) =>
  storeCall({ member: 'countCredentialProjectionPending' }, () => brain.countCredentialProjectionPending(sourceIds ?? null));
/** The statement deadline (`timeoutMs`) bounds a SQL scan; the store answers from one snapshot with no cancellation point. */
export const readIgnoredPrivacyLabelCounts: Member<'readIgnoredPrivacyLabelCounts'> = async (brain, opts) =>
  storeCall({ member: 'readIgnoredPrivacyLabelCounts' }, () => brain.readIgnoredPrivacyLabelCounts(opts.sourceIds ?? null));
export const countDerivedVisibility: Member<'countDerivedVisibility'> = async (brain, sourceIds) =>
  storeCall({ member: 'countDerivedVisibility' }, () => brain.countDerivedVisibility(sourceIds));
export const listUntiledSegmentedPageRows: Member<'listUntiledSegmentedPageRows'> = async (brain, sourceIds, slugs, limit) =>
  storeCall({ member: 'listUntiledSegmentedPageRows' }, () =>
    brain.listUntiledSegmentedPageRows(sourceIds ? [...sourceIds] : null, slugs ? [...slugs] : null, limit));
export const listAmbiguousExtractionInputs: Member<'listAmbiguousExtractionInputs'> = async (brain) =>
  storeCall({ member: 'listAmbiguousExtractionInputs' }, () => brain.listAmbiguousExtractionInputs());
export const listExtractionInputReceipts: Member<'listExtractionInputReceipts'> = async (brain) =>
  storeCall({ member: 'listExtractionInputReceipts' }, () => brain.listExtractionInputReceipts());
export const listUnpricedDerivationModels: Member<'listUnpricedDerivationModels'> = async (brain) =>
  storeCall({ member: 'listUnpricedDerivationModels' }, () => brain.listUnpricedDerivationModels());

/** Belief ledger rows: the store keeps no `belief_events`, so no source is a recorded one and no tombstone is listed. */
export const listRecordedTombstones: Member<'listRecordedTombstones'> = async () => [];
/**
 * Held and capped large pages with chunks still waiting, by source, state and reason, from the store's budget ledger,
 * pages and chunks. The column name is checked as the SQL engines check it (`withEmbeddingColumn`); the store keeps one
 * vector per chunk, so it reads whether that vector is there.
 */
export const listBudgetLimitedRows: Member<'listBudgetLimitedRows'> = async (brain, opts) => {
  withEmbeddingColumn('"__COL__"', opts.column);
  return storeCall({ member: 'listBudgetLimitedRows' }, () => brain.listBudgetLimitedRows(opts.sourceId ?? null, opts.signature ?? null));
};
/** Of the same holds (chunks or not), how many were last updated over a day ago, and the oldest update time (ISO text). */
export const readBudgetHoldAge: Member<'readBudgetHoldAge'> = async (brain) =>
  storeCall({ member: 'readBudgetHoldAge' }, () => brain.readBudgetHoldAge());
/** Derived generations and their ledger: the store keeps none, so no retirement is ledger-covered. */
export const countLedgerCoveredAtomRetirements: Member<'countLedgerCoveredAtomRetirements'> = async () => 0;
/** The live generations that retired items inside the restore window, and the held generations: served from the ledger (generations/doctor_reads.rs). */
export const listLiveGenerationRetirements: Member<'listLiveGenerationRetirements'> = async (brain, sourceIds, restoreDays) =>
  storeCall({ member: 'listLiveGenerationRetirements' }, () => brain.listLiveGenerationRetirements([...sourceIds], restoreDays));
export const listHeldGenerations: Member<'listHeldGenerations'> = async (brain, sourceIds) =>
  storeCall({ member: 'listHeldGenerations' }, () => brain.listHeldGenerations([...sourceIds]));
export const listOrphanGenerationCandidates: Member<'listOrphanGenerationCandidates'> = async () => [];
// ---- the 7-day extract rollup, from the store's day rows (extract_bookkeeping.rs list_extract_rollup_days) -----------

/** A stored `extract_rollup_7d` day row as the store returns it. */
interface RollupDayRow {
  kind: string; source_id: string; day: string; cost_usd: number; halt_count: number; eval_fail_count: number; eval_pass_count: number;
  round_completed_count: number; expected_limit_count: number; rollup_write_failures: number; halt_reasons: Record<string, unknown>;
  updated_at_us: number;
}
const DAY_MS = 86_400_000;
/** `CURRENT_DATE` in UTC as days since the epoch, and a `YYYY-MM-DD` day as the same count. */
const today = (): number => Math.floor(Date.now() / DAY_MS);
const dayNumber = (day: string): number => Math.floor(Date.parse(`${day}T00:00:00Z`) / DAY_MS);
/** The day rows of `WHERE day >= CURRENT_DATE - 7`, in the store's (kind, source_id, day) key order. */
async function rollupWindow(brain: StoreBrain, member: string): Promise<RollupDayRow[]> {
  const since = new Date((today() - 7) * DAY_MS).toISOString().slice(0, 10);
  return (await storeCall({ member }, () => brain.listExtractRollupDays(since))) as RollupDayRow[];
}
/** A single-precision value as the SQL engines print it: the shortest decimal that reads back as the same `real`. */
function realText(v: number): number {
  for (let digits = 1; digits <= 9; digits++) {
    const shortest = Number(v.toPrecision(digits));
    if (Math.fround(shortest) === v) return shortest;
  }
  return v;
}
/** `SUM(cost_usd)` over a `real` column: Postgres adds in `real`, so each step rounds to single precision. */
const sumReal = (rows: RollupDayRow[]): number => realText(rows.reduce((acc, r) => Math.fround(acc + Math.fround(r.cost_usd)), 0));
const sumInt = (rows: RollupDayRow[], key: keyof RollupDayRow): number => rows.reduce((acc, r) => acc + Number(r[key]), 0);
const latest = (rows: RollupDayRow[]): string => new Date(Math.floor(Math.max(...rows.map(r => r.updated_at_us)) / 1000)).toISOString();
/** The window's rows by kind, kinds in byte order (`GROUP BY kind ORDER BY kind COLLATE "C"`). */
function byKind(rows: RollupDayRow[]): Array<[string, RollupDayRow[]]> {
  const groups = new Map<string, RollupDayRow[]>();
  for (const r of rows) groups.set(r.kind, [...(groups.get(r.kind) ?? []), r]);
  return [...groups].sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
}

/** The 7-day extract rollup per kind; `withExpected: false` answers the pre-v141 text's constant 0 expected limits. */
export const readExtractRollup7d: Member<'readExtractRollup7d'> = async (brain, withExpected) =>
  byKind(await rollupWindow(brain, 'readExtractRollup7d')).map(([kind, rows]) => {
    const halted = rows.filter(r => r.halt_count > 0).map(r => dayNumber(r.day));
    return {
      kind, cost_7d_usd: sumReal(rows), eval_pass_count: sumInt(rows, 'eval_pass_count'), eval_fail_count: sumInt(rows, 'eval_fail_count'),
      halt_count: sumInt(rows, 'halt_count'), round_completed_count: sumInt(rows, 'round_completed_count'),
      expected_limit_count: withExpected ? sumInt(rows, 'expected_limit_count') : 0, rollup_write_failures: sumInt(rows, 'rollup_write_failures'),
      last_updated_at: latest(rows), last_halt_age_days: halted.length ? today() - Math.max(...halted) : null,
    };
  });
/** The recorded halt reasons of the window, summed per kind and reason (`jsonb_each_text(halt_reasons)`). */
export const listRecordedHaltReasons7d: Member<'listRecordedHaltReasons7d'> = async (brain) => {
  const sums = new Map<string, { kind: string; reason: string; n: number }>();
  for (const r of await rollupWindow(brain, 'listRecordedHaltReasons7d')) {
    for (const [reason, value] of Object.entries(r.halt_reasons ?? {})) {
      const key = JSON.stringify([r.kind, reason]);
      const row = sums.get(key) ?? { kind: r.kind, reason, n: 0 };
      row.n += Number(value);
      sums.set(key, row);
    }
  }
  return [...sums.values()];
};
/** One kind's rollup aggregate: with no row for the kind, SUM and MAX over nothing are null, as the SQL engines answer. */
export const readExtractKindRollup7d: Member<'readExtractKindRollup7d'> = async (brain, kind) => {
  const rows = (await rollupWindow(brain, 'readExtractKindRollup7d')).filter(r => r.kind === kind);
  if (rows.length === 0) {
    return { cost_7d_usd: null, eval_pass_count: null, eval_fail_count: null, halt_count: null, round_completed_count: null, last_updated_at: null };
  }
  return {
    cost_7d_usd: sumReal(rows), eval_pass_count: String(sumInt(rows, 'eval_pass_count')), eval_fail_count: String(sumInt(rows, 'eval_fail_count')),
    halt_count: String(sumInt(rows, 'halt_count')), round_completed_count: String(sumInt(rows, 'round_completed_count')), last_updated_at: latest(rows),
  };
};
