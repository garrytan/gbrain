/**
 * Salience members (BrainEngine batchLoadEmotionalInputs, setEmotionalWeightBatch, getRecentSalience,
 * getSalienceScores). The store keeps each page's emotional weight and touch time (rust/docs/store/salience.md). This
 * shell does what the shared SQL does before its statement runs (window boundary, limit clamp, briefings rule, recency
 * map), so both engines rank the same pages.
 *
 * Read policy: source scope and `takesHoldersAllowList` are honoured. `excludePrivate` is served as the page policy
 * `pageReadFilter` adds (private-provenance.ts `storePagePolicy`, which refuses a caller whose policy is wider than the
 * store's). On getSalienceScores a trust floor or flag suppression refuses, as its SQL reads them; getRecentSalience's
 * SQL never reads them, so they change nothing there.
 * getSalienceScores also accepts the rest of hybrid search's post-fusion option bag (`HYBRID_BAG_KEYS`), which its SQL
 * never reads; refusing it would make the post-fusion stage skip the salience boost.
 */
import { clampSearchLimit } from '../../engine.ts';
import { resolveRecencyDecayMap, DEFAULT_FALLBACK, type RecencyDecayConfig, type RecencyDecayMap } from '../../search/recency-decay.ts';
import type {
  EmotionalWeightInputRow, EmotionalWeightWriteRow, PageReadPolicy, SalienceOpts, SalienceResult,
} from '../../types.ts';
import { refuseMember, storeCall, takeOptions, type StoreMember } from './common.ts';
import { HYBRID_BAG_KEYS, storePagePolicy } from './private-provenance.ts';


/** `pageReadFilter`'s source filter: a non-empty `sourceIds` wins over a truthy `sourceId`; neither is no scope. */
function sourceScope(opts: Record<string, unknown>): unknown[] | null {
  if (Array.isArray(opts.sourceIds) && opts.sourceIds.length > 0) return opts.sourceIds;
  if (opts.sourceId) return [opts.sourceId];
  return null;
}

/** `takesHoldersAllowList`: undefined is unrestricted; any list (even empty) restricts. */
function holders(opts: Record<string, unknown>): unknown[] | null {
  return opts.takesHoldersAllowList === undefined ? null : ((opts.takesHoldersAllowList ?? []) as unknown[]);
}

export const batchLoadEmotionalInputs: StoreMember<[slugs?: string[]], EmotionalWeightInputRow[]> = async (brain, slugs) =>
  (await storeCall({ member: 'batchLoadEmotionalInputs' }, () => brain.batchLoadEmotionalInputs(slugs ?? null))) as EmotionalWeightInputRow[];

export const setEmotionalWeightBatch: StoreMember<[rows: EmotionalWeightWriteRow[]], number> = async (brain, rows) => {
  if (rows.length === 0) return 0;
  // JSON carries no NaN or Infinity; PGLite would store them as real NaN / Infinity.
  if (rows.some((r) => typeof r.weight === 'number' && !Number.isFinite(r.weight))) {
    refuseMember('setEmotionalWeightBatch', 'non-finite weight');
  }
  const sent = rows.map((r) => ({ slug: r.slug, source_id: r.source_id, weight: r.weight ?? null }));
  return Number(await storeCall({ member: 'setEmotionalWeightBatch' }, () => brain.setEmotionalWeightBatch(sent)));
};

/** `buildRecencyComponentSql`'s inputs: branches longest prefix first, the first match wins. */
function recency(decayMap: RecencyDecayMap, fallback: RecencyDecayConfig, effectiveDate: boolean) {
  const branches = Object.keys(decayMap)
    .sort((a, b) => b.length - a.length)
    .map((prefix) => ({ prefix, halflife_days: decayMap[prefix].halflifeDays, coefficient: decayMap[prefix].coefficient }));
  return {
    effective_date: effectiveDate,
    branches,
    fallback_halflife_days: fallback.halflifeDays,
    fallback_coefficient: fallback.coefficient,
  };
}

type RecentRow = Omit<SalienceResult, 'updated_at'> & { updated_at: string };

export const getRecentSalience: StoreMember<[opts: SalienceOpts], SalienceResult[]> = async (brain, opts) => {
  const o = takeOptions('getRecentSalience', opts,
    ['sourceId', 'sourceIds', 'days', 'limit', 'slugPrefix', 'recency_bias', 'takesHoldersAllowList', 'excludePrivate', 'nowMs'],
    ['minTrust', 'suppressFlagged', 'requireSafeChunks']);
  const excludePrivate = storePagePolicy('getRecentSalience', o.excludePrivate);
  const days = Math.max(0, (o.days as number | undefined) ?? 14);
  const limit = clampSearchLimit(o.limit as number | undefined, 20, 100);
  const slugPrefix = o.slugPrefix as string | undefined;
  // The SQL binds this ms-precision ISO string as its window boundary.
  const nowMs = o.nowMs as number | undefined;
  const boundaryMs = Date.parse(new Date((nowMs ?? Date.now()) - days * 86400000).toISOString());
  const bias = (o.recency_bias as SalienceOpts['recency_bias']) ?? 'flat';
  const rows = (await storeCall({ member: 'getRecentSalience' }, () => brain.getRecentSalience({
    boundary_ms: boundaryMs,
    now_ms: nowMs ?? null,
    limit,
    slug_prefix: slugPrefix || null,
    exclude_briefings: !(slugPrefix && slugPrefix.startsWith('briefings')),
    source_ids: sourceScope(o),
    holders: holders(o),
    recency: bias === 'on'
      ? recency(resolveRecencyDecayMap(), DEFAULT_FALLBACK, true)
      : recency({}, { halflifeDays: 1, coefficient: 1.0 }, false),
    ...(excludePrivate ? { exclude_private: excludePrivate } : {}),
  }))) as RecentRow[];
  return rows.map((r) => ({ ...r, updated_at: new Date(r.updated_at) }));
};

export const getSalienceScores: StoreMember<[refs: Array<{ slug: string; source_id: string }>, opts?: PageReadPolicy], Map<string, number>> = async (brain, refs, opts) => {
  if (!refs.length) return new Map();
  const o = takeOptions('getSalienceScores', opts, ['sourceId', 'sourceIds', 'takesHoldersAllowList'],
    // Hybrid search's post-fusion stage hands its whole option bag (search options plus applyBacklinks, floorRatio,
    // graphSignalsEnabled, query, titleBoost...) to this read; readSalienceScores reads only the page policy out of it.
    ['requireSafeChunks', 'excludePrivate', ...HYBRID_BAG_KEYS]);
  const excludePrivate = storePagePolicy('getSalienceScores', opts?.excludePrivate);
  const rows = (await storeCall({ member: 'getSalienceScores' }, () => brain.getSalienceScores({
    refs: refs.map((r) => ({ slug: r.slug, source_id: r.source_id })),
    source_ids: sourceScope(o),
    holders: holders(o),
    live: !!opts,
    ...(excludePrivate ? { exclude_private: excludePrivate } : {}),
  }))) as Array<{ slug: string; source_id: string; score: number }>;
  return new Map(rows.map((r) => [`${r.source_id}::${r.slug}`, r.score]));
};
