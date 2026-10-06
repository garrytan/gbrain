/**
 * Engine graduation custody state in the database: the `persistence_graduation`
 * singleton (each engine's own row: the source records `quiesced` -> `cutover`,
 * the target records `copying` -> ... -> `authoritative`) and the
 * `gbrain_graduation_fence` statement triggers that refuse every write on the
 * target except from transactions that carry the run's identity
 * (`SET LOCAL gbrain.graduation_run = '<run_id>'`, PgBouncer transaction-mode
 * safe). The GUC and `GBRAIN_GRADUATION_RUN` are safety interlocks, not
 * security boundaries.
 */
import type { BrainEngine } from '../engine.ts';
import {
  assertTransition, SOURCE_ROW_STATES, SOURCE_TRANSITIONS, TARGET_ROW_STATES, TARGET_TRANSITIONS,
  type ReplayProbeResult, type SourceRowState, type TableReceipt, type TargetRowState, type TriggerBypass,
} from './engine-graduation.types.ts';

export const GRADUATION_FENCE_TRIGGER = 'gbrain_graduation_fence';
export const GRADUATION_RUN_SETTING = 'gbrain.graduation_run';

const ROW_STATES = [...new Set<string>([...SOURCE_ROW_STATES, ...TARGET_ROW_STATES])];

/** Shared by the schema migration on both engines. Idempotent. */
export const PERSISTENCE_GRADUATION_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS persistence_graduation (
  singleton smallint PRIMARY KEY DEFAULT 1 CHECK (singleton = 1),
  role text NOT NULL CHECK (role IN ('source','target')),
  run_id uuid NOT NULL,
  state text NOT NULL CHECK (state IN (${ROW_STATES.map(s => `'${s}'`).join(',')})),
  source_brain_id uuid,
  source_data_dir text,
  cutover_sequence bigint,
  trigger_bypass text CHECK (trigger_bypass IS NULL OR trigger_bypass IN ('session_replication_role','disable_trigger')),
  table_receipts jsonb,
  replay_probe jsonb,
  timings jsonb NOT NULL DEFAULT '{}'::jsonb,
  doctor jsonb,
  rollback jsonb,
  graduated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE OR REPLACE FUNCTION gbrain_graduation_fence() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $fence$
DECLARE fence_run text;
BEGIN
  SELECT run_id::text INTO fence_run FROM persistence_graduation WHERE singleton = 1;
  IF fence_run IS NULL OR fence_run IS DISTINCT FROM NULLIF(current_setting('${GRADUATION_RUN_SETTING}', true), '') THEN
    RAISE EXCEPTION 'graduation_in_progress: this database is fenced by gbrain engine graduation run %; writes are refused until the run grants it authority', COALESCE(fence_run, 'unknown')
      USING ERRCODE = '55000', HINT = 'Run: gbrain migrate --status --json';
  END IF;
  RETURN NULL;
END
$fence$;
`;

export interface GraduationRow {
  role: 'source' | 'target';
  run_id: string;
  state: SourceRowState | TargetRowState;
  source_brain_id: string | null;
  source_data_dir: string | null;
  cutover_sequence: string | null;
  trigger_bypass: TriggerBypass | null;
  table_receipts: readonly TableReceipt[] | null;
  replay_probe: ReplayProbeResult | null;
  timings: Record<string, number>;
  doctor: unknown;
  rollback: unknown;
  graduated_at: string | null;
}

function parseJson<T>(value: unknown): T | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') { try { return JSON.parse(value) as T; } catch { return null; } }
  return value as T;
}

export async function graduationTablePresent(engine: BrainEngine): Promise<boolean> {
  const [row] = await engine.executeRaw<{ present: boolean }>(`SELECT to_regclass('persistence_graduation') IS NOT NULL AS present`);
  return row?.present === true;
}

/** The engine's own custody row, or null on a normal brain (or before the migration). */
export async function readGraduationRow(engine: BrainEngine, opts: { forUpdate?: boolean } = {}): Promise<GraduationRow | null> {
  if (!await graduationTablePresent(engine)) return null;
  const [row] = await engine.executeRaw<Record<string, unknown>>(
    `SELECT role, run_id::text AS run_id, state, source_brain_id::text AS source_brain_id, source_data_dir,
       cutover_sequence::text AS cutover_sequence, trigger_bypass, table_receipts, replay_probe, timings, doctor, rollback,
       graduated_at::text AS graduated_at
     FROM persistence_graduation WHERE singleton = 1${opts.forUpdate ? ' FOR UPDATE' : ''}`);
  if (!row) return null;
  return {
    role: row.role as GraduationRow['role'],
    run_id: String(row.run_id),
    state: row.state as GraduationRow['state'],
    source_brain_id: (row.source_brain_id as string | null) ?? null,
    source_data_dir: (row.source_data_dir as string | null) ?? null,
    cutover_sequence: (row.cutover_sequence as string | null) ?? null,
    trigger_bypass: (row.trigger_bypass as TriggerBypass | null) ?? null,
    table_receipts: parseJson<TableReceipt[]>(row.table_receipts),
    replay_probe: parseJson<ReplayProbeResult>(row.replay_probe),
    timings: parseJson<Record<string, number>>(row.timings) ?? {},
    doctor: parseJson(row.doctor),
    rollback: parseJson(row.rollback),
    graduated_at: (row.graduated_at as string | null) ?? null,
  };
}

/** Run `fn` in one transaction that carries the run's identity, so the fence admits its writes. */
export async function withGraduationRun<T>(engine: BrainEngine, runId: string, fn: (tx: BrainEngine) => Promise<T>): Promise<T> {
  return engine.transaction(async tx => {
    await tx.executeRaw(`SELECT set_config('${GRADUATION_RUN_SETTING}', $1, true)`, [runId]);
    return fn(tx);
  });
}

export interface GraduationRowPatch {
  sourceBrainId?: string | null;
  sourceDataDir?: string | null;
  cutoverSequence?: string | null;
  triggerBypass?: TriggerBypass | null;
  tableReceipts?: readonly TableReceipt[] | null;
  replayProbe?: ReplayProbeResult | null;
  timings?: Record<string, number>;
  doctor?: unknown;
  rollback?: unknown;
  graduatedAt?: 'now' | null;
}

async function writeRow(tx: BrainEngine, role: 'source' | 'target', runId: string, state: string, patch: GraduationRowPatch, insert: boolean): Promise<void> {
  const json = (v: unknown) => (v === undefined ? undefined : v === null ? null : JSON.stringify(v));
  const fields: Array<[string, unknown, string]> = [];
  const add = (column: string, value: unknown, cast = '') => { if (value !== undefined) fields.push([column, value, cast]); };
  add('source_brain_id', patch.sourceBrainId, '::uuid');
  add('source_data_dir', patch.sourceDataDir);
  add('cutover_sequence', patch.cutoverSequence, '::bigint');
  add('trigger_bypass', patch.triggerBypass);
  add('table_receipts', json(patch.tableReceipts), '::text::jsonb');
  add('replay_probe', json(patch.replayProbe), '::text::jsonb');
  add('timings', json(patch.timings), '::text::jsonb');
  add('doctor', json(patch.doctor), '::text::jsonb');
  add('rollback', json(patch.rollback), '::text::jsonb');
  const params: unknown[] = [role, runId, state, ...fields.map(f => f[1])];
  const graduatedAt = patch.graduatedAt === 'now' ? 'now()' : patch.graduatedAt === null ? 'NULL' : undefined;
  if (insert) {
    const cols = ['role', 'run_id', 'state', ...fields.map(f => f[0]), ...(graduatedAt ? ['graduated_at'] : [])];
    const vals = ['$1', '$2::uuid', '$3', ...fields.map((f, i) => `$${i + 4}${f[2]}`), ...(graduatedAt ? [graduatedAt] : [])];
    await tx.executeRaw(`INSERT INTO persistence_graduation (singleton, ${cols.join(', ')}) VALUES (1, ${vals.join(', ')})
      ON CONFLICT (singleton) DO UPDATE SET ${cols.map(c => `${c} = EXCLUDED.${c}`).join(', ')}, created_at = now(), updated_at = now()`, params);
    return;
  }
  const sets = ['role = $1', 'run_id = $2::uuid', 'state = $3', ...fields.map((f, i) => `${f[0]} = $${i + 4}${f[2]}`),
    ...(graduatedAt ? [`graduated_at = ${graduatedAt}`] : []), 'updated_at = now()'];
  await tx.executeRaw(`UPDATE persistence_graduation SET ${sets.join(', ')} WHERE singleton = 1`, params);
}

/**
 * Move the target row to `to`, driven by TARGET_TRANSITIONS. A missing row may
 * only start as `copying`; an `abandoned` row of another run may be reused
 * (`abandoned` -> `copying`) only when `reuse` is set (`--force`). Call inside
 * `withGraduationRun` so the fence admits the write.
 */
export async function setTargetState(tx: BrainEngine, runId: string, to: TargetRowState, patch: GraduationRowPatch = {}, opts: { reuse?: boolean } = {}): Promise<void> {
  const row = await readGraduationRow(tx, { forUpdate: true });
  if (!row) {
    if (to !== 'copying') throw new Error(`Illegal graduation transition (none) -> ${to}`);
    await writeRow(tx, 'target', runId, to, patch, true);
    return;
  }
  if (row.role !== 'target') throw new Error('This database records a graduation source row; it cannot become a graduation target.');
  if (row.run_id !== runId) {
    if (!(opts.reuse && row.state === 'abandoned' && to === 'copying')) {
      throw new Error(`The target row belongs to graduation run ${row.run_id}, not ${runId}.`);
    }
    // The fence keys on the stored run id: switch the row, then this transaction's identity.
    await writeRow(tx, 'target', runId, to, { ...patch, cutoverSequence: null, tableReceipts: null, replayProbe: null, rollback: null, graduatedAt: null }, false);
    await tx.executeRaw(`SELECT set_config('${GRADUATION_RUN_SETTING}', $1, true)`, [runId]);
    return;
  }
  if (row.state !== to) assertTransition(TARGET_TRANSITIONS, row.state as TargetRowState, to);
  await writeRow(tx, 'target', runId, to, patch, false);
}

/** Move the source row to `to`, driven by SOURCE_TRANSITIONS; a fresh run starts at `quiesced`. */
export async function setSourceState(tx: BrainEngine, runId: string, to: SourceRowState, patch: GraduationRowPatch = {}): Promise<void> {
  const row = await readGraduationRow(tx, { forUpdate: true });
  if (!row) {
    if (to !== 'quiesced') throw new Error(`Illegal graduation transition (none) -> ${to}`);
    await writeRow(tx, 'source', runId, to, patch, true);
    return;
  }
  if (row.role !== 'source') throw new Error('This database records a graduation target row; it cannot become a graduation source.');
  if (row.run_id !== runId) {
    if (row.state !== 'rolled_back' || to !== 'quiesced') throw new Error(`The source row belongs to graduation run ${row.run_id}, not ${runId}.`);
    await writeRow(tx, 'source', runId, to, { cutoverSequence: null, ...patch }, true);
    return;
  }
  if (row.state !== to) assertTransition(SOURCE_TRANSITIONS, row.state as SourceRowState, to);
  await writeRow(tx, 'source', runId, to, patch, false);
}

const FENCED_TABLES_SQL = `SELECT c.oid AS relid, c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = current_schema() AND c.relkind IN ('r','p') AND NOT c.relispartition`;

/**
 * Install `gbrain_graduation_fence` (statement-level BEFORE INSERT OR UPDATE
 * OR DELETE OR TRUNCATE, `ENABLE ALWAYS` so it also fires under
 * `session_replication_role = replica`) on every table of the target schema.
 * Idempotent: repairs missing triggers and ones not set to ALWAYS.
 */
export async function installGraduationFence(target: BrainEngine, runId: string): Promise<void> {
  const row = await readGraduationRow(target);
  if (!row || row.role !== 'target' || row.run_id !== runId) {
    throw new Error(`The graduation fence needs the target row of run ${runId} first.`);
  }
  await target.executeRaw(`DO $install$ DECLARE r record; BEGIN
    FOR r IN ${FENCED_TABLES_SQL} LOOP
      IF NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = r.relid AND t.tgname = '${GRADUATION_FENCE_TRIGGER}') THEN
        EXECUTE format('CREATE TRIGGER ${GRADUATION_FENCE_TRIGGER} BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION gbrain_graduation_fence()', r.relname);
      END IF;
      EXECUTE format('ALTER TABLE %I ENABLE ALWAYS TRIGGER ${GRADUATION_FENCE_TRIGGER}', r.relname);
    END LOOP; END $install$`);
}

/** Drop every fence trigger. The authority transaction calls this in the same transaction that grants authority. */
export async function dropGraduationFence(target: BrainEngine): Promise<void> {
  await target.executeRaw(`DO $drop$ DECLARE r record; BEGIN
    FOR r IN SELECT c.relname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = current_schema() AND t.tgname = '${GRADUATION_FENCE_TRIGGER}' LOOP
      EXECUTE format('DROP TRIGGER IF EXISTS ${GRADUATION_FENCE_TRIGGER} ON %I', r.relname);
    END LOOP; END $drop$`);
}

export interface FenceStatus {
  tables: number;
  /** Tables with the fence trigger set to ALWAYS. */
  fenced: number;
  /** Tables without a fence trigger, or with one not set to ALWAYS. */
  unfenced: readonly string[];
}

export async function graduationFenceStatus(engine: BrainEngine): Promise<FenceStatus> {
  const rows = await engine.executeRaw<{ relname: string; tgenabled: string | null }>(
    `SELECT c.relname, t.tgenabled::text AS tgenabled FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     LEFT JOIN pg_trigger t ON t.tgrelid = c.oid AND t.tgname = '${GRADUATION_FENCE_TRIGGER}'
     WHERE n.nspname = current_schema() AND c.relkind IN ('r','p') AND NOT c.relispartition ORDER BY c.relname COLLATE "C"`);
  const unfenced = rows.filter(r => r.tgenabled !== 'A').map(r => r.relname);
  return { tables: rows.length, fenced: rows.length - unfenced.length, unfenced };
}
