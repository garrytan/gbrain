/**
 * Incremental derivation over a segmented page (Wave B spec 8.1, 8.2, PR 4 lane 4a): the shared driver the unpaid
 * pipelines (links, mentions, timeline, fences) use instead of a full pass over every block.
 *
 * The unit of work is a run: the live manifest rows of one region joined by forced cuts, which bodyBlocks reads
 * together (segment-blocks.ts), so every block a run yields starts where the parsers start fresh. A run's result is
 * stored on its first occurrence's page_segment_derivations row; its other occurrences get a row naming that first
 * occurrence. Each row's context hash covers the run's composition (every member's sha and entry state, its region and
 * whether it opens it), the page's withdrawal ledger and segmenter version, and the page-level inputs the pipeline
 * passes, so a run whose rows all match is current and the work left is found from manifest metadata alone.
 *
 * A run is read only when it is due (or a pipeline asks for a neighbour as context). The read checks that the body
 * generation and the ledger it planned from are still the page's; otherwise it throws SegmentDerivationRaced and the
 * caller falls back to its full pass, so a row never pairs one generation's metadata with another's text.
 */
import { createHash } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import { canonicalJson } from '../belief/keys.ts';
import { planSegmentDerivations, segmentDerivationContextHash, type LiveSegment, type SegmentDerivationKind,
  type SegmentDerivationRow } from './derivations.ts';
import { faultPoint } from '../persistence/fault-points.ts';
import { derivationClaimCandidateSql, derivationHoldsClaimSql, derivationScopeLockSql, derivationSweepScopeSql, foldSql } from './schema.ts';
import { bodyBlocks, type BodyBlock } from './segment-blocks.ts';
import { ledgerApplies, readBodyLedger } from './segment-ledger.ts';
import { SEGMENTER_VERSION } from './segmenter.ts';
import type { BodyRegion, ManifestRow } from './types.ts';

/** Bump a kind's version to re-derive every page's rows of that kind once. fences 2: rows keep fence digests, not fence text. */
export const SEGMENT_PIPELINE_VERSIONS = { links: 1, mentions: 1, timeline: 1, fences: 2 } as const satisfies Partial<Record<SegmentDerivationKind, number>>;
export type UnpaidDerivationKind = keyof typeof SEGMENT_PIPELINE_VERSIONS;

/**
 * @internal Per kind, for the work-volume tests (counts, not time): runs derived and their occurrences, runs reused,
 * writes skipped because the page moved before they could commit (`skipped`), and current runs read again for text
 * their rows do not keep (`reread`).
 */
export const segmentDeriveWork: Record<UnpaidDerivationKind, { derived: number; occurrences: number; reused: number; skipped: number; reread: number }> = {
  links: { derived: 0, occurrences: 0, reused: 0, skipped: 0, reread: 0 }, mentions: { derived: 0, occurrences: 0, reused: 0, skipped: 0, reread: 0 },
  timeline: { derived: 0, occurrences: 0, reused: 0, skipped: 0, reread: 0 }, fences: { derived: 0, occurrences: 0, reused: 0, skipped: 0, reread: 0 },
};

let beforeWrite: ((scope: DerivationScope) => Promise<void>) | null = null;
/** @internal Test seam: runs before each derivation write (a purge forced into the window between the read and the write). */
export function __setBeforeDerivationWriteForTests(fn: ((scope: DerivationScope) => Promise<void>) | null): void { beforeWrite = fn; }

export interface DeriveRun {
  index: number;
  region: BodyRegion;
  /** The run opens its region. */
  first: boolean;
  seqs: number[];
  occurrences: number[];
  shas: Uint8Array[];
  entryStates: unknown[];
  bytes: number;
}

export interface DerivationScope {
  pageId: number;
  slug: string;
  sourceId: string;
  generation: number;
  runs: DeriveRun[];
  /** SHA-256 of the withdrawal ledger when one applies to the page (the overlay changes text), else null. */
  ledgerKey: string | null;
  stale: boolean;
}

export interface SegmentedDerivationPage { id: number; slug: string; source_id: string }

/** The page's body moved (another generation, another ledger) between the plan and the read. */
export class SegmentDerivationRaced extends Error {
  constructor(slug: string) {
    super(`Segmented page ${slug} changed while its derivations were read.`);
    this.name = 'SegmentDerivationRaced';
  }
}

const toJson = (v: unknown) => typeof v === 'string' ? JSON.parse(v) as unknown : v;
const bytesOf = (v: unknown) => v instanceof Uint8Array ? new Uint8Array(v) : new Uint8Array(Buffer.from(String(v).replace(/^\\x/, ''), 'hex'));
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

async function ledgerKey(engine: BrainEngine, page: SegmentedDerivationPage): Promise<string | null> {
  const ledger = await readBodyLedger(engine, page.source_id, page.slug);
  return ledgerApplies(ledger) ? createHash('sha256').update(canonicalJson(ledger)).digest('hex') : null;
}

/** The live runs of a segmented page from its manifest rows (no segment text), or null when it is not segmented. */
export async function derivationScope(engine: BrainEngine, page: SegmentedDerivationPage): Promise<DerivationScope | null> {
  const [state] = await engine.executeRaw<{ body_storage: string; body_generation: string; segmenter_version: number | null }>(
    'SELECT body_storage, body_generation::text AS body_generation, segmenter_version FROM pages WHERE id=$1', [page.id]);
  if (state?.body_storage !== 'segmented') return null;
  const generation = Number(state.body_generation);
  const rows = await engine.executeRaw<{ seq: number; occurrence_id: string; region: BodyRegion; sha256: unknown; entry_state: unknown; cut_kind: string; byte_len: number }>(
    `SELECT seq, occurrence_id::text AS occurrence_id, region, sha256, entry_state, cut_kind, byte_len FROM page_body_manifest
      WHERE page_id=$1 AND staging_id IS NULL AND gen_from<=$2 AND (gen_to IS NULL OR gen_to>$2) ORDER BY seq`, [page.id, generation]);
  const runs: DeriveRun[] = [];
  for (const region of ['truth', 'timeline'] as const) {
    const own = rows.filter(row => row.region === region);
    for (let i = 0; i < own.length;) {
      let j = i;
      while (j + 1 < own.length && own[j]!.cut_kind === 'forced') j++;
      const members = own.slice(i, j + 1);
      runs.push({ index: runs.length, region, first: i === 0, seqs: members.map(row => Number(row.seq)), occurrences: members.map(row => Number(row.occurrence_id)),
        shas: members.map(row => bytesOf(row.sha256)), entryStates: members.map(row => toJson(row.entry_state)), bytes: members.reduce((n, row) => n + Number(row.byte_len), 0) });
      i = j + 1;
    }
  }
  return { pageId: page.id, slug: page.slug, sourceId: page.source_id, generation, runs, ledgerKey: await ledgerKey(engine, page),
    stale: Number(state.segmenter_version) !== SEGMENTER_VERSION };
}

/** The identity of a run's stored text and of its place in its region. */
export function runIdentity(run: DeriveRun): unknown {
  return [run.region, run.first, run.shas.map(hex), run.entryStates];
}

/** Per member occurrence, the context hash of `run` for `kind` under the page-level `inputs`. */
export function runContextHashes(kind: UnpaidDerivationKind, scope: DerivationScope, run: DeriveRun, inputs: Record<string, unknown>): Uint8Array[] {
  const page = { ...inputs, run: runIdentity(run), ledger: scope.ledgerKey, stale: scope.stale };
  return run.entryStates.map((entryState, i) => segmentDerivationContextHash(kind, { entryState, page: { ...page, member: i } }));
}

export interface RunPlan<O> {
  /** Runs to derive, in page order. */
  todo: DeriveRun[];
  /** Outputs of the runs whose rows all match, by run index. */
  current: Map<number, O>;
}

/** Split a page's runs into due and current for `kind`, given each run's page-level inputs (`inputsOf`) and its rows (`read`, else read here). */
export async function planRuns<O>(engine: BrainEngine, kind: UnpaidDerivationKind, scope: DerivationScope,
  inputsOf: (run: DeriveRun) => Record<string, unknown>, read?: readonly SegmentDerivationRow[]): Promise<RunPlan<O>> {
  const result = splitRuns<O>(kind, scope, inputsOf, read ?? await engine.readSegmentDerivations(scope.pageId, { kind }));
  segmentDeriveWork[kind].reused += result.current.size;
  return result;
}

function splitRuns<O>(kind: UnpaidDerivationKind, scope: DerivationScope, inputsOf: (run: DeriveRun) => Record<string, unknown>,
  rows: readonly SegmentDerivationRow[]): RunPlan<O> {
  const live: LiveSegment[] = [];
  for (const run of scope.runs) {
    const hashes = runContextHashes(kind, scope, run, inputsOf(run));
    run.occurrences.forEach((occurrenceId, i) => live.push({ occurrenceId, sha256: run.shas[i]!, contextHash: hashes[i]! }));
  }
  const plan = planSegmentDerivations(kind, SEGMENT_PIPELINE_VERSIONS[kind], live, rows);
  const settled = new Map(plan.current.map(row => [row.occurrenceId, row]));
  const result: RunPlan<O> = { todo: [], current: new Map() };
  for (const run of scope.runs) {
    const first = settled.get(run.occurrences[0]!);
    if (first && run.occurrences.every(id => settled.has(id))) result.current.set(run.index, first.output as O);
    else result.todo.push(run);
  }
  return result;
}

/**
 * Read the blocks of the runs `wanted` names (a set of indices, or a predicate asked as each run is reached, in order),
 * in page order, handing each to `onBlock` with its run; the region separator between truth and timeline is handed
 * with run null. Runs not wanted are never read. Throws SegmentDerivationRaced when the page's generation or ledger
 * moved from the scope's.
 */
export async function readRuns(engine: BrainEngine, scope: DerivationScope, wanted: ReadonlySet<number> | ((run: DeriveRun) => boolean),
  onBlock: (run: DeriveRun | null, block: BodyBlock) => void | Promise<void>, opts: { separator?: string } = {}): Promise<void> {
  if (typeof wanted !== 'function' && !wanted.size) return;
  const wants = typeof wanted === 'function' ? wanted : (run: DeriveRun) => wanted.has(run.index);
  const bySeq = new Map(scope.runs.map(run => [run.seqs[0]!, run]));
  let current: DeriveRun | null = null;
  const page = { id: scope.pageId, slug: scope.slug, source_id: scope.sourceId };
  for await (const block of bodyBlocks(engine, page, {
    ...(opts.separator !== undefined ? { separator: opts.separator } : {}),
    want: ({ seqs }) => {
      const run = bySeq.get(seqs[0]!);
      if (!run || run.seqs.length !== seqs.length || run.seqs.some((seq, i) => seq !== seqs[i])) throw new SegmentDerivationRaced(scope.slug);
      current = wants(run) ? run : null;
      return current !== null;
    },
  })) await onBlock(block.region === null ? null : current, block);
  await assertScopeCurrent(engine, scope);
}

/** The page still has the scope's generation and ledger. */
export async function assertScopeCurrent(engine: BrainEngine, scope: DerivationScope): Promise<void> {
  const [state] = await engine.executeRaw<{ body_generation: string; body_storage: string }>(
    'SELECT body_generation::text AS body_generation, body_storage FROM pages WHERE id=$1', [scope.pageId]);
  if (state?.body_storage !== 'segmented' || Number(state.body_generation) !== scope.generation
    || await ledgerKey(engine, { id: scope.pageId, slug: scope.slug, source_id: scope.sourceId }) !== scope.ledgerKey) throw new SegmentDerivationRaced(scope.slug);
}

/**
 * Store the outputs of derived runs (`outputs` by run index, under the inputs `inputsOf` gives) and delete the rows of
 * occurrences no longer live. The first occurrence of a run holds its output; the others name it.
 */
export async function commitRuns(engine: BrainEngine, kind: UnpaidDerivationKind, scope: DerivationScope, outputs: ReadonlyMap<number, unknown>,
  inputsOf: (run: DeriveRun) => Record<string, unknown>): Promise<void> {
  if (await storeRuns(engine, kind, scope, outputs, inputsOf)) await engine.retireSegmentDerivations(scope.pageId, scope.runs.flatMap(run => run.occurrences), { kind });
}

/** Rows per guarded insert statement. */
const STORE_BATCH_ROWS = 64;

/**
 * Store the outputs of derived runs. Each statement inserts only while the page row, read FOR SHARE, is still
 * segmented at the scope's generation: a purge, a fence rewrite (forget, withdrawal, edit) or a demotion holds that
 * row FOR UPDATE until it commits and moves the generation, so a statement racing one waits for it and then writes
 * nothing, and a statement that committed first is in place for that writer's deletes. A single statement, not a
 * transaction, so a caller's own transaction or connection is never waited on. Returns false, counted in `skipped`,
 * when the page moved; the caller's result still stands for the generation it read.
 */
async function storeRuns(engine: BrainEngine, kind: UnpaidDerivationKind, scope: DerivationScope, outputs: ReadonlyMap<number, unknown>,
  inputsOf: (run: DeriveRun) => Record<string, unknown>): Promise<boolean> {
  const rows: Array<Record<string, unknown>> = [];
  let occurrences = 0;
  for (const [index, output] of outputs) {
    const run = scope.runs[index]!;
    const hashes = runContextHashes(kind, scope, run, inputsOf(run));
    occurrences += run.occurrences.length;
    run.occurrences.forEach((occurrenceId, i) => rows.push({ pipeline: kind, occurrence_id: occurrenceId, pipeline_version: SEGMENT_PIPELINE_VERSIONS[kind],
      segment_sha256: hex(run.shas[i]!), context_hash: hex(hashes[i]!), output: i === 0 ? output : { run: run.occurrences[0] } }));
  }
  if (!rows.length) return true;
  await beforeWrite?.(scope);
  for (let at = 0; at < rows.length; at += STORE_BATCH_ROWS) {
    const written = await engine.executeRaw(`WITH live AS (SELECT id FROM pages WHERE id=$1 AND body_storage='segmented' AND body_generation=$2 FOR SHARE)
      INSERT INTO page_segment_derivations (page_id, pipeline, occurrence_id, pipeline_version, segment_sha256, context_hash, state, output, receipt)
      SELECT live.id, d.pipeline, d.occurrence_id, d.pipeline_version, decode(d.segment_sha256, 'hex'), decode(d.context_hash, 'hex'), 'done', d.output, NULL
      FROM live, jsonb_to_recordset($3::text::jsonb) AS d(pipeline text, occurrence_id bigint, pipeline_version int, segment_sha256 text, context_hash text, output jsonb)
      ON CONFLICT (page_id, pipeline, occurrence_id) DO UPDATE SET pipeline_version = EXCLUDED.pipeline_version, segment_sha256 = EXCLUDED.segment_sha256,
        context_hash = EXCLUDED.context_hash, state = EXCLUDED.state, output = EXCLUDED.output, receipt = EXCLUDED.receipt, updated_at = now()
      RETURNING 1`, [scope.pageId, scope.generation, JSON.stringify(rows.slice(at, at + STORE_BATCH_ROWS))]);
    if (!written.length) {
      segmentDeriveWork[kind].skipped++;
      return false;
    }
  }
  segmentDeriveWork[kind].derived += outputs.size;
  segmentDeriveWork[kind].occurrences += occurrences;
  return true;
}

/** Runs per batch of streamRuns: rows and texts of at most this many runs are held at once. */
const STREAM_BATCH_RUNS = 2;

/** How streamRuns derives one due run: `start` makes its empty output, `block` folds each of its blocks in. */
export interface RunDeriver<O> {
  start(run: DeriveRun): O;
  block(output: O, block: BodyBlock): void;
}

/**
 * planRuns, deriving and visiting for a kind whose outputs are large (one entry per timeline line), holding the rows of
 * at most STREAM_BATCH_RUNS runs and one due run's output at a time. The rows are read in batches to find the due runs;
 * then one read of the body (readRuns) derives each due run in page order, stores it and hands it to `visit`, and the
 * current runs before it are handed over from their rows, read again in batches. Every block read also goes to
 * `onBlock`. A current run whose rows changed in between throws SegmentDerivationRaced. Rows of occurrences no longer
 * live are deleted at the end.
 */
export async function streamRuns<O>(engine: BrainEngine, kind: UnpaidDerivationKind, scope: DerivationScope,
  inputsOf: (run: DeriveRun) => Record<string, unknown>, deriver: RunDeriver<O>, visit: (run: DeriveRun, output: O) => void,
  onBlock?: (run: DeriveRun | null, block: BodyBlock) => void): Promise<void> {
  const batchRows = (runs: readonly DeriveRun[]) => engine.readSegmentDerivations(scope.pageId, { kind, occurrenceIds: runs.flatMap(run => run.occurrences) });
  const due = new Set<number>();
  for (let at = 0; at < scope.runs.length; at += STREAM_BATCH_RUNS) {
    const batch = scope.runs.slice(at, at + STREAM_BATCH_RUNS);
    for (const run of (await planRuns<O>(engine, kind, { ...scope, runs: batch }, inputsOf, await batchRows(batch))).todo) due.add(run.index);
  }
  let next = 0;
  const handOver = async (until: number) => {
    while (next < until) {
      const batch = scope.runs.slice(next, Math.min(until, next + STREAM_BATCH_RUNS)).filter(run => !due.has(run.index));
      const plan = splitRuns<O>(kind, { ...scope, runs: batch }, inputsOf, await batchRows(batch));
      if (plan.todo.length) throw new SegmentDerivationRaced(scope.slug);
      for (const run of batch) visit(run, plan.current.get(run.index)!);
      next = Math.min(until, next + STREAM_BATCH_RUNS);
    }
  };
  let deriving: { run: DeriveRun; output: O } | null = null;
  let moved = false;
  const finish = async () => {
    if (!deriving) return;
    const { run, output } = deriving;
    deriving = null;
    if (!await storeRuns(engine, kind, scope, new Map([[run.index, output]]), inputsOf)) moved = true;
    visit(run, output);
    next = run.index + 1;
  };
  const begin = async (run: DeriveRun, block: BodyBlock) => {
    await finish();
    await handOver(run.index);
    deriving = { run, output: deriver.start(run) };
    deriver.block(deriving.output, block);
  };
  await readRuns(engine, scope, due, (run, block) => {
    onBlock?.(run, block);
    if (!run) return;
    if (deriving?.run !== run) return begin(run, block);
    deriver.block(deriving.output, block);
  });
  await finish();
  await handOver(scope.runs.length);
  if (!moved) await engine.retireSegmentDerivations(scope.pageId, scope.runs.flatMap(run => run.occurrences), { kind });
}

/** Bytes of neighbouring runs whose link rows a rewrite also drops: a link excerpt reaches 120 units past its block. */
const LINK_REACH_BYTES = 4096;

/**
 * Delete the derivation rows that may hold text a fence rewrite (forget, purge, withdrawal; spec 11) replaced, in the
 * caller's transaction: every kind's rows of each run holding a rewritten row (a run's output sits on its first
 * occurrence), the links rows of the runs on either side up to LINK_REACH_BYTES away, whose candidate excerpts can
 * reach into it, and every unpaid kind's rows of occurrences that had already left the live body (a pipeline retires
 * them only when it next runs, so they can still hold the text). `rows` is the generation's manifest in order;
 * `spans` the rewritten index ranges. Returns the rows deleted.
 */
export async function deleteRewrittenDerivations(engine: BrainEngine, pageId: number,
  rows: ReadonlyArray<Pick<ManifestRow, 'occurrenceId' | 'region' | 'cutKind' | 'byteLen'>>, spans: ReadonlyArray<{ from: number; to: number }>): Promise<number> {
  const joined = (i: number) => i + 1 < rows.length && rows[i]!.cutKind === 'forced' && rows[i]!.region === rows[i + 1]!.region;
  const runOf = (i: number): [number, number] => {
    let from = i, to = i;
    while (from > 0 && joined(from - 1)) from--;
    while (joined(to)) to++;
    return [from, to];
  };
  const touched = new Set<number>(), reach = new Set<number>();
  const add = (into: Set<number>, from: number, to: number) => { for (let i = from; i <= to; i++) into.add(rows[i]!.occurrenceId); };
  for (const span of spans) {
    const [from] = runOf(span.from), [, to] = runOf(span.to);
    add(touched, from, to);
    for (let at = from - 1, bytes = 0; at >= 0 && bytes < LINK_REACH_BYTES;) {
      const [a, b] = runOf(at);
      add(reach, a, b);
      for (let i = a; i <= b; i++) bytes += rows[i]!.byteLen;
      at = a - 1;
    }
    for (let at = to + 1, bytes = 0; at < rows.length && bytes < LINK_REACH_BYTES;) {
      const [a, b] = runOf(at);
      add(reach, a, b);
      for (let i = a; i <= b; i++) bytes += rows[i]!.byteLen;
      at = b + 1;
    }
  }
  if (!touched.size) return 0;
  return (await engine.executeRaw(`DELETE FROM page_segment_derivations WHERE page_id=$1
    AND (occurrence_id = ANY($2::bigint[]) OR (pipeline = 'links' AND occurrence_id = ANY($3::bigint[]))
      OR (pipeline = ANY($4::text[]) AND NOT (occurrence_id = ANY($5::bigint[])))) RETURNING 1`,
  [pageId, [...touched], [...reach], Object.keys(SEGMENT_PIPELINE_VERSIONS), rows.map(row => row.occurrenceId)])).length;
}

/**
 * Claims as the derivation predicates match them: each claim's folded normalized text between spaces (`needles`), and
 * for each a LIKE pattern of its words in order (`patterns`), which the prefilter tries on a row's raw text.
 */
export interface DerivationNeedles { needles: string[]; patterns: string[] }

/**
 * The claims in the form the derivation predicates take, normalized by the database (gbrain_fact_normalize, then
 * foldSql), so the needle and the rows go through the same SQL. A claim that normalizes to nothing matches nothing.
 */
export async function derivationNeedles(engine: Pick<BrainEngine, 'executeRaw'>, claims: readonly string[]): Promise<DerivationNeedles> {
  const list = [...new Set(claims.filter(Boolean))];
  const rows = list.length ? await engine.executeRaw<{ f: string }>(`SELECT DISTINCT f FROM (SELECT ${foldSql('gbrain_fact_normalize(c)')} AS f
    FROM unnest($1::text[]) c) x WHERE f <> '' ORDER BY f`, [list]) : [];
  // A word holding a control character is spelled \uXXXX in a row's JSON text, so it cannot prefilter.
  const pattern = (text: string) => ['', ...text.split(' ').filter(t => t && !/[\u0000-\u001f]/.test(t)).map(t => t.replace(/[\\%_]/g, '\\$&')), ''].join('%');
  return { needles: rows.map(row => ` ${row.f} `), patterns: rows.map(row => pattern(row.f)) };
}

/**
 * Bounds of a fact purge's derivation sweep and of its receipt probe: each statement reads at most `batchRows` rows of
 * the source, walking them in primary-key order (so the rows it normalizes are bounded too), fewer after a statement
 * outran `statementMs` (the batch halves, down to one row); a sweep statement runs in a transaction of its own under
 * `statementMs`; one continueDerivationPurges call starts no new batch past `totalMs` (`inlineMs` for the call a
 * purge makes before it returns; it runs at least one), and the next call resumes from the stored cursor. A walk that
 * ends while a writer holds the source's scope lock waits at most `finalizeWaitMs` for it before leaving it to a later call.
 */
export const DERIVATION_SWEEP_LIMITS = { batchRows: 500, totalMs: 120_000, statementMs: 5_000, inlineMs: 5_000, finalizeWaitMs: 1_500 } as const;
let sweepLimits: { batchRows: number; totalMs: number; statementMs: number; inlineMs: number; finalizeWaitMs: number } = { ...DERIVATION_SWEEP_LIMITS };
let afterSweepBatch: (() => Promise<void>) | null = null;
/** @internal Test seam: run `fn` after each committed batch of continueDerivationPurges (null removes it). */
export function __setAfterDerivationSweepBatchForTests(fn: (() => Promise<void>) | null): void { afterSweepBatch = fn; }
let beforeUnreadDelete: ((tx: BrainEngine) => Promise<void>) | null = null;
/** @internal Test seam: run `fn` in a sweep's unread-delete transaction, after it picked the row and before it deletes it (null removes it). */
export function __setBeforeUnreadDerivationDeleteForTests(fn: ((tx: BrainEngine) => Promise<void>) | null): void { beforeUnreadDelete = fn; }
/** The pipelines whose rows a sweep may delete unread: unpaid, so rederiving them costs nothing. */
const UNPAID_PIPELINES: readonly string[] = Object.keys(SEGMENT_PIPELINE_VERSIONS);
/** @internal Test seam: shrink the sweep's bounds (null restores them). */
export function __setDerivationSweepLimitsForTests(limits: Partial<typeof sweepLimits> | null): void {
  sweepLimits = { ...DERIVATION_SWEEP_LIMITS, ...(limits ?? {}) };
}
/** The rows one sweep or probe statement reads. */
export function derivationBatchRows(): number { return sweepLimits.batchRows; }

/** A derivation row's primary key, the cursor a batched walk resumes after. */
export type DerivationKey = [pageId: number, pipeline: string, occurrenceId: string];

/** SQL predicate: row `d` comes after the cursor in the int, text and bigint parameters `at` (all null: the first batch). */
export function derivationAfterSql(d: string, at: [string, string, string]): string {
  return `(${at[0]}::int IS NULL OR (${d}.page_id, ${d}.pipeline, ${d}.occurrence_id) > (${at[0]}::int, ${at[1]}::text, ${at[2]}::bigint))`;
}

/**
 * @internal For the work-volume tests (counts, not time): per page, the derivation rows each sweep's first walk read,
 * normalized and deleted; per statement of a sweep's first walk, of its verify and recheck walks (`verify`) or of a
 * receipt probe, the rows it read and normalized. Recorded only while
 * __setDerivationSweepWorkForTests(true) is in effect.
 */
export const derivationSweepWork: Array<{ pageId: number; scanned: number; normalized: number; deleted: number }> = [];
export const derivationSweepStatements: Array<{ phase: 'sweep' | 'verify' | 'probe'; scanned: number; normalized: number }> = [];
let recordSweepWork = false;
/** @internal Test seam: start (clearing what is there) or stop recording derivationSweepWork and derivationSweepStatements. */
export function __setDerivationSweepWorkForTests(on: boolean): void {
  recordSweepWork = on;
  derivationSweepWork.length = 0;
  derivationSweepStatements.length = 0;
}
/** @internal Records one statement's rows while a test records sweep work. */
export function recordDerivationStatement(entry: { phase: 'sweep' | 'verify' | 'probe'; scanned: number; normalized: number }): void {
  if (recordSweepWork) derivationSweepStatements.push(entry);
}

/**
 * Record a fact purge's derivation sweep in the purge's transaction: the claims' normalized forms (derivationNeedles)
 * and `pageIds`, the pages it rewrote, keyed by the purge request. From the purge's commit the trigger on
 * page_segment_derivations refuses rows holding the claim on those pages (schema.ts), and continueDerivationPurges
 * deletes the rows already there. A claim that normalizes to nothing records nothing.
 */
export async function recordDerivationPurge(engine: Pick<BrainEngine, 'executeRaw'>, requestId: string, sourceId: string, pageIds: readonly number[],
  claims: readonly string[]): Promise<void> {
  const { needles, patterns } = await derivationNeedles(engine, claims);
  if (!needles.length) return;
  await engine.executeRaw(`INSERT INTO page_segment_derivation_purges (request_id, source_id, needles, patterns, page_ids)
    VALUES ($1::uuid, $2, $3::text[], $4::text[], $5::int[]) ON CONFLICT (request_id) DO NOTHING`, [requestId, sourceId, needles, patterns, [...pageIds]]);
}

/** A recorded derivation sweep of a purge request: still walking (`pending`) or stopped on a row it could not sweep within its statement budget (`stalled`). */
export type DerivationSweepState = 'pending' | 'stalled';
/**
 * Why a pending sweep has not ended: `scope_lock_busy`, it walked to its end but a write in the source that brings
 * stored results into its scope (an import or sync still open) held the scope lock past the bounded wait.
 */
export type DerivationPendingReason = 'scope_lock_busy';
/**
 * Why a sweep stalled: `statement_timeout`, even deleting a single unpaid row unread outran the budget;
 * `paid_row_unreadable`, a row of a paid pipeline alone outran it (paid rows are never deleted unread).
 */
export type DerivationStallReason = 'statement_timeout' | 'paid_row_unreadable';

/** The state of a purge request's derivation sweep (with why it stalled, or why a pending one has not ended), or null once it is verified and its record is gone. */
export async function derivationPurgeState(engine: Pick<BrainEngine, 'executeRaw'>, requestId: string):
  Promise<{ state: DerivationSweepState; reason: DerivationStallReason | DerivationPendingReason | null } | null> {
  const [row] = await engine.executeRaw<{ stalled: boolean; reason: DerivationStallReason | null; pending: DerivationPendingReason | null }>(
    'SELECT stalled_at IS NOT NULL AS stalled, stalled_reason AS reason, pending_reason AS pending FROM page_segment_derivation_purges WHERE request_id=$1::uuid', [requestId]);
  return row ? { state: row.stalled ? 'stalled' : 'pending', reason: row.stalled ? row.reason ?? 'statement_timeout' : row.pending ?? null } : null;
}

/**
 * Whether a recorded sweep covers page `pageId` (a page its purge rewrote, or a soft-deleted page of its source): the
 * trigger drops a derivation write there that holds the claim, so a paid pipeline makes no call for it until the sweep ends.
 */
export async function derivationSweepCoversPage(engine: Pick<BrainEngine, 'executeRaw'>, pageId: number): Promise<boolean> {
  return (await engine.executeRaw(`SELECT 1 FROM page_segment_derivation_purges x JOIN pages p ON p.source_id = x.source_id
    WHERE p.id = $1 AND (p.id = ANY(x.page_ids) OR p.deleted_at IS NOT NULL) LIMIT 1`, [pageId])).length > 0;
}

type SweepRecord = { request_id: string; needles: string[]; patterns: string[]; page_ids: number[]; phase: 'sweep' | 'verify' | 'recheck'; recheck: number[] | null;
  found: number; cursor_page: number | null; cursor_pipeline: string | null; cursor_occurrence: string | null; batch_rows: number };

/**
 * Continue the recorded derivation sweeps of a source: the sweep of request `opts.first` first, then the others oldest
 * first, skipping a stalled one (`opts.retry` names one to try again). Each batch is a transaction of its own that locks
 * the sweep's record (one another caller is walking is left to it), reads the next rows of the source after its cursor,
 * the record's batch size of them (DERIVATION_SWEEP_LIMITS.batchRows at first), deletes those in the sweep's scope
 * (derivationSweepScopeSql over its pages) that hold the claim (derivationHoldsClaimSql; only rows passing the
 * prefilter, derivationClaimCandidateSql, are normalized) and stores the cursor. No batch locks the source or a page, so
 * writes go on during a sweep.
 *
 * A batch that outruns DERIVATION_SWEEP_LIMITS.statementMs rolls back and halves the record's batch size, down to one
 * row. A single row of an unpaid pipeline that still outruns it is deleted unread when it is in scope, the scope
 * predicate repeated in the DELETE itself (a page restored meanwhile keeps its row): unpaid rows are rederived from the
 * segments for free. A paid pipeline's row is never deleted unread: the record is marked stalled
 * (`paid_row_unreadable`), as it is when even the unread delete outruns its budget (`statement_timeout`). A stalled
 * record is skipped from then on, so it blocks no other sweep, until `opts.retry` names it.
 *
 * At the end of the source the first walk (`sweep`) is followed by a `verify` walk, repeated until one deletes nothing;
 * then the pages that entered the scope meanwhile (page_segment_derivation_purge_pages) are checked again, and only
 * when none of their rows the sweep covers holds the claim is the record deleted. A writer that brings rows into the
 * scope holds the source's scope lock (derivationScopeLockSql) shared from the trigger's first firing to its commit,
 * and leaves no note when it fired before the sweep was recorded. So both the move from the first walk to `verify`
 * (every writer open when the sweep was recorded has ended, and every verify walk sees its rows) and the end of the
 * record (every noted page is visible) happen under that lock held exclusively. It is tried without waiting at the end
 * of a walk; when a writer holds it, the record waits at the end of its walk (its cursor kept) and the call waits for
 * the lock at most DERIVATION_SWEEP_LIMITS.finalizeWaitMs in a transaction of its own that holds no other lock, so no
 * deadlock is possible and writers that arrive meanwhile queue behind it. Holding it, the rest of the walk is read
 * without deleting (a row lock is never awaited under it) and, when none of it holds the claim, the walk ends there;
 * the noted pages are read the same way, and walked again (`recheck`) only when one holds the claim or they hold more
 * than a batch of rows. A wait that times out leaves the record where it is for a later call, marked `scope_lock_busy`
 * (cleared as the sweep moves on); no walk restarts.
 * No batch starts past DERIVATION_SWEEP_LIMITS.totalMs (the lower `inlineMs` for the
 * purge's own call, `opts.inline`, so a purge returns `pending` soon after it recorded the sweep); the next call resumes
 * from the cursor. Returns the rows deleted.
 */
export async function continueDerivationPurges(engine: BrainEngine, sourceId: string, opts: { first?: string; retry?: string; inline?: boolean } = {}): Promise<number> {
  const { batchRows: maxRows, statementMs } = sweepLimits;
  const deadline = performance.now() + (opts.inline ? Math.min(sweepLimits.inlineMs, sweepLimits.totalMs) : sweepLimits.totalMs);
  const pages = new Map<number, { scanned: number; normalized: number; deleted: number }>();
  if (opts.retry) await engine.executeRaw('UPDATE page_segment_derivation_purges SET stalled_at = NULL, stalled_reason = NULL, pending_reason = NULL WHERE request_id=$1::uuid', [opts.retry]);
  const skip: string[] = [];
  const restart = 'cursor_page = NULL, cursor_pipeline = NULL, cursor_occurrence = NULL, found = 0, pending_reason = NULL';
  const toVerify = async (tx: BrainEngine, purge: SweepRecord) => {
    await tx.executeRaw('DELETE FROM page_segment_derivation_purge_pages WHERE request_id=$1::uuid', [purge.request_id]);
    await tx.executeRaw(`UPDATE page_segment_derivation_purges SET phase = 'verify', recheck = NULL, ${restart} WHERE request_id=$1::uuid`, [purge.request_id]);
  };
  /** Read-only: whether at most the record's batch size of rows after `at` (on `onPages`; every page when null) are all there are, and how many the sweep covers hold the claim. */
  const unswept = async (tx: BrainEngine, purge: SweepRecord, at: [number | null, string | null, string | null], onPages: number[] | null) => {
    const [row] = await tx.executeRaw<{ scanned: number; hits: number }>(`WITH batch AS MATERIALIZED (
        SELECT d.page_id, d.pipeline, d.occurrence_id, ${derivationSweepScopeSql('d', 'p', '$2')} AS swept FROM page_segment_derivations d
        JOIN pages p ON p.id = d.page_id WHERE p.source_id = $1 AND ${derivationAfterSql('d', ['$5', '$6', '$7'])} AND ($9::int[] IS NULL OR d.page_id = ANY($9::int[]))
        ORDER BY d.page_id, d.pipeline, d.occurrence_id LIMIT $8
      ) SELECT (SELECT count(*)::int FROM batch) AS scanned, count(*) FILTER (WHERE CASE WHEN ${derivationClaimCandidateSql('d', '$4')}
          THEN ${derivationHoldsClaimSql('d', '$3', '$4')} ELSE false END)::int AS hits
        FROM batch b JOIN page_segment_derivations d ON d.page_id = b.page_id AND d.pipeline = b.pipeline AND d.occurrence_id = b.occurrence_id WHERE b.swept`,
    [sourceId, purge.page_ids, purge.needles, purge.patterns, ...at, purge.batch_rows, onPages]);
    return { all: Number(row?.scanned ?? 0) < Number(purge.batch_rows), hits: Number(row?.hits ?? 0) };
  };
  /** The end of a walk, under the source's scope lock held exclusively. */
  const finish = async (tx: BrainEngine, purge: SweepRecord) => {
    if (purge.phase === 'sweep') return toVerify(tx, purge);
    const noted = (await tx.executeRaw<{ page_id: number }>('DELETE FROM page_segment_derivation_purge_pages WHERE request_id=$1::uuid RETURNING page_id',
      [purge.request_id])).map(row => Number(row.page_id));
    if (noted.length) {
      const check = await unswept(tx, purge, [null, null, null], noted);
      if (!check.all || check.hits) {
        await tx.executeRaw(`UPDATE page_segment_derivation_purges SET phase = 'recheck', recheck = $2::int[], ${restart} WHERE request_id=$1::uuid`, [purge.request_id, noted]);
        return;
      }
    }
    await tx.executeRaw('DELETE FROM page_segment_derivation_purges WHERE request_id=$1::uuid', [purge.request_id]);
    await tx.executeRaw(`DELETE FROM page_segment_derivation_purge_pages n WHERE NOT EXISTS (SELECT 1 FROM page_segment_derivation_purges x
      WHERE x.request_id = n.request_id)`);
  };
  let parked: string | null = null;
  const endWalk = async (tx: BrainEngine, purge: SweepRecord, found: number, last: [number, string, string] | null) => {
    if (purge.phase === 'verify' && found > 0) return toVerify(tx, purge);
    const held = await faultPoint('purge:derivation_scope_lock', { sourceId, requestId: purge.request_id }).then(async () => (await tx.executeRaw<{ held: boolean }>(
      `SELECT pg_try_advisory_xact_lock(${derivationScopeLockSql('$1::text')}) AS held`, [sourceId]))[0]?.held === true, error => {
      if ((error as { code?: unknown } | null)?.code === '55P03') return false;
      throw error;
    });
    if (held) return finish(tx, purge);
    await tx.executeRaw(`UPDATE page_segment_derivation_purges SET cursor_page = COALESCE($2::int, cursor_page), cursor_pipeline = COALESCE($3::text, cursor_pipeline),
      cursor_occurrence = COALESCE($4::bigint, cursor_occurrence), found = $5, pending_reason = NULL WHERE request_id=$1::uuid`, [purge.request_id, ...(last ?? [null, null, null]), found]);
    parked = purge.request_id;
  };
  /** A record waiting at the end of its walk: wait for the scope lock (holding no other), then end the walk if the rest of it holds nothing to sweep. */
  const finishParked = async (requestId: string) => {
    try {
      await engine.transaction(async tx => {
        await tx.executeRaw("SELECT set_config('statement_timeout',$1,true), set_config('lock_timeout',$2,true)", [`${statementMs}ms`, `${sweepLimits.finalizeWaitMs}ms`]);
        await faultPoint('purge:derivation_scope_lock', { sourceId, requestId });
        await tx.executeRaw(`SELECT pg_advisory_xact_lock(${derivationScopeLockSql('$1::text')})`, [sourceId]);
        const [purge] = await tx.executeRaw<SweepRecord>(`SELECT request_id::text AS request_id, needles, patterns, page_ids, phase, recheck, found, cursor_page,
            cursor_pipeline, cursor_occurrence::text AS cursor_occurrence, LEAST(COALESCE(batch_rows, $2), $2) AS batch_rows
          FROM page_segment_derivation_purges WHERE request_id=$1::uuid AND stalled_at IS NULL FOR UPDATE SKIP LOCKED`, [requestId, maxRows]);
        if (!purge) {
          skip.push(requestId);
          return;
        }
        const rest = await unswept(tx, purge, [purge.cursor_page, purge.cursor_pipeline, purge.cursor_occurrence], purge.recheck);
        if (rest.all && !rest.hits) await finish(tx, purge);
      });
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      if (code !== '55P03' && code !== '57014') throw error;
      if (code === '55P03') await engine.executeRaw("UPDATE page_segment_derivation_purges SET pending_reason = 'scope_lock_busy' WHERE request_id=$1::uuid", [requestId]);
      skip.push(requestId);
    }
  };
  const timedOut = (error: unknown) => (error as { code?: unknown } | null)?.code === '57014';
  const stall = async (requestId: string, reason: DerivationStallReason) => {
    await engine.executeRaw('UPDATE page_segment_derivation_purges SET stalled_at = now(), stalled_reason = $2, pending_reason = NULL WHERE request_id=$1::uuid', [requestId, reason]);
    skip.push(requestId);
  };
  for (let batches = 0; batches === 0 || performance.now() <= deadline; batches++) {
    let picked: SweepRecord | null = null;
    parked = null;
    type Row = { page_id: number | null; swept: number; normalized: number; deleted: number; scanned: number; last_page: number; last_pipeline: string; last_occurrence: string };
    let rows: Row[] | 'paid' | null;
    try {
      rows = await engine.transaction(async tx => {
        await tx.executeRaw("SELECT set_config('statement_timeout',$1,true)", [`${statementMs}ms`]);
        const [purge] = await tx.executeRaw<SweepRecord>(`SELECT request_id::text AS request_id, needles, patterns, page_ids, phase, recheck, found, cursor_page,
            cursor_pipeline, cursor_occurrence::text AS cursor_occurrence, LEAST(COALESCE(batch_rows, $4), $4) AS batch_rows
          FROM page_segment_derivation_purges WHERE source_id=$1 AND stalled_at IS NULL AND NOT (request_id = ANY($3::uuid[]))
          ORDER BY COALESCE(request_id = $2::uuid, false) DESC, created_at, request_id LIMIT 1 FOR UPDATE SKIP LOCKED`,
        [sourceId, opts.first ?? null, skip, maxRows]);
        if (!purge) return null;
        picked = purge;
        await faultPoint('purge:derivation_batch', { sourceId, requestId: purge.request_id, round: Number(purge.batch_rows),
          read: purge.cursor_page === null ? '' : `${purge.cursor_page}/${purge.cursor_pipeline}/${purge.cursor_occurrence}` });
        const batch = await tx.executeRaw<Row>(`WITH batch AS MATERIALIZED (
            SELECT d.page_id, d.pipeline, d.occurrence_id, ${derivationSweepScopeSql('d', 'p', '$2')} AS swept FROM page_segment_derivations d
            JOIN pages p ON p.id = d.page_id WHERE p.source_id = $1 AND ${derivationAfterSql('d', ['$5', '$6', '$7'])}
              AND ($9::int[] IS NULL OR d.page_id = ANY($9::int[]))
            ORDER BY d.page_id, d.pipeline, d.occurrence_id LIMIT $8
          ), scope AS MATERIALIZED (
            SELECT d.page_id, d.pipeline, d.occurrence_id, d.output, d.receipt, ${derivationClaimCandidateSql('d', '$4')} AS candidate
            FROM batch b JOIN page_segment_derivations d ON d.page_id = b.page_id AND d.pipeline = b.pipeline AND d.occurrence_id = b.occurrence_id
            WHERE b.swept
          ), hits AS MATERIALIZED (
            SELECT s.page_id, s.pipeline, s.occurrence_id FROM scope s WHERE s.candidate AND ${derivationHoldsClaimSql('s', '$3', '$4')}
          ), gone AS (
            DELETE FROM page_segment_derivations x USING hits h WHERE x.page_id = h.page_id AND x.pipeline = h.pipeline
              AND x.occurrence_id = h.occurrence_id RETURNING x.page_id
          ), last AS (
            SELECT b.page_id, b.pipeline, b.occurrence_id::text AS occurrence_id FROM batch b ORDER BY b.page_id DESC, b.pipeline DESC, b.occurrence_id DESC LIMIT 1
          ), per_page AS (
            SELECT s.page_id, count(*)::int AS swept, count(*) FILTER (WHERE s.candidate)::int AS normalized,
              (SELECT count(*)::int FROM gone g WHERE g.page_id = s.page_id) AS deleted FROM scope s GROUP BY s.page_id
          ) SELECT pp.page_id, COALESCE(pp.swept, 0) AS swept, COALESCE(pp.normalized, 0) AS normalized, COALESCE(pp.deleted, 0) AS deleted,
            (SELECT count(*)::int FROM batch) AS scanned, l.page_id AS last_page, l.pipeline AS last_pipeline, l.occurrence_id AS last_occurrence
          FROM (SELECT 1) one LEFT JOIN last l ON true LEFT JOIN per_page pp ON true ORDER BY pp.page_id`,
        [sourceId, purge.page_ids, purge.needles, purge.patterns, purge.cursor_page, purge.cursor_pipeline, purge.cursor_occurrence, purge.batch_rows, purge.recheck]);
        const found = Number(purge.found) + batch.reduce((n, row) => n + Number(row.deleted), 0);
        if (Number(batch[0]?.scanned ?? 0) < Number(purge.batch_rows)) {
          await endWalk(tx, purge, found, batch[0]?.last_page == null ? null : [Number(batch[0].last_page), batch[0].last_pipeline, String(batch[0].last_occurrence)]);
        }
        else await tx.executeRaw(`UPDATE page_segment_derivation_purges SET cursor_page=$2, cursor_pipeline=$3, cursor_occurrence=$4::bigint, found=$5, pending_reason = NULL
          WHERE request_id=$1::uuid`, [purge.request_id, Number(batch[0]!.last_page), batch[0]!.last_pipeline, String(batch[0]!.last_occurrence), found]);
        return batch;
      });
    } catch (error) {
      const purge = picked as SweepRecord | null;
      if (!timedOut(error) || !purge) throw error;
      if (Number(purge.batch_rows) > 1) {
        await engine.executeRaw('UPDATE page_segment_derivation_purges SET batch_rows=$2 WHERE request_id=$1::uuid', [purge.request_id, Math.floor(Number(purge.batch_rows) / 2)]);
        continue;
      }
      try {
        rows = await engine.transaction(async tx => {
          await tx.executeRaw("SELECT set_config('statement_timeout',$1,true)", [`${statementMs}ms`]);
          await faultPoint('purge:derivation_unread', { sourceId, requestId: purge.request_id });
          const [next] = await tx.executeRaw<{ page_id: number; pipeline: string; occurrence_id: string; swept: boolean }>(`SELECT d.page_id, d.pipeline,
              d.occurrence_id::text AS occurrence_id, ${derivationSweepScopeSql('d', 'p', '$2')} AS swept FROM page_segment_derivations d
            JOIN pages p ON p.id = d.page_id WHERE p.source_id = $1 AND ${derivationAfterSql('d', ['$3', '$4', '$5'])} AND ($6::int[] IS NULL OR d.page_id = ANY($6::int[]))
            ORDER BY d.page_id, d.pipeline, d.occurrence_id LIMIT 1`,
          [sourceId, purge.page_ids, purge.cursor_page, purge.cursor_pipeline, purge.cursor_occurrence, purge.recheck]);
          if (!next) {
            await endWalk(tx, purge, Number(purge.found), null);
            return [];
          }
          if (next.swept && !UNPAID_PIPELINES.includes(next.pipeline)) return 'paid' as const;
          await beforeUnreadDelete?.(tx);
          const deleted = next.swept ? (await tx.executeRaw(`DELETE FROM page_segment_derivations d USING pages p WHERE d.page_id=$1 AND d.pipeline=$2
              AND d.occurrence_id=$3::bigint AND p.id = d.page_id AND p.source_id = $4 AND d.pipeline = ANY($6::text[]) AND ${derivationSweepScopeSql('d', 'p', '$5')} RETURNING 1`,
            [Number(next.page_id), next.pipeline, next.occurrence_id, sourceId, purge.page_ids, UNPAID_PIPELINES])).length : 0;
          await tx.executeRaw(`UPDATE page_segment_derivation_purges SET cursor_page=$2, cursor_pipeline=$3, cursor_occurrence=$4::bigint, found=found + $5, pending_reason = NULL
            WHERE request_id=$1::uuid`, [purge.request_id, Number(next.page_id), next.pipeline, next.occurrence_id, deleted]);
          return [{ page_id: Number(next.page_id), swept: next.swept ? 1 : 0, normalized: 0, deleted, scanned: 1, last_page: Number(next.page_id), last_pipeline: next.pipeline,
            last_occurrence: next.occurrence_id }];
        });
      } catch (unread) {
        if (!timedOut(unread)) throw unread;
        await stall(purge.request_id, 'statement_timeout');
        continue;
      }
      if (rows === 'paid') {
        await stall(purge.request_id, 'paid_row_unreadable');
        continue;
      }
    }
    if (!rows) break;
    const walk = (picked as SweepRecord | null)?.phase === 'sweep' ? 'sweep' : 'verify';
    recordDerivationStatement({ phase: walk, scanned: Number(rows[0]?.scanned ?? 0), normalized: rows.reduce((n, row) => n + Number(row.normalized), 0) });
    if (walk === 'sweep') for (const row of rows) {
      if (row.page_id === null) continue;
      const page = pages.get(Number(row.page_id)) ?? { scanned: 0, normalized: 0, deleted: 0 };
      pages.set(Number(row.page_id), { scanned: page.scanned + Number(row.swept), normalized: page.normalized + Number(row.normalized), deleted: page.deleted + Number(row.deleted) });
    }
    await afterSweepBatch?.();
    if (parked) await finishParked(parked);
  }
  const sorted = [...pages].sort((a, b) => a[0] - b[0]);
  if (recordSweepWork) for (const [pageId, work] of sorted) derivationSweepWork.push({ pageId, ...work });
  return sorted.reduce((n, [, work]) => n + work.deleted, 0);
}

/** SHA-256 hex (its first 32 digits) of a key, recorded in an output instead of the key's text. */
export function keyDigest(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 32);
}
