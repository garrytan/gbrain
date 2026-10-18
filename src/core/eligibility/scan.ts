/**
 * DX-6 / ENG-8 scan step: run the write gate's deterministic detector over
 * rows that existed before the gate (or were written while it was off), so
 * activation control (CEO-20) covers legacy content too.
 *
 * Scope: rows at `agent_written` or lower (the activation ceiling) in pages,
 * facts, takes and timeline entries. A detector hit records a `flag` receipt
 * (`write_gate_receipts`, deduped on target + content hash + detector
 * version) and never moves, hides or rewrites the row itself: the scan
 * only makes the row ineligible for proactive injection until the owner
 * confirms it. Zero model calls.
 *
 * Refuses (recovery_required) while a claimed source's lift is unfinished
 * (trust/claim.ts): those legacy rows are about to become owner tier.
 *
 * Bounded and resumable: keyset batches by id per table, with the cursor
 * (the detector version it was taken under and the id ceiling it covers:
 * the max ids the write gate went live at (`write_gate.scan_baseline`), or,
 * without a baseline for the current detector, the max ids when the scan
 * began; rows above it are gated by their writers) in `op_checkpoints`. A
 * detector-version bump restarts the scan from the beginning; stored
 * verdicts from the older version stay until the rescan re-assesses
 * (ENG-21). Doctor `trust_scan` reports the unscanned count.
 */
import type { BrainEngine } from '../engine.ts';
import {
  assessFactForGate, assessPageForGate, assessTakeForGate, assessTimelineForGate, WRITE_GATE_DETECTOR_VERSION,
  type WriteGateAssessment, type WriteGateConfig,
} from '../write-gate.ts';
import { recordWriteGateReceipt } from '../write-gate-store.ts';
import { WRITE_GATE_SCAN_BASELINE_KEY } from '../write-gate-schema.ts';
import { storedTrustTier, TRUST_TIER_RANK, TRUST_TIERS, type TrustTier } from '../trust/tier.ts';
import { ACTIVATION_TIER_CEILING } from './sql.ts';
import { opError } from '../ops/contract.ts';
import { claimPendingSql, TRUST_CLAIM_RESUME_COMMAND } from '../trust/claim-state.ts';

export type ScanTable = 'pages' | 'facts' | 'takes' | 'timeline_entries';
export const SCAN_TABLES: readonly ScanTable[] = ['pages', 'facts', 'takes', 'timeline_entries'];

const CHECKPOINT_OP = 'trust_scan';
const CHECKPOINT_KEY = 'v1';
export const DEFAULT_SCAN_BATCH = 500;

/** Every hit is recorded as a flag: the scan never quarantines or rejects retroactively. */
const SCAN_CONFIG: WriteGateConfig = { externalMode: 'flag', agentMode: 'flag' };

/** Tiers the scan covers: at or below the activation ceiling. */
export const SCAN_TIERS: readonly TrustTier[] = TRUST_TIERS.filter(t => TRUST_TIER_RANK[t] <= TRUST_TIER_RANK[ACTIVATION_TIER_CEILING]);
const tierList = SCAN_TIERS.map(t => `'${t}'`).join(',');

/**
 * `until` is each table's max id when the scan (for this detector version)
 * first ran: rows above it were written after the gate went live and are
 * gated at write time, so the scan's work is bounded and it can complete.
 */
interface Cursor { detector_version: number; ids: Partial<Record<ScanTable, number>>; until?: Partial<Record<ScanTable, number>>; completed_at?: string }

async function readCursor(engine: Pick<BrainEngine, 'executeRaw'>): Promise<Cursor | null> {
  const [row] = await engine.executeRaw<{ keys: unknown }>(
    'SELECT completed_keys AS keys FROM op_checkpoints WHERE op = $1 AND fingerprint = $2', [CHECKPOINT_OP, CHECKPOINT_KEY]);
  const keys = typeof row?.keys === 'string' ? JSON.parse(row.keys) as unknown : row?.keys;
  const first = Array.isArray(keys) ? keys[0] as Cursor | undefined : undefined;
  return first && typeof first === 'object' && typeof first.detector_version === 'number' ? first : null;
}

async function saveCursor(engine: Pick<BrainEngine, 'executeRaw'>, cursor: Cursor): Promise<void> {
  await engine.executeRaw(`INSERT INTO op_checkpoints(op, fingerprint, completed_keys) VALUES ($1, $2, $3::text::jsonb)
    ON CONFLICT (op, fingerprint) DO UPDATE SET completed_keys = EXCLUDED.completed_keys, updated_at = now()`,
  [CHECKPOINT_OP, CHECKPOINT_KEY, JSON.stringify([cursor])]);
}

/**
 * Each table's max id when the write gate went live (migration v227, under
 * the detector version it records): rows above it were assessed by their writers. Only a baseline taken
 * under the current detector bounds the scan; a detector bump rescans all.
 */
async function readBaseline(engine: Pick<BrainEngine, 'executeRaw'>): Promise<Cursor['until'] | null> {
  const [row] = await engine.executeRaw<{ value: string }>('SELECT value FROM config WHERE key = $1', [WRITE_GATE_SCAN_BASELINE_KEY]);
  const parsed = row ? JSON.parse(row.value) as { detector_version?: unknown; until?: unknown } : null;
  return parsed?.detector_version === WRITE_GATE_DETECTOR_VERSION && parsed.until && typeof parsed.until === 'object'
    ? parsed.until as Cursor['until'] : null;
}

/** The cursor that applies to the current detector; an older detector's cursor starts over from the gate's baseline, if any. */
async function currentCursor(engine: Pick<BrainEngine, 'executeRaw'>): Promise<Cursor> {
  const stored = await readCursor(engine).catch(() => null);
  if (stored && stored.detector_version === WRITE_GATE_DETECTOR_VERSION) return stored;
  const until = await readBaseline(engine).catch(() => null);
  return { detector_version: WRITE_GATE_DETECTOR_VERSION, ids: {}, ...(until ? { until } : {}) };
}

interface Row { id: number | string; source_id: string | null; trust_tier: string; write_origin: unknown; [k: string]: unknown }

const SELECT: Readonly<Record<ScanTable, string>> = {
  pages: `SELECT p.id, p.source_id, p.trust_tier, p.write_origin, p.title, p.compiled_truth, p.timeline, p.frontmatter FROM pages p
    WHERE p.id > $1 AND p.deleted_at IS NULL AND p.trust_tier IN (${tierList}) ORDER BY p.id LIMIT $2`,
  facts: `SELECT f.id, f.source_id, f.trust_tier, f.write_origin, f.fact, f.context, f.value, f.source FROM facts f
    WHERE f.id > $1 AND f.trust_tier IN (${tierList}) ORDER BY f.id LIMIT $2`,
  takes: `SELECT t.id, p.source_id, t.trust_tier, t.write_origin, t.claim, t.source FROM takes t JOIN pages p ON p.id = t.page_id
    WHERE t.id > $1 AND t.trust_tier IN (${tierList}) ORDER BY t.id LIMIT $2`,
  timeline_entries: `SELECT te.id, p.source_id, te.trust_tier, te.write_origin, te.summary, te.detail, te.source FROM timeline_entries te
    JOIN pages p ON p.id = te.page_id WHERE te.id > $1 AND te.trust_tier IN (${tierList}) ORDER BY te.id LIMIT $2`,
};

const text = (v: unknown) => (typeof v === 'string' ? v : null);
const json = (v: unknown): Record<string, unknown> | null => {
  const parsed = typeof v === 'string' ? (() => { try { return JSON.parse(v) as unknown; } catch { return null; } })() : v;
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
};

function assess(table: ScanTable, row: Row): WriteGateAssessment {
  const input = { tier: storedTrustTier(row.trust_tier), origin: json(row.write_origin) as never };
  switch (table) {
    case 'pages': return assessPageForGate({ title: text(row.title), compiled_truth: text(row.compiled_truth) ?? '', timeline: text(row.timeline), frontmatter: json(row.frontmatter) }, input, SCAN_CONFIG);
    case 'facts': return assessFactForGate({ fact: text(row.fact) ?? '', context: text(row.context), value: text(row.value), source: text(row.source) }, input, SCAN_CONFIG);
    case 'takes': return assessTakeForGate({ claim: text(row.claim) ?? '', source: text(row.source) }, input, SCAN_CONFIG);
    case 'timeline_entries': return assessTimelineForGate({ summary: text(row.summary) ?? '', detail: text(row.detail), source: text(row.source) }, input, SCAN_CONFIG);
  }
}

export interface TrustScanTableReport { table: ScanTable; scanned: number; flagged: number; done: boolean }
export interface TrustScanReport {
  detector_version: number;
  tables: TrustScanTableReport[];
  complete: boolean;
  /** Present while rows remain: the command that continues. */
  resume_command?: string;
}

export interface TrustScanOptions {
  batchSize?: number;
  /** Stop after this many batches per table (bounded runs from a job or doctor remediation). */
  maxBatches?: number;
}

/**
 * Scans forward from the stored cursor (always resumable; the cursor is
 * saved after every batch). Each batch's receipts commit with its cursor
 * advance, so an interrupted run neither loses nor repeats a verdict.
 */
export async function runTrustScan(engine: BrainEngine, opts: TrustScanOptions = {}): Promise<TrustScanReport> {
  const batchSize = Math.max(1, Math.min(opts.batchSize ?? DEFAULT_SCAN_BATCH, 10_000));
  // A claimed source's legacy rows are owner tier once its lift finishes; scanning them first would flag the owner's own notes.
  const pending = await engine.executeRaw<{ id: string }>(`SELECT s.id FROM sources s WHERE ${claimPendingSql('s')} ORDER BY s.id`);
  if (pending.length) {
    throw opError('recovery_required', `Claimed source(s) ${pending.map(r => r.id).join(', ')} have not finished their lift, so the scan would treat the owner's notes as unverified.`,
      'Run the fix (it finishes the claim the owner already confirmed), then run the scan again.', {
        fix: { argv: [...TRUST_CLAIM_RESUME_COMMAND], consent: [], actor: 'agent', requires_exclusive: false,
          why: 'Finishes lifting the claimed sources\' legacy rows in resumable batches; nothing goes above "your notes".', verify: { argv: ['gbrain', 'doctor', '--only', 'trust_sources_unclaimed', '--json'] } },
      });
  }
  const cursor = await currentCursor(engine);
  if (!cursor.until) {
    cursor.until = {};
    for (const table of SCAN_TABLES) {
      const [row] = await engine.executeRaw<{ n: number | string | null }>(`SELECT max(id) AS n FROM ${table}`);
      cursor.until[table] = Number(row?.n ?? 0);
    }
    await saveCursor(engine, cursor);
  }
  const tables: TrustScanTableReport[] = [];
  for (const table of SCAN_TABLES) {
    const report: TrustScanTableReport = { table, scanned: 0, flagged: 0, done: false };
    const until = cursor.until[table] ?? 0;
    for (let batch = 0; opts.maxBatches === undefined || batch < opts.maxBatches; batch++) {
      const after = cursor.ids[table] ?? 0;
      if (after >= until) { report.done = true; break; }
      // Page bodies are large: their batches stay small whatever the caller asked for.
      const limit = table === 'pages' ? Math.min(batchSize, 100) : batchSize;
      const rows = (await engine.executeRaw<Row>(SELECT[table], [after, limit])).filter(r => Number(r.id) <= until);
      if (rows.length === 0) { cursor.ids[table] = until; await saveCursor(engine, cursor); report.done = true; break; }
      await engine.transaction(async tx => {
        for (const row of rows) {
          const assessment = assess(table, row);
          if (assessment.verdict !== 'flag') continue;
          await recordWriteGateReceipt(tx, { targetTable: table, targetId: row.id, sourceId: row.source_id, assessment });
          report.flagged++;
        }
        cursor.ids[table] = rows.length === limit ? Number(rows[rows.length - 1].id) : until;
        await saveCursor(tx, cursor);
      });
      report.scanned += rows.length;
      if (rows.length < limit) { report.done = true; break; }
    }
    tables.push(report);
  }
  const complete = tables.every(t => t.done);
  if (complete) await saveCursor(engine, { ...cursor, completed_at: new Date().toISOString() });
  return { detector_version: WRITE_GATE_DETECTOR_VERSION, tables, complete, ...(complete ? {} : { resume_command: 'gbrain trust scan' }) };
}

export interface TrustScanState { detector_version: number; unscanned: Record<ScanTable, number>; total_unscanned: number; completed_at: string | null }

/**
 * Rows at or below the activation ceiling the current detector has not
 * scanned (doctor `trust_scan`): everything before the first run, then the
 * rows between the cursor and the run's id ceiling.
 */
export async function readTrustScanState(engine: Pick<BrainEngine, 'executeRaw'>): Promise<TrustScanState> {
  const cursor = await currentCursor(engine);
  const unscanned = {} as Record<ScanTable, number>;
  for (const table of SCAN_TABLES) {
    const alias = { pages: 'pages', facts: 'facts', takes: 'takes', timeline_entries: 'timeline_entries' }[table];
    const live = table === 'pages' ? ' AND deleted_at IS NULL' : '';
    const ceiling = cursor.until ? ` AND id <= ${Number(cursor.until[table] ?? 0)}` : '';
    const [row] = await engine.executeRaw<{ n: number | string }>(
      `SELECT count(*)::int AS n FROM ${alias} WHERE id > $1 AND trust_tier IN (${tierList})${live}${ceiling}`, [cursor.ids[table] ?? 0]);
    unscanned[table] = Number(row?.n ?? 0);
  }
  return {
    detector_version: WRITE_GATE_DETECTOR_VERSION, unscanned,
    total_unscanned: SCAN_TABLES.reduce((n, t) => n + unscanned[t], 0), completed_at: cursor.completed_at ?? null,
  };
}
