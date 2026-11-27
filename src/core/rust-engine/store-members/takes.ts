/**
 * Takes members (BrainEngine addTakesBatch, listTakes, searchTakes, updateTake, supersedeTake, resolveTake,
 * getScorecard, getCalibrationCurve, addSynthesisEvidence, listActiveTakesForPages). The store keeps the `takes` and
 * `synthesis_evidence` rows (rust/docs/store/takes.md). This shell does what the shared SQL module does before its
 * statement runs (weight normalization, defaults, limit clamps, the GBrainErrors), so both engines say the same thing.
 *
 * A read-eligibility policy is honoured without `floor` and `suppressFlagged`: the store hides the takes of
 * soft-deleted and quarantined pages, as `projectionEligibleSql` always does. A trust floor or flag suppression
 * refuses (the store keeps no trust tiers or write-gate receipts for takes).
 */
import { clampSearchLimit } from '../../engine.ts';
import type {
  BatchOpts, CalibrationBucket, CalibrationCurveOpts, SynthesisEvidenceInput, Take, TakeBatchInput, TakeHit,
  TakeResolution, TakesListOpts, TakesScorecard, TakesScorecardOpts,
} from '../../engine.ts';
import type { ReadEligibility } from '../../eligibility/policy.ts';
import { buildTakeRows } from '../../batch-rows.ts';
import { normalizeWeightForStorage } from '../../takes-fence.ts';
import { deriveResolutionTuple, finalizeScorecard } from '../../takes-resolution.ts';
import type { SearchOpts } from '../../types.ts';
import { GBrainError } from '../../types.ts';
import { refuseMember, storeCall, takeOptions, throwIfAborted, type StoreMember } from './common.ts';
import type { TakeFenceRow } from '../../engine-sql/takes.ts';

/** Page-read options these members accept and that change nothing here (no trust tiers or chunk safety on takes). */
const IGNORED_READ_OPTIONS = ['minTrust', 'suppressFlagged', 'requireSafeChunks'] as const;

/** `SearchOpts` keys that do not change which takes `searchTakes` returns (its SQL never reads them). */
const SEARCH_IGNORED = [
  ...IGNORED_READ_OPTIONS,
  'offset', 'onVectorPoolMeta', 'vectorLegacyGuard', 'hnswIterativeScan', 'cjkKeyword', 'onKeywordIncomplete',
  'adaptiveReturn', 'autocut', 'type', 'types', 'where', 'exclude_slugs', 'exclude_slug_prefixes', 'source_boosts',
  'include_slug_prefixes', 'detail', 'language', 'symbolKind', 'nearSymbol', 'walkDepth', 'orFallback', 'orFill',
  'keywordTimeoutCache', 'rankQuery', 'keywordPhrase', 'embeddingColumn', 'afterDate', 'afterDateInclusive',
  'beforeDate', 'beforeDateInclusive', 'recencyBoost', 'salience', 'recency', 'since', 'until', 'tokenBudget',
  'useCache', 'intentWeighting', 'reranker', 'crossModal', 'graph_signals', 'relationalRetrieval',
  'relationalRetrievalDepth', 'relationalRerankPin', 'relationalPlanner', 'relationalOrientOneHop',
  'relationalChainSlots',
] as const;

/** The SQL module's source filter: a non-empty `sourceIds` wins over a truthy `sourceId`; neither is no scope. */
function sourceScope(opts: { sourceId?: unknown; sourceIds?: unknown }): unknown[] | null {
  if (Array.isArray(opts.sourceIds) && opts.sourceIds.length > 0) return opts.sourceIds;
  if (opts.sourceId) return [opts.sourceId];
  return null;
}

/** Whether a read applies the eligibility base clauses; a floor or flag suppression refuses. */
function eligibleOnly(member: string, policy: ReadEligibility | undefined): boolean {
  if (!policy) return false;
  if (policy.floor) refuseMember(member, 'option eligibility.floor');
  if (policy.suppressFlagged) refuseMember(member, 'option eligibility.suppressFlagged');
  return true;
}

/** An allow-list as the SQL reads it: undefined and null filter nothing. */
function allowList(list: unknown): unknown[] | null {
  return list == null ? null : (list as unknown[]);
}

function notFound(pageId: number, row: number, hint: string): GBrainError {
  return new GBrainError('TAKE_ROW_NOT_FOUND', `take not found at page_id=${pageId} row=${row}`, hint);
}

/** A take as `takeRowToTake` builds it: the store's microsecond ISO stamps read back as `Date#toISOString` (ms). */
function toTake(row: Take): Take {
  const ms = (v: string | null): string | null => (v == null ? null : new Date(v).toISOString());
  return { ...row, resolved_at: ms(row.resolved_at), created_at: ms(row.created_at) ?? '', updated_at: ms(row.updated_at) ?? '' };
}

const ROW_HINT = 'list takes for this page with `gbrain takes <slug>` to see valid row numbers';

export const addTakesBatch: StoreMember<[rows: TakeBatchInput[], opts?: BatchOpts], number> = async (brain, rowsIn, opts) => {
  if (rowsIn.length === 0) return 0;
  takeOptions('addTakesBatch', opts, [], ['auditSite', 'signal']);
  throwIfAborted(opts?.signal);
  const { rows, weightClamped } = buildTakeRows(rowsIn);
  if (weightClamped > 0) {
    process.stderr.write(`[takes] TAKES_WEIGHT_CLAMPED: ${weightClamped} row(s) had weight outside [0,1]; clamped\n`);
  }
  await storeCall({ member: 'addTakesBatch' }, () => brain.addTakesBatch(rows));
  return rows.length;
};

export const listTakes: StoreMember<[opts?: TakesListOpts], Take[]> = async (brain, opts = {}) => {
  const o = takeOptions('listTakes', opts, [
    'page_id', 'page_slug', 'holder', 'kind', 'active', 'resolved', 'takesHoldersAllowList', 'sortBy', 'oldestFirst',
    'sinceOnOrBefore', 'limit', 'offset', 'sourceId', 'sourceIds', 'eligibility',
  ], IGNORED_READ_OPTIONS) as TakesListOpts;
  const offset = Math.max(0, Math.floor(o.offset ?? 0));
  const filter = {
    page_id: o.page_id ?? null,
    page_slug: o.page_slug ?? null,
    holder: o.holder ?? null,
    kind: o.kind ?? null,
    active: o.active ?? true,
    resolved: o.resolved ?? null,
    allow_list: allowList(o.takesHoldersAllowList),
    sort_by: o.sortBy ?? 'created_at',
    oldest_first: o.oldestFirst ?? false,
    since_on_or_before: o.sinceOnOrBefore ?? null,
    limit: clampSearchLimit(o.limit, 100, 500),
    // Postgres refuses a non-finite OFFSET; the store refuses anything but a number.
    offset: Number.isFinite(offset) ? offset : String(offset),
    source_ids: sourceScope(o),
    eligible_only: eligibleOnly('listTakes', o.eligibility),
  };
  const rows: Take[] = await storeCall({ member: 'listTakes' }, () => brain.listTakes(filter));
  return rows.map(toTake);
};

export const searchTakes: StoreMember<
  [query: string, opts?: SearchOpts & { takesHoldersAllowList?: string[]; sourceId?: string; sourceIds?: string[]; eligibility?: ReadEligibility }],
  TakeHit[]
> = async (brain, query, opts = {}) => {
  const o = takeOptions('searchTakes', opts, ['limit', 'takesHoldersAllowList', 'sourceId', 'sourceIds', 'eligibility'], SEARCH_IGNORED) as
    { limit?: number; takesHoldersAllowList?: string[]; sourceId?: string; sourceIds?: string[]; eligibility?: ReadEligibility };
  const options = {
    query,
    limit: clampSearchLimit(o.limit, 30, 100),
    allow_list: allowList(o.takesHoldersAllowList),
    source_ids: sourceScope(o),
    eligible_only: eligibleOnly('searchTakes', o.eligibility),
  };
  return storeCall({ member: 'searchTakes' }, () => brain.searchTakes(options));
};

export const updateTake: StoreMember<[pageId: number, rowNum: number, fields: { weight?: number; since_date?: string; source?: string }], void> =
  async (brain, pageId, rowNum, fields) => {
    let weight = fields.weight;
    if (weight !== undefined) {
      const norm = normalizeWeightForStorage(weight);
      if (norm.clamped) {
        process.stderr.write(`[takes] TAKES_WEIGHT_CLAMPED: updateTake clamped weight ${weight} → ${norm.weight}\n`);
      }
      weight = norm.weight;
    }
    const input = {
      page_id: pageId ?? null,
      row_num: rowNum ?? null,
      weight: weight ?? null,
      since_date: fields.since_date ?? null,
      source: fields.source ?? null,
    };
    const found: boolean = await storeCall({ member: 'updateTake' }, () => brain.updateTake(input));
    if (!found) throw notFound(pageId, rowNum, ROW_HINT);
  };

export const supersedeTake: StoreMember<
  [pageId: number, oldRow: number, newRow: Omit<TakeBatchInput, 'page_id' | 'row_num' | 'superseded_by'>],
  { oldRow: number; newRow: number }
> = async (brain, pageId, oldRow, newRow) => {
  const weight = Math.max(0, Math.min(1, newRow.weight ?? 0.5));
  const input = {
    page_id: pageId ?? null,
    old_row: oldRow ?? null,
    claim: newRow.claim ?? null,
    kind: newRow.kind ?? null,
    holder: newRow.holder ?? null,
    // A NaN weight reaches Postgres as null and fails the column's NOT NULL.
    weight: Number.isNaN(weight) ? null : weight,
    since_date: newRow.since_date ?? null,
    until_date: newRow.until_date ?? null,
    source: newRow.source ?? null,
    active: newRow.active ?? true,
  };
  const result: { status: string; new_row?: number } = await storeCall({ member: 'supersedeTake' }, () => brain.supersedeTake(input));
  if (result.status === 'not_found') throw notFound(pageId, oldRow, 'list takes with `gbrain takes <slug>`');
  if (result.status === 'resolved') {
    throw new GBrainError('TAKE_RESOLVED_IMMUTABLE', `take ${pageId}#${oldRow} is resolved`, 'resolved bets are immutable; add a new take instead');
  }
  return { oldRow, newRow: Number(result.new_row) };
};

export const resolveTake: StoreMember<[pageId: number, rowNum: number, resolution: TakeResolution], void> =
  async (brain, pageId, rowNum, resolution) => {
    // PGLite reads the row first and derives the tuple after, so its row errors win over a bad resolution.
    let tuple: ReturnType<typeof deriveResolutionTuple> | undefined;
    let invalid: unknown;
    try {
      tuple = deriveResolutionTuple(resolution);
    } catch (error) {
      invalid = error;
    }
    const value = resolution?.value ?? null;
    if (tuple && value !== null && !Number.isFinite(value)) refuseMember('resolveTake', 'a non-finite resolution value');
    const input = {
      page_id: pageId ?? null,
      row_num: rowNum ?? null,
      resolution: tuple
        ? {
          quality: tuple.quality,
          outcome: tuple.outcome,
          value,
          unit: resolution.unit ?? null,
          source: resolution.source ?? null,
          resolved_by: resolution.resolvedBy ?? null,
        }
        : null,
    };
    const status: string = await storeCall({ member: 'resolveTake' }, () => brain.resolveTake(input));
    if (status === 'not_found') throw notFound(pageId, rowNum, ROW_HINT);
    if (status === 'resolved') {
      throw new GBrainError('TAKE_ALREADY_RESOLVED', `take ${pageId}#${rowNum} already resolved`, 'resolution is immutable; add a new take to record a new outcome');
    }
    if (!tuple) throw invalid;
  };

export const getScorecard: StoreMember<[opts: TakesScorecardOpts, allowList: string[] | undefined], TakesScorecard> =
  async (brain, opts, list) => {
    const o = takeOptions('getScorecard', opts, ['holder', 'domainPrefix', 'since', 'until', 'sourceId', 'sourceIds'], IGNORED_READ_OPTIONS) as TakesScorecardOpts;
    const options = {
      holder: o.holder || null,
      domain_prefix: o.domainPrefix || null,
      since: o.since || null,
      until: o.until || null,
      allow_list: list ? list : null,
      source_ids: sourceScope(o),
    };
    const raw: Parameters<typeof finalizeScorecard>[0] = await storeCall({ member: 'getScorecard' }, () => brain.getScorecard(options));
    return finalizeScorecard(raw);
  };

export const getCalibrationCurve: StoreMember<[opts: CalibrationCurveOpts, allowList: string[] | undefined], CalibrationBucket[]> =
  async (brain, opts, list) => {
    const o = takeOptions('getCalibrationCurve', opts, ['holder', 'bucketSize', 'sourceId', 'sourceIds'], IGNORED_READ_OPTIONS) as CalibrationCurveOpts;
    const bucketSize = o.bucketSize && o.bucketSize > 0 && o.bucketSize <= 1 ? o.bucketSize : 0.1;
    const options = {
      holder: o.holder || null,
      bucket_size: bucketSize,
      allow_list: list ? list : null,
      source_ids: sourceScope(o),
    };
    return storeCall({ member: 'getCalibrationCurve' }, () => brain.getCalibrationCurve(options));
  };

export const addSynthesisEvidence: StoreMember<[rows: SynthesisEvidenceInput[]], number> = async (brain, rows) => {
  if (rows.length === 0) return 0;
  const input = rows.map((r) => ({
    synthesis_page_id: r.synthesis_page_id ?? null,
    take_page_id: r.take_page_id ?? null,
    take_row_num: r.take_row_num ?? null,
    citation_index: r.citation_index ?? null,
  }));
  return storeCall({ member: 'addSynthesisEvidence' }, () => brain.addSynthesisEvidence(input));
};

export const listActiveTakesForPages: StoreMember<[pageIds: number[], opts?: { takesHoldersAllowList?: string[] }], Map<number, Take[]>> =
  async (brain, pageIds, opts = {}) => {
    const out = new Map<number, Take[]>();
    for (const pid of pageIds) out.set(pid, []);
    if (pageIds.length === 0) return out;
    const o = takeOptions('listActiveTakesForPages', opts, ['takesHoldersAllowList']) as { takesHoldersAllowList?: string[] };
    const input = { page_ids: pageIds, allow_list: allowList(o.takesHoldersAllowList) };
    const rows: Take[] = await storeCall({ member: 'listActiveTakesForPages' }, () => brain.listActiveTakesForPages(input));
    for (const take of rows) out.get(take.page_id)?.push(toTake(take));
    return out;
  };

/** Deletes the page's take rows with these row numbers (a fence rewrite drops them). */
export const deleteTakeRows: StoreMember<[pageId: number, rowNums: number[]], void> = async (brain, pageId, rowNums) => {
  await storeCall({ member: 'deleteTakeRows' }, () => brain.deleteTakeRows(pageId, rowNums));
};

/** The row numbers of the page's take rows that match the fence rows, at most `limit`. */
export const matchTakeRows: StoreMember<[pageId: number, rows: TakeFenceRow[], limit: number], number[]> = (brain, pageId, rows, limit) =>
  storeCall({ member: 'matchTakeRows' }, () => brain.matchTakeRows(pageId, rows, limit));
