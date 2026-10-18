/**
 * Graduation verify: the gate for cutover. With both engines open and the
 * target still fenced it compares relation sets, column contracts, row counts
 * and canonical digests (source side transformed by the inventory's permitted
 * transforms), sequence positions, every FK, trigger state, the target doctor
 * and a replay probe that resubmits a carried request through admission
 * inside a rolled-back transaction.
 */
import type { BrainEngine } from '../engine.ts';
import { OperationError } from '../ops/contract.ts';
import { admitWriteInTransaction, type WriteAdmission } from './journal.ts';
import type { Principal, WriteAuthority } from './model.ts';
import { readManagedMode } from './managed-mode.ts';
import type {
  GraduationEngines, Inventory, InventoryEntry, ReplayProbeResult, TableReceipt, VerifyFailure, VerifyResult,
} from './engine-graduation.types.ts';
import { assertRelationSet, copyOrder, foreignKeys } from './graduation-inventory.ts';
import {
  DEFAULT_DIGEST_BATCH_ROWS, digestPlan, digestTable, quoteIdent, readDigestRows, tableColumns, withDigestSession,
} from './graduation-digest.ts';

export const GRADUATION_FENCE_TRIGGER = 'gbrain_graduation_fence';
/** Derived side tables the copy must reproduce exactly (they are carried, so the digest covers them). */
export const DERIVED_SIDE_TABLES = ['page_projection_jobs', 'page_generation_clock'] as const;

export interface VerifyContext {
  inventory: Inventory;
  /** Copy-time source snapshot: digestTable(source, entry, { applyTransforms: true }) per carried relation. */
  sourceReceipts: readonly TableReceipt[];
  replayRequestId?: string;
  /** The original caller input of the replay request (persistence_requests stores only the normalized intent). */
  replayCallerIntent?: Record<string, unknown>;
  /** The graduation run id; the replay probe sets gbrain.graduation_run to it so the target fence admits its rolled-back writes. */
  runId?: string;
  /** Verify runs before cutover, so the gbrain_graduation_fence triggers must be present and ENABLE ALWAYS (default true). */
  expectFence?: boolean;
  batchRows?: number;
  runDoctor: () => Promise<readonly string[]>;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function firstDifference(e: GraduationEngines, entry: InventoryEntry, source: TableReceipt, target: TableReceipt, batchRows: number)
  : Promise<{ firstKey?: string; column?: string }> {
  let index = source.batches.findIndex((b, i) => b.sha256 !== target.batches[i]?.sha256 || b.lastKey !== target.batches[i]?.lastKey);
  if (index < 0) index = source.batches.length;
  const after = index > 0 ? JSON.parse(source.batches[index - 1]!.lastKey) as string[] : null;
  const limit = Math.max(batchRows, source.batches[index]?.rows ?? 0, target.batches[index]?.rows ?? 0);
  const [srcPlan, dstPlan] = await Promise.all([digestPlan(e.source, entry, true), digestPlan(e.target, entry, false)]);
  const [srcRows, dstRows] = await Promise.all([
    withDigestSession(e.source, tx => readDigestRows(tx, srcPlan, after, limit)),
    withDigestSession(e.target, tx => readDigestRows(tx, dstPlan, after, limit)),
  ]);
  for (let i = 0; i < Math.max(srcRows.length, dstRows.length); i++) {
    const s = srcRows[i], d = dstRows[i];
    if (s && d && s.text === d.text && JSON.stringify(s.key) === JSON.stringify(d.key)) continue;
    if (!s || !d || JSON.stringify(s.key) !== JSON.stringify(d.key)) return { firstKey: JSON.stringify((s ?? d)!.key) };
    const sv = JSON.parse(s.text) as unknown[], dv = JSON.parse(d.text) as unknown[];
    const col = srcPlan.columns.findIndex((_, j) => sv[j] !== dv[j]);
    return { firstKey: JSON.stringify(s.key), ...(col >= 0 ? { column: srcPlan.columns[col]!.name } : {}) };
  }
  return {};
}

async function verifyTable(e: GraduationEngines, entry: InventoryEntry, recorded: TableReceipt | undefined, batchRows: number,
  failures: VerifyFailure[]): Promise<TableReceipt | null> {
  const relation = entry.relation;
  const [srcCols, dstCols] = await Promise.all([tableColumns(e.source, relation), tableColumns(e.target, relation)]);
  const dstByName = new Map(dstCols.map(c => [c.name, c]));
  const contract = [
    ...srcCols.filter(c => !dstByName.has(c.name)).map(c => ({ column: c.name, detail: `missing on the target (${c.type})` })),
    ...dstCols.filter(c => !srcCols.some(s => s.name === c.name)).map(c => ({ column: c.name, detail: `exists only on the target (${c.type})` })),
    ...srcCols.filter(c => dstByName.has(c.name) && (dstByName.get(c.name)!.type !== c.type || dstByName.get(c.name)!.generated !== c.generated))
      .map(c => ({ column: c.name, detail: `source ${c.type}${c.generated ? ' generated' : ''}, target ${dstByName.get(c.name)!.type}${dstByName.get(c.name)!.generated ? ' generated' : ''}` })),
  ];
  if (contract.length) {
    for (const c of contract) failures.push({ relation, kind: 'digest', column: c.column, detail: `Column contract: ${c.column} ${c.detail}.` });
    return null;
  }
  const [source, target] = await Promise.all([
    digestTable(e.source, entry, { batchRows, applyTransforms: true }),
    digestTable(e.target, entry, { batchRows }),
  ]);
  if (!recorded) failures.push({ relation, kind: 'digest', detail: 'No copy-time source receipt was recorded for this table.' });
  else if (recorded.rootSha256 !== source.rootSha256 || recorded.rows !== source.rows) {
    failures.push({ relation, kind: 'digest', detail: `The source changed since the copy (rows ${recorded.rows} -> ${source.rows}); re-copy this table and its FK closure.` });
  }
  if (source.rows !== target.rows) failures.push({ relation, kind: 'count', detail: `Source has ${source.rows} rows, target has ${target.rows}.` });
  const countSql = `SELECT count(*)::text AS n FROM ${quoteIdent(relation)}${entry.rowFilter ? ` WHERE (${entry.rowFilter})` : ''}`;
  const [[srcCount], [dstCount]] = await Promise.all([
    e.source.executeRaw<{ n: string }>(countSql), e.target.executeRaw<{ n: string }>(countSql)]);
  for (const [side, counted, digested] of [['source', Number(srcCount?.n), source.rows], ['target', Number(dstCount?.n), target.rows]] as const) {
    if (counted !== digested) failures.push({ relation, kind: 'count', detail: `The ${side} has ${counted} rows by count(*) but the keyset digest read ${digested}; batching skipped rows.` });
  }
  if (source.rootSha256 !== target.rootSha256) {
    const diff = await firstDifference(e, entry, source, target, batchRows);
    failures.push({ relation, kind: 'digest', ...diff, detail: `Canonical content differs${diff.firstKey ? ` first at key ${diff.firstKey}` : ''}${diff.column ? ` in column ${diff.column}` : ''}.` });
  }
  return target;
}

interface SequenceRow { seq: string; tbl: string | null; col: string | null }

async function sequences(engine: BrainEngine): Promise<Map<string, SequenceRow>> {
  const rows = await engine.executeRaw<SequenceRow>(`SELECT s.relname AS seq, t.relname AS tbl, a.attname AS col
    FROM pg_class s JOIN pg_namespace n ON n.oid=s.relnamespace
    LEFT JOIN pg_depend d ON d.objid=s.oid AND d.classid='pg_class'::regclass AND d.refclassid='pg_class'::regclass AND d.deptype IN ('a','i')
    LEFT JOIN pg_class t ON t.oid=d.refobjid
    LEFT JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=d.refobjsubid
    WHERE s.relkind='S' AND n.nspname=current_schema() ORDER BY s.relname COLLATE "C"`);
  return new Map(rows.map(r => [r.seq, r]));
}

/** The highest value the sequence has handed out (or would hand out first, minus one). */
async function sequencePosition(engine: BrainEngine, seq: string): Promise<bigint> {
  const [row] = await engine.executeRaw<{ last_value: string; is_called: unknown }>(`SELECT last_value::text AS last_value, is_called FROM ${quoteIdent(seq)}`);
  const called = row!.is_called === true || row!.is_called === 't';
  return BigInt(row!.last_value) - (called ? 0n : 1n);
}

async function verifySequences(e: GraduationEngines, inventory: Inventory, failures: VerifyFailure[]): Promise<void> {
  const copied = new Set(inventory.entries.filter(x => x.class === 'carry' || x.class === 'rebind').map(x => x.relation));
  const [src, dst] = await Promise.all([sequences(e.source), sequences(e.target)]);
  for (const [name, row] of src) {
    if (row.tbl !== null && !copied.has(row.tbl)) continue;
    if (!dst.has(name)) { failures.push({ relation: name, kind: 'sequence', detail: 'Sequence is missing on the target.' }); continue; }
    const [sp, tp] = await Promise.all([sequencePosition(e.source, name), sequencePosition(e.target, name)]);
    if (tp < sp) failures.push({ relation: name, kind: 'sequence', detail: `Target position ${tp} is below the source position ${sp}.` });
    if (row.tbl && row.col) {
      const [max] = await e.target.executeRaw<{ m: string | null }>(`SELECT max(${quoteIdent(row.col)})::text AS m FROM ${quoteIdent(row.tbl)}`);
      if (max?.m != null && tp < BigInt(max.m)) failures.push({ relation: name, kind: 'sequence', detail: `Target position ${tp} is below ${row.tbl}.${row.col} maximum ${max.m}.` });
    }
  }
}

async function verifyForeignKeys(target: BrainEngine, failures: VerifyFailure[]): Promise<void> {
  for (const fk of await foreignKeys(target)) {
    const notNull = fk.childColumns.map(c => `c.${quoteIdent(c)} IS NOT NULL`).join(' AND ');
    const match = fk.childColumns.map((c, i) => `p.${quoteIdent(fk.parentColumns[i]!)} = c.${quoteIdent(c)}`).join(' AND ');
    const rows = await target.executeRaw<Record<string, string>>(`SELECT ${fk.childColumns.map((c, i) => `c.${quoteIdent(c)}::text AS ${quoteIdent(`v${i}`)}`).join(', ')}
      FROM ${quoteIdent(fk.child)} c WHERE ${notNull} AND NOT EXISTS (SELECT 1 FROM ${quoteIdent(fk.parent)} p WHERE ${match}) LIMIT 1`);
    if (rows.length) {
      const key = JSON.stringify(fk.childColumns.map((_, i) => rows[0]![`v${i}`]));
      failures.push({ relation: fk.child, kind: 'fk', firstKey: key, column: fk.childColumns.join(','),
        detail: `${fk.name}: ${fk.child}(${fk.childColumns.join(',')}) = ${key} has no row in ${fk.parent}.` });
    }
  }
}

async function verifyTriggers(target: BrainEngine, inventory: Inventory, expectFence: boolean, failures: VerifyFailure[]): Promise<void> {
  const rows = await target.executeRaw<{ rel: string; name: string; enabled: string; internal: unknown }>(`SELECT c.relname AS rel, t.tgname AS name,
      t.tgenabled::text AS enabled, t.tgisinternal AS internal
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=current_schema() ORDER BY c.relname COLLATE "C", t.tgname COLLATE "C"`);
  const fenced = new Set<string>();
  for (const t of rows) {
    if (t.name === GRADUATION_FENCE_TRIGGER) {
      if (!expectFence) failures.push({ relation: t.rel, kind: 'trigger', detail: `${t.name} is still installed after cutover.` });
      else if (t.enabled !== 'A') failures.push({ relation: t.rel, kind: 'trigger', detail: `${t.name} is '${t.enabled}', expected ENABLE ALWAYS ('A').` });
      else fenced.add(t.rel);
      continue;
    }
    if (t.enabled !== 'O') failures.push({ relation: t.rel, kind: 'trigger', detail: `Trigger ${t.name} is '${t.enabled}', expected enabled ('O').` });
  }
  if (!expectFence) return;
  const live = new Set(rows.map(r => r.rel));
  const tables = new Set((await target.executeRaw<{ relname: string }>(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=current_schema() AND c.relkind IN ('r','p')`)).map(r => r.relname));
  for (const entry of inventory.entries) {
    if ((entry.class === 'carry' || entry.class === 'rebind') && entry.engines.postgres && tables.has(entry.relation) && !fenced.has(entry.relation)) {
      failures.push({ relation: entry.relation, kind: 'trigger', detail: `${GRADUATION_FENCE_TRIGGER} is missing${live.has(entry.relation) ? '' : ' (no triggers at all)'}; the target is not fenced.` });
    }
  }
}

interface StoredRequest {
  id: string; principal_kind: Principal['kind']; principal_id: string; request_id: string; operation: string; source_id: string;
  source_incarnation: string; page_id: number | null; slug: string; worktree_id: string | null; topology_generation: string | number | null;
  intent: unknown; authority: unknown; state: string; outcome: unknown; compacted: unknown; target_kind: string | null;
  protocol_version: number | null; terminal_reservation: string | number;
}

function parsedJson(value: unknown): unknown {
  return typeof value === 'string' ? JSON.parse(value) : value;
}

function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map(k => `${JSON.stringify(k)}:${stable(obj[k])}`).join(',')}}`;
}

class ReplayRollback extends Error {
  constructor(readonly result: ReplayProbeResult) { super('replay probe rollback'); }
}

const TERMINAL_STATES = ['committed', 'conflict', 'failed', 'cancelled'];

/**
 * Resubmits a carried request through admitWriteInTransaction on the target
 * inside a transaction that is always rolled back, with persistence_brain.enabled
 * set to the source value so the managed admission path runs. Passes when the
 * stored id and outcome come back with no new request row and unchanged counters.
 */
export async function replayProbe(target: BrainEngine, requestId: string, callerIntent?: unknown,
  opts: { sourceEnabled?: boolean; runId?: string } = {}): Promise<ReplayProbeResult> {
  const stored = await target.executeRaw<StoredRequest>('SELECT * FROM persistence_requests WHERE request_id=$1::uuid', [requestId]);
  if (!stored.length) return { status: 'failed', requestId, detail: 'The request is not on the target; it was not carried.' };
  if (stored.length > 1) return { status: 'failed', requestId, detail: `${stored.length} principals hold this request id; the probe needs one.` };
  const row = stored[0]!;
  if (row.compacted === true || row.compacted === 't' || row.intent == null) return { status: 'not_available', reason: 'no_uncompacted_request' };
  if (callerIntent === undefined || callerIntent === null || typeof callerIntent !== 'object') return { status: 'not_available', reason: 'no_caller_input' };
  const [source] = await target.executeRaw<{ incarnation: string; archived: unknown }>('SELECT incarnation, archived FROM sources WHERE id=$1', [row.source_id]);
  if (!source || source.archived === true || source.archived === 't' || source.incarnation !== row.source_incarnation) {
    return { status: 'not_available', reason: 'archived_source' };
  }
  const admission: WriteAdmission = {
    principal: { kind: row.principal_kind, id: row.principal_id },
    operation: row.operation,
    targetKind: (row.target_kind ?? 'page') as WriteAdmission['targetKind'],
    protocolVersion: (row.protocol_version ?? 1) as WriteAdmission['protocolVersion'],
    sourceId: row.source_id,
    sourceIncarnation: row.source_incarnation,
    slug: row.slug,
    pageId: row.page_id,
    worktreeId: row.worktree_id,
    topologyGeneration: row.topology_generation,
    requestId: row.request_id,
    callerIntent: callerIntent as Record<string, unknown>,
    intent: parsedJson(row.intent) as Record<string, unknown>,
    authority: parsedJson(row.authority) as WriteAuthority,
    terminalReservation: Number(row.terminal_reservation),
  };
  try {
    await target.transaction(async tx => {
      if (opts.runId) await tx.executeRaw("SELECT set_config('gbrain.graduation_run', $1, true)", [opts.runId]);
      if (opts.sourceEnabled !== undefined) await tx.executeRaw('UPDATE persistence_brain SET enabled=$1 WHERE singleton=1', [opts.sourceEnabled]);
      const snapshot = async () => {
        const [count] = await tx.executeRaw<{ n: string }>('SELECT count(*)::text AS n FROM persistence_requests');
        const counters = await tx.executeRaw<Record<string, unknown>>('SELECT row_to_json(c)::text AS r FROM persistence_counters c ORDER BY key COLLATE "C"');
        return `${count!.n}|${counters.map(c => c.r).join('\n')}`;
      };
      const before = await snapshot();
      const replayed = await admitWriteInTransaction(tx, admission);
      const after = await snapshot();
      const problems = [
        String(replayed.id) !== String(row.id) ? `returned row ${replayed.id}, stored ${row.id}` : '',
        stable(parsedJson(replayed.outcome)) !== stable(parsedJson(row.outcome)) ? 'returned outcome differs from the stored outcome' : '',
        before !== after ? 'request rows or counters changed' : '',
        TERMINAL_STATES.includes(row.state) ? '' : `stored request is ${row.state}, not terminal`,
      ].filter(Boolean);
      throw new ReplayRollback(problems.length ? { status: 'failed', requestId, detail: problems.join('; ') } : { status: 'passed', requestId });
    });
  } catch (error) {
    if (error instanceof ReplayRollback) return error.result;
    if (error instanceof OperationError && error.code === 'permission_denied') return { status: 'not_available', reason: 'revoked_principal' };
    if (error instanceof OperationError && error.code === 'source_changed') return { status: 'not_available', reason: 'source_changed' };
    return { status: 'failed', requestId, detail: `Admission refused the replay: ${message(error)}` };
  }
  return { status: 'failed', requestId, detail: 'The probe transaction committed; it must always roll back.' };
}

async function chooseReplay(e: GraduationEngines, ctx: VerifyContext): Promise<ReplayProbeResult> {
  let requestId = ctx.replayRequestId;
  if (!requestId) {
    const [newest] = await e.target.executeRaw<{ request_id: string }>(`SELECT request_id FROM persistence_requests
      WHERE NOT compacted AND intent IS NOT NULL AND state = ANY($1::text[]) ORDER BY sequence DESC LIMIT 1`, [TERMINAL_STATES]);
    if (!newest) return { status: 'not_available', reason: 'no_uncompacted_request' };
    if (!ctx.replayCallerIntent) return { status: 'not_available', reason: 'no_caller_input' };
    requestId = newest.request_id;
  }
  const sourceEnabled = await readManagedMode(e.source);
  return replayProbe(e.target, requestId, ctx.replayCallerIntent, { sourceEnabled, runId: ctx.runId });
}

export async function verifyGraduation(e: GraduationEngines, ctx: VerifyContext): Promise<VerifyResult> {
  const failures: VerifyFailure[] = [];
  const batchRows = ctx.batchRows ?? DEFAULT_DIGEST_BATCH_ROWS;
  for (const [engine, kind] of [[e.source, e.source.kind], [e.target, e.target.kind]] as const) {
    try { await assertRelationSet(engine, kind, ctx.inventory); }
    catch (error) { failures.push({ relation: `(${kind} schema)`, kind: 'relation_set', detail: message(error) }); }
  }
  const carried = new Set(ctx.inventory.entries.filter(x => x.class === 'carry').map(x => x.relation));
  for (const side of DERIVED_SIDE_TABLES) {
    if (!carried.has(side)) failures.push({ relation: side, kind: 'digest', detail: 'Derived side table is not carried, so verify cannot prove it equals the source.' });
  }
  const recorded = new Map(ctx.sourceReceipts.map(r => [r.relation, r]));
  const targetTables = new Set((await copyOrder(e.target, ctx.inventory)).map(x => x.relation));
  const tables: TableReceipt[] = [];
  for (const entry of await copyOrder(e.source, ctx.inventory)) {
    if (!targetTables.has(entry.relation)) {
      failures.push({ relation: entry.relation, kind: 'relation_set', detail: 'Copied relation is missing on the target.' });
      continue;
    }
    try {
      const receipt = await verifyTable(e, entry, recorded.get(entry.relation), batchRows, failures);
      if (receipt) tables.push(receipt);
    } catch (error) {
      failures.push({ relation: entry.relation, kind: 'digest', detail: `Digest failed: ${message(error)}` });
    }
  }
  const checks: Array<[VerifyFailure['kind'], () => Promise<void>]> = [
    ['sequence', () => verifySequences(e, ctx.inventory, failures)],
    ['fk', () => verifyForeignKeys(e.target, failures)],
    ['trigger', () => verifyTriggers(e.target, ctx.inventory, ctx.expectFence ?? true, failures)],
  ];
  for (const [kind, run] of checks) {
    try { await run(); } catch (error) { failures.push({ relation: '(target)', kind, detail: `Check failed: ${message(error)}` }); }
  }
  let replay: ReplayProbeResult;
  try { replay = await chooseReplay(e, ctx); }
  catch (error) { replay = { status: 'failed', requestId: ctx.replayRequestId ?? '', detail: message(error) }; }
  if (replay.status === 'failed') failures.push({ relation: 'persistence_requests', kind: 'replay', firstKey: replay.requestId, detail: replay.detail });
  let doctorFailingChecks: readonly string[] = [];
  try { doctorFailingChecks = await ctx.runDoctor(); }
  catch (error) { doctorFailingChecks = [`doctor_unavailable: ${message(error)}`]; }
  for (const check of doctorFailingChecks) failures.push({ relation: '(target doctor)', kind: 'doctor', detail: `Doctor check ${check} fails on the target.` });
  return { ok: failures.length === 0, tables, failures, replay, doctorFailingChecks };
}
