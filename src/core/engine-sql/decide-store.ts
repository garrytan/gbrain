/**
 * The decide store (src/core/ai/decide/store.ts): `decide_state` (internal key/value state), `decide_spend` (the
 * third-party spend ledger), `decision_receipts` (one row per decision, aggregate-only reads) and `decide_calibrations`
 * (the qualification runs). SQL once for both engines, so a store that is not SQL serves the same members
 * (rust/docs/store/decide-store.md).
 *
 * Every function takes the engine (or transaction) it runs on. Rows come back typed: counts and sums as numbers,
 * timestamps as `Date`s. The 60 s daily-spend cache, the buffered writers and the salt cache stay in store.ts.
 */
import type { BrainEngine } from '../engine.ts';

type Raw = Pick<BrainEngine, 'executeRaw'>;

// ---------------------------------------------------------------- state

/** The value kept under `key`, or null when there is none. */
export async function readDecideState(tx: Raw, key: string): Promise<string | null> {
  const rows = await tx.executeRaw<{ value: string }>('SELECT value FROM decide_state WHERE key = $1', [key]);
  return rows[0]?.value ?? null;
}

/** Keep `value` under `key`, replacing an earlier value and stamping the write. */
export async function upsertDecideState(tx: Raw, key: string, value: string): Promise<void> {
  await tx.executeRaw(
    `INSERT INTO decide_state (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, value],
  );
}

/** Forget `key` (nothing happens when it is absent). */
export async function deleteDecideState(tx: Raw, key: string): Promise<void> {
  await tx.executeRaw('DELETE FROM decide_state WHERE key = $1', [key]);
}

/**
 * Keep `value` under `key` only when nothing is there yet, then answer what is stored (so concurrent callers agree on
 * one value). Null only when the stored value cannot be read back.
 */
export async function ensureDecideState(tx: Raw, key: string, value: string): Promise<string | null> {
  await tx.executeRaw('INSERT INTO decide_state (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING', [key, value]);
  return readDecideState(tx, key);
}

// ---------------------------------------------------------------- spend

/**
 * One `decide_spend` row to insert. Loose on purpose: store.ts's `SpendRow` is assignable to it, and a caller that
 * leaves a column out gets the same refusal an explicit null gets (every column but the two booleans is bound as given).
 */
export interface DecideSpendInsert {
  request_id: string;
  source_id?: string | null;
  slot: string;
  provider: string;
  model_resolved?: string | null;
  lane: string;
  remote?: boolean;
  input_tokens?: number | null;
  cost_usd?: number | null;
  outcome: string;
}

type Cell = string | number | boolean | null;
type ColumnKind = 'text' | 'int' | 'float8' | 'boolean';

const SPEND_COLUMNS: ReadonlyArray<readonly [string, ColumnKind]> = [
  ['request_id', 'text'], ['source_id', 'text'], ['slot', 'text'], ['provider', 'text'], ['model_resolved', 'text'],
  ['lane', 'text'], ['remote', 'boolean'], ['input_tokens', 'int'], ['cost_usd', 'float8'], ['outcome', 'text'],
];

/**
 * Each row as one value per column: a column the caller left out is null (a NOT NULL column then refuses the row),
 * except the booleans, which default to false. Text columns are text, numbers and booleans keep their type.
 * The SQL insert and the Rust store both start from this, so the two engines read a row the same way.
 */
function columnValues(columns: ReadonlyArray<readonly [string, ColumnKind]>, rows: readonly object[]): Array<Record<string, Cell>> {
  return rows.map((row) => {
    const out: Record<string, Cell> = {};
    for (const [name, kind] of columns) {
      const v = (row as Record<string, unknown>)[name];
      if (v === undefined) out[name] = kind === 'boolean' ? false : null;
      else if (v === null) out[name] = null;
      else out[name] = kind === 'text' ? String(v) : (v as Cell);
    }
    return out;
  });
}

export function spendRowValues(rows: readonly DecideSpendInsert[]): Array<Record<string, Cell>> {
  return columnValues(SPEND_COLUMNS, rows);
}

/** The statements are spelled out: engine-sql splices only constant text. Each column binds as one array parameter. */
const INSERT_SPEND_SQL = `INSERT INTO decide_spend (request_id, source_id, slot, provider, model_resolved, lane, remote, input_tokens, cost_usd, outcome)
  SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[]::boolean[],
                       $8::text[]::int[], $9::text[]::float8[], $10::text[])
  ON CONFLICT (request_id) DO NOTHING`;

/**
 * Multi-row insert via unnest of one array per column (fixed parameter count). Every column binds as text[] and casts
 * server-side: postgres.js cannot serialize boolean/number arrays for a typed array cast, PGLite can; text arrays behave
 * the same on both engines.
 */
async function unnestInsert(tx: Raw, sql: string, columns: ReadonlyArray<readonly [string, ColumnKind]>, values: Array<Record<string, Cell>>): Promise<void> {
  if (values.length === 0) return;
  await tx.executeRaw(sql, columns.map(([name]) => values.map((r) => (r[name] === null ? null : String(r[name])))));
}

/** Record spend rows. A request id that is already recorded keeps its first row. All rows go in, or none do. */
export async function insertDecideSpend(tx: Raw, rows: readonly DecideSpendInsert[]): Promise<void> {
  await unnestInsert(tx, INSERT_SPEND_SQL, SPEND_COLUMNS, spendRowValues(rows));
}

/** Third-party spend recorded at or after `since`: everything, and the part that went to a remote caller. */
export async function dailyDecideSpend(tx: Raw, since: Date): Promise<{ total: number; remote: number }> {
  const rows = await tx.executeRaw<{ total: number | string | null; remote: number | string | null }>(
    `SELECT COALESCE(SUM(cost_usd), 0) AS total, COALESCE(SUM(CASE WHEN remote THEN cost_usd ELSE 0 END), 0) AS remote
       FROM decide_spend WHERE created_at >= $1::timestamptz AND provider LIKE 'typesafe:%'`,
    [since.toISOString()],
  );
  return { total: Number(rows[0]?.total ?? 0), remote: Number(rows[0]?.remote ?? 0) };
}

export interface DecideSpendSlotTotals { slot: string; input_tokens: number; cost_usd: number; requests: number }

/** Spend totals per slot over the whole ledger, in slot order (byte order, so every engine lists them alike). */
export async function listDecideSpendBySlot(tx: Raw): Promise<DecideSpendSlotTotals[]> {
  const rows = await tx.executeRaw<{ slot: string; tokens: number | string; cost: number | string; n: number | string }>(
    `SELECT slot, COALESCE(SUM(input_tokens), 0) AS tokens, COALESCE(SUM(cost_usd), 0) AS cost, COUNT(*) AS n
       FROM decide_spend GROUP BY slot ORDER BY slot COLLATE "C"`,
  );
  return rows.map((r) => ({ slot: String(r.slot), input_tokens: Number(r.tokens), cost_usd: Number(r.cost), requests: Number(r.n) }));
}
