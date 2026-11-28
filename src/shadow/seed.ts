/**
 * The shadow seed (plan PR S3, rust/docs/store/seed.md): copies the primary brain into a fresh Rust store, so a
 * shadow run compares answers from the same data.
 *
 * Every read runs in one read-only snapshot of the primary (REPEATABLE READ on Postgres; one transaction on
 * PGLite) with the digest session settings, so timestamps, floats and bytes read as the text the store decodes.
 * Each relation of `seedPlan()` is read in keyset batches by its key columns and sent to `importRelation`; the
 * pages read carries its `page_projection_jobs` row. In the same snapshot the seed counts the gaps (rows the store
 * does not copy and does not name as a loss), the rows of each not-copied table, the unfinished jobs and the
 * segmented pages, and writes them to `seed.json`. The seed writes no row to the primary (opening a PGLite primary still takes its process lock
 * and lets PGLite rewrite its own control and log files).
 */
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../core/engine.ts';
import type { ColumnMeta } from '../core/persistence/engine-graduation.types.ts';
import {
  DIGEST_SESSION_SETTINGS, digestQuery, quoteIdent, readKeysetRows, tableColumns, type DigestPlan,
} from '../core/persistence/graduation-digest.ts';
import type { SeedDigest, SeedImportResult, SeedPlan, SeedRow } from '../core/rust-engine/store.ts';
import { rowDigest, sortKey, sortKeyUnsupported } from './follow-digest.ts';
import type { ManagedStorageRecord } from './managed-gate.ts';
import { countSeedGaps, primaryTables, type SeedQuery } from './seed-gaps.ts';

export const SEED_RECORD_VERSION = 1;
export const DEFAULT_SEED_BATCH_ROWS = 500;
export const DEFAULT_SEED_BUDGET_MS = 30 * 60_000;
/** The largest `--batch-rows`: one batch is held in memory twice (the read and the store call). */
export const MAX_SEED_BATCH_ROWS = 10_000;
/** Sets the seed budget in minutes when `--budget-minutes` is not given; `0` or `none` means no limit. */
export const SEED_BUDGET_ENV = 'GBRAIN_SHADOW_SEED_BUDGET_MINUTES';

/**
 * A seed budget in minutes, as `--budget-minutes` or `GBRAIN_SHADOW_SEED_BUDGET_MINUTES` give it, in milliseconds:
 * null for `0` or `none` (no limit), undefined for text that is not a number of minutes.
 */
export function parseSeedBudgetMs(raw: string): number | null | undefined {
  const text = raw.trim().toLowerCase();
  if (text === 'none') return null;
  if (!/^\d+(\.\d+)?$/.test(text)) return undefined;
  const minutes = Number(text);
  if (minutes === 0) return null;
  const ms = Math.max(1, Math.round(minutes * 60_000));
  return Number.isFinite(ms) ? ms : undefined;
}

/** `30-minute`, `1.5-minute`: the budget as the error text names it. */
function budgetText(budgetMs: number): string {
  const minutes = budgetMs / 60_000;
  return `${Number.isInteger(minutes) ? minutes : Number(minutes.toFixed(2))}-minute`;
}

/** The store calls the seed makes: `RustStore`'s seed methods. */
export interface SeedTarget {
  seedPlan(): Promise<SeedPlan>;
  importRelation(seedId: string, relation: string, rows: SeedRow[], digests?: SeedDigest[]): Promise<SeedImportResult>;
}

export interface SeedRelationRecord {
  rows_read: number;
  imported: number;
  skipped: number;
  dropped: number;
  /** Columns the store does not keep that held a value other than their default. */
  unmapped_columns: string[];
  /** The primary has no such table (an older schema); nothing was read. */
  absent?: true;
}

/** `seed.json`: what the seed copied, what it left behind, and the gaps a swap check refuses on. */
export interface SeedRecord {
  version: typeof SEED_RECORD_VERSION;
  seed_id: string;
  started_at: string;
  finished_at: string;
  primary_engine: string;
  /** Whether the brain used managed storage when the seed read it (right before the snapshot). Absent in a record written before this field existed. */
  storage?: ManagedStorageRecord;
  relations: Record<string, SeedRelationRecord>;
  losses: {
    /** Values in copied rows the store could not keep, by kind (rust/docs/store/seed.md "Losses"). */
    values: Record<string, number>;
    /** The tables the seed leaves behind on purpose, with the read that differs and the rows they held. */
    not_copied: Array<{ table: string; kind: string; read: string; rows: number }>;
    /** Every gap, the same counts as `unseeded_gap_rows`. */
    gaps: Record<string, number>;
  };
  /** Rows of brain state the store did not copy and the seed does not name as a loss, by gap. */
  unseeded_gap_rows: Record<string, number>;
  unseeded_gap_rows_total: number;
  /** `minion_jobs` rows not yet finished: `gbrain jobs list` on the seeded store does not show them. */
  non_terminal_jobs: number;
  /** Pages whose body is stored in segments: the seeded store reads them as shells, without their text. */
  segmented_pages: number;
  /** The store holds a digest entry for every row it copied: the follower and reconcile need them. Absent in a seed written before follow. */
  digests?: true;
}

export const RESEED_STEPS = 'gbrain engine shadow stop --delete (deletes the store, ledger and reports), then gbrain engine shadow seed, then gbrain engine shadow start --plan, then gbrain engine shadow start --yes --expect <plan_hash> to turn shadow mode on again';

export interface SeedOptions {
  primaryEngine: string;
  /** The storage mode the caller read before the snapshot; recorded in `seed.json` as is. */
  storage?: ManagedStorageRecord;
  batchRows?: number;
  /** The wall-clock budget in milliseconds; null means no limit, undefined the default (30 minutes). */
  budgetMs?: number | null;
  now?: () => Date;
  seedId?: string;
  /** Called after each batch, for progress on stderr; the seed waits for a returned promise. */
  onBatch?: (relation: string, rowsRead: number) => void | Promise<void>;
}

/** What to run after a budget stop: a larger budget, with `--restart` to clear the partial store first. */
export const SEED_BUDGET_FIX = `Raise the budget and seed again from the start: gbrain engine shadow seed --restart --budget-minutes <n> (or set ${SEED_BUDGET_ENV}; 0 or none means no limit). --restart deletes the partial Rust store first; nothing in the brain changes`;

export class SeedBudgetError extends Error {
  constructor(readonly relation: string, readonly budgetMs: number) {
    super(`the seed ran past its ${budgetText(budgetMs)} budget while copying ${relation}, so it stopped; the Rust store holds a partial seed and no seed.json was written. ${SEED_BUDGET_FIX}`);
  }
}

/** Columns the pages read adds from `page_projection_jobs` (rust/crates/gbrain-store/src/seed/core.rs). */
const PROJECTION_JOB_COLUMNS = [
  ['projection_job_revision', 'j.revision'],
  ['projection_job_reason', 'j.reason'],
  ['projection_job_updated_at', 'j.updated_at'],
] as const;

const TERMINAL_JOB_STATUSES = ['completed', 'failed', 'dead', 'cancelled'];

/**
 * The keyset read of one relation: every stored column as text, keyed by the plan's key columns. `extra` are further
 * SELECT expressions (aliased by the caller) that ride along without being part of the row.
 */
export async function relationRead(tx: BrainEngine, relation: string, keyNames: readonly string[], extra: readonly string[] = []): Promise<DigestPlan> {
  const all = await tableColumns(tx, relation);
  // A generated column and a tsvector are derived by the store from kept columns; they are never sent.
  const columns: ColumnMeta[] = all.filter(c => !c.generated && c.type !== 'tsvector');
  const key = keyNames.map(name => {
    const meta = all.find(c => c.name === name);
    if (!meta) throw new Error(`shadow seed: ${relation} has no key column ${name}`);
    return meta;
  });
  const list = [
    ...key.map((k, i) => `t.${quoteIdent(k.name)}::text AS ${quoteIdent(`k${i}`)}`),
    ...columns.map((c, i) => `t.${quoteIdent(c.name)}::text AS ${quoteIdent(`c${i}`)}`),
  ];
  let from = `${quoteIdent(relation)} AS t`;
  if (relation === 'pages') {
    for (const [name, expr] of PROJECTION_JOB_COLUMNS) {
      list.push(`${expr}::text AS ${quoteIdent(`c${columns.length}`)}`);
      columns.push({ name, type: 'text', category: 'S', collatable: true, generated: false });
    }
    from += ' LEFT JOIN sources AS s ON s.id = t.source_id'
      + ' LEFT JOIN page_projection_jobs AS j ON j.source_incarnation = s.incarnation AND j.slug = t.slug';
  }
  return { relation, columns, key, select: `SELECT ${[...list, ...extra].join(', ')} FROM ${from}`, filter: '' };
}

async function countRows(query: SeedQuery, sql: string, params: unknown[] = []): Promise<number> {
  const [row] = await query(sql, params);
  return Number(row?.n ?? 0);
}

/**
 * Seeds `target` from `primary` in one read-only snapshot and returns the record to write as `seed.json`.
 * Throws `SeedBudgetError` past the budget; the store then holds a partial seed and must be replaced
 * (`gbrain engine shadow seed --restart`). A seed never resumes into a partial store: every row it copies must come
 * from the one snapshot it reads.
 */
export async function runSeed(primary: BrainEngine, target: SeedTarget, opts: SeedOptions): Promise<SeedRecord> {
  const now = opts.now ?? (() => new Date());
  const batchRows = opts.batchRows ?? DEFAULT_SEED_BATCH_ROWS;
  const budgetMs = opts.budgetMs === undefined ? DEFAULT_SEED_BUDGET_MS : opts.budgetMs;
  const started = now();
  const seedId = opts.seedId ?? `seed-${started.toISOString().replace(/[-:.]/g, '')}-${randomUUID().slice(0, 8)}`;
  const plan = await target.seedPlan();

  return primary.transaction(async tx => {
    const query = digestQuery(tx);
    // The first statement of the transaction fixes its snapshot for every later read.
    await query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await query(DIGEST_SESSION_SETTINGS);
    const tables = new Set(await primaryTables(query));

    const relations: Record<string, SeedRelationRecord> = {};
    const values: Record<string, number> = {};
    for (const { relation, key } of plan.relations) {
      const rec: SeedRelationRecord = { rows_read: 0, imported: 0, skipped: 0, dropped: 0, unmapped_columns: [] };
      relations[relation] = rec;
      if (!tables.has(relation)) { rec.absent = true; continue; }
      const read = await relationRead(tx, relation, key);
      const unmapped = new Set<string>();
      const digested = sortKeyUnsupported(read.key) === null;
      let after: readonly string[] | null = null;
      for (;;) {
        if (budgetMs !== null && now().getTime() - started.getTime() > budgetMs) throw new SeedBudgetError(relation, budgetMs);
        const rows = await readKeysetRows(tx, read, after, batchRows);
        if (!rows.length) break;
        const result = await target.importRelation(seedId, relation, rows.map(r => r.values), digested
          ? rows.map((r): SeedDigest => ({ sort: sortKey(read.key, r.key).toString('hex'), digest: rowDigest(r.values).toString('hex') }))
          : undefined);
        rec.rows_read += rows.length;
        rec.imported += result.imported;
        rec.skipped += result.skipped;
        rec.dropped += result.dropped;
        for (const c of result.unmapped_columns) unmapped.add(c);
        for (const [kind, n] of Object.entries(result.losses)) values[kind] = (values[kind] ?? 0) + n;
        await opts.onBatch?.(relation, rec.rows_read);
        after = rows[rows.length - 1]!.key;
        if (rows.length < batchRows) break;
      }
      rec.unmapped_columns = [...unmapped].sort();
    }

    const gaps = await countSeedGaps(plan, query);
    const notCopied: SeedRecord['losses']['not_copied'] = [];
    for (const n of plan.not_copied) {
      const rows = tables.has(n.table) ? await countRows(query, `SELECT count(*)::bigint::text AS n FROM ${quoteIdent(n.table)}`) : 0;
      notCopied.push({ table: n.table, kind: n.kind, read: n.read, rows });
    }
    const nonTerminalJobs = tables.has('minion_jobs')
      ? await countRows(query, `SELECT count(*)::bigint::text AS n FROM minion_jobs WHERE status <> ALL($1::text[])`, [TERMINAL_JOB_STATUSES])
      : 0;
    const segmentedPages = tables.has('pages')
      && (await query(`SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'pages' AND column_name = 'body_storage'`)).length
      ? await countRows(query, `SELECT count(*)::bigint::text AS n FROM pages WHERE body_storage = 'segmented'`)
      : 0;

    return {
      version: SEED_RECORD_VERSION,
      seed_id: seedId,
      started_at: started.toISOString(),
      finished_at: now().toISOString(),
      primary_engine: opts.primaryEngine,
      ...(opts.storage ? { storage: opts.storage } : {}),
      relations,
      losses: { values, not_copied: notCopied, gaps },
      unseeded_gap_rows: gaps,
      unseeded_gap_rows_total: Object.values(gaps).reduce((a, b) => a + b, 0),
      non_terminal_jobs: nonTerminalJobs,
      segmented_pages: segmentedPages,
      digests: true,
    };
  }, { readOnly: true });
}

export function seedRecordPath(dir: string): string {
  return join(dir, 'seed.json');
}

/** Writes `seed.json` atomically (temp file plus rename), mode 0600. */
export function writeSeedRecord(dir: string, record: SeedRecord): string {
  const path = seedRecordPath(dir);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, path);
  return path;
}

/** The seed record, or null when the store was never seeded (or the file is unreadable). */
export function readSeedRecord(dir: string): SeedRecord | null {
  const path = seedRecordPath(dir);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as SeedRecord;
    return parsed?.version === SEED_RECORD_VERSION && typeof parsed.seed_id === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

export type SeedSwapCheck =
  | { ok: true; seed_id: string }
  | { ok: false; code: 'not_seeded'; message: string }
  | { ok: false; code: 'unseeded_gaps'; message: string; gaps: Record<string, number> };

/**
 * The seed's part of the swap safety checks: a swap to the seeded store is refused until a seed finished, and
 * while any gap holds a row (the store would serve answers without that brain state).
 */
export function seedSwapCheck(record: SeedRecord | null): SeedSwapCheck {
  if (!record) return { ok: false, code: 'not_seeded', message: 'The Rust store was never seeded: run gbrain engine shadow seed.' };
  const gaps = Object.fromEntries(Object.entries(record.unseeded_gap_rows).filter(([, n]) => n > 0));
  if (record.unseeded_gap_rows_total > 0 || Object.keys(gaps).length) {
    const named = Object.entries(gaps).map(([g, n]) => `${g} ${n}`).join(', ');
    return { ok: false, code: 'unseeded_gaps', gaps, message: `The primary holds rows the Rust store did not copy: ${named}.` };
  }
  return { ok: true, seed_id: record.seed_id };
}
