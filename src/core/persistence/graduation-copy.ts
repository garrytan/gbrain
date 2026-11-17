/**
 * Engine graduation copier (Route B, in process): copies each carried table
 * from the PGLite source into the fenced Postgres target verbatim, primary
 * keys and every column preserved.
 *
 * - Per-column contract: source and target columns must match by name, type
 *   and typmod (`format_type`) and generation expression, outside the
 *   inventory entry's `columnAllowlist`; generated columns are never inserted.
 * - Source rows are read with the digest's own plan (`digestPlan` with
 *   transforms applied, every value as `::text`, the entry's `rowFilter`,
 *   keyset order by primary key with COLLATE "C" under the digest session
 *   settings), so what is copied is exactly what verify digests.
 * - Each table copies in one target transaction that carries the run's fence
 *   identity (`gbrain.graduation_run`), bypasses user triggers
 *   (`session_replication_role = replica`, or DISABLE/ENABLE TRIGGER by name
 *   inside the same transaction, never the fence), deletes the target's rows
 *   for that table (initSchema seed rows included) and inserts the source rows.
 * - Values travel as text in one jsonb array per batch (bound `$1::text::jsonb`,
 *   far below the 65,535 bind-parameter limit) and are cast back with each
 *   column's own `format_type`; batches are sized by bytes.
 * - Self-referencing FKs copy in one pass under replica mode (no FK triggers)
 *   and in two passes (insert with NULL, then update) under DISABLE TRIGGER,
 *   where FK checks stay active.
 * - Sequences are set to the source's exact position, raised to the target
 *   column maximum when that is higher.
 * - HNSW and GIN indexes are dropped before the copy and rebuilt after it; the
 *   pending list lives in a target-owned config row so a crash resumes it.
 */
import type { BrainEngine } from '../engine.ts';
import { ANN_BUILD_MESSAGE, buildDeferredAnnIndexes, type DeferredAnnIndex } from '../embedding-ann-build.ts';
import type { ColumnMeta, GraduationEngines, Inventory, InventoryEntry, TriggerBypass } from './engine-graduation.types.ts';
import { digestPlan, quoteIdent, tableColumns, withDigestSession, type DigestPlan } from './graduation-digest.ts';
import { fkClosure, GRADUATION_INVENTORY } from './graduation-inventory.ts';
import { targetUnsupportedError } from './graduation-errors.ts';

/** Target-owned config row holding the deferred index list; the config copy never deletes it. */
export const GRADUATION_DEFERRED_INDEXES_KEY = 'graduation.deferred_indexes';
/** Default copy batch size in bytes of canonical text. */
export const DEFAULT_COPY_BATCH_BYTES = 4 * 1024 * 1024;
const MAX_BATCH_ROWS = 5000;
const FENCE_TRIGGER_PREFIX = 'gbrain_graduation_fence';

type Sql = Pick<BrainEngine, 'executeRaw'>;

/** Generation expressions of a table's generated columns, keyed by column name. */
export async function generationExpressions(engine: Sql, relation: string): Promise<Map<string, string>> {
  const rows = await engine.executeRaw<{ name: string; expr: string }>(`SELECT a.attname AS name, pg_get_expr(d.adbin, d.adrelid) AS expr
    FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE n.nspname = current_schema() AND c.relname = $1 AND a.attnum > 0 AND NOT a.attisdropped AND a.attgenerated::text = 's'`, [relation]);
  return new Map(rows.map(r => [r.name, r.expr.replace(/\s+/g, ' ').trim()]));
}

/**
 * The per-column contract: every non-allowlisted column must exist on both
 * sides with the same type and typmod, and generated columns must carry the
 * same expression. Returns the names of the columns the copy inserts.
 */
export function columnContract(entry: Pick<InventoryEntry, 'relation' | 'columnAllowlist'>,
  source: { columns: readonly ColumnMeta[]; generated: ReadonlyMap<string, string> },
  target: { columns: readonly ColumnMeta[]; generated: ReadonlyMap<string, string> }): string[] {
  const allow = entry.columnAllowlist ?? {};
  const targetByName = new Map(target.columns.map(c => [c.name, c]));
  const sourceNames = new Set(source.columns.map(c => c.name));
  const problems: string[] = [];
  const copied: string[] = [];
  for (const column of source.columns) {
    const other = targetByName.get(column.name);
    if (column.name in allow) { if (other && !other.generated && !column.generated && other.type === column.type) copied.push(column.name); continue; }
    if (!other) { problems.push(`${column.name} (${column.type}) is missing on the target`); continue; }
    if (other.type !== column.type) { problems.push(`${column.name} is ${column.type} on the source but ${other.type} on the target`); continue; }
    const sourceExpr = source.generated.get(column.name) ?? null;
    const targetExpr = target.generated.get(column.name) ?? null;
    if (other.generated !== column.generated || sourceExpr !== targetExpr) {
      problems.push(`${column.name} generation differs (source ${sourceExpr ?? 'not generated'}, target ${targetExpr ?? 'not generated'})`);
      continue;
    }
    if (!column.generated) copied.push(column.name);
  }
  for (const column of target.columns) {
    if (!sourceNames.has(column.name) && !(column.name in allow)) problems.push(`${column.name} (${column.type}) exists only on the target`);
  }
  if (problems.length) {
    const error = targetUnsupportedError({ requirement: 'column', detail: `the ${entry.relation} columns do not match the source (${problems.join('; ')})`, host: 'the target' });
    error.detail = problems.join('; ');
    throw error;
  }
  return copied;
}

export async function detectTriggerBypass(target: BrainEngine): Promise<TriggerBypass | null> {
  const rollback = Symbol('rollback');
  try {
    await target.transaction(async tx => { await tx.executeRaw('SET LOCAL session_replication_role = replica'); throw rollback; });
  } catch (error) {
    if (error === rollback) return 'session_replication_role';
  }
  const [row] = await target.executeRaw<{ owns: boolean }>(`SELECT COALESCE(bool_and(pg_has_role(current_user, c.relowner, 'USAGE')), true) AS owns
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')`);
  return row?.owns ? 'disable_trigger' : null;
}

async function setFence(tx: Sql, runId: string): Promise<void> {
  await tx.executeRaw("SELECT set_config('gbrain.graduation_run', $1::text, true)", [runId]);
}

/** The run id the target fence admits: explicit, else the target's `persistence_graduation` row. */
async function fenceRunId(target: Sql, explicit?: string): Promise<string | null> {
  if (explicit) return explicit;
  const [table] = await target.executeRaw<{ present: boolean }>("SELECT to_regclass('public.persistence_graduation') IS NOT NULL AS present");
  if (!table?.present) return null;
  const [row] = await target.executeRaw<{ run_id: string }>('SELECT run_id::text AS run_id FROM persistence_graduation LIMIT 1');
  return row?.run_id ?? null;
}

type TriggerState = { ident: string; enabled: string };

async function userTriggers(tx: Sql, relation: string, enabledOnly: boolean): Promise<TriggerState[]> {
  return tx.executeRaw<TriggerState>(`SELECT format('%I', tgname) AS ident, tgenabled::text AS enabled FROM pg_trigger
    WHERE tgrelid = to_regclass(format('public.%I', $1::text)) AND NOT tgisinternal AND tgname NOT LIKE '${FENCE_TRIGGER_PREFIX}%'
      ${enabledOnly ? "AND tgenabled <> 'D'" : "AND tgenabled = 'D'"} ORDER BY tgname`, [relation]);
}

const ENABLE_BY_MODE: Readonly<Record<string, string>> = { O: 'ENABLE TRIGGER', A: 'ENABLE ALWAYS TRIGGER', R: 'ENABLE REPLICA TRIGGER' };

/** Keyset-paged source rows from the digest plan: raw primary-key texts and transformed column texts. */
async function readSourceBatch(source: BrainEngine, plan: DigestPlan, extraWhere: string | null, afterKey: readonly string[] | null, limit: number):
  Promise<Array<{ key: string[]; values: Array<string | null> }>> {
  const collate = (c: ColumnMeta, expr: string) => c.collatable ? `${expr} COLLATE "C"` : expr;
  const order = plan.key.map(k => collate(k, `t.${quoteIdent(k.name)}`)).join(', ');
  const where = [
    plan.filter ? `(${plan.filter})` : '',
    extraWhere ? `(${extraWhere})` : '',
    afterKey ? `(${order}) > (${plan.key.map((k, i) => collate(k, `$${i + 1}::text::${k.type}`)).join(', ')})` : '',
  ].filter(Boolean);
  const rows = await withDigestSession(source, tx => tx.executeRaw<Record<string, string | null>>(
    `${plan.select}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY ${order} LIMIT ${limit}`, afterKey ? [...afterKey] : []));
  return rows.map(r => ({ key: plan.key.map((_, i) => r[`k${i}`] as string), values: plan.columns.map((_, i) => r[`c${i}`] ?? null) }));
}

/**
 * Copies one carried (or rebind) table into the fenced target in a single
 * transaction and returns the number of source rows copied. Catalog reads
 * happen before any transaction opens (PGLite serializes its one connection).
 */
export async function copyTable(e: GraduationEngines, entry: InventoryEntry,
  opts: { bypass: TriggerBypass; batchBytes?: number; onBatch?: (rows: number) => void | Promise<void>; runId: string }): Promise<{ rows: number }> {
  if (entry.class !== 'carry' && entry.class !== 'rebind') throw new Error(`copyTable: ${entry.relation} is ${entry.class}, not carried`);
  const relation = entry.relation;
  const plan = await digestPlan(e.source, entry, true);
  const [targetColumns, sourceGenerated, targetGenerated] = await Promise.all([
    tableColumns(e.target, relation), generationExpressions(e.source, relation), generationExpressions(e.target, relation)]);
  if (!targetColumns.length) throw new Error(`copyTable: ${relation} does not exist on the target`);
  const copied = new Set(columnContract(entry, { columns: plan.columns, generated: sourceGenerated }, { columns: targetColumns, generated: targetGenerated }));
  const selfFk = opts.bypass === 'disable_trigger'
    ? (await e.target.executeRaw<{ name: string }>(`SELECT DISTINCT a.attname AS name FROM pg_constraint k CROSS JOIN LATERAL unnest(k.conkey) AS u(attnum)
        JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = u.attnum JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE k.contype = 'f' AND k.conrelid = k.confrelid AND n.nspname = current_schema() AND c.relname = $1`, [relation])).map(r => r.name).filter(name => copied.has(name))
    : [];
  const table = quoteIdent(relation);
  const inserted = plan.columns.map((c, i) => ({ c, i })).filter(({ c }) => copied.has(c.name));
  const insertSql = `INSERT INTO ${table} (${inserted.map(({ c }) => quoteIdent(c.name)).join(', ')}) SELECT ${inserted
    .map(({ c, i }) => selfFk.includes(c.name) ? 'NULL' : `(r.v->>${i})::${c.type}`).join(', ')} FROM jsonb_array_elements($1::text::jsonb) AS r(v)`;
  const batchBytes = opts.batchBytes ?? DEFAULT_COPY_BATCH_BYTES;
  const deleteFilter = [entry.rowFilter ? `(${entry.rowFilter})` : '', relation === 'config' ? `key <> '${GRADUATION_DEFERRED_INDEXES_KEY}'` : ''].filter(Boolean);
  const disabled = opts.bypass === 'disable_trigger' ? await userTriggers(e.target, relation, true) : [];

  const scan = async (extraWhere: string | null, visit: (rows: Array<Array<string | null>>) => Promise<void>) => {
    let limit = 100;
    let after: string[] | null = null;
    for (;;) {
      const rows = await readSourceBatch(e.source, plan, extraWhere, after, limit);
      if (!rows.length) return;
      const values = rows.map(r => r.values);
      await visit(values);
      if (rows.length < limit) return;
      after = rows[rows.length - 1]!.key;
      const bytes = values.reduce((sum, row) => sum + row.reduce((n, v) => n + (v?.length ?? 4) + 3, 2), 0);
      limit = Math.max(1, Math.min(MAX_BATCH_ROWS, Math.floor(batchBytes * rows.length / Math.max(1, bytes))));
    }
  };

  return e.target.transaction(async tx => {
    await setFence(tx, opts.runId);
    if (opts.bypass === 'session_replication_role') await tx.executeRaw('SET LOCAL session_replication_role = replica');
    for (const trigger of disabled) await tx.executeRaw(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger.ident}`);
    await tx.executeRaw(`DELETE FROM ${table}${deleteFilter.length ? ` WHERE ${deleteFilter.join(' AND ')}` : ''}`);
    let rows = 0;
    await scan(null, async batch => {
      await tx.executeRaw(insertSql, [JSON.stringify(batch)]);
      rows += batch.length;
      await opts.onBatch?.(batch.length);
    });
    if (selfFk.length) {
      const fk = selfFk.map(name => ({ c: plan.columns.find(c => c.name === name)!, i: plan.columns.findIndex(c => c.name === name) }));
      const keyIndex = plan.key.map(k => plan.columns.findIndex(c => c.name === k.name));
      const updateSql = `UPDATE ${table} AS t SET ${fk.map(({ c }, j) => `${quoteIdent(c.name)} = (r.v->>${plan.key.length + j})::${c.type}`).join(', ')}
        FROM jsonb_array_elements($1::text::jsonb) AS r(v) WHERE ${plan.key.map((k, j) => `t.${quoteIdent(k.name)} = (r.v->>${j})::${k.type}`).join(' AND ')}`;
      await scan(fk.map(({ c }) => `${quoteIdent(c.name)} IS NOT NULL`).join(' OR '), async batch => {
        const payload = batch.map(row => [...keyIndex.map(i => row[i] ?? null), ...fk.map(({ i }) => row[i] ?? null)]);
        await tx.executeRaw(updateSql, [JSON.stringify(payload)]);
      });
    }
    for (const trigger of disabled) await tx.executeRaw(`ALTER TABLE ${table} ${ENABLE_BY_MODE[trigger.enabled] ?? 'ENABLE TRIGGER'} ${trigger.ident}`);
    return { rows };
  });
}

/**
 * Re-copies a table together with every table that references it
 * transitively (its FK closure): all closure tables are emptied children
 * first in one fenced transaction (a parent delete would otherwise cascade
 * into, or be refused by, children still holding rows under DISABLE TRIGGER),
 * then each carried closure table is copied parents first.
 */
export async function recopyClosure(e: GraduationEngines, relation: string,
  opts: { bypass: TriggerBypass; runId: string; batchBytes?: number; inventory?: Inventory; onBatch?: (relation: string, rows: number) => void }): Promise<Record<string, number>> {
  const inventory = opts.inventory ?? GRADUATION_INVENTORY;
  const byName = new Map(inventory.entries.filter(x => x.class === 'carry' || x.class === 'rebind').map(x => [x.relation, x]));
  const closure = (await fkClosure(e.target, relation)).filter(name => byName.has(name));
  const disabled = new Map<string, Awaited<ReturnType<typeof userTriggers>>>();
  if (opts.bypass === 'disable_trigger') for (const name of closure) disabled.set(name, await userTriggers(e.target, name, true));
  await e.target.transaction(async tx => {
    await setFence(tx, opts.runId);
    if (opts.bypass === 'session_replication_role') await tx.executeRaw('SET LOCAL session_replication_role = replica');
    for (const name of [...closure].reverse()) {
      const table = quoteIdent(name);
      const filter = [byName.get(name)!.rowFilter ? `(${byName.get(name)!.rowFilter})` : '', name === 'config' ? `key <> '${GRADUATION_DEFERRED_INDEXES_KEY}'` : ''].filter(Boolean);
      for (const trigger of disabled.get(name) ?? []) await tx.executeRaw(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger.ident}`);
      await tx.executeRaw(`DELETE FROM ${table}${filter.length ? ` WHERE ${filter.join(' AND ')}` : ''}`);
      for (const trigger of disabled.get(name) ?? []) await tx.executeRaw(`ALTER TABLE ${table} ${ENABLE_BY_MODE[trigger.enabled] ?? 'ENABLE TRIGGER'} ${trigger.ident}`);
    }
  });
  const counts: Record<string, number> = {};
  for (const name of closure) {
    counts[name] = (await copyTable(e, byName.get(name)!, { bypass: opts.bypass, runId: opts.runId, batchBytes: opts.batchBytes,
      onBatch: rows => opts.onBatch?.(name, rows) })).rows;
  }
  return counts;
}

export interface SequencePosition { sequence: string; value: string; isCalled: boolean; raisedToColumnMax: boolean }

/**
 * Sets every source sequence present on the target to the source's exact
 * position (`last_value`, `is_called`), raised to the maximum of every target
 * column it feeds when that is higher, so a value consumed by an aborted source
 * transaction is never reissued. Sequences absent on the target are skipped.
 */
export async function copySequences(e: GraduationEngines, opts: { runId?: string } = {}): Promise<readonly SequencePosition[]> {
  const sequences = await e.source.executeRaw<{ name: string; ident: string }>(`SELECT c.relname AS name, format('%I', c.relname) AS ident
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'S' ORDER BY c.relname`);
  const runId = await fenceRunId(e.target, opts.runId);
  const positions: SequencePosition[] = [];
  await e.target.transaction(async tx => {
    if (runId) await setFence(tx, runId);
    for (const seq of sequences) {
      const [present] = await tx.executeRaw<{ present: boolean }>("SELECT to_regclass(format('public.%I', $1::text)) IS NOT NULL AS present", [seq.name]);
      if (!present?.present) continue;
      const [position] = await e.source.executeRaw<{ last_value: string; is_called: boolean }>(`SELECT last_value::text AS last_value, is_called FROM ${seq.ident}`);
      const feeds = await tx.executeRaw<{ table_ident: string; column_ident: string }>(`SELECT DISTINCT format('%I', t.relname) AS table_ident, format('%I', a.attname) AS column_ident
        FROM pg_depend d JOIN pg_class t ON t.oid = d.refobjid JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
        WHERE d.classid = 'pg_class'::regclass AND d.objid = to_regclass(format('public.%I', $1::text)) AND d.refclassid = 'pg_class'::regclass AND d.deptype IN ('a', 'i')
        UNION
        SELECT DISTINCT format('%I', t.relname), format('%I', a.attname)
        FROM pg_depend d JOIN pg_attrdef ad ON ad.oid = d.objid JOIN pg_class t ON t.oid = ad.adrelid JOIN pg_attribute a ON a.attrelid = ad.adrelid AND a.attnum = ad.adnum
        WHERE d.classid = 'pg_attrdef'::regclass AND d.refobjid = to_regclass(format('public.%I', $1::text))`, [seq.name]);
      let value = BigInt(position!.last_value);
      let isCalled = position!.is_called === true;
      let raised = false;
      for (const feed of feeds) {
        const [max] = await tx.executeRaw<{ max: string | null }>(`SELECT max(${feed.column_ident})::text AS max FROM ${feed.table_ident}`);
        if (max?.max && /^-?\d+$/.test(max.max) && BigInt(max.max) > value - (isCalled ? 0n : 1n)) {
          value = BigInt(max.max); isCalled = true; raised = true;
        }
      }
      await tx.executeRaw(`SELECT setval(to_regclass(format('public.%I', $1::text)), $2::bigint, $3::boolean)`, [seq.name, value.toString(), isCalled]);
      positions.push({ sequence: seq.name, value: value.toString(), isCalled, raisedToColumnMax: raised });
    }
  });
  return positions;
}

export interface DeferredIndex { name: string; relation: string; method: 'hnsw' | 'gin'; def: string }

async function readDeferred(engine: Sql): Promise<DeferredIndex[]> {
  const [row] = await engine.executeRaw<{ value: string }>('SELECT value FROM config WHERE key = $1', [GRADUATION_DEFERRED_INDEXES_KEY]);
  if (!row?.value) return [];
  const parsed = JSON.parse(row.value) as unknown;
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((d): d is DeferredIndex => !!d && typeof d.name === 'string' && typeof d.def === 'string' && typeof d.relation === 'string'
    && (d.method === 'hnsw' || d.method === 'gin') && /^CREATE INDEX [a-z_][a-z0-9_]* ON public\.[a-z_][a-z0-9_]* USING (hnsw|gin) \(/.test(d.def) && !d.def.includes(';'));
}

async function writeDeferred(engine: BrainEngine, pending: readonly DeferredIndex[], runId: string | null): Promise<void> {
  await engine.transaction(async tx => {
    if (runId) await setFence(tx, runId);
    if (pending.length) {
      await tx.executeRaw(`INSERT INTO config (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [GRADUATION_DEFERRED_INDEXES_KEY, JSON.stringify(pending)]);
    } else {
      await tx.executeRaw('DELETE FROM config WHERE key = $1', [GRADUATION_DEFERRED_INDEXES_KEY]);
    }
  });
}

/**
 * Drops every non-unique HNSW and GIN index on the target's public tables and
 * records their definitions in the target-owned `graduation.deferred_indexes`
 * config row, in one transaction. Re-running merges with an existing list.
 */
export async function deferIndexes(target: BrainEngine, opts: { runId?: string } = {}): Promise<readonly DeferredIndex[]> {
  const runId = await fenceRunId(target, opts.runId);
  return target.transaction(async tx => {
    if (runId) await setFence(tx, runId);
    const found = await tx.executeRaw<{ name: string; ident: string; relation: string; method: 'hnsw' | 'gin'; def: string }>(`SELECT i.relname AS name,
        format('%I', i.relname) AS ident, t.relname AS relation, am.amname AS method, pg_get_indexdef(i.oid) AS def
      FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid JOIN pg_class t ON t.oid = x.indrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace JOIN pg_am am ON am.oid = i.relam
      WHERE n.nspname = 'public' AND am.amname IN ('hnsw', 'gin') AND NOT x.indisunique
        AND NOT EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conindid = i.oid) ORDER BY t.relname, i.relname`);
    const byName = new Map((await readDeferred(tx)).map(d => [d.name, d]));
    for (const index of found) byName.set(index.name, { name: index.name, relation: index.relation, method: index.method, def: index.def });
    const pending = [...byName.values()];
    if (pending.length) {
      await tx.executeRaw(`INSERT INTO config (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [GRADUATION_DEFERRED_INDEXES_KEY, JSON.stringify(pending)]);
    }
    for (const index of found) await tx.executeRaw(`DROP INDEX ${index.ident}`);
    return pending;
  });
}

/**
 * Builds the deferred indexes one at a time, removing each from the pending
 * row once valid, so a killed run resumes where it stopped. HNSW indexes go
 * through the deferred-ANN build of `foresights migrate embeddings` (invalid
 * remnant cleanup, CONCURRENTLY on Postgres, per-type dimension caps); GIN
 * indexes build plainly without a statement timeout.
 */
export async function buildDeferredIndexes(target: BrainEngine, opts: { runId?: string; log?: (line: string) => void } = {}): Promise<{ built: readonly string[] }> {
  const runId = await fenceRunId(target, opts.runId);
  const built: string[] = [];
  for (const index of await readDeferred(target)) {
    if (index.method === 'hnsw') {
      const column = /USING hnsw \(([a-z_][a-z0-9_]*) /.exec(index.def)?.[1];
      const [dims] = await target.executeRaw<{ dims: number }>(`SELECT a.atttypmod AS dims FROM pg_attribute a
        WHERE a.attrelid = to_regclass(format('public.%I', $1::text)) AND a.attname = $2`, [index.relation, column ?? '']);
      const targetDims = Number(dims?.dims ?? 0);
      if (!(targetDims > 0)) throw new Error(`deferred index ${index.name}: ${index.relation}.${column} has no vector dimension on the target`);
      const ann: DeferredAnnIndex = { name: index.name, def: index.def };
      const result = await buildDeferredAnnIndexes(target, {
        targetDims, readPending: async () => [ann], writePending: async () => {},
        log: opts.log ?? (line => process.stderr.write(`${line.replace(`[migrate] ${ANN_BUILD_MESSAGE}`, '[graduation] building deferred vector index')}\n`)),
      });
      if (result.skipped_over_cap.length) throw new Error(`deferred index ${index.name} exceeds the HNSW dimension cap on the target`);
    } else {
      await target.transaction(async tx => {
        await tx.executeRaw('SET LOCAL statement_timeout = 0');
        await tx.executeRaw(index.def.replace(/^CREATE INDEX /, 'CREATE INDEX IF NOT EXISTS '));
      });
    }
    built.push(index.name);
    await writeDeferred(target, (await readDeferred(target)).filter(d => d.name !== index.name), runId);
  }
  return { built };
}

/**
 * Re-enables user triggers left disabled on the given relations (never the
 * graduation fence). The copier disables and re-enables inside each table's
 * transaction, so this only repairs a target someone else left disabled.
 */
export async function reenableTriggers(target: BrainEngine, relations: readonly string[], opts: { runId?: string } = {}): Promise<readonly string[]> {
  const runId = await fenceRunId(target, opts.runId);
  const enabled: string[] = [];
  await target.transaction(async tx => {
    if (runId) await setFence(tx, runId);
    for (const relation of relations) {
      const [present] = await tx.executeRaw<{ present: boolean }>("SELECT to_regclass(format('public.%I', $1::text)) IS NOT NULL AS present", [relation]);
      if (!present?.present) continue;
      const ident = quoteIdent(relation);
      for (const trigger of await userTriggers(tx, relation, false)) {
        await tx.executeRaw(`ALTER TABLE ${ident} ENABLE TRIGGER ${trigger.ident}`);
        enabled.push(`${relation}.${trigger.ident}`);
      }
    }
  });
  return enabled;
}
