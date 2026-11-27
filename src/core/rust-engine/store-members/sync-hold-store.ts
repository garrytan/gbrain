/**
 * The git sync hold store and the managed sync pass row reads, answered from the store's op checkpoint rows
 * (rust/docs/store/persistence.md, "Checkpoint rows").
 * The rows are the ones PGLite keeps in `op_checkpoints`: a hold row (`GIT_HOLD_OP`, `<source>:<incarnation>:<path>`)
 * holds `[record]`, a summary row (`GIT_HOLD_SUMMARY_OP`, `<source>:<incarnation>`) holds `[{ source_id, incarnation,
 * count, stale, ... }]`, a pass row (`MANAGED_SYNC_PASS_OP`, `<source>:<incarnation>`) holds `[value]`.
 *
 * Each store call is one store write transaction and the store runs one at a time, so a read followed by a write here
 * sees no other write between them: the summary row lock PGLite and Postgres take is implied. The SQL these members
 * stand for (the hold listing, per-code and image counts and the conversion log among them) is engine-sql/sync-hold-store.ts, engine-sql/sync-hold-reads.ts and engine-sql/persistence-journal.ts.
 * Fingerprints list in byte order, where the SQL orders by the database collation; the two agree on the ASCII paths
 * the parity tests hold.
 */
import { GIT_HOLD_OP, GIT_HOLD_SUMMARY_OP, type HeldCoverageRow, type HeldHitQuery, type HeldHitRow } from '../../engine-sql/persistence-journal.ts';
import { COVERAGE_COUNT_CAP } from '../../search/retrieval-coverage.ts';
import { coveragePatternWord } from './coverage-pattern.ts';
import { GIT_HOLD_RETRY_OP, type GitHoldRecordsQuery, type GitHoldReportInputs, type GitHoldSummaryRow } from '../../engine-sql/sync-hold-reads.ts';
import {
  GIT_HOLD_SUMMARY_COUNTERS, MANAGED_SYNC_PASS_OP, SYNC_CONVERSION_KEEP, SYNC_CONVERSION_OP, gitHoldFingerprint, summaryFingerprint,
  type GitHoldSummaryWeights, type SyncConversion, type SyncPassRowRead, type SyncPassRowWrite,
} from '../../engine-sql/sync-hold-store.ts';
import type { SourceStateRow } from '../../engine-sql/write-misc.ts';
import type { SourceRow } from '../../engine.ts';
import type { StoreBrain } from '../store.ts';
import { storeCall, type StoreMember } from './common.ts';

/** One op checkpoint row as the store returns it. */
interface CheckpointRow { fingerprint: string; completed_keys: unknown; updated_at: string }
type JsonObject = Record<string, unknown>;

/** A live source: its id, current incarnation (as text), archived flag and config. */
interface LiveSource { id: string; incarnation: string; archived: boolean; config: JsonObject }

const first = (row: CheckpointRow | null): JsonObject | null => {
  const keys = row?.completed_keys;
  return Array.isArray(keys) && keys[0] !== undefined && keys[0] !== null ? keys[0] as JsonObject : null;
};

/** `(x->>'name')::int` with COALESCE 0: a missing or null counter is 0. */
const counter = (record: JsonObject | null, name: string): number => {
  const value = record?.[name];
  return value === undefined || value === null ? 0 : Math.trunc(Number(value));
};

/** `x->>'name'`: the text of a JSON value, or null. */
const text = (value: unknown): string | null =>
  value === undefined || value === null ? null : typeof value === 'string' ? value : JSON.stringify(value);

function readRow(brain: StoreBrain, member: string, op: string, fingerprint: string): Promise<CheckpointRow | null> {
  return storeCall({ member }, () => brain.readOpCheckpointRow(op, fingerprint));
}

function listRows(brain: StoreBrain, member: string, op: string, prefix = ''): Promise<CheckpointRow[]> {
  return storeCall({ member }, () => brain.listOpCheckpointRows(op, prefix));
}

/** Every source, archived ones too, with its current incarnation and config. */
async function liveSources(brain: StoreBrain, member: string): Promise<Map<string, LiveSource>> {
  const rows: SourceRow[] = await storeCall({ member }, () => brain.listAllSources({ includeArchived: true }));
  const out = new Map<string, LiveSource>();
  for (const row of rows) {
    const state: SourceStateRow | null = await storeCall({ member, sourceId: row.id }, () => brain.readSourceState(row.id));
    if (state) out.set(row.id, { id: row.id, incarnation: String(state.incarnation), archived: state.archived === true, config: state.config ?? {} });
  }
  return out;
}

/** The source a hold record names (`source_id`, `incarnation`) when that incarnation is the source's current one. */
const holdSource = (sources: Map<string, LiveSource>, record: JsonObject): LiveSource | undefined => {
  const source = sources.get(String(record.source_id));
  return source && source.incarnation === text(record.incarnation) ? source : undefined;
};

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Creates the summary row when missing (`count` and `stale` 0), else re-stamps it; returns its count. */
export const lockGitHoldSummary: StoreMember<[sourceId: string, incarnation: string], number> = async (brain, sourceId, incarnation) => {
  const member = 'lockGitHoldSummary';
  const fingerprint = summaryFingerprint(sourceId, incarnation);
  const row = await readRow(brain, member, GIT_HOLD_SUMMARY_OP, fingerprint);
  // An existing row is re-stamped only while unchanged, so the touch never undoes an adjustment that landed between.
  if (row) await storeCall({ member, sourceId }, () => brain.replaceOpCheckpointRow(GIT_HOLD_SUMMARY_OP, fingerprint, row.completed_keys, row.completed_keys));
  else await storeCall({ member, sourceId }, () => brain.putOpCheckpointRow(GIT_HOLD_SUMMARY_OP, fingerprint, [{ source_id: sourceId, incarnation, count: 0, stale: 0 }]));
  return counter(first(row), 'count');
};

/** Adds `delta` to the count and each weight to its counter, none below zero; no summary row, no write. */
export const adjustGitHoldSummary: StoreMember<[sourceId: string, incarnation: string, delta: number, weights: GitHoldSummaryWeights], void> =
  async (brain, sourceId, incarnation, delta, weights) => {
    const member = 'adjustGitHoldSummary';
    const fingerprint = summaryFingerprint(sourceId, incarnation);
    // Read, then replace only while unchanged: a summary another write moved in between is re-read, never overwritten.
    for (let attempt = 0; attempt < 8; attempt++) {
      const row = await readRow(brain, member, GIT_HOLD_SUMMARY_OP, fingerprint);
      if (!row) return;
      const record: JsonObject = { ...(first(row) ?? {}) };
      record.count = Math.max(0, counter(record, 'count') + Math.trunc(delta));
      for (const name of GIT_HOLD_SUMMARY_COUNTERS) record[name] = Math.max(0, counter(record, name) + Math.trunc(weights[name]));
      if (await storeCall({ member, sourceId }, () => brain.replaceOpCheckpointRow(GIT_HOLD_SUMMARY_OP, fingerprint, row.completed_keys, [record]))) return;
    }
    throw new Error(`adjustGitHoldSummary: the hold summary of ${fingerprint} kept changing under the write`);
  };

export const readGitHoldRow: StoreMember<[sourceId: string, incarnation: string, path: string], never | null> = async (brain, sourceId, incarnation, path) =>
  first(await readRow(brain, 'readGitHoldRow', GIT_HOLD_OP, gitHoldFingerprint(sourceId, incarnation, path))) as never | null;

export const writeGitHoldRow: StoreMember<[sourceId: string, incarnation: string, path: string, record: object], void> = async (brain, sourceId, incarnation, path, record) => {
  await storeCall({ member: 'writeGitHoldRow', sourceId }, () => brain.putOpCheckpointRow(GIT_HOLD_OP, gitHoldFingerprint(sourceId, incarnation, path), [record]));
};

export const replaceGitHoldRow: StoreMember<[sourceId: string, incarnation: string, path: string, expected: object, next: object], boolean> =
  (brain, sourceId, incarnation, path, expected, next) =>
    storeCall({ member: 'replaceGitHoldRow', sourceId }, () =>
      brain.replaceOpCheckpointRow(GIT_HOLD_OP, gitHoldFingerprint(sourceId, incarnation, path), [expected], [next]));

export const deleteGitHoldRow: StoreMember<[sourceId: string, incarnation: string, path: string], void> = async (brain, sourceId, incarnation, path) => {
  await storeCall({ member: 'deleteGitHoldRow', sourceId }, () => brain.deleteOpCheckpoint(GIT_HOLD_OP, gitHoldFingerprint(sourceId, incarnation, path)));
};

export const countGitHolds: StoreMember<[sourceId: string, incarnation: string], number> = async (brain, sourceId, incarnation) =>
  counter(first(await readRow(brain, 'countGitHolds', GIT_HOLD_SUMMARY_OP, summaryFingerprint(sourceId, incarnation))), 'count');

const passRead = <V>(row: CheckpointRow, readAt: string): SyncPassRowRead<V> =>
  ({ value: first(row) as V | null, updated_at: row.updated_at, read_at: readAt });

export const readSyncPassRow: StoreMember<[sourceId: string, incarnation: string], SyncPassRowRead<never> | null> = async (brain, sourceId, incarnation) => {
  const row = await readRow(brain, 'readSyncPassRow', MANAGED_SYNC_PASS_OP, summaryFingerprint(sourceId, incarnation));
  return row ? passRead<never>(row, new Date().toISOString()) : null;
};

/** The pass rows whose fingerprint is a listed (or any) source's current `<id>:<incarnation>`, archived sources too. */
export const readLiveSyncPassRows: StoreMember<[sourceIds: readonly string[] | null], Array<SyncPassRowRead<never> & { source_id: string }>> = async (brain, sourceIds) => {
  const member = 'readLiveSyncPassRows';
  const sources = await liveSources(brain, member);
  const wanted = sourceIds ? new Set(sourceIds) : null;
  const rows = await listRows(brain, member, MANAGED_SYNC_PASS_OP);
  const byFingerprint = new Map(rows.map(row => [row.fingerprint, row]));
  const readAt = new Date().toISOString();
  const out: Array<SyncPassRowRead<never> & { source_id: string }> = [];
  for (const source of sources.values()) {
    if (wanted && !wanted.has(source.id)) continue;
    const row = byFingerprint.get(summaryFingerprint(source.id, source.incarnation));
    if (row) out.push({ source_id: source.id, ...passRead<never>(row, readAt) });
  }
  return out;
};

/**
 * The pass row write under its lease fence (engine-sql/sync-hold-store.ts writeSyncPassRow): it replaces the row read
 * only while that row is unchanged, so a write that raced in between is never overwritten.
 */
export const writeSyncPassRow: StoreMember<[sourceId: string, incarnation: string, value: { lease_token?: unknown }, opts?: SyncPassRowWrite], boolean> =
  async (brain, sourceId, incarnation, value, opts = {}) => {
    const member = 'writeSyncPassRow';
    const fingerprint = summaryFingerprint(sourceId, incarnation);
    let next: JsonObject = value as JsonObject;
    const telemetry = next.telemetry;
    if (opts.clock && telemetry !== null && typeof telemetry === 'object' && !Array.isArray(telemetry)) {
      next = { ...next, telemetry: { ...(telemetry as JsonObject), started_at: new Date().toISOString() } };
    }
    const row = await readRow(brain, member, MANAGED_SYNC_PASS_OP, fingerprint);
    if (!row) {
      if (opts.onlyOpen) return false;
      await storeCall({ member, sourceId }, () => brain.putOpCheckpointRow(MANAGED_SYNC_PASS_OP, fingerprint, [next]));
      return true;
    }
    const stored = first(row);
    const fenced = opts.pin === true || (value.lease_token !== undefined && value.lease_token !== null && text(stored?.lease_token) === String(value.lease_token));
    const open = !opts.onlyOpen || text((stored?.telemetry as JsonObject | undefined)?.outcome) === 'open';
    if (!fenced || !open) return false;
    return storeCall({ member, sourceId }, () => brain.replaceOpCheckpointRow(MANAGED_SYNC_PASS_OP, fingerprint, row.completed_keys, [next]));
  };

/** The current-incarnation hold rows naming these page ids, each with its page's revision (any source, deleted too). */
export const readHeldPageRows: StoreMember<[pageIds: string[]], Array<{ record: never; revision: string | null }>> = async (brain, pageIds) => {
  const member = 'readHeldPageRows';
  const ids = new Set(pageIds.map(String));
  if (ids.size === 0) return [];
  const sources = await liveSources(brain, member);
  const held = (await listRows(brain, member, GIT_HOLD_OP)).flatMap(row => {
    const record = first(row);
    const pageId = record ? text(record.page_id) : null;
    return record && pageId !== null && ids.has(pageId) && holdSource(sources, record) ? [{ record, pageId }] : [];
  });
  const numeric = [...new Set(held.map(h => Number(h.pageId)).filter(Number.isSafeInteger))];
  const revisions = numeric.length
    ? await storeCall({ member }, () => brain.readPageRevisions(numeric)) as Array<{ id: number; knowledge_revision: string | number | null }>
    : [];
  const revisionOf = new Map(revisions.map(row => [String(row.id), row.knowledge_revision === null ? null : String(row.knowledge_revision)]));
  return held.map(h => ({ record: h.record as never, revision: revisionOf.get(String(Number(h.pageId))) ?? null }));
};

/**
 * The holds naming the hits' pages with their page revisions, by fingerprint, then the capped count of held files that
 * could affect the read (persistence/diagnostic_checkpoints.rs). Each relevance pattern is sent as its query word.
 */
export const readHeldHitRows: StoreMember<[query: HeldHitQuery], Array<HeldHitRow<never>>> = async (brain, query) => {
  const member = 'readHeldHitRows';
  const terms = query.patterns.map(pattern => coveragePatternWord(member, pattern));
  return await storeCall({ member }, () => brain.readHeldHitRows({
    holdOp: GIT_HOLD_OP, pageIds: [...query.pageIds], sourceIds: [...query.sourceIds], types: [...query.types], terms, cap: COVERAGE_COUNT_CAP,
  })) as Array<HeldHitRow<never>>;
};

/** The summary rows of unarchived sources' current incarnations with at least one held file, by source id. */
export const readHeldCoverageRows: StoreMember<[sourceIds: string[] | null], HeldCoverageRow[]> = async (brain, sourceIds) => {
  const member = 'readHeldCoverageRows';
  const sources = await liveSources(brain, member);
  const wanted = sourceIds ? new Set(sourceIds) : null;
  const rows = await listRows(brain, member, GIT_HOLD_SUMMARY_OP);
  const byFingerprint = new Map(rows.map(row => [row.fingerprint, row]));
  const out: HeldCoverageRow[] = [];
  for (const source of [...sources.values()].sort((a, b) => byText(a.id, b.id))) {
    if (source.archived || (wanted && !wanted.has(source.id))) continue;
    const row = byFingerprint.get(summaryFingerprint(source.id, source.incarnation));
    const record = row ? first(row) : null;
    if (!row || counter(record, 'count') <= 0) continue;
    out.push({
      source_id: source.id, count: counter(record, 'count'), stale: counter(record, 'stale'), fences: counter(record, 'fences'),
      concurrent: counter(record, 'concurrent'), stalled: counter(record, 'stalled'), dirty: counter(record, 'dirty'), drift: counter(record, 'drift'),
    });
  }
  return out;
};

/** The current-incarnation hold records, marked `read_only_checkout` on a read-only mirror, by source then fingerprint. */
export const readGitHoldRecords: StoreMember<[opts?: GitHoldRecordsQuery], Array<{ record: never }>> = async (brain, opts = {}) => {
  const member = 'readGitHoldRecords';
  const sources = await liveSources(brain, member);
  const wanted = opts.sourceIds ? new Set(opts.sourceIds) : null;
  const held = (await listRows(brain, member, GIT_HOLD_OP)).flatMap(row => {
    const record = first(row);
    const source = record ? holdSource(sources, record) : undefined;
    if (!record || !source || (wanted && !wanted.has(source.id))) return [];
    if (opts.runId !== undefined && opts.runId !== null && text(record.run_id) !== opts.runId) return [];
    const mirror = (text(source.config.mirror_read_only) ?? 'false') === 'true';
    return [{ source: source.id, fingerprint: row.fingerprint, record: mirror ? { ...record, read_only_checkout: true } : record }];
  });
  held.sort((a, b) => byText(a.source, b.source) || byText(a.fingerprint, b.fingerprint));
  return held.map(h => ({ record: h.record as never }));
};

/** The hold records of each source's current incarnation by fingerprint, marked `read_only_checkout` on a read-only mirror (one store listing). */
async function currentHoldRecords(brain: StoreBrain, member: string, sources: Map<string, LiveSource>, wanted: Set<string>): Promise<Map<string, Array<{ fingerprint: string; record: JsonObject }>>> {
  const out = new Map<string, Array<{ fingerprint: string; record: JsonObject }>>();
  for (const row of await listRows(brain, member, GIT_HOLD_OP)) {
    const record = first(row);
    const source = record ? holdSource(sources, record) : undefined;
    if (!record || !source || !wanted.has(source.id)) continue;
    const mirror = (text(source.config.mirror_read_only) ?? 'false') === 'true';
    out.set(source.id, [...(out.get(source.id) ?? []), { fingerprint: row.fingerprint, record: mirror ? { ...record, read_only_checkout: true } : record }]);
  }
  for (const list of out.values()) list.sort((a, b) => byText(a.fingerprint, b.fingerprint));
  return out;
}

/** Each listed source with outstanding holds (its summary count above 0) and its first `limit` records; a source with none listed answers a null record. */
export const readGitHoldListingRows: StoreMember<[sourceIds: readonly string[], limit: number], Array<{ source_id: string; incarnation: string; count: number; record: never | null }>> =
  async (brain, sourceIds, limit) => {
    const member = 'readGitHoldListingRows';
    if (!sourceIds.length) return [];
    const sources = await liveSources(brain, member);
    const wanted = new Set(sourceIds);
    const listed = [...wanted].filter(id => sources.has(id)).sort(byText);
    const records = await currentHoldRecords(brain, member, sources, wanted);
    const take = Math.max(0, Math.floor(limit));
    const out: Array<{ source_id: string; incarnation: string; count: number; record: never | null }> = [];
    for (const id of listed) {
      const source = sources.get(id)!;
      const count = counter(first(await readRow(brain, member, GIT_HOLD_SUMMARY_OP, summaryFingerprint(id, source.incarnation))), 'count');
      if (count <= 0) continue;
      const holds = (records.get(id) ?? []).slice(0, take);
      if (!holds.length) out.push({ source_id: id, incarnation: source.incarnation, count, record: null });
      for (const hold of holds) out.push({ source_id: id, incarnation: source.incarnation, count, record: hold.record as never });
    }
    return out;
  };

/** Each listed source's current-incarnation holds counted per code (`code` null for a record without one). */
export const readGitHoldCodeCountRows: StoreMember<[sourceIds: readonly string[]], Array<{ source_id: string; code: string | null; n: number }>> = async (brain, sourceIds) => {
  const member = 'readGitHoldCodeCountRows';
  if (!sourceIds.length) return [];
  const records = await currentHoldRecords(brain, member, await liveSources(brain, member), new Set(sourceIds));
  const out: Array<{ source_id: string; code: string | null; n: number }> = [];
  for (const [sourceId, list] of [...records].sort(([a], [b]) => byText(a, b))) {
    const counts = new Map<string | null, number>();
    for (const { record } of list) { const code = text(record.code); counts.set(code, (counts.get(code) ?? 0) + 1); }
    for (const [code, n] of counts) out.push({ source_id: sourceId, code, n });
  }
  return out;
};

/** Each listed source whose current-incarnation summary counts unsupported-image holds, with that count. */
export const readGitImageHoldCountRows: StoreMember<[sourceIds: readonly string[]], Array<{ source_id: string; images: number }>> = async (brain, sourceIds) => {
  const member = 'readGitImageHoldCountRows';
  if (!sourceIds.length) return [];
  const sources = await liveSources(brain, member);
  const out: Array<{ source_id: string; images: number }> = [];
  for (const id of [...new Set(sourceIds)].sort(byText)) {
    const source = sources.get(id);
    if (!source) continue;
    const images = counter(first(await readRow(brain, member, GIT_HOLD_SUMMARY_OP, summaryFingerprint(id, source.incarnation))), 'images');
    if (images > 0) out.push({ source_id: id, images });
  }
  return out;
};

/** The stored conversion log of each listed source's current incarnation; a source without a log row is absent. */
export const readSyncConversionRows: StoreMember<[sourceIds: readonly string[]], Array<{ source_id: string; conversions: never[] | null }>> = async (brain, sourceIds) => {
  const member = 'readSyncConversionRows';
  if (!sourceIds.length) return [];
  const sources = await liveSources(brain, member);
  const out: Array<{ source_id: string; conversions: never[] | null }> = [];
  for (const id of [...new Set(sourceIds)].sort(byText)) {
    const source = sources.get(id);
    if (!source) continue;
    const row = await readRow(brain, member, SYNC_CONVERSION_OP, summaryFingerprint(id, source.incarnation));
    if (!row) continue;
    const log = first(row)?.conversions;
    out.push({ source_id: id, conversions: log === undefined ? null : log as never[] | null });
  }
  return out;
};

/**
 * Stamps the source's first connector sync attempt once: one store write that reads the source's incarnation, keys
 * the state row as connectorStateKey does, and keeps an existing stamp (rust/crates/gbrain-store/src/persistence/connector_attempts.rs).
 */
export const recordConnectorSyncAttempt: StoreMember<[sourceId: string, at: string, seed: readonly unknown[]], boolean> =
  (brain, sourceId, at, seed) =>
    storeCall({ member: 'recordConnectorSyncAttempt', sourceId }, () => brain.recordConnectorSyncAttempt(sourceId, at, [...seed])) as Promise<boolean>;

/** Writes an unmanaged connector's cursor row as engine-sql/connector-db-cursor.ts does: one store write (connector_attempts.rs). */
export const writeConnectorDbCursor: StoreMember<[key: string, record: readonly unknown[]], void> = async (brain, key, record) => {
  await storeCall({ member: 'writeConnectorDbCursor' }, () => brain.writeConnectorDbCursor(key, [...record]));
};

/**
 * Puts the conversion first in the source incarnation's log, keeping the newest SYNC_CONVERSION_KEEP: one store write
 * (rust/crates/gbrain-store/src/persistence/sync_conversions.rs).
 */
export const recordSyncConversion: StoreMember<[sourceId: string, incarnation: string, conversion: SyncConversion], void> =
  async (brain, sourceId, incarnation, conversion) => {
    await storeCall({ member: 'recordSyncConversion', sourceId },
      () => brain.recordSyncConversion(sourceId, incarnation, { ...conversion }, SYNC_CONVERSION_KEEP));
  };

/** The pending `sources retry-held` request's keys for this fingerprint, or null. */
export const readGitHoldRetryRequest: StoreMember<[fingerprint: string], Array<{ paths?: unknown }> | null> = async (brain, fingerprint) => {
  const row = await readRow(brain, 'readGitHoldRetryRequest', GIT_HOLD_RETRY_OP, fingerprint);
  return row ? row.completed_keys as Array<{ paths?: unknown }> : null;
};

/** The summary row's counters (null without one) and the text of the source's `mirror_read_only` config key. */
export const readGitHoldReportInputs: StoreMember<[sourceId: string, fingerprint: string], GitHoldReportInputs> = async (brain, sourceId, fingerprint) => {
  const member = 'readGitHoldReportInputs';
  const row = await readRow(brain, member, GIT_HOLD_SUMMARY_OP, fingerprint);
  const record = row ? first(row) : null;
  const summary: GitHoldSummaryRow | null = row ? {
    count: counter(record, 'count'), drift: counter(record, 'drift'), images: counter(record, 'images'), fences: counter(record, 'fences'),
    stalled: counter(record, 'stalled'), concurrent: counter(record, 'concurrent'), dirty: counter(record, 'dirty'),
  } : null;
  const source: SourceStateRow | null = await storeCall({ member, sourceId }, () => brain.readSourceState(sourceId));
  return { summary, mirror: text(source?.config?.mirror_read_only) };
};
